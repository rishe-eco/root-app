import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentContract, holdsContractWork } from './home.js';
import { stepFromParams } from './wizard.js';
import type { Capability } from './access.js';
import type { ContractLink, WizardStep } from './queries.js';

/**
 * Journeys build plan J12 — the small rules behind the home screens. The list
 * itself is the API's (`myAttention`); what is held here is which contract the
 * dashboard's standing action opens, who has contract work at all, and which step
 * a link opens the wizard on.
 */

const link = (id: string, over: Partial<ContractLink> = {}): ContractLink => ({
  id,
  ref: `RC-${id}`,
  titleFa: 'ا',
  titleEn: id,
  status: 'IN_PROGRESS',
  sequence: 'AGREEMENT_FIRST',
  updatedAt: '2026-10-01T00:00:00Z',
  deliveredAt: null,
  ...over,
});

test('currentContract: the most recently touched contract that is still being worked', () => {
  const contracts = [
    link('old', { updatedAt: '2026-08-01T00:00:00Z' }),
    link('new', { updatedAt: '2026-10-03T00:00:00Z' }),
    link('delivered', { updatedAt: '2026-10-04T00:00:00Z', deliveredAt: '2026-10-04T00:00:00Z' }),
    link('done', { updatedAt: '2026-10-04T00:00:00Z', status: 'DONE' }),
    link('discarded', { updatedAt: '2026-10-04T00:00:00Z', status: 'DISCARDED' }),
  ];
  assert.equal(currentContract(contracts)?.id, 'new');
  assert.equal(currentContract([contracts[2], contracts[3], contracts[4]]), null, 'every contract closed: no action to offer');
  assert.equal(currentContract([]), null);
});

test('holdsContractWork: sales, design, development, support and approvals have a My work; a contributor and a reviewer do not', () => {
  const has = (...capabilities: Capability[]) => holdsContractWork({ capabilities });
  assert.equal(has('contracts.author'), true);
  assert.equal(has('design.author', 'contracts.readActive'), true);
  assert.equal(has('builds.author', 'contracts.readActive'), true);
  assert.equal(has('tickets.answer'), true);
  assert.equal(has('billing.manage'), true);
  assert.equal(has('feedback.approveAnswers'), true);
  assert.equal(has('library.write'), false);
  assert.equal(has('review.participate'), false);
  assert.equal(has('contracts.readActive'), false, 'reading is not work');
  assert.equal(holdsContractWork(null), false);
});

const step = (s: WizardStep['step'], phaseId: string | null = null): WizardStep => ({
  step: s,
  phaseId,
  phaseNumber: phaseId ? 1 : null,
  status: 'UPCOMING',
  locked: false,
  lockedAt: null,
  takesInput: true,
  iterationsUsed: null,
  allowance: null,
  finishedAt: null,
});
const query = (qs: string) => new URLSearchParams(qs);

test('stepFromParams: a link names a step, and for a demo its phase; anything the road does not have opens nothing', () => {
  const wizard = [step('REQUIREMENTS'), step('DESIGN'), step('DEMO', 'p1'), step('DEMO', 'p2'), step('SUMMARY')];
  assert.equal(stepFromParams(wizard, query('step=DESIGN'))?.step, 'DESIGN');
  assert.equal(stepFromParams(wizard, query('step=DEMO&phase=p2'))?.phaseId, 'p2');
  assert.equal(stepFromParams(wizard, query('step=DEMO'))?.phaseId, 'p1', 'a demo without its phase is the first');
  assert.equal(stepFromParams(wizard, query('step=DEMO&phase=nope')), null, 'a phase this contract does not own');
  assert.equal(stepFromParams(wizard, query('step=MOCKUP')), null, 'a step this road does not have (the pre-made path)');
  assert.equal(stepFromParams(wizard, query('step=BOGUS')), null);
  assert.equal(stepFromParams(wizard, query('')), null);
});
