import { GraphQLError } from 'graphql';
import type { Prisma, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { viewerOf, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { scopeSeeded, scopeStepDone } from '../../lib/scopeProposals.js';
import type { FullContract } from './contracts.js';
import { assertStepOpen } from '../../lib/steps.js';
import { briefIncompleteOn, wizardStateOn } from './wizard.js';

/**
 * What stops a new-road contract's draft from being published, as data (DX1,
 * desk UX review 16) — **the one place the two content gates of
 * `publishContractRevision` are decided**, so the desk's readiness box and the
 * publish button cannot disagree (house rule 3). The mutation throws the first
 * refusal below; `Contract.publishBlockers` lists them all, so sales sees every
 * blocker at once instead of one per press.
 *
 * The order is the plan's (J6): the scope first, because it names what is on the
 * step sales is looking at when they press the button, then the brief. Both
 * exist on the new road only; the legacy road has neither gate.
 *
 * Reads are of the contract as given. `briefIncompleteOn` reads through
 * `prisma`, not `db`, exactly as the mutation always did.
 */

export type PublishRefusal = {
  code: 'SCOPE_UNCONFIRMED' | 'BRIEF_INCOMPLETE';
  message: string;
  /** Where in the wizard it is fixed. */
  step: StepKind;
  /** How many things: proposals waiting, or brief fields missing. */
  count: number;
  /** The mutation's own `extensions`, besides the code. */
  extensions: Record<string, unknown>;
};

export async function publishContentRefusals(
  db: typeof prisma | Prisma.TransactionClient,
  contract: FullContract,
): Promise<PublishRefusal[]> {
  if (contract.sequence !== 'AGREEMENT_FIRST') return [];
  const out: PublishRefusal[] = [];
  const proposals = await db.scopeProposal.findMany({
    where: { contractId: contract.id },
    select: { decidedAt: true },
  });
  if (!scopeStepDone({ items: contract.project.scopeItems, proposals, contractId: contract.id })) {
    const undecided = proposals.filter((p) => p.decidedAt === null).length;
    out.push({
      code: 'SCOPE_UNCONFIRMED',
      message: 'The scope is not confirmed: it has nothing in it yet, or a proposal is still waiting for a decision.',
      step: 'SCOPE',
      count: undecided,
      extensions: { undecided, seeded: scopeSeeded(contract.project.scopeItems, contract.id) },
    });
  }
  const missing = await briefIncompleteOn(contract);
  if (missing.length > 0) {
    out.push({
      code: 'BRIEF_INCOMPLETE',
      message: 'Step 1 is not complete yet.',
      step: 'REQUIREMENTS',
      count: missing.length,
      extensions: { missing: missing.map((m) => m.code) },
    });
  }
  return out;
}

/** The first refusal as the `GraphQLError` the mutation has always thrown. */
export function refusalError(r: PublishRefusal): GraphQLError {
  return new GraphQLError(r.message, { extensions: { code: r.code, ...r.extensions } });
}

/**
 * `Contract.publishBlockers` — what stops the publish button from working,
 * every blocker at once, for whoever holds `contracts.author` (the capability
 * the button itself needs); empty for everyone else, not an error. **Signed**
 * and **locked** are the mutation's first two refusals (`CONTRACT_SIGNED`,
 * `STEP_LOCKED`), asked of the same `assertStepOpen` over the same `wizardStateOn`; then the content gates
 * above. "Nothing has changed" (`NO_CHANGES`) is not a blocker here: it is the
 * draft's `dirty` flag, which the box shows on its own line.
 */
export type PublishBlocker = { code: string; step: StepKind | null; count: number };

export const contractPublishFields = {
  publishBlockers: async (c: FullContract, _a: unknown, ctx: Context): Promise<PublishBlocker[]> => {
    if (!can(viewerOf(ctx), 'contracts.author')) return [];
    const out: PublishBlocker[] = [];
    if (c.currentContractRevision?.signature) out.push({ code: 'CONTRACT_SIGNED', step: null, count: 0 });
    try {
      // The same check `assertStepOpenOn` makes for the mutation — asked of the same state and rule, but not through
      // that name: this is a read, and the lock table (j7) counts the guarded *writes* by it.
      assertStepOpen(await wizardStateOn(c.id), 'DRAFT', null);
    } catch (err) {
      if (!(err instanceof GraphQLError) || err.extensions?.code !== 'STEP_LOCKED') throw err;
      out.push({ code: 'STEP_LOCKED', step: 'AGREEMENT', count: 0 });
    }
    for (const r of await publishContentRefusals(prisma, c)) out.push({ code: r.code, step: r.step, count: r.count });
    return out;
  },
};
