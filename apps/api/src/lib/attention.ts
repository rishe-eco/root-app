import type { StepKind, User } from '@prisma/client';
import { isOverdue } from './dependency.js';
import { isOverdue as isInvoiceOverdue, type InvoiceLike } from './invoice.js';
import { attentionVisibleTo } from './visibility.js';

/**
 * What is waiting on whom (journeys build plan J3, §6.3) — the in-app
 * counterpart of a notification (§6.2's last paragraph: while no SMS provider
 * is configured a notification that cannot be delivered "waits in the
 * attention module for the next sign-in").
 *
 * **Pure over loaded rows**, unit-tested with fixtures (`attention.test.ts`).
 * The loader (`resolvers/wizard.ts`) turns a contract into an `AttentionInput`;
 * this file turns that into typed items and decides which of them a viewer may
 * see (through `lib/visibility.ts` — never a second copy of that rule).
 *
 * **Derived, never stored** (the journeys file's rule): no item is a row, so
 * none can be left behind by a bug that forgot to clear it. If a "seen" state
 * is ever needed for replies, record the *read*, never an "unread" flag
 * someone has to clear.
 *
 * ## How a later stage extends this file
 *
 * The catalogue below is §6.3 whole — all twenty kinds are in the GraphQL
 * enum already, so a stage never edits the SDL to add one. To ship a kind:
 *
 * 1. Add its facts to `AttentionInput` (a new optional list), and have
 *    `resolvers/wizard.ts`'s loader fill them from the stage's own rows.
 * 2. Push its items in `allItems` below — `waitingOn`, `since`, `params`, and
 *    the two visibility flags: `internal` (Root's housekeeping, never shown to
 *    the customer) and `money` (PD-21: only money readers).
 * 3. Add its sentences to `ATTENTION_SENTENCES` and to **both** locale files
 *    under `attention.<KIND>.<variant>.<customer|staff>`; `attention.test.ts`
 *    reads the locale files and fails on a missing one.
 *
 * Shipped in J3, the ones whose data exists already: the pending banner
 * (`DRAFT_TO_REVIEW`, `ROUND_PUBLISHED`), overdue dependencies
 * (`COMMITMENT_OVERDUE`) and demo items addressed (`ANSWER_PUBLISHED`).
 * J13 adds `INVOICE_OVERDUE`: one line per contract, "N invoices are past
 * their due day", the customer's move and about money (`money`, PD-21: shown
 * to the customer and to those who may read money, no one else). There is no
 * reminder — no scheduler — so this is the only place an overdue invoice is
 * said out loud, and it is said on read. `INVOICE_DUE` (coming due) and
 * `INVOICE_ISSUABLE` (the desk's *Issue next* is enabled) are still declared
 * and unemitted: the brief asked for overdue, and the button already says the
 * second on the plan itself.
 * S2 makes the three feedback kinds real for every step: Root owes an answer
 * (`FEEDBACK_UNRESOLVED`), an answer waits for sales (`ANSWER_PENDING_APPROVAL`,
 * Root's housekeeping — staff only), Root has answered and the customer's
 * move is to reopen or approve (`ANSWER_PUBLISHED`).
 * Not shipped though the data exists: `TICKET_REPLY` and `REQUEST_MESSAGE`
 * (J3 names the three above), `ASSIGNEE_INACTIVE` (J4 decides who sees it).
 */

/** §6.3, in the catalogue's order. */
export const ATTENTION_KINDS = [
  'STEP_WAITING',
  'DRAFT_TO_REVIEW',
  'ANSWER_PUBLISHED',
  'ANSWER_PENDING_APPROVAL',
  'PROPOSAL_DECIDED',
  'PROPOSAL_TO_DECIDE',
  'FEEDBACK_UNRESOLVED',
  'ROUND_PUBLISHED',
  'ITERATION_PUBLISHED',
  'DEMO_READY_TO_APPROVE',
  'COMMITMENT_OVERDUE',
  'INVOICE_DUE',
  'INVOICE_OVERDUE',
  'INVOICE_ISSUABLE',
  'REQUEST_MESSAGE',
  'TICKET_REPLY',
  'TRADE_TO_CONFIRM',
  'ALLOWANCE_EXHAUSTED',
  'DEMO_NOT_READY',
  'ASSIGNEE_INACTIVE',
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type WaitingOn = 'CUSTOMER' | 'ROOT';
/** The staff job an item routes to, where it routes to one. Not a `Role`
 *  (house rule 1): the three jobs the plan names, as the SDL enum. */
export type WorkRole = 'SALES' | 'DESIGNER' | 'DEVELOPER';

export type AttentionItem = {
  kind: AttentionKind;
  /** Which sentence of the kind to show (`attention.<kind>.<variant>.<audience>`
   *  in the locale files) — chosen here so the client never re-derives it. */
  variant: string;
  contractId: string;
  phaseId: string | null;
  waitingOn: WaitingOn;
  role: WorkRole | null;
  /** When the wait began; the list is longest-waiting first. */
  since: Date;
  /** The numbers and names the sentence interpolates. Strings and numbers only:
   *  the API returns codes and parameters, never prose. */
  params: Record<string, string | number>;
  /** Root's own housekeeping — hidden from a customer (`attentionVisibleTo`). */
  internal: boolean;
  /** About money — shown only to those who may read it (PD-21). */
  money: boolean;
};

export type Audience = 'customer' | 'staff';
const BOTH: readonly Audience[] = ['customer', 'staff'];

/**
 * Every sentence a shipped kind can need: kind → variant → the audiences it is
 * shown to. The locale files must carry each, in both languages
 * (`attention.test.ts`). A Root-side overdue commitment is staff-only, so it
 * has no customer sentence to write.
 */
export const ATTENTION_SENTENCES: Partial<Record<AttentionKind, Record<string, readonly Audience[]>>> = {
  DRAFT_TO_REVIEW: { contract: BOTH, amendmentApprove: BOTH, amendmentSign: BOTH },
  ROUND_PUBLISHED: { default: BOTH },
  ANSWER_PUBLISHED: { default: BOTH },
  FEEDBACK_UNRESOLVED: { default: BOTH },
  ANSWER_PENDING_APPROVAL: { default: ['staff'] },
  COMMITMENT_OVERDUE: { customer: BOTH, root: ['staff'] },
  INVOICE_OVERDUE: { default: BOTH },
};

/** What `Contract.pending` (fields.ts) says, reduced to the facts attention
 *  needs — with the dates the wait began on, which the banner never showed. */
export type PendingFacts = {
  contract: { fromVersion: number; toVersion: number; since: Date } | null;
  designChangeCount: number;
  designSince: Date | null;
  amendment: { ordinal: number; approved: boolean; since: Date } | null;
};

export type AttentionInput = {
  contractId: string;
  customerId: string;
  now: Date;
  pending: PendingFacts | null;
  /** The project's commitments, both sides. */
  dependencies: Array<{
    id: string;
    side: WaitingOn;
    titleFa: string;
    titleEn: string;
    dueAt: Date;
    verifiedAt: Date | null;
  }>;
  /** Feedback on every step (S2), reduced to three lists of facts — the loader
   *  decides membership, this file only groups and words them. */
  feedback: FeedbackFacts;
  /** The contract's issued, unpaid invoices (J13) — this file decides which of
   *  them are overdue (`isOverdue`, lib/invoice.ts), like the dependencies. */
  invoices: InvoiceLike[];
};

/** One item's worth of a feedback fact. `money` is PD-21's flag (the item is
 *  about the budget, the payment plan or a sensitive article) and travels onto
 *  the attention item, so `attentionVisibleTo` does the hiding. */
export type FeedbackFact = { step: StepKind; phaseId: string | null; money: boolean; since: Date };

export type FeedbackFacts = {
  /** Items still `OPEN`: Root owes an answer. `since` is the customer's last
   *  word on it. */
  unresolved: FeedbackFact[];
  /** Answers written but not yet approved (`PENDING`): sales' queue. */
  pendingApproval: FeedbackFact[];
  /** Items Root has resolved (addressed, declined or moved) that the customer
   *  has not yet accepted — an approval will. `since` is when the answer
   *  reached them: for an item addressed in a build, the build's publish time
   *  (the customer was not told before it). */
  answered: FeedbackFact[];
};

const stepRole = (step: StepKind): WorkRole =>
  step === 'DESIGN' || step === 'MOCKUP' ? 'DESIGNER' : step === 'DEMO' ? 'DEVELOPER' : 'SALES';

/** One line per (step, phase, money), not per item: "three comments are
 *  waiting" is the fact; three lines are noise. Money is a key so the money
 *  items' line can be hidden alone. */
function groupFacts(facts: readonly FeedbackFact[]): Array<{ step: StepKind; phaseId: string | null; money: boolean; count: number; since: Date }> {
  const groups = new Map<string, { step: StepKind; phaseId: string | null; money: boolean; count: number; since: Date }>();
  for (const f of facts) {
    const key = `${f.step}|${f.phaseId ?? ''}|${f.money}`;
    const seen = groups.get(key);
    if (!seen) groups.set(key, { step: f.step, phaseId: f.phaseId, money: f.money, count: 1, since: f.since });
    else groups.set(key, { ...seen, count: seen.count + 1, since: seen.since < f.since ? seen.since : f.since });
  }
  return [...groups.values()];
}

function allItems(input: AttentionInput): AttentionItem[] {
  const base = { contractId: input.contractId, phaseId: null, role: null, internal: false, money: false } as const;
  const items: AttentionItem[] = [];
  const { pending } = input;

  if (pending?.contract) {
    items.push({
      ...base,
      kind: 'DRAFT_TO_REVIEW',
      variant: 'contract',
      waitingOn: 'CUSTOMER',
      since: pending.contract.since,
      params: { fromVersion: pending.contract.fromVersion, toVersion: pending.contract.toVersion },
    });
  }
  if (pending?.amendment) {
    items.push({
      ...base,
      kind: 'DRAFT_TO_REVIEW',
      variant: pending.amendment.approved ? 'amendmentSign' : 'amendmentApprove',
      waitingOn: 'CUSTOMER',
      since: pending.amendment.since,
      params: { label: `A${pending.amendment.ordinal}` },
    });
  }
  if (pending && pending.designChangeCount > 0) {
    items.push({
      ...base,
      kind: 'ROUND_PUBLISHED',
      variant: 'default',
      waitingOn: 'CUSTOMER',
      since: pending.designSince ?? input.now,
      params: { count: pending.designChangeCount },
    });
  }

  for (const d of input.dependencies) {
    if (!isOverdue(d, input.now)) continue;
    const root = d.side === 'ROOT';
    items.push({
      ...base,
      kind: 'COMMITMENT_OVERDUE',
      variant: root ? 'root' : 'customer',
      waitingOn: d.side,
      // Sales keeps the board (`contracts.author` holds the dependency
      // mutations), so a late Root commitment routes there.
      role: root ? 'SALES' : null,
      internal: root,
      since: d.dueAt,
      params: { dependencyId: d.id, titleFa: d.titleFa, titleEn: d.titleEn },
    });
  }

  // One line for all of a contract's overdue invoices, longest-overdue first
  // (`since` is the earliest due day): the count is the fact, and three lines
  // for three invoices would say the same thing three times. Hidden from
  // anyone who may not read money (PD-21) by `attentionVisibleTo`.
  const overdueInvoices = input.invoices.filter((i) => isInvoiceOverdue(i, input.now));
  if (overdueInvoices.length > 0) {
    items.push({
      ...base,
      kind: 'INVOICE_OVERDUE',
      variant: 'default',
      waitingOn: 'CUSTOMER',
      money: true,
      since: overdueInvoices.reduce((a, i) => (i.dueAt!.getTime() < a.getTime() ? i.dueAt! : a), overdueInvoices[0].dueAt!),
      params: { count: overdueInvoices.length },
    });
  }

  // One line per phase, not per item: "three things you raised were
  // addressed" is the customer's next move; three lines are noise.
  for (const g of groupFacts(input.feedback.answered)) {
    items.push({
      ...base,
      kind: 'ANSWER_PUBLISHED',
      variant: 'default',
      phaseId: g.phaseId,
      waitingOn: 'CUSTOMER',
      since: g.since,
      money: g.money,
      params: { count: g.count, step: g.step },
    });
  }

  // Root owes the customer an answer: the step's owner's move.
  for (const g of groupFacts(input.feedback.unresolved)) {
    items.push({
      ...base,
      kind: 'FEEDBACK_UNRESOLVED',
      variant: 'default',
      phaseId: g.phaseId,
      waitingOn: 'ROOT',
      role: stepRole(g.step),
      since: g.since,
      money: g.money,
      params: { count: g.count, step: g.step },
    });
  }

  // An answer written and not yet published is sales' to decide, and nobody
  // else's business — the customer never sees that it exists (`internal`).
  for (const g of groupFacts(input.feedback.pendingApproval)) {
    items.push({
      ...base,
      kind: 'ANSWER_PENDING_APPROVAL',
      variant: 'default',
      phaseId: g.phaseId,
      waitingOn: 'ROOT',
      role: 'SALES',
      internal: true,
      since: g.since,
      money: g.money,
      params: { count: g.count, step: g.step },
    });
  }

  return items;
}

/**
 * The typed items for one contract, as this viewer may see them, longest-
 * waiting first (ties by kind, then variant, so the order is total).
 */
export function attentionFor(input: AttentionInput, viewer: Pick<User, 'id' | 'roles'>): AttentionItem[] {
  return allItems(input)
    .filter((item) => attentionVisibleTo(viewer, { customerId: input.customerId }, item))
    .sort(
      (a, b) =>
        a.since.getTime() - b.since.getTime() ||
        ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind) ||
        a.variant.localeCompare(b.variant),
    );
}
