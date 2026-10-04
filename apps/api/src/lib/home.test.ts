import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '@prisma/client';
import type { AttentionInput } from './attention.js';
import { homeFor, mayWork, needsRoot, routeFor, type HomeContract, type HomeInput } from './home.js';

/**
 * Journeys build plan J12 — the home screens as tables. The attention module's
 * own rules are `attention.test.ts`; what is tested here is what a list across
 * contracts adds: whose items are whose, where each opens, and the turn of a
 * conversation.
 */

const NOW = new Date('2026-10-04T12:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

const viewer = (id: string, ...roles: Role[]) => ({ id, roles });
const CUSTOMER = viewer('cust', 'CUSTOMER');
const SALES = viewer('sales', 'SALES');
const DESIGNER = viewer('designer', 'DESIGNER');
const OTHER_DESIGNER = viewer('designer2', 'DESIGNER');
const DEVELOPER = viewer('developer', 'DEVELOPER');
const ADMIN = viewer('admin', 'ADMIN');
const CONTRIBUTOR = viewer('contrib', 'CONTRIBUTOR');
const BOTH = viewer('both', 'CUSTOMER', 'SALES');

const empty = (contractId: string, over: Partial<AttentionInput> = {}): AttentionInput => ({
  contractId,
  customerId: 'cust',
  now: NOW,
  pending: null,
  dependencies: [],
  feedback: { unresolved: [], pendingApproval: [], answered: [] },
  invoices: [],
  ...over,
});

const fact = (step: 'DESIGN' | 'MOCKUP' | 'DEMO' | 'SCOPE', phaseId: string | null, since: Date, money = false) => ({ step, phaseId, money, since });

function contract(id: string, over: Partial<HomeContract> = {}, input: Partial<AttentionInput> = {}): HomeContract {
  return {
    id,
    ref: `RC-${id}`,
    titleFa: `قرارداد ${id}`,
    titleEn: `Contract ${id}`,
    customerId: 'cust',
    customerName: 'Test Studio',
    sequence: 'AGREEMENT_FIRST',
    status: 'WAITING_ON_ROOT',
    publishedAt: day(-30),
    deliveredAt: null,
    designerId: 'designer',
    developerId: 'developer',
    project: { status: 'ACTIVE' },
    input: empty(id, input),
    ...over,
  };
}

const home = (over: Partial<HomeInput> & Pick<HomeInput, 'viewer'>): ReturnType<typeof homeFor> =>
  homeFor({ now: NOW, contracts: [], requests: [], tickets: [], accountInvoices: [], ...over });

const kinds = (items: ReturnType<typeof homeFor>) => items.map((i) => `${i.kind}/${i.variant}${i.contractId ? `@${i.contractId}` : ''}`);

/** One contract with something for every job: a design note, a demo note, a
 *  scope proposal and an overdue invoice. */
const busy = (id: string, over: Partial<HomeContract> = {}) =>
  contract(id, over, {
    feedback: {
      unresolved: [fact('DESIGN', null, day(-5)), fact('DEMO', 'p1', day(-4))],
      pendingApproval: [fact('DESIGN', null, day(-3))],
      answered: [fact('DESIGN', null, day(-2))],
    },
    scope: { undecidedProposals: [{ since: day(-6) }], openTrades: [] },
    invoices: [{ id: 'i1', invoiceNumber: 'INV-000001', issuedAt: day(-40), dueAt: day(-10), paidAt: null }],
  });

// ---- the customer ----------------------------------------------------------------------------

test('a customer’s home is everything on the contracts they own, theirs to do first, then what waits on Root; never a stranger’s', () => {
  const items = home({ viewer: CUSTOMER, contracts: [busy('c1'), busy('c2', { customerId: 'other' })] });
  assert.ok(items.every((i) => i.audience === 'CUSTOMER' && i.contractId === 'c1'));
  // Waiting on the customer: the answered notes (since -2) and the overdue invoice (since -10);
  // then Root's: the unresolved notes and the proposal. The pending approval is Root's
  // housekeeping and the customer never sees it.
  assert.deepEqual(kinds(items), [
    'INVOICE_OVERDUE/default@c1',
    'ANSWER_PUBLISHED/default@c1',
    'PROPOSAL_TO_DECIDE/default@c1',
    'FEEDBACK_UNRESOLVED/default@c1',
    'FEEDBACK_UNRESOLVED/default@c1',
  ]);
  assert.deepEqual(items.map((i) => i.waitingOn), ['CUSTOMER', 'CUSTOMER', 'ROOT', 'ROOT', 'ROOT']);
  assert.equal(items[0].subject.ref, 'RC-c1');
  assert.equal(items[0].subject.customerName, 'Test Studio');
});

test('an unpublished or discarded contract is not on the customer’s home', () => {
  const items = home({
    viewer: CUSTOMER,
    contracts: [busy('draft', { publishedAt: null }), busy('gone', { status: 'DISCARDED' }), busy('live')],
  });
  assert.deepEqual([...new Set(items.map((i) => i.contractId))], ['live']);
});

test('where a customer’s item opens: the wizard on its step, an invoice on its page, a contract on the contract', () => {
  const c = contract('c1', {}, {
    pending: { contract: { fromVersion: 1, toVersion: 2, since: day(-1) }, designChangeCount: 0, designSince: null, amendment: null },
    feedback: { unresolved: [], pendingApproval: [], answered: [fact('DEMO', 'p1', day(-2))] },
    steps: { waiting: [], mockupOut: { count: 1, since: day(-1) }, demosOut: [{ phaseId: 'p1', phaseNumber: 1, since: day(-1) }], demosNotReady: [] },
    invoices: [
      { id: 'inv-due', invoiceNumber: 'INV-000002', issuedAt: day(-2), dueAt: day(5), paidAt: null },
      { id: 'inv-late', invoiceNumber: 'INV-000001', issuedAt: day(-30), dueAt: day(-3), paidAt: null },
    ],
    dependencies: [{ id: 'd1', side: 'CUSTOMER', titleFa: 'ا', titleEn: 'a', dueAt: day(-2), verifiedAt: null }],
  });
  const routes = Object.fromEntries(home({ viewer: CUSTOMER, contracts: [c] }).map((i) => [`${i.kind}${i.phaseId ? `:${i.phaseId}` : ''}`, i.route]));
  assert.deepEqual(routes, {
    DRAFT_TO_REVIEW: '/app/contracts/c1?step=AGREEMENT',
    'ANSWER_PUBLISHED:p1': '/app/contracts/c1?step=DEMO&phase=p1',
    ITERATION_PUBLISHED: '/app/contracts/c1?step=MOCKUP',
    'DEMO_READY_TO_APPROVE:p1': '/app/contracts/c1?step=DEMO&phase=p1',
    INVOICE_DUE: '/app/invoices/inv-due',
    INVOICE_OVERDUE: '/app/invoices',
    COMMITMENT_OVERDUE: '/app/contracts/c1',
  });
});

test('a request is the customer’s move once Root has written last, Root’s until then; a ticket the same way (the turn is whoever wrote last)', () => {
  const request = (over: Partial<HomeInput['requests'][number]> = {}) => ({
    id: 'r1',
    title: 'A shop',
    customerId: 'cust',
    customerName: 'Test Studio',
    requestedAt: day(-5),
    lastMessage: null,
    ...over,
  });
  const ticket = (over: Partial<HomeInput['tickets'][number]> = {}) => ({
    id: 't1',
    subject: 'Logo is blurry',
    customerId: 'cust',
    customerName: 'Test Studio',
    createdAt: day(-4),
    lastMessage: null,
    ...over,
  });
  const at = (over: Partial<HomeInput>) => home({ viewer: CUSTOMER, ...over }).map((i) => [i.kind, i.variant, i.waitingOn, i.since.getTime() === day(-1).getTime()]);

  assert.deepEqual(at({ requests: [request()] }), [['REQUEST_MESSAGE', 'sent', 'ROOT', false]]);
  assert.deepEqual(at({ requests: [request({ lastMessage: { authorId: 'cust', at: day(-3) } })] }), [['REQUEST_MESSAGE', 'sent', 'ROOT', false]]);
  assert.deepEqual(at({ requests: [request({ lastMessage: { authorId: 'sales', at: day(-1) } })] }), [['REQUEST_MESSAGE', 'reply', 'CUSTOMER', true]]);
  assert.deepEqual(at({ tickets: [ticket()] }), [['TICKET_REPLY', 'open', 'ROOT', false]]);
  assert.deepEqual(at({ tickets: [ticket({ lastMessage: { authorId: 'admin', at: day(-1) } })] }), [['TICKET_REPLY', 'reply', 'CUSTOMER', true]]);
  // Somebody else's are not mine.
  assert.deepEqual(at({ requests: [request({ customerId: 'other' })], tickets: [ticket({ customerId: 'other' })] }), []);
  const routes = home({ viewer: CUSTOMER, requests: [request()], tickets: [ticket()] }).map((i) => i.route).sort();
  assert.deepEqual(routes, ['/app/contracts?request=r1', '/app/support']);
});

test('invoices that belong to no contract are on the customer’s home like a contract’s (a subscription period)', () => {
  const rows = [
    { id: 's1', invoiceNumber: 'INV-000009', issuedAt: day(-30), dueAt: day(-5), paidAt: null, customerId: 'cust', customerName: 'Test Studio' },
    { id: 's2', invoiceNumber: 'INV-000010', issuedAt: day(-2), dueAt: day(5), paidAt: null, customerId: 'cust', customerName: 'Test Studio' },
    { id: 's3', invoiceNumber: 'INV-000011', issuedAt: day(-30), dueAt: day(-5), paidAt: null, customerId: 'other', customerName: 'Someone' },
  ];
  const items = home({ viewer: CUSTOMER, accountInvoices: rows });
  assert.deepEqual(items.map((i) => [i.kind, i.contractId, i.route]), [
    ['INVOICE_OVERDUE', null, '/app/invoices'],
    ['INVOICE_DUE', null, '/app/invoices/s2'],
  ]);
});

// ---- staff: whose job is it -------------------------------------------------------------------

test('sales’ home: pending answers, proposals, notes on their steps and overdue invoices, on every contract — not the design’s or the demo’s notes', () => {
  const items = home({ viewer: SALES, contracts: [busy('c1'), busy('c2')] });
  assert.ok(items.every((i) => i.audience === 'STAFF' && i.role === 'SALES'));
  assert.deepEqual(
    [...new Set(kinds(items))].sort(),
    ['ANSWER_PENDING_APPROVAL/default@c1', 'ANSWER_PENDING_APPROVAL/default@c2', 'INVOICE_OVERDUE/default@c1', 'INVOICE_OVERDUE/default@c2', 'PROPOSAL_TO_DECIDE/default@c1', 'PROPOSAL_TO_DECIDE/default@c2'],
  );
});

test('a designer sees design work on the contracts they are the designer of, and not another’s', () => {
  const mine = busy('mine', { designerId: 'designer' });
  const theirs = busy('theirs', { designerId: 'designer2' });
  const items = home({ viewer: DESIGNER, contracts: [mine, theirs] });
  assert.deepEqual(kinds(items), ['FEEDBACK_UNRESOLVED/default@mine']);
  assert.equal(items[0].params.step, 'DESIGN');
  assert.deepEqual(kinds(home({ viewer: OTHER_DESIGNER, contracts: [mine, theirs] })), ['FEEDBACK_UNRESOLVED/default@theirs']);
});

test('a developer sees demo work, readiness and technical commitments on the contracts they develop', () => {
  const c = contract('c1', {}, {
    feedback: { unresolved: [fact('DEMO', 'p1', day(-4)), fact('DESIGN', null, day(-3))], pendingApproval: [], answered: [] },
    steps: {
      waiting: [{ step: 'DEMO', phaseId: 'p2', phaseNumber: 2, since: day(-2) }],
      mockupOut: null,
      demosOut: [],
      demosNotReady: [{ phaseId: 'p1', phaseNumber: 1, since: day(-1) }],
    },
    dependencies: [
      { id: 'dns', side: 'CUSTOMER', titleFa: 'ا', titleEn: 'DNS', dueAt: day(-2), verifiedAt: null, technical: true },
      { id: 'logo', side: 'CUSTOMER', titleFa: 'ا', titleEn: 'Logo', dueAt: day(-2), verifiedAt: null },
    ],
  });
  const items = home({ viewer: DEVELOPER, contracts: [c, { ...c, id: 'other', designerId: null, developerId: 'someone-else', input: { ...c.input, contractId: 'other' } }] });
  assert.deepEqual(
    items.map((i) => `${i.kind}/${i.variant}@${i.contractId}`),
    // What waits on Root first (the developer's own move); the customer's late DNS access is the follow-up.
    ['FEEDBACK_UNRESOLVED/default@c1', 'STEP_WAITING/DEMO@c1', 'DEMO_NOT_READY/default@c1', 'COMMITMENT_OVERDUE/customer@c1'],
  );
  assert.equal(items[3].params.dependencyId, 'dns');
  const routes = Object.fromEntries(items.map((i) => [i.kind, i.route]));
  assert.equal(routes.DEMO_NOT_READY, '/desk/contracts/c1/phases');
  assert.equal(routes.COMMITMENT_OVERDUE, '/desk/contracts/c1/dependencies');
  assert.equal(routes.FEEDBACK_UNRESOLVED, '/desk/contracts/c1/steps?step=DEMO&phase=p1');
});

test('ADMIN holds every job and every contract through assignments.override: their home is everyone’s', () => {
  const items = home({ viewer: ADMIN, contracts: [busy('c1', { designerId: null, developerId: null })] });
  assert.deepEqual(
    [...new Set(items.map((i) => i.role))].sort(),
    ['DESIGNER', 'DEVELOPER', 'SALES'],
  );
});

test('a closed contract (J11) leaves the designer’s and the developer’s homes, and stays on sales’', () => {
  const closed = busy('closed', { deliveredAt: day(-1) });
  assert.deepEqual(home({ viewer: DESIGNER, contracts: [closed] }), []);
  assert.deepEqual(home({ viewer: DEVELOPER, contracts: [closed] }), []);
  assert.ok(home({ viewer: SALES, contracts: [closed] }).length > 0);
});

test('an inactive project or a discarded contract is no one’s work but the book’s', () => {
  const asleep = busy('asleep', { project: { status: 'ARCHIVED' } });
  assert.deepEqual(home({ viewer: DESIGNER, contracts: [asleep] }), []);
  assert.deepEqual(home({ viewer: SALES, contracts: [busy('gone', { status: 'DISCARDED' })] }), []);
});

test('a contributor holds no contract work: an empty home, however many contracts there are', () => {
  assert.deepEqual(home({ viewer: CONTRIBUTOR, contracts: [busy('c1')], requests: [], tickets: [] }), []);
});

test('money is not a designer’s: the overdue invoice and the issuable plan row are sales’ alone', () => {
  const c = contract('c1', {}, {
    invoices: [{ id: 'i1', invoiceNumber: 'INV-000001', issuedAt: day(-40), dueAt: day(-10), paidAt: null }],
    issuable: [{ ordinal: 2, since: day(-1) }],
  });
  assert.deepEqual(kinds(home({ viewer: SALES, contracts: [c] })).sort(), ['INVOICE_ISSUABLE/default@c1', 'INVOICE_OVERDUE/default@c1']);
  assert.deepEqual(home({ viewer: DESIGNER, contracts: [c] }), []);
  assert.deepEqual(home({ viewer: DEVELOPER, contracts: [c] }), []);
  const routes = home({ viewer: SALES, contracts: [c] }).map((i) => i.route);
  assert.deepEqual(routes, ['/desk/billing', '/desk/billing']);
});

test('sales’ requests and tickets: only the ones Root owes a reply, and tickets need tickets.answer', () => {
  const requests = [
    { id: 'r-new', title: 'New', customerId: 'cust', customerName: 'A', requestedAt: day(-3), lastMessage: null },
    { id: 'r-replied', title: 'Replied', customerId: 'cust', customerName: 'A', requestedAt: day(-6), lastMessage: { authorId: 'sales', at: day(-2) } },
    { id: 'r-asked', title: 'Asked', customerId: 'cust', customerName: 'A', requestedAt: day(-9), lastMessage: { authorId: 'cust', at: day(-1) } },
  ];
  const tickets = [
    { id: 't-new', subject: 'Bug', customerId: 'cust', customerName: 'A', createdAt: day(-2), lastMessage: { authorId: 'cust', at: day(-2) } },
    { id: 't-answered', subject: 'Done', customerId: 'cust', customerName: 'A', createdAt: day(-5), lastMessage: { authorId: 'sales', at: day(-4) } },
  ];
  const items = home({ viewer: SALES, requests, tickets });
  // Longest-waiting first: a request waits from its last message, or from its own text.
  assert.deepEqual(items.map((i) => [i.kind, i.route]), [
    ['REQUEST_MESSAGE', '/desk/requests/r-new'],
    ['TICKET_REPLY', '/desk/tickets'],
    ['REQUEST_MESSAGE', '/desk/requests/r-asked'],
  ]);
  // A designer sees neither (no requests for design and development — `requestVisibleTo`).
  assert.deepEqual(home({ viewer: DESIGNER, requests, tickets }), []);
});

test('contract-less overdue invoices are sales’ too: one line per customer', () => {
  const rows = [
    { id: 'a', invoiceNumber: 'INV-1', issuedAt: day(-30), dueAt: day(-5), paidAt: null, customerId: 'cust', customerName: 'A' },
    { id: 'b', invoiceNumber: 'INV-2', issuedAt: day(-30), dueAt: day(-6), paidAt: null, customerId: 'cust', customerName: 'A' },
    { id: 'c', invoiceNumber: 'INV-3', issuedAt: day(-30), dueAt: day(-1), paidAt: null, customerId: 'other', customerName: 'B' },
  ];
  const items = home({ viewer: SALES, accountInvoices: rows });
  assert.deepEqual(items.map((i) => [i.kind, i.params.count, i.subject.customerName, i.route]), [
    ['INVOICE_OVERDUE', 2, 'A', '/desk/billing'],
    ['INVOICE_OVERDUE', 1, 'B', '/desk/billing'],
  ]);
  assert.deepEqual(home({ viewer: DESIGNER, accountInvoices: rows }), []);
});

test('a person who is both a customer and sales sees their own contract as a customer, once, and the rest as staff', () => {
  const own = busy('own', { customerId: 'both' });
  own.input = { ...own.input, customerId: 'both' };
  const items = home({ viewer: BOTH, contracts: [own, busy('book')] });
  assert.ok(items.filter((i) => i.contractId === 'own').every((i) => i.audience === 'CUSTOMER'));
  assert.ok(items.filter((i) => i.contractId === 'book').every((i) => i.audience === 'STAFF'));
});

test('longest-waiting first, and a total order: equal times fall back to the kind, then the contract', () => {
  const same = { feedback: { unresolved: [fact('DESIGN', null, day(-3))], pendingApproval: [], answered: [] } };
  const items = home({ viewer: ADMIN, contracts: [contract('b', {}, same), contract('a', {}, same), contract('old', {}, { feedback: { unresolved: [fact('DESIGN', null, day(-9))], pendingApproval: [], answered: [] } })] });
  assert.deepEqual(items.map((i) => i.contractId), ['old', 'a', 'b']);
});

// ---- the queue --------------------------------------------------------------------------------

test('needsRoot: by what Root owes, oldest first — not by ContractStatus (the enum can say anything)', () => {
  const waitingByStatusOnly = contract('status-only', { status: 'WAITING_ON_ROOT' });
  const owingByAttention = contract('owing', { status: 'WAITING_ON_CUSTOMER' }, {
    feedback: { unresolved: [fact('DESIGN', null, day(-5)), fact('DEMO', 'p1', day(-2))], pendingApproval: [fact('DESIGN', null, day(-9))], answered: [] },
  });
  const olderOwing = contract('older', { status: 'DONE' }, { scope: { undecidedProposals: [{ since: day(-12) }], openTrades: [] } });
  const delivered = contract('delivered', { deliveredAt: day(-1) }, { scope: { undecidedProposals: [{ since: day(-20) }], openTrades: [] } });
  const waitingOnCustomer = contract('theirs', {}, { feedback: { unresolved: [], pendingApproval: [], answered: [fact('DESIGN', null, day(-30))] } });

  const queue = needsRoot(SALES, [waitingByStatusOnly, owingByAttention, olderOwing, delivered, waitingOnCustomer]);
  assert.deepEqual(
    queue.map((e) => [e.contractId, e.count, e.since.getTime()]),
    [
      ['older', 1, day(-12).getTime()],
      ['owing', 3, day(-9).getTime()],
    ],
  );
});

// ---- the rules, one by one ---------------------------------------------------------------------

test('mayWork: a job needs its capability, and design and development need the assignment as well (two mechanisms, checked separately)', () => {
  const c = { designerId: 'designer', developerId: 'developer' };
  const table: Array<{ who: string; v: ReturnType<typeof viewer>; kind: Parameters<typeof mayWork>[2]; sees: boolean }> = [
    { who: 'sales, a sales item', v: SALES, kind: { kind: 'PROPOSAL_TO_DECIDE', role: 'SALES' }, sees: true },
    { who: 'sales, approvals', v: SALES, kind: { kind: 'ANSWER_PENDING_APPROVAL', role: 'SALES' }, sees: true },
    { who: 'designer, a sales item', v: DESIGNER, kind: { kind: 'PROPOSAL_TO_DECIDE', role: 'SALES' }, sees: false },
    { who: 'designer, approvals (feedback.approveAnswers is sales’)', v: DESIGNER, kind: { kind: 'ANSWER_PENDING_APPROVAL', role: 'SALES' }, sees: false },
    { who: 'the assigned designer', v: DESIGNER, kind: { kind: 'FEEDBACK_UNRESOLVED', role: 'DESIGNER' }, sees: true },
    { who: 'another designer', v: OTHER_DESIGNER, kind: { kind: 'FEEDBACK_UNRESOLVED', role: 'DESIGNER' }, sees: false },
    { who: 'sales, a design item', v: SALES, kind: { kind: 'FEEDBACK_UNRESOLVED', role: 'DESIGNER' }, sees: false },
    { who: 'the assigned developer', v: DEVELOPER, kind: { kind: 'DEMO_NOT_READY', role: 'DEVELOPER' }, sees: true },
    { who: 'the designer, a developer item', v: DESIGNER, kind: { kind: 'DEMO_NOT_READY', role: 'DEVELOPER' }, sees: false },
    { who: 'ADMIN, any job', v: ADMIN, kind: { kind: 'STEP_WAITING', role: 'DESIGNER' }, sees: true },
    { who: 'nobody’s item', v: ADMIN, kind: { kind: 'COMMITMENT_OVERDUE', role: null }, sees: false },
  ];
  for (const row of table) assert.equal(mayWork(row.v, c, row.kind), row.sees, row.who);
});

test('routeFor: the desk’s Steps tab on the new road, the contract itself on the legacy one, and the surface that acts for the rest', () => {
  const item = (kind: Parameters<typeof routeFor>[1]['kind'], params: Record<string, string | number> = {}, phaseId: string | null = null) => ({ kind, phaseId, params });
  const modern = { id: 'c1', sequence: 'AGREEMENT_FIRST' as const };
  const legacy = { id: 'c2', sequence: 'DESIGN_FIRST' as const };
  assert.equal(routeFor('STAFF', item('FEEDBACK_UNRESOLVED', { step: 'MOCKUP' }), modern), '/desk/contracts/c1/steps?step=MOCKUP');
  assert.equal(routeFor('STAFF', item('FEEDBACK_UNRESOLVED', { step: 'DESIGN' }), legacy), '/desk/contracts/c2');
  assert.equal(routeFor('STAFF', item('ANSWER_PENDING_APPROVAL', { step: 'DESIGN' }), modern), '/desk/approvals');
  assert.equal(routeFor('STAFF', item('INVOICE_ISSUABLE'), modern), '/desk/billing');
  assert.equal(routeFor('STAFF', item('PROPOSAL_TO_DECIDE'), modern), '/desk/contracts/c1/steps?step=SCOPE');
  assert.equal(routeFor('STAFF', item('TRADE_TO_CONFIRM'), modern), '/desk/contracts/c1/scope');
  assert.equal(routeFor('CUSTOMER', item('FEEDBACK_UNRESOLVED', { step: 'DEMO' }, 'p9'), modern), '/app/contracts/c1?step=DEMO&phase=p9');
});
