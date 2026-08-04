import { DateTimeResolver } from 'graphql-scalars';
import { Contract, ContractRevision, DesignConcept, PageDesign, ScopeItem } from './fields.js';
import { Query } from './query.js';
import { authMutations } from './auth.js';
import { customerMutations } from './customer.js';
import { adminMutations } from './admin.js';

/**
 * The composition root. Nothing but assembly lives here, so that the question
 * "where does this resolver live?" always has an answer you can read off the
 * imports.
 *
 * The split is by *who is acting*, not by data type, because that is the axis
 * the rules actually run along: `auth` guards what it says about accounts,
 * `customer` goes through `loadForActor` and the gate, `admin` is guarded by
 * role and writes drafts. A per-model split would have cut across all three.
 */
export const resolvers = {
  DateTime: DateTimeResolver,

  Contract,
  ContractRevision,
  DesignConcept,
  PageDesign,
  ScopeItem,

  Query,

  Mutation: {
    ...authMutations,
    ...customerMutations,
    ...adminMutations,
  },
};
