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
 * ## The extension point for J9 and J10
 *
 * `roundCountsOn` is where a step's rounds are counted, and **only the design's
 * is written**: published design revisions of the contract. J9 adds the published
 * mockup builds (`counts.mockup`) and J10 the published site builds per phase
 * (`counts.demoByPhase`) *here*, and their publish mutations call
 * `allowanceStateOn` and `assertWithinAllowance` exactly as
 * `publishDesignRevision` does. Until then those counts are absent, which the
 * rule reads as "not counted" and never refuses on — see `lib/allowance.ts`'s
 * header for why absent is not zero.
 */

type Db = typeof prisma | Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });

/** How many rounds each step has taken. DESIGN: the published design revisions
 *  of this contract (`publishedAt` is set exactly once, at publish — a superseded
 *  revision was published and still counts). */
export async function roundCountsOn(db: Db, contractId: string): Promise<RoundCounts> {
  return { design: await db.designRevision.count({ where: { contractId, publishedAt: { not: null } } }) };
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

const CHARGE_TEXT = (extra: number) => ({
  descriptionFa: `${new Intl.NumberFormat('fa-IR').format(extra)} دورِ اضافه‌ی طراحی`,
  descriptionEn: `${extra} extra design ${extra === 1 ? 'round' : 'rounds'}`,
});

export const allowanceMutations = {
  /**
   * **Sales admits more rounds** (journeys Q-S5: "a sales approval, with an
   * optional charge"). `contracts.author`; with `charge` also `billing.manage`,
   * because the charge is a **draft invoice** (J13's draft path — `issuedAt` null,
   * invisible to the customer until an invoice is issued), linked from the
   * extension so the two can be read together. The extension is a row of its own:
   * the brief's allowance was frozen with step 1 and is never edited.
   *
   * Only the design has rounds to extend in J8; a mockup's and a demo's are J9's
   * and J10's (`STEP_NOT_BUILT`, until they count them). The new road only —
   * the legacy road has no allowance to raise (`STEP_NOT_ON_ROAD`).
   *
   * Refusals, in order: `FORBIDDEN` (no capability — checked first, so no id
   * leaks), the input's own (`INVALID_EXTRA`, `REASON_REQUIRED`,
   * `STEP_HAS_NO_ALLOWANCE`, `PHASE_REQUIRED`, `PHASE_NOT_ALLOWED`),
   * `INVALID_AMOUNT`, `NOT_FOUND`, `STEP_NOT_ON_ROAD`, `STEP_NOT_BUILT`,
   * `NO_ALLOWANCE_SET` (an extension on a step that had no limit is meaningless).
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
    if (args.step !== 'DESIGN') {
      throw refuse('STEP_NOT_BUILT', 'Only the design’s rounds can be extended yet.');
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
            ...CHARGE_TEXT(args.extra),
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
