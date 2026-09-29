import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { primaryContractId } from '../graphql/resolvers/admin/shared.js';

/**
 * T1 — template types, scope templates, `ScopeItem.kind` (journeys build plan
 * §5 "T1").
 *
 * Six things: the **kind backfill** (the migration's own SQL, run over fixture
 * rows — see its test for why that is enough); the two uniqueness rules; each
 * capability's half (a designer keeps the types and not the scope, sales the
 * reverse, and nobody else writes either); replace-all's atomicity; the type
 * lifecycle (deactivate, reorder — and no delete); and that every path which
 * *creates* a scope item after the migration sets its kind and agreement.
 */

let f: Fixture;
const staff: Record<string, User> = {};

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

// ---- documents --------------------------------------------------------------

const TYPES = `query($activeOnly: Boolean){ templateTypes(activeOnly: $activeOnly) {
  id slug labelFa labelEn position active items { key kind labelFa labelEn position } } }`;
const CREATE = `mutation($slug: String!, $fa: String!, $en: String!){
  createTemplateType(slug: $slug, labelFa: $fa, labelEn: $en) { id slug position active items { key } } }`;
const UPDATE = `mutation($id: ID!, $slug: String, $fa: String, $en: String, $active: Boolean){
  updateTemplateType(id: $id, slug: $slug, labelFa: $fa, labelEn: $en, active: $active) { id slug labelFa labelEn active } }`;
const REORDER = `mutation($ids: [ID!]!){ reorderTemplateTypes(ids: $ids) { id position } }`;
const SET_SCOPE = `mutation($typeId: ID!, $items: [TemplateScopeItemInput!]!){
  setTemplateScope(typeId: $typeId, items: $items) { id items { key kind labelFa labelEn position } } }`;

type Item = { key: string; kind: string; labelFa: string; labelEn: string };
const item = (key: string, kind = 'PAGE', over: Partial<Item> = {}): Item => ({
  key,
  kind,
  labelFa: `فارسی ${key}`,
  labelEn: `English ${key}`,
  ...over,
});

async function makeType(slug: string, position = 0) {
  return prisma.templateType.create({ data: { slug, labelFa: `نوع ${slug}`, labelEn: `Type ${slug}`, position } });
}

async function keysOf(typeId: string): Promise<string[]> {
  const rows = await prisma.templateScopeItem.findMany({ where: { typeId }, orderBy: { position: 'asc' } });
  return rows.map((r) => r.key);
}

// ---- the backfill -------------------------------------------------------------

/**
 * The backfill cannot run on pre-migration rows inside this harness — the test
 * database is migrated before any test starts, so by the time there are rows
 * the column is already required and filled. What *can* be run is the
 * migration's own text: this takes the block between its `BACKFILL` markers,
 * and inside one transaction — which Postgres lets roll back DDL — un-does the
 * migration's effect (drops NOT NULL, blanks `kind` and `contractId`), runs the
 * migration's statements verbatim over fixture rows, reads the result, and
 * rolls everything back. So what is proven is the SQL that ships, not a copy of
 * it. (A unit test separately pins the block's page list to `PAGES`.)
 */
async function runBackfillOverFixture() {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20260929130000_t1_templates/migration.sql', import.meta.url)),
    'utf8',
  );
  const block = sql.slice(sql.indexOf('-- BACKFILL:BEGIN'), sql.indexOf('-- BACKFILL:END'));
  // Comments first — one of them contains a semicolon.
  const statements = block
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 2, 'the backfill is a kind update and a contract update');

  const rolledBack = new Error('roll back the un-migrated fixture');
  let rows: Array<{ key: string; kind: string | null; contractId: string | null; projectId: string }> = [];
  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "ScopeItem" ALTER COLUMN "kind" DROP NOT NULL');
      await tx.$executeRawUnsafe('UPDATE "ScopeItem" SET "kind" = NULL, "contractId" = NULL');
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      rows = await tx.$queryRawUnsafe(
        'SELECT "key", "kind"::text AS "kind", "contractId", "projectId" FROM "ScopeItem" ORDER BY "key"',
      );
      throw rolledBack;
    })
    .catch((err) => {
      if (err !== rolledBack) throw err;
    });
  return rows;
}

test('the kind backfill: checklist.* is EXTRA, the PAGES keys PAGE, everything else FEATURE', async () => {
  const projectId = f.contract.projectId;
  const keys = ['checklist.auth', 'checklist.hosting', 'home', 'about', 'contracts', 'portal', 'bilingual', 'sms-auth', 'landing'];
  await prisma.scopeItem.createMany({
    data: keys.map((key, position) => ({ projectId, key, kind: 'FEATURE' as const, labelFa: key, labelEn: key, position })),
  });

  const rows = await runBackfillOverFixture();
  const kindOf = Object.fromEntries(rows.map((r) => [r.key, r.kind]));
  assert.deepEqual(kindOf, {
    'checklist.auth': 'EXTRA',
    'checklist.hosting': 'EXTRA',
    home: 'PAGE',
    about: 'PAGE',
    contracts: 'PAGE',
    portal: 'PAGE',
    bilingual: 'FEATURE',
    'sms-auth': 'FEATURE',
    landing: 'FEATURE',
  });
  assert.ok(rows.every((r) => r.kind !== null), 'no row is left without a kind');

  // …and the rollback was real: the migrated column is required again.
  const after = await prisma.scopeItem.findMany();
  assert.equal(after.length, keys.length);
  assert.ok(after.every((r) => r.kind === 'FEATURE'), 'the transaction rolled back');
});

test('the contract backfill: every row gets its project\'s first contract, matching primaryContractId', async () => {
  const projectId = f.contract.projectId;
  // A second, *earlier* contract on the same project, created after the
  // fixture's — so "first" means createdAt, not insertion order or id.
  const earlier = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-000',
      titleFa: 'قدیمی',
      titleEn: 'Older',
      customerId: f.customer.id,
      projectId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  // A project with no contract at all, and a second customer's project.
  const orphan = await prisma.project.create({
    data: { customerId: f.stranger.id, titleFa: 'بی‌قرارداد', titleEn: 'No contract' },
  });
  await prisma.scopeItem.createMany({
    data: [
      { projectId, key: 'checklist.auth', kind: 'EXTRA', labelFa: 'ا', labelEn: 'a', status: 'DECLINED' },
      { projectId, key: 'bilingual', kind: 'FEATURE', labelFa: 'ب', labelEn: 'b', status: 'AGREED' },
      { projectId, key: 'proposed-thing', kind: 'FEATURE', labelFa: 'پ', labelEn: 'p', status: 'PROPOSED' },
      { projectId: orphan.id, key: 'lonely', kind: 'FEATURE', labelFa: 'ت', labelEn: 't' },
    ],
  });

  assert.equal(await primaryContractId(projectId), earlier.id, 'fixture sanity: primaryContractId picks the earlier one');
  const rows = await runBackfillOverFixture();
  for (const row of rows.filter((r) => r.projectId === projectId)) {
    assert.equal(row.contractId, earlier.id, `${row.key} (EXTRA and PROPOSED rows too)`);
  }
  const lonely = rows.find((r) => r.key === 'lonely')!;
  assert.equal(lonely.contractId, null, 'a project with no contract leaves the column NULL');
});

test('the column has no default: an insert that names no kind is refused by the database', async () => {
  await assert.rejects(
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "ScopeItem" ("id", "projectId", "key", "labelFa", "labelEn") VALUES ('x', '${f.contract.projectId}', 'k', 'ا', 'a')`,
      ),
    // SQLSTATE 23502, not_null_violation — the message names the row, not the column.
    /23502/,
  );
});

// ---- uniqueness -----------------------------------------------------------------

test('slug uniqueness: a duplicate is TEMPLATE_SLUG_TAKEN on create and on update, never a leaked unique violation', async () => {
  const made = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'store', fa: 'فروشگاه', en: 'Store' } }));
  assert.equal((made.createTemplateType as { slug: string }).slug, 'store');

  const dup = await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'store', fa: 'دیگر', en: 'Other' } });
  assert.equal(dup.code, 'TEMPLATE_SLUG_TAKEN');

  const blog = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'blog', fa: 'وبلاگ', en: 'Blog' } }));
  const id = (blog.createTemplateType as { id: string }).id;
  const clash = await exec(UPDATE, { as: staff.DESIGNER, variables: { id, slug: 'store' } });
  assert.equal(clash.code, 'TEMPLATE_SLUG_TAKEN');
  // Renaming to its own slug is not a clash.
  ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id, slug: 'blog', fa: 'وبلاگِ من' } }));

  // The constraint itself, around the resolver.
  await assert.rejects(() => makeType('store'), /Unique constraint/);
});

test('slug shape: Latin lowercase words only', async () => {
  for (const slug of ['Store', 'فروشگاه', 'a b', 'a--b', '']) {
    const r = await exec(CREATE, { as: staff.DESIGNER, variables: { slug, fa: 'ا', en: 'a' } });
    assert.equal(r.code, 'INVALID_SLUG', JSON.stringify(slug));
  }
  const noLabel = await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'ok', fa: '  ', en: 'x' } });
  assert.equal(noLabel.code, 'LABEL_REQUIRED');
  assert.equal(await prisma.templateType.count(), 0, 'nothing was created by a refusal');
});

test('key uniqueness: a repeated key in one list is DUPLICATE_TEMPLATE_KEY, and the constraint backs it', async () => {
  const type = await makeType('store');
  const r = await exec(SET_SCOPE, {
    as: staff.SALES,
    variables: { typeId: type.id, items: [item('home'), item('cart', 'FEATURE'), item('home', 'FEATURE')] },
  });
  assert.equal(r.code, 'DUPLICATE_TEMPLATE_KEY');

  // The same key under two *different* types is fine — the scope is (type, key).
  const other = await makeType('blog');
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('home')] } }));
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: other.id, items: [item('home')] } }));

  await assert.rejects(
    () => prisma.templateScopeItem.create({ data: { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'ا', labelEn: 'a' } }),
    /Unique constraint/,
  );
});

test('a template key must be Latin and can never enter the checklist namespace', async () => {
  const type = await makeType('store');
  for (const key of ['checklist.auth', 'Home', 'صفحه', 'a_b']) {
    const r = await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item(key)] } });
    assert.equal(r.code, 'INVALID_KEY', key);
  }
});

test('TemplateScopeItem_kind_not_extra: refused by the resolver, and by the database on a direct insert', async () => {
  const type = await makeType('store');
  const r = await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('x', 'EXTRA')] } });
  assert.equal(r.code, 'INVALID_TEMPLATE_KIND');

  await assert.rejects(
    () => prisma.templateScopeItem.create({ data: { typeId: type.id, key: 'x', kind: 'EXTRA', labelFa: 'ا', labelEn: 'a' } }),
    /TemplateScopeItem_kind_not_extra|check constraint/i,
  );
});

// ---- the capability halves ----------------------------------------------------------

type Actor = 'ADMIN' | 'SALES' | 'DESIGNER' | 'DEVELOPER' | 'CONTRIBUTOR' | 'REVIEWER' | 'CUSTOMER';
const actor = (name: Actor): User => (name === 'ADMIN' ? f.admin : name === 'CUSTOMER' ? f.customer : staff[name]);

test('each capability owns its half: types are the designer\'s, scope is sales\', admin holds both, no one else writes', async () => {
  const type = await makeType('store');
  // [who, may edit types, may edit scope]
  const table: Array<[Actor, boolean, boolean]> = [
    ['ADMIN', true, true],
    ['DESIGNER', true, false],
    ['SALES', false, true],
    ['DEVELOPER', false, false],
    ['CONTRIBUTOR', false, false],
    ['REVIEWER', false, false],
    ['CUSTOMER', false, false],
  ];
  let n = 0;
  for (const [who, typesOk, scopeOk] of table) {
    const as = actor(who);
    n += 1;
    const created = await exec(CREATE, { as, variables: { slug: `t-${n}`, fa: 'ا', en: 'a' } });
    assert.equal(created.code, typesOk ? undefined : 'FORBIDDEN', `${who} createTemplateType`);
    const updated = await exec(UPDATE, { as, variables: { id: type.id, active: true } });
    assert.equal(updated.code, typesOk ? undefined : 'FORBIDDEN', `${who} updateTemplateType`);
    const all = (await prisma.templateType.findMany()).map((t) => t.id);
    const reordered = await exec(REORDER, { as, variables: { ids: all } });
    assert.equal(reordered.code, typesOk ? undefined : 'FORBIDDEN', `${who} reorderTemplateTypes`);
    const scoped = await exec(SET_SCOPE, { as, variables: { typeId: type.id, items: [item(`k-${n}`)] } });
    assert.equal(scoped.code, scopeOk ? undefined : 'FORBIDDEN', `${who} setTemplateScope`);
  }
});

test('FORBIDDEN comes before NOT_FOUND: a refused writer learns nothing about which ids exist', async () => {
  const r = await exec(SET_SCOPE, { as: staff.DESIGNER, variables: { typeId: 'no-such-type', items: [] } });
  assert.equal(r.code, 'FORBIDDEN');
  const u = await exec(UPDATE, { as: staff.SALES, variables: { id: 'no-such-type', active: false } });
  assert.equal(u.code, 'FORBIDDEN');
});

test('reading: either capability opens the types; developers, contributors, reviewers, customers and the anonymous do not', async () => {
  await makeType('store');
  for (const who of ['ADMIN', 'SALES', 'DESIGNER'] as Actor[]) {
    const data = ok(await exec(TYPES, { as: actor(who) })) as { templateTypes: unknown[] };
    assert.equal(data.templateTypes.length, 1, who);
  }
  for (const who of ['DEVELOPER', 'CONTRIBUTOR', 'REVIEWER', 'CUSTOMER'] as Actor[]) {
    assert.equal((await exec(TYPES, { as: actor(who) })).code, 'FORBIDDEN', who);
  }
  assert.equal((await exec(TYPES, { as: null })).code, 'UNAUTHENTICATED');
});

// ---- replace-all ----------------------------------------------------------------------

test('setTemplateScope replaces the whole list, in the order given, and touches no other type', async () => {
  const store = await makeType('store');
  const blog = await makeType('blog', 1);
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: blog.id, items: [item('archive')] } }));
  ok(
    await exec(SET_SCOPE, {
      as: staff.SALES,
      variables: { typeId: store.id, items: [item('home'), item('cart', 'FEATURE'), item('invoice', 'DELIVERABLE')] },
    }),
  );
  assert.deepEqual(await keysOf(store.id), ['home', 'cart', 'invoice']);

  const replaced = ok(
    await exec(SET_SCOPE, {
      as: staff.SALES,
      variables: { typeId: store.id, items: [item('checkout', 'PAGE', { labelFa: '  پرداخت  ' }), item('home')] },
    }),
  ) as { setTemplateScope: { items: Array<{ key: string; position: number; labelFa: string }> } };
  assert.deepEqual(
    replaced.setTemplateScope.items.map((i) => [i.key, i.position]),
    [['checkout', 0], ['home', 1]],
  );
  assert.equal(replaced.setTemplateScope.items[0].labelFa, 'پرداخت', 'labels are trimmed');
  assert.deepEqual(await keysOf(store.id), ['checkout', 'home']);
  assert.deepEqual(await keysOf(blog.id), ['archive'], 'another type\'s list is untouched');

  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: store.id, items: [] } }));
  assert.deepEqual(await keysOf(store.id), [], 'an empty list clears the type');
});

test('an unknown typeId is NOT_FOUND', async () => {
  const r = await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: 'no-such-type', items: [item('a')] } });
  assert.equal(r.code, 'NOT_FOUND');
});

test('a refused input leaves the old list exactly as it was', async () => {
  const type = await makeType('store');
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('home'), item('cart', 'FEATURE')] } }));
  const before = await prisma.templateScopeItem.findMany({ where: { typeId: type.id }, orderBy: { position: 'asc' } });

  const refused: Array<[string, Item[]]> = [
    ['DUPLICATE_TEMPLATE_KEY', [item('new'), item('new')]],
    ['INVALID_KEY', [item('new'), item('Bad Key')]],
    ['INVALID_TEMPLATE_KIND', [item('new'), item('x', 'EXTRA')]],
    ['LABEL_REQUIRED', [item('new'), item('y', 'PAGE', { labelEn: ' ' })]],
  ];
  for (const [code, items] of refused) {
    const r = await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items } });
    assert.equal(r.code, code);
    assert.deepEqual(
      await prisma.templateScopeItem.findMany({ where: { typeId: type.id }, orderBy: { position: 'asc' } }),
      before,
      `after ${code}`,
    );
  }
});

test('a failure the checks cannot foresee rolls the delete back with it', async () => {
  const type = await makeType('store');
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('home'), item('cart', 'FEATURE')] } }));
  const before = await prisma.templateScopeItem.findMany({ where: { typeId: type.id }, orderBy: { position: 'asc' } });

  // A NUL byte is well-formed as far as the input rules go — a non-empty label
  // — and Postgres refuses it in text. It fails *after* the transaction has
  // deleted the old rows and started inserting the new ones, which is exactly
  // the window a non-atomic replace would leave the type empty in.
  const r = await exec(SET_SCOPE, {
    as: staff.SALES,
    variables: { typeId: type.id, items: [item('fresh'), item('poisoned', 'PAGE', { labelEn: 'a\u0000b' })] },
  });
  assert.ok(r.errors.length > 0, 'the write failed');
  assert.deepEqual(
    await prisma.templateScopeItem.findMany({ where: { typeId: type.id }, orderBy: { position: 'asc' } }),
    before,
    'the old list survived intact',
  );
});

test('concurrent replaces serialise: both succeed and the last writer\'s list stands, whole', async () => {
  const type = await makeType('store');
  const a = exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('a1'), item('a2'), item('a3')] } });
  const b = exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('b1'), item('b2')] } });
  const [ra, rb] = await Promise.all([a, b]);
  ok(ra);
  ok(rb);
  const keys = await keysOf(type.id);
  assert.ok(
    JSON.stringify(keys) === JSON.stringify(['a1', 'a2', 'a3']) || JSON.stringify(keys) === JSON.stringify(['b1', 'b2']),
    `never a mixture: ${keys.join(',')}`,
  );
});

// ---- the type lifecycle ------------------------------------------------------------------

test('a type is deactivated, not deleted: it leaves the picker and keeps its scope', async () => {
  const type = await makeType('store');
  ok(await exec(SET_SCOPE, { as: staff.SALES, variables: { typeId: type.id, items: [item('home')] } }));
  ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id: type.id, active: false } }));

  const picker = ok(await exec(TYPES, { as: staff.SALES, variables: { activeOnly: true } })) as { templateTypes: unknown[] };
  assert.equal(picker.templateTypes.length, 0);
  const desk = ok(await exec(TYPES, { as: staff.SALES })) as {
    templateTypes: Array<{ active: boolean; items: unknown[] }>;
  };
  assert.equal(desk.templateTypes.length, 1);
  assert.equal(desk.templateTypes[0].active, false);
  assert.equal(desk.templateTypes[0].items.length, 1);

  // And there is no delete on the surface to reach for.
  const sdl = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(sdl, /deleteTemplate/);
});

test('updateTemplateType leaves omitted fields alone and refuses an unknown id and a blank label', async () => {
  const type = await makeType('store');
  const r = ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id: type.id, en: 'Shop' } })) as {
    updateTemplateType: { slug: string; labelFa: string; labelEn: string; active: boolean };
  };
  assert.deepEqual(r.updateTemplateType, { id: type.id, slug: 'store', labelFa: 'نوع store', labelEn: 'Shop', active: true });
  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: 'nope', en: 'x' } })).code, 'NOT_FOUND');
  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: type.id, fa: ' ' } })).code, 'LABEL_REQUIRED');
  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: type.id, slug: 'Bad' } })).code, 'INVALID_SLUG');
});

test('new types go last, and reorderTemplateTypes takes the whole order or refuses', async () => {
  const a = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'a', fa: 'ا', en: 'A' } })) as {
    createTemplateType: { id: string; position: number };
  };
  const b = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'b', fa: 'ب', en: 'B' } })) as {
    createTemplateType: { id: string; position: number };
  };
  const c = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { slug: 'c', fa: 'پ', en: 'C' } })) as {
    createTemplateType: { id: string; position: number };
  };
  const [ia, ib, ic] = [a, b, c].map((x) => x.createTemplateType.id);
  assert.deepEqual([a, b, c].map((x) => x.createTemplateType.position), [0, 1, 2]);

  const reordered = ok(await exec(REORDER, { as: staff.DESIGNER, variables: { ids: [ic, ia, ib] } })) as {
    reorderTemplateTypes: Array<{ id: string; position: number }>;
  };
  assert.deepEqual(reordered.reorderTemplateTypes.map((t) => t.id), [ic, ia, ib]);
  const listed = ok(await exec(TYPES, { as: staff.SALES })) as { templateTypes: Array<{ slug: string }> };
  assert.deepEqual(listed.templateTypes.map((t) => t.slug), ['c', 'a', 'b']);

  for (const ids of [[ia, ib], [ia, ib, ic, ic], [ia, ib, 'nope'], [ia, ia, ib]]) {
    assert.equal((await exec(REORDER, { as: staff.DESIGNER, variables: { ids } })).code, 'REORDER_MISMATCH', ids.join());
  }
  const still = ok(await exec(TYPES, { as: staff.SALES })) as { templateTypes: Array<{ slug: string }> };
  assert.deepEqual(still.templateTypes.map((t) => t.slug), ['c', 'a', 'b'], 'a refused order changes nothing');
});

// ---- every creator sets its kind --------------------------------------------------------------

test('createContract: the checklist is EXTRA and names the contract that created it', async () => {
  const m = `mutation($i: CreateContractInput!){ createContract(input: $i) { id } }`;
  const made = ok(
    await exec(m, {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-T1-1', titleFa: 'ت', titleEn: 'T' } },
    }),
  ) as { createContract: { id: string } };
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: made.createContract.id } });
  const rows = await prisma.scopeItem.findMany({ where: { projectId: contract.projectId } });
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.kind === 'EXTRA' && r.contractId === contract.id));
});

test('applyContractTemplate: each row is classified by its key and agreed by this contract', async () => {
  // The fixture's three articles make the template refuse (v2.test.ts asserts
  // that); clear them, since this test is about what it writes.
  await prisma.article.deleteMany({ where: { contractId: f.contract.id } });
  const before = await prisma.scopeItem.count({ where: { projectId: f.contract.projectId } });
  assert.equal(before, 0);
  ok(await exec(`mutation($id: ID!){ applyContractTemplate(contractId: $id) { id } }`, { as: staff.SALES, variables: { id: f.contract.id } }));
  const rows = await prisma.scopeItem.findMany({ where: { projectId: f.contract.projectId }, orderBy: { position: 'asc' } });
  assert.deepEqual(
    rows.map((r) => [r.key, r.kind]),
    [
      ['bilingual', 'FEATURE'],
      ['landing', 'FEATURE'],
      ['about', 'PAGE'],
      ['portal', 'PAGE'],
      ['contracts', 'PAGE'],
      ['tracking', 'FEATURE'],
    ],
  );
  assert.ok(rows.every((r) => r.contractId === f.contract.id && r.status === 'AGREED'));
});

test('addScopeItem: an explicit kind wins, otherwise the key decides; either way the contract is named', async () => {
  const m = `mutation($c: ID!, $k: String!, $kind: ScopeKind){ addScopeItem(contractId: $c, key: $k, labelFa: "ا", labelEn: "a", kind: $kind) { id } }`;
  ok(await exec(m, { as: staff.SALES, variables: { c: f.contract.id, k: 'home' } }));
  ok(await exec(m, { as: staff.SALES, variables: { c: f.contract.id, k: 'cart' } }));
  ok(await exec(m, { as: staff.SALES, variables: { c: f.contract.id, k: 'handover-doc', kind: 'DELIVERABLE' } }));
  ok(await exec(m, { as: staff.SALES, variables: { c: f.contract.id, k: 'faq', kind: 'PAGE' } }));
  const rows = await prisma.scopeItem.findMany({ where: { projectId: f.contract.projectId }, orderBy: { position: 'asc' } });
  assert.deepEqual(
    rows.map((r) => [r.key, r.kind]),
    [['home', 'PAGE'], ['cart', 'FEATURE'], ['handover-doc', 'DELIVERABLE'], ['faq', 'PAGE']],
  );
  assert.ok(rows.every((r) => r.contractId === f.contract.id));
});

test('a scope trade: the incoming item is classified when proposed and agreed by the contract when executed', async () => {
  const projectId = f.contract.projectId;
  const out = await prisma.scopeItem.create({
    data: { projectId, key: 'old-feature', kind: 'FEATURE', labelFa: 'ا', labelEn: 'a', status: 'AGREED', contractId: f.contract.id },
  });
  ok(
    await exec(
      `mutation($p: ID!, $o: ID!){ proposeScopeTrade(projectId: $p, outItemId: $o, inKey: "about", inLabelFa: "ب", inLabelEn: "b") { id } }`,
      { as: staff.SALES, variables: { p: projectId, o: out.id } },
    ),
  );
  const incoming = await prisma.scopeItem.findUniqueOrThrow({ where: { projectId_key: { projectId, key: 'about' } } });
  assert.equal(incoming.kind, 'PAGE');
  assert.equal(incoming.status, 'PROPOSED');
  assert.equal(incoming.contractId, null, 'nothing has agreed it yet');

  const trade = await prisma.scopeTrade.findUniqueOrThrow({ where: { outItemId: out.id } });
  ok(await exec(`mutation($t: ID!){ confirmScopeTradeRoot(tradeId: $t) { id } }`, { as: staff.SALES, variables: { t: trade.id } }));
  // The customer's confirmation has no mutation yet (L1's documented TODO).
  await prisma.scopeTrade.update({ where: { id: trade.id }, data: { customerConfirmedAt: new Date() } });
  ok(await exec(`mutation($t: ID!){ executeScopeTrade(tradeId: $t) { id } }`, { as: staff.SALES, variables: { t: trade.id } }));

  const agreed = await prisma.scopeItem.findUniqueOrThrow({ where: { id: incoming.id } });
  assert.equal(agreed.status, 'AGREED');
  assert.equal(agreed.contractId, f.contract.id);
});

test('ScopeItem exposes kind and contractId', async () => {
  const projectId = f.contract.projectId;
  await prisma.scopeItem.create({
    data: { projectId, key: 'home', kind: 'PAGE', labelFa: 'ا', labelEn: 'a', status: 'AGREED', contractId: f.contract.id },
  });
  const r = ok(
    await exec(`query($id: ID!){ contract(id: $id) { project { scopeItems { key kind contractId } } } }`, {
      as: f.admin,
      variables: { id: f.contract.id },
    }),
  ) as { contract: { project: { scopeItems: Array<{ key: string; kind: string; contractId: string }> } } };
  assert.deepEqual(r.contract.project.scopeItems, [{ key: 'home', kind: 'PAGE', contractId: f.contract.id }]);
});
