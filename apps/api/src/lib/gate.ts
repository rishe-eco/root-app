import { GraphQLError } from 'graphql';
import type { ContractSequence } from '@prisma/client';
import { planMatchesFee } from './plan.js';

type PageLike = { approvedAt: Date | null };
type ConceptLike = { chosenAt: Date | null; pages: PageLike[] };

type DesignRevisionLike = { concepts: ConceptLike[] } | null;
type ContractRevisionLike = {
  approvedAt: Date | null;
  contentHash: string | null;
  signature?: unknown | null;
} | null;

/**
 * What the gate reads. Deliberately structural rather than Prisma types: the
 * rule below did not change when versioning landed, only where the caller
 * fetches its inputs from — the contract's *current revisions* instead of the
 * contract itself.
 */
export type GateInput = {
  currentDesignRevision: DesignRevisionLike;
  currentContractRevision: ContractRevisionLike;
};

/**
 * The core rule, in one place:
 *
 *   design approved & complete -> unlock "approve contract" -> unlock e-sign
 *
 * Design complete = a concept is chosen AND every page under it is approved,
 * within the current design revision. Commenting and the scope checklist are
 * never gated.
 *
 * This lives on the server because the UI's copy of it is a convenience, not
 * an authority — a client that skips a step must still be refused.
 *
 * The two lineages advance on separate clocks. Publishing a design revision
 * leaves `contractApproved` and `signed` exactly as they were; publishing a
 * contract revision leaves the design alone. That independence is a property
 * of *which revision* each half reads, not of the rule.
 */
export function computeGate(input: GateInput) {
  const concepts = input.currentDesignRevision?.concepts ?? [];
  const chosen = concepts.find((c) => c.chosenAt !== null) ?? null;
  const pages = chosen?.pages ?? [];
  const approvedPageCount = pages.filter((p) => p.approvedAt !== null).length;
  const totalPageCount = pages.length;

  const designComplete = chosen !== null && totalPageCount > 0 && approvedPageCount === totalPageCount;
  const contractApproved = input.currentContractRevision?.approvedAt != null;
  const signed = !!input.currentContractRevision?.signature;

  return { designComplete, contractApproved, signed, approvedPageCount, totalPageCount };
}

/**
 * **The agreement gate** (journeys build plan J7; the lifecycle plan's owed
 * L8). On the new road the design comes *after* the agreement, so "the design is
 * complete" is not what stands between the customer and the button. What does
 * is that the agreement is ready to be signed:
 *
 * - a published revision to approve (`NO_PUBLISHED_REVISION`);
 * - the scope confirmed (`SCOPE_UNCONFIRMED`);
 * - the payment plan adds up to the fee (`PLAN_TOTAL_MISMATCH` — *no fee is not
 *   a match*, `planMatchesFee`);
 * - every phase has its planned end and the contract its planned start and end
 *   (`DATES_INCOMPLETE`);
 * - step 1 is complete (`BRIEF_INCOMPLETE`, `briefCompleteness`);
 * - and the published revision *is* the live steps (`REVISION_STALE` — not in the
 *   plan's list; see the note on it below).
 *
 * plus, in `approveContract`'s transaction and not here, no unresolved note and
 * no pending answer on steps 1–3 (`STEP_HAS_OPEN_FEEDBACK`,
 * `STEP_HAS_PENDING_ANSWERS`, from `approveStepTx`, which is the one place that
 * rule lives).
 *
 * **`REVISION_STALE` is the gate's own addition.** Approval *locks* steps 1–3,
 * and what it locks are the live rows; what the customer approves and signs is
 * the *snapshot*. If sales edited the brief after publishing the draft, the two
 * differ — and the agreement would freeze a state nobody signed. A format-2
 * snapshot carries every one of those rows, so `draftState`'s `dirty` is exactly
 * "the live steps have moved on from what was published", and the remedy is the
 * one the customer already understands: Root publishes again.
 *
 * Pure over facts the caller loaded under the contract's row lock, so the
 * answer is the same one the approval then acts on. Every check is a plain
 * boolean here (as `computeGate`'s are); which code is refused first is
 * `assertAgreementGate`'s order.
 */
export type AgreementGateInput = {
  /** The contract's current revision, or null when nothing is published. */
  revision: { approvedAt: Date | null } | null;
  scopeConfirmed: boolean;
  /** The draft fee. */
  fee: bigint | null;
  plan: { invoices: ReadonlyArray<{ amount: bigint }> } | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  phases: ReadonlyArray<{ plannedEndAt: Date | null }>;
  /** `briefCompleteness`' answer — codes, so the refusal can carry them. */
  briefMissing: readonly string[];
  /** `draftState(...).dirty` against the current revision. */
  revisionStale: boolean;
  /** Carried onto the scope refusal, as `publishContractRevision` does. */
  undecidedProposals?: number;
  seeded?: boolean;
};

export function computeAgreementGate(input: AgreementGateInput) {
  return {
    alreadyApproved: input.revision?.approvedAt != null,
    hasRevision: input.revision !== null,
    scopeConfirmed: input.scopeConfirmed,
    // A contract with no plan at all is the empty plan against its fee, which
    // is a mismatch by arithmetic — `briefCompleteness` names it `PAYMENT_PLAN`
    // as well, so sales sees both.
    planMatchesFee: planMatchesFee(input.plan ?? { invoices: [] }, input.fee),
    datesComplete:
      input.plannedStartAt !== null && input.plannedEndAt !== null && input.phases.every((p) => p.plannedEndAt !== null),
    briefMissing: input.briefMissing,
    revisionCurrent: !input.revisionStale,
    undecidedProposals: input.undecidedProposals ?? 0,
    seeded: input.seeded ?? true,
    phasesWithoutEnd: input.phases.filter((p) => p.plannedEndAt === null).length,
  };
}

export function assertAgreementGate(gate: ReturnType<typeof computeAgreementGate>): void {
  const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) => {
    throw new GraphQLError(message, { extensions: { code, ...extensions } });
  };
  if (gate.alreadyApproved) refuse('ALREADY_APPROVED', 'This contract is already approved.');
  if (!gate.hasRevision) refuse('NO_PUBLISHED_REVISION', 'This contract has no published text to approve.');
  if (!gate.scopeConfirmed) {
    refuse('SCOPE_UNCONFIRMED', 'The scope is not confirmed: it has nothing in it yet, or a proposal is still waiting for a decision.', {
      undecided: gate.undecidedProposals,
      seeded: gate.seeded,
    });
  }
  if (!gate.planMatchesFee) refuse('PLAN_TOTAL_MISMATCH', 'The payment plan does not add up to the fee.');
  if (!gate.datesComplete) {
    refuse('DATES_INCOMPLETE', 'The planned start and end, and every phase’s end, must be set before the agreement is approved.', {
      phasesWithoutEnd: gate.phasesWithoutEnd,
    });
  }
  if (gate.briefMissing.length > 0) refuse('BRIEF_INCOMPLETE', 'Step 1 is not complete yet.', { missing: [...gate.briefMissing] });
  if (!gate.revisionCurrent) {
    refuse('REVISION_STALE', 'The steps have changed since this draft was published — it has to be published again first.');
  }
}

export function assertCanApproveContract(
  input: GateInput & { sequence?: ContractSequence },
  agreement?: AgreementGateInput,
) {
  // The new road's gate is a different rule about a different thing (J7): the
  // agreement, not the design-then-text chain. Branching here keeps one entry
  // point for "may this contract be approved"; the legacy code below is what it
  // was, line for line, and `gate.test.ts` — which never passes a sequence —
  // still reads it unchanged (PD-7).
  if (input.sequence === 'AGREEMENT_FIRST') {
    if (!agreement) throw new Error('assertCanApproveContract: an AGREEMENT_FIRST contract needs its agreement facts.');
    assertAgreementGate(computeAgreementGate(agreement));
    return;
  }
  const gate = computeGate(input);
  if (!gate.designComplete) {
    throw new GraphQLError('The design must be approved and complete first.', {
      extensions: { code: 'GATE_DESIGN_INCOMPLETE' },
    });
  }
  if (gate.contractApproved) {
    throw new GraphQLError('This contract is already approved.', {
      extensions: { code: 'ALREADY_APPROVED' },
    });
  }
}

export function assertCanSign(input: GateInput) {
  const gate = computeGate(input);
  if (!gate.contractApproved) {
    throw new GraphQLError('The contract must be approved before it can be signed.', {
      extensions: { code: 'GATE_CONTRACT_UNAPPROVED' },
    });
  }
  if (gate.signed) {
    throw new GraphQLError('This contract is already signed.', {
      extensions: { code: 'ALREADY_SIGNED' },
    });
  }
  // A signature stands against specific bytes. An unsealed revision — one the
  // backfill migration created and `npm run backfill` has not yet sealed — has
  // no bytes to stand against, so signing it would produce a signature that
  // attests to nothing.
  if (!input.currentContractRevision?.contentHash) {
    throw new GraphQLError('This contract revision has no content hash yet.', {
      extensions: { code: 'REVISION_UNSEALED' },
    });
  }
}

/**
 * The amendment's own mini-gate: approve, then sign — without reopening the
 * base contract. Kept beside the other two rather than inside `Gate` itself
 * (house rule 3, and V3's note: growing `Gate` a fourth meaning makes every
 * existing reader wonder which of two things it now answers).
 */
export function assertCanApproveAmendment(a: {
  publishedAt: Date | null;
  approvedAt: Date | null;
}): void {
  if (!a.publishedAt) {
    throw new GraphQLError('This amendment has not been published yet.', {
      extensions: { code: 'AMENDMENT_UNPUBLISHED' },
    });
  }
  if (a.approvedAt) {
    throw new GraphQLError('This amendment is already approved.', {
      extensions: { code: 'ALREADY_APPROVED' },
    });
  }
}

export function assertCanSignAmendment(a: {
  approvedAt: Date | null;
  signature?: unknown | null;
}): void {
  if (!a.approvedAt) {
    throw new GraphQLError('This amendment must be approved before it can be signed.', {
      extensions: { code: 'GATE_CONTRACT_UNAPPROVED' },
    });
  }
  if (a.signature) {
    throw new GraphQLError('This amendment is already signed.', {
      extensions: { code: 'ALREADY_SIGNED' },
    });
  }
}
