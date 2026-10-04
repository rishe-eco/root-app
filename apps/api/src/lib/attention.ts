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
 * J5 ships `PROPOSAL_TO_DECIDE` (proposals waiting for Root) and
 * `TRADE_TO_CONFIRM` (a scope trade waiting on the customer, on Root, or on
 * Root carrying it out). `PROPOSAL_DECIDED` is *not* shipped: it would need a
 * "seen" state to know when the customer has read a decision, and the derived-
 * never-stored rule above forbids inventing one for it — the notification is
 * what tells them, and the proposal itself shows its fate.
 *
 * **J12 (the home screens) makes more real and closes J9b's gap.** In this
 * module, per contract: `ITERATION_PUBLISHED` (a mockup iteration is out and the
 * customer has neither approved nor commented — their move), `DEMO_READY_TO_APPROVE`
 * (the same for a phase's demo), `DEMO_NOT_READY` (a staging site no browser of
 * Root's has yet seen report — the developer's housekeeping), `INVOICE_DUE` (an
 * issued, unpaid invoice not yet past its day — the customer's move), `INVOICE_ISSUABLE`
 * (a planned invoice `canIssuePlanned` allows — sales' move) and `STEP_WAITING`
 * (the design, the mockup or a phase's demo is the current step and nothing has
 * been shown yet — the designer's or the developer's move). Not per contract, in
 * `lib/home.ts`: `REQUEST_MESSAGE` and `TICKET_REPLY`, which belong to a project
 * that may not be a contract and a ticket that may belong to none. And one variant
 * of a shipped kind: `DRAFT_TO_REVIEW` gains `draft` (the contract's *first*
 * published draft, on the new road — read it, say what you want changed, approve it)
 * and `sign` (approved, not yet signed); the banner only ever compared a revision
 * with an earlier one the customer had approved, so the dashboard would have said
 * nothing on the day sales published the draft. Not shipped,
 * still: `PROPOSAL_DECIDED` (needs a "seen" state — see below), `ALLOWANCE_EXHAUSTED`
 * (a notification, and the allowance counters already say it) and
 * `ASSIGNEE_INACTIVE` (J4 decides who sees it).
 *
 * **Why no read record in J12.** Every kind above clears by the *next act of the
 * party whose move it is* — the customer comments or approves, sales answers, a
 * published demo is approved, an invoice is paid — not by anyone having looked.
 * A conversation's turn is the author of its last message (`REQUEST_MESSAGE`,
 * `TICKET_REPLY`), the same ownership edge V4's review queue uses. The kinds that
 * would need a read (`PROPOSAL_DECIDED`) are the ones left out, so there is no
 * unread flag anywhere for someone to clear.
 *
 * `role` is the job that *follows an item up*, not whose move it is: an overdue
 * invoice waits on the customer and is sales' to chase; a technical commitment
 * is the developer's whichever side owes it. The home screen's "my work"
 * (`lib/home.ts`) is the items whose job is one of the viewer's.
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
  // J12 adds the contract's *first* published draft (`draft`: read it, say what you want
  // changed, approve it) and its signature (`sign`) — until then only a revision made after
  // an approval, or an amendment, was a line.
  DRAFT_TO_REVIEW: { contract: BOTH, draft: BOTH, sign: BOTH, amendmentApprove: BOTH, amendmentSign: BOTH },
  ROUND_PUBLISHED: { default: BOTH },
  ANSWER_PUBLISHED: { default: BOTH },
  FEEDBACK_UNRESOLVED: { default: BOTH },
  ANSWER_PENDING_APPROVAL: { default: ['staff'] },
  COMMITMENT_OVERDUE: { customer: BOTH, root: ['staff'] },
  // J5: proposals waiting for Root's decision, and a scope trade waiting on
  // one side or the other — the customer's confirmation, Root's confirmation,
  // or Root carrying out a trade both have confirmed.
  PROPOSAL_TO_DECIDE: { default: BOTH },
  TRADE_TO_CONFIRM: { customer: BOTH, root: BOTH, execute: BOTH },
  INVOICE_OVERDUE: { default: BOTH },
  // J12. A published mockup iteration or phase demo is the customer's to review;
  // the staff sentence says what Root is waiting for.
  ITERATION_PUBLISHED: { default: BOTH },
  DEMO_READY_TO_APPROVE: { default: BOTH },
  // Root's housekeeping: only a contract reader reads that a demo is not ready.
  DEMO_NOT_READY: { default: ['staff'] },
  INVOICE_DUE: { default: BOTH },
  INVOICE_ISSUABLE: { default: ['staff'] },
  // One variant per step that can be the current one with nothing shown yet. A
  // customer reads these as "Root is working on it"; the staff sentence names the
  // job.
  STEP_WAITING: { DESIGN: BOTH, MOCKUP: BOTH, DEMO: BOTH },
  // The two that live outside a contract (`lib/home.ts`). Whose move it is
  // decides the variant: `reply` is the customer's; `sent` and `open` are Root's,
  // written for the customer who is waiting; `unanswered` is Root's, written for
  // sales.
  REQUEST_MESSAGE: { reply: ['customer'], sent: ['customer'], unanswered: ['staff'] },
  TICKET_REPLY: { reply: ['customer'], open: ['customer'], unanswered: ['staff'] },
};

/** What `Contract.pending` (fields.ts) says, reduced to the facts attention
 *  needs — with the dates the wait began on, which the banner never showed. */
export type PendingFacts = {
  contract: { fromVersion: number; toVersion: number; since: Date } | null;
  designChangeCount: number;
  designSince: Date | null;
  amendment: { ordinal: number; approved: boolean; since: Date } | null;
  /** J12: the contract's first published draft, on the new road — to read and
   *  approve (`review`), or approved and waiting for the signature (`sign`).
   *  Optional so fixtures that predate it need not name it. */
  draft?: { state: 'review' | 'sign'; version: number; since: Date } | null;
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
    /** J4's flag: hosting, DNS, credentials. Optional so fixtures that predate J12
     *  need not name it. A technical commitment is the developer's to follow up,
     *  whichever side owes it. */
    technical?: boolean;
  }>;
  /** Feedback on every step (S2), reduced to three lists of facts — the loader
   *  decides membership, this file only groups and words them. */
  feedback: FeedbackFacts;
  /** The contract's issued, unpaid invoices (J13) — this file decides which of
   *  them are overdue (`isOverdue`, lib/invoice.ts), like the dependencies. */
  invoices: AttentionInvoice[];
  /** Step 2a (J5). Optional so fixtures that predate it need not name it. */
  scope?: ScopeFacts;
  /** Steps 4–6 (J12): what the design, the mockup and the demos are waiting on.
   *  Optional for the same reason `scope` is. */
  steps?: StepFacts;
  /** Planned invoices `canIssuePlanned` allows right now (J13's rule, J12's
   *  line): the plan's ordinal and when it became issuable. */
  issuable?: Array<{ ordinal: number; since: Date }>;
};

/** An issued, unpaid invoice, with enough of itself to name and route to it. */
export type AttentionInvoice = InvoiceLike & { id: string; invoiceNumber: string | null };

/**
 * What the design, the mockup and the demos are waiting on (J12) — membership
 * decided by the loader (`resolvers/wizard.ts`'s `stepFacts`), like
 * `FeedbackFacts`: this file only words and routes them.
 */
export type StepFacts = {
  /** The wizard's current step, when it is the design, the mockup or a phase's
   *  demo, nothing has been shown for it yet and so the move is Root's. `since`
   *  is when the road reached it (the previous step's finish or lock). */
  waiting: Array<{ step: 'DESIGN' | 'MOCKUP' | 'DEMO'; phaseId: string | null; phaseNumber: number | null; since: Date }>;
  /** A mockup iteration is out, not approved, and no note on it waits for Root. */
  mockupOut: { count: number; since: Date } | null;
  /** The same for each phase's demo. */
  demosOut: Array<{ phaseId: string; phaseNumber: number; since: Date }>;
  /** A phase's staging site has a URL and no browser of Root's has seen it report. */
  demosNotReady: Array<{ phaseId: string; phaseNumber: number; since: Date }>;
};

/** What the scope step is waiting on. A trade is open until it executes; who it
 *  waits on is read off which halves are confirmed. */
export type ScopeFacts = {
  undecidedProposals: Array<{ since: Date }>;
  openTrades: Array<{ id: string; proposedAt: Date; rootConfirmedAt: Date | null; customerConfirmedAt: Date | null }>;
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
  if (pending?.draft) {
    items.push({
      ...base,
      kind: 'DRAFT_TO_REVIEW',
      variant: pending.draft.state === 'review' ? 'draft' : 'sign',
      waitingOn: 'CUSTOMER',
      since: pending.draft.since,
      params: { version: pending.draft.version },
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
      // mutations), so a late Root commitment routes there — unless it is a
      // technical one (hosting, DNS, credentials), which the developer verifies
      // (`dependencies.verifyTechnical`) whichever side owes it.
      role: d.technical ? 'DEVELOPER' : root ? 'SALES' : null,
      internal: root,
      since: d.dueAt,
      params: { dependencyId: d.id, titleFa: d.titleFa, titleEn: d.titleEn },
    });
  }

  items.push(...invoiceItems(input.invoices, input.now, base));

  // A planned invoice sales may issue (J12, J13's rule): one line per contract
  // with the count — the desk's *Issue next* is what acts on it. Root's own
  // move and about money, so only money readers see it; and it is not the
  // customer's business that Root has not yet sent an invoice.
  if (input.issuable && input.issuable.length > 0) {
    items.push({
      ...base,
      kind: 'INVOICE_ISSUABLE',
      variant: 'default',
      waitingOn: 'ROOT',
      role: 'SALES',
      internal: true,
      money: true,
      since: input.issuable.reduce((a, i) => (i.since < a ? i.since : a), input.issuable[0].since),
      params: { count: input.issuable.length },
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

  // Step 2a (J5). Proposals waiting for Root are one line, not one per proposal
  // ("three things you asked for are waiting" is the fact). A scope trade is
  // the post-lock way to change a scope, so it is what the customer is told to
  // confirm — and Root to confirm or carry out.
  const scope = input.scope;
  if (scope && scope.undecidedProposals.length > 0) {
    items.push({
      ...base,
      kind: 'PROPOSAL_TO_DECIDE',
      variant: 'default',
      waitingOn: 'ROOT',
      role: 'SALES',
      since: scope.undecidedProposals.reduce((a, p) => (p.since < a ? p.since : a), scope.undecidedProposals[0].since),
      params: { count: scope.undecidedProposals.length },
    });
  }
  for (const trade of scope?.openTrades ?? []) {
    const both = trade.rootConfirmedAt !== null && trade.customerConfirmedAt !== null;
    if (trade.customerConfirmedAt === null) {
      items.push({
        ...base,
        kind: 'TRADE_TO_CONFIRM',
        variant: 'customer',
        waitingOn: 'CUSTOMER',
        since: trade.proposedAt,
        params: { tradeId: trade.id },
      });
    }
    if (trade.rootConfirmedAt === null || both) {
      items.push({
        ...base,
        kind: 'TRADE_TO_CONFIRM',
        variant: both ? 'execute' : 'root',
        waitingOn: 'ROOT',
        role: 'SALES',
        since: trade.proposedAt,
        params: { tradeId: trade.id },
      });
    }
  }

  items.push(...stepItems(input.steps, base));

  return items;
}

type ItemBase = Pick<AttentionItem, 'contractId' | 'phaseId' | 'role' | 'internal' | 'money'>;

/**
 * Invoice lines, shared by a contract's own invoices and by an account's
 * contract-less ones (`lib/home.ts`: subscriptions, tickets, service runs).
 * One line for all the overdue ones, longest-overdue first (`since` is the
 * earliest due day): the count is the fact, and three lines for three invoices
 * would say the same thing three times. One line *each* for the ones not yet
 * overdue, because each is a number to pay by a day. Hidden from anyone who may
 * not read money (PD-21) by `attentionVisibleTo`.
 *
 * `role` SALES on the overdue line is the follow-up (see the header): the
 * customer owes the money and sales is who asks for it.
 */
export function invoiceItems(invoices: readonly AttentionInvoice[], now: Date, base: ItemBase): AttentionItem[] {
  const items: AttentionItem[] = [];
  const overdue = invoices.filter((i) => isInvoiceOverdue(i, now));
  if (overdue.length > 0) {
    items.push({
      ...base,
      kind: 'INVOICE_OVERDUE',
      variant: 'default',
      waitingOn: 'CUSTOMER',
      role: 'SALES',
      money: true,
      since: overdue.reduce((a, i) => (i.dueAt!.getTime() < a.getTime() ? i.dueAt! : a), overdue[0].dueAt!),
      params: { count: overdue.length },
    });
  }
  for (const i of invoices) {
    if (i.issuedAt === null || i.paidAt !== null || isInvoiceOverdue(i, now)) continue;
    items.push({
      ...base,
      kind: 'INVOICE_DUE',
      variant: 'default',
      waitingOn: 'CUSTOMER',
      money: true,
      // The wait began when the invoice reached them.
      since: i.issuedAt,
      params: {
        invoiceId: i.id,
        number: i.invoiceNumber ?? '',
        // A calendar day (PD-19), as ISO text; the client formats it for the reader.
        dueAt: i.dueAt ? i.dueAt.toISOString().slice(0, 10) : '',
      },
    });
  }
  return items;
}

/**
 * Steps 4–6 as attention (J12, closing J9b's owed gap: "the attention module and
 * status area do not know about the mockup"). Each is the loader's fact, wired
 * to a kind, a side and a job: a published mockup iteration or demo is the
 * customer's move; a staging site not yet seen to report is the developer's
 * housekeeping (`internal`: it is never the customer's business); a step that
 * is current with nothing shown is the step's owner's move, and the customer is
 * told Root is on it.
 */
function stepItems(steps: StepFacts | undefined, base: ItemBase): AttentionItem[] {
  if (!steps) return [];
  const items: AttentionItem[] = [];
  for (const w of steps.waiting) {
    items.push({
      ...base,
      kind: 'STEP_WAITING',
      variant: w.step,
      phaseId: w.phaseId,
      waitingOn: 'ROOT',
      role: w.step === 'DEMO' ? 'DEVELOPER' : 'DESIGNER',
      since: w.since,
      params: w.phaseNumber === null ? { step: w.step } : { step: w.step, phase: w.phaseNumber },
    });
  }
  if (steps.mockupOut) {
    items.push({
      ...base,
      kind: 'ITERATION_PUBLISHED',
      variant: 'default',
      waitingOn: 'CUSTOMER',
      since: steps.mockupOut.since,
      params: { count: steps.mockupOut.count, step: 'MOCKUP' },
    });
  }
  for (const d of steps.demosOut) {
    items.push({
      ...base,
      kind: 'DEMO_READY_TO_APPROVE',
      variant: 'default',
      phaseId: d.phaseId,
      waitingOn: 'CUSTOMER',
      since: d.since,
      params: { step: 'DEMO', phase: d.phaseNumber },
    });
  }
  for (const d of steps.demosNotReady) {
    items.push({
      ...base,
      kind: 'DEMO_NOT_READY',
      variant: 'default',
      phaseId: d.phaseId,
      waitingOn: 'ROOT',
      role: 'DEVELOPER',
      internal: true,
      since: d.since,
      params: { step: 'DEMO', phase: d.phaseNumber },
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
