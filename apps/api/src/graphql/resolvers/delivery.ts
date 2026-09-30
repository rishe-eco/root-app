import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, viewerOf, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { lockContract } from '../../lib/stepApproval.js';
import { agreementSignedAt } from '../../lib/steps.js';
import { isAgreedOrBeyond } from '../../lib/scope.js';
import { isAgreementSnapshot, readContractSnapshot } from '../../lib/revision.js';
import { parseCalendarDay } from '../../lib/calendarDay.js';
import {
  HANDOVER_MESSAGES,
  assertCanClose,
  checkHandoverNote,
  closeBlockers,
  supportPeriod,
  type CloseBlockers,
} from '../../lib/delivery.js';
import {
  executedAmendments,
  invoiceTotals,
  summaryItems,
  summarySteps,
  unpromptedChanges,
} from '../../lib/summary.js';
import { canAuthorBuild, contractVisibleToStaff, isContractReader, mayReadMoney } from '../../lib/visibility.js';
import { notify } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { agreementView } from './agreement.js';
import { roundCountsOn } from './allowance.js';
import { contractWizardFields } from './wizard.js';

/**
 * Step 7 — the summary, the handover and closing a contract (journeys build plan
 * J11, PD-6). The rules are `lib/delivery.ts` (what a close waits for) and
 * `lib/summary.ts` (what the record says); this file loads the rows, decides who
 * is looking, and writes.
 *
 * ## Who does what
 *
 * - **`markHandedOver`** — `contracts.author` (sales), *or* `builds.author` **and**
 *   the contract's developer: the developer is the one who actually gives the
 *   customer the repository and the access, so it is theirs to record. House rule
 *   2, both mechanisms, checked separately: the capability first (`FORBIDDEN` — no
 *   id leaks), then whether the contract is one this person may see
 *   (`NOT_FOUND`), then — for the developer only — whether it is theirs
 *   (`NOT_ASSIGNED`). Sales holds the capability over every contract and needs no
 *   edge, as they need none for any other authoring verb.
 * - **`unmarkHandedOver`** — `contracts.author` only, and only before the close.
 *   A handover is a statement *Root makes to the customer*; taking one back is a
 *   correction someone accountable for the record makes, not a thing the person
 *   who made it undoes at will. (A developer who mistyped the note asks sales.)
 * - **`closeContract`** — `contracts.author`. The act that ends the contract's
 *   working life: sets `deliveredAt`, moves `status` to `DONE`, tells the
 *   customer, and — because `deliveredAt` is the third clause of
 *   `isActiveContract` — takes the contract out of every `contracts.readActive`
 *   view. Sales (`readAll`) and the customer keep it: the record is theirs.
 *
 * Every write takes `lockContract`, the same row lock an approval takes, so a
 * handover cannot interleave with the close that is counting handovers: without
 * it "every deliverable is handed over" could be true when read and false when
 * committed, or the reverse.
 */

type Db = typeof prisma | Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

// --- what a close waits for, from the rows ------------------------------------

/** The rows `closeBlockers` reads, for one contract. The one loader behind both
 *  `closeContract` and `Contract.delivery`, so the button and the refusal agree. */
export async function closeBlockersOn(db: Db, contractId: string): Promise<CloseBlockers> {
  const [contract, phases, approvals, items] = await Promise.all([
    db.contract.findUniqueOrThrow({ where: { id: contractId }, select: { sequence: true } }),
    db.phase.findMany({
      where: { contractId },
      select: { id: true, number: true, scopeItems: { select: { status: true } } },
    }),
    db.stepApproval.findMany({ where: { contractId, step: 'DEMO' }, select: { step: true, phaseId: true } }),
    db.scopeItem.findMany({
      where: { contractId, kind: 'DELIVERABLE' },
      select: { id: true, kind: true, status: true, contractId: true, position: true, handedOverAt: true },
    }),
  ]);
  return closeBlockers({ contractId, sequence: contract.sequence, phases, approvals, items });
}

// --- notifications ---------------------------------------------------------------

/** The customer, told their contract is closed. Best-effort like every
 *  notification: it must never fail the act that caused it. */
async function tellCustomerClosed(contract: FullContract, supportMonths: number | null, deliveredAt: Date): Promise<void> {
  try {
    const period = supportPeriod(deliveredAt, supportMonths);
    await notify(contract.customer, {
      kind: 'CONTRACT_CLOSED',
      params: {
        customerName: contract.customer.name,
        projectTitleFa: contract.project.titleFa,
        projectTitleEn: contract.project.titleEn,
        supportMonths: period?.months ?? null,
        supportUntil: period?.until ?? null,
        portalUrl: `${env.APP_ORIGIN}/${contract.customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contract.id}`,
      },
    });
  } catch (err) {
    console.error('[delivery] notification failed', err);
  }
}

// --- the mutations ---------------------------------------------------------------

/**
 * The contract a deliverable belongs to, as the caller may act on it. Returns the
 * item's own row too. Capability → visibility → (developer only) assignment.
 */
async function requireHandoverRights(ctx: Context, scopeItemId: string, opts: { developerMayAct: boolean }) {
  const user = requireUser(ctx);
  const asSales = can(user, 'contracts.author');
  const asDeveloper = opts.developerMayAct && !asSales && can(user, 'builds.author');
  if (!asSales && !asDeveloper) {
    throw refuse('FORBIDDEN', 'You do not have access to that.');
  }

  const item = await prisma.scopeItem.findUnique({ where: { id: scopeItemId }, select: { id: true, contractId: true } });
  if (!item || !item.contractId) throw notFound('item');
  const contract = await prisma.contract.findUnique({
    where: { id: item.contractId },
    select: { id: true, status: true, deliveredAt: true, developerId: true, project: { select: { status: true } } },
  });
  // A delivered contract has left the developer's views (S1's `isActiveContract`),
  // so to them it is not there — which is the point of it leaving. Sales sees it
  // and is told the truth (`CONTRACT_DELIVERED`, below).
  if (!contract || !contractVisibleToStaff(user, contract)) throw notFound('item');
  if (!asSales && !canAuthorBuild(user, contract)) {
    throw refuse('NOT_ASSIGNED', 'You are not the developer of this contract.');
  }
  return { user, contractId: contract.id };
}

export const deliveryMutations = {
  /**
   * **Hand a deliverable over** (journeys build plan J11): record that Root gave
   * the customer the thing, and what and how. An agreed `DELIVERABLE` of a signed,
   * not-yet-delivered contract, with a note that says something. Refusals, in
   * order: `FORBIDDEN`, the note (`HANDOVER_NOTE_REQUIRED`, `HANDOVER_NOTE_TOO_LONG`),
   * `NOT_FOUND`, `NOT_ASSIGNED`, then — under the contract's lock —
   * `CONTRACT_DELIVERED`, `CONTRACT_NOT_SIGNED`, `NOT_A_DELIVERABLE`, `NOT_AGREED`
   * (declined, traded away, or only proposed), `ALREADY_HANDED_OVER`.
   *
   * **A second handover is refused, not merged.** A note rewritten in place is a
   * record that says something other than what was said, and "who handed it over"
   * would silently become whoever corrected the typo. To change one, sales takes
   * it back (`unmarkHandedOver`) and it is made again — two visible acts.
   */
  markHandedOver: async (_p: unknown, args: { scopeItemId: string; note: string }, ctx: Context) => {
    requireUser(ctx);
    const problem = checkHandoverNote(args.note);
    if (problem) throw refuse(problem, HANDOVER_MESSAGES[problem]);

    const { user, contractId } = await requireHandoverRights(ctx, args.scopeItemId, { developerMayAct: true });
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contractId);
      const contract = await tx.contract.findUniqueOrThrow({
        where: { id: contractId },
        select: {
          deliveredAt: true,
          currentContractRevision: { select: { signature: { select: { signedAt: true } } } },
        },
      });
      if (contract.deliveredAt) throw refuse('CONTRACT_DELIVERED', 'This contract has been delivered; its record is closed.');
      if (agreementSignedAt({ signatureSignedAt: contract.currentContractRevision?.signature?.signedAt ?? null }) === null) {
        throw refuse('CONTRACT_NOT_SIGNED', 'Nothing is handed over before the agreement is signed.');
      }
      const item = await tx.scopeItem.findUniqueOrThrow({
        where: { id: args.scopeItemId },
        select: { kind: true, status: true, handedOverAt: true },
      });
      if (item.kind !== 'DELIVERABLE') {
        throw refuse('NOT_A_DELIVERABLE', 'Only a deliverable is handed over; a page or a feature is accepted in its demo.');
      }
      if (!isAgreedOrBeyond(item.status)) {
        throw refuse('NOT_AGREED', 'That deliverable is not part of the agreement any more.');
      }
      if (item.handedOverAt) throw refuse('ALREADY_HANDED_OVER', 'That deliverable has already been handed over.');
      await tx.scopeItem.update({
        where: { id: args.scopeItemId },
        data: { handedOverAt: new Date(), handedOverById: user.id, handoverNote: args.note.trim() },
      });
    });
    return reload(contractId);
  },

  /**
   * **Take a handover back**, before the contract closes. `contracts.author` only —
   * see the file header for why the developer who made it cannot. Clears all
   * three columns together (the CHECK allows a note without a date, but a record
   * half-erased is worse than either state). `NOT_HANDED_OVER` when there is
   * nothing to take back.
   */
  unmarkHandedOver: async (_p: unknown, args: { scopeItemId: string }, ctx: Context) => {
    const { contractId } = await requireHandoverRights(ctx, args.scopeItemId, { developerMayAct: false });
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contractId);
      const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, select: { deliveredAt: true } });
      if (contract.deliveredAt) throw refuse('CONTRACT_DELIVERED', 'This contract has been delivered; its record is closed.');
      const item = await tx.scopeItem.findUniqueOrThrow({ where: { id: args.scopeItemId }, select: { handedOverAt: true } });
      if (!item.handedOverAt) throw refuse('NOT_HANDED_OVER', 'That deliverable has not been handed over.');
      await tx.scopeItem.update({
        where: { id: args.scopeItemId },
        data: { handedOverAt: null, handedOverById: null, handoverNote: null },
      });
    });
    return reload(contractId);
  },

  /**
   * **Close the contract** (journeys build plan J11, PD-6) — `contracts.author`.
   * Refusals, in order: `FORBIDDEN`, `NOT_FOUND` (`loadForActor`), then under the
   * contract's lock `ALREADY_DELIVERED`, `CONTRACT_DISCARDED`, `CONTRACT_NOT_SIGNED`,
   * `PHASES_NOT_ACCEPTED`, `DELIVERABLES_PENDING` (`lib/delivery.ts` — the same
   * answer `Contract.delivery` shows the desk). Sets `deliveredAt` and
   * `deliveredById` and moves `status` to `DONE` — `statusChangedAt` only when the
   * status actually differs (V4 defect D7).
   *
   * **It applies to both roads** (PD-6 is about delivery, not the road): the new
   * road's phases are accepted by the customer's DEMO approval, the legacy road's
   * by its scope items, each asked in its own terms.
   */
  closeContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const user = requireCapability(ctx, 'contracts.author');
    const contract = await loadForActor(args.contractId, user);
    const deliveredAt = new Date();

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      const fresh = await tx.contract.findUniqueOrThrow({
        where: { id: contract.id },
        select: {
          status: true,
          deliveredAt: true,
          currentContractRevision: { select: { signature: { select: { signedAt: true } } } },
        },
      });
      if (fresh.deliveredAt) throw refuse('ALREADY_DELIVERED', 'This contract has already been delivered.');
      if (fresh.status === 'DISCARDED') throw refuse('CONTRACT_DISCARDED', 'A discarded contract cannot be delivered.');
      if (agreementSignedAt({ signatureSignedAt: fresh.currentContractRevision?.signature?.signedAt ?? null }) === null) {
        throw refuse('CONTRACT_NOT_SIGNED', 'A contract that was never signed cannot be delivered.');
      }
      assertCanClose(await closeBlockersOn(tx, contract.id));
      await tx.contract.update({
        where: { id: contract.id },
        data: {
          deliveredAt,
          deliveredById: user.id,
          status: 'DONE',
          ...(fresh.status === 'DONE' ? {} : { statusChangedAt: deliveredAt }),
        },
      });
    });

    const after = await reload(contract.id);
    const brief = await prisma.contractBrief.findUnique({ where: { contractId: contract.id }, select: { supportMonths: true } });
    await tellCustomerClosed(after, brief?.supportMonths ?? null, deliveredAt);
    return after;
  },
};

// --- the fields ---------------------------------------------------------------------

export const contractDeliveryFields = {
  /** The close, as the desk needs it (`lib/delivery.ts`): whether it can be done,
   *  and if not, what is in the way. Read by anyone who can read the contract — a
   *  phase number and a count of pending handovers are not secrets from the
   *  customer who is waiting on them. */
  delivery: async (c: FullContract) => {
    const blockers = await closeBlockersOn(prisma, c.id);
    const signed = agreementSignedAt({ signatureSignedAt: c.currentContractRevision?.signature?.signedAt ?? null }) !== null;
    return {
      deliveredAt: c.deliveredAt,
      ...blockers,
      closable:
        c.deliveredAt === null &&
        c.status !== 'DISCARDED' &&
        signed &&
        !blockers.noPhases &&
        blockers.phasesNotAccepted.length === 0 &&
        blockers.deliverablesPending.length === 0,
    };
  },

  /**
   * **The summary** (journeys build plan J11; Q-S8): a record, derived on read.
   * Each part is sourced from the row that already owns it — the signed snapshot
   * for what was agreed, the registry for what became of it, the wizard and
   * `lib/allowance.ts` for each step's rounds and finish date, the billing entries
   * for the money — so nothing here can disagree with the screen it summarises.
   *
   * **Who sees what.** Everyone who can read the contract reads the summary; what
   * differs is what they read, and by the same rules as everywhere else: money
   * follows `mayReadMoney` (owner or `money.read` — the invoice totals and the
   * agreed plan are null for a designer), amendment bodies follow
   * `mayReadAmendmentBody` (the existing `Amendment` field resolvers), and an
   * unprompted change a person has not yet written up in both languages is
   * staff's (`unpromptedChanges`). Asked through `viewerOf`, so sales looking as
   * the customer sees the customer's record.
   *
   * Null until the agreement is signed: there is nothing agreed to record.
   */
  summary: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const revision = c.currentContractRevision;
    const snapshot = readContractSnapshot(revision?.snapshot ?? null);
    if (!revision?.signature || !snapshot) return null;
    const staff = isContractReader(viewer);
    const money = mayReadMoney(viewer, c);

    const [phases, approvals, trades, amendments, unprompted, extensions, counts, brief, entries, deliverer, wizard, status] =
      await Promise.all([
        prisma.phase.findMany({ where: { contractId: c.id }, orderBy: { number: 'asc' } }),
        prisma.stepApproval.findMany({ where: { contractId: c.id, step: 'DEMO' }, select: { phaseId: true, approvedAt: true } }),
        prisma.scopeTrade.findMany({
          where: { executedAt: { not: null }, OR: [{ outItem: { contractId: c.id } }, { inItem: { contractId: c.id } }] },
          include: { outItem: true, inItem: true },
          orderBy: { executedAt: 'asc' },
        }),
        prisma.amendment.findMany({
          where: { contractRevisionId: revision.id },
          include: { signature: { include: { signer: true } }, scopeTrade: { select: { executedAt: true } } },
          orderBy: { ordinal: 'asc' },
        }),
        prisma.buildChangeEntry.findMany({
          where: {
            feedbackItemId: null,
            scopeItemId: null,
            build: { publishedAt: { not: null }, OR: [{ phase: { contractId: c.id } }, { demo: { contractId: c.id } }] },
          },
          include: {
            frameLine: { select: { textFa: true, textEn: true } },
            build: { select: { kind: true, number: true, publishedAt: true } },
          },
        }),
        prisma.allowanceExtension.findMany({ where: { contractId: c.id }, select: { step: true, phaseId: true, extra: true } }),
        roundCountsOn(prisma, c.id),
        prisma.contractBrief.findUnique({ where: { contractId: c.id } }),
        money
          ? prisma.billingEntry.findMany({
              where: { contractId: c.id, issuedAt: { not: null } },
              select: { amount: true, issuedAt: true, paidAt: true },
            })
          : Promise.resolve(null),
        c.deliveredById ? prisma.user.findUnique({ where: { id: c.deliveredById }, select: { name: true } }) : Promise.resolve(null),
        contractWizardFields.wizard(c, undefined, ctx),
        contractWizardFields.statusSummary(c, undefined, ctx),
      ]);

    const handers = await prisma.user.findMany({
      where: { id: { in: c.project.scopeItems.flatMap((i) => (i.handedOverById ? [i.handedOverById] : [])) } },
      select: { id: true, name: true },
    });
    const handerName = new Map(handers.map((u) => [u.id, u.name]));

    const phaseNumbers = new Map(phases.map((p) => [p.id, p.number]));
    const executedTrades = trades.map((t) => ({ outItemId: t.outItemId, inItemId: t.inItemId, executedAt: t.executedAt! }));
    const acceptedAt = new Map(approvals.flatMap((a) => (a.phaseId ? [[a.phaseId, a.approvedAt] as const] : [])));
    const supportMonths = (isAgreementSnapshot(snapshot) ? snapshot.brief?.supportMonths : null) ?? brief?.supportMonths ?? null;
    const support = supportPeriod(c.deliveredAt, supportMonths);
    const day = (v: string | null) => (v === null ? null : parseCalendarDay(v));

    return {
      deliveredAt: c.deliveredAt,
      deliveredBy: deliverer?.name ?? null,
      agreed: {
        version: revision.version,
        contentHash: revision.contentHash,
        signedAt: revision.signature.signedAt,
        scopeItems: snapshot.scopeItems,
        agreement: isAgreementSnapshot(snapshot) ? agreementView(snapshot, money) : null,
        amendments: executedAmendments(amendments),
        trades: trades.map((t) => ({
          executedAt: t.executedAt!,
          out: { key: t.outItem.key, labelFa: t.outItem.labelFa, labelEn: t.outItem.labelEn },
          in: { key: t.inItem.key, labelFa: t.inItem.labelFa, labelEn: t.inItem.labelEn },
        })),
      },
      items: summaryItems({
        contractId: c.id,
        items: c.project.scopeItems.map((i) => ({
          ...i,
          handedOverBy: i.handedOverById ? { name: handerName.get(i.handedOverById) ?? '' } : null,
        })),
        agreedKeys: new Set(snapshot.scopeItems.map((s) => s.key)),
        trades: executedTrades,
        phaseNumbers,
      }),
      unpromptedChanges: unpromptedChanges(unprompted, staff),
      steps: summarySteps({ wizard, brief, extensions, counts }),
      dates: {
        plannedStartAt: c.plannedStartAt,
        plannedEndAt: c.plannedEndAt,
        signedAt: revision.signature.signedAt,
        startedAt: status.startedAt,
        deliveredAt: c.deliveredAt,
        phases: phases.map((p) => ({
          number: p.number,
          titleFa: p.titleFa,
          titleEn: p.titleEn,
          plannedEndAt: p.plannedEndAt,
          acceptedAt: acceptedAt.get(p.id) ?? null,
        })),
      },
      invoices: entries ? invoiceTotals(entries) : null,
      support: support && { months: support.months, from: day(support.from), until: day(support.until) },
    };
  },
};

