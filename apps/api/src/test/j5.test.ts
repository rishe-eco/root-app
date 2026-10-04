import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { ARTICLES } from '../lib/templates.js';

/**
 * J5 — step 2a, pages, features and deliverables (journeys build plan §5 "J5").
 *
 * In this order: **the two CHECKs by direct insert**; a customer's three
 * proposals and every refusal in front of them (the customer's edge, the road,
 * the lock, the item's state); sales' decisions — an ADD becomes a bilingual
 * item with a Latin `custom.<n>` key, a REMOVE declines the item with the
 * proposal's own text, a RESTORE agrees it, a decline needs and shows its
 * reason; seeding a contract's scope from its template (`SCOPE_ALREADY_SEEDED`,
 * and what a *second* contract on the same project gets); **D-5** — the
 * template's placeholders rendered, none left; **the trade's customer half** —
 * it executes only after both sides, and only the contract's customer may
 * confirm; the tick refused on the new road and untouched on the legacy one
 * (`checkedAt` never written); the wizard's SCOPE signal and the attention
 * items; and the notifications, who gets them and who does not.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}@test.local`,
        phone: role === 'SALES' ? '+989120000102' : null,
        name: role,
        roles: [role],
        state: 'ACTIVE',
      },
    });
  }
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  for (const [i, [key, kind, fa, en]] of (
    [
      ['home', 'PAGE', 'صفحه‌ی اصلی', 'Home page'],
      ['about', 'PAGE', 'درباره‌ی ما', 'About us'],
      ['checkout', 'FEATURE', 'پرداخت', 'Checkout'],
      ['handover-guide', 'DELIVERABLE', 'راهنمای تحویل', 'Handover guide'],
    ] as const
  ).entries()) {
    await prisma.templateScopeItem.create({ data: { typeId: type.id, key, kind, labelFa: fa, labelEn: en, position: i } });
  }
  await prisma.contractBrief.create({
    data: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK' },
  });
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to) => void sms.push({ to }),
    sendText: async (to, text) => void sms.push({ to, text }),
  });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// ---- documents ------------------------------------------------------------------

const CONTRACT = `
  id
  sequence
  scopeItems { id key kind status contractId labelFa labelEn position checked declinedReason originNote }
  scopeProposals {
    id kind requestedKind text lang createdAt decidedAt decision declineReason
    scopeItem { id key }
    createdItem { id key kind status contractId labelFa labelEn }
    proposedBy { id }
  }
  wizard { step status locked }
  attention { kind variant waitingOn role }
  project { scopeTrades { id rootConfirmedAt customerConfirmedAt executedAt outItem { id key status } inItem { id key status contractId } } }
`;
const SEED = `mutation($c: ID!){ applyScopeTemplate(contractId: $c) { ${CONTRACT} } }`;
const ADD = `mutation($c: ID!, $k: ScopeKind!, $t: String!, $l: String!){ proposeScopeAddition(contractId: $c, kind: $k, text: $t, lang: $l) { ${CONTRACT} } }`;
const REMOVE = `mutation($i: ID!, $t: String!){ proposeScopeRemoval(scopeItemId: $i, text: $t) { ${CONTRACT} } }`;
const RESTORE = `mutation($i: ID!, $t: String!){ proposeRestore(scopeItemId: $i, text: $t) { ${CONTRACT} } }`;
const DECIDE = `mutation($id: ID!, $d: ScopeProposalDecision!, $fa: String, $en: String, $key: String, $kind: ScopeKind, $r: String){
  decideScopeProposal(id: $id, decision: $d, labelFa: $fa, labelEn: $en, key: $key, kind: $kind, declineReason: $r) { ${CONTRACT} } }`;
const READ = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { ${CONTRACT} } }`;
const TEMPLATE = `mutation($c: ID!){ applyContractTemplate(contractId: $c) { id draft { articles { number bodyFa bodyEn } } scopeItems { key contractId kind } } }`;

type Item = {
  id: string;
  key: string;
  kind: string;
  status: string;
  contractId: string | null;
  labelFa: string;
  labelEn: string;
  position: number;
  checked: boolean;
  declinedReason: string | null;
  originNote: string | null;
};
type Proposal = {
  id: string;
  kind: string;
  requestedKind: string | null;
  text: string;
  lang: string;
  decidedAt: string | null;
  decision: string | null;
  declineReason: string | null;
  scopeItem: { id: string; key: string } | null;
  createdItem: { id: string; key: string; kind: string; status: string; contractId: string | null; labelFa: string; labelEn: string } | null;
  proposedBy: { id: string };
};
type Contract = {
  id: string;
  sequence: string;
  scopeItems: Item[];
  scopeProposals: Proposal[];
  wizard: Array<{ step: string; status: string; locked: boolean }>;
  attention: Array<{ kind: string; variant: string; waitingOn: string; role: string | null }>;
  project: {
    scopeTrades: Array<{
      id: string;
      rootConfirmedAt: string | null;
      customerConfirmedAt: string | null;
      executedAt: string | null;
      outItem: { id: string; key: string; status: string };
      inItem: { id: string; key: string; status: string; contractId: string | null };
    }>;
  };
};

const seed = async (as: User = staff.SALES, contractId = f.contract.id) =>
  ok(await exec(SEED, { as, variables: { c: contractId } })).applyScopeTemplate as Contract;
const add = async (text = 'یک صفحه‌ی وبلاگ', kind = 'PAGE', lang = 'fa', contractId = f.contract.id, as: User = f.customer) =>
  exec(ADD, { as, variables: { c: contractId, k: kind, t: text, l: lang } });
const addOk = async (...args: Parameters<typeof add>) => ok(await add(...args)).proposeScopeAddition as Contract;
const read = async (as: User, asCustomer = false, contractId = f.contract.id) =>
  ok(await exec(READ, { as, variables: { c: contractId, as: asCustomer } })).contract as Contract;
const decide = (id: string, over: Record<string, unknown> = {}, as: User = staff.SALES) =>
  exec(DECIDE, { as, variables: { id, d: 'ACCEPTED', fa: 'وبلاگ', en: 'Blog', ...over } });
const decideOk = async (...args: Parameters<typeof decide>) => ok(await decide(...args)).decideScopeProposal as Contract;
const itemByKey = (c: Contract, key: string) => c.scopeItems.find((i) => i.key === key)!;
const lock = () => prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });

// ---- the two CHECKs, by direct insert ---------------------------------------------

test('CHECK ScopeProposal_declined_has_reason: a decline says why — whitespace is not a reason, and an undecided or accepted row needs none', async () => {
  const base = { contractId: f.contract.id, kind: 'ADD' as const, requestedKind: 'PAGE' as const, text: 'x', lang: 'fa', proposedById: f.customer.id };
  await assert.rejects(
    prisma.scopeProposal.create({ data: { ...base, decision: 'DECLINED', decidedAt: new Date(), decidedById: staff.SALES.id } }),
    /ScopeProposal_declined_has_reason/,
  );
  await assert.rejects(
    prisma.scopeProposal.create({ data: { ...base, decision: 'DECLINED', declineReason: '   ', decidedAt: new Date() } }),
    /ScopeProposal_declined_has_reason/,
  );
  await assert.rejects(
    prisma.scopeProposal.create({ data: { ...base, decision: 'DECLINED', declineReason: '\t\n\r\n', decidedAt: new Date() } }),
    /ScopeProposal_declined_has_reason/,
    'tabs and newlines are not a reason either (20261004100000 — btrim strips spaces only)',
  );
  await prisma.scopeProposal.create({ data: { ...base, decision: 'DECLINED', declineReason: 'خارج از دامنه', decidedAt: new Date() } });
  await prisma.scopeProposal.create({ data: { ...base, decision: 'ACCEPTED', decidedAt: new Date() } });
  await prisma.scopeProposal.create({ data: base });
});

test('CHECK ScopeProposal_target_required: only an ADD names no item — a REMOVE or RESTORE without one is refused', async () => {
  const base = { contractId: f.contract.id, text: 'x', lang: 'fa', proposedById: f.customer.id };
  await prisma.scopeProposal.create({ data: { ...base, kind: 'ADD', requestedKind: 'FEATURE' } });
  for (const kind of ['REMOVE', 'RESTORE'] as const) {
    await assert.rejects(prisma.scopeProposal.create({ data: { ...base, kind } }), /ScopeProposal_target_required/, kind);
  }
  const item = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'thing', labelFa: 'ت', labelEn: 'Thing', kind: 'PAGE', status: 'AGREED', contractId: f.contract.id },
  });
  await prisma.scopeProposal.create({ data: { ...base, kind: 'REMOVE', scopeItemId: item.id } });
  // Deleting an item takes the proposals about it with it — the CHECK forbids the alternative.
  await prisma.scopeItem.delete({ where: { id: item.id } });
  assert.equal(await prisma.scopeProposal.count({ where: { kind: 'REMOVE' } }), 0);
});

// ---- seeding ----------------------------------------------------------------------

test('applyScopeTemplate seeds this contract’s scope from the brief’s type: agreed, of the right kinds, its own — and only once', async () => {
  const c = await seed();
  const own = c.scopeItems.filter((i) => i.kind !== 'EXTRA');
  assert.deepEqual(
    own.map((i) => [i.key, i.kind, i.status, i.contractId === f.contract.id]),
    [
      ['home', 'PAGE', 'AGREED', true],
      ['about', 'PAGE', 'AGREED', true],
      ['checkout', 'FEATURE', 'AGREED', true],
      ['handover-guide', 'DELIVERABLE', 'AGREED', true],
    ],
  );
  assert.deepEqual(own.map((i) => i.labelEn), ['Home page', 'About us', 'Checkout', 'Handover guide']);
  assert.ok(own.every((i) => !i.checked), 'checkedAt is never written on the new road');

  const again = await exec(SEED, { as: staff.SALES, variables: { c: f.contract.id } });
  assert.equal(again.code, 'SCOPE_ALREADY_SEEDED');
  assert.equal((await prisma.scopeItem.count({ where: { projectId: f.contract.projectId } })), 4);
});

test('applyScopeTemplate: contracts.author only, a brief and a type with something in it, on the new road', async () => {
  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    assert.equal((await exec(SEED, { as: who, variables: { c: f.contract.id } })).code, 'FORBIDDEN', who.email!);
  }
  await prisma.contractBrief.delete({ where: { contractId: f.contract.id } });
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: f.contract.id } })).code, 'BRIEF_MISSING');
  const empty = await prisma.templateType.create({ data: { slug: 'blank', labelFa: 'خالی', labelEn: 'Blank' } });
  await prisma.contractBrief.create({ data: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: empty.id, designTier: 'THEME_PICK' } });
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: f.contract.id } })).code, 'TEMPLATE_SCOPE_EMPTY');
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: 'nope' } })).code, 'NOT_FOUND');

  const legacy = await legacyContract();
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: legacy.id } })).code, 'STEP_NOT_ON_ROAD');
});

/** A legacy contract on its own project, with a scope item of its own and the customer's tick on it. */
async function legacyContract() {
  const project = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'قدیمی', titleEn: 'Legacy' } });
  const contract = await prisma.contract.create({
    data: {
      ref: 'RC-LEGACY-1',
      titleFa: 'قدیمی',
      titleEn: 'Legacy',
      customerId: f.customer.id,
      projectId: project.id,
      publishedAt: new Date(),
      status: 'WAITING_ON_CUSTOMER',
      sequence: 'DESIGN_FIRST',
    },
  });
  const item = await prisma.scopeItem.create({
    data: { projectId: project.id, key: 'landing', labelFa: 'ل', labelEn: 'Landing', kind: 'PAGE', status: 'AGREED', contractId: contract.id },
  });
  return { id: contract.id, itemId: item.id, projectId: project.id };
}

test('a second contract on the same project is seeded on its own — a taken key takes the next suffix, and the first contract’s rows are untouched (J2’s owed item, for the scope half)', async () => {
  await seed();
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId: f.contract.projectId,
      publishedAt: new Date(),
      status: 'WAITING_ON_CUSTOMER',
    },
  });
  await prisma.contractBrief.create({ data: { contractId: second.id, kind: 'FEATURE_FOR_EXISTING', templateTypeId: type.id, designTier: 'THEME_PICK' } });
  const before = await prisma.scopeItem.findMany({ where: { contractId: f.contract.id }, orderBy: { key: 'asc' } });

  const c = await seed(staff.SALES, second.id);
  const own = c.scopeItems.filter((i) => i.contractId === second.id);
  assert.deepEqual(own.map((i) => i.key), ['home.2', 'about.2', 'checkout.2', 'handover-guide.2']);
  // The kind is the template's, not read off the suffixed key.
  assert.deepEqual(own.map((i) => i.kind), ['PAGE', 'PAGE', 'FEATURE', 'DELIVERABLE']);
  assert.deepEqual(await prisma.scopeItem.findMany({ where: { contractId: f.contract.id }, orderBy: { key: 'asc' } }), before);
  // ...and it is seeded once too.
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: second.id } })).code, 'SCOPE_ALREADY_SEEDED');
});

// ---- proposing --------------------------------------------------------------------

test('a customer proposes an addition in their own words: nothing enters the registry, sales are told, and the step is not confirmed', async () => {
  await seed();
  const c = await addOk('  یک صفحه‌ی وبلاگ  ');
  assert.equal(c.scopeItems.filter((i) => i.kind !== 'EXTRA').length, 4, 'no registry row yet');
  assert.equal(c.scopeProposals.length, 1);
  const [p] = c.scopeProposals;
  assert.deepEqual([p.kind, p.requestedKind, p.text, p.lang, p.decision, p.decidedAt, p.scopeItem], ['ADD', 'PAGE', 'یک صفحه‌ی وبلاگ', 'fa', null, null, null]);
  assert.equal(p.proposedBy.id, f.customer.id);
  assert.deepEqual(c.wizard.find((w) => w.step === 'SCOPE'), { step: 'SCOPE', status: 'UPCOMING', locked: false });
});

test('proposeScopeAddition refuses: another customer’s contract, staff, a bad kind, language or text — and, on a legacy contract, the road', async () => {
  await seed();
  assert.equal((await add(undefined, 'PAGE', 'fa', f.contract.id, f.stranger)).code, 'NOT_FOUND');
  assert.equal((await add(undefined, 'PAGE', 'fa', f.contract.id, staff.SALES)).code, 'NOT_FOUND', 'Root decides proposals, it does not raise them');
  assert.equal((await add(undefined, 'PAGE', 'fa', f.contract.id, f.admin)).code, 'NOT_FOUND');
  assert.equal((await add(undefined, 'PAGE', 'fa', 'nope')).code, 'NOT_FOUND');
  assert.equal((await add('x', 'EXTRA')).code, 'INVALID_KIND', 'the checklist is step 1’s');
  assert.equal((await add('x', 'PAGE', 'de')).code, 'INVALID_LANG');
  assert.equal((await add('   ')).code, 'EMPTY_PROPOSAL');
  assert.equal((await add('x'.repeat(1001))).code, 'PROPOSAL_TOO_LONG');
  assert.equal(await prisma.scopeProposal.count(), 0, 'every refusal left nothing behind');

  const legacy = await legacyContract();
  assert.equal((await add('x', 'PAGE', 'en', legacy.id)).code, 'STEP_NOT_ON_ROAD');

  // An unpublished contract is not the customer's yet.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });
  assert.equal((await add()).code, 'NOT_FOUND');
});

test('removing and restoring: the customer names an item and says why; only an agreed item can go, only a declined one can come back, and never an extra', async () => {
  const c = await seed();
  const home = itemByKey(c, 'home');
  const removed = ok(await exec(REMOVE, { as: f.customer, variables: { i: home.id, t: 'we do not need a landing page' } })).proposeScopeRemoval as Contract;
  assert.deepEqual(
    removed.scopeProposals.map((p) => [p.kind, p.scopeItem?.key, p.text]),
    [['REMOVE', 'home', 'we do not need a landing page']],
  );
  // The proposal waits; the item is unchanged.
  assert.equal(itemByKey(removed, 'home').status, 'AGREED');
  // One at a time: a second ask about the same item while the first waits is refused.
  assert.equal((await exec(REMOVE, { as: f.customer, variables: { i: home.id, t: 'again' } })).code, 'PROPOSAL_PENDING');
  assert.equal((await exec(RESTORE, { as: f.customer, variables: { i: home.id, t: 'again' } })).code, 'ITEM_NOT_RESTORABLE');
  // Restoring what is not declined is not a thing.
  assert.equal(
    (await exec(RESTORE, { as: f.customer, variables: { i: itemByKey(c, 'about').id, t: 'x' } })).code,
    'ITEM_NOT_RESTORABLE',
  );
  // An extra is step 1's toggle, not a proposal.
  const extra = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'checklist.auth', labelFa: 'ا', labelEn: 'Auth', kind: 'EXTRA', status: 'DECLINED', contractId: f.contract.id },
  });
  assert.equal((await exec(RESTORE, { as: f.customer, variables: { i: extra.id, t: 'x' } })).code, 'NOT_PROPOSABLE');
  assert.equal((await exec(REMOVE, { as: f.customer, variables: { i: extra.id, t: 'x' } })).code, 'NOT_PROPOSABLE');
  // Not the customer's item: an item that no contract of theirs agreed.
  assert.equal((await exec(REMOVE, { as: f.stranger, variables: { i: home.id, t: 'x' } })).code, 'NOT_FOUND');
  assert.equal((await exec(REMOVE, { as: staff.SALES, variables: { i: home.id, t: 'x' } })).code, 'NOT_FOUND');
  assert.equal((await exec(REMOVE, { as: f.customer, variables: { i: 'nope', t: 'x' } })).code, 'NOT_FOUND');
  assert.equal((await exec(REMOVE, { as: f.customer, variables: { i: itemByKey(c, 'about').id, t: '  ' } })).code, 'EMPTY_PROPOSAL');
});

// ---- deciding ---------------------------------------------------------------------

test('ADD accepted: a bilingual item, agreed, of this contract, with a Latin custom.<n> key — never made from the Persian words', async () => {
  await seed();
  const c1 = await addOk('یک صفحه‌ی وبلاگ', 'PAGE');
  const done = await decideOk(c1.scopeProposals[0].id);
  const created = itemByKey(done, 'custom.1');
  assert.deepEqual(
    [created.kind, created.status, created.contractId, created.labelFa, created.labelEn],
    ['PAGE', 'AGREED', f.contract.id, 'وبلاگ', 'Blog'],
  );
  assert.equal(created.originNote, 'یک صفحه‌ی وبلاگ', 'the customer’s words are the item’s origin');
  const [p] = done.scopeProposals;
  assert.deepEqual([p.decision, p.createdItem?.key, p.declineReason], ['ACCEPTED', 'custom.1', null]);
  assert.ok(p.decidedAt);
  assert.equal(done.scopeItems.find((i) => i.key === 'custom.1')!.checked, false, 'checkedAt is never written');
  assert.equal(done.scopeItems.filter((i) => i.kind !== 'EXTRA').length, 5);

  // The next one is custom.2; a typed key and a corrected kind are honoured.
  const c2 = await addOk('a wishlist', 'FEATURE', 'en');
  const second = c2.scopeProposals.find((p) => !p.decidedAt)!;
  const d2 = await decideOk(second.id, { fa: 'فهرست علاقه‌مندی', en: 'Wishlist' });
  assert.deepEqual(d2.scopeItems.filter((i) => i.key.startsWith('custom.')).map((i) => [i.key, i.kind]), [['custom.1', 'PAGE'], ['custom.2', 'FEATURE']]);
  const c3 = await addOk('a thing', 'PAGE', 'en');
  const d3 = await decideOk(c3.scopeProposals.find((p) => !p.decidedAt)!.id, { key: 'the-thing', kind: 'DELIVERABLE' });
  const typed = itemByKey(d3, 'the-thing');
  assert.deepEqual([typed.kind, typed.status], ['DELIVERABLE', 'AGREED']);
});

test('ADD accepted refuses without both labels, on a malformed or taken key, and never twice', async () => {
  await seed();
  const c = await addOk();
  const id = c.scopeProposals[0].id;
  assert.equal((await decide(id, { en: '' })).code, 'LABEL_REQUIRED');
  assert.equal((await decide(id, { fa: '  ' })).code, 'LABEL_REQUIRED');
  assert.equal((await decide(id, { key: 'Bad Key' })).code, 'INVALID_KEY');
  assert.equal((await decide(id, { key: 'checklist.auth' })).code, 'INVALID_KEY');
  assert.equal((await decide(id, { key: 'home' })).code, 'KEY_TAKEN');
  assert.equal((await decide(id, { kind: 'EXTRA' })).code, 'INVALID_KIND');
  assert.equal(await prisma.scopeItem.count({ where: { projectId: f.contract.projectId, key: { startsWith: 'custom' } } }), 0, 'refusals wrote nothing');
  await decideOk(id);
  assert.equal((await decide(id)).code, 'ALREADY_DECIDED');
});

test('REMOVE accepted declines the item with the proposal’s text as its reason; RESTORE accepted agrees it again', async () => {
  const c = await seed();
  const about = itemByKey(c, 'about');
  const removed = ok(await exec(REMOVE, { as: f.customer, variables: { i: about.id, t: '  we have no team page  ' } })).proposeScopeRemoval as Contract;
  const removedDone = await decideOk(removed.scopeProposals[0].id, {});
  const declined = itemByKey(removedDone, 'about');
  assert.deepEqual([declined.status, declined.declinedReason], ['DECLINED', 'we have no team page']);
  assert.equal(removedDone.scopeProposals[0].decision, 'ACCEPTED');

  // ...and back: the customer changes their mind.
  const restore = ok(await exec(RESTORE, { as: f.customer, variables: { i: about.id, t: 'we do want it after all' } })).proposeRestore as Contract;
  const restored = await decideOk(restore.scopeProposals.find((p) => !p.decidedAt)!.id, {});
  const back = itemByKey(restored, 'about');
  assert.deepEqual([back.status, back.declinedReason], ['AGREED', null], 'a stale reason is not left on an agreed item');
});

test('a decline needs a reason the customer reads and changes nothing in the registry', async () => {
  const c = await seed();
  const removed = ok(await exec(REMOVE, { as: f.customer, variables: { i: itemByKey(c, 'home').id, t: 'drop it' } })).proposeScopeRemoval as Contract;
  const id = removed.scopeProposals[0].id;
  assert.equal((await decide(id, { d: 'DECLINED' })).code, 'REASON_REQUIRED');
  assert.equal((await decide(id, { d: 'DECLINED', r: '   ' })).code, 'REASON_REQUIRED');
  const done = await decideOk(id, { d: 'DECLINED', r: 'The landing page is what the whole design hangs on.' });
  assert.equal(itemByKey(done, 'home').status, 'AGREED', 'the item is exactly as it was');
  const [p] = done.scopeProposals;
  assert.deepEqual([p.decision, p.declineReason], ['DECLINED', 'The landing page is what the whole design hangs on.']);
  // The customer reads it, through the same field.
  const theirs = (await read(f.customer)).scopeProposals[0];
  assert.equal(theirs.declineReason, 'The landing page is what the whole design hangs on.');
});

test('decideScopeProposal: contracts.author only, on the new road, and NOT_FOUND for a proposal that is not there', async () => {
  await seed();
  const c = await addOk();
  const id = c.scopeProposals[0].id;
  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    assert.equal((await decide(id, {}, who)).code, 'FORBIDDEN', who.email!);
  }
  assert.equal((await decide('nope')).code, 'NOT_FOUND');
  assert.equal((await decide(id, {}, f.admin)).errors.length, 0, 'ADMIN holds every capability');
});

test('an item that moved since the proposal was made is refused, not silently overwritten', async () => {
  const c = await seed();
  const home = itemByKey(c, 'home');
  const removed = ok(await exec(REMOVE, { as: f.customer, variables: { i: home.id, t: 'drop it' } })).proposeScopeRemoval as Contract;
  // Sales declines the item by another door before deciding the proposal.
  await prisma.scopeItem.update({ where: { id: home.id }, data: { status: 'DECLINED', declinedReason: 'already gone' } });
  assert.equal((await decide(removed.scopeProposals[0].id, {})).code, 'ITEM_STATE_CHANGED');
  // The proposal is still undecided: it can be declined, with a reason.
  await decideOk(removed.scopeProposals[0].id, { d: 'DECLINED', r: 'Already removed.' });
});

// ---- the lock ---------------------------------------------------------------------

test('STEP_LOCKED: once the agreement is approved (a StepApproval row, inserted directly) every J5 write is refused — the road is walked, not skipped', async () => {
  const c = await seed();
  const pending = await addOk();
  await lock();
  assert.equal((await add()).code, 'STEP_LOCKED');
  assert.equal((await exec(REMOVE, { as: f.customer, variables: { i: itemByKey(c, 'home').id, t: 'x' } })).code, 'STEP_LOCKED');
  assert.equal((await decide(pending.scopeProposals[0].id)).code, 'STEP_LOCKED');
  assert.equal((await exec(SEED, { as: staff.SALES, variables: { c: f.contract.id } })).code, 'STEP_LOCKED');
  // Nothing changed under any of them.
  assert.equal(await prisma.scopeProposal.count(), 1);
  assert.equal(await prisma.scopeItem.count({ where: { projectId: f.contract.projectId } }), 4);
  const v = await read(f.customer);
  assert.deepEqual(v.wizard.filter((w) => ['REQUIREMENTS', 'SCOPE', 'DRAFT'].includes(w.step)).map((w) => w.locked), [true, true, true]);
});

// ---- D-5: the template's parties ----------------------------------------------------

test('D-5: applyContractTemplate renders {{client}} and {{provider}} per language — and nothing is left', async () => {
  await prisma.article.deleteMany({ where: { contractId: f.contract.id } });
  const data = ok(await exec(TEMPLATE, { as: staff.SALES, variables: { c: f.contract.id } })).applyContractTemplate as {
    draft: { articles: Array<{ number: number; bodyFa: string | null; bodyEn: string | null }> };
    scopeItems: Array<{ key: string; contractId: string | null; kind: string }>;
  };
  const one = data.draft.articles.find((a) => a.number === 1)!;
  assert.match(one.bodyEn!, /between Test Studio \(the Client\) and Root \(the Provider\)/);
  assert.match(one.bodyFa!, /میان Test Studio \(کارفرما\) و ریشه \(مجری\)/);
  const two = data.draft.articles.find((a) => a.number === 2)!;
  assert.match(two.bodyEn!, /the Test Studio website and portal/);
  assert.match(two.bodyFa!, /پرتالِ Test Studio/);
  assert.equal(data.draft.articles.length, ARTICLES.length);
  for (const a of data.draft.articles) {
    assert.ok(!/\{\{/.test(`${a.bodyFa ?? ''}${a.bodyEn ?? ''}`), `article ${a.number} still has a placeholder`);
    assert.ok(!/Nahal|نهال/.test(`${a.bodyFa ?? ''}${a.bodyEn ?? ''}`), `article ${a.number} names another client`);
  }
  // What is stored is the finished text, so the snapshot freezes it.
  const stored = await prisma.article.findMany({ where: { contractId: f.contract.id } });
  assert.ok(stored.every((a) => !/\{\{/.test(`${a.bodyFa ?? ''}${a.bodyEn ?? ''}`)));
  // The money articles are still marked by number and title — J4's rule.
  assert.deepEqual(stored.filter((a) => a.sensitive).map((a) => [a.number, a.titleEn]).sort(), [[4, 'Fees'], [5, 'Payment Schedule']]);
  // On the new road it wrote the articles only: its scope is `applyScopeTemplate`'s.
  assert.deepEqual(data.scopeItems, []);
});

test('D-5: a customer with no company name is named by their own, stored as typed (escaping is the renderer’s job at read time)', async () => {
  await prisma.user.update({ where: { id: f.customer.id }, data: { clientName: null, name: 'Nahal & <Co>' } });
  await prisma.article.deleteMany({ where: { contractId: f.contract.id } });
  const data = ok(await exec(TEMPLATE, { as: staff.SALES, variables: { c: f.contract.id } })).applyContractTemplate as {
    draft: { articles: Array<{ number: number; bodyEn: string | null }> };
  };
  // Prose is stored as typed; escaping is the renderer's job at read time, as for every article.
  assert.match(data.draft.articles.find((a) => a.number === 1)!.bodyEn!, /between Nahal & <Co> \(the Client\)/);
});

test('J2’s owed item: applyContractTemplate works on a second contract of a project — its articles, and (legacy) its own scope with suffixed keys', async () => {
  // First contract: a legacy one, template applied.
  const legacy = await legacyContract();
  await prisma.scopeItem.deleteMany({ where: { projectId: legacy.projectId } });
  const first = ok(await exec(TEMPLATE, { as: staff.SALES, variables: { c: legacy.id } })).applyContractTemplate as { scopeItems: Array<{ key: string }> };
  assert.equal(first.scopeItems.length, 6);
  // Second, on the same project.
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-LEGACY-2',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId: legacy.projectId,
      sequence: 'DESIGN_FIRST',
    },
  });
  const r = ok(await exec(TEMPLATE, { as: staff.SALES, variables: { c: second.id } })).applyContractTemplate as {
    draft: { articles: unknown[] };
    scopeItems: Array<{ key: string; contractId: string | null }>;
  };
  assert.equal(r.draft.articles.length, 15);
  const own = r.scopeItems.filter((i) => i.contractId === second.id);
  assert.equal(own.length, 6);
  assert.ok(own.every((i) => /\.2$/.test(i.key)), own.map((i) => i.key).join());
  assert.equal(r.scopeItems.filter((i) => i.contractId === legacy.id).length, 6, 'the first contract keeps its six');
  // Applying again to either is still refused.
  assert.equal((await exec(TEMPLATE, { as: staff.SALES, variables: { c: second.id } })).code, 'TEMPLATE_NOT_EMPTY');
});

// ---- the tick ---------------------------------------------------------------------

test('the tick: refused on a new-road contract (checkedAt never written), and still working — and still logging — on a legacy one', async () => {
  const c = await seed();
  const home = itemByKey(c, 'home');
  const TICK = 'mutation($i: ID!, $c: ID){ setScopeItem(scopeItemId: $i, checked: true, contractId: $c) { id scopeItems { key checked } } }';
  const refused = await exec(TICK, { as: f.customer, variables: { i: home.id, c: f.contract.id } });
  assert.equal(refused.code, 'NOT_APPLICABLE');
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: home.id } })).checkedAt, null);
  // A stranger still hears "no such item" and learns nothing about the road.
  assert.equal((await exec(TICK, { as: f.stranger, variables: { i: home.id } })).code, 'NOT_FOUND');

  const legacy = await legacyContract();
  const ticked = ok(await exec(TICK, { as: f.customer, variables: { i: legacy.itemId, c: legacy.id } })).setScopeItem as {
    scopeItems: Array<{ key: string; checked: boolean }>;
  };
  assert.deepEqual(ticked.scopeItems.map((s) => [s.key, s.checked]), [['landing', true]]);
  assert.ok((await prisma.scopeItem.findUniqueOrThrow({ where: { id: legacy.itemId } })).checkedAt);
  assert.equal(await prisma.changeLog.count({ where: { contractId: legacy.id, action: 'SCOPE_ON' } }), 1, 'the legacy tick still logs');
  assert.equal(await prisma.changeLog.count({ where: { contractId: f.contract.id, action: 'SCOPE_ON' } }), 0);
});

test('legacy behaviour is unchanged: a legacy customer cannot propose, and sales’ registry edits still work', async () => {
  const legacy = await legacyContract();
  assert.equal((await add('x', 'PAGE', 'en', legacy.id)).code, 'STEP_NOT_ON_ROAD');
  ok(
    await exec('mutation($c: ID!){ addScopeItem(contractId: $c, key: "extra-page", labelFa: "ص", labelEn: "Page", kind: PAGE) { id } }', {
      as: staff.SALES,
      variables: { c: legacy.id },
    }),
  );
  assert.equal(await prisma.scopeItem.count({ where: { projectId: legacy.projectId } }), 2);
});

// ---- the trade's customer half ----------------------------------------------------

const TRADE = `mutation($p: ID!, $o: ID!, $c: ID){ proposeScopeTrade(projectId: $p, outItemId: $o, inKey: "loyalty", inLabelFa: "وفاداری", inLabelEn: "Loyalty", contractId: $c) { ${CONTRACT} } }`;
const CONFIRM_ROOT = `mutation($t: ID!, $c: ID){ confirmScopeTradeRoot(tradeId: $t, contractId: $c) { id } }`;
const CONFIRM_CUSTOMER = `mutation($t: ID!, $c: ID){ confirmScopeTradeCustomer(tradeId: $t, contractId: $c) { ${CONTRACT} } }`;
const EXECUTE = `mutation($t: ID!, $c: ID){ executeScopeTrade(tradeId: $t, contractId: $c) { ${CONTRACT} } }`;

async function openTrade() {
  const c = await seed();
  const proposed = ok(
    await exec(TRADE, { as: staff.SALES, variables: { p: f.contract.projectId, o: itemByKey(c, 'about').id, c: f.contract.id } }),
  ).proposeScopeTrade as Contract;
  return proposed.project.scopeTrades[0].id;
}

test('a scope trade executes only once both sides have confirmed; only the contract’s customer may confirm theirs', async () => {
  const tradeId = await openTrade();
  const run = (as: User) => exec(EXECUTE, { as, variables: { t: tradeId, c: f.contract.id } });

  // Nobody has confirmed.
  assert.equal((await run(staff.SALES)).code, 'TRADE_NOT_CONFIRMED');
  // Root's half alone is not enough — this is the gate L1 wrote and J5 did not change.
  ok(await exec(CONFIRM_ROOT, { as: staff.SALES, variables: { t: tradeId, c: f.contract.id } }));
  assert.equal((await run(staff.SALES)).code, 'TRADE_NOT_CONFIRMED');

  // Not the customer: staff who can see the contract, a stranger, and a signed-out caller.
  for (const who of [staff.SALES, staff.DESIGNER, f.admin, f.stranger]) {
    assert.equal((await exec(CONFIRM_CUSTOMER, { as: who, variables: { t: tradeId } })).code, 'NOT_FOUND', who.email!);
  }
  assert.ok(['UNAUTHENTICATED', 'FORBIDDEN'].includes((await exec(CONFIRM_CUSTOMER, { as: null, variables: { t: tradeId } })).code ?? ''));
  assert.equal((await prisma.scopeTrade.findUniqueOrThrow({ where: { id: tradeId } })).customerConfirmedAt, null);
  // A contract of another customer named by the caller does not make it theirs.
  assert.equal((await exec(CONFIRM_CUSTOMER, { as: f.stranger, variables: { t: tradeId, c: f.contract.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: 'nope' } })).code, 'NOT_FOUND');

  // The customer's half.
  const confirmed = ok(await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: tradeId } })).confirmScopeTradeCustomer as Contract;
  assert.ok(confirmed.project.scopeTrades[0].customerConfirmedAt);
  assert.equal((await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: tradeId } })).code, 'ALREADY_CONFIRMED');

  // Now it executes: the item goes out, the item comes in, agreed by this contract.
  const done = ok(await run(staff.SALES)).executeScopeTrade as Contract;
  const trade = done.project.scopeTrades[0];
  assert.ok(trade.executedAt);
  assert.deepEqual([trade.outItem.status, trade.inItem.status, trade.inItem.contractId], ['TRADED', 'AGREED', f.contract.id]);
  assert.equal((await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: tradeId } })).code, 'ALREADY_EXECUTED');
  assert.equal((await run(staff.SALES)).code, 'ALREADY_EXECUTED');
});

test('the customer’s half works when SCOPE is locked — a trade is how a scope changes after the agreement', async () => {
  const tradeId = await openTrade();
  await lock();
  ok(await exec(CONFIRM_ROOT, { as: staff.SALES, variables: { t: tradeId, c: f.contract.id } }));
  ok(await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: tradeId } }));
  ok(await exec(EXECUTE, { as: staff.SALES, variables: { t: tradeId, c: f.contract.id } }));
  // ...while a proposal, which is the *pre*-lock path, is refused.
  assert.equal((await add()).code, 'STEP_LOCKED');
});

test('a trade waiting shows in both statuses: the customer’s move until they confirm, then Root’s to carry out', async () => {
  const tradeId = await openTrade();
  const kinds = (c: Contract) => c.attention.filter((a) => a.kind === 'TRADE_TO_CONFIRM').map((a) => `${a.variant}/${a.waitingOn}`).sort();
  assert.deepEqual(kinds(await read(f.customer)), ['customer/CUSTOMER', 'root/ROOT']);
  ok(await exec(CONFIRM_ROOT, { as: staff.SALES, variables: { t: tradeId, c: f.contract.id } }));
  assert.deepEqual(kinds(await read(f.customer)), ['customer/CUSTOMER']);
  ok(await exec(CONFIRM_CUSTOMER, { as: f.customer, variables: { t: tradeId } }));
  assert.deepEqual(kinds(await read(staff.SALES)), ['execute/ROOT']);
  ok(await exec(EXECUTE, { as: staff.SALES, variables: { t: tradeId, c: f.contract.id } }));
  assert.deepEqual(kinds(await read(staff.SALES)), [], 'an executed trade waits on no one');
});

// ---- the wizard and attention ------------------------------------------------------

test('the wizard: SCOPE is done exactly when the contract has a scope and no proposal is waiting', async () => {
  const scope = (c: Contract) => c.wizard.find((w) => w.step === 'SCOPE')!.status;
  assert.notEqual(scope(await read(staff.SALES)), 'DONE', 'no scope yet: confirmed is not seeded');
  await seed();
  assert.equal(scope(await read(staff.SALES)), 'DONE');
  const c = await addOk();
  assert.notEqual(scope(c), 'DONE', 'a proposal is waiting for Root');
  assert.notEqual(scope(await read(f.customer)), 'DONE');
  await decideOk(c.scopeProposals[0].id);
  assert.equal(scope(await read(f.customer)), 'DONE');
  // Declining settles it just as much.
  const c2 = await addOk('another');
  assert.notEqual(scope(c2), 'DONE');
  await decideOk(c2.scopeProposals.find((p) => !p.decidedAt)!.id, { d: 'DECLINED', r: 'no' });
  assert.equal(scope(await read(staff.SALES)), 'DONE');
});

test('attention: proposals waiting are Root’s move, one line for all of them — the customer sees that Root owes them an answer, and it clears when they are decided', async () => {
  await seed();
  await addOk();
  await addOk('two', 'FEATURE', 'en');
  const item = (c: Contract) => c.attention.find((a) => a.kind === 'PROPOSAL_TO_DECIDE');
  const forSales = item(await read(staff.SALES))!;
  assert.deepEqual([forSales.waitingOn, forSales.role], ['ROOT', 'SALES']);
  assert.ok(item(await read(f.customer)));
  assert.ok(item(await read(staff.SALES, true)), 'view-as-customer is the same answer');
  const proposals = await prisma.scopeProposal.findMany();
  for (const p of proposals) await decideOk(p.id, { d: 'DECLINED', r: 'no' });
  assert.equal(item(await read(staff.SALES)), undefined);
});

test('the proposals are the contract’s readers’: the customer and staff who can see the contract, nobody else', async () => {
  await seed();
  await addOk();
  const q = `query($c: ID!){ contract(id: $c) { scopeProposals { id text } } }`;
  for (const who of [f.customer, staff.SALES, staff.DESIGNER, f.admin]) {
    const c = ok(await exec(q, { as: who, variables: { c: f.contract.id } })).contract as { scopeProposals: unknown[] };
    assert.equal(c.scopeProposals.length, 1, who.email!);
  }
  for (const who of [f.stranger, staff.CONTRIBUTOR]) {
    assert.equal((await exec(q, { as: who, variables: { c: f.contract.id } })).code, 'NOT_FOUND', who.email!);
  }
});

// ---- notifications ----------------------------------------------------------------

test('a proposal made tells everyone who can decide it — by email and SMS — and nobody else', async () => {
  await seed();
  await addOk('A page about <us>');
  const recipients = mail.map((m) => m.to).sort();
  assert.deepEqual(recipients, [f.admin.email, staff.SALES.email].sort(), 'contracts.author holders only: not the designer, not the customer');
  const first = mail.find((m) => m.to === staff.SALES.email)!;
  assert.ok(first.html.includes('A page about &lt;us&gt;'), 'the customer’s words, escaped');
  assert.ok(first.text.includes('A page about <us>'));
  assert.ok(first.text.includes(`/desk/contracts/${f.contract.id}/steps`));
  // Sales has a phone; the admin has none in this fixture — so one SMS, and no words in it.
  assert.deepEqual(sms.map((s) => s.to), ['+989120000102']);
  assert.ok(sms[0].text!.includes(`/desk/contracts/${f.contract.id}/steps`));
  assert.ok(!sms[0].text!.includes('page about'));
});

test('a refused proposal tells no one', async () => {
  await seed();
  mail.length = 0;
  await add('x', 'EXTRA');
  await add('   ');
  assert.deepEqual(mail, []);
  assert.deepEqual(sms, []);
});

test('a proposal decided tells the customer, in their language, with the reason when it was declined', async () => {
  await seed();
  const c = await addOk();
  mail.length = 0;
  sms.length = 0;
  await decideOk(c.scopeProposals[0].id);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, f.customer.email);
  assert.match(mail[0].subject, /پذیرفته شد/);
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, '+989120000105');

  const c2 = await addOk('another', 'PAGE', 'fa');
  mail.length = 0;
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  await decideOk(c2.scopeProposals.find((p) => !p.decidedAt)!.id, { d: 'DECLINED', r: 'Not in this contract' });
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /declined/);
  assert.ok(mail[0].text.includes('Not in this contract'));
});

test('a failing mail transport never fails the act that caused it', async () => {
  await seed();
  __setMailTransportForTests({
    send: async () => {
      throw new Error('mail is down');
    },
  });
  const c = await addOk();
  assert.equal(c.scopeProposals.length, 1);
  ok(await decide(c.scopeProposals[0].id));
});
