import type { ContractSequence, ContractStatus, ProjectStatus, StepKind, User } from '@prisma/client';
import { can, type Capability } from './capabilities.js';
import {
  ATTENTION_KINDS,
  attentionFor,
  invoiceItems,
  type AttentionInput,
  type AttentionInvoice,
  type AttentionItem,
  type AttentionKind,
  type WaitingOn,
} from './attention.js';
import { canAuthorBuild, canAuthorDesign, contractVisibleToStaff, requestVisibleTo } from './visibility.js';

/**
 * The home screens (journeys build plan J12): what is waiting on **me**, as one
 * list, for the customer's dashboard and for each staff role's *My work*.
 *
 * **There is no second rule set.** A contract's items are `attentionFor` — the
 * module J3 built and every stage since has extended — asked once per contract
 * with the same viewer, so its `internal` and `money` hiding (`attentionVisibleTo`,
 * lib/visibility.ts) applies here exactly as on the contract page. What this file
 * adds is the three things a *list across contracts* needs and a contract page
 * does not:
 *
 * 1. **Which contracts and which items are mine** — a customer's are the ones
 *    they own; a staff member's are the ones `contractVisibleToStaff` admits,
 *    narrowed to the items whose *job* they hold (`mayWork`): the capability
 *    that does the job, and for design and development the assignment edge
 *    (`canAuthorDesign` / `canAuthorBuild` — a capability and an ownership edge,
 *    checked separately, house rule 2; ADMIN's `assignments.override` is what
 *    makes ADMIN's list everyone's). A delivered contract is out of a designer's
 *    and developer's reach by `contractVisibleToStaff` (J11), so its items leave
 *    their home with it.
 * 2. **Things that are not a contract's** — a request (a project that may never
 *    become one), a ticket, and an invoice with no contract (a subscription
 *    period, a service run). `REQUEST_MESSAGE`, `TICKET_REPLY` and the
 *    contract-less invoice lines live here, in the same shape.
 * 3. **A destination** — each item says where to open it (`routeFor`): a path
 *    inside the app, without the language prefix, which the web puts one in
 *    front of. A route is the API's statement of *what the item is about*; the
 *    router that serves it is the web's, and `home.test.ts` holds the two to
 *    each other.
 *
 * **Derived, never stored** (the journeys file's rule, and J12's trap). Nothing
 * here is a row: not an unread count, not a "dismissed" flag. A conversation's
 * turn is whoever wrote its last message — the same ownership edge V4's review
 * queue uses — so an item clears by the next act of whoever's move it is, never
 * by someone having looked. See `lib/attention.ts`'s header for the kinds this
 * leaves out for that reason.
 *
 * Pure over loaded rows (`resolvers/home.ts` loads them, in a number of queries
 * that does not grow with the number of contracts).
 */

type Viewer = Pick<User, 'id' | 'roles'>;

/** A contract as the home screen needs it: what to name it, the edges
 *  visibility reads, and the attention module's input (`attentionInputOf`). */
export type HomeContract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  customerId: string;
  customerName: string;
  sequence: ContractSequence;
  status: ContractStatus;
  publishedAt: Date | null;
  deliveredAt: Date | null;
  designerId: string | null;
  developerId: string | null;
  project: { status: ProjectStatus };
  input: AttentionInput;
};

/** A pending request and who spoke last in its thread (null: nobody has —
 *  the request's own text is the customer's first word). */
export type HomeRequest = {
  id: string;
  title: string;
  customerId: string;
  customerName: string;
  requestedAt: Date;
  lastMessage: { authorId: string; at: Date } | null;
};

export type HomeTicket = {
  id: string;
  subject: string;
  customerId: string;
  customerName: string;
  createdAt: Date;
  /** `null` for a ticket made from a feedback item, which starts with no message. */
  lastMessage: { authorId: string; at: Date } | null;
};

/** An issued, unpaid invoice that belongs to no contract. */
export type HomeAccountInvoice = AttentionInvoice & { customerId: string; customerName: string };

export type HomeInput = {
  viewer: Viewer;
  now: Date;
  contracts: HomeContract[];
  /** Pending requests only (`REQUESTED`); the loader filters, as it does for tickets. */
  requests: HomeRequest[];
  /** Open and in-progress tickets only. */
  tickets: HomeTicket[];
  accountInvoices: HomeAccountInvoice[];
};

export type HomeAudience = 'CUSTOMER' | 'STAFF';

export type HomeItem = Omit<AttentionItem, 'contractId' | 'internal' | 'money'> & {
  /** Null for what is not a contract's: a request, a ticket, a contract-less invoice. */
  contractId: string | null;
  /** Which sentence set to read it in — `attention.<kind>.<variant>.<customer|staff>`. */
  audience: HomeAudience;
  /** A path inside the app, no language prefix: `/app/contracts/…`, `/desk/…`. */
  route: string;
  /** What it is about, for the line's context: a contract's ref and title, a
   *  request's or a ticket's own title, a customer's name. */
  subject: { ref: string | null; titleFa: string; titleEn: string; customerName: string };
};

// --- whose job is it ------------------------------------------------------------------------

/**
 * The capability that does an item's job, where it is not the job's default
 * (sales' `contracts.author`). Not `role === 'SALES'` anywhere (house rule 1):
 * ADMIN holds all of these, a person holding two roles gets the union, and the
 * three jobs below are labels the attention module put on its items.
 */
const JOB_CAPABILITY: Partial<Record<AttentionKind, Capability>> = {
  ANSWER_PENDING_APPROVAL: 'feedback.approveAnswers',
  INVOICE_OVERDUE: 'billing.manage',
  INVOICE_ISSUABLE: 'billing.manage',
};

type WorkContract = Pick<HomeContract, 'designerId' | 'developerId'>;

/**
 * Whether this item is *my work* on this contract: its job is one I hold. Sales'
 * items need the capability that does them; design's and development's need the
 * capability **and** the assignment (or `assignments.override`). An item with no
 * job (`role: null` — a customer's late commitment, a customer's pending
 * review) is nobody's work, only the contract page's information.
 */
export function mayWork(viewer: Viewer, c: WorkContract, item: Pick<AttentionItem, 'kind' | 'role'>): boolean {
  switch (item.role) {
    case 'SALES':
      return can(viewer, JOB_CAPABILITY[item.kind] ?? 'contracts.author');
    case 'DESIGNER':
      return canAuthorDesign(viewer, c);
    case 'DEVELOPER':
      return canAuthorBuild(viewer, c);
    default:
      return false;
  }
}

// --- where to open it -------------------------------------------------------------------------

/** The step an item is about, where it is about one — the wizard opens on it. */
function stepOf(item: Pick<AttentionItem, 'kind' | 'params'>): StepKind | null {
  switch (item.kind) {
    case 'DRAFT_TO_REVIEW':
      return 'AGREEMENT';
    case 'ROUND_PUBLISHED':
      return 'DESIGN';
    case 'PROPOSAL_TO_DECIDE':
    case 'TRADE_TO_CONFIRM':
      return 'SCOPE';
    case 'ANSWER_PUBLISHED':
    case 'FEEDBACK_UNRESOLVED':
    case 'ANSWER_PENDING_APPROVAL':
    case 'STEP_WAITING':
    case 'ITERATION_PUBLISHED':
    case 'DEMO_READY_TO_APPROVE':
    case 'DEMO_NOT_READY':
      return (item.params.step as StepKind | undefined) ?? null;
    default:
      return null;
  }
}

const withStep = (path: string, step: StepKind | null, phaseId: string | null) =>
  step === null ? path : `${path}?step=${step}${phaseId ? `&phase=${phaseId}` : ''}`;

/**
 * The path an item opens. The customer's own contract is one route
 * (`/app/contracts/:id`) that opens on the step named; the desk's is the
 * workspace's Steps tab on the new road (the legacy road has no such tab — its
 * steps are the tabs beside it — and ignores a step it cannot show), with a few
 * kinds sent to the surface that acts on them instead: the approvals queue, the
 * billing screen, the Phases tab where a demo's readiness is verified, the
 * dependency board.
 */
export function routeFor(
  audience: HomeAudience,
  item: Pick<AttentionItem, 'kind' | 'phaseId' | 'params'>,
  contract: { id: string; sequence: ContractSequence },
): string {
  const step = stepOf(item);
  if (audience === 'CUSTOMER') {
    if (item.kind === 'INVOICE_DUE') return `/app/invoices/${item.params.invoiceId}`;
    if (item.kind === 'INVOICE_OVERDUE') return '/app/invoices';
    return withStep(`/app/contracts/${contract.id}`, step, item.phaseId);
  }
  switch (item.kind) {
    case 'ANSWER_PENDING_APPROVAL':
      return '/desk/approvals';
    case 'INVOICE_OVERDUE':
    case 'INVOICE_ISSUABLE':
      return '/desk/billing';
    case 'DEMO_NOT_READY':
      return `/desk/contracts/${contract.id}/phases`;
    case 'COMMITMENT_OVERDUE':
      return `/desk/contracts/${contract.id}/dependencies`;
    case 'TRADE_TO_CONFIRM':
      return `/desk/contracts/${contract.id}/scope`;
    default:
      return contract.sequence === 'AGREEMENT_FIRST'
        ? withStep(`/desk/contracts/${contract.id}/steps`, step, item.phaseId)
        : `/desk/contracts/${contract.id}`;
  }
}

// --- the list ----------------------------------------------------------------------------------

const subjectOf = (c: HomeContract): HomeItem['subject'] => ({
  ref: c.ref,
  titleFa: c.titleFa,
  titleEn: c.titleEn,
  customerName: c.customerName,
});

/** A contract's item as a home item. `contractId: ''` (the invoice helper's
 *  stand-in for "no contract") is a null here. */
function wrap(
  item: AttentionItem,
  audience: HomeAudience,
  route: string,
  subject: HomeItem['subject'],
): HomeItem {
  const { internal: _internal, money: _money, ...rest } = item;
  return { ...rest, contractId: item.contractId === '' ? null : item.contractId, audience, route, subject };
}

const NO_CONTRACT = { contractId: '', phaseId: null, role: null, internal: false, money: false } as const;

/**
 * A request or a ticket is Root's move while its last message is the customer's
 * (or there is none) and the customer's while it is anyone else's. **The edge is
 * `authorId === customerId`** — ownership, not a role test (house rule 2) — so an
 * ADMIN replying on a customer's behalf, or a designer who was copied in, is
 * "Root" without the code knowing their roles.
 */
function turn(customerId: string, last: { authorId: string } | null): WaitingOn {
  return last === null || last.authorId === customerId ? 'ROOT' : 'CUSTOMER';
}

const KIND_ORDER = (k: AttentionKind) => ATTENTION_KINDS.indexOf(k);

/**
 * The viewer's items, longest-waiting first; for a customer the ones waiting on
 * *them* come first, then the ones waiting on Root (the second group is
 * information: "Root has your request"). A staff member's list is "mine to do"
 * and so is mostly Root's side by construction.
 */
export function homeFor(input: HomeInput): HomeItem[] {
  const { viewer, now } = input;
  const items: HomeItem[] = [];

  // --- as a customer: everything about what I own ------------------------------------------
  for (const c of input.contracts) {
    if (c.customerId !== viewer.id || c.publishedAt === null || c.status === 'DISCARDED') continue;
    for (const item of attentionFor(c.input, viewer)) {
      items.push(wrap(item, 'CUSTOMER', routeFor('CUSTOMER', item, c), subjectOf(c)));
    }
  }
  for (const r of input.requests) {
    if (r.customerId !== viewer.id) continue;
    const root = turn(r.customerId, r.lastMessage) === 'ROOT';
    items.push({
      kind: 'REQUEST_MESSAGE',
      variant: root ? 'sent' : 'reply',
      audience: 'CUSTOMER',
      contractId: null,
      phaseId: null,
      waitingOn: root ? 'ROOT' : 'CUSTOMER',
      role: null,
      since: r.lastMessage?.at ?? r.requestedAt,
      params: { title: r.title },
      route: `/app/contracts?request=${r.id}`,
      subject: { ref: null, titleFa: r.title, titleEn: r.title, customerName: r.customerName },
    });
  }
  for (const t of input.tickets) {
    if (t.customerId !== viewer.id) continue;
    const root = turn(t.customerId, t.lastMessage) === 'ROOT';
    items.push({
      kind: 'TICKET_REPLY',
      variant: root ? 'open' : 'reply',
      audience: 'CUSTOMER',
      contractId: null,
      phaseId: null,
      waitingOn: root ? 'ROOT' : 'CUSTOMER',
      role: null,
      since: t.lastMessage?.at ?? t.createdAt,
      params: { subject: t.subject },
      route: '/app/support',
      subject: { ref: null, titleFa: t.subject, titleEn: t.subject, customerName: t.customerName },
    });
  }
  const mine = input.accountInvoices.filter((i) => i.customerId === viewer.id);
  for (const item of invoiceItems(mine, now, NO_CONTRACT)) {
    const route = item.kind === 'INVOICE_DUE' ? `/app/invoices/${item.params.invoiceId}` : '/app/invoices';
    items.push(wrap(item, 'CUSTOMER', route, { ref: null, titleFa: '', titleEn: '', customerName: mine[0]?.customerName ?? '' }));
  }

  // --- as staff: the work I hold the job for -------------------------------------------------
  for (const c of input.contracts) {
    // My own contract is my dashboard's, not my desk's: a person who is both is
    // not shown it twice (and never a staff sentence about their own account).
    if (c.customerId === viewer.id || c.status === 'DISCARDED') continue;
    if (!contractVisibleToStaff(viewer, c)) continue;
    for (const item of attentionFor(c.input, viewer)) {
      if (!mayWork(viewer, c, item)) continue;
      items.push(wrap(item, 'STAFF', routeFor('STAFF', item, c), subjectOf(c)));
    }
  }
  if (can(viewer, 'contracts.author')) {
    for (const r of input.requests) {
      if (r.customerId === viewer.id) continue;
      if (!requestVisibleTo(viewer, { customerId: r.customerId, requestedAt: r.requestedAt })) continue;
      if (turn(r.customerId, r.lastMessage) !== 'ROOT') continue;
      items.push({
        kind: 'REQUEST_MESSAGE',
        variant: 'unanswered',
        audience: 'STAFF',
        contractId: null,
        phaseId: null,
        waitingOn: 'ROOT',
        role: 'SALES',
        since: r.lastMessage?.at ?? r.requestedAt,
        params: { title: r.title },
        route: `/desk/requests/${r.id}`,
        subject: { ref: null, titleFa: r.title, titleEn: r.title, customerName: r.customerName },
      });
    }
  }
  if (can(viewer, 'tickets.answer')) {
    for (const t of input.tickets) {
      if (t.customerId === viewer.id || turn(t.customerId, t.lastMessage) !== 'ROOT') continue;
      items.push({
        kind: 'TICKET_REPLY',
        variant: 'unanswered',
        audience: 'STAFF',
        contractId: null,
        phaseId: null,
        waitingOn: 'ROOT',
        role: 'SALES',
        since: t.lastMessage?.at ?? t.createdAt,
        params: { subject: t.subject },
        route: '/desk/tickets',
        subject: { ref: null, titleFa: t.subject, titleEn: t.subject, customerName: t.customerName },
      });
    }
  }
  // Overdue invoices that belong to no contract (a subscription period, a service
  // run): one line per customer, as a contract's are one line per contract.
  if (can(viewer, 'billing.manage') && can(viewer, 'money.read')) {
    const byCustomer = new Map<string, HomeAccountInvoice[]>();
    for (const i of input.accountInvoices) {
      if (i.customerId === viewer.id) continue;
      byCustomer.set(i.customerId, [...(byCustomer.get(i.customerId) ?? []), i]);
    }
    for (const rows of byCustomer.values()) {
      for (const item of invoiceItems(rows, now, NO_CONTRACT)) {
        if (item.kind !== 'INVOICE_OVERDUE') continue;
        items.push(wrap(item, 'STAFF', '/desk/billing', { ref: null, titleFa: '', titleEn: '', customerName: rows[0].customerName }));
      }
    }
  }

  return items.sort(
    (a, b) =>
      // Mine first, then the ones waiting on Root (only a customer has both).
      Number(a.waitingOn === 'ROOT') - Number(b.waitingOn === 'ROOT') ||
      a.since.getTime() - b.since.getTime() ||
      KIND_ORDER(a.kind) - KIND_ORDER(b.kind) ||
      a.variant.localeCompare(b.variant) ||
      (a.contractId ?? '').localeCompare(b.contractId ?? '') ||
      (a.phaseId ?? '').localeCompare(b.phaseId ?? '') ||
      a.route.localeCompare(b.route),
  );
}

// --- the desk's Needs-Root queue (V4, re-pointed) ----------------------------------------------

export type NeedsRootEntry = { contractId: string; since: Date; count: number };

/**
 * Contracts with something waiting on Root, longest-waiting first — V4's
 * Needs-Root queue, **re-pointed from `ContractStatus` to the attention
 * module** (the plan: the enum is hand-overridable and says one thing at a
 * time; attention says what is actually owed). Every Root-side item the viewer
 * may see counts — housekeeping included, since it is Root's — whatever job it
 * belongs to: the queue is the book's, not one person's work (`homeFor` is
 * that). A delivered or discarded contract owes nothing.
 */
export function needsRoot(viewer: Viewer, contracts: readonly HomeContract[]): NeedsRootEntry[] {
  const out: NeedsRootEntry[] = [];
  for (const c of contracts) {
    if (c.status === 'DISCARDED' || c.deliveredAt !== null) continue;
    const owed = attentionFor(c.input, viewer).filter((i) => i.waitingOn === 'ROOT');
    if (owed.length === 0) continue;
    out.push({ contractId: c.id, since: owed.reduce((a, i) => (i.since < a ? i.since : a), owed[0].since), count: owed.length });
  }
  return out.sort((a, b) => a.since.getTime() - b.since.getTime() || a.contractId.localeCompare(b.contractId));
}
