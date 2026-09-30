import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import {
  assertAgreementGate,
  assertCanApproveContract,
  computeAgreementGate,
  type AgreementGateInput,
} from './gate.js';

/**
 * J7's agreement gate, as a table (journeys build plan §5 "J7"). Pure: the
 * facts are passed in, so every refusal code is reachable here without a
 * database; `j7.test.ts` proves the resolver loads the right facts and takes
 * the lock. `gate.test.ts` — the legacy gate's — is not touched by this stage
 * (PD-7), and one test here proves the legacy branch is still the legacy one.
 */

const ready = (over: Partial<AgreementGateInput> = {}): AgreementGateInput => ({
  revision: { approvedAt: null },
  scopeConfirmed: true,
  fee: 180n,
  plan: { invoices: [{ amount: 100n }, { amount: 80n }] },
  plannedStartAt: new Date('2026-10-12'),
  plannedEndAt: new Date('2026-12-20'),
  phases: [{ plannedEndAt: new Date('2026-11-10') }],
  briefMissing: [],
  revisionStale: false,
  ...over,
});

const codeOf = (input: AgreementGateInput): { code?: string; extensions?: Record<string, unknown> } => {
  try {
    assertAgreementGate(computeAgreementGate(input));
    return {};
  } catch (err) {
    const e = err as GraphQLError;
    return { code: e.extensions?.code as string, extensions: e.extensions };
  }
};

test('an agreement with everything in place passes', () => {
  assert.deepEqual(codeOf(ready()), {});
});

test('each precondition refuses with its own code', () => {
  const table: Array<{ name: string; input: AgreementGateInput; code: string }> = [
    { name: 'already approved', input: ready({ revision: { approvedAt: new Date() } }), code: 'ALREADY_APPROVED' },
    { name: 'nothing published', input: ready({ revision: null }), code: 'NO_PUBLISHED_REVISION' },
    { name: 'scope unconfirmed', input: ready({ scopeConfirmed: false }), code: 'SCOPE_UNCONFIRMED' },
    { name: 'plan short of the fee', input: ready({ plan: { invoices: [{ amount: 100n }] } }), code: 'PLAN_TOTAL_MISMATCH' },
    { name: 'plan over the fee', input: ready({ plan: { invoices: [{ amount: 200n }] } }), code: 'PLAN_TOTAL_MISMATCH' },
    { name: 'no plan', input: ready({ plan: null }), code: 'PLAN_TOTAL_MISMATCH' },
    { name: 'no fee is not a match', input: ready({ fee: null }), code: 'PLAN_TOTAL_MISMATCH' },
    { name: 'no planned start', input: ready({ plannedStartAt: null }), code: 'DATES_INCOMPLETE' },
    { name: 'no planned end', input: ready({ plannedEndAt: null }), code: 'DATES_INCOMPLETE' },
    { name: 'a phase without its end', input: ready({ phases: [{ plannedEndAt: null }] }), code: 'DATES_INCOMPLETE' },
    { name: 'step 1 incomplete', input: ready({ briefMissing: ['BUDGET_CAP'] }), code: 'BRIEF_INCOMPLETE' },
    { name: 'the steps moved since publishing', input: ready({ revisionStale: true }), code: 'REVISION_STALE' },
  ];
  for (const row of table) assert.equal(codeOf(row.input).code, row.code, row.name);
});

test('the order is the plan’s: approved, published, scope, plan, dates, brief, then stale', () => {
  // Everything wrong at once: each fix reveals the next.
  let input = ready({
    revision: { approvedAt: new Date() },
    scopeConfirmed: false,
    plan: null,
    plannedStartAt: null,
    briefMissing: ['PAYMENT_PLAN'],
    revisionStale: true,
  });
  const seen: string[] = [];
  const fixes: Array<Partial<AgreementGateInput>> = [
    { revision: null },
    { revision: { approvedAt: null } },
    { scopeConfirmed: true },
    { plan: { invoices: [{ amount: 180n }] } },
    { plannedStartAt: new Date('2026-10-12') },
    { briefMissing: [] },
    { revisionStale: false },
  ];
  for (const fix of fixes) {
    seen.push(codeOf(input).code ?? 'ok');
    input = { ...input, ...fix };
  }
  seen.push(codeOf(input).code ?? 'ok');
  assert.deepEqual(seen, [
    'ALREADY_APPROVED',
    'NO_PUBLISHED_REVISION',
    'SCOPE_UNCONFIRMED',
    'PLAN_TOTAL_MISMATCH',
    'DATES_INCOMPLETE',
    'BRIEF_INCOMPLETE',
    'REVISION_STALE',
    'ok',
  ]);
});

test('the refusals carry what the customer’s screen and sales’ need: what is undecided, what is missing', () => {
  assert.deepEqual(codeOf(ready({ scopeConfirmed: false, undecidedProposals: 2, seeded: true })).extensions?.undecided, 2);
  assert.deepEqual(codeOf(ready({ briefMissing: ['A', 'B'] })).extensions?.missing, ['A', 'B']);
  assert.equal(codeOf(ready({ phases: [{ plannedEndAt: null }, { plannedEndAt: null }, { plannedEndAt: new Date() }] })).extensions?.phasesWithoutEnd, 2);
});

test('assertCanApproveContract branches on the sequence: the new road takes the agreement gate, the legacy road is the legacy gate', () => {
  const legacyInput = {
    sequence: 'DESIGN_FIRST' as const,
    currentDesignRevision: null,
    currentContractRevision: null,
  };
  // The legacy branch wants a complete design first — whatever agreement facts it is handed.
  assert.throws(
    () => assertCanApproveContract(legacyInput, ready()),
    (e: unknown) => (e as GraphQLError).extensions?.code === 'GATE_DESIGN_INCOMPLETE',
  );
  // No sequence at all (gate.test.ts’s inputs) is the legacy gate, exactly as before.
  assert.throws(
    () => assertCanApproveContract({ currentDesignRevision: null, currentContractRevision: null }),
    (e: unknown) => (e as GraphQLError).extensions?.code === 'GATE_DESIGN_INCOMPLETE',
  );
  // The new road ignores the design entirely (it comes after the agreement) and wants its facts.
  assertCanApproveContract({ sequence: 'AGREEMENT_FIRST', currentDesignRevision: null, currentContractRevision: null }, ready());
  assert.throws(
    () => assertCanApproveContract({ sequence: 'AGREEMENT_FIRST', currentDesignRevision: null, currentContractRevision: null }),
    /needs its agreement facts/,
  );
  assert.throws(
    () => assertCanApproveContract({ sequence: 'AGREEMENT_FIRST', currentDesignRevision: null, currentContractRevision: null }, ready({ scopeConfirmed: false })),
    (e: unknown) => (e as GraphQLError).extensions?.code === 'SCOPE_UNCONFIRMED',
  );
});
