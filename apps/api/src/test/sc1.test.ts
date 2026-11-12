import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * SC1 — Root adds pages, features and deliverables straight into step 2a.
 *
 * `addScopeItem` without a key takes the next `custom.<n>`; its refusals
 * (`LABEL_REQUIRED`, `INVALID_KEY`, `KEY_TAKEN`, a customer's `FORBIDDEN`); an
 * item added by hand never makes the site type's template unreachable, and
 * `Contract.scopeTemplateApplied` says exactly when `applyScopeTemplate` would
 * refuse; `deleteScopeItem` refuses an item a note or a proposal points at
 * (`ITEM_IN_USE`) rather than cascading the customer's words away.
 */

let f: Fixture;
let sales: User;
let type: { id: string };

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  sales = await prisma.user.create({
    data: { email: 'sales@test.local', phone: '+989120000102', name: 'Sales', roles: ['SALES'], state: 'ACTIVE' },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  for (const [i, [key, kind, fa, en]] of (
    [
      ['home', 'PAGE', 'صفحه‌ی اصلی', 'Home page'],
      ['checkout', 'FEATURE', 'پرداخت', 'Checkout'],
    ] as const
  ).entries()) {
    await prisma.templateScopeItem.create({ data: { typeId: type.id, key, kind, labelFa: fa, labelEn: en, position: i } });
  }
  await prisma.contractBrief.create({
    data: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK' },
  });
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const CONTRACT = `id scopeTemplateApplied scopeItems { id key kind status contractId labelFa labelEn }`;
const ADD = `mutation($c: ID!, $k: String, $fa: String!, $en: String!, $kind: ScopeKind){
  addScopeItem(contractId: $c, key: $k, labelFa: $fa, labelEn: $en, kind: $kind) { ${CONTRACT} } }`;
const SEED = `mutation($c: ID!){ applyScopeTemplate(contractId: $c) { ${CONTRACT} } }`;
const READ = `query($c: ID!){ contract(id: $c) { ${CONTRACT} } }`;
const DELETE = `mutation($s: ID!, $c: ID){ deleteScopeItem(scopeItemId: $s, contractId: $c) { ${CONTRACT} } }`;

type Item = { id: string; key: string; kind: string; status: string; contractId: string | null; labelFa: string; labelEn: string };
type Contract = { id: string; scopeTemplateApplied: boolean; scopeItems: Item[] };

const add = (over: Record<string, unknown> = {}, as: User = sales) =>
  exec(ADD, { as, variables: { c: f.contract.id, fa: 'وبلاگ', en: 'Blog', kind: 'PAGE', ...over } });
const own = (c: Contract) => c.scopeItems.filter((i) => i.contractId === f.contract.id && i.kind !== 'EXTRA');

test('without a key an item takes the next custom.<n>, agreed, of this contract, labels trimmed, kind as asked', async () => {
  ok(await add({ fa: '  وبلاگ ', en: ' Blog  ' }));
  const second = ok(await add({ fa: 'جست‌وجو', en: 'Search', kind: 'FEATURE' })).addScopeItem as Contract;
  assert.deepEqual(
    own(second).map((i) => [i.key, i.kind, i.status, i.labelFa, i.labelEn]),
    [
      ['custom.1', 'PAGE', 'AGREED', 'وبلاگ', 'Blog'],
      ['custom.2', 'FEATURE', 'AGREED', 'جست‌وجو', 'Search'],
    ],
  );
});

test('refusals: both labels, a valid typed key, a key not already on the project, staff only', async () => {
  assert.equal((await add({ fa: '   ' })).code, 'LABEL_REQUIRED');
  assert.equal((await add({ en: '' })).code, 'LABEL_REQUIRED');
  assert.equal((await add({ k: 'Not A Key' })).code, 'INVALID_KEY');
  assert.equal((await add({ k: 'checklist.hosting' })).code, 'INVALID_KEY');
  ok(await add({ k: 'blog' }));
  assert.equal((await add({ k: 'blog' })).code, 'KEY_TAKEN');
  assert.equal((await add({}, f.customer)).code, 'FORBIDDEN');
  assert.equal(await prisma.scopeItem.count({ where: { contractId: f.contract.id, kind: { not: 'EXTRA' } } }), 1);
});

test('an item added first leaves the template reachable; once applied, scopeTemplateApplied turns and a second apply refuses', async () => {
  const before = ok(await exec(READ, { as: sales, variables: { c: f.contract.id } })).contract as Contract;
  assert.equal(before.scopeTemplateApplied, false);

  const added = ok(await add()).addScopeItem as Contract;
  assert.equal(added.scopeTemplateApplied, false, 'a hand-added item is not the template');

  const seeded = ok(await exec(SEED, { as: sales, variables: { c: f.contract.id } })).applyScopeTemplate as Contract;
  assert.equal(seeded.scopeTemplateApplied, true);
  assert.deepEqual(own(seeded).map((i) => i.key).sort(), ['checkout', 'custom.1', 'home']);

  assert.equal((await exec(SEED, { as: sales, variables: { c: f.contract.id } })).code, 'SCOPE_ALREADY_SEEDED');
  // Adding after seeding still works, and does not disturb the template's rows.
  const after = ok(await add({ fa: 'تماس', en: 'Contact' })).addScopeItem as Contract;
  assert.deepEqual(own(after).map((i) => i.key).sort(), ['checkout', 'custom.1', 'custom.2', 'home']);
});

test('the template stays unapplied for a contract with no brief', async () => {
  await prisma.contractBrief.delete({ where: { contractId: f.contract.id } });
  const read = ok(await exec(READ, { as: sales, variables: { c: f.contract.id } })).contract as Contract;
  assert.equal(read.scopeTemplateApplied, false);
});

test('deleteScopeItem: an untouched item goes; one a note or a proposal points at is ITEM_IN_USE and stays', async () => {
  const added = ok(await add()).addScopeItem as Contract;
  ok(await add({ fa: 'تماس', en: 'Contact' }));
  const [blog] = own(added);
  const contact = (await prisma.scopeItem.findFirstOrThrow({ where: { contractId: f.contract.id, labelEn: 'Contact' } })).id;

  await prisma.feedbackItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'SCOPE', anchorScopeItemId: blog.id, status: 'OPEN' },
  });
  assert.equal((await exec(DELETE, { as: sales, variables: { s: blog.id, c: f.contract.id } })).code, 'ITEM_IN_USE');
  assert.equal(await prisma.feedbackItem.count({ where: { anchorScopeItemId: blog.id } }), 1, 'the note is still there');

  await prisma.scopeProposal.create({
    data: {
      contractId: f.contract.id,
      kind: 'REMOVE',
      scopeItemId: contact,
      text: 'لازم نیست',
      lang: 'fa',
      proposedById: f.customer.id,
    },
  });
  assert.equal((await exec(DELETE, { as: sales, variables: { s: contact, c: f.contract.id } })).code, 'ITEM_IN_USE');

  const third = ok(await add({ fa: 'سوالات', en: 'FAQ' })).addScopeItem as Contract;
  const faq = own(third).find((i) => i.labelEn === 'FAQ')!;
  const after = ok(await exec(DELETE, { as: sales, variables: { s: faq.id, c: f.contract.id } })).deleteScopeItem as Contract;
  assert.ok(!own(after).some((i) => i.id === faq.id));
});
