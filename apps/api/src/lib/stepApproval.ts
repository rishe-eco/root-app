import { GraphQLError } from 'graphql';
import type { Prisma, StepKind } from '@prisma/client';
import { acceptanceOnApproval, blockerCode, stepBlockers } from './feedbackRules.js';
import { LOCKS_WITH_AGREEMENT } from './steps.js';

/**
 * **The one approval** (journeys build plan S2; journeys §3.1). Every stage
 * that locks a step — J7 the agreement, J8 the design, J9 the mockup, J10 a
 * phase's demo — calls `approveStepTx` inside its own transaction and passes
 * its stage-specific preconditions in; none reimplements the feedback rule.
 * That is the point of the file: "approval requires nothing unresolved, then
 * accepts everything and locks the step" is one rule (house rule 3), and
 * three copies of it are three chances for one to forget a clause.
 *
 * **This module is the only writer of `FeedbackItem.acceptedAt` /
 * `acceptedById`, and of `StepApproval`.** L3b's invariant — *"resolved" is
 * Root's claim, "accepted" is the customer's act, two fields, never one; nothing
 * Root does closes the loop on its own* — is kept by construction, and
 * `s2.test.ts` reads every resolver and lib file as text to hold it: a second
 * writer would be a second path with different preconditions, which is exactly
 * what the plan's first trap describes. The caller must be the customer's own
 * mutation; this function does not check who is calling (it is given
 * `approverId`, not a user), so a caller that is not the customer's is a bug
 * in the caller, and there is one caller per stage to read.
 *
 * ## What one call does, in order
 *
 * 1. Takes the contract row's lock (`FOR UPDATE`), so an approval cannot
 *    interleave with an answer or a comment being written on the same
 *    contract — both take the same lock (`lockContract`) before they check
 *    `assertStepOpen`. Without it, "no answer is pending" could be true when
 *    read and false when committed.
 * 2. Refuses if the step is already approved (`STEP_LOCKED`).
 * 3. Reads the step's items and pending answers and refuses with
 *    `STEP_HAS_OPEN_FEEDBACK` / `STEP_HAS_PENDING_ANSWERS` (`stepBlockers`).
 *    **AGREEMENT covers REQUIREMENTS, SCOPE and DRAFT** (`LOCKS_WITH_AGREEMENT`,
 *    J3): approving it blocks on, accepts and seals all three steps' items,
 *    because that is what the lock does to them.
 * 4. Runs the stage's own preconditions, each of which throws its own code.
 * 5. Writes the acceptance onto every resolved item (`acceptanceOnApproval`)
 *    and the `StepApproval` row — the lock — in the same transaction.
 *
 * `phaseId` is set for a DEMO (a demo is approved once per phase) and null for
 * every other step; it selects which items the approval covers.
 */

export type StepTarget = {
  contractId: string;
  step: StepKind;
  phaseId: string | null;
  /** The customer who is approving — written as `approvedById` and
   *  `acceptedById`. */
  approverId: string;
};

/** A stage's own condition ("the payment plan sums to the fee", "the demo is
 *  ready"). Runs in the approval's transaction, after the feedback checks, and
 *  refuses by throwing a `GraphQLError` with its own code. */
export type StepPrecondition = (tx: Prisma.TransactionClient) => Promise<void>;

/** The steps whose items one approval of `step` covers. */
export function stepsSealedBy(step: StepKind): StepKind[] {
  return step === 'AGREEMENT' ? ['AGREEMENT', ...LOCKS_WITH_AGREEMENT] : [step];
}

/**
 * The row lock every write to a contract's feedback takes before it checks
 * that the step is open — see `approveStepTx` step 1. Held to the end of the
 * caller's transaction.
 */
export async function lockContract(tx: Prisma.TransactionClient, contractId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Contract" WHERE "id" = ${contractId} FOR UPDATE`;
}

export async function approveStepTx(
  tx: Prisma.TransactionClient,
  target: StepTarget,
  preconditions: readonly StepPrecondition[] = [],
) {
  const { contractId, step, phaseId, approverId } = target;
  await lockContract(tx, contractId);

  const already = await tx.stepApproval.findFirst({
    where: { contractId, step, phaseId },
    select: { id: true },
  });
  if (already) {
    throw new GraphQLError('That step is locked.', { extensions: { code: 'STEP_LOCKED' } });
  }

  const covered = stepsSealedBy(step);
  const items = await tx.feedbackItem.findMany({
    where: { contractId, step: { in: covered }, phaseId: step === 'DEMO' ? phaseId : undefined },
    select: { id: true, status: true, acceptedAt: true },
  });
  const pending = await tx.feedbackComment.findMany({
    where: { approval: 'PENDING', feedbackItem: { id: { in: items.map((i) => i.id) } } },
    select: { id: true },
  });

  const blockers = stepBlockers(items, pending);
  const code = blockerCode(blockers);
  if (code) {
    throw new GraphQLError(
      code === 'STEP_HAS_OPEN_FEEDBACK'
        ? 'Every comment on this step needs Root’s answer before it can be approved.'
        : 'Some answers on this step are still waiting for approval by Root.',
      {
        extensions: {
          code,
          count: code === 'STEP_HAS_OPEN_FEEDBACK' ? blockers.openItemIds.length : blockers.pendingAnswerIds.length,
        },
      },
    );
  }

  for (const precondition of preconditions) await precondition(tx);

  const now = new Date();
  const writes = acceptanceOnApproval(items);
  for (const status of ['ACCEPTED', 'DECLINED', 'MOVED'] as const) {
    const ids = writes.filter((w) => w.status === status).map((w) => w.id);
    if (ids.length === 0) continue;
    await tx.feedbackItem.updateMany({
      where: { id: { in: ids } },
      data: { status, acceptedAt: now, acceptedById: approverId },
    });
  }

  const approval = await tx.stepApproval.create({
    data: { contractId, step, phaseId, approvedAt: now, approvedById: approverId },
  });
  return { approval, acceptedItemIds: writes.map((w) => w.id) };
}
