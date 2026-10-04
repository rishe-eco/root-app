import { GraphQLError } from 'graphql';
import type { Prisma, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import {
  allowanceFor,
  allowanceState,
  checkExtension,
  type AllowanceState,
  type ExtensionProblem,
  type RoundCounts,
} from '../../lib/allowance.js';
import { lockContract } from '../../lib/stepApproval.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload } from './contracts.js';
import { parseAmountOrThrow } from './admin/billing.js';

/**
 * The allowance, over the database (journeys build plan J8; the rule is
 * `lib/allowance.ts`). Two things live here: **the loader** every publish guard
 * calls, and **`extendAllowance`**, the only thing that raises an allowance.
 *
 * ## Where the rounds are counted
 *
 * `roundCountsOn` counts all three: the design's (published design revisions of
 * the contract, J8), the mockup's (published mockup builds, J9b) and — since J10 —
 * each phase's demo (its published SITE builds, `counts.demoByPhase`). The three
 * publish mutations (`publishDesignRevision`, the mockup branch of `publishBuild`
 * and the site branch, `publishSiteBuild` in `demoStep.ts`) call
 * `allowanceStateOn` and `assertWithinAllowance` the same way. A step nothing
 * counts reads "not counted" and never refuses — see `lib/allowance.ts`'s header
 * for why absent is not zero.
 */

type Db = typeof prisma | Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });

/** How many rounds each step has taken. DESIGN: the published design revisions
 *  of this contract (`publishedAt` is set exactly once, at publish — a superseded
 *  revision was published and still counts). MOCKUP (J9b): the published
 *  iterations of this contract's mockup — builds of kind `MOCKUP` with a
 *  `publishedAt`, counted through their demo because a mockup build has no phase.
 *  A declared build the designer never published costs nothing, as a design draft
 *  does not (journeys §7.4: an iteration is what reached the customer). */
export async function roundCountsOn(db: Db, contractId: string): Promise<RoundCounts> {
  const [design, mockup, phases, siteBuilds] = await Promise.all([
    db.designRevision.count({ where: { contractId, publishedAt: { not: null } } }),
    db.build.count({ where: { kind: 'MOCKUP', publishedAt: { not: null }, demo: { contractId } } }),
    db.phase.findMany({ where: { contractId }, select: { id: true } }),
    db.build.groupBy({
      by: ['phaseId'],
      where: { kind: 'SITE', publishedAt: { not: null }, phase: { contractId } },
      _count: { _all: true },
    }),
  ]);
  // **A phase's demo rounds (J10, Q-S6): its published SITE builds.** Every phase
  // of the contract has an entry — zero for one nothing has been published for —
  // because a phase with no entry reads "not counted" (`iterationsUsed` → null),
  // which is a different statement from "none used": the desk's "iteration 1 of 3"
  // needs the 0.
  const demoByPhase: Record<string, number> = Object.fromEntries(phases.map((p) => [p.id, 0]));
  for (const row of siteBuilds) {
    if (row.phaseId !== null) demoByPhase[row.phaseId] = row._count._all;
  }
  return { design, mockup, demoByPhase };
}

/** A step's rounds used and allowance in force, as the publish guard needs them. */
export async function allowanceStateOn(
  db: Db,
  contractId: string,
  step: StepKind,
  phaseId: string | null = null,
): Promise<AllowanceState> {
  const [brief, extensions, counts] = await Promise.all([
    db.contractBrief.findUnique({ where: { contractId } }),
    db.allowanceExtension.findMany({ where: { contractId }, select: { step: true, phaseId: true, extra: true } }),
    roundCountsOn(db, contractId),
  ]);
  return allowanceState(step, phaseId, brief, extensions, counts);
}

/**
 * Tells sales a step's rounds are used up and the designer wants another — sent
 * when a publish is refused `ALLOWANCE_EXHAUSTED`, which is the moment sales is
 * needed (Q-S5: extending is theirs to approve). Best-effort like every
 * notification. It fires per refusal, not once: a designer who tries again after
 * an hour has not been helped by the first, and the third try is a signal too.
 */
export async function tellSalesAllowanceExhausted(contractId: string, state: { used: number; allowance: number }, step: StepKind) {
  try {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { project: true } });
    if (!contract) return;
    const recipients = await recipientsHolding('contracts.author');
    await Promise.all(
      recipients.map((r) =>
        notify(r, {
          kind: 'ALLOWANCE_EXHAUSTED',
          params: {
            recipientName: r.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            step,
            used: state.used,
            allowance: state.allowance,
            deskUrl: `${env.APP_ORIGIN}/${r.locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contract.id}/steps`,
          },
        }),
      ),
    );
  } catch (err) {
    console.error('[allowance] notification failed', err);
  }
}

const PROBLEM_MESSAGES: Record<ExtensionProblem, string> = {
  INVALID_EXTRA: 'An extension is a whole number of rounds above zero.',
  REASON_REQUIRED: 'Say why the allowance is being extended.',
  STEP_HAS_NO_ALLOWANCE: 'That step has no allowance.',
  PHASE_REQUIRED: 'A demo’s allowance is per phase; name the phase.',
  PHASE_NOT_ALLOWED: 'Only a demo’s allowance is per phase.',
};

const CHARGE_TEXT = (step: StepKind, extra: number) => {
  const count = new Intl.NumberFormat('fa-IR').format(extra);
  const plural = extra === 1 ? 'round' : 'rounds';
  if (step === 'MOCKUP') return { descriptionFa: `${count} دورِ اضافه‌ی ماکت`, descriptionEn: `${extra} extra mockup ${plural}` };
  if (step === 'DEMO') return { descriptionFa: `${count} دورِ اضافه‌ی دمو`, descriptionEn: `${extra} extra demo ${plural}` };
  return { descriptionFa: `${count} دورِ اضافه‌ی طراحی`, descriptionEn: `${extra} extra design ${plural}` };
};

export const allowanceMutations = {
  /**
   * **Sales admits more rounds** (journeys Q-S5: "a sales approval, with an
   * optional charge"). `contracts.author`; with `charge` also `billing.manage`,
   * because the charge is a **draft invoice** (J13's draft path — `issuedAt` null,
   * invisible to the customer until an invoice is issued), linked from the
   * extension so the two can be read together. The extension is a row of its own:
   * the brief's allowance was frozen with step 1 and is never edited.
   *
   * The design's, the mockup's and a phase's demo rounds can be extended (J8, J9b,
   * J10 — a demo's per phase, the phase being this contract's). The new road only —
   * the legacy road has no allowance to raise (`STEP_NOT_ON_ROAD`).
   *
   * Refusals, in order: `FORBIDDEN` (no capability — checked first, so no id
   * leaks), the input's own (`INVALID_EXTRA`, `REASON_REQUIRED`,
   * `STEP_HAS_NO_ALLOWANCE`, `PHASE_REQUIRED`, `PHASE_NOT_ALLOWED`),
   * `INVALID_AMOUNT`, `NOT_FOUND` (the contract, or a demo's phase),
   * `STEP_NOT_ON_ROAD`, `NO_ALLOWANCE_SET` (an extension on a step that had no
   * limit is meaningless).
   */
  extendAllowance: async (
    _p: unknown,
    args: { contractId: string; step: StepKind; phaseId?: string | null; extra: number; reason: string; charge?: string | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const phaseId = args.phaseId ?? null;
    const problem = checkExtension({ step: args.step, phaseId, extra: args.extra, reason: args.reason });
    if (problem) throw refuse(problem, PROBLEM_MESSAGES[problem]);

    let charge: bigint | null = null;
    if (args.charge !== undefined && args.charge !== null) {
      if (!can(user, 'billing.manage')) throw refuse('FORBIDDEN', 'You do not have access to that.');
      charge = parseAmountOrThrow(args.charge);
    }

    const contract = await loadForActor(args.contractId, user);
    if (contract.sequence !== 'AGREEMENT_FIRST') {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no allowances to extend.');
    }
    // DESIGN, MOCKUP and a phase's DEMO count their rounds (J8, J9b, J10); the
    // other steps have no allowance (`checkExtension` refused them above).
    if (args.step === 'DEMO') {
      // A demo's allowance is per phase, and the phase must be this contract's:
      // a sibling contract's phase id would extend nothing this contract reads.
      const phase = await prisma.phase.findFirst({ where: { id: phaseId!, contractId: contract.id }, select: { id: true } });
      if (!phase) throw refuse('NOT_FOUND', 'No such phase.');
    }

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      const brief = await tx.contractBrief.findUnique({ where: { contractId: contract.id } });
      if (allowanceFor(args.step, phaseId, brief, []) === null) {
        throw refuse('NO_ALLOWANCE_SET', 'This step has no allowance to extend.');
      }
      let billingEntryId: string | null = null;
      if (charge !== null) {
        const entry = await tx.billingEntry.create({
          data: {
            customerId: contract.customerId,
            contractId: contract.id,
            source: 'CONTRACT',
            ...CHARGE_TEXT(args.step, args.extra),
            amount: charge,
          },
        });
        billingEntryId = entry.id;
      }
      await tx.allowanceExtension.create({
        data: {
          contractId: contract.id,
          step: args.step,
          phaseId,
          extra: args.extra,
          reason: args.reason.trim(),
          approvedById: user.id,
          billingEntryId,
        },
      });
    });
    return reload(contract.id);
  },
};
