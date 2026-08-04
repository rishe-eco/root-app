import { GraphQLError } from 'graphql';

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

export function assertCanApproveContract(input: GateInput) {
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
