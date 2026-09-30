import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, viewerOf, type Context } from '../../context.js';
import { approveStepTx, lockContract } from '../../lib/stepApproval.js';
import { agreementSignedAt, designMissing, designPathOf, type DesignMissing, type DesignPath } from '../../lib/steps.js';
import { otherOptionsAskBody } from '../../lib/design.js';
import { isContractReader, mayReadMoney } from '../../lib/visibility.js';
import { notify } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { assertStepOpenOn } from './wizard.js';
import { raiseFeedback, stepOwners } from './feedback.js';

/**
 * Step 4 on the customer's side, and the rules every design write shares
 * (journeys build plan J8). The designer's half is `admin/design.ts`; the rules
 * that neither owns — *when the design step is open*, *which path a contract is
 * on*, *what is missing from it* — live here so the two halves read one copy
 * (house rule 3).
 *
 * ## Who does what
 *
 * - **`requestOtherOptions`, `approveDesign`** — the contract's own customer and
 *   nobody else (house rule 2): staff who can see the contract get the answer a
 *   stranger gets, because these are the customer's acts and Root answers, it
 *   does not raise. `chooseConcept` and `setPageApproval` are the customer's too;
 *   they live in `customer.ts` beside their legacy behaviour and take the same
 *   guards from here.
 * - **One approval writer.** `approveDesign` is `approveStepTx(DESIGN)` with the
 *   path's completeness as its precondition. S2's `approveStep` no longer
 *   approves DESIGN (it refuses `STEP_NOT_APPROVABLE`, as it does AGREEMENT,
 *   which S2's own comment said the owning stage would do): two mutations that
 *   approve the same step with different preconditions is the drift this file
 *   exists to prevent.
 */

type Tx = Prisma.TransactionClient;
type Db = typeof prisma | Tx;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

/**
 * **Every design write starts here.** Under the contract's row lock (so a write
 * cannot interleave with an approval or an answer on the same contract), the
 * step must not be locked (`STEP_LOCKED` — after the customer approves the
 * design, nothing on it moves, for staff too), and — the rule the other steps do
 * not need — **on the new road the design opens once the agreement is signed**
 * (`AGREEMENT_NOT_SIGNED`): the agreement's approval locks steps 1–3, but AGREEMENT
 * is only *done* at the signature (`agreementSignedAt`, the one rule J13's
 * invoices read too), and a round shown to a customer who has not yet signed
 * would put step 4 in front of step 3. The legacy road (`DESIGN_FIRST`) is
 * design-first by definition and has no such rule (PD-7).
 *
 * `j8.test.ts` holds the table of every call site against `STEP_LOCKED`, built
 * by grepping for `openDesign(`.
 */
export async function openDesign(tx: Tx, contractId: string): Promise<void> {
  await lockContract(tx, contractId);
  await assertStepOpenOn(contractId, 'DESIGN', null, tx);
  const contract = await tx.contract.findUnique({
    where: { id: contractId },
    select: { sequence: true, currentContractRevision: { select: { signature: { select: { signedAt: true } } } } },
  });
  if (
    contract?.sequence === 'AGREEMENT_FIRST' &&
    agreementSignedAt({ signatureSignedAt: contract.currentContractRevision?.signature?.signedAt ?? null }) === null
  ) {
    throw refuse('AGREEMENT_NOT_SIGNED', 'The design opens once the agreement is signed.');
  }
}

/**
 * The path a contract's design is on — the brief's tier through `designPathOf`
 * (PD-13). `null` for a legacy contract and for a new-road contract with no
 * brief yet: there is no path to be on.
 */
export async function designPathOn(db: Db, contractId: string): Promise<DesignPath | null> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: { sequence: true, brief: { select: { designTier: true } } },
  });
  if (!contract || contract.sequence !== 'AGREEMENT_FIRST' || !contract.brief) return null;
  return designPathOf(contract.brief.designTier);
}

/**
 * What the design step still lacks (`designMissing`, lib/steps.ts), from the
 * rows: the **current published revision** and its palette. The one computation
 * the `Contract.designMissing` field and `approveDesign`'s precondition share, so
 * the button and the refusal cannot disagree.
 */
export async function designMissingOn(db: Db, contractId: string): Promise<DesignMissing[]> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: {
      currentDesignRevision: {
        select: {
          concepts: { select: { chosenAt: true, pages: { select: { approvedAt: true } } } },
          _count: { select: { palette: true } },
        },
      },
    },
  });
  const revision = contract?.currentDesignRevision ?? null;
  return designMissing({
    path: await designPathOn(db, contractId),
    hasRound: revision !== null,
    concepts: revision?.concepts ?? [],
    paletteCount: revision?._count.palette ?? 0,
  });
}

// --- who is told -------------------------------------------------------------------

type ContractForMail = Pick<FullContract, 'id' | 'designerId' | 'developerId' | 'customer' | 'project'>;

const portalUrl = (locale: string | null, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`;
const deskStepsUrl = (locale: string | null, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contractId}/steps`;

/** A notification is best-effort: it must never fail the act that caused it. */
async function tell(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error('[design] notification failed', err);
  }
}

/**
 * The contract's designer, told what the customer did in the design step: a
 * concept chosen, other options asked for, the design approved. The recipient is
 * the assigned designer — and only when there is none (or they are disabled) the
 * people who could answer in their place, which is `stepOwners`' rule (S2), not a
 * second one.
 */
export async function tellDesigner(
  kind: 'DESIGN_CONCEPT_CHOSEN' | 'DESIGN_OTHER_OPTIONS_ASKED' | 'DESIGN_APPROVED',
  contract: ContractForMail,
): Promise<void> {
  await tell(async () => {
    const recipients = await stepOwners(contract, 'DESIGN', false);
    await Promise.all(
      recipients.map((r) =>
        notify(r, {
          kind,
          params: {
            recipientName: r.name,
            customerName: contract.customer.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            deskUrl: deskStepsUrl(r.locale, contract.id),
          },
        }),
      ),
    );
  });
}

/** The customer, told a round is up ("round 2 of 3"). */
export async function tellCustomerOfRound(
  contract: ContractForMail,
  round: number,
  allowance: number | null,
  premade: boolean,
): Promise<void> {
  await tell(() =>
    notify(contract.customer, {
      kind: 'DESIGN_ROUND_PUBLISHED',
      params: {
        customerName: contract.customer.name,
        projectTitleFa: contract.project.titleFa,
        projectTitleEn: contract.project.titleEn,
        round,
        allowance,
        premade,
        portalUrl: portalUrl(contract.customer.locale, contract.id),
      },
    }),
  );
}

// --- the customer's mutations ------------------------------------------------------

/** The contract, visible to the caller, and theirs — `NOT_FOUND` for anyone else. */
async function ownContract(contractId: string, ctx: Context) {
  const user = requireUser(ctx);
  const contract = await loadForActor(contractId, user);
  if (contract.customerId !== user.id) throw notFound('contract');
  return { user, contract };
}

export const designCustomerMutations = {
  /**
   * **"Show me other options"** — a pre-made round's escape hatch. It is a
   * `general` DESIGN feedback item like any other (S2; `raiseFeedback` writes it,
   * so duplicate collapse, reopening and the lock are the same code), marked
   * `otherOptionsAskedAt` in that same write. The next round's publish answers it
   * through the ordinary resolution path — a designer's `ADDRESSED` comment on the
   * record, not a status flip — and until then the item is open, which blocks the
   * design's approval: a customer who has asked for other options has not
   * accepted these.
   *
   * Refusals: `NOT_FOUND` (not the caller's contract), `NOT_PREMADE` (a custom
   * design has no gallery to ask for more of), `NO_ROUND` (nothing has been shown
   * yet), `STEP_LOCKED`.
   */
  requestOtherOptions: async (_p: unknown, args: { contractId: string; note?: string | null }, ctx: Context) => {
    const { user, contract } = await ownContract(args.contractId, ctx);
    if ((await designPathOn(prisma, contract.id)) !== 'PREMADE') {
      throw refuse('NOT_PREMADE', 'Other options are asked for on a pre-made design.');
    }
    if (!contract.currentDesignRevisionId) throw refuse('NO_ROUND', 'Nothing has been proposed yet.');

    const body = args.note?.trim() || otherOptionsAskBody(user.locale);
    await raiseFeedback(
      { contractId: contract.id, step: 'DESIGN', target: { general: true }, body },
      ctx,
      { markOtherOptions: true, silent: true },
    );
    await tellDesigner('DESIGN_OTHER_OPTIONS_ASKED', contract);
    return reload(contract.id);
  },

  /**
   * **Approving the design** (journeys build plan J8) — `approveStepTx(DESIGN)`
   * with the path's completeness as its precondition, in one transaction under the
   * contract's lock. Pre-made: a concept is chosen. Custom: every page approved,
   * one at least, and a palette (`designMissing`). Refused while any note is
   * unresolved or an answer waits for sales, exactly as every step is
   * (`STEP_HAS_OPEN_FEEDBACK`, `STEP_HAS_PENDING_ANSWERS`); after it, every design
   * mutation is `STEP_LOCKED`.
   *
   * The new road only: the legacy road approves its design through the gate
   * (`STEP_NOT_APPROVABLE`).
   */
  approveDesign: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const { user, contract } = await ownContract(args.contractId, ctx);
    if (contract.sequence !== 'AGREEMENT_FIRST') {
      throw refuse('STEP_NOT_APPROVABLE', 'That step cannot be approved this way.');
    }
    try {
      await prisma.$transaction((tx) =>
        approveStepTx(tx, { contractId: contract.id, step: 'DESIGN', phaseId: null, approverId: user.id }, [
          async (inner) => {
            const missing = await designMissingOn(inner, contract.id);
            if (missing.length > 0) {
              throw refuse('DESIGN_INCOMPLETE', 'The design is not complete yet.', { missing });
            }
          },
        ]),
      );
    } catch (err) {
      // Two approvals at once: the partial unique index on `StepApproval` refuses
      // the second — and the answer the caller should get is the lock.
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw refuse('STEP_LOCKED', 'That step is locked.');
      }
      throw err;
    }
    await tellDesigner('DESIGN_APPROVED', contract);
    return reload(contract.id);
  },
};

// --- Contract fields ---------------------------------------------------------------

export const contractDesignFields = {
  /** The current published round's palette. Empty on the pre-made path and on the
   *  legacy road. */
  palette: (c: FullContract) => c.currentDesignRevision?.palette ?? [],

  /**
   * What the new road's design step still lacks (`designMissing`), as codes — the
   * portal's "approve" button is enabled when this is empty, and `approveDesign`
   * refuses on exactly this list. Empty for a legacy contract, whose design is
   * complete when the gate says so (`Contract.gate`).
   */
  designMissing: async (c: FullContract) => (c.sequence === 'AGREEMENT_FIRST' ? designMissingOn(prisma, c.id) : []),

  /**
   * The rounds sales has granted beyond the brief — staff readers only (an empty
   * list for anyone else, never an error, so a fragment shared with the portal
   * cannot break the customer's page). The reason is internal; the customer sees
   * only the allowance that results ("round 2 of 4"). `charge` is money and follows
   * `mayReadMoney` (PD-14): the draft invoice's amount, or null.
   */
  allowanceExtensions: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    if (!isContractReader(viewer)) return [];
    const rows = await prisma.allowanceExtension.findMany({
      where: { contractId: c.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { approvedBy: true, billingEntry: { select: { amount: true } } },
    });
    const money = mayReadMoney(viewer, c);
    return rows.map((r) => ({
      id: r.id,
      step: r.step,
      phaseId: r.phaseId,
      extra: r.extra,
      reason: r.reason,
      approvedBy: r.approvedBy,
      charge: money && r.billingEntry ? r.billingEntry.amount.toString() : null,
      createdAt: r.createdAt,
    }));
  },
};
