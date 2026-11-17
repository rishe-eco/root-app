import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { jalaliYear } from '../lib/contractRef.js';

/**
 * DX3b — the generated reference (desk UX review item 1): `createContract`
 * with no ref numbers it `R-<year>-001`, `-002`; a typed one still works and
 * is checked; `updateContractRef` until anything is signed; `nextContractRef`
 * is `contracts.author` and nothing else.
 */

let f: Fixture;
let sales: User;
let designer: User;
const YEAR = jalaliYear(new Date());

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  sales = await prisma.user.create({
    data: { email: 'sales@test.local', phone: '+989120000102', name: 'Sales', roles: ['SALES'], state: 'ACTIVE' },
  });
  designer = await prisma.user.create({
    data: { email: 'design@test.local', phone: '+989120000103', name: 'Designer', roles: ['DESIGNER'], state: 'ACTIVE' },
  });
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const CREATE = `mutation($i: CreateContractInput!){ createContract(input: $i) { id ref } }`;
const NEXT = `query { nextContractRef }`;
const UPDATE = `mutation($c: ID!, $r: String!){ updateContractRef(contractId: $c, ref: $r) { id ref } }`;
const make = (extra: Record<string, unknown> = {}) =>
  exec(CREATE, { as: sales, variables: { i: { customerId: f.customer.id, titleFa: 'ق', titleEn: 'C', ...extra } } });

test('no ref: numbered R-<year>-001, then -002; the prefill says what is next', async () => {
  assert.equal(ok(await exec(NEXT, { as: sales })).nextContractRef, `R-${YEAR}-001`);
  const a = ok(await make()).createContract as { ref: string };
  const b = ok(await make({ ref: '   ' })).createContract as { ref: string };
  assert.equal(a.ref, `R-${YEAR}-001`);
  assert.equal(b.ref, `R-${YEAR}-002`, 'a blank ref is no ref');
  assert.equal(ok(await exec(NEXT, { as: sales })).nextContractRef, `R-${YEAR}-003`);
});

test('two creations at once get two numbers', async () => {
  const both = await Promise.all([make(), make(), make()]);
  const refs = both.map((r) => (ok(r).createContract as { ref: string }).ref).sort();
  assert.deepEqual(refs, [`R-${YEAR}-001`, `R-${YEAR}-002`, `R-${YEAR}-003`]);
});

test('a typed ref still works; an old-style one does not disturb the numbering; clashes and junk are refused', async () => {
  assert.equal((ok(await make({ ref: ' RC-2026-014 ' })).createContract as { ref: string }).ref, 'RC-2026-014');
  assert.equal((ok(await make()).createContract as { ref: string }).ref, `R-${YEAR}-001`);
  assert.equal((await make({ ref: 'RC-2026-014' })).code, 'REF_TAKEN');
  assert.equal((await make({ ref: 'has space' })).code, 'REF_INVALID');
  assert.equal((await make({ ref: 'x'.repeat(41) })).code, 'REF_INVALID');
  assert.equal((await make({ ref: 'شماره' })).code, 'REF_INVALID');
});

test('a typed R-<year>-n counts for the next number', async () => {
  ok(await make({ ref: `R-${YEAR}-041` }));
  assert.equal((ok(await make()).createContract as { ref: string }).ref, `R-${YEAR}-042`);
});

test('updateContractRef: trims, changes, refuses a duplicate and a bad shape', async () => {
  const c = ok(await make()).createContract as { id: string };
  const r = ok(await exec(UPDATE, { as: sales, variables: { c: c.id, r: '  RC-2026-020 ' } })).updateContractRef as { ref: string };
  assert.equal(r.ref, 'RC-2026-020');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).ref, 'RC-2026-020');
  assert.equal((await exec(UPDATE, { as: sales, variables: { c: c.id, r: f.contract.ref } })).code, 'REF_TAKEN');
  assert.equal((await exec(UPDATE, { as: sales, variables: { c: c.id, r: '' } })).code, 'REF_INVALID');
  assert.equal((await exec(UPDATE, { as: sales, variables: { c: c.id, r: 'a b' } })).code, 'REF_INVALID');
  assert.equal((await exec(UPDATE, { as: sales, variables: { c: 'nope', r: 'OK-1' } })).code, 'NOT_FOUND');
  // Unchanged is a no-op, not a clash with itself.
  ok(await exec(UPDATE, { as: sales, variables: { c: c.id, r: 'RC-2026-020' } }));
});

test('updateContractRef: CONTRACT_SIGNED once a revision is signed', async () => {
  const revision = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id } });
  ok(await exec(UPDATE, { as: sales, variables: { c: f.contract.id, r: 'BEFORE-SIGN' } }));
  await prisma.signature.create({
    data: { contractRevisionId: revision.id, signerId: f.customer.id, typedName: 'Nahal', signedHash: revision.contentHash },
  });
  assert.equal((await exec(UPDATE, { as: sales, variables: { c: f.contract.id, r: 'AFTER-SIGN' } })).code, 'CONTRACT_SIGNED');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).ref, 'BEFORE-SIGN');
});

test('nextContractRef and updateContractRef are contracts.author: a designer and a customer are refused', async () => {
  for (const as of [designer, f.customer]) {
    assert.equal((await exec(NEXT, { as })).code, 'FORBIDDEN');
    assert.equal((await exec(UPDATE, { as, variables: { c: f.contract.id, r: 'NOPE-1' } })).code, 'FORBIDDEN');
  }
  assert.equal((await exec(NEXT, {})).code, 'UNAUTHENTICATED');
});
