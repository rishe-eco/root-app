import { customerMutations } from './customers.js';
import { contractAdminMutations } from './contracts.js';
import { designMutations } from './design.js';
import { amendmentMutations } from './amendments.js';
import { registryMutations } from './registry.js';

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
};
