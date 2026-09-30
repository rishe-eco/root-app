import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractStatus, ProjectStatus, Role } from '@prisma/client';
import {
  canAuthorBuild,
  canAuthorBuildOnAnyPhase,
  canAuthorBuildOnPhase,
  canAuthorDesign,
  contractVisibleTo,
  contractVisibleToStaff,
  isActiveContract,
  invoiceVisibleTo,
  isContractReader,
  mayReadInternalNotes,
  mayReadArticleBody,
  mayReadAmendmentBody,
  mayReadContactOf,
  mayReadMoney,
  mayReadPlannedDates,
  projectVisibleTo,
  projectVisibleToStaff,
  requestVisibleTo,
} from './visibility.js';

/**
 * Journeys build plan S1 — the ownership half, as tables. Each rule is a pure
 * function of the row's own columns, so the whole matrix is checkable here
 * without a database; the integration suite (`s1.test.ts`) then only has to
 * prove each loader *calls* the right one.
 */

const person = (id: string, ...roles: Role[]) => ({ id, roles });

const contract = (
  over: Partial<{ customerId: string; publishedAt: Date | null; status: ContractStatus; project: { status: ProjectStatus } }> = {},
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
  // J2: a request is not a project being worked. A contract can never sit on
  // one (conversion flips the project to ACTIVE in the same transaction that
  // attaches the contract), but if one ever did it would read as inactive —
  // the type has no "no project" any more, so there is no artefact case left.
  assert.equal(isActiveContract(contract({ project: { status: 'REQUESTED' } })), false);
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

test('canAuthorBuild, and its phase forms (J4)', () => {
  const dev = person('dev', 'DEVELOPER');
  assert.equal(canAuthorBuild(dev, { developerId: 'dev' }), true);
  assert.equal(canAuthorBuild(dev, { developerId: 'x' }), false);
  assert.equal(canAuthorBuild(person('des', 'DESIGNER'), { developerId: 'des' }), false);
  assert.equal(canAuthorBuild(person('a', 'ADMIN'), { developerId: null }), true);

  const live = (developerId: string | null) => ({ developerId, status: 'IN_PROGRESS' as ContractStatus });
  assert.equal(canAuthorBuildOnAnyPhase(dev, [live('x'), live('dev')]), true);
  assert.equal(canAuthorBuildOnAnyPhase(dev, [live('x')]), false);
  assert.equal(canAuthorBuildOnAnyPhase(dev, []), false);
  assert.equal(canAuthorBuildOnAnyPhase(person('a', 'ADMIN'), []), true);
});

test('canAuthorBuildOnPhase: the claim on a phase is its own contract\'s developer — never the project\'s other contract\'s', () => {
  const dev = person('dev', 'DEVELOPER');
  const other = person('other', 'DEVELOPER');
  const phaseOf = (developerId: string | null, status: ContractStatus = 'IN_PROGRESS') => ({
    developerId,
    status,
    project: { status: 'ACTIVE' as ProjectStatus },
  });
  // Two contracts on one project, two developers: each holds only their own
  // contract's phases — S1's project-wide "any contract" answer is gone.
  assert.equal(canAuthorBuildOnPhase(dev, phaseOf('dev')), true);
  assert.equal(canAuthorBuildOnPhase(dev, phaseOf('other')), false);
  assert.equal(canAuthorBuildOnPhase(other, phaseOf('other')), true);
  // A discarded contract's developer is out (contractVisibleToStaff), the
  // override is not.
  assert.equal(canAuthorBuildOnPhase(dev, phaseOf('dev', 'DISCARDED')), false);
  assert.equal(canAuthorBuildOnPhase(person('a', 'ADMIN'), phaseOf('dev', 'DISCARDED')), true);
  // The capability first: a designer named in the developer column is refused.
  assert.equal(canAuthorBuildOnPhase(person('des', 'DESIGNER'), phaseOf('des')), false);
  // And a customer is never a build author, whatever they own.
  assert.equal(canAuthorBuildOnPhase(person('cust', 'CUSTOMER'), phaseOf('cust')), false);
});

test('contractVisibleToStaff is the staff half of contractVisibleTo — the customer edge does not count', () => {
  const owner = person('cust', 'CUSTOMER');
  assert.equal(contractVisibleTo(owner, contract()), true);
  assert.equal(contractVisibleToStaff(owner, contract()), false);
  assert.equal(contractVisibleToStaff(person('s', 'SALES'), contract({ publishedAt: null })), true);
  assert.equal(contractVisibleToStaff(person('d', 'DEVELOPER'), contract({ status: 'DISCARDED' })), false);
});

test('mayReadArticleBody: a sensitive body needs the contract\'s money; an ordinary one never does (PD-14, J4)', () => {
  const c = { customerId: 'cust' };
  const secret = { sensitive: true };
  const plain = { sensitive: false };
  assert.equal(mayReadArticleBody(person('cust', 'CUSTOMER'), c, secret), true, 'the customer always reads their own');
  assert.equal(mayReadArticleBody(person('s', 'SALES'), c, secret), true);
  assert.equal(mayReadArticleBody(person('a', 'ADMIN'), c, secret), true);
  for (const role of ['DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(mayReadArticleBody(person('x', role), c, secret), false, role);
    assert.equal(mayReadArticleBody(person('x', role), c, plain), true, role);
  }
  assert.equal(mayReadArticleBody(person('other', 'CUSTOMER'), c, secret), false, 'another customer is not this customer');
});

test('canAuthorBuildOnAnyPhase: the contracts that own phases on a project — a discarded one\'s developer never holds the keys', () => {
  const dev = person('dev', 'DEVELOPER');
  const first = { developerId: 'dev', status: 'DISCARDED' as ContractStatus };
  const second = { developerId: 'other', status: 'IN_PROGRESS' as ContractStatus };
  // The project moved on to a second contract with a different developer: the
  // first developer's discarded contract no longer holds the keys.
  assert.equal(canAuthorBuildOnAnyPhase(dev, [first, second]), false);
  assert.equal(canAuthorBuildOnAnyPhase(person('other', 'DEVELOPER'), [first, second]), true);
  // Two live contracts, two developers, each owning phases: each is in.
  const live = { developerId: 'dev', status: 'WAITING_ON_CUSTOMER' as ContractStatus };
  assert.equal(canAuthorBuildOnAnyPhase(dev, [live, second]), true);
  assert.equal(canAuthorBuildOnAnyPhase(person('other', 'DEVELOPER'), [live, second]), true);
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

test('invoiceVisibleTo (J13): a draft is billing’s alone; an issued invoice is its customer’s and money readers’; design and development see none', () => {
  const issued = { customerId: 'cust', issuedAt: new Date('2026-09-01T00:00:00Z') };
  const draft = { customerId: 'cust', issuedAt: null };
  const table: Array<{ who: string; viewer: ReturnType<typeof person>; issued: boolean; draft: boolean }> = [
    { who: 'the customer', viewer: person('cust', 'CUSTOMER'), issued: true, draft: false },
    { who: 'another customer', viewer: person('other', 'CUSTOMER'), issued: false, draft: false },
    { who: 'sales (billing.manage and money.read)', viewer: person('s', 'SALES'), issued: true, draft: true },
    { who: 'admin', viewer: person('a', 'ADMIN'), issued: true, draft: true },
    { who: 'a designer', viewer: person('des', 'DESIGNER'), issued: false, draft: false },
    { who: 'a developer', viewer: person('dev', 'DEVELOPER'), issued: false, draft: false },
    { who: 'a contributor', viewer: person('con', 'CONTRIBUTOR'), issued: false, draft: false },
  ];
  for (const row of table) {
    assert.equal(invoiceVisibleTo(row.viewer, issued), row.issued, `${row.who}, issued`);
    assert.equal(invoiceVisibleTo(row.viewer, draft), row.draft, `${row.who}, draft`);
  }
});

/**
 * Journeys build plan J2: how the new `REQUESTED` status reads. A request is
 * a project with no contract, and the rule is written once, here: sales
 * (`contracts.readAll`) and the customer who made it see it; design and
 * development (`contracts.readActive`) do not, however the project is asked
 * about.
 */
test('a REQUESTED project: sales and its own customer see it; design, development and other customers do not', () => {
  const requested = { customerId: 'cust', status: 'REQUESTED' as ProjectStatus, contracts: [] };
  // The project-level rule (what demos, builds and the desk's project query use).
  assert.equal(projectVisibleTo(person('s', 'SALES'), requested), true);
  assert.equal(projectVisibleTo(person('a', 'ADMIN'), requested), true);
  assert.equal(projectVisibleTo(person('cust', 'CUSTOMER'), requested), true);
  assert.equal(projectVisibleTo(person('d', 'DESIGNER'), requested), false);
  assert.equal(projectVisibleTo(person('v', 'DEVELOPER'), requested), false);
  assert.equal(projectVisibleTo(person('other', 'CUSTOMER'), requested), false);
  assert.equal(projectVisibleTo(person('c', 'CONTRIBUTOR'), requested), false);
  // Not even a contract that somehow named it would make it visible to them.
  const withContract = { ...requested, contracts: [{ status: 'IN_PROGRESS' as ContractStatus }] };
  assert.equal(projectVisibleToStaff(person('d', 'DESIGNER'), withContract), false);
  assert.equal(projectVisibleToStaff(person('v', 'DEVELOPER'), withContract), false);
});

test('requestVisibleTo: the customer who asked and contracts.readAll, in every request status; never readActive', () => {
  const asked = new Date('2026-09-29T09:00:00Z');
  const request = { customerId: 'cust', requestedAt: asked };
  assert.equal(requestVisibleTo(person('cust', 'CUSTOMER'), request), true);
  assert.equal(requestVisibleTo(person('s', 'SALES'), request), true);
  assert.equal(requestVisibleTo(person('a', 'ADMIN'), request), true);
  assert.equal(requestVisibleTo(person('other', 'CUSTOMER'), request), false);
  for (const role of ['DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(requestVisibleTo(person('x', role), request), false, role);
  }
  // A project that never was a request has nothing to read, for anyone.
  const plain = { customerId: 'cust', requestedAt: null };
  assert.equal(requestVisibleTo(person('cust', 'CUSTOMER'), plain), false);
  assert.equal(requestVisibleTo(person('a', 'ADMIN'), plain), false);
});

/**
 * Journeys build plan J3: Root's private notes. A staff reader of contracts who
 * may see *this* contract — never a customer, whichever side of the row.
 */
test('mayReadInternalNotes: contract readers who can see the contract; never the customer, owner or not', () => {
  const owner = person('cust', 'CUSTOMER');
  const live = contract();
  assert.equal(mayReadInternalNotes(owner, live), false);
  assert.equal(mayReadInternalNotes(person('other', 'CUSTOMER'), live), false);
  assert.equal(mayReadInternalNotes(person('s', 'SALES'), live), true);
  assert.equal(mayReadInternalNotes(person('a', 'ADMIN'), live), true);
  assert.equal(mayReadInternalNotes(person('d', 'DESIGNER'), live), true);
  assert.equal(mayReadInternalNotes(person('v', 'DEVELOPER'), live), true);
  // A reader with readActive only cannot read the notes of a contract they cannot open…
  const dead = contract({ status: 'DISCARDED' });
  assert.equal(mayReadInternalNotes(person('d', 'DESIGNER'), dead), false);
  assert.equal(mayReadInternalNotes(person('s', 'SALES'), dead), true);
  // …and roles that read no contracts at all read no notes.
  for (const role of ['CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(mayReadInternalNotes(person('x', role), live), false, role);
  }
  // An unpublished contract is staff's: notes are exactly what sales writes on a draft.
  assert.equal(mayReadInternalNotes(person('s', 'SALES'), contract({ publishedAt: null })), true);
});

test('mayReadPlannedDates: staff readers always; a customer only once the loader says they are shown (a draft published, or the agreement approved — J6)', () => {
  assert.equal(mayReadPlannedDates(person('s', 'SALES'), false), true);
  assert.equal(mayReadPlannedDates(person('d', 'DESIGNER'), false), true);
  assert.equal(mayReadPlannedDates(person('cust', 'CUSTOMER'), false), false);
  assert.equal(mayReadPlannedDates(person('cust', 'CUSTOMER'), true), true);
});

test('mayReadContactOf: yourself, and the staff who work with accounts — never a customer, contributor or reviewer (J3 review)', () => {
  const staffer = { id: 'des' };
  assert.equal(mayReadContactOf(person('des', 'DESIGNER'), staffer), true, 'your own');
  for (const role of ['ADMIN', 'SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    assert.equal(mayReadContactOf(person('x', role), staffer), true, role);
  }
  for (const role of ['CUSTOMER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    assert.equal(mayReadContactOf(person('x', role), staffer), false, role);
  }
});

test('mayReadAmendmentBody (J7): a sensitive amendment reads like a sensitive article — the customer and money readers only', () => {
  const c = { customerId: 'cust' };
  for (const sensitive of [true, false]) {
    for (const role of ['DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER', 'SALES', 'ADMIN'] as Role[]) {
      assert.equal(
        mayReadAmendmentBody(person('x', role), c, { sensitive }),
        mayReadArticleBody(person('x', role), c, { sensitive }),
        role + ' ' + sensitive,
      );
    }
  }
  assert.equal(mayReadAmendmentBody(person('cust', 'CUSTOMER'), c, { sensitive: true }), true);
  assert.equal(mayReadAmendmentBody(person('x', 'DESIGNER'), c, { sensitive: true }), false);
  assert.equal(mayReadAmendmentBody(person('x', 'DESIGNER'), c, { sensitive: false }), true);
});
