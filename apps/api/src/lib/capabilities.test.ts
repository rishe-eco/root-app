import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '@prisma/client';
import { CAPABILITIES, can, capabilitiesOf, requiresSecondFactor } from './capabilities.js';

const holding = (...roles: Role[]) => ({ roles });

test('a customer holds no capability at all', () => {
  const customer = holding('CUSTOMER');
  assert.deepEqual([...capabilitiesOf(customer)], []);
  for (const cap of CAPABILITIES) assert.equal(can(customer, cap), false);
});

test('an admin holds every capability, including ones added later', () => {
  const admin = holding('ADMIN');
  for (const cap of CAPABILITIES) assert.equal(can(admin, cap), true, cap);
});

test('a contributor writes the Library but does not publish or edit the tree', () => {
  // The Research Lab's own sentence — "the same editor minus publish and
  // tree-editing" — is what forced capabilities over a role ranking. If this
  // ever passes for all three, the table has quietly become a hierarchy.
  const contributor = holding('CONTRIBUTOR');
  assert.equal(can(contributor, 'library.write'), true);
  assert.equal(can(contributor, 'library.publish'), false);
  assert.equal(can(contributor, 'library.editTree'), false);
});

test('a reviewer reaches the Review Room and nothing else', () => {
  const reviewer = holding('REVIEWER');
  assert.deepEqual([...capabilitiesOf(reviewer)], ['review.participate']);
  assert.equal(can(reviewer, 'library.write'), false);
  assert.equal(can(reviewer, 'contracts.readActive'), false);
  assert.equal(can(reviewer, 'review.admin'), false);
});

test('two roles union, and neither one subtracts from the other', () => {
  // The case the whole change exists for. An outside specialist who both
  // reviews and contributes holds the sum of the two, and holding the second
  // role never costs them anything the first granted.
  const both = holding('REVIEWER', 'CONTRIBUTOR');
  assert.equal(can(both, 'review.participate'), true);
  assert.equal(can(both, 'library.write'), true);
  assert.equal(can(both, 'library.publish'), false);

  assert.deepEqual(
    [...capabilitiesOf(both)].sort(),
    ['library.write', 'review.participate'].sort(),
  );
});

test('order within the set does not change the answer', () => {
  const forwards = capabilitiesOf(holding('CONTRIBUTOR', 'REVIEWER'));
  const backwards = capabilitiesOf(holding('REVIEWER', 'CONTRIBUTOR'));
  assert.deepEqual([...forwards].sort(), [...backwards].sort());
});

test('a customer who is also staff keeps the staff capabilities', () => {
  // This is precisely what the old `user.role === 'ADMIN'` got wrong. Under a
  // set there is no single value to compare, and an equality check against
  // either member would have denied the other half of this person's work.
  const both = holding('CUSTOMER', 'ADMIN');
  for (const cap of CAPABILITIES) assert.equal(can(both, cap), true, cap);
});

test('the empty set grants nothing rather than throwing', () => {
  // The database forbids this row (CHECK cardinality > 0). The guard should
  // still fail closed if one ever appears, not crash the request.
  const nobody = { roles: [] as Role[] };
  assert.deepEqual([...capabilitiesOf(nobody)], []);
  for (const cap of CAPABILITIES) assert.equal(can(nobody, cap), false);
});

/**
 * Journeys build plan S1 — the grant table as a literal, one row per role,
 * read against the code rather than restating it. `capabilities.ts` is where
 * the grants are *explained*; this is where a changed grant has to be
 * *meant*: widening a role is now two edits in two files, and the second one
 * is a table a reviewer can read at a glance.
 *
 * ADMIN is absent on purpose — it is `CAPABILITIES` by construction and has
 * its own test above. Every capability not listed for a role must be false
 * for it, which is what makes this a table rather than a list of spot checks.
 */
const EXPECTED: Record<Exclude<Role, 'ADMIN'>, readonly string[]> = {
  CUSTOMER: [],
  CONTRIBUTOR: ['library.write'],
  REVIEWER: ['review.participate'],
  DEVELOPER: [
    'contracts.readActive',
    'feedback.answer',
    'answers.direct.demo',
    'builds.author',
    'dependencies.verifyTechnical',
  ],
  SALES: [
    'contracts.readAll',
    'contracts.readActive',
    'contracts.author',
    'money.read',
    'customers.manage',
    'tickets.answer',
    'billing.manage',
    'feedback.answer',
    'feedback.approveAnswers',
    'answers.direct.agreement',
    'answers.direct.design',
    'answers.direct.mockup',
    'answers.direct.demo',
    'templates.scope',
    'dependencies.verifyGeneral',
  ],
  DESIGNER: [
    'contracts.readActive',
    'feedback.answer',
    'answers.direct.design',
    'answers.direct.mockup',
    'design.author',
    'templates.types',
  ],
};

for (const [role, expected] of Object.entries(EXPECTED) as Array<[Role, readonly string[]]>) {
  test(`the ${role} row of the grant table, every capability checked`, () => {
    for (const cap of CAPABILITIES) {
      assert.equal(can(holding(role), cap), expected.includes(cap), `${role} × ${cap}`);
    }
    // And nothing listed here that the table does not know about — a typo in
    // EXPECTED would otherwise pass as "correctly not granted".
    for (const cap of expected) assert.ok((CAPABILITIES as readonly string[]).includes(cap), cap);
  });
}

test('no staff role but ADMIN holds the two escape hatches', () => {
  // `assignments.override` and `staff.manage` are the rows whose blast
  // radius is other people's work and other people's accounts.
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(can(holding(role), 'assignments.override'), false, role);
    assert.equal(can(holding(role), 'staff.manage'), false, role);
  }
});

test('money is visible to exactly the roles that sell', () => {
  // PD-14 / journeys Q-S3: design and development never see what it costs.
  assert.equal(can(holding('DESIGNER'), 'money.read'), false);
  assert.equal(can(holding('DEVELOPER'), 'money.read'), false);
  assert.equal(can(holding('SALES'), 'money.read'), true);
});

/**
 * Journeys build plan J1, PD-20 — the second-factor table as a literal, the
 * same shape as the grant table above: one row per role, read against the
 * code rather than restated, so the set widening or narrowing later is a
 * one-line diff a reviewer sees rather than a fact only inferred from other
 * behaviour changing.
 */
const REQUIRES_SECOND_FACTOR: Record<Role, boolean> = {
  CUSTOMER: false,
  ADMIN: true,
  CONTRIBUTOR: false,
  REVIEWER: false,
  DEVELOPER: true,
  SALES: true,
  DESIGNER: true,
};

for (const [role, expected] of Object.entries(REQUIRES_SECOND_FACTOR) as Array<[Role, boolean]>) {
  test(`requiresSecondFactor(${role}) is ${expected}`, () => {
    assert.equal(requiresSecondFactor(holding(role)), expected);
  });
}

test('holding any second-factor role is enough, even alongside one that would not require it alone', () => {
  // Union, never subtraction — the same rule `can` already applies to
  // capabilities, applied here to the factor requirement itself.
  assert.equal(requiresSecondFactor(holding('CONTRIBUTOR', 'SALES')), true);
});

test('holding only non-factor roles never requires one, however many are held', () => {
  assert.equal(requiresSecondFactor(holding('CONTRIBUTOR', 'REVIEWER')), false);
});

test('the empty role set does not require a factor either — it fails closed the same way `can` does', () => {
  assert.equal(requiresSecondFactor({ roles: [] as Role[] }), false);
});

test('contracts.manage is gone, not aliased', () => {
  // S1 removed it. A leftover alias would be a verb no role is meant to hold,
  // silently admitting ADMIN alone wherever it is still checked.
  assert.equal((CAPABILITIES as readonly string[]).includes('contracts.manage'), false);
});
