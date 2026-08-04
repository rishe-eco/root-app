import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import {
  assertCanApproveContract,
  assertCanSign,
  computeGate,
  type GateInput,
} from './gate.js';

const AT = new Date('2026-07-30T10:00:00Z');
const HASH = 'a'.repeat(64);

const page = (approved = false) => ({ approvedAt: approved ? AT : null });

/** A design revision with one concept, chosen unless told otherwise. */
const design = (pages: ReturnType<typeof page>[], chosen = true) => ({
  concepts: [{ chosenAt: chosen ? AT : null, pages }],
});

const contract = (o: { approved?: boolean; signed?: boolean; sealed?: boolean } = {}) => ({
  approvedAt: o.approved ? AT : null,
  contentHash: o.sealed === false ? null : HASH,
  signature: o.signed ? { id: 'sig_1' } : null,
});

const input = (
  d: GateInput['currentDesignRevision'],
  c: GateInput['currentContractRevision'],
): GateInput => ({ currentDesignRevision: d, currentContractRevision: c });

/** The code an error carries, which is what the client actually branches on. */
const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as GraphQLError).extensions?.code as string;
  }
  return undefined;
};

// --- the rule ---------------------------------------------------------------

test('a contract with no revisions at all is closed, not crashed', () => {
  assert.deepEqual(computeGate(input(null, null)), {
    designComplete: false,
    contractApproved: false,
    signed: false,
    approvedPageCount: 0,
    totalPageCount: 0,
  });
});

test('no concept chosen means no pages count, even approved ones', () => {
  // Pages only count under the *chosen* concept — approvals under an
  // abandoned one are history, not progress.
  const gate = computeGate(input(design([page(true), page(true)], false), contract()));
  assert.equal(gate.designComplete, false);
  assert.equal(gate.totalPageCount, 0);
  assert.equal(gate.approvedPageCount, 0);
});

test('a chosen concept with no pages is not complete', () => {
  // Vacuous truth would be the natural bug here: 0 of 0 approved reads as
  // "all approved" to anything that only compares the two counts.
  const gate = computeGate(input(design([]), contract()));
  assert.equal(gate.designComplete, false);
});

test('three of four approved is not complete', () => {
  const gate = computeGate(
    input(design([page(true), page(true), page(true), page()]), contract()),
  );
  assert.equal(gate.designComplete, false);
  assert.equal(gate.approvedPageCount, 3);
  assert.equal(gate.totalPageCount, 4);
});

test('all pages approved under a chosen concept completes the design', () => {
  const gate = computeGate(input(design([page(true), page(true)]), contract()));
  assert.equal(gate.designComplete, true);
  assert.equal(gate.approvedPageCount, 2);
});

test('un-approving one page reopens a complete design', () => {
  const complete = computeGate(input(design([page(true), page(true)]), contract()));
  const reopened = computeGate(input(design([page(true), page()]), contract()));
  assert.equal(complete.designComplete, true);
  assert.equal(reopened.designComplete, false);
});

test('approval and signature are read from the contract revision, not the design', () => {
  const gate = computeGate(input(design([]), contract({ approved: true, signed: true })));
  assert.equal(gate.designComplete, false); // design says no…
  assert.equal(gate.contractApproved, true); // …and the other lineage is untouched
  assert.equal(gate.signed, true);
});

test('a design revision published after signing does not un-sign anything', () => {
  // The property the two lineages exist for: Root publishes design v2, the
  // customer has pages to re-approve, and the signature still stands.
  const afterNewDesign = computeGate(
    input(design([page(true), page()]), contract({ approved: true, signed: true })),
  );
  assert.equal(afterNewDesign.designComplete, false);
  assert.equal(afterNewDesign.contractApproved, true);
  assert.equal(afterNewDesign.signed, true);
});

// --- assertCanApproveContract -----------------------------------------------

test('approving is refused while the design is incomplete', () => {
  assert.equal(
    codeOf(() => assertCanApproveContract(input(design([page(true), page()]), contract()))),
    'GATE_DESIGN_INCOMPLETE',
  );
});

test('approving is allowed once the design is complete', () => {
  assert.equal(
    codeOf(() => assertCanApproveContract(input(design([page(true)]), contract()))),
    undefined,
  );
});

test('approving twice is refused', () => {
  assert.equal(
    codeOf(() =>
      assertCanApproveContract(input(design([page(true)]), contract({ approved: true }))),
    ),
    'ALREADY_APPROVED',
  );
});

// --- assertCanSign ----------------------------------------------------------

test('signing is refused before the contract is approved', () => {
  // Even with the design complete — the steps are ordered, not a set.
  assert.equal(
    codeOf(() => assertCanSign(input(design([page(true)]), contract()))),
    'GATE_CONTRACT_UNAPPROVED',
  );
});

test('signing is allowed once approved and sealed', () => {
  assert.equal(
    codeOf(() => assertCanSign(input(design([page(true)]), contract({ approved: true })))),
    undefined,
  );
});

test('signing twice is refused', () => {
  assert.equal(
    codeOf(() =>
      assertCanSign(input(design([page(true)]), contract({ approved: true, signed: true }))),
    ),
    'ALREADY_SIGNED',
  );
});

test('an unsealed revision cannot be signed', () => {
  // A signature stands against specific bytes. A revision the backfill created
  // and `npm run backfill` has not sealed has none, so a signature on it would
  // attest to nothing.
  assert.equal(
    codeOf(() =>
      assertCanSign(input(design([page(true)]), contract({ approved: true, sealed: false }))),
    ),
    'REVISION_UNSEALED',
  );
});

test('already-signed is reported before unsealed', () => {
  // Order matters for the message the customer reads: "already signed" is the
  // true and useful answer; "no content hash" would be a confusing half-truth
  // about a contract they have already signed.
  assert.equal(
    codeOf(() =>
      assertCanSign(
        input(design([page(true)]), contract({ approved: true, signed: true, sealed: false })),
      ),
    ),
    'ALREADY_SIGNED',
  );
});

// --- the invariant nothing else enforces ------------------------------------

test('with two concepts marked chosen, the gate reads the first', () => {
  // Documenting a known sharp edge rather than blessing it. computeGate takes
  // the *first* concept with a chosenAt; only chooseConcept's transaction
  // (which clears every chosenAt in the revision before setting one) keeps
  // that from being ambiguous. No database constraint backs it, so if that
  // transaction ever regresses, this is the behaviour you get.
  const gate = computeGate(
    input(
      {
        concepts: [
          { chosenAt: AT, pages: [page(true)] },
          { chosenAt: AT, pages: [page(), page()] },
        ],
      },
      contract(),
    ),
  );
  assert.equal(gate.totalPageCount, 1);
  assert.equal(gate.designComplete, true);
});
