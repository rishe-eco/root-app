import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '@prisma/client';
import { CAPABILITIES, can, capabilitiesOf } from './capabilities.js';

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
  assert.equal(can(reviewer, 'contracts.manage'), false);
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
