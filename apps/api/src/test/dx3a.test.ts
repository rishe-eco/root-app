import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, publishDraftDirect, resetDatabase, seedFixture, seedHandoverTypes, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { COMMITMENTS } from '../lib/brief.js';
import { onDay } from './calendar.js';

/**
 * DX3a — handover items: the `Dependency` row is the item, edited from
 * Requirements and from the Dependencies tab (desk UX review items 6–8, 20, 29;
 * decision log row 15).
 *
 * What the pure tables (`brief.test.ts`, `dependency.test.ts`, `revision.test.ts`)
 * cannot show: the database's own CHECK by direct insert; a new brief making a
 * row for each active item on the desk's list; the two places editing the same
 * records; the lock after the agreement is approved (and verification still
 * allowed); what the customer's board hides and Requirements still lists; the
 * "feature for an existing site" preset; the format-3 snapshot's `handover`;
 * and the desk list's own mutations.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let typeId: string;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  typeId = (await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } })).id;
  await seedHandoverTypes();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

// ---- documents ------------------------------------------------------------------

const DEP = 'id side dueAt notNeeded inBrief briefKey titleEn technical overdue verifiedAt';
const SET_BRIEF = `mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) {
  id brief { designTier kind } handover { ${DEP} } briefCompleteness { code key } project { dependencies { ${DEP} } scopeItems { key status } }
} }`;
const READ = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { id handover { ${DEP} } project { dependencies { ${DEP} } } briefCompleteness { code key } } }`;
const CREATE_DEP = `mutation($p: ID!, $side: DependencySide, $due: DateTime, $fa: String!, $en: String!, $c: ID){
  createDependency(projectId: $p, side: $side, titleFa: $fa, titleEn: $en, dueAt: $due, contractId: $c) { id handover { ${DEP} } project { dependencies { ${DEP} } } }
}`;
const UPDATE_DEP = `mutation($d: ID!, $fa: String, $en: String, $side: DependencySide, $due: DateTime, $nn: Boolean, $c: ID){
  updateDependency(dependencyId: $d, titleFa: $fa, titleEn: $en, side: $side, dueAt: $due, notNeeded: $nn, contractId: $c) { id handover { ${DEP} } project { dependencies { ${DEP} } } }
}`;
const DELETE_DEP = `mutation($d: ID!, $c: ID){ deleteDependency(dependencyId: $d, contractId: $c) { id } }`;
const VERIFY = `mutation($d: ID!){ verifyDependency(dependencyId: $d, note: "checked it") { id } }`;

type Dep = {
  id: string;
  side: string | null;
  dueAt: string | null;
  notNeeded: boolean;
  inBrief: boolean;
  briefKey: string | null;
  titleEn: string;
  technical: boolean;
  overdue: boolean;
  verifiedAt: string | null;
};
type View = { handover: Dep[]; project: { dependencies: Dep[]; scopeItems?: Array<{ key: string; status: string }> } };

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const briefInput = (over: Record<string, unknown> = {}) => ({
  kind: 'NEW_SITE',
  templateTypeId: typeId,
  designTier: 'THEME_PICK',
  budgetCap: '150000000',
  hardDeadline: onDay('2026-10-23'),
  supportMonths: 6,
  premadeRounds: 2,
  demoIterationsPerPhase: 2,
  ...over,
});
const setBrief = (over: Record<string, unknown> = {}, as: User = staff.SALES) =>
  exec(SET_BRIEF, { as, variables: { c: f.contract.id, i: briefInput(over) } });
const setBriefOk = async (over: Record<string, unknown> = {}) => ok(await setBrief(over)).setBrief as View & {
  brief: { designTier: string; kind: string };
  briefCompleteness: Array<{ code: string; key: string | null }>;
};
const read = async (as: User, asCustomer = false) => ok(await exec(READ, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as View & {
  briefCompleteness: Array<{ code: string; key: string | null }>;
};
const board = () => prisma.dependency.findMany({ where: { projectId: f.contract.projectId }, orderBy: [{ briefKey: 'asc' }, { titleEn: 'asc' }] });
const byKey = async (key: string) => (await board()).find((r) => r.briefKey === key)!;
const update = (variables: Record<string, unknown>, as: User = staff.SALES) => exec(UPDATE_DEP, { as, variables });
const approveAgreement = () => prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
const extra = (key: string, status: 'DECLINED' | 'AGREED' = 'DECLINED') =>
  prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key, kind: 'EXTRA', labelFa: 'ا', labelEn: key, status, contractId: f.contract.id },
  });

// =================================================================================
// the database's own rule, by direct insert
// =================================================================================

test('Dependency_board_row_complete: a row that is only on the board needs a side and a date; a requirements row needs neither', async () => {
  const base = { projectId: f.contract.projectId, titleFa: 'ا', titleEn: 'x', createdById: f.admin.id };
  const day = new Date();
  await assert.rejects(() => prisma.dependency.create({ data: { ...base, side: null, dueAt: day } }), /Dependency_board_row_complete/);
  await assert.rejects(() => prisma.dependency.create({ data: { ...base, side: 'ROOT', dueAt: null } }), /Dependency_board_row_complete/);
  await assert.rejects(() => prisma.dependency.create({ data: { ...base } }), /Dependency_board_row_complete/);
  await assert.doesNotReject(() => prisma.dependency.create({ data: { ...base, side: 'ROOT', dueAt: day } }));
  await assert.doesNotReject(() => prisma.dependency.create({ data: { ...base, inBrief: true } }), 'inBrief: undecided and undated is allowed');
  await assert.doesNotReject(() => prisma.dependency.create({ data: { ...base, inBrief: true, side: 'CUSTOMER' } }));
  // An update that would strip a board-only row of its side is refused by the same rule.
  const plain = await prisma.dependency.create({ data: { ...base, titleEn: 'plain', side: 'ROOT', dueAt: day } });
  await assert.rejects(() => prisma.dependency.update({ where: { id: plain.id }, data: { dueAt: null } }), /Dependency_board_row_complete/);
});

test('the migration seeds the default list from the commitments table, in order — one table, two copies, pinned together', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20261117150000_dx3a_handover/migration.sql', import.meta.url)),
    'utf8',
  );
  const seeded = [...sql.matchAll(/\('handover_type_(\w+)', '(\w+)', '([^']+)', '([^']+)', (true|false), (\d+)\)/g)].map((m) => ({
    key: m[2],
    titleFa: m[3],
    titleEn: m[4],
    technical: m[5] === 'true',
    position: Number(m[6]),
  }));
  assert.deepEqual(
    seeded.map((s) => s.key),
    ['domain', 'host', 'content'],
  );
  for (const s of seeded) {
    const spec = COMMITMENTS[s.key as 'domain' | 'host' | 'content'];
    assert.deepEqual([s.titleFa, s.titleEn, s.technical], [spec.titleFa, spec.titleEn, spec.technical], s.key);
  }
  assert.deepEqual(seeded.map((s) => s.position), [0, 1, 2]);
});

// =================================================================================
// seeding, and one set of records
// =================================================================================

test('a new brief makes an inBrief row for every active default item; a second save makes none; an inactive item is skipped', async () => {
  await prisma.handoverItemType.update({ where: { key: 'content' }, data: { active: false } });
  const view = await setBriefOk();
  assert.deepEqual(
    view.handover.map((h) => [h.briefKey, h.side, h.dueAt, h.inBrief, h.notNeeded, h.technical]),
    [
      ['domain', null, null, true, false, true],
      ['host', null, null, true, false, true],
    ],
  );
  await setBriefOk({ budgetCap: '1' });
  assert.equal((await board()).length, 2);
  assert.deepEqual(view.briefCompleteness, [], 'an undecided, undated list is complete: each provider is optional');
});

test('Requirements’ list and the Dependencies tab are the same rows: an edit from either shows in both; an item added before the lock is in both', async () => {
  await setBriefOk();
  const domain = await byKey('domain');
  const due = iso(10);

  // From the board's side: Root, with a date. Both views show the one row.
  const afterEdit = ok(await update({ d: domain.id, side: 'ROOT', due })).updateDependency as View;
  const seenInReq = afterEdit.handover.find((h) => h.id === domain.id)!;
  const seenOnBoard = afterEdit.project.dependencies.find((h) => h.id === domain.id)!;
  assert.deepEqual(seenInReq, seenOnBoard);
  assert.deepEqual([seenInReq.side, seenInReq.dueAt], ['ROOT', due]);

  // A one-off added from the board before the lock is a requirements row too…
  const made = ok(
    await exec(CREATE_DEP, { as: staff.SALES, variables: { p: f.contract.projectId, fa: 'لوگو', en: 'Logo files', c: f.contract.id } }),
  ).createDependency as View;
  const logo = made.handover.find((h) => h.titleEn === 'Logo files')!;
  assert.deepEqual([logo.inBrief, logo.side, logo.dueAt, logo.briefKey], [true, null, null, null], 'inBrief, undecided and undated');
  assert.ok(made.project.dependencies.some((d) => d.id === logo.id));

  // …and one with a side and a date stays complete; clearing it is allowed while the step is open.
  ok(await update({ d: logo.id, side: 'CUSTOMER', due }));
  assert.deepEqual((await read(staff.SALES)).briefCompleteness, []);
  ok(await update({ d: logo.id, side: null, due: null }));
  // A one-off can be removed from Requirements; a keyed row cannot (BRIEF_OWNED) — mark it not needed.
  ok(await exec(DELETE_DEP, { as: staff.SALES, variables: { d: logo.id, c: f.contract.id } }));
  assert.equal(await prisma.dependency.count({ where: { id: logo.id } }), 0);
  assert.equal((await exec(DELETE_DEP, { as: staff.SALES, variables: { d: domain.id } })).code, 'BRIEF_OWNED');
});

test('an update names what it changes: an omitted argument is left alone, null clears, and a blank title is refused', async () => {
  await setBriefOk();
  const host = await byKey('host');
  ok(await update({ d: host.id, side: 'ROOT', due: iso(5) }));
  ok(await update({ d: host.id, nn: true }));
  const row = await byKey('host');
  assert.deepEqual([row.side, row.dueAt !== null, row.notNeeded, row.titleEn], ['ROOT', true, true, COMMITMENTS.host.titleEn]);
  // DX4: one language is enough, so blanking one of the two is allowed; blanking both is not.
  assert.equal((await update({ d: host.id, fa: '', en: '   ' })).code, 'TITLE_REQUIRED');
  assert.equal((await update({ d: host.id, side: 'ROOT' }, staff.DESIGNER)).code, 'FORBIDDEN');
  assert.equal((await update({ d: host.id, side: 'ROOT' }, f.customer)).code, 'FORBIDDEN');
});

test('a board-only row (a legacy contract has no requirements step) still needs a side and a date', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  const vars = { p: f.contract.projectId, fa: 'ا', en: 'Board only', c: f.contract.id };
  assert.equal((await exec(CREATE_DEP, { as: staff.SALES, variables: vars })).code, 'DEPENDENCY_INCOMPLETE');
  assert.equal((await exec(CREATE_DEP, { as: staff.SALES, variables: { ...vars, side: 'ROOT' } })).code, 'DEPENDENCY_INCOMPLETE');
  const made = ok(await exec(CREATE_DEP, { as: staff.SALES, variables: { ...vars, side: 'ROOT', due: iso(3) } })).createDependency as View;
  const row = made.project.dependencies.find((d) => d.titleEn === 'Board only')!;
  assert.equal(row.inBrief, false);
  assert.equal((await update({ d: row.id, side: null })).code, 'DEPENDENCY_INCOMPLETE');
  assert.equal((await update({ d: row.id, due: null })).code, 'DEPENDENCY_INCOMPLETE');
  ok(await update({ d: row.id, side: 'CUSTOMER', en: 'Renamed' }));
});

// =================================================================================
// the lock
// =================================================================================

test('once the agreement is approved an inBrief row cannot change or be deleted (STEP_LOCKED) — verifying it still works, and repeating what it says is not a change', async () => {
  await setBriefOk();
  const host = await byKey('host');
  const logo = ok(
    await exec(CREATE_DEP, { as: staff.SALES, variables: { p: f.contract.projectId, fa: 'لوگو', en: 'Logo files', side: 'CUSTOMER', due: iso(4), c: f.contract.id } }),
  ).createDependency as View;
  const oneOff = logo.handover.find((h) => h.titleEn === 'Logo files')!;
  ok(await update({ d: host.id, side: 'ROOT', due: iso(6) }));
  await approveAgreement();

  const before = JSON.stringify(await board());
  const hostNow = await byKey('host');
  const attempts: Array<[string, Record<string, unknown>]> = [
    ['side', { d: host.id, side: 'CUSTOMER' }],
    ['clearing the side', { d: host.id, side: null }],
    ['date', { d: host.id, due: iso(30) }],
    ['clearing the date', { d: host.id, due: null }],
    ['not needed', { d: host.id, nn: true }],
    ['title', { d: host.id, en: 'Other' }],
    ['a one-off’s side', { d: oneOff.id, side: 'ROOT' }],
  ];
  for (const [name, vars] of attempts) assert.equal((await update(vars)).code, 'STEP_LOCKED', name);
  assert.equal((await exec(DELETE_DEP, { as: staff.SALES, variables: { d: oneOff.id } })).code, 'STEP_LOCKED', 'a one-off cannot be deleted');
  assert.equal(JSON.stringify(await board()), before, 'nothing was written');

  // A form that resends every field as it is, is not refused.
  ok(await update({ d: host.id, side: 'ROOT', due: hostNow.dueAt!.toISOString(), nn: false, fa: hostNow.titleFa, en: hostNow.titleEn }));

  // Marking it delivered (verification) is not an edit.
  ok(await exec(VERIFY, { as: f.admin, variables: { d: host.id } }));
  assert.ok((await byKey('host')).verifiedAt);
});

test('a row added after the lock is not part of the requirements: it needs a side and a date and shows on the board only', async () => {
  await setBriefOk();
  await approveAgreement();
  const vars = { p: f.contract.projectId, fa: 'ا', en: 'After the lock', c: f.contract.id };
  assert.equal((await exec(CREATE_DEP, { as: staff.SALES, variables: vars })).code, 'DEPENDENCY_INCOMPLETE');
  const made = ok(await exec(CREATE_DEP, { as: staff.SALES, variables: { ...vars, side: 'ROOT', due: iso(9) } })).createDependency as View;
  const row = made.project.dependencies.find((d) => d.titleEn === 'After the lock')!;
  assert.equal(row.inBrief, false);
  assert.equal(made.handover.some((h) => h.id === row.id), false, 'not in Requirements');
  // It is the board's own row: editable and deletable as before.
  ok(await update({ d: row.id, side: 'CUSTOMER', due: iso(12) }));
  ok(await exec(DELETE_DEP, { as: staff.SALES, variables: { d: row.id, c: f.contract.id } }));
});

// =================================================================================
// who sees what
// =================================================================================

test('the customer’s board hides not-needed and undecided rows, Requirements lists them all; staff see every row, undated last; undated is never overdue', async () => {
  await setBriefOk();
  const [domain, host] = [await byKey('domain'), await byKey('host')];
  ok(await update({ d: domain.id, side: 'CUSTOMER', due: iso(-3) })); // overdue
  ok(await update({ d: host.id, side: 'ROOT', nn: true, due: iso(-3) })); // not needed: not overdue, hidden
  // content stays undecided and undated.

  const staffView = await read(staff.SALES);
  assert.deepEqual(staffView.project.dependencies.map((d) => d.briefKey), ['domain', 'host', 'content'], 'soonest first, the undated last');
  const flags = Object.fromEntries(staffView.project.dependencies.map((d) => [d.briefKey, d.overdue]));
  assert.deepEqual(flags, { domain: true, host: false, content: false });

  for (const viewAs of [false, true]) {
    const customerView = viewAs ? await read(staff.SALES, true) : await read(f.customer);
    assert.deepEqual(customerView.project.dependencies.map((d) => d.briefKey), ['domain'], `the customer’s board${viewAs ? ' (view as customer)' : ''}`);
    assert.deepEqual(customerView.handover.map((d) => d.briefKey).sort(), ['content', 'domain', 'host'], 'Requirements lists all three');
  }

  // The staff dashboard counts neither the undated nor the not-needed.
  const overdue = ok(await exec('query{ overdueDependencies { briefKey } }', { as: f.admin })).overdueDependencies as Array<{ briefKey: string }>;
  assert.deepEqual(overdue.map((d) => d.briefKey), ['domain']);
  const mine = ok(await exec('query{ myOverdueDependencies { briefKey } }', { as: f.customer })).myOverdueDependencies as Array<{ briefKey: string }>;
  assert.deepEqual(mine.map((d) => d.briefKey), ['domain']);
});

// =================================================================================
// the preset
// =================================================================================

test('choosing "feature for an existing site" sets No design, takes every extra out of scope and marks the domain and host not needed — once, in one write; switching back changes nothing', async () => {
  await extra('checklist.payment', 'AGREED');
  await setBriefOk({ commitments: [{ key: 'gateway', dueAt: '2026-12-01' }] });
  assert.ok((await board()).some((r) => r.briefKey === 'gateway'));

  const view = await setBriefOk({ kind: 'FEATURE_FOR_EXISTING', existingSiteUrl: 'https://old.example.com', designTier: 'SENIOR_DESIGNER' });
  assert.deepEqual([view.brief.kind, view.brief.designTier], ['FEATURE_FOR_EXISTING', 'NONE']);
  assert.deepEqual(view.project.scopeItems!.filter((s) => s.key.startsWith('checklist.')).map((s) => s.status), ['DECLINED']);
  const rows = await board();
  assert.deepEqual(rows.map((r) => [r.briefKey, r.notNeeded]), [['content', false], ['domain', true], ['host', true]], 'and the declined extra’s row is gone');

  // Every field stays editable: put the design back and say the domain is needed; saving again does not re-apply the preset.
  ok(await update({ d: (await byKey('domain')).id, nn: false }));
  const again = await setBriefOk({ kind: 'FEATURE_FOR_EXISTING', existingSiteUrl: 'https://old.example.com', designTier: 'THEME_PICK' });
  assert.equal(again.brief.designTier, 'THEME_PICK');
  assert.equal((await byKey('domain')).notNeeded, false);
  assert.equal((await byKey('host')).notNeeded, true);

  // Switching back to a new site changes none of it.
  const back = await setBriefOk({ kind: 'NEW_SITE', designTier: 'NONE' });
  assert.equal(back.brief.designTier, 'NONE');
  assert.equal((await byKey('host')).notNeeded, true);
});

test('a brief that is a feature for an existing site from the start is preset too: the rows are seeded, then the domain and host marked', async () => {
  const view = await setBriefOk({ kind: 'FEATURE_FOR_EXISTING', existingSiteUrl: 'https://old.example.com' });
  assert.equal(view.brief.designTier, 'NONE');
  assert.deepEqual(view.handover.map((h) => [h.briefKey, h.notNeeded]), [['domain', true], ['host', true], ['content', false]]);
});

// =================================================================================
// the snapshot
// =================================================================================

test('a format-3 publish carries the handover items — the inBrief rows, by the list’s position, with no board-only row and nothing about verification', async () => {
  await setBriefOk();
  const [domain, host] = [await byKey('domain'), await byKey('host')];
  ok(await update({ d: domain.id, side: 'CUSTOMER', due: '2026-12-01T00:00:00.000Z' }));
  ok(await update({ d: host.id, nn: true }));
  ok(await exec(VERIFY, { as: f.admin, variables: { d: domain.id } }));
  ok(await exec(CREATE_DEP, { as: staff.SALES, variables: { p: f.contract.projectId, fa: 'لوگو', en: 'Logo files', side: 'ROOT', due: '2027-01-02T00:00:00.000Z', c: f.contract.id } }));
  // A board-only row (made after a lock, here by hand) is not part of the agreement.
  await prisma.dependency.create({
    data: { projectId: f.contract.projectId, titleFa: 'ا', titleEn: 'Board only', side: 'ROOT', dueAt: new Date(), createdById: f.admin.id },
  });
  // Reorder the desk list: content first. The agreement lists the items in the list's order.
  await prisma.handoverItemType.update({ where: { key: 'content' }, data: { position: -1 } });

  const revision = await publishDraftDirect(f.contract.id);
  const snapshot = revision.snapshot as unknown as { format: number; brief: Record<string, unknown>; handover: Array<Record<string, unknown>> };
  assert.equal(snapshot.format, 3);
  assert.deepEqual(snapshot.handover, [
    { key: 'content', titleFa: COMMITMENTS.content.titleFa, titleEn: COMMITMENTS.content.titleEn, side: null, dueOn: null, notNeeded: false },
    { key: 'domain', titleFa: COMMITMENTS.domain.titleFa, titleEn: COMMITMENTS.domain.titleEn, side: 'CUSTOMER', dueOn: '2026-12-01', notNeeded: false },
    { key: 'host', titleFa: COMMITMENTS.host.titleFa, titleEn: COMMITMENTS.host.titleEn, side: null, dueOn: null, notNeeded: true },
    { key: null, titleFa: 'لوگو', titleEn: 'Logo files', side: 'ROOT', dueOn: '2027-01-02', notNeeded: false },
  ]);
  for (const k of ['domainProvidedBy', 'hostProvidedBy', 'contentProvidedBy']) assert.ok(!(k in snapshot.brief), k);

  // …and the customer reads it back through the API, days as days.
  const view = ok(
    await exec(`query($c: ID!){ contract(id: $c) { revision { format agreement { handover { key side dueOn notNeeded } brief { domainProvidedBy } } } } }`, {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  ).contract as { revision: { format: number; agreement: { handover: Array<{ key: string | null; dueOn: string | null }>; brief: { domainProvidedBy: string | null } } } };
  assert.equal(view.revision.format, 3);
  assert.deepEqual(view.revision.agreement.handover.map((h) => h.key), ['content', 'domain', 'host', null]);
  assert.equal(view.revision.agreement.handover[1].dueOn?.slice(0, 10), '2026-12-01');
  assert.equal(view.revision.agreement.brief.domainProvidedBy, null);
});

test('the draft goes stale when a handover item changes before the lock — the agreement gate sees what the snapshot freezes', async () => {
  await setBriefOk();
  await publishDraftDirect(f.contract.id);
  const dirty = `query($c: ID!){ contract(id: $c) { draft { dirty } } }`;
  const isDirty = async () => (ok(await exec(dirty, { as: staff.SALES, variables: { c: f.contract.id } })).contract as { draft: { dirty: boolean } }).draft.dirty;
  assert.equal(await isDirty(), false);
  ok(await update({ d: (await byKey('domain')).id, side: 'ROOT' }));
  assert.equal(await isDirty(), true);
});

// =================================================================================
// the desk's default list
// =================================================================================

const LIST = `query{ handoverItemTypes { id key titleFa titleEn technical position active } }`;
const CREATE_TYPE = `mutation($k: String!, $fa: String!, $en: String!, $t: Boolean){ createHandoverItemType(key: $k, titleFa: $fa, titleEn: $en, technical: $t) { id key position active technical } }`;
const UPDATE_TYPE = `mutation($id: ID!, $fa: String, $en: String, $t: Boolean, $a: Boolean){ updateHandoverItemType(id: $id, titleFa: $fa, titleEn: $en, technical: $t, active: $a) { id key titleEn technical active } }`;
const REORDER = `mutation($ids: [ID!]!){ reorderHandoverItemTypes(ids: $ids) { key position } }`;

test('the default list: add (last), rename, reorder, deactivate; the key never changes; no delete; and the rows already made keep what they say', async () => {
  const list = async () => (ok(await exec(LIST, { as: staff.SALES })).handoverItemTypes as Array<{ id: string; key: string; titleEn: string; position: number; active: boolean }>);
  assert.deepEqual((await list()).map((t) => t.key), ['domain', 'host', 'content']);

  const made = ok(await exec(CREATE_TYPE, { as: staff.SALES, variables: { k: 'sms-line', fa: 'خط پیامک', en: 'SMS line' } })).createHandoverItemType as { id: string; position: number; technical: boolean };
  assert.deepEqual([made.position, made.technical], [3, false]);
  assert.equal((await exec(CREATE_TYPE, { as: staff.SALES, variables: { k: 'sms-line', fa: 'ا', en: 'x' } })).code, 'HANDOVER_KEY_TAKEN');
  assert.equal((await exec(CREATE_TYPE, { as: staff.SALES, variables: { k: 'gateway', fa: 'ا', en: 'x' } })).code, 'HANDOVER_KEY_TAKEN', 'an extra’s key');
  assert.equal((await exec(CREATE_TYPE, { as: staff.SALES, variables: { k: 'Not A Slug', fa: 'ا', en: 'x' } })).code, 'INVALID_SLUG');
  assert.equal((await exec(CREATE_TYPE, { as: staff.SALES, variables: { k: 'blank', fa: ' ', en: 'x' } })).code, 'TITLE_REQUIRED');

  // A brief made now gets the new item.
  await setBriefOk();
  assert.deepEqual((await board()).map((r) => r.briefKey), ['content', 'domain', 'host', 'sms-line']);

  // Rename: the type changes, the row that exists keeps its title.
  ok(await exec(UPDATE_TYPE, { as: staff.SALES, variables: { id: made.id, en: 'SMS number', t: true } }));
  assert.equal((await byKey('sms-line')).titleEn, 'SMS line');
  assert.equal((await exec(UPDATE_TYPE, { as: staff.SALES, variables: { id: made.id, en: '' } })).code, 'TITLE_REQUIRED');
  assert.equal((await exec(UPDATE_TYPE, { as: staff.SALES, variables: { id: 'nope', en: 'x' } })).code, 'NOT_FOUND');

  // Reorder: the whole list, exactly once each.
  const ids = (await list()).map((t) => t.id);
  assert.equal((await exec(REORDER, { as: staff.SALES, variables: { ids: ids.slice(1) } })).code, 'REORDER_MISMATCH');
  ok(await exec(REORDER, { as: staff.SALES, variables: { ids: [...ids].reverse() } }));
  assert.deepEqual((await list()).map((t) => t.key), ['sms-line', 'content', 'host', 'domain']);

  // Deactivate: kept on the list, not seeded for the next project's brief.
  ok(await exec(UPDATE_TYPE, { as: staff.SALES, variables: { id: made.id, a: false } }));
  assert.equal((ok(await exec('query{ handoverItemTypes(activeOnly: true) { key } }', { as: staff.SALES })).handoverItemTypes as unknown[]).length, 3);
});

test('the default list is sales’ (contracts.author): the designer and the customer cannot read or write it', async () => {
  for (const who of [staff.DESIGNER, staff.DEVELOPER, f.customer]) {
    assert.equal((await exec(LIST, { as: who })).code, 'FORBIDDEN');
    assert.equal((await exec(CREATE_TYPE, { as: who, variables: { k: 'x', fa: 'ا', en: 'x' } })).code, 'FORBIDDEN');
  }
  assert.equal((await exec(LIST, { as: f.admin })).code ?? 'OK', 'OK');
  assert.equal(await prisma.handoverItemType.count(), 3);
});
