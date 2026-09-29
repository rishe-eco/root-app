import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractStatus, ProjectStatus, Role } from '@prisma/client';
import {
  canAuthorBuild,
  canAuthorBuildOnProject,
  canAuthorDesign,
  contractVisibleTo,
  isActiveContract,
  isContractReader,
  mayReadMoney,
  projectVisibleTo,
  projectVisibleToStaff,
} from './visibility.js';

/**
 * Journeys build plan S1 — the ownership half, as tables. Each rule is a pure
 * function of the row's own columns, so the whole matrix is checkable here
 * without a database; the integration suite (`s1.test.ts`) then only has to
 * prove each loader *calls* the right one.
 */

const person = (id: string, ...roles: Role[]) => ({ id, roles });

const contract = (
  over: Partial<{ customerId: string; publishedAt: Date | null; status: ContractStatus; project: { status: ProjectStatus } | null }> = {},
) => ({
  customerId: 'cust',
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  status: 'IN_PROGRESS' as ContractStatus,
  project: { status: 'ACTIVE' as ProjectStatus },
  ...over,
});

test('isActiveContract: discarded and archived-project contracts are not active', () => {
  assert.equal(isActiveContract(contract()), true);
  assert.equal(isActiveContract(contract({ status: 'DISCARDED' })), false);
  assert.equal(isActiveContract(contract({ project: { status: 'ARCHIVED' } })), false);
  // DONE is still active until J11's deliveredAt exists — the clause is
  // absent, not false (plan S1).
  assert.equal(isActiveContract(contract({ status: 'DONE' })), true);
  assert.equal(isActiveContract(contract({ status: 'DRAFT' })), true);
  // The L1 migration artefact: no project reads as active, not hidden.
  assert.equal(isActiveContract(contract({ project: null })), true);
});

test('contractVisibleTo: the customer sees their own, once published', () => {
  const owner = person('cust', 'CUSTOMER');
  assert.equal(contractVisibleTo(owner, contract()), true);
  assert.equal(contractVisibleTo(owner, contract({ publishedAt: null })), false);
  assert.equal(contractVisibleTo(person('other', 'CUSTOMER'), contract()), false);
  // Discarded does not hide a published contract from its own customer —
  // that is `readActive`'s rule, not the ownership edge's.
  assert.equal(contractVisibleTo(owner, contract({ status: 'DISCARDED' })), true);
});

test('contractVisibleTo: readAll sees everything, readActive only what is active', () => {
  const discarded = contract({ status: 'DISCARDED' });
  const draft = contract({ publishedAt: null });
  for (const role of ['ADMIN', 'SALES'] as Role[]) {
    assert.equal(contractVisibleTo(person('s', role), discarded), true, role);
    assert.equal(contractVisibleTo(person('s', role), draft), true, role);
  }
  for (const role of ['DESIGNER', 'DEVELOPER'] as Role[]) {
    assert.equal(contractVisibleTo(person('d', role), contract()), true, role);
    assert.equal(contractVisibleTo(person('d', role), draft), true, `${role} sees an unpublished active contract`);
    assert.equal(contractVisibleTo(person('d', role), discarded), false, role);
    assert.equal(contractVisibleTo(person('d', role), contract({ project: { status: 'ARCHIVED' } })), false, role);
  }
  for (const role of ['CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(contractVisibleTo(person('x', role), contract()), false, role);
  }
});

test('isContractReader: the lifecycle staff, and nobody else', () => {
  for (const role of ['ADMIN', 'SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    assert.equal(isContractReader(person('s', role)), true, role);
  }
  for (const role of ['CUSTOMER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(isContractReader(person('s', role)), false, role);
  }
});

test('canAuthorDesign: the capability and the assignment, or the override', () => {
  const designer = person('des', 'DESIGNER');
  assert.equal(canAuthorDesign(designer, { designerId: 'des' }), true);
  assert.equal(canAuthorDesign(designer, { designerId: 'someone-else' }), false);
  assert.equal(canAuthorDesign(designer, { designerId: null }), false);
  // Assigned but without the capability — a developer named in the designer
  // column by mistake — is still refused: two mechanisms, both checked.
  assert.equal(canAuthorDesign(person('dev', 'DEVELOPER'), { designerId: 'dev' }), false);
  // Sales holds neither.
  assert.equal(canAuthorDesign(person('s', 'SALES'), { designerId: 's' }), false);
  // ADMIN's override, assigned or not.
  assert.equal(canAuthorDesign(person('a', 'ADMIN'), { designerId: null }), true);
});

test('canAuthorBuild and its project form', () => {
  const dev = person('dev', 'DEVELOPER');
  assert.equal(canAuthorBuild(dev, { developerId: 'dev' }), true);
  assert.equal(canAuthorBuild(dev, { developerId: 'x' }), false);
  assert.equal(canAuthorBuild(person('des', 'DESIGNER'), { developerId: 'des' }), false);
  assert.equal(canAuthorBuild(person('a', 'ADMIN'), { developerId: null }), true);

  assert.equal(canAuthorBuildOnProject(dev, [{ developerId: 'x' }, { developerId: 'dev' }]), true);
  assert.equal(canAuthorBuildOnProject(dev, [{ developerId: 'x' }]), false);
  assert.equal(canAuthorBuildOnProject(dev, []), false);
  assert.equal(canAuthorBuildOnProject(person('a', 'ADMIN'), []), true);
});

test('projectVisibleTo: the customer edge, or any active contract for readActive', () => {
  const p = (status: ProjectStatus, statuses: ContractStatus[]) => ({
    customerId: 'cust',
    status,
    contracts: statuses.map((s) => ({ status: s })),
  });
  assert.equal(projectVisibleTo(person('cust', 'CUSTOMER'), p('ACTIVE', [])), true);
  assert.equal(projectVisibleTo(person('other', 'CUSTOMER'), p('ACTIVE', ['IN_PROGRESS'])), false);
  assert.equal(projectVisibleTo(person('d', 'DEVELOPER'), p('ACTIVE', ['DISCARDED', 'IN_PROGRESS'])), true);
  assert.equal(projectVisibleTo(person('d', 'DEVELOPER'), p('ACTIVE', ['DISCARDED'])), false);
  assert.equal(projectVisibleTo(person('d', 'DEVELOPER'), p('ARCHIVED', ['IN_PROGRESS'])), false);
  assert.equal(projectVisibleTo(person('s', 'SALES'), p('ARCHIVED', ['DISCARDED'])), true);
  // The staff half never admits a customer through their own project.
  assert.equal(projectVisibleToStaff(person('cust', 'CUSTOMER'), p('ACTIVE', ['IN_PROGRESS'])), false);
});

test('mayReadMoney: the customer and money.read, never design or development', () => {
  const c = { customerId: 'cust' };
  assert.equal(mayReadMoney(person('cust', 'CUSTOMER'), c), true);
  assert.equal(mayReadMoney(person('s', 'SALES'), c), true);
  assert.equal(mayReadMoney(person('a', 'ADMIN'), c), true);
  assert.equal(mayReadMoney(person('des', 'DESIGNER'), c), false);
  assert.equal(mayReadMoney(person('dev', 'DEVELOPER'), c), false);
  assert.equal(mayReadMoney(person('other', 'CUSTOMER'), c), false);
});
