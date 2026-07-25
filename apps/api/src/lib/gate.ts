import { GraphQLError } from 'graphql';

type PageLike = { approvedAt: Date | null };
type ConceptLike = { chosenAt: Date | null; pages: PageLike[] };
type ContractLike = {
  concepts: ConceptLike[];
  contractApprovedAt: Date | null;
  signature?: unknown | null;
};

/**
 * The core rule, in one place:
 *
 *   design approved & complete -> unlock "approve contract" -> unlock e-sign
 *
 * Design complete = a concept is chosen AND every page under it is approved.
 * Commenting and the scope checklist are never gated.
 *
 * This lives on the server because the UI's copy of it is a convenience, not
 * an authority — a client that skips a step must still be refused.
 */
export function computeGate(contract: ContractLike) {
  const chosen = contract.concepts.find((c) => c.chosenAt !== null) ?? null;
  const pages = chosen?.pages ?? [];
  const approvedPageCount = pages.filter((p) => p.approvedAt !== null).length;
  const totalPageCount = pages.length;

  const designComplete = chosen !== null && totalPageCount > 0 && approvedPageCount === totalPageCount;
  const contractApproved = contract.contractApprovedAt !== null;
  const signed = !!contract.signature;

  return { designComplete, contractApproved, signed, approvedPageCount, totalPageCount };
}

export function assertCanApproveContract(contract: ContractLike) {
  const gate = computeGate(contract);
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

export function assertCanSign(contract: ContractLike) {
  const gate = computeGate(contract);
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
}
