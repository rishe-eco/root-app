import { DateTimeResolver } from 'graphql-scalars';
import {
  Contract as ContractFields,
  Amendment,
  ContractRevision,
  DesignConcept,
  DesignPaletteItem,
  DesignDraft,
  PageDesign,
  Project,
  ScopeItem,
  DemoFrame,
  FeedbackItem,
  FeedbackComment,
  Build,
  Dependency,
  BillingEntry,
  Subscription,
  BillingSourceTotal,
  BillingReport,
  ServiceRun,
  ServiceRunRow,
  Ticket,
  User,
} from './fields.js';
import { Query } from './query.js';
import { authMutations } from './auth.js';
import { customerMutations } from './customer.js';
import { adminMutations } from './admin/index.js';
import { demoMutations } from './demo.js';
import { feedbackMutations, feedbackQueries } from './feedback.js';
import { buildQueries, buildMutations } from './builds.js';
import { ticketQueries, ticketMutations } from './tickets.js';
import { serviceQueries, serviceMutations } from './services.js';
import { LibraryEntry, libraryMutations, libraryQueries, publicLibraryQueries } from './library.js';
import { reviewMutations, reviewQueries } from './review.js';
import { reviewThreadFields, reviewThreadMutations } from './reviewThreads.js';
import { apiTokenMutations, apiTokenQueries } from './apiTokens.js';
import { templateMutations, templateQueries } from './templates.js';
import { Theme, themeMutations, themeQueries } from './themes.js';
import { Request, requestMutations, requestQueries } from './requests.js';
import { peopleMutations, peopleQueries } from './people.js';
import { contractWizardFields, wizardMutations } from './wizard.js';
import { briefMutations, contractBriefFields } from './brief.js';
import { scopeMutations, contractScopeFields } from './scope.js';
import { contractDraftNoteFields } from './draftNotes.js';
import { PlannedInvoice, invoiceQueries } from './invoices.js';
import { contractDesignFields, designCustomerMutations } from './design.js';
import { allowanceMutations } from './allowance.js';
import { mockupQueries } from './mockups.js';
import { contractDeliveryFields, deliveryMutations } from './delivery.js';

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

  // Journeys build plan J3: the wizard's derived views and the staff notes
  // sit beside the fields they read (`Contract.pending`) — see wizard.ts for
  // why they are a separate file spread in here.
  // Journeys build plan J4: step 1's own fields (brief, payment plan, this
  // contract's phases) — see brief.ts.
  // Journeys build plan J5 and J6: step 2a's proposals (scope.ts) and step 2b's
  // notes with where each note's article is now (draftNotes.ts).
  Contract: {
    ...ContractFields,
    ...contractWizardFields,
    ...contractBriefFields,
    ...contractScopeFields,
    ...contractDraftNoteFields,
    // Journeys build plan J8: the palette, what the design still lacks, and the
    // allowance extensions (staff only) — see design.ts.
    ...contractDesignFields,
    // Journeys build plan J11: the close, as the desk needs it (`delivery`), and the
    // summary — a record derived on read. See delivery.ts.
    ...contractDeliveryFields,
  },
  Amendment,
  ContractRevision,
  DesignConcept,
  DesignPaletteItem,
  DesignDraft,
  PageDesign,
  Project,
  ScopeItem,
  DemoFrame,
  FeedbackItem,
  FeedbackComment,
  Build,
  Dependency,
  BillingEntry,
  // Journeys build plan J13: where each row of a payment plan stands.
  PlannedInvoice,
  Subscription,
  BillingSourceTotal,
  BillingReport,
  ServiceRun,
  ServiceRunRow,
  Ticket,
  Theme,
  User,
  Request,
  CustomerProfile: { id: (p: { user: { id: string } }) => p.user.id },
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
    // journeys build plan S2: pendingAnswers (feedback.approveAnswers) and
    // myFeedbackQueue (feedback.answer) — see resolvers/feedback.ts.
    ...feedbackQueries,
    // build plan L4: myTickets is ownership-gated, allTickets and
    // adminRequestCount are contracts.manage — see resolvers/tickets.ts.
    ...ticketQueries,
    // build plan L7: myProjects/projectServiceRuns are ownership-gated,
    // allServiceRuns is contracts.manage — see resolvers/services.ts.
    ...serviceQueries,
    // journeys build plan T1: templates.types / templates.scope write, any staff
    // holding either (or contracts.author) reads — see resolvers/templates.ts.
    ...templateQueries,
    // journeys build plan T2: the theme catalogue, same readers as the types.
    ...themeQueries,
    // journeys build plan J2: myRequests is ownership-gated, allRequests is
    // contracts.readAll, request is both — see resolvers/requests.ts.
    ...requestQueries,
    // journeys build plan S3: customer (customers.manage) and allUsers
    // (staff.manage) — see resolvers/people.ts.
    ...peopleQueries,
    // journeys build plan J13: myInvoices and invoice are the customer's own
    // (issued only), contractsWithPaymentPlan is billing.manage — see
    // resolvers/invoices.ts.
    ...invoiceQueries,
    // journeys build plan J9: mockupViewUrl mints a viewer's grant — see
    // resolvers/mockups.ts and routes/mockups.ts.
    ...mockupQueries,
  },

  Mutation: {
    ...authMutations,
    ...customerMutations,
    ...adminMutations,
    // build plan L2: callable by Root *or* the project's own customer — see
    // resolvers/demo.ts's own comment on why it is not folded into
    // adminMutations.
    ...demoMutations,
    // build plan L3, journeys build plan S2: submitFeedback and approveStep
    // are the contract's own customer's (an ownership edge); answerFeedback,
    // approveAnswer and declineAnswer are capabilities (feedback.answer,
    // feedback.approveAnswers). ratifyFeedback and acceptFeedback are retired.
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
    ...templateMutations,
    // journeys build plan T2: templates.types writes — see resolvers/themes.ts.
    ...themeMutations,
    // journeys build plan J2: submitRequest/postRequestMessage are
    // ownership-gated, archiveRequest is contracts.author — the conversion
    // itself is createContract's, in admin/contracts.ts.
    ...requestMutations,
    // journeys build plan S3: setUserState / grantTool / revokeTool / inviteStaff /
    // setUserRoles — two capabilities, see resolvers/people.ts.
    ...peopleMutations,
    // journeys build plan J3: addInternalNote — staff readers, see wizard.ts.
    ...wizardMutations,
    // journeys build plan J4: setBrief / setExtra / setPaymentPlan —
    // contracts.author, each under the contract's lock and assertStepOpen(REQUIREMENTS).
    ...briefMutations,
    // journeys build plan J5: the customer's proposals and the customer half of
    // a scope trade (ownership edges), sales' decisions and template seeding
    // (contracts.author) — see scope.ts. setPlannedDates and the J6 publish
    // gate live in admin/contracts.ts beside the draft they belong to.
    ...scopeMutations,
    // journeys build plan J8: the customer's half of step 4 (other options,
    // approving the design — ownership edges) and sales' extension of an
    // allowance (contracts.author). The designer's half is admin/design.ts.
    ...designCustomerMutations,
    ...allowanceMutations,
    // Journeys build plan J11: markHandedOver (contracts.author, or builds.author and
    // the developer), unmarkHandedOver and closeContract (contracts.author).
    ...deliveryMutations,
  },
};
