import { DateTimeResolver } from 'graphql-scalars';
import {
  Contract,
  ContractRevision,
  DesignConcept,
  DesignDraft,
  PageDesign,
  Project,
  ScopeItem,
  DemoFrame,
  Dependency,
  BillingEntry,
  Subscription,
  BillingSourceTotal,
  BillingReport,
  ServiceRun,
  ServiceRunRow,
  User,
} from './fields.js';
import { Query } from './query.js';
import { authMutations } from './auth.js';
import { customerMutations } from './customer.js';
import { adminMutations } from './admin/index.js';
import { demoMutations } from './demo.js';
import { feedbackMutations } from './feedback.js';
import { buildQueries, buildMutations } from './builds.js';
import { ticketQueries, ticketMutations } from './tickets.js';
import { serviceQueries, serviceMutations } from './services.js';
import { LibraryEntry, libraryMutations, libraryQueries, publicLibraryQueries } from './library.js';
import { reviewMutations, reviewQueries } from './review.js';
import { reviewThreadFields, reviewThreadMutations } from './reviewThreads.js';
import { apiTokenMutations, apiTokenQueries } from './apiTokens.js';

/**
 * The composition root. Nothing but assembly lives here, so that the question
 * "where does this resolver live?" always has an answer you can read off the
 * imports.
 *
 * The split is by *who is acting*, not by data type, because that is the axis
 * the rules actually run along: `auth` guards what it says about accounts,
 * `customer` goes through `loadForActor` and the gate, `admin` is guarded by
 * capability and writes drafts. A per-model split would have cut across all
 * three.
 */
export const resolvers = {
  DateTime: DateTimeResolver,

  Contract,
  ContractRevision,
  DesignConcept,
  DesignDraft,
  PageDesign,
  Project,
  ScopeItem,
  DemoFrame,
  Dependency,
  BillingEntry,
  Subscription,
  BillingSourceTotal,
  BillingReport,
  ServiceRun,
  ServiceRunRow,
  User,
  LibraryEntry,
  ReviewDocument: reviewThreadFields.ReviewDocument,

  Query: {
    ...Query,
    ...libraryQueries,
    ...publicLibraryQueries,
    ...reviewQueries,
    ...apiTokenQueries,
    // build plan L3b: builds.author-gated, not contracts.manage — see
    // resolvers/builds.ts's own comment on why this stays out of the admin
    // barrel entirely.
    ...buildQueries,
    // build plan L4: myTickets is ownership-gated, allTickets and
    // adminRequestCount are contracts.manage — see resolvers/tickets.ts.
    ...ticketQueries,
    // build plan L7: myProjects/projectServiceRuns are ownership-gated,
    // allServiceRuns is contracts.manage — see resolvers/services.ts.
    ...serviceQueries,
  },

  Mutation: {
    ...authMutations,
    ...customerMutations,
    ...adminMutations,
    // build plan L2: callable by Root *or* the project's own customer — see
    // resolvers/demo.ts's own comment on why it is not folded into
    // adminMutations.
    ...demoMutations,
    // build plan L3: same reasoning — submitFeedback/ratifyFeedback are
    // ownership-gated against project.customerId, not capability-gated.
    ...feedbackMutations,
    // build plan L3b: builds.author-gated — see resolvers/builds.ts.
    ...buildMutations,
    // build plan L4: a mix of ownership (createTicket, addTicketMessage) and
    // contracts.manage (everything else) — see resolvers/tickets.ts.
    ...ticketMutations,
    // build plan L7: createServiceRun/previewServiceRun/applyServiceRun are
    // ownership-gated against project.customerId — see resolvers/services.ts.
    // createServiceRunBillingEntry (contracts.manage) lives in
    // resolvers/admin/billing.ts instead, beside L6's own billing edges.
    ...serviceMutations,
    ...libraryMutations,
    ...reviewMutations,
    ...reviewThreadMutations,
    ...apiTokenMutations,
  },
};
