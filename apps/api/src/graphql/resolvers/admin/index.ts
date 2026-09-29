import { customerMutations } from './customers.js';
import { contractAdminMutations } from './contracts.js';
import { designMutations } from './design.js';
import { amendmentMutations } from './amendments.js';
import { registryMutations } from './registry.js';
import { phaseMutations } from './phases.js';
import { demoFrameMutations } from './demoFrame.js';
import { dependencyMutations } from './dependencies.js';
import { billingMutations } from './billing.js';

/**
 * Everything only Root may do: invites, authoring a contract's draft,
 * publishing, and the scope registry — split by domain (build plan L1) from
 * what used to be one 951-line `admin.ts`. This barrel is the only thing that
 * changed behaviourally: it preserves the flat `adminMutations` shape
 * `resolvers/index.ts` already imports, so the split is mechanical — no
 * resolver's guard, transaction, or return value moved.
 *
 * The dividing line that matters across every file in this directory is
 * still **draft versus published**. Every authoring mutation writes to a
 * draft — `Article` rows for the contract, an unpublished `DesignRevision`
 * for the design, a live `ScopeItem` for the registry (never versioned, see
 * V2.md §5) — and none of it reaches the customer until a publish mutation
 * freezes it.
 */
export const adminMutations = {
  ...customerMutations,
  ...contractAdminMutations,
  ...designMutations,
  ...amendmentMutations,
  ...registryMutations,
  // Phases and the live demo surface (build plan L2) — phase CRUD is
  // `contracts.author`, demos `builds.author` plus the developer assignment
  // (journeys build plan S1; see phases.ts). `reportDemoPath`
  // (resolvers/demo.ts) is deliberately *not* here: a customer calls it too,
  // so it is spread straight into the root Mutation object in
  // resolvers/index.ts instead.
  ...phaseMutations,
  // Review frames (build plan L3) — `builds.author` plus assignment, like demos.
  // `submitFeedback`/`ratifyFeedback` (resolvers/feedback.ts) are likewise
  // deliberately *not* here: the project's own customer calls both.
  ...demoFrameMutations,
  // The dependency board (build plan L5) — `contracts.author` to write,
  // `dependencies.verifyGeneral` to mark met (S1; see dependencies.ts). Reading
  // one's own overdue commitments (`myOverdueDependencies`) is ownership-
  // gated instead, and lives in query.ts, not here — see that file's comment.
  ...dependencyMutations,
  // Billing (build plan L6) — `billing.manage` (S1; see billing.ts).
  // `myBillingEntries`/`myBillingReport`/`mySubscriptions` are
  // ownership-gated instead, and live in query.ts, not here.
  ...billingMutations,
};
