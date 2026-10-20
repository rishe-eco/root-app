import { gql } from '@apollo/client';
import type { Role, Capability } from './access';

export type { Role, Capability };

export type ContractStatus =
  | 'DRAFT'
  | 'WAITING_ON_CUSTOMER'
  | 'WAITING_ON_ROOT'
  | 'IN_PROGRESS'
  | 'FINAL_REVIEW'
  | 'DONE'
  | 'DISCARDED';

export type ChangeAction =
  | 'CREATED'
  | 'PUBLISHED'
  | 'CHOSE_CONCEPT'
  | 'APPROVED_PAGE'
  | 'UNAPPROVED_PAGE'
  | 'DESIGN_COMPLETE'
  | 'APPROVED_CONTRACT'
  | 'SIGNED'
  | 'COMMENTED'
  | 'SCOPE_ON'
  | 'SCOPE_OFF'
  | 'STATUS_CHANGED'
  | 'CONTRACT_REVISED'
  | 'DESIGN_REVISED'
  | 'CONTRACT_AMENDED'
  | 'RE_APPROVED'
  | 'RE_SIGNED'
  | 'AMENDMENT_SIGNED'
  | 'AMENDMENT_APPROVED';

export type User = {
  id: string;
  // Journeys build plan J1: optional — a customer or staff account may now
  // be identified by phone alone.
  email: string | null;
  phone: string | null;
  name: string;
  roles: Role[];
  capabilities: Capability[];
  clientName: string | null;
  locale: string;
  passwordChangeRequired: boolean;
  /** Journeys build plan S3. */
  state: UserState;
};

export type UserState = 'INVITED' | 'ACTIVE' | 'DISABLED';

export type PageDesign = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  imageUrl: string | null;
  approved: boolean;
};

/** What a pre-made round remembers of a theme (journeys build plan J8): name,
 *  vendor and demo URL as they were when it was proposed. Never a licence cost.
 *  The demo opens in a new tab and is never framed. */
export type ThemeSnapshot = { name: string; vendor: string | null; demoUrl: string | null };

export type DesignConcept = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  imageUrl: string | null;
  chosen: boolean;
  pages: PageDesign[];
  /** J8: set for a pre-made round's theme; null for a concept that is not one. Selected by `WizardFields`. */
  themeSnapshot?: ThemeSnapshot | null;
  /** J8: the catalogue row (staff only; null for a customer). Workspace only. */
  themeId?: string | null;
};

export type PaletteKind = 'COLOR' | 'FONT' | 'LOGO_USAGE';

/** J8: one entry of a custom design's palette. A COLOR's value is `#rrggbb`. */
export type DesignPaletteItem = {
  id: string;
  kind: PaletteKind;
  role: string;
  value: string;
  labelFa: string;
  labelEn: string;
  imageUrl: string | null;
  position?: number;
};

/** J8: rounds sales granted beyond the brief. Staff only; `charge` is money (null without `money.read`). */
export type AllowanceExtension = {
  id: string;
  step: StepKind;
  phaseId: string | null;
  extra: number;
  reason: string;
  approvedBy: Pick<User, 'id' | 'name'>;
  charge: string | null;
  createdAt: string;
};

export type ScopeKind = 'PAGE' | 'FEATURE' | 'DELIVERABLE' | 'EXTRA';

export type ScopeStatus = 'PROPOSED' | 'AGREED' | 'IN_BUILD' | 'IN_DEMO' | 'ACCEPTED' | 'DECLINED' | 'TRADED';

export type ScopeItem = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  position: number;
  /** Journeys build plan T1 — `EXTRA` rows are the completeness checklist's
   *  areas, which step 1 (J4) toggles as the brief's "extras". */
  kind: ScopeKind;
  /** The agreement that agreed this item (PD-5, T1) — step 2a shows a contract
   *  its own items, and a project can hold several contracts. */
  contractId: string | null;
  checked: boolean;
  status: ScopeStatus;
  temporary: boolean;
  outOfScope: boolean;
  adminWork: boolean;
  decidedAt: string | null;
  decidedNote: string | null;
  declinedReason: string | null;
  originNote: string | null;
  originRound: string | null;
  /** Which phase (L2) is building this item, if any. */
  phaseId: string | null;
};

/**
 * What a customer asked of their contract's scope (journeys build plan J5,
 * step 2a), in their own words, and Root's decision. An accepted ADD names the
 * bilingual item sales wrote (`createdItem`); a declined one carries its reason.
 */
export type ScopeProposalKind = 'ADD' | 'REMOVE' | 'RESTORE';
export type ScopeProposal = {
  id: string;
  kind: ScopeProposalKind;
  scopeItem: Pick<ScopeItem, 'id' | 'key' | 'labelFa' | 'labelEn' | 'kind' | 'status'> | null;
  requestedKind: ScopeKind | null;
  text: string;
  lang: 'fa' | 'en';
  proposedBy: Pick<User, 'id' | 'name'>;
  createdAt: string;
  decidedAt: string | null;
  decision: 'ACCEPTED' | 'DECLINED' | null;
  declineReason: string | null;
  createdItem: Pick<ScopeItem, 'id' | 'key' | 'labelFa' | 'labelEn' | 'kind'> | null;
};

/**
 * A note on the contract draft (journeys build plan J6): a DRAFT `FeedbackItem`
 * with where its article is *now*. `articleNumber` is the number in the revision
 * the note was written against (`revisionVersion`); `currentArticleNumber` the
 * current revision's; `articleGone` when the article cannot be found by title.
 */
export type DraftNote = {
  item: FeedbackItem;
  revisionVersion: number;
  onCurrentRevision: boolean;
  articleNumber: number | null;
  currentArticleNumber: number | null;
  articleChangedSince: boolean;
  articleGone: boolean;
};

export type ScopeTrade = {
  id: string;
  outItem: ScopeItem;
  inItem: ScopeItem;
  proposedBy: Pick<User, 'id' | 'name'>;
  proposedAt: string;
  rootConfirmedAt: string | null;
  customerConfirmedAt: string | null;
  executedAt: string | null;
};

// ---------------------------------------------------------------------------
// The dependency board (build plan L5; spec §7) — symmetric commitments,
// customer-side and Root-side, one board under one rule.
// ---------------------------------------------------------------------------

export type DependencySide = 'CUSTOMER' | 'ROOT';

export type Dependency = {
  id: string;
  side: DependencySide;
  titleFa: string;
  titleEn: string;
  dueAt: string;
  /** Derived server-side (lib/dependency.ts) — never a hand-typed flag (F5). */
  overdue: boolean;
  createdBy: Pick<User, 'id' | 'name'>;
  createdAt: string;
  verifiedAt: string | null;
  verifiedBy: Pick<User, 'id' | 'name'> | null;
  /** What was actually done to verify it — the banked trap's own fix. Set exactly when verifiedAt is. */
  verifiedNote: string | null;
  /** J4: the step-1 brief owns this row (`domain`, `host`, `content`, `gateway`,
   *  `smsLine`, `enamad`) — it cannot be deleted from the board (`BRIEF_OWNED`). */
  briefKey: string | null;
  /** J4: verified by the developer (`dependencies.verifyTechnical`) rather than sales. */
  technical: boolean;
};

/** The staff dashboard's own cross-project shape — a Dependency plus which
 *  project (and whose) it belongs to, since that board spans every customer
 *  at once (unlike Project.dependencies, reached from one project already
 *  known by context). */
export type DependencyWithProject = Dependency & {
  project: { id: string; titleFa: string; titleEn: string; customer: Pick<User, 'id' | 'name' | 'clientName'> };
};

// ---------------------------------------------------------------------------
// Phases and the live demo surface (build plan L2). One list, reached only
// through `Contract.project.phases` — there is no standalone "phase" query,
// matching T9: every mutation here returns the whole contract.
// ---------------------------------------------------------------------------

/** The design-image toggle's own read (L2.1) — imageUrl and key only, never approvedAt. */
export type PageDesignRef = { id: string; key: string; imageUrl: string | null };

export type DemoPage = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  canonicalPath: string;
  pageDesign: PageDesignRef | null;
};

/** "A page we did not expect" (L2.2) — visible on the desk phase board. */
export type DemoUnmatchedPath = {
  id: string;
  normalizedPath: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
};

// ---------------------------------------------------------------------------
// Review frames and feedback intake (build plan L3; spec §6). Named without
// the bare word "review" anywhere — see the API's schema.prisma comment on
// DemoFrame for why (desk/sections.ts already has review/reviewAdmin for the
// unrelated Review Room).
// ---------------------------------------------------------------------------

/** J10: `HOW_TO_TEST` is typed by the developer by hand — staging-only access details, never a production credential. */
export type DemoFrameLineKind = 'NEW' | 'KNOWN_MISSING' | 'TEMPORARY' | 'DECIDED' | 'HOW_TO_TEST';

/** Only what interception (D4) and the frame display need from the source item. */
export type FrameLineScopeItemRef = {
  id: string;
  labelFa: string;
  labelEn: string;
  temporary: boolean;
  decidedAt: string | null;
  decidedNote: string | null;
};

/** Journeys build plan S2: `RATIFIED` is gone (a submission is its own
 *  ratification) and `MOVED` is a resolution the customer sees. */
export type FeedbackStatus = 'OPEN' | 'ADDRESSED' | 'DECLINED' | 'MOVED' | 'ACCEPTED';
export type FeedbackResolution = 'ADDRESSED' | 'DECLINED';
export type AnswerApproval = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DECLINED';

export type FeedbackComment = {
  id: string;
  body: string;
  createdAt: string;
  /** A staff answer that resolves the item. The customer only ever sees the
   *  ones that reached them; `approval`, `approvedBy`, `approvalNote` and
   *  `originalBody` are Root's machinery and come back null/NOT_REQUIRED-ish
   *  for a customer (the API withholds them). */
  resolution: FeedbackResolution | null;
  approval: AnswerApproval;
  approvedAt: string | null;
  approvalNote: string | null;
  originalBody: string | null;
  approvedBy: Pick<User, 'id' | 'name'> | null;
  author: Pick<User, 'id' | 'name'>;
};

/** Just enough of a Build to trace "which build addressed this" from a
 *  feedback item — never the full change list (that is `Build` below, read
 *  only through the builds.author-gated queries). The customer may read who
 *  declared it (a name); contacts and the change list are staff's. */
export type BuildRef = {
  id: string;
  number: number;
  ref: string | null;
  deployedAt: string;
  declaredBy: Pick<User, 'id' | 'name'>;
};

export type FeedbackItem = {
  id: string;
  contractId: string;
  step: StepKind;
  /** Set for a DEMO item; null for every other step. */
  phaseId: string | null;
  /** The step as a whole — all such comments are one thread. */
  general: boolean;
  briefField: string | null;
  contractRevisionId: string | null;
  articleNumber: number | null;
  designRevisionId: string | null;
  conceptId: string | null;
  pageDesignId: string | null;
  paletteItemId: string | null;
  /** J8: set while a "show me other options" request waits for the next round. */
  otherOptionsAskedAt: string | null;
  anchorScopeItem: FrameLineScopeItemRef | null;
  status: FeedbackStatus;
  createdAt: string;
  reopenedScopeItem: FrameLineScopeItemRef | null;
  demoPage: Pick<DemoPage, 'id' | 'key' | 'labelFa' | 'labelEn'> | null;
  frameLine: { id: string; kind: DemoFrameLineKind; textFa: string; textEn: string } | null;
  /** Build plan L3b.2's first rule, as two fields: the developer's claim
   *  (addressedInBuild), never the customer's own acceptance (acceptedAt). */
  addressedInBuild: BuildRef | null;
  acceptedAt: string | null;
  acceptedBy: Pick<User, 'id' | 'name'> | null;
  comments: FeedbackComment[];
  /** Build plan L4 — set once this item becomes a change ticket. Thin: the
   *  desk reads only whether one exists, never the ticket's own fields from
   *  here (that is `allTickets`/`myTickets`'s job). */
  ticket: { id: string } | null;
};

export type DemoFrameLine = {
  id: string;
  kind: DemoFrameLineKind;
  textFa: string;
  textEn: string;
  position: number;
  scopeItem: FrameLineScopeItemRef | null;
  feedbackItem: FeedbackItem | null;
};

/** Build plan L3b's third source, not yet written up as a line of its own —
 *  staff-only (fields.ts's own comment); see `DemoFeedbackPanel`. */
export type UnpromptedBuildChange = {
  id: string;
  note: string | null;
  noteLang: string | null;
};

export type DemoFrame = {
  id: string;
  summaryFa: string | null;
  summaryEn: string | null;
  authoredBy: Pick<User, 'id' | 'name'>;
  lines: DemoFrameLine[];
  unpromptedChanges: UnpromptedBuildChange[];
};

export type FeedbackInterceptionReason = 'DECIDED' | 'TEMPORARY';

/** What submitFeedback actually did — house rule 6: a code and parameters,
 *  never a sentence. The web renders the interception prompt from
 *  interceptionReason and interceptionScopeItem's own fields. */
export type FeedbackSubmitResult = {
  item: FeedbackItem | null;
  intercepted: boolean;
  interceptionReason: FeedbackInterceptionReason | null;
  interceptionScopeItem: FrameLineScopeItemRef | null;
};

export type DemoKind = 'MOCKUP' | 'SITE';

/** One iteration of a mockup (journeys build plan J9b). `number` is the build's own
 *  (per kind, skips whenever a draft is abandoned); the ordinal the customer is told
 *  is the published count, `WizardStep.iterationsUsed`. */
export type MockupBuild = {
  id: string;
  kind: 'MOCKUP';
  number: number;
  publishedAt: string | null;
  createdAt: string;
  declaredBy: Pick<User, 'id' | 'name'>;
  /** Staff only — the API returns none to a customer. */
  changes: Array<{
    id: string;
    outcome: BuildChangeOutcome | null;
    note: string | null;
    noteLang: string | null;
    createdAt: string;
    feedbackItem: { id: string; general: boolean; demoPage: Pick<DemoPage, 'id' | 'key' | 'labelFa' | 'labelEn'> | null } | null;
  }>;
};

export type Demo = {
  id: string;
  /** J9: a mockup is not a site. */
  kind?: DemoKind;
  /** Null exactly for a MOCKUP demo — it is served at a per-view subdomain (`mockupViewUrl`). */
  stagingUrl: string | null;
  /** J9b, MOCKUP only: its iterations (the customer's are the published ones). */
  builds?: MockupBuild[];
  /** J9b, MOCKUP only: frame lines that are words of the interface, as codes. */
  fixedFrameLines?: string[];
  /** J9b, staff only: the page paths the newest bundle has. */
  bundlePages?: string[];
  buildRef: string | null;
  reviewWindowStart: string | null;
  reviewWindowEnd: string | null;
  /** Null means draft — build plan L3: "a demo cannot be published naked." */
  publishedAt: string | null;
  /** J10, staff only: when a staff member's browser first heard the reporter snippet
   *  report from this demo's own origin, and whose. A browser's claim — never "the
   *  server verified it". Null until then, and again after a change of staging URL. */
  readyAt?: string | null;
  readyVerifiedBy?: Pick<User, 'id' | 'name'> | null;
  pages: DemoPage[];
  unmatchedPaths: DemoUnmatchedPath[];
  frame: DemoFrame | null;
  feedbackItems: FeedbackItem[];
};

/** Only what the phase board actually selects — not the full ScopeItem shape
 *  (that stays on `contract.scopeItems`, which the assignment control reads
 *  from so the dropdown can offer every item, not only ones already on a
 *  phase). */
export type PhaseScopeItemRef = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  status: ScopeStatus;
};

export type Phase = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  /** J4 (PD-5): the contract this phase delivers — `Project.phases` lists the
   *  project's, and a screen for one contract filters by this. */
  contractId: string;
  /** A calendar day (PD-19) as an ISO instant at midnight UTC — render with `calendarDate`. */
  plannedEndAt: string | null;
  milestoneLabel: string | null;
  scopeItems: PhaseScopeItemRef[];
  demos: Demo[];
  /** J10: this phase's site builds, oldest first — staff read drafts too, anyone else only published. */
  builds?: PhaseBuild[];
};

/** A site build as the phase lists it (J10). `pageMapConfirmedAt` is staff's. */
export type PhaseBuild = {
  id: string;
  number: number;
  ref: string | null;
  publishedAt: string | null;
  pageMapConfirmedAt: string | null;
};

/** One phase on the build timeline (J10, journeys Q22) — derived, never stored. */
export type BuildTimelineEntry = {
  phaseId: string;
  number: number;
  titleFa: string;
  titleEn: string;
  plannedEndAt: string | null;
  demoPublishedAt: string | null;
  acceptedAt: string | null;
  builds: Array<{ id: string; number: number; publishedAt: string }>;
};

/** Derived server-side (lib/phase.ts) — never a hand-typed percentage (F5). */
export type ProjectProgress = {
  totalPhases: number;
  currentPhaseNumber: number | null;
  currentPhaseTitleFa: string | null;
  currentPhaseTitleEn: string | null;
  itemsAcceptedInPhase: number;
  itemsTotalInPhase: number;
};

/** What reporting one browser navigation did — not the whole contract (see typeDefs). */
export type DemoPathReport = {
  matched: boolean;
  normalizedPath: string;
  page: DemoPage | null;
};

export type Article = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  /** Null for a sensitive article when the viewer may not read the contract's money (PD-14, J4). */
  bodyFa: string | null;
  bodyEn: string | null;
  sensitive?: boolean;
};

export type Comment = {
  id: string;
  author: Pick<User, 'id' | 'name'>;
  target: 'DESIGN' | 'CONTRACT';
  body: string;
  createdAt: string;
};

export type ChangeLogEntry = {
  id: string;
  actor: Pick<User, 'id' | 'name'>;
  action: ChangeAction;
  arg: string | null;
  createdAt: string;
};

export type Signature = {
  id: string;
  typedName: string;
  signedAt: string;
};

export type Amendment = {
  id: string;
  ordinal: number;
  titleFa: string;
  titleEn: string;
  /** Null for a sensitive amendment when the viewer may not read the contract's money (J7, PD-14). */
  bodyFa: string | null;
  bodyEn: string | null;
  /** J7: this amendment's prose is about money. */
  sensitive: boolean;
  contentHash: string;
  relatesToArticle: number | null;
  publishedAt: string | null;
  approvedAt: string | null;
  signature: Signature | null;
};

/**
 * A format-2 snapshot's steps 1 and 2 (journeys build plan J7) — what the
 * customer approves and signs. `budgetCap` and `paymentPlan` are null to staff
 * without `money.read` who are not the customer; the customer reads all of it.
 */
export type AgreementSnapshot = {
  brief: {
    kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
    existingSiteUrl: string | null;
    templateType: { slug: string; labelFa: string; labelEn: string };
    designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER';
    budgetCap: string | null;
    idealDeadline: string | null;
    hardDeadline: string | null;
    domainName: string | null;
    domainProvidedBy: 'CUSTOMER' | 'ROOT' | null;
    hostProvidedBy: 'CUSTOMER' | 'ROOT' | null;
    contentProvidedBy: 'CUSTOMER' | 'ROOT' | null;
    supportMonths: number | null;
  } | null;
  allowances: {
    premadeRounds: number | null;
    wireframeIterations: number;
    mockupIterations: number | null;
    demoIterationsPerPhase: number | null;
  } | null;
  paymentPlan: {
    split: 'LUMP_SUM' | 'INSTALLMENTS' | 'MONTHLY';
    total: string;
    invoices: Array<{
      ordinal: number;
      labelFa: string;
      labelEn: string;
      amount: string;
      phaseNumber: number | null;
      paymentTermDays: number;
    }>;
  } | null;
  phases: Array<{ number: number; titleFa: string; titleEn: string; plannedEndAt: string | null; milestoneLabel: string | null }>;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
};

/**
 * The published revision, with its own frozen title and fee. The printable
 * view reads these rather than the identically named fields on Contract —
 * those are Root's working draft, and the whole point of `contentHash` is that
 * what you print is what the hash covers.
 */
export type ContractRevision = {
  id: string;
  version: number;
  titleFa: string;
  titleEn: string;
  amount: string | null;
  contentHash: string | null;
  publishedAt: string | null;
  approvedAt: string | null;
  signature: Signature | null;
  amendments: Amendment[];
  /** The snapshot's format: 1 before J7 and on the legacy road, 2 on the new one. */
  format: number;
  /** Steps 1 and 2 as approved — format 2 only (J7). */
  agreement: AgreementSnapshot | null;
};

export type Gate = {
  designComplete: boolean;
  contractApproved: boolean;
  signed: boolean;
  approvedPageCount: number;
  totalPageCount: number;
};

/** Shared by a design page's change and a contract article's change. */
export type ChangeKind = 'ADDED' | 'CHANGED' | 'REMOVED' | 'UNCHANGED';

export type PageChange = {
  conceptKey: string;
  pageKey: string;
  kind: ChangeKind;
};

/** What publishing the design draft would do — computed server-side, never guessed. */
export type CarryForwardPreview = {
  chosenConceptKey: string | null;
  carriedPageCount: number;
  resetPageCount: number;
  changes: PageChange[];
};

/** Root's working copy of the contract's title, fee and articles. Staff only. */
export type ContractDraft = {
  titleFa: string;
  titleEn: string;
  amount: string | null;
  articles: Article[];
  contentHash: string;
  dirty: boolean;
};

/** The unpublished design revision, if one exists. Staff only; null means no draft. */
export type DesignDraft = {
  id: string;
  version: number;
  concepts: DesignConcept[];
  palette: DesignPaletteItem[];
  carryForward: CarryForwardPreview;
};

export type ContractRevisionSummary = {
  id: string;
  version: number;
  contentHash: string | null;
  publishedAt: string | null;
  approvedAt: string | null;
  supersededAt: string | null;
  signedAt: string | null;
  amendmentCount: number;
};

export type DesignRevisionSummary = {
  id: string;
  version: number;
  publishedAt: string | null;
  supersededAt: string | null;
  conceptCount: number;
  pageCount: number;
};

export type ArticleChange = {
  number: number;
  titleFa: string;
  titleEn: string;
  kind: ChangeKind;
};

/** What moved in the text since the revision the customer last approved. */
export type ContractDiff = {
  fromVersion: number;
  toVersion: number;
  titleChanged: boolean;
  amountChanged: boolean;
  articles: ArticleChange[];
};

/**
 * What has moved since the customer last acted, computed server-side —
 * never guessed on the client (V3.md §3.2/T4). Null means there is nothing
 * to show; that is the banner's entire "show or don't" decision.
 */
export type PendingReview = {
  contractDiff: ContractDiff | null;
  designChanges: PageChange[];
  amendment: Amendment | null;
};

/**
 * Requests — a project before a contract (journeys build plan J2). The
 * customer asks; sales answers in a thread, then archives (with a reason) or
 * converts it into a contract. `id` is the project's.
 */
export type ProjectStatus = 'REQUESTED' | 'ACTIVE' | 'ARCHIVED';

/** Deliberately thin — the API exposes name and company for a message's
 *  author and a request's customer, never an email, phone or role. */
export type RequestParty = { id: string; name: string; clientName: string | null };

export type RequestMessage = { id: string; author: RequestParty; body: string; createdAt: string };

export type Request = {
  id: string;
  customer: RequestParty;
  title: string;
  body: string;
  lang: 'fa' | 'en';
  /** REQUESTED = pending; ARCHIVED = closed with `archivedReason`; ACTIVE =
   *  converted to a contract, the thread now read-only. */
  status: ProjectStatus;
  requestedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
  messages: RequestMessage[];
  /** The contract this request became, once this viewer may open it. */
  contractId: string | null;
};

/**
 * The wizard (journeys build plan J3). These mirror the API's derived views
 * (`lib/steps.ts`, `attention.ts`, `statusSummary.ts`, `timeline.ts`) — the
 * client renders them and never recomputes one.
 */
export type ContractSequence = 'DESIGN_FIRST' | 'AGREEMENT_FIRST';
export type StepKind = 'REQUIREMENTS' | 'SCOPE' | 'DRAFT' | 'AGREEMENT' | 'DESIGN' | 'MOCKUP' | 'DEMO' | 'SUMMARY';
export type WaitingOn = 'CUSTOMER' | 'ROOT';

export type WizardStep = {
  step: StepKind;
  phaseId: string | null;
  phaseNumber: number | null;
  status: 'DONE' | 'CURRENT' | 'UPCOMING';
  locked: boolean;
  lockedAt: string | null;
  takesInput: boolean;
  iterationsUsed: number | null;
  allowance: number | null;
  finishedAt: string | null;
};

export type AttentionItem = {
  kind: string;
  variant: string;
  contractId: string;
  phaseId: string | null;
  waitingOn: WaitingOn;
  role: 'SALES' | 'DESIGNER' | 'DEVELOPER' | null;
  since: string;
  params: Array<{ key: string; value: string }>;
};

export type StatusSummary = {
  started: boolean;
  startedAt: string | null;
  /** J7: when the customer approved the agreement (steps 1–3 locked from then); null before, and on the legacy road. */
  agreementApprovedAt: string | null;
  /** When the current revision was signed — approval is not signing. */
  signedAt: string | null;
  currentStep: StepKind | null;
  currentPhaseId: string | null;
  currentPhaseNumber: number | null;
  nextMoveOn: WaitingOn | null;
  waitingOnRoot: number;
  waitingOnCustomer: number;
  /** Calendar days (PD-19) — format with `timeZone: 'UTC'`. */
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  overdueCount: number;
  lastProgressAt: string | null;
  daysSinceProgress: number | null;
};

export type TimelineItem = {
  id: string;
  at: string;
  kind: string;
  by: WaitingOn;
  step: StepKind | null;
  phaseNumber: number | null;
  number: number | null;
};

export type InternalNote = { id: string; body: string; createdAt: string; author: { id: string; name: string } };

export type Contract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  /** Journeys build plan J3, PD-7 — which road; the wizard renders both. */
  sequence: ContractSequence;
  status: ContractStatus;
  amount: string | null;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  publishedAt: string | null;
  updatedAt: string;
  gate: Gate;
  concepts: DesignConcept[];
  scopeItems: ScopeItem[];
  /** Every contract has a project (required since J2). */
  project: { id: string; scopeTrades: ScopeTrade[]; phases: Phase[]; progress: ProjectProgress; dependencies: Dependency[] };
  articles: Article[];
  /** Appendix 1 as frozen into the current published revision (build plan
   *  L1) — the registry's agreed set at publish time, not the live registry
   *  (`scopeItems` above). Empty for a revision published before L1. */
  agreedScopeItems: Array<{ key: string; labelFa: string; labelEn: string; kind?: ScopeKind | null }>;
  comments: Comment[];
  changeLog: ChangeLogEntry[];
  signature: Signature | null;
  revision: ContractRevision | null;
  // Non-staff see published revisions only — enforced server-side, not here.
  contractRevisions: ContractRevisionSummary[];
  designRevisions: DesignRevisionSummary[];
  pending: PendingReview | null;
  // Journeys build plan J3 — present only on queries that select
  // `WizardFields` (the detail, the view-as-customer and the workspace); the
  // desk list selects `statusSummary` alone.
  wizard?: WizardStep[];
  /** J10: the phases in order with their published builds and dates. */
  buildTimeline?: BuildTimelineEntry[];
  statusSummary?: StatusSummary;
  attention?: AttentionItem[];
  timeline?: TimelineItem[];
  /** Staff only in effect: an empty list for a customer, and under view-as. */
  internalNotes?: InternalNote[];
  /** J2: the request this contract's project began as — read-only from here.
   *  Present only on the detail query; null for a project that never was a
   *  request and for anyone but its customer and `contracts.readAll`. */
  request?: Request | null;
  // Staff-only; present only on queries that select them (the workspace).
  draft?: ContractDraft | null;
  designDraft?: DesignDraft | null;
  // Journeys build plan S1 — the assignment edges. Present only on the
  // workspace query (the header's own display and change control); null
  // means unassigned, not "not selected" (see CONTRACT_WORKSPACE_FIELDS).
  designer?: Pick<User, 'id' | 'name'> | null;
  developer?: Pick<User, 'id' | 'name'> | null;
  // Journeys build plan J4 — step 1. Selected by `WizardFields`, so wherever
  // the wizard is.
  brief?: ContractBrief | null;
  /** What step 1 still lacks, as codes. Empty means the step is done. */
  briefCompleteness?: BriefMissing[];
  /** Journeys build plan J8 — step 4, selected by `WizardFields`: the current
   *  round's palette (a custom design's), and what the design still lacks
   *  (`CONCEPT_NOT_CHOSEN`, `NO_PAGES`, `PAGE_NOT_APPROVED`, `PALETTE_EMPTY`,
   *  `NO_ROUND`) — empty means it can be approved. */
  palette?: DesignPaletteItem[];
  designMissing?: string[];
  /** Staff only, workspace only. */
  allowanceExtensions?: AllowanceExtension[];
  /** Money (PD-14): null for staff without `money.read` who are not the customer. */
  paymentPlan?: PaymentPlan | null;
  /** This contract's own phases (`project.phases` is every phase of the project). */
  phases?: Array<Pick<Phase, 'id' | 'number' | 'titleFa' | 'titleEn' | 'contractId' | 'plannedEndAt'>>;
  /** Journeys build plan J5 — step 2a: the customer's proposals, oldest first. */
  scopeProposals?: ScopeProposal[];
  /** Journeys build plan J6 — the planned start and end (Q12), calendar days: null
   *  to a customer until a draft is published, and while unset. */
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
};

export type BriefKind = 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
export type DesignTier = 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER';
export type PaymentSplit = 'LUMP_SUM' | 'INSTALLMENTS' | 'MONTHLY';

/** Step 1 (journeys build plan J4). Dates are calendar days (PD-19): ISO
 *  instants at midnight UTC, rendered with `calendarDate` and edited through
 *  `DayInput`, which speaks `YYYY-MM-DD`. */
export type ContractBrief = {
  id: string;
  kind: BriefKind;
  existingSiteUrl: string | null;
  templateType: { id: string; slug: string; labelFa: string; labelEn: string };
  designTier: DesignTier;
  /** Toman as a decimal string; null for staff without `money.read` (PD-14). */
  budgetCap: string | null;
  idealDeadline: string | null;
  hardDeadline: string | null;
  domainName: string | null;
  domainProvidedBy: DependencySide | null;
  hostProvidedBy: DependencySide | null;
  contentProvidedBy: DependencySide | null;
  supportMonths: number | null;
  premadeRounds: number | null;
  wireframeIterations: number;
  mockupIterations: number | null;
  demoIterationsPerPhase: number | null;
  updatedAt: string;
};

export type BriefMissing = { code: string; key: string | null };

export type PlannedInvoice = {
  id: string;
  ordinal: number;
  labelFa: string;
  labelEn: string;
  /** Toman as a decimal string. */
  amount: string;
  phaseId: string | null;
  paymentTermDays: number;
};

export type PaymentPlan = { id: string; split: PaymentSplit; total: string; invoices: PlannedInvoice[] };

/** J13 — where a payment plan's row stands (lib/invoice.ts). */
export type PlannedInvoiceState = 'NOT_YET_ISSUABLE' | 'ISSUABLE' | 'ISSUED' | 'PAID' | 'OVERDUE';
/** What keeps an unissued row from being issued. */
export type IssueBlock = 'NOT_SIGNED' | 'PREVIOUS_UNPAID' | 'PHASE_NOT_ACCEPTED';

const USER_FIELDS = gql`
  fragment UserFields on User {
    id
    email
    phone
    name
    roles
    capabilities
    clientName
    locale
    passwordChangeRequired
    state
  }
`;

/**
 * Shared by a demo's `feedbackItems` and a frame line's own `feedbackItem`
 * (build plan L3) — one fragment, so the two never silently ask for
 * different shapes of the same object.
 */
export const FEEDBACK_ITEM_FIELDS = gql`
  fragment FeedbackItemFields on FeedbackItem {
    id
    contractId
    step
    phaseId
    general
    briefField
    contractRevisionId
    articleNumber
    designRevisionId
    conceptId
    pageDesignId
    paletteItemId
    otherOptionsAskedAt
    status
    createdAt
    addressedInBuild {
      id
      number
      ref
      deployedAt
      declaredBy {
        id
        name
      }
    }
    acceptedAt
    acceptedBy {
      id
      name
    }
    reopenedScopeItem {
      id
      labelFa
      labelEn
      temporary
      decidedAt
      decidedNote
    }
    demoPage {
      id
      key
      labelFa
      labelEn
    }
    frameLine {
      id
      kind
      textFa
      textEn
    }
    anchorScopeItem {
      id
      labelFa
      labelEn
      temporary
      decidedAt
      decidedNote
    }
    comments {
      id
      body
      createdAt
      resolution
      approval
      approvedAt
      approvalNote
      originalBody
      approvedBy {
        id
        name
      }
      author {
        id
        name
      }
    }
    ticket {
      id
    }
  }
`;

/** Build plan L5 — reused by the contract workspace's own tab and the staff
 *  cross-project dashboard, so the two never silently ask for different
 *  shapes of the same row. */
export const DEPENDENCY_FIELDS = gql`
  fragment DependencyFields on Dependency {
    id
    side
    titleFa
    titleEn
    dueAt
    overdue
    createdAt
    createdBy {
      id
      name
    }
    verifiedAt
    verifiedNote
    verifiedBy {
      id
      name
    }
    briefKey
    technical
  }
`;

/** One shape for the detail screen, so every mutation can return it whole. */
/**
 * The wizard's derived views (journeys build plan J3), kept out of
 * `ContractFields` because the list query and every mutation would otherwise
 * pay for them on each row. Selected by the detail, view-as-customer and
 * workspace queries, and by the mutations whose result those screens show, so
 * the status area moves with each act instead of being refetched.
 */
export const WIZARD_FIELDS = gql`
  fragment WizardFields on Contract {
    id
    sequence
    wizard {
      step
      phaseId
      phaseNumber
      status
      locked
      lockedAt
      takesInput
      iterationsUsed
      allowance
      finishedAt
    }
    buildTimeline {
      phaseId
      number
      titleFa
      titleEn
      plannedEndAt
      demoPublishedAt
      acceptedAt
      builds {
        id
        number
        publishedAt
      }
    }
    statusSummary {
      started
      agreementApprovedAt
      signedAt
      startedAt
      currentStep
      currentPhaseId
      currentPhaseNumber
      nextMoveOn
      waitingOnRoot
      waitingOnCustomer
      plannedStartAt
      plannedEndAt
      overdueCount
      lastProgressAt
      daysSinceProgress
    }
    attention {
      kind
      variant
      contractId
      phaseId
      waitingOn
      role
      since
      params {
        key
        value
      }
    }
    timeline {
      id
      at
      kind
      by
      step
      phaseNumber
      number
    }
    brief {
      id
      kind
      existingSiteUrl
      templateType {
        id
        slug
        labelFa
        labelEn
      }
      designTier
      budgetCap
      idealDeadline
      hardDeadline
      domainName
      domainProvidedBy
      hostProvidedBy
      contentProvidedBy
      supportMonths
      premadeRounds
      wireframeIterations
      mockupIterations
      demoIterationsPerPhase
      updatedAt
    }
    briefCompleteness {
      code
      key
    }
    concepts {
      id
      themeSnapshot {
        name
        vendor
        demoUrl
      }
    }
    palette {
      id
      kind
      role
      value
      labelFa
      labelEn
      imageUrl
      position
    }
    designMissing
    scopeProposals {
      id
      kind
      requestedKind
      text
      lang
      createdAt
      decidedAt
      decision
      declineReason
      scopeItem {
        id
        key
        labelFa
        labelEn
        kind
        status
      }
      createdItem {
        id
        key
        labelFa
        labelEn
        kind
      }
      proposedBy {
        id
        name
      }
    }
    plannedStartAt
    plannedEndAt
    paymentPlan {
      id
      split
      total
      invoices {
        id
        ordinal
        labelFa
        labelEn
        amount
        phaseId
        paymentTermDays
      }
    }
    phases {
      id
      number
      titleFa
      titleEn
      contractId
      plannedEndAt
    }
  }
`;

export const CONTRACT_FIELDS = gql`
  ${FEEDBACK_ITEM_FIELDS}
  ${DEPENDENCY_FIELDS}
  fragment ContractFields on Contract {
    id
    ref
    titleFa
    titleEn
    sequence
    status
    amount
    publishedAt
    updatedAt
    customer {
      id
      name
      clientName
    }
    gate {
      designComplete
      contractApproved
      signed
      approvedPageCount
      totalPageCount
    }
    concepts {
      id
      key
      labelFa
      labelEn
      imageUrl
      chosen
      pages {
        id
        key
        labelFa
        labelEn
        imageUrl
        approved
      }
    }
    scopeItems {
      id
      key
      labelFa
      labelEn
      position
      checked
      status
      temporary
      outOfScope
      adminWork
      decidedAt
      decidedNote
      declinedReason
      originNote
      originRound
      phaseId
      kind
      contractId
    }
    project {
      id
      scopeTrades {
        id
        proposedAt
        rootConfirmedAt
        customerConfirmedAt
        executedAt
        proposedBy {
          id
          name
        }
        outItem {
          id
          key
          labelFa
          labelEn
          status
          contractId
        }
        inItem {
          id
          key
          labelFa
          labelEn
          status
          contractId
        }
      }
      progress {
        totalPhases
        currentPhaseNumber
        currentPhaseTitleFa
        currentPhaseTitleEn
        itemsAcceptedInPhase
        itemsTotalInPhase
      }
      dependencies {
        ...DependencyFields
      }
      phases {
        id
        number
        titleFa
        titleEn
        contractId
        plannedEndAt
        milestoneLabel
        scopeItems {
          id
          key
          labelFa
          labelEn
          status
        }
        builds {
          id
          number
          ref
          publishedAt
          pageMapConfirmedAt
        }
        demos {
          id
          stagingUrl
          buildRef
          reviewWindowStart
          reviewWindowEnd
          publishedAt
          readyAt
          readyVerifiedBy {
            id
            name
          }
          pages {
            id
            key
            labelFa
            labelEn
            canonicalPath
            pageDesign {
              id
              key
              imageUrl
            }
          }
          unmatchedPaths {
            id
            normalizedPath
            firstSeenAt
            lastSeenAt
            count
          }
          frame {
            id
            summaryFa
            summaryEn
            authoredBy {
              id
              name
            }
            unpromptedChanges {
              id
              note
              noteLang
            }
            lines {
              id
              kind
              textFa
              textEn
              position
              scopeItem {
                id
                labelFa
                labelEn
                temporary
                decidedAt
                decidedNote
              }
              feedbackItem {
                ...FeedbackItemFields
              }
            }
          }
          feedbackItems {
            ...FeedbackItemFields
          }
        }
      }
    }
    articles {
      id
      number
      titleFa
      titleEn
      bodyFa
      bodyEn
      sensitive
    }
    agreedScopeItems {
      key
      labelFa
      labelEn
      kind
    }
    comments {
      id
      target
      body
      createdAt
      author {
        id
        name
      }
    }
    changeLog {
      id
      action
      arg
      createdAt
      actor {
        id
        name
      }
    }
    signature {
      id
      typedName
      signedAt
    }
    revision {
      id
      version
      titleFa
      titleEn
      amount
      contentHash
      publishedAt
      approvedAt
      format
      agreement {
        brief {
          kind
          existingSiteUrl
          templateType {
            slug
            labelFa
            labelEn
          }
          designTier
          budgetCap
          idealDeadline
          hardDeadline
          domainName
          domainProvidedBy
          hostProvidedBy
          contentProvidedBy
          supportMonths
        }
        allowances {
          premadeRounds
          wireframeIterations
          mockupIterations
          demoIterationsPerPhase
        }
        paymentPlan {
          split
          total
          invoices {
            ordinal
            labelFa
            labelEn
            amount
            phaseNumber
            paymentTermDays
          }
        }
        phases {
          number
          titleFa
          titleEn
          plannedEndAt
          milestoneLabel
        }
        plannedStartAt
        plannedEndAt
      }
      signature {
        id
        typedName
        signedAt
      }
      amendments {
        id
        ordinal
        titleFa
        titleEn
        bodyFa
        bodyEn
        sensitive
        contentHash
        relatesToArticle
        publishedAt
        approvedAt
        signature {
          id
          typedName
          signedAt
        }
      }
    }
    contractRevisions {
      id
      version
      contentHash
      publishedAt
      approvedAt
      supersededAt
      signedAt
      amendmentCount
    }
    designRevisions {
      id
      version
      publishedAt
      supersededAt
      conceptCount
      pageCount
    }
    pending {
      contractDiff {
        fromVersion
        toVersion
        titleChanged
        amountChanged
        articles {
          number
          titleFa
          titleEn
          kind
        }
      }
      designChanges {
        conceptKey
        pageKey
        kind
      }
      amendment {
        id
        ordinal
        titleFa
        titleEn
        bodyFa
        bodyEn
        sensitive
        contentHash
        relatesToArticle
        publishedAt
        approvedAt
        signature {
          id
          typedName
          signedAt
        }
      }
    }
  }
`;

/**
 * The workspace's own shape: everything a customer's `ContractFields` gets,
 * plus the staff-only fields V1b put on the wire and V2 finally reads. Kept
 * separate on purpose (V1b §3.4) — a customer's query never asks for these,
 * and a fragment that selected them anyway would carry four extra nulls on
 * every customer request.
 */
export const CONTRACT_WORKSPACE_FIELDS = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  fragment ContractWorkspaceFields on Contract {
    ...ContractFields
    ...WizardFields
    internalNotes {
      id
      body
      createdAt
      author {
        id
        name
      }
    }
    request {
      id
      status
    }
    designer {
      id
      name
    }
    developer {
      id
      name
    }
    draft {
      titleFa
      titleEn
      amount
      contentHash
      dirty
      articles {
        id
        number
        titleFa
        titleEn
        bodyFa
        bodyEn
        sensitive
      }
    }
    allowanceExtensions {
      id
      step
      phaseId
      extra
      reason
      charge
      createdAt
      approvedBy {
        id
        name
      }
    }
    designDraft {
      id
      version
      concepts {
        id
        key
        labelFa
        labelEn
        imageUrl
        chosen
        themeId
        themeSnapshot {
          name
          vendor
          demoUrl
        }
        pages {
          id
          key
          labelFa
          labelEn
          imageUrl
          approved
        }
      }
      palette {
        id
        kind
        role
        value
        labelFa
        labelEn
        imageUrl
        position
      }
      carryForward {
        chosenConceptKey
        carriedPageCount
        resetPageCount
        changes {
          conceptKey
          pageKey
          kind
        }
      }
    }
  }
`;

export const CONTRACT_WORKSPACE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  query ContractWorkspace($id: ID!) {
    contract(id: $id) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ME = gql`
  ${USER_FIELDS}
  query Me {
    me {
      ...UserFields
    }
  }
`;

export const MY_CONTRACTS = gql`
  ${CONTRACT_FIELDS}
  query MyContracts {
    myContracts {
      ...ContractFields
    }
  }
`;

export const REQUEST_FIELDS = gql`
  fragment RequestFields on Request {
    id
    title
    body
    lang
    status
    requestedAt
    archivedAt
    archivedReason
    contractId
    customer {
      id
      name
      clientName
    }
    messages {
      id
      body
      createdAt
      author {
        id
        name
        clientName
      }
    }
  }
`;

export const CONTRACT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  ${REQUEST_FIELDS}
  query Contract($id: ID!) {
    contract(id: $id) {
      ...ContractFields
      ...WizardFields
      request {
        ...RequestFields
      }
    }
  }
`;

/**
 * View as customer (journeys build plan J3): the same fragments as the
 * portal's own detail query, with the one argument that changes who the API
 * reads through. No field is added or dropped here — that is the point: the
 * screen it feeds is the portal's, and this query is byte-for-byte what a
 * customer's would be.
 */
export const CONTRACT_AS_CUSTOMER = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  ${REQUEST_FIELDS}
  query ContractAsCustomer($id: ID!) {
    contract(id: $id, asCustomer: true) {
      ...ContractFields
      ...WizardFields
      request {
        ...RequestFields
      }
    }
  }
`;

// --- Journeys build plan J11: step 7, the summary, the handover, the close ------

export type SummaryItem = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  kind: ScopeKind;
  status: ScopeStatus;
  phaseNumber: number | null;
  inAgreement: boolean;
  declinedReason: string | null;
  tradePartner: { direction: 'OUT' | 'IN'; key: string; labelFa: string; labelEn: string; executedAt: string } | null;
  handedOverAt: string | null;
  handedOverBy: string | null;
  handoverNote: string | null;
};

export type ContractSummary = {
  deliveredAt: string | null;
  deliveredBy: string | null;
  agreed: {
    version: number;
    contentHash: string | null;
    signedAt: string;
    scopeItems: Array<{ key: string; labelFa: string; labelEn: string; kind: ScopeKind | null }>;
    agreement: ContractRevision['agreement'];
    amendments: Array<{
      id: string;
      ordinal: number;
      titleFa: string;
      titleEn: string;
      publishedAt: string | null;
      signature: { typedName: string; signedAt: string } | null;
    }>;
    trades: Array<{
      executedAt: string;
      out: { key: string; labelFa: string; labelEn: string };
      in: { key: string; labelFa: string; labelEn: string };
    }>;
  };
  items: SummaryItem[];
  unpromptedChanges: Array<{
    id: string;
    step: StepKind;
    buildNumber: number;
    publishedAt: string;
    textFa: string | null;
    textEn: string | null;
    note: string | null;
    noteLang: string | null;
    writtenUp: boolean;
  }>;
  steps: Array<{
    step: StepKind;
    phaseId: string | null;
    phaseNumber: number | null;
    iterationsUsed: number | null;
    allowance: number | null;
    extensions: number;
    finishedAt: string | null;
  }>;
  dates: {
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    signedAt: string | null;
    startedAt: string | null;
    deliveredAt: string | null;
    phases: Array<{ number: number; titleFa: string; titleEn: string; plannedEndAt: string | null; acceptedAt: string | null }>;
  };
  invoices: { count: number; paidCount: number; issued: string; paid: string; outstanding: string } | null;
  support: { months: number; from: string | null; until: string | null } | null;
};

export type Delivery = {
  deliveredAt: string | null;
  closable: boolean;
  noPhases: boolean;
  phasesNotAccepted: number[];
  deliverablesPending: string[];
};

export type SummaryContract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  customer: { id: string; name: string; clientName: string | null };
  deliveredAt: string | null;
  delivery: Delivery;
  summary: ContractSummary | null;
};

export const SUMMARY_FIELDS = gql`
  fragment SummaryFields on Contract {
    id
    ref
    titleFa
    titleEn
    deliveredAt
    customer {
      id
      name
      clientName
    }
    delivery {
      deliveredAt
      closable
      noPhases
      phasesNotAccepted
      deliverablesPending
    }
    summary {
      deliveredAt
      deliveredBy
      agreed {
        version
        contentHash
        signedAt
        scopeItems {
          key
          labelFa
          labelEn
          kind
        }
        agreement {
          brief {
            kind
            templateType {
              slug
              labelFa
              labelEn
            }
            designTier
            budgetCap
            hardDeadline
            supportMonths
          }
          paymentPlan {
            total
          }
          phases {
            number
            titleFa
            titleEn
            plannedEndAt
          }
          plannedStartAt
          plannedEndAt
        }
        amendments {
          id
          ordinal
          titleFa
          titleEn
          publishedAt
          signature {
            typedName
            signedAt
          }
        }
        trades {
          executedAt
          out {
            key
            labelFa
            labelEn
          }
          in {
            key
            labelFa
            labelEn
          }
        }
      }
      items {
        id
        key
        labelFa
        labelEn
        kind
        status
        phaseNumber
        inAgreement
        declinedReason
        tradePartner {
          direction
          key
          labelFa
          labelEn
          executedAt
        }
        handedOverAt
        handedOverBy
        handoverNote
      }
      unpromptedChanges {
        id
        step
        buildNumber
        publishedAt
        textFa
        textEn
        note
        noteLang
        writtenUp
      }
      steps {
        step
        phaseId
        phaseNumber
        iterationsUsed
        allowance
        extensions
        finishedAt
      }
      dates {
        plannedStartAt
        plannedEndAt
        signedAt
        startedAt
        deliveredAt
        phases {
          number
          titleFa
          titleEn
          plannedEndAt
          acceptedAt
        }
      }
      invoices {
        count
        paidCount
        issued
        paid
        outstanding
      }
      support {
        months
        from
        until
      }
    }
  }
`;

/** The summary and the close, for one contract — as the signed-in viewer, or (with
 *  `asCustomer`) as the customer would read it. */
export const CONTRACT_SUMMARY = gql`
  ${SUMMARY_FIELDS}
  query ContractSummary($id: ID!, $asCustomer: Boolean) {
    contract(id: $id, asCustomer: $asCustomer) {
      ...SummaryFields
    }
  }
`;

export const MARK_HANDED_OVER = gql`
  mutation MarkHandedOver($scopeItemId: ID!, $note: String!) {
    markHandedOver(scopeItemId: $scopeItemId, note: $note) {
      id
      delivery {
        deliveredAt
        closable
        noPhases
        phasesNotAccepted
        deliverablesPending
      }
    }
  }
`;

export const UNMARK_HANDED_OVER = gql`
  mutation UnmarkHandedOver($scopeItemId: ID!) {
    unmarkHandedOver(scopeItemId: $scopeItemId) {
      id
      delivery {
        deliveredAt
        closable
        noPhases
        phasesNotAccepted
        deliverablesPending
      }
    }
  }
`;

/** Closing moves the status, the wizard (SUMMARY is done) and the timeline at once. */
export const CLOSE_CONTRACT = gql`
  ${SUMMARY_FIELDS}
  ${WIZARD_FIELDS}
  mutation CloseContract($contractId: ID!) {
    closeContract(contractId: $contractId) {
      ...SummaryFields
      ...WizardFields
      status
    }
  }
`;

export const ADD_INTERNAL_NOTE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddInternalNote($contractId: ID!, $body: String!) {
    addInternalNote(contractId: $contractId, body: $body) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SIGN_IN = gql`
  ${USER_FIELDS}
  mutation SignIn($identifier: String!, $password: String!) {
    signIn(identifier: $identifier, password: $password) {
      user {
        ...UserFields
      }
      factorChallengeId
    }
  }
`;

export const VERIFY_SIGN_IN_FACTOR = gql`
  ${USER_FIELDS}
  mutation VerifySignInFactor($challengeId: String!, $code: String!) {
    verifySignInFactor(challengeId: $challengeId, code: $code) {
      user {
        ...UserFields
      }
    }
  }
`;

export const REQUEST_LOGIN_CODE = gql`
  mutation RequestLoginCode($phone: String!) {
    requestLoginCode(phone: $phone)
  }
`;

export const VERIFY_LOGIN_CODE = gql`
  ${USER_FIELDS}
  mutation VerifyLoginCode($phone: String!, $code: String!) {
    verifyLoginCode(phone: $phone, code: $code) {
      user {
        ...UserFields
      }
    }
  }
`;

export const SET_NEW_PASSWORD = gql`
  ${USER_FIELDS}
  mutation SetNewPassword($password: String!) {
    setNewPassword(password: $password) {
      user {
        ...UserFields
      }
    }
  }
`;

export const SIGN_OUT = gql`
  mutation SignOut {
    signOut
  }
`;

export const ACCEPT_INVITE = gql`
  ${USER_FIELDS}
  mutation AcceptInvite($token: String!, $name: String!, $password: String!) {
    acceptInvite(token: $token, name: $name, password: $password) {
      user {
        ...UserFields
      }
    }
  }
`;

export const REQUEST_RESET = gql`
  mutation RequestPasswordReset($email: String!) {
    requestPasswordReset(email: $email)
  }
`;

export const RESET_PASSWORD = gql`
  ${USER_FIELDS}
  mutation ResetPassword($token: String!, $password: String!) {
    resetPassword(token: $token, password: $password) {
      user {
        ...UserFields
      }
    }
  }
`;

export const CHOOSE_CONCEPT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ChooseConcept($contractId: ID!, $conceptId: ID!) {
    chooseConcept(contractId: $contractId, conceptId: $conceptId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const SET_PAGE_APPROVAL = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation SetPageApproval($pageDesignId: ID!, $approved: Boolean!) {
    setPageApproval(pageDesignId: $pageDesignId, approved: $approved) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const APPROVE_CONTRACT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ApproveContract($contractId: ID!) {
    approveContract(contractId: $contractId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const SET_SCOPE_ITEM = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation SetScopeItem($scopeItemId: ID!, $checked: Boolean!, $contractId: ID) {
    setScopeItem(scopeItemId: $scopeItemId, checked: $checked, contractId: $contractId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const SIGN_CONTRACT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation SignContract($contractId: ID!, $typedName: String!) {
    signContract(contractId: $contractId, typedName: $typedName) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const ADD_COMMENT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation AddComment($contractId: ID!, $body: String!, $target: CommentTarget) {
    addComment(contractId: $contractId, body: $body, target: $target) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const ALL_CONTRACTS = gql`
  ${CONTRACT_FIELDS}
  query AllContracts {
    allContracts {
      ...ContractFields
      # J3: the list sales works from shows the current step and whose move it
      # is beside the status. Only the three fields it prints — the cache merges
      # this into the fuller StatusSummary the workspace fetches.
      statusSummary {
        currentStep
        currentPhaseNumber
        nextMoveOn
      }
    }
  }
`;

export const ALL_CUSTOMERS = gql`
  ${USER_FIELDS}
  query AllCustomers {
    allCustomers {
      ...UserFields
    }
  }
`;

/**
 * Journeys build plan S3 — the customer page and the Users place's first slice
 * (PD-12). One shape, `CustomerProfile`, for the page and for both tool
 * mutations (they return it, so Apollo's cache is right without a refetch).
 */
export type ToolKey = 'PRODUCT_IMPORT';

export type CustomerProfile = {
  id: string;
  user: User;
  grants: Array<{ id: string; tool: ToolKey; grantedAt: string; grantedBy: Pick<User, 'id' | 'name'> }>;
  contracts: Array<Pick<Contract, 'id' | 'ref' | 'titleFa' | 'titleEn' | 'status' | 'amount' | 'publishedAt'>>;
  tickets: Array<{
    id: string;
    subject: string;
    status: TicketStatus;
    urgency: TicketUrgency;
    type: TicketType;
    createdAt: string;
  }>;
  /** Null without `money.read` — never zero, which would read as "owes nothing". */
  invoices: { totalIssued: string; totalPaid: string; totalOutstanding: string } | null;
};

const CUSTOMER_PROFILE_FIELDS = gql`
  ${USER_FIELDS}
  fragment CustomerProfileFields on CustomerProfile {
    id
    user {
      ...UserFields
    }
    grants {
      id
      tool
      grantedAt
      grantedBy {
        id
        name
      }
    }
    contracts {
      id
      ref
      titleFa
      titleEn
      status
      amount
      publishedAt
    }
    tickets {
      id
      subject
      status
      urgency
      type
      createdAt
    }
    invoices {
      totalIssued
      totalPaid
      totalOutstanding
    }
  }
`;

/** `customers.manage`. Null for an id that is not a customer. */
export const CUSTOMER_PROFILE = gql`
  ${CUSTOMER_PROFILE_FIELDS}
  query CustomerProfile($id: ID!) {
    customer(id: $id) {
      ...CustomerProfileFields
    }
  }
`;

export const GRANT_TOOL = gql`
  ${CUSTOMER_PROFILE_FIELDS}
  mutation GrantTool($customerId: ID!, $tool: ToolKey!) {
    grantTool(customerId: $customerId, tool: $tool) {
      ...CustomerProfileFields
    }
  }
`;

export const REVOKE_TOOL = gql`
  ${CUSTOMER_PROFILE_FIELDS}
  mutation RevokeTool($customerId: ID!, $tool: ToolKey!) {
    revokeTool(customerId: $customerId, tool: $tool) {
      ...CustomerProfileFields
    }
  }
`;

/** Disable or restore. `customers.manage` for a customer, `staff.manage` for anyone with a staff role. */
export const SET_USER_STATE = gql`
  ${USER_FIELDS}
  mutation SetUserState($userId: ID!, $state: UserState!) {
    setUserState(userId: $userId, state: $state) {
      ...UserFields
    }
  }
`;

/** `staff.manage`. Every account, customers included. */
export const ALL_USERS = gql`
  ${USER_FIELDS}
  query AllUsers {
    allUsers {
      ...UserFields
    }
  }
`;

export const INVITE_STAFF = gql`
  mutation InviteStaff($name: String!, $roles: [Role!]!, $phone: String, $email: String) {
    inviteStaff(name: $name, roles: $roles, phone: $phone, email: $email) {
      userId
      email
      inviteUrl
      expiresAt
    }
  }
`;

export const SET_USER_ROLES = gql`
  ${USER_FIELDS}
  mutation SetUserRoles($userId: ID!, $roles: [Role!]!) {
    setUserRoles(userId: $userId, roles: $roles) {
      ...UserFields
    }
  }
`;

/** The tools the caller may use — feeds the portal rail's Tools item. */
export const MY_TOOLS = gql`
  query MyTools {
    myTools
  }
`;

/** Journeys build plan S1 — the two jobs `assignContract` accepts. */
export type AssignmentJob = 'DESIGN' | 'BUILD';

/**
 * Who `assignContract` would accept for a job — the active accounts holding
 * `design.author` (DESIGN) or `builds.author` (BUILD). Feeds the create-
 * contract form's two optional pickers and the workspace header's own
 * change control, so the list offered and the mutation's own refusal can
 * never disagree.
 */
export const ASSIGNABLE_USERS = gql`
  ${USER_FIELDS}
  query AssignableUsers($job: AssignmentJob!) {
    assignableUsers(job: $job) {
      ...UserFields
    }
  }
`;

export type StatusCount = {
  status: ContractStatus;
  count: number;
};

/** A contract, thin — the desk's Overview reads these rather than full Contracts (V4 T1). */
export type ContractRef = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  status: ContractStatus;
  customerName: string;
  statusChangedAt: string;
};

export type ActivityItem = {
  id: string;
  contract: ContractRef;
  actor: Pick<User, 'id' | 'name'>;
  action: ChangeAction;
  arg: string | null;
  createdAt: string;
};

export const ALL_CONTRACT_STATUS_COUNTS = gql`
  query AllContractStatusCounts {
    allContractStatusCounts {
      status
      count
    }
  }
`;

const CONTRACT_REF_FIELDS = gql`
  fragment ContractRefFields on ContractRef {
    id
    ref
    titleFa
    titleEn
    status
    customerName
    statusChangedAt
  }
`;

/** One entry of the desk's Needs-Root queue (V4, re-pointed by J12): a contract,
 *  the oldest thing Root owes on it, and how many things are owed. */
export type NeedsRootEntry = { contract: ContractRef; since: string; count: number };

export const NEEDS_ROOT_QUEUE = gql`
  ${CONTRACT_REF_FIELDS}
  query NeedsRootQueue($limit: Int) {
    needsRootQueue(limit: $limit) {
      since
      count
      contract {
        ...ContractRefFields
      }
    }
  }
`;

/** How many contracts Root owes something on (change note 02): the Needs-Root
 *  queue's rule without its limit, for the Overview's "Waiting on Root" tile. */
export const NEEDS_ROOT_COUNT = gql`
  query NeedsRootCount {
    needsRootCount
  }
`;

/**
 * The home screens (journeys build plan J12): what is waiting on the signed-in
 * person, derived on every read by the API. The customer's dashboard and each
 * staff role's *My work* are this one list; `audience` picks the sentence set
 * (`attention.<kind>.<variant>.<customer|staff>`) and `route` is where the item
 * opens, without the language prefix.
 */
export type HomeItem = {
  kind: string;
  variant: string;
  audience: 'CUSTOMER' | 'STAFF';
  contractId: string | null;
  phaseId: string | null;
  waitingOn: WaitingOn;
  role: 'SALES' | 'DESIGNER' | 'DEVELOPER' | null;
  since: string;
  params: Array<{ key: string; value: string }>;
  route: string;
  subject: { ref: string | null; titleFa: string; titleEn: string; customerName: string };
};

export const MY_ATTENTION = gql`
  query MyAttention {
    myAttention {
      kind
      variant
      audience
      contractId
      phaseId
      waitingOn
      role
      since
      route
      params {
        key
        value
      }
      subject {
        ref
        titleFa
        titleEn
        customerName
      }
    }
  }
`;

/** The dashboard's standing "open the current contract": just enough of each of
 *  the customer's contracts to name one and to tell which is still being worked. */
export type ContractLink = Pick<Contract, 'id' | 'ref' | 'titleFa' | 'titleEn' | 'status' | 'sequence' | 'updatedAt'> & {
  deliveredAt: string | null;
};

export const MY_CONTRACT_LINKS = gql`
  query MyContractLinks {
    myContracts {
      id
      ref
      titleFa
      titleEn
      status
      sequence
      updatedAt
      deliveredAt
    }
  }
`;

export const ACTIVITY = gql`
  ${CONTRACT_REF_FIELDS}
  query Activity($limit: Int, $reviewOnly: Boolean) {
    activity(limit: $limit, reviewOnly: $reviewOnly) {
      id
      action
      arg
      createdAt
      actor {
        id
        name
      }
      contract {
        ...ContractRefFields
      }
    }
  }
`;

export const INVITE_CUSTOMER = gql`
  mutation InviteCustomer($phone: String!, $name: String!, $clientName: String, $email: String) {
    inviteCustomer(phone: $phone, name: $name, clientName: $clientName, email: $email) {
      userId
      email
      inviteUrl
      expiresAt
    }
  }
`;

/** PD-18 — the desk shell's own banner. Staff (staff.manage — ADMIN only). */
export const SMS_CONFIGURED = gql`
  query SmsConfigured {
    smsConfigured
  }
`;

export const PUBLISH_CONTRACT = gql`
  ${CONTRACT_FIELDS}
  mutation PublishContract($contractId: ID!) {
    publishContract(contractId: $contractId) {
      ...ContractFields
    }
  }
`;

// --- Step 1 — requirements (journeys build plan J4) ---

/** Hands step 1 to the customer is `PUBLISH_CONTRACT` above; these three write it. Each returns `Contract!` with the wizard's own fields, so the step's panel,
 *  the status area and the completeness list move with the write. */
export const SET_BRIEF = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetBrief($contractId: ID!, $input: BriefInput!) {
    setBrief(contractId: $contractId, input: $input) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_EXTRA = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetExtra($scopeItemId: ID!, $included: Boolean!, $contractId: ID) {
    setExtra(scopeItemId: $scopeItemId, included: $included, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_PAYMENT_PLAN = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetPaymentPlan($contractId: ID!, $split: PaymentSplit!, $invoices: [PlannedInvoiceInput!]!) {
    setPaymentPlan(contractId: $contractId, split: $split, invoices: $invoices) {
      ...ContractWorkspaceFields
    }
  }
`;

/** The shape `setBrief` takes — the form's whole state, dates as `YYYY-MM-DD`. */
export type BriefInput = {
  kind: BriefKind;
  existingSiteUrl?: string | null;
  templateTypeId: string;
  designTier: DesignTier;
  budgetCap?: string | null;
  idealDeadline?: string | null;
  hardDeadline?: string | null;
  domainName?: string | null;
  domainProvidedBy?: DependencySide | null;
  hostProvidedBy?: DependencySide | null;
  contentProvidedBy?: DependencySide | null;
  supportMonths?: number | null;
  premadeRounds?: number | null;
  wireframeIterations?: number | null;
  mockupIterations?: number | null;
  demoIterationsPerPhase?: number | null;
  commitments?: Array<{ key: string; side?: DependencySide | null; dueAt?: string | null }>;
};

export type PlannedInvoiceInput = {
  labelFa: string;
  labelEn: string;
  amount: string;
  phaseId?: string | null;
  paymentTermDays: number;
};

export const SET_CONTRACT_STATUS = gql`
  ${CONTRACT_FIELDS}
  mutation SetContractStatus($contractId: ID!, $status: ContractStatus!) {
    setContractStatus(contractId: $contractId, status: $status) {
      ...ContractFields
    }
  }
`;

// --- the contract workspace (V2) --------------------------------------------
//
// Every mutation below returns the whole workspace shape, matching the rest
// of the API's convention (T9 in V2.md): one reload keeps the gate, the
// status, the dirty flag and the carry-forward preview all consistent
// without the client recomputing any of them.

export const CREATE_CONTRACT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation CreateContract($input: CreateContractInput!) {
    createContract(input: $input) {
      ...ContractWorkspaceFields
    }
  }
`;

/**
 * Journeys build plan S1: sales changes who designs and who develops a
 * contract from the workspace header. An omitted argument leaves that side
 * unchanged; `null` unassigns it — the same convention `updateContractDraft`
 * uses for `amount`. Returns `Contract!` (the T9 convention), so Apollo's
 * cache updates without a refetch.
 */
export const ASSIGN_CONTRACT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AssignContract($contractId: ID!, $designerId: ID, $developerId: ID) {
    assignContract(contractId: $contractId, designerId: $designerId, developerId: $developerId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const APPLY_CONTRACT_TEMPLATE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ApplyContractTemplate($contractId: ID!) {
    applyContractTemplate(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_CONTRACT_DRAFT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateContractDraft($contractId: ID!, $titleFa: String!, $titleEn: String!, $amount: String) {
    updateContractDraft(contractId: $contractId, titleFa: $titleFa, titleEn: $titleEn, amount: $amount) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_ARTICLE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetArticle($contractId: ID!, $number: Int!, $titleFa: String!, $titleEn: String!, $bodyFa: String, $bodyEn: String, $sensitive: Boolean) {
    setArticle(contractId: $contractId, number: $number, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn, sensitive: $sensitive) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_ARTICLE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteArticle($contractId: ID!, $number: Int!) {
    deleteArticle(contractId: $contractId, number: $number) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PUBLISH_CONTRACT_REVISION = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation PublishContractRevision($contractId: ID!) {
    publishContractRevision(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ADD_CONCEPT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddConcept($contractId: ID!, $key: String!, $labelFa: String!, $labelEn: String!) {
    addConcept(contractId: $contractId, key: $key, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_CONCEPT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateConcept($conceptId: ID!, $labelFa: String!, $labelEn: String!) {
    updateConcept(conceptId: $conceptId, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_CONCEPT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteConcept($conceptId: ID!) {
    deleteConcept(conceptId: $conceptId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ADD_PAGE_DESIGN = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddPageDesign($conceptId: ID!, $key: String!, $labelFa: String!, $labelEn: String!) {
    addPageDesign(conceptId: $conceptId, key: $key, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_PAGE_DESIGN = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdatePageDesign($pageId: ID!, $labelFa: String!, $labelEn: String!) {
    updatePageDesign(pageId: $pageId, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_PAGE_DESIGN = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeletePageDesign($pageId: ID!) {
    deletePageDesign(pageId: $pageId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_CONCEPT_IMAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetConceptImage($conceptId: ID!, $fileId: ID) {
    setConceptImage(conceptId: $conceptId, fileId: $fileId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_PAGE_IMAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetPageImage($pageId: ID!, $fileId: ID) {
    setPageImage(pageId: $pageId, fileId: $fileId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DISCARD_DESIGN_DRAFT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DiscardDesignDraft($contractId: ID!) {
    discardDesignDraft(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PUBLISH_DESIGN_REVISION = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation PublishDesignRevision($contractId: ID!) {
    publishDesignRevision(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

// --- Step 4, design (journeys build plan J8) --------------------------------------
//
// The designer's writes return the whole workspace contract (T9), so the step
// panel — which reads `designDraft`, `concepts`, `palette`, `wizard` — moves
// with each act. The customer's return the customer's fields.

export const START_DESIGN_DRAFT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation StartDesignDraft($contractId: ID!) {
    startDesignDraft(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PROPOSE_THEMES = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ProposeThemes($contractId: ID!, $themeIds: [ID!]!) {
    proposeThemes(contractId: $contractId, themeIds: $themeIds) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ADD_PALETTE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddPaletteItem($contractId: ID!, $kind: PaletteKind!, $role: String!, $value: String!, $labelFa: String!, $labelEn: String!) {
    addPaletteItem(contractId: $contractId, kind: $kind, role: $role, value: $value, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_PALETTE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdatePaletteItem($itemId: ID!, $value: String!, $labelFa: String!, $labelEn: String!) {
    updatePaletteItem(itemId: $itemId, value: $value, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_PALETTE_ITEM_IMAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetPaletteItemImage($itemId: ID!, $fileId: ID) {
    setPaletteItemImage(itemId: $itemId, fileId: $fileId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_PALETTE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeletePaletteItem($itemId: ID!) {
    deletePaletteItem(itemId: $itemId) {
      ...ContractWorkspaceFields
    }
  }
`;

/** Sales admits more rounds (journeys Q-S5), optionally billed as a draft invoice. */
export const EXTEND_ALLOWANCE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ExtendAllowance($contractId: ID!, $step: StepKind!, $phaseId: ID, $extra: Int!, $reason: String!, $charge: String) {
    extendAllowance(contractId: $contractId, step: $step, phaseId: $phaseId, extra: $extra, reason: $reason, charge: $charge) {
      ...ContractWorkspaceFields
    }
  }
`;

/** The customer asks to see other options (pre-made). */
export const REQUEST_OTHER_OPTIONS = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation RequestOtherOptions($contractId: ID!, $note: String) {
    requestOtherOptions(contractId: $contractId, note: $note) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

/** The customer approves the design — `approveStepTx(DESIGN)` with the path's completeness. */
export const APPROVE_DESIGN = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ApproveDesign($contractId: ID!) {
    approveDesign(contractId: $contractId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const ADD_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddScopeItem($contractId: ID!, $key: String!, $labelFa: String!, $labelEn: String!) {
    addScopeItem(contractId: $contractId, key: $key, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateScopeItem($scopeItemId: ID!, $labelFa: String!, $labelEn: String!, $contractId: ID) {
    updateScopeItem(scopeItemId: $scopeItemId, labelFa: $labelFa, labelEn: $labelEn, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteScopeItem($scopeItemId: ID!, $contractId: ID) {
    deleteScopeItem(scopeItemId: $scopeItemId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_SCOPE_ITEM_STATUS = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetScopeItemStatus($scopeItemId: ID!, $status: ScopeStatus!, $reason: String, $contractId: ID) {
    setScopeItemStatus(scopeItemId: $scopeItemId, status: $status, reason: $reason, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const SET_SCOPE_ITEM_FLAGS = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetScopeItemFlags($scopeItemId: ID!, $temporary: Boolean!, $outOfScope: Boolean!, $adminWork: Boolean!, $contractId: ID) {
    setScopeItemFlags(scopeItemId: $scopeItemId, temporary: $temporary, outOfScope: $outOfScope, adminWork: $adminWork, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DECIDE_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DecideScopeItem($scopeItemId: ID!, $note: String!, $contractId: ID) {
    decideScopeItem(scopeItemId: $scopeItemId, note: $note, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UNDECIDE_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UndecideScopeItem($scopeItemId: ID!, $contractId: ID) {
    undecideScopeItem(scopeItemId: $scopeItemId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const REORDER_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ReorderScopeItem($scopeItemId: ID!, $direction: ScopeMoveDirection!, $contractId: ID) {
    reorderScopeItem(scopeItemId: $scopeItemId, direction: $direction, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PROPOSE_SCOPE_TRADE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ProposeScopeTrade($projectId: ID!, $outItemId: ID!, $inKey: String!, $inLabelFa: String!, $inLabelEn: String!, $contractId: ID) {
    proposeScopeTrade(projectId: $projectId, outItemId: $outItemId, inKey: $inKey, inLabelFa: $inLabelFa, inLabelEn: $inLabelEn, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const CONFIRM_SCOPE_TRADE_ROOT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ConfirmScopeTradeRoot($tradeId: ID!, $contractId: ID) {
    confirmScopeTradeRoot(tradeId: $tradeId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

// --- Phases and the live demo surface (build plan L2) -----------------------

export const CREATE_PHASE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation CreatePhase($contractId: ID!, $number: Int!, $titleFa: String!, $titleEn: String!, $milestoneLabel: String, $plannedEndAt: String) {
    createPhase(contractId: $contractId, number: $number, titleFa: $titleFa, titleEn: $titleEn, milestoneLabel: $milestoneLabel, plannedEndAt: $plannedEndAt) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_PHASE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdatePhase($phaseId: ID!, $titleFa: String!, $titleEn: String!, $milestoneLabel: String, $plannedEndAt: String, $contractId: ID) {
    updatePhase(phaseId: $phaseId, titleFa: $titleFa, titleEn: $titleEn, milestoneLabel: $milestoneLabel, plannedEndAt: $plannedEndAt, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_PHASE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeletePhase($phaseId: ID!, $contractId: ID) {
    deletePhase(phaseId: $phaseId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ASSIGN_SCOPE_ITEM_TO_PHASE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AssignScopeItemToPhase($scopeItemId: ID!, $phaseId: ID, $contractId: ID) {
    assignScopeItemToPhase(scopeItemId: $scopeItemId, phaseId: $phaseId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const CREATE_DEMO = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation CreateDemo($phaseId: ID!, $stagingUrl: String!, $buildRef: String, $contractId: ID) {
    createDemo(phaseId: $phaseId, stagingUrl: $stagingUrl, buildRef: $buildRef, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_DEMO = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateDemo($demoId: ID!, $stagingUrl: String, $buildRef: String, $reviewWindowStart: DateTime, $reviewWindowEnd: DateTime, $contractId: ID) {
    updateDemo(demoId: $demoId, stagingUrl: $stagingUrl, buildRef: $buildRef, reviewWindowStart: $reviewWindowStart, reviewWindowEnd: $reviewWindowEnd, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_DEMO = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteDemo($demoId: ID!, $contractId: ID) {
    deleteDemo(demoId: $demoId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DECLARE_DEMO_PAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeclareDemoPage($demoId: ID!, $key: String!, $labelFa: String!, $labelEn: String!, $canonicalPath: String!, $pageDesignId: ID, $contractId: ID) {
    declareDemoPage(demoId: $demoId, key: $key, labelFa: $labelFa, labelEn: $labelEn, canonicalPath: $canonicalPath, pageDesignId: $pageDesignId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_DEMO_PAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateDemoPage($demoPageId: ID!, $labelFa: String!, $labelEn: String!, $canonicalPath: String!, $pageDesignId: ID, $contractId: ID) {
    updateDemoPage(demoPageId: $demoPageId, labelFa: $labelFa, labelEn: $labelEn, canonicalPath: $canonicalPath, pageDesignId: $pageDesignId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_DEMO_PAGE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteDemoPage($demoPageId: ID!, $contractId: ID) {
    deleteDemoPage(demoPageId: $demoPageId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

/**
 * The reporter snippet's own call, relayed by the viewport frame
 * (components/DemoViewport.tsx) whenever it accepts a page-change message.
 * Returns a thin payload, not the whole contract (typeDefs' own comment) —
 * this fires on every navigation inside the framed site, staff or customer.
 */
export const REPORT_DEMO_PATH = gql`
  mutation ReportDemoPath($demoId: ID!, $path: String!) {
    reportDemoPath(demoId: $demoId, path: $path) {
      matched
      normalizedPath
      page {
        id
        key
        labelFa
        labelEn
        canonicalPath
        pageDesign {
          id
          key
          imageUrl
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Review frames and feedback intake (build plan L3; spec §6). The frame
// mutations follow T9 like every other registry/phase mutation (whole
// Contract back); submitFeedback returns FeedbackSubmitResult instead — the
// interception result is not a Contract-shaped fact — so the caller refetches
// the contract query itself after a first, non-intercepted submission (see
// ContractDetail.tsx / PhasesTab.tsx). (ratifyFeedback and acceptFeedback are
// gone — S2, PD-2: a submission is its own ratification.)
// ---------------------------------------------------------------------------

export const GENERATE_DEMO_FRAME = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation GenerateDemoFrame($demoId: ID!, $contractId: ID) {
    generateDemoFrame(demoId: $demoId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_DEMO_FRAME_SUMMARY = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateDemoFrameSummary($demoId: ID!, $summaryFa: String, $summaryEn: String, $contractId: ID) {
    updateDemoFrameSummary(demoId: $demoId, summaryFa: $summaryFa, summaryEn: $summaryEn, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ADD_DEMO_FRAME_LINE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation AddDemoFrameLine($demoId: ID!, $kind: DemoFrameLineKind!, $textFa: String!, $textEn: String!, $buildChangeEntryId: ID, $contractId: ID) {
    addDemoFrameLine(demoId: $demoId, kind: $kind, textFa: $textFa, textEn: $textEn, buildChangeEntryId: $buildChangeEntryId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_DEMO_FRAME_LINE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateDemoFrameLine($lineId: ID!, $textFa: String!, $textEn: String!, $contractId: ID) {
    updateDemoFrameLine(lineId: $lineId, textFa: $textFa, textEn: $textEn, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_DEMO_FRAME_LINE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteDemoFrameLine($lineId: ID!, $contractId: ID) {
    deleteDemoFrameLine(lineId: $lineId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PUBLISH_DEMO = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation PublishDemo($demoId: ID!, $contractId: ID) {
    publishDemo(demoId: $demoId, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export type FeedbackTargetInput = {
  general?: boolean;
  briefField?: string;
  scopeItemId?: string;
  contractRevisionId?: string;
  articleNumber?: number;
  designRevisionId?: string;
  conceptId?: string;
  pageDesignId?: string;
  paletteItemId?: string;
  demoId?: string;
  demoPageId?: string;
  frameLineId?: string;
};

/**
 * Journeys build plan S2: one submit for every step. The contract's own
 * customer only; `target` names the anchor and `phaseId` the phase of a DEMO.
 * Returns FeedbackSubmitResult, not Contract!, for the same reason as before —
 * an interception is not a Contract-shaped fact, and a brand-new item has
 * nowhere for the normalized cache to put itself — so the caller refetches.
 */
export const SUBMIT_FEEDBACK = gql`
  ${FEEDBACK_ITEM_FIELDS}
  mutation SubmitFeedback(
    $contractId: ID!
    $step: StepKind!
    $phaseId: ID
    $target: FeedbackTargetInput!
    $body: String!
    $confirmReopen: Boolean
  ) {
    submitFeedback(
      contractId: $contractId
      step: $step
      phaseId: $phaseId
      target: $target
      body: $body
      confirmReopen: $confirmReopen
    ) {
      item {
        ...FeedbackItemFields
      }
      intercepted
      interceptionReason
      interceptionScopeItem {
        id
        labelFa
        labelEn
        temporary
        decidedAt
        decidedNote
      }
    }
  }
`;

/**
 * A staff answer (S2, PD-4). Returns FeedbackItem!, which Apollo merges into
 * the item it already holds — whether the answer went straight to the customer
 * or into sales' queue is the comment's `approval` in what comes back.
 */
export const ANSWER_FEEDBACK = gql`
  ${FEEDBACK_ITEM_FIELDS}
  mutation AnswerFeedback($itemId: ID!, $body: String!, $resolution: FeedbackResolution) {
    answerFeedback(itemId: $itemId, body: $body, resolution: $resolution) {
      ...FeedbackItemFields
    }
  }
`;

export const APPROVE_ANSWER = gql`
  ${FEEDBACK_ITEM_FIELDS}
  mutation ApproveAnswer($commentId: ID!, $body: String) {
    approveAnswer(commentId: $commentId, body: $body) {
      ...FeedbackItemFields
    }
  }
`;

export const DECLINE_ANSWER = gql`
  ${FEEDBACK_ITEM_FIELDS}
  mutation DeclineAnswer($commentId: ID!, $reason: String!) {
    declineAnswer(commentId: $commentId, reason: $reason) {
      ...FeedbackItemFields
    }
  }
`;

/**
 * The customer approves one phase's demo (journeys §3.1, J10) — accepts every
 * resolved item at once, accepts the phase's scope and locks it. T9: the whole
 * Contract back, wizard included, so the phase's lock shows without a refetch.
 * The one door: the agreement, the design and the mockup each have their own.
 */
export const APPROVE_DEMO = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ApproveDemo($contractId: ID!, $phaseId: ID!) {
    approveDemo(contractId: $contractId, phaseId: $phaseId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

/**
 * J10: a staff member's browser heard the reporter snippet report from the demo's
 * own origin — a claim recorded with who (`DemoViewport` makes it). `origin` is the
 * origin the browser heard from.
 */
export const VERIFY_DEMO_READINESS = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation VerifyDemoReadiness($demoId: ID!, $origin: String!, $contractId: ID) {
    verifyDemoReadiness(demoId: $demoId, origin: $origin, contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

/**
 * A step's feedback on one contract (S2: one model for every step). The demo
 * panel reads its threads this way; `asCustomer` asks as the customer would be
 * asked, so view-as-customer shows exactly the customer's list.
 */
export const CONTRACT_FEEDBACK = gql`
  ${FEEDBACK_ITEM_FIELDS}
  query ContractFeedback($id: ID!, $step: StepKind, $phaseId: ID, $asCustomer: Boolean) {
    contract(id: $id, asCustomer: $asCustomer) {
      id
      feedbackItems(step: $step, phaseId: $phaseId) {
        ...FeedbackItemFields
      }
    }
  }
`;

/**
 * Step 2b's notes (journeys build plan J6): the DRAFT items anchored to an
 * article, each with where its article is now, plus the draft-wide note (which
 * is not anchored to a revision and so stays on `feedbackItems`). `asCustomer`
 * asks as the customer would be asked.
 */
export const CONTRACT_DRAFT_NOTES = gql`
  ${FEEDBACK_ITEM_FIELDS}
  query ContractDraftNotes($id: ID!, $asCustomer: Boolean) {
    contract(id: $id, asCustomer: $asCustomer) {
      id
      draftNotes {
        revisionVersion
        onCurrentRevision
        articleNumber
        currentArticleNumber
        articleChangedSince
        articleGone
        item {
          ...FeedbackItemFields
        }
      }
      feedbackItems(step: DRAFT) {
        ...FeedbackItemFields
      }
    }
  }
`;

/**
 * Step 2a (journeys build plan J5). The customer's three proposals and Root's
 * decision return the whole Contract (T9) — the wizard's SCOPE state and the
 * status area move with the act; the desk's answers return the workspace shape.
 */
export const PROPOSE_SCOPE_ADDITION = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ProposeScopeAddition($contractId: ID!, $kind: ScopeKind!, $text: String!, $lang: String!) {
    proposeScopeAddition(contractId: $contractId, kind: $kind, text: $text, lang: $lang) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const PROPOSE_SCOPE_REMOVAL = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ProposeScopeRemoval($scopeItemId: ID!, $text: String!) {
    proposeScopeRemoval(scopeItemId: $scopeItemId, text: $text) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const PROPOSE_RESTORE = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ProposeRestore($scopeItemId: ID!, $text: String!) {
    proposeRestore(scopeItemId: $scopeItemId, text: $text) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

/** The customer's half of a scope trade — works when SCOPE is locked. */
export const CONFIRM_SCOPE_TRADE_CUSTOMER = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ConfirmScopeTradeCustomer($tradeId: ID!, $contractId: ID) {
    confirmScopeTradeCustomer(tradeId: $tradeId, contractId: $contractId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const APPLY_SCOPE_TEMPLATE = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation ApplyScopeTemplate($contractId: ID!) {
    applyScopeTemplate(contractId: $contractId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DECIDE_SCOPE_PROPOSAL = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DecideScopeProposal(
    $id: ID!
    $decision: ScopeProposalDecision!
    $labelFa: String
    $labelEn: String
    $key: String
    $kind: ScopeKind
    $declineReason: String
  ) {
    decideScopeProposal(
      id: $id
      decision: $decision
      labelFa: $labelFa
      labelEn: $labelEn
      key: $key
      kind: $kind
      declineReason: $declineReason
    ) {
      ...ContractWorkspaceFields
    }
  }
`;

/** The contract's planned start and end (J6, Q12), `YYYY-MM-DD` days. */
export const SET_PLANNED_DATES = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation SetPlannedDates($contractId: ID!, $plannedStartAt: String, $plannedEndAt: String) {
    setPlannedDates(contractId: $contractId, plannedStartAt: $plannedStartAt, plannedEndAt: $plannedEndAt) {
      ...ContractWorkspaceFields
    }
  }
`;

/** One answer waiting in sales' queue (`pendingAnswers`). */
export type PendingAnswer = {
  id: string;
  comment: FeedbackComment;
  item: FeedbackItem;
  contractId: string;
  contractRef: string;
  contractTitleFa: string;
  contractTitleEn: string;
  step: StepKind;
  phaseNumber: number | null;
};

export const PENDING_ANSWERS = gql`
  ${FEEDBACK_ITEM_FIELDS}
  query PendingAnswers {
    pendingAnswers {
      id
      contractId
      contractRef
      contractTitleFa
      contractTitleEn
      step
      phaseNumber
      comment {
        id
        body
        createdAt
        resolution
        approval
        author {
          id
          name
        }
      }
      item {
        ...FeedbackItemFields
      }
    }
  }
`;


// ---------------------------------------------------------------------------
// Builds and the resolution ledger (build plan L3b; spec §6's gap). Gated on
// builds.author, never contracts.author (journeys build plan S1) — none of
// these mutations or queries return Contract!, on purpose: see
// resolvers/builds.ts's own comment on why a DEVELOPER holding only
// builds.author must never reach that payload.
// ---------------------------------------------------------------------------

export type BuildChangeOutcome = 'ADDRESSED' | 'DECLINED' | 'CARRIED_FORWARD';

export type BuildChangeEntry = {
  id: string;
  feedbackItem: FeedbackItem | null;
  scopeItem: Pick<ScopeItem, 'id' | 'key' | 'labelFa' | 'labelEn'> | null;
  outcome: BuildChangeOutcome | null;
  note: string | null;
  noteLang: string | null;
  createdAt: string;
};

export type Build = {
  id: string;
  number: number;
  deployedAt: string;
  declaredBy: Pick<User, 'id' | 'name'>;
  ref: string | null;
  publishedAt: string | null;
  /** J10, staff only. */
  pageMapConfirmedAt?: string | null;
  changes: BuildChangeEntry[];
  createdAt: string;
};

/** scopeItemsAwaitingBuild's own thin shape — not the full ScopeItem (that
 *  query never selects position/checked/temporary/… so asserting the full
 *  type against it would claim fields that were never fetched). */
export type ScopeItemAwaitingBuild = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  status: ScopeStatus;
};

/** The build-authoring form's phase picker — thin, never touches Contract. */
export type BuildPhase = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  projectId: string;
  projectTitleFa: string;
  projectTitleEn: string;
};

/** One entry sent to declareBuild — mirrors BuildChangeInput. */
export type BuildChangeInput = {
  feedbackItemId?: string | null;
  scopeItemId?: string | null;
  outcome?: BuildChangeOutcome | null;
  note?: string | null;
  noteLang?: string | null;
};

const BUILD_FIELDS = gql`
  ${FEEDBACK_ITEM_FIELDS}
  fragment BuildFields on Build {
    id
    number
    deployedAt
    ref
    publishedAt
    pageMapConfirmedAt
    createdAt
    declaredBy {
      id
      name
    }
    changes {
      id
      outcome
      note
      noteLang
      createdAt
      feedbackItem {
        ...FeedbackItemFields
      }
      scopeItem {
        id
        key
        labelFa
        labelEn
      }
    }
  }
`;

export const PHASES_FOR_BUILDS = gql`
  query PhasesForBuilds {
    phasesForBuilds {
      id
      number
      titleFa
      titleEn
      projectId
      projectTitleFa
      projectTitleEn
    }
  }
`;

export const OPEN_FEEDBACK_QUEUE = gql`
  ${FEEDBACK_ITEM_FIELDS}
  query OpenFeedbackQueue($projectId: ID!, $phaseId: ID) {
    openFeedbackQueue(projectId: $projectId, phaseId: $phaseId) {
      ...FeedbackItemFields
    }
  }
`;

export const SCOPE_ITEMS_AWAITING_BUILD = gql`
  query ScopeItemsAwaitingBuild($projectId: ID!) {
    scopeItemsAwaitingBuild(projectId: $projectId) {
      id
      key
      labelFa
      labelEn
      status
    }
  }
`;

export const PROJECT_BUILDS = gql`
  ${BUILD_FIELDS}
  query ProjectBuilds($projectId: ID!) {
    projectBuilds(projectId: $projectId) {
      ...BuildFields
    }
  }
`;

export const DECLARE_BUILD = gql`
  ${BUILD_FIELDS}
  mutation DeclareBuild($phaseId: ID!, $ref: String, $changes: [BuildChangeInput!]!) {
    declareBuild(phaseId: $phaseId, ref: $ref, changes: $changes) {
      ...BuildFields
    }
  }
`;

export const PUBLISH_BUILD = gql`
  ${BUILD_FIELDS}
  mutation PublishBuild($buildId: ID!) {
    publishBuild(buildId: $buildId) {
      ...BuildFields
    }
  }
`;

/** J10: the developer confirms the page map for this unpublished build. */
export const CONFIRM_PAGE_MAP = gql`
  ${BUILD_FIELDS}
  mutation ConfirmPageMap($buildId: ID!) {
    confirmPageMap(buildId: $buildId) {
      ...BuildFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Step 5, the mockup (journeys build plan J9b). The panel reads the mockup
// through one query of its own — it is not part of `WizardFields`, which every
// contract screen pays for — and refetches it after each act.
// ---------------------------------------------------------------------------

export const CONTRACT_MOCKUP = gql`
  ${FEEDBACK_ITEM_FIELDS}
  query ContractMockup($id: ID!, $asCustomer: Boolean) {
    contract(id: $id, asCustomer: $asCustomer) {
      id
      mockup {
        id
        kind
        publishedAt
        fixedFrameLines
        bundlePages
        pages {
          id
          key
          labelFa
          labelEn
          canonicalPath
        }
        builds {
          id
          kind
          number
          publishedAt
          createdAt
          declaredBy {
            id
            name
          }
          changes {
            id
            outcome
            note
            noteLang
            createdAt
            feedbackItem {
              id
              general
              demoPage {
                id
                key
                labelFa
                labelEn
              }
            }
          }
        }
        frame {
          id
          summaryFa
          summaryEn
          authoredBy {
            id
            name
          }
          unpromptedChanges {
            id
            note
            noteLang
          }
          lines {
            id
            kind
            textFa
            textEn
            position
            scopeItem {
              id
              labelFa
              labelEn
              temporary
              decidedAt
              decidedNote
            }
            feedbackItem {
              ...FeedbackItemFields
            }
          }
        }
        feedbackItems {
          ...FeedbackItemFields
        }
      }
    }
  }
`;

export const MOCKUP_VIEW_URL = gql`
  query MockupViewUrl($demoId: ID!) {
    mockupViewUrl(demoId: $demoId)
  }
`;

export const CREATE_MOCKUP_DEMO = gql`
  mutation CreateMockupDemo($contractId: ID!) {
    createMockupDemo(contractId: $contractId) {
      id
    }
  }
`;

export const MAP_MOCKUP_PAGE = gql`
  mutation MapMockupPage($demoPageId: ID!, $path: String!) {
    mapMockupPage(demoPageId: $demoPageId, path: $path) {
      id
    }
  }
`;

export const DECLARE_MOCKUP_BUILD = gql`
  mutation DeclareMockupBuild($demoId: ID!, $fileId: ID!, $ref: String, $changes: [BuildChangeInput!]!) {
    declareMockupBuild(demoId: $demoId, fileId: $fileId, ref: $ref, changes: $changes) {
      id
      number
      publishedAt
    }
  }
`;

/** The customer approves the mockup — `approveStepTx(MOCKUP)` with a published iteration. */
export const APPROVE_MOCKUP = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ApproveMockup($contractId: ID!) {
    approveMockup(contractId: $contractId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Tickets and the three channels (build plan L4; spec §5, §6). Never returns
// Contract! — a ticket is its own object, reached by myTickets/allTickets,
// not through a contract's own fields.
// ---------------------------------------------------------------------------

export type TicketType = 'CHANGE_REQUEST' | 'BUG' | 'QUESTION' | 'ADMIN_REQUEST';
export type TicketUrgency = 'URGENT' | 'NOT_URGENT';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

export type TicketMessage = {
  id: string;
  author: Pick<User, 'id' | 'name'>;
  body: string;
  createdAt: string;
};

export type Ticket = {
  id: string;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  project: { id: string; titleFa: string; titleEn: string } | null;
  type: TicketType;
  urgency: TicketUrgency;
  status: TicketStatus;
  subject: string;
  billable: boolean;
  sourceFeedbackItem: Pick<FeedbackItem, 'id'> | null;
  briefPageFa: string | null;
  briefPageEn: string | null;
  briefAnnotation: string | null;
  briefCurrentState: string | null;
  briefDesiredState: string | null;
  briefLang: string | null;
  /** Build plan L6: the charge this billable ticket produced, if any. */
  billingEntry: { id: string; amount: string; paidAt: string | null; issuedAt: string | null } | null;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
};

const TICKET_FIELDS = gql`
  fragment TicketFields on Ticket {
    id
    type
    urgency
    status
    subject
    billable
    briefPageFa
    briefPageEn
    briefAnnotation
    briefCurrentState
    briefDesiredState
    briefLang
    createdAt
    updatedAt
    billingEntry {
      id
      amount
      paidAt
      issuedAt
    }
    customer {
      id
      name
      clientName
    }
    project {
      id
      titleFa
      titleEn
    }
    sourceFeedbackItem {
      id
    }
    messages {
      id
      body
      createdAt
      author {
        id
        name
      }
    }
  }
`;

export const MY_TICKETS = gql`
  ${TICKET_FIELDS}
  query MyTickets {
    myTickets {
      ...TicketFields
    }
  }
`;

export const ALL_TICKETS = gql`
  ${TICKET_FIELDS}
  query AllTickets($status: TicketStatus, $type: TicketType, $projectId: ID) {
    allTickets(status: $status, type: $type, projectId: $projectId) {
      ...TicketFields
    }
  }
`;

export const ADMIN_REQUEST_COUNT = gql`
  query AdminRequestCount {
    adminRequestCount
  }
`;

export const CREATE_TICKET = gql`
  ${TICKET_FIELDS}
  mutation CreateTicket($type: TicketType!, $subject: String!, $body: String!, $urgency: TicketUrgency, $projectId: ID) {
    createTicket(type: $type, subject: $subject, body: $body, urgency: $urgency, projectId: $projectId) {
      ...TicketFields
    }
  }
`;

export const ADD_TICKET_MESSAGE = gql`
  ${TICKET_FIELDS}
  mutation AddTicketMessage($ticketId: ID!, $body: String!) {
    addTicketMessage(ticketId: $ticketId, body: $body) {
      ...TicketFields
    }
  }
`;

export const SET_TICKET_STATUS = gql`
  ${TICKET_FIELDS}
  mutation SetTicketStatus($ticketId: ID!, $status: TicketStatus!) {
    setTicketStatus(ticketId: $ticketId, status: $status) {
      ...TicketFields
    }
  }
`;

export const SET_TICKET_URGENCY = gql`
  ${TICKET_FIELDS}
  mutation SetTicketUrgency($ticketId: ID!, $urgency: TicketUrgency!) {
    setTicketUrgency(ticketId: $ticketId, urgency: $urgency) {
      ...TicketFields
    }
  }
`;

export const SET_TICKET_BILLABLE = gql`
  ${TICKET_FIELDS}
  mutation SetTicketBillable($ticketId: ID!, $billable: Boolean!) {
    setTicketBillable(ticketId: $ticketId, billable: $billable) {
      ...TicketFields
    }
  }
`;

export const MOVE_TICKET_CHANNEL = gql`
  ${TICKET_FIELDS}
  mutation MoveTicketChannel($ticketId: ID!, $type: TicketType!) {
    moveTicketChannel(ticketId: $ticketId, type: $type) {
      ...TicketFields
    }
  }
`;

export const CREATE_TICKET_FROM_FEEDBACK = gql`
  ${TICKET_FIELDS}
  mutation CreateTicketFromFeedback($itemId: ID!, $currentState: String!, $desiredState: String!, $lang: String!) {
    createTicketFromFeedback(itemId: $itemId, currentState: $currentState, desiredState: $desiredState, lang: $lang) {
      ...TicketFields
    }
  }
`;

// ---------------------------------------------------------------------------
// The dependency board (build plan L5; spec §7). createDependency/
// updateDependency/verifyDependency/unverifyDependency/deleteDependency all
// return Contract! (T9), reached via project.dependencies — same convention
// every other registry-adjacent mutation since L1 already follows.
// ---------------------------------------------------------------------------

export const CREATE_DEPENDENCY = gql`
  ${CONTRACT_FIELDS}
  mutation CreateDependency($projectId: ID!, $side: DependencySide!, $titleFa: String!, $titleEn: String!, $dueAt: DateTime!, $contractId: ID) {
    createDependency(projectId: $projectId, side: $side, titleFa: $titleFa, titleEn: $titleEn, dueAt: $dueAt, contractId: $contractId) {
      ...ContractFields
    }
  }
`;

export const UPDATE_DEPENDENCY = gql`
  ${CONTRACT_FIELDS}
  mutation UpdateDependency($dependencyId: ID!, $titleFa: String!, $titleEn: String!, $dueAt: DateTime!, $contractId: ID) {
    updateDependency(dependencyId: $dependencyId, titleFa: $titleFa, titleEn: $titleEn, dueAt: $dueAt, contractId: $contractId) {
      ...ContractFields
    }
  }
`;

export const VERIFY_DEPENDENCY = gql`
  ${CONTRACT_FIELDS}
  mutation VerifyDependency($dependencyId: ID!, $note: String!, $contractId: ID) {
    verifyDependency(dependencyId: $dependencyId, note: $note, contractId: $contractId) {
      ...ContractFields
    }
  }
`;

export const UNVERIFY_DEPENDENCY = gql`
  ${CONTRACT_FIELDS}
  mutation UnverifyDependency($dependencyId: ID!, $contractId: ID) {
    unverifyDependency(dependencyId: $dependencyId, contractId: $contractId) {
      ...ContractFields
    }
  }
`;

export const DELETE_DEPENDENCY = gql`
  ${CONTRACT_FIELDS}
  mutation DeleteDependency($dependencyId: ID!, $contractId: ID) {
    deleteDependency(dependencyId: $dependencyId, contractId: $contractId) {
      ...ContractFields
    }
  }
`;

/** The staff dashboard's own query — every overdue commitment, both sides,
 *  across every project (Query.overdueDependencies never returns Contract!:
 *  a cross-project list has no one contract to be). */
export const OVERDUE_DEPENDENCIES = gql`
  ${DEPENDENCY_FIELDS}
  query OverdueDependencies {
    overdueDependencies {
      ...DependencyFields
      project {
        id
        titleFa
        titleEn
        customer {
          id
          name
          clientName
        }
      }
    }
  }
`;

/** The portal's own half — the caller's own overdue CUSTOMER-side rows. */
export const MY_OVERDUE_DEPENDENCIES = gql`
  ${DEPENDENCY_FIELDS}
  query MyOverdueDependencies {
    myOverdueDependencies {
      ...DependencyFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Billing — subscriptions, invoices, the report (build plan L6; spec §8).
// BillingEntry/Subscription are their own objects (never Contract!) — the
// same "not part of the registry-adjacent reload convention" shape Ticket
// already uses.
// ---------------------------------------------------------------------------

export type BillingSource = 'CONTRACT' | 'SERVICE' | 'TICKET' | 'SUBSCRIPTION';
export type SubscriptionPeriod = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export type Subscription = {
  id: string;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  project: { id: string; titleFa: string; titleEn: string } | null;
  labelFa: string;
  labelEn: string;
  /** Toman — a string, since BigInt does not survive JSON. */
  amount: string;
  period: SubscriptionPeriod;
  activeFrom: string;
  activeUntil: string | null;
  createdAt: string;
};

export type BillingEntry = {
  id: string;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  contract: { id: string; ref: string } | null;
  phase: { id: string; number: number; titleFa: string; titleEn: string; milestoneLabel: string | null } | null;
  subscription: Pick<Subscription, 'id' | 'labelFa' | 'labelEn'> | null;
  periodStart: string | null;
  periodEnd: string | null;
  ticket: { id: string; subject: string } | null;
  source: BillingSource;
  descriptionFa: string;
  descriptionEn: string;
  /** Toman — a string, since BigInt does not survive JSON. */
  amount: string;
  /** Null is a draft (J13) — only the desk ever receives one. */
  issuedAt: string | null;
  paidAt: string | null;
  /** `INV-000123`, Latin in every language. Null on a draft. */
  invoiceNumber: string | null;
  /** A calendar day (PD-19): render with `calendarDate`. Null on a draft. */
  dueAt: string | null;
  paymentTermDays: number | null;
  /** The plan row this issued — what it waited on. */
  plannedInvoice: { id: string; ordinal: number; labelFa: string; labelEn: string } | null;
  overdue: boolean;
};

export type BillingSourceTotal = {
  source: BillingSource;
  totalIssued: string;
  totalPaid: string;
  totalOutstanding: string;
};

export type BillingReport = {
  totalIssued: string;
  totalPaid: string;
  totalOutstanding: string;
  bySource: BillingSourceTotal[];
};

const SUBSCRIPTION_FIELDS = gql`
  fragment SubscriptionFields on Subscription {
    id
    labelFa
    labelEn
    amount
    period
    activeFrom
    activeUntil
    createdAt
    customer {
      id
      name
      clientName
    }
    project {
      id
      titleFa
      titleEn
    }
  }
`;

const BILLING_ENTRY_FIELDS = gql`
  fragment BillingEntryFields on BillingEntry {
    id
    source
    descriptionFa
    descriptionEn
    amount
    issuedAt
    paidAt
    invoiceNumber
    dueAt
    paymentTermDays
    overdue
    periodStart
    periodEnd
    plannedInvoice {
      id
      ordinal
      labelFa
      labelEn
    }
    customer {
      id
      name
      clientName
    }
    contract {
      id
      ref
    }
    phase {
      id
      number
      titleFa
      titleEn
      milestoneLabel
    }
    subscription {
      id
      labelFa
      labelEn
    }
    ticket {
      id
      subject
    }
  }
`;

const BILLING_REPORT_FIELDS = gql`
  fragment BillingReportFields on BillingReport {
    totalIssued
    totalPaid
    totalOutstanding
    bySource {
      source
      totalIssued
      totalPaid
      totalOutstanding
    }
  }
`;

/** The caller's own issued invoices (J13) — never a draft. */
export const MY_INVOICES = gql`
  ${BILLING_ENTRY_FIELDS}
  query MyInvoices {
    myInvoices {
      ...BillingEntryFields
    }
  }
`;

/** One of the caller's own issued invoices; NOT_FOUND for anything else. */
export const INVOICE = gql`
  ${BILLING_ENTRY_FIELDS}
  query Invoice($id: ID!) {
    invoice(id: $id) {
      ...BillingEntryFields
    }
  }
`;

export const MY_BILLING_REPORT = gql`
  ${BILLING_REPORT_FIELDS}
  query MyBillingReport {
    myBillingReport {
      ...BillingReportFields
    }
  }
`;

export const MY_SUBSCRIPTIONS = gql`
  ${SUBSCRIPTION_FIELDS}
  query MySubscriptions {
    mySubscriptions {
      ...SubscriptionFields
    }
  }
`;

export const ALL_BILLING_ENTRIES = gql`
  ${BILLING_ENTRY_FIELDS}
  query AllBillingEntries($customerId: ID, $projectId: ID) {
    allBillingEntries(customerId: $customerId, projectId: $projectId) {
      ...BillingEntryFields
    }
  }
`;

export const BILLING_REPORT = gql`
  ${BILLING_REPORT_FIELDS}
  query BillingReport($customerId: ID) {
    billingReport(customerId: $customerId) {
      ...BillingReportFields
    }
  }
`;

export const ALL_SUBSCRIPTIONS = gql`
  ${SUBSCRIPTION_FIELDS}
  query AllSubscriptions($customerId: ID) {
    allSubscriptions(customerId: $customerId) {
      ...SubscriptionFields
    }
  }
`;

/** A draft (J13) — the customer sees nothing until `ISSUE_INVOICE`. */
export const CREATE_INVOICE_DRAFT = gql`
  ${BILLING_ENTRY_FIELDS}
  mutation CreateInvoiceDraft($customerId: ID!, $contractId: ID, $phaseId: ID, $source: BillingSource!, $descriptionFa: String!, $descriptionEn: String!, $amount: String!, $paymentTermDays: Int) {
    createInvoiceDraft(customerId: $customerId, contractId: $contractId, phaseId: $phaseId, source: $source, descriptionFa: $descriptionFa, descriptionEn: $descriptionEn, amount: $amount, paymentTermDays: $paymentTermDays) {
      ...BillingEntryFields
    }
  }
`;

export const ISSUE_INVOICE = gql`
  ${BILLING_ENTRY_FIELDS}
  mutation IssueInvoice($entryId: ID!) {
    issueInvoice(entryId: $entryId) {
      ...BillingEntryFields
    }
  }
`;

export const DELETE_INVOICE_DRAFT = gql`
  mutation DeleteInvoiceDraft($entryId: ID!) {
    deleteInvoiceDraft(entryId: $entryId)
  }
`;

/** A payment plan as the desk's billing screen reads it, per contract (J13). */
export type PlanContract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  paymentPlan: {
    id: string;
    split: PaymentSplit;
    total: string;
    invoices: Array<
      PlannedInvoice & {
        state: PlannedInvoiceState;
        blockedBy: IssueBlock | null;
        invoice: Pick<BillingEntry, 'id' | 'invoiceNumber' | 'issuedAt' | 'dueAt' | 'paidAt' | 'overdue'> | null;
      }
    >;
  } | null;
};

const PLAN_CONTRACT_FIELDS = gql`
  fragment PlanContractFields on Contract {
    id
    ref
    titleFa
    titleEn
    customer {
      id
      name
      clientName
    }
    paymentPlan {
      id
      split
      total
      invoices {
        id
        ordinal
        labelFa
        labelEn
        amount
        phaseId
        paymentTermDays
        state
        blockedBy
        invoice {
          id
          invoiceNumber
          issuedAt
          dueAt
          paidAt
          overdue
        }
      }
    }
  }
`;

export const CONTRACTS_WITH_PAYMENT_PLAN = gql`
  ${PLAN_CONTRACT_FIELDS}
  query ContractsWithPaymentPlan($customerId: ID) {
    contractsWithPaymentPlan(customerId: $customerId) {
      ...PlanContractFields
    }
  }
`;

export const ISSUE_PLANNED_INVOICE = gql`
  ${PLAN_CONTRACT_FIELDS}
  mutation IssuePlannedInvoice($plannedInvoiceId: ID!) {
    issuePlannedInvoice(plannedInvoiceId: $plannedInvoiceId) {
      ...PlanContractFields
    }
  }
`;

export const MARK_BILLING_ENTRY_PAID = gql`
  ${BILLING_ENTRY_FIELDS}
  mutation MarkBillingEntryPaid($entryId: ID!) {
    markBillingEntryPaid(entryId: $entryId) {
      ...BillingEntryFields
    }
  }
`;

export const UNMARK_BILLING_ENTRY_PAID = gql`
  ${BILLING_ENTRY_FIELDS}
  mutation UnmarkBillingEntryPaid($entryId: ID!) {
    unmarkBillingEntryPaid(entryId: $entryId) {
      ...BillingEntryFields
    }
  }
`;

export const CREATE_TICKET_BILLING_ENTRY = gql`
  ${BILLING_ENTRY_FIELDS}
  mutation CreateTicketBillingEntry($ticketId: ID!, $amount: String!, $descriptionFa: String!, $descriptionEn: String!) {
    createTicketBillingEntry(ticketId: $ticketId, amount: $amount, descriptionFa: $descriptionFa, descriptionEn: $descriptionEn) {
      ...BillingEntryFields
    }
  }
`;

export const CREATE_SUBSCRIPTION = gql`
  ${SUBSCRIPTION_FIELDS}
  mutation CreateSubscription($customerId: ID!, $projectId: ID, $labelFa: String!, $labelEn: String!, $amount: String!, $period: SubscriptionPeriod!, $activeFrom: DateTime!) {
    createSubscription(customerId: $customerId, projectId: $projectId, labelFa: $labelFa, labelEn: $labelEn, amount: $amount, period: $period, activeFrom: $activeFrom) {
      ...SubscriptionFields
    }
  }
`;

export const UPDATE_SUBSCRIPTION = gql`
  ${SUBSCRIPTION_FIELDS}
  mutation UpdateSubscription($subscriptionId: ID!, $labelFa: String!, $labelEn: String!, $amount: String!) {
    updateSubscription(subscriptionId: $subscriptionId, labelFa: $labelFa, labelEn: $labelEn, amount: $amount) {
      ...SubscriptionFields
    }
  }
`;

export const END_SUBSCRIPTION = gql`
  ${SUBSCRIPTION_FIELDS}
  mutation EndSubscription($subscriptionId: ID!, $activeUntil: DateTime!) {
    endSubscription(subscriptionId: $subscriptionId, activeUntil: $activeUntil) {
      ...SubscriptionFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Services — the product-import panel (build plan L7; spec §9). "A service =
// a panel + a run history + a billing edge."
// ---------------------------------------------------------------------------

export type ServiceRunStatus = 'UPLOADED' | 'PREVIEWED' | 'APPLIED' | 'FAILED';
export type ServiceRowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'REJECTED';

export type ServiceRunRow = {
  id: string;
  rowNumber: number;
  sku: string;
  nameFa: string;
  nameEn: string | null;
  /** Toman — a string, since BigInt does not survive JSON. Null on a
   *  REJECTED row with no parseable price. */
  price: string | null;
  stock: number | null;
  action: ServiceRowAction;
  rejectReason: string | null;
};

export type ServiceRunSummary = {
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  rejectedCount: number;
};

export type ServiceRun = {
  id: string;
  project: { id: string; titleFa: string; titleEn: string };
  fileUrl: string;
  fileName: string;
  fileBytes: number;
  uploadedBy: Pick<User, 'id' | 'name'>;
  createdAt: string;
  status: ServiceRunStatus;
  failureReason: string | null;
  previewedAt: string | null;
  appliedAt: string | null;
  appliedBy: Pick<User, 'id' | 'name'> | null;
  rows: ServiceRunRow[];
  summary: ServiceRunSummary;
  billingEntry: { id: string; amount: string; paidAt: string | null; issuedAt: string | null } | null;
};

const SERVICE_RUN_FIELDS = gql`
  fragment ServiceRunFields on ServiceRun {
    id
    fileUrl
    fileName
    fileBytes
    createdAt
    status
    failureReason
    previewedAt
    appliedAt
    project {
      id
      titleFa
      titleEn
    }
    uploadedBy {
      id
      name
    }
    appliedBy {
      id
      name
    }
    rows {
      id
      rowNumber
      sku
      nameFa
      nameEn
      price
      stock
      action
      rejectReason
    }
    summary {
      createCount
      updateCount
      unchangedCount
      rejectedCount
    }
    billingEntry {
      id
      amount
      paidAt
      issuedAt
    }
  }
`;

export const MY_PROJECTS = gql`
  query MyProjects {
    myProjects {
      id
      titleFa
      titleEn
    }
  }
`;

export const PROJECT_SERVICE_RUNS = gql`
  ${SERVICE_RUN_FIELDS}
  query ProjectServiceRuns($projectId: ID!) {
    projectServiceRuns(projectId: $projectId) {
      ...ServiceRunFields
    }
  }
`;

export const ALL_SERVICE_RUNS = gql`
  ${SERVICE_RUN_FIELDS}
  query AllServiceRuns($projectId: ID) {
    allServiceRuns(projectId: $projectId) {
      ...ServiceRunFields
    }
  }
`;

export const CREATE_SERVICE_RUN = gql`
  ${SERVICE_RUN_FIELDS}
  mutation CreateServiceRun($projectId: ID!, $fileId: ID!) {
    createServiceRun(projectId: $projectId, fileId: $fileId) {
      ...ServiceRunFields
    }
  }
`;

export const PREVIEW_SERVICE_RUN = gql`
  ${SERVICE_RUN_FIELDS}
  mutation PreviewServiceRun($runId: ID!) {
    previewServiceRun(runId: $runId) {
      ...ServiceRunFields
    }
  }
`;

export const APPLY_SERVICE_RUN = gql`
  ${SERVICE_RUN_FIELDS}
  mutation ApplyServiceRun($runId: ID!) {
    applyServiceRun(runId: $runId) {
      ...ServiceRunFields
    }
  }
`;

export const CREATE_SERVICE_RUN_BILLING_ENTRY = gql`
  ${SERVICE_RUN_FIELDS}
  mutation CreateServiceRunBillingEntry($runId: ID!, $amount: String!, $descriptionFa: String!, $descriptionEn: String!) {
    createServiceRunBillingEntry(runId: $runId, amount: $amount, descriptionFa: $descriptionFa, descriptionEn: $descriptionEn) {
      ...ServiceRunFields
    }
  }
`;

export const ISSUE_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation IssueAmendment($contractId: ID!, $titleFa: String!, $titleEn: String!, $bodyFa: String!, $bodyEn: String!, $relatesToArticle: Int, $sensitive: Boolean) {
    issueAmendment(contractId: $contractId, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn, relatesToArticle: $relatesToArticle, sensitive: $sensitive) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateAmendment($amendmentId: ID!, $titleFa: String!, $titleEn: String!, $bodyFa: String!, $bodyEn: String!, $relatesToArticle: Int, $sensitive: Boolean) {
    updateAmendment(amendmentId: $amendmentId, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn, relatesToArticle: $relatesToArticle, sensitive: $sensitive) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteAmendment($amendmentId: ID!) {
    deleteAmendment(amendmentId: $amendmentId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const PUBLISH_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation PublishAmendment($amendmentId: ID!) {
    publishAmendment(amendmentId: $amendmentId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const APPROVE_AMENDMENT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation ApproveAmendment($amendmentId: ID!) {
    approveAmendment(amendmentId: $amendmentId) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

export const SIGN_AMENDMENT = gql`
  ${CONTRACT_FIELDS}
  ${WIZARD_FIELDS}
  mutation SignAmendment($amendmentId: ID!, $typedName: String!) {
    signAmendment(amendmentId: $amendmentId, typedName: $typedName) {
      ...ContractFields
      ...WizardFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Library (R1) — bilingual as *data*. Entry content is never a translation
// key; only the editor's own chrome lives in en.json/fa.json (R1.md §0.1).
// ---------------------------------------------------------------------------

export type EntryType = 'PAPER' | 'BOOK' | 'ARTICLE' | 'ROOT_RESEARCH';
export type TranslationProvenance = 'PUBLISHED' | 'ROOT' | 'NONE_YET';
export type RightsBasis = 'PUBLIC_DOMAIN' | 'OPEN_LICENCE' | 'PERMISSION_GRANTED' | 'LINK_ONLY';
export type EntryVisibility = 'PUBLIC' | 'PRIVATE';

export type LibraryConcept = {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string;
};

export type LibraryEntry = {
  id: string;
  slug: string;
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  authors: string;
  venue: string | null;
  year: number | null;
  doi: string | null;
  sourceUrl: string | null;
  abstractOriginal: string | null;
  translationProvenance: TranslationProvenance;
  titleTranslated: string | null;
  abstractTranslated: string | null;
  translationCredit: string | null;
  rightsBasis: RightsBasis;
  rightsNote: string | null;
  fullTextUrl: string | null;
  visibility: EntryVisibility;
  publishedAt: string | null;
  concepts: LibraryConcept[];
  createdBy: Pick<User, 'id' | 'name'>;
  createdAt: string;
  updatedAt: string;
};

/** The list screen's shape — never the abstract, never unbounded (R1.md §4.4, T1). */
export type LibraryEntryRow = {
  id: string;
  slug: string;
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  titleTranslated: string | null;
  year: number | null;
  translationProvenance: TranslationProvenance;
  rightsBasis: RightsBasis;
  publishedAt: string | null;
  conceptCount: number;
};

export type LibraryEntryInput = {
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  authors: string;
  venue?: string | null;
  year?: number | null;
  doi?: string | null;
  sourceUrl?: string | null;
  abstractOriginal?: string | null;
  translationProvenance: TranslationProvenance;
  titleTranslated?: string | null;
  abstractTranslated?: string | null;
  translationCredit?: string | null;
  rightsBasis: RightsBasis;
  rightsNote?: string | null;
  visibility: EntryVisibility;
  slug?: string | null;
};

export type LibraryConceptInput = { titleFa: string; titleEn: string; slug?: string | null };

const LIBRARY_ENTRY_ROW_FIELDS = gql`
  fragment LibraryEntryRowFields on LibraryEntryRow {
    id
    slug
    type
    originalLang
    titleOriginal
    titleTranslated
    year
    translationProvenance
    rightsBasis
    publishedAt
    conceptCount
  }
`;

export const LIBRARY_ENTRIES = gql`
  ${LIBRARY_ENTRY_ROW_FIELDS}
  query LibraryEntries($search: String, $type: EntryType, $limit: Int, $offset: Int) {
    libraryEntries(search: $search, type: $type, limit: $limit, offset: $offset) {
      rows {
        ...LibraryEntryRowFields
      }
      total
    }
  }
`;

const LIBRARY_ENTRY_FIELDS = gql`
  fragment LibraryEntryFields on LibraryEntry {
    id
    slug
    type
    originalLang
    titleOriginal
    authors
    venue
    year
    doi
    sourceUrl
    abstractOriginal
    translationProvenance
    titleTranslated
    abstractTranslated
    translationCredit
    rightsBasis
    rightsNote
    fullTextUrl
    visibility
    publishedAt
    concepts {
      id
      slug
      titleFa
      titleEn
    }
    createdBy {
      id
      name
    }
    createdAt
    updatedAt
  }
`;

export const LIBRARY_ENTRY = gql`
  ${LIBRARY_ENTRY_FIELDS}
  query LibraryEntryById($id: ID!) {
    libraryEntry(id: $id) {
      ...LibraryEntryFields
    }
  }
`;

export const LIBRARY_CONCEPTS = gql`
  query LibraryConcepts {
    libraryConcepts {
      id
      slug
      titleFa
      titleEn
    }
  }
`;

export const CREATE_LIBRARY_ENTRY = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation CreateLibraryEntry($input: LibraryEntryInput!) {
    createLibraryEntry(input: $input) {
      ...LibraryEntryFields
    }
  }
`;

export const UPDATE_LIBRARY_ENTRY = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation UpdateLibraryEntry($id: ID!, $input: LibraryEntryInput!) {
    updateLibraryEntry(id: $id, input: $input) {
      ...LibraryEntryFields
    }
  }
`;

export const DELETE_LIBRARY_ENTRY = gql`
  mutation DeleteLibraryEntry($id: ID!) {
    deleteLibraryEntry(id: $id)
  }
`;

export const SET_ENTRY_CONCEPTS = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation SetEntryConcepts($id: ID!, $conceptIds: [ID!]!) {
    setEntryConcepts(id: $id, conceptIds: $conceptIds) {
      ...LibraryEntryFields
    }
  }
`;

export const DETACH_ENTRY_FULL_TEXT = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation DetachEntryFullText($id: ID!) {
    detachEntryFullText(id: $id) {
      ...LibraryEntryFields
    }
  }
`;

export const PUBLISH_LIBRARY_ENTRY = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation PublishLibraryEntry($id: ID!) {
    publishLibraryEntry(id: $id) {
      ...LibraryEntryFields
    }
  }
`;

export const UNPUBLISH_LIBRARY_ENTRY = gql`
  ${LIBRARY_ENTRY_FIELDS}
  mutation UnpublishLibraryEntry($id: ID!) {
    unpublishLibraryEntry(id: $id) {
      ...LibraryEntryFields
    }
  }
`;

export const CREATE_LIBRARY_CONCEPT = gql`
  mutation CreateLibraryConcept($input: LibraryConceptInput!) {
    createLibraryConcept(input: $input) {
      id
      slug
      titleFa
      titleEn
    }
  }
`;

export const UPDATE_LIBRARY_CONCEPT = gql`
  mutation UpdateLibraryConcept($id: ID!, $input: LibraryConceptInput!) {
    updateLibraryConcept(id: $id, input: $input) {
      id
      slug
      titleFa
      titleEn
    }
  }
`;

export const DELETE_LIBRARY_CONCEPT = gql`
  mutation DeleteLibraryConcept($id: ID!) {
    deleteLibraryConcept(id: $id)
  }
`;

// ---------------------------------------------------------------------
// Library (R2) — the public reader. Distinct types from the staff ones
// above: PublicEntry/PublicEntryRow/PublicConcept are what an anonymous
// visitor may see, curated server-side (R2.md §2.3) — this file mirrors
// the server's shape by hand, same as everything else here, and cannot
// widen it by accident the way reusing LibraryEntry's type could.
// ---------------------------------------------------------------------

export type PublicConcept = { slug: string; titleFa: string; titleEn: string };

export type PublicEntry = {
  id: string;
  slug: string;
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  authors: string;
  venue: string | null;
  year: number | null;
  doi: string | null;
  sourceUrl: string | null;
  abstractOriginal: string | null;
  translationProvenance: TranslationProvenance;
  titleTranslated: string | null;
  abstractTranslated: string | null;
  translationCredit: string | null;
  rightsBasis: RightsBasis;
  rightsNote: string | null;
  fullTextUrl: string | null;
  publishedAt: string;
  concepts: PublicConcept[];
};

export type PublicEntryRow = {
  id: string;
  slug: string;
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  titleTranslated: string | null;
  year: number | null;
  translationProvenance: TranslationProvenance;
  rightsBasis: RightsBasis;
  fullTextUrl: string | null;
  publishedAt: string;
  conceptCount: number;
};

const PUBLIC_ENTRY_ROW_FIELDS = gql`
  fragment PublicEntryRowFields on PublicEntryRow {
    id
    slug
    type
    originalLang
    titleOriginal
    titleTranslated
    year
    translationProvenance
    rightsBasis
    fullTextUrl
    publishedAt
    conceptCount
  }
`;

/**
 * Whether this deployment can answer at all — `AskLab` asks for itself rather
 * than taking it as a prop, so no call site can mount the panel on a server
 * that has no key. It is a root field with no arguments, so Apollo's cache
 * answers every mount after the first from memory: one request per session,
 * not one per page.
 */
export const ASK_AVAILABLE = gql`
  query AskAvailable {
    askAvailable
  }
`;

export const PUBLIC_LIBRARY_ENTRIES = gql`
  ${PUBLIC_ENTRY_ROW_FIELDS}
  query PublicLibraryEntries($search: String, $type: EntryType, $conceptSlug: String, $limit: Int, $offset: Int) {
    publicLibraryEntries(search: $search, type: $type, conceptSlug: $conceptSlug, limit: $limit, offset: $offset) {
      rows {
        ...PublicEntryRowFields
      }
      total
    }
  }
`;

export const PUBLIC_LIBRARY_ENTRY = gql`
  query PublicLibraryEntry($slug: String!) {
    publicLibraryEntry(slug: $slug) {
      id
      slug
      type
      originalLang
      titleOriginal
      authors
      venue
      year
      doi
      sourceUrl
      abstractOriginal
      translationProvenance
      titleTranslated
      abstractTranslated
      translationCredit
      rightsBasis
      rightsNote
      fullTextUrl
      publishedAt
      concepts {
        slug
        titleFa
        titleEn
      }
    }
  }
`;

export const PUBLIC_LIBRARY_CONCEPTS = gql`
  query PublicLibraryConcepts {
    publicLibraryConcepts {
      slug
      titleFa
      titleEn
    }
  }
`;

// ---------------------------------------------------------------------
// Review Room (C1) — reading only. Publishing a round happens through the
// publish-round CLI (C1.md §3), never through this app, so there is no
// mutation document here to mirror one.
// ---------------------------------------------------------------------

export type BlockKind = 'HEADING' | 'PARAGRAPH' | 'CODE' | 'LIST' | 'QUOTE' | 'TABLE';

export type ReviewBlock = {
  id: string;
  kind: BlockKind;
  depth: number | null;
  text: string;
};

export type ReviewDocumentRef = {
  id: string;
  path: string;
  title: string;
  order: number;
};

export type ReviewRound = {
  id: string;
  sha: string;
  label: string | null;
  publishedAt: string;
  publishedBy: Pick<User, 'id' | 'name'>;
  documents: ReviewDocumentRef[];
};

export type ReviewRoundRef = {
  id: string;
  sha: string;
  label: string | null;
  publishedAt: string;
};

export type ReviewComment = {
  id: string;
  authorId: string;
  author: Pick<User, 'id' | 'name'>;
  body: string;
  createdAt: string;
};

export type ReviewThread = {
  id: string;
  documentId: string;
  authorId: string;
  author: Pick<User, 'id' | 'name'>;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  resolvedAt: string | null;
  resolvedById: string | null;
  resolvedBy: Pick<User, 'id' | 'name'> | null;
  createdAt: string;
  comments: ReviewComment[];
};

export type ReviewDocument = {
  id: string;
  path: string;
  title: string;
  order: number;
  contentHash: string;
  blocks: ReviewBlock[];
  round: ReviewRoundRef;
  threads: ReviewThread[];
};

const REVIEW_THREAD_FIELDS = gql`
  fragment ReviewThreadFields on ReviewThread {
    id
    documentId
    authorId
    author {
      id
      name
    }
    blockId
    startOffset
    endOffset
    quote
    resolvedAt
    resolvedById
    resolvedBy {
      id
      name
    }
    createdAt
    comments {
      id
      authorId
      author {
        id
        name
      }
      body
      createdAt
    }
  }
`;

export const REVIEW_ROUNDS = gql`
  query ReviewRounds {
    reviewRounds {
      id
      sha
      label
      publishedAt
      publishedBy {
        id
        name
      }
      documents {
        id
        path
        title
        order
      }
    }
  }
`;

export const REVIEW_DOCUMENT = gql`
  ${REVIEW_THREAD_FIELDS}
  query ReviewDocumentById($roundId: ID!, $documentId: ID!) {
    reviewDocument(roundId: $roundId, documentId: $documentId) {
      id
      path
      title
      order
      contentHash
      blocks {
        id
        kind
        depth
        text
      }
      round {
        id
        sha
        label
        publishedAt
      }
      threads {
        ...ReviewThreadFields
      }
    }
  }
`;

export const OPEN_REVIEW_THREAD = gql`
  ${REVIEW_THREAD_FIELDS}
  mutation OpenReviewThread($documentId: ID!, $blockId: String!, $startOffset: Int!, $endOffset: Int!, $quote: String!, $body: String!) {
    openReviewThread(documentId: $documentId, blockId: $blockId, startOffset: $startOffset, endOffset: $endOffset, quote: $quote, body: $body) {
      ...ReviewThreadFields
    }
  }
`;

export const ADD_REVIEW_COMMENT = gql`
  ${REVIEW_THREAD_FIELDS}
  mutation AddReviewComment($threadId: ID!, $body: String!) {
    addReviewComment(threadId: $threadId, body: $body) {
      ...ReviewThreadFields
    }
  }
`;

export const RESOLVE_REVIEW_THREAD = gql`
  ${REVIEW_THREAD_FIELDS}
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(threadId: $threadId) {
      ...ReviewThreadFields
    }
  }
`;

// ---------------------------------------------------------------------
// The corpus admin (C2 §5) — reviewer invite and revoke.
// ---------------------------------------------------------------------

export const REVIEWERS = gql`
  query Reviewers {
    reviewers {
      id
      name
      email
    }
  }
`;

export const INVITE_REVIEWER = gql`
  mutation InviteReviewer($email: String!, $name: String!) {
    inviteReviewer(email: $email, name: $name) {
      userId
      email
      inviteUrl
      expiresAt
    }
  }
`;

export const REVOKE_REVIEWER = gql`
  mutation RevokeReviewer($userId: ID!) {
    revokeReviewer(userId: $userId)
  }
`;

// ---------------------------------------------------------------------
// Personal access tokens. The secret comes back from CREATE_API_TOKEN and
// nowhere else — MY_API_TOKENS cannot return it, because the server does
// not have it to return.
// ---------------------------------------------------------------------

export type ApiTokenScope = 'READ' | 'WRITE';

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  scope: ApiTokenScope;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const API_TOKEN_FIELDS = gql`
  fragment ApiTokenFields on ApiToken {
    id
    name
    prefix
    scope
    lastUsedAt
    expiresAt
    revokedAt
    createdAt
  }
`;

export const MY_API_TOKENS = gql`
  ${API_TOKEN_FIELDS}
  query MyApiTokens {
    myApiTokens {
      ...ApiTokenFields
    }
  }
`;

export const CREATE_API_TOKEN = gql`
  ${API_TOKEN_FIELDS}
  mutation CreateApiToken($name: String!, $scope: ApiTokenScope!, $expiresInDays: Int) {
    createApiToken(name: $name, scope: $scope, expiresInDays: $expiresInDays) {
      token
      apiToken {
        ...ApiTokenFields
      }
    }
  }
`;

export const REVOKE_API_TOKEN = gql`
  ${API_TOKEN_FIELDS}
  mutation RevokeApiToken($id: ID!) {
    revokeApiToken(id: $id) {
      ...ApiTokenFields
    }
  }
`;

// ---------------------------------------------------------------------
// Template types and scope templates (journeys build plan T1). A designer
// keeps the types, sales keeps what each type contains; the API checks the
// two capabilities separately, and the desk screen mirrors that split.
// ---------------------------------------------------------------------

/** What a template's own list may hold — the API refuses EXTRA there. */
export type TemplateScopeKind = 'PAGE' | 'FEATURE' | 'DELIVERABLE';

export type TemplateScopeItem = {
  id: string;
  key: string;
  kind: TemplateScopeKind;
  labelFa: string;
  labelEn: string;
  position: number;
};

export type TemplateType = {
  id: string;
  slug: string;
  labelFa: string;
  labelEn: string;
  position: number;
  active: boolean;
  items: TemplateScopeItem[];
};

const TEMPLATE_TYPE_FIELDS = gql`
  fragment TemplateTypeFields on TemplateType {
    id
    slug
    labelFa
    labelEn
    position
    active
    items {
      id
      key
      kind
      labelFa
      labelEn
      position
    }
  }
`;

export const TEMPLATE_TYPES = gql`
  ${TEMPLATE_TYPE_FIELDS}
  query TemplateTypes {
    templateTypes {
      ...TemplateTypeFields
    }
  }
`;

export const CREATE_TEMPLATE_TYPE = gql`
  ${TEMPLATE_TYPE_FIELDS}
  mutation CreateTemplateType($slug: String!, $labelFa: String!, $labelEn: String!) {
    createTemplateType(slug: $slug, labelFa: $labelFa, labelEn: $labelEn) {
      ...TemplateTypeFields
    }
  }
`;

export const UPDATE_TEMPLATE_TYPE = gql`
  ${TEMPLATE_TYPE_FIELDS}
  mutation UpdateTemplateType($id: ID!, $slug: String, $labelFa: String, $labelEn: String, $active: Boolean) {
    updateTemplateType(id: $id, slug: $slug, labelFa: $labelFa, labelEn: $labelEn, active: $active) {
      ...TemplateTypeFields
    }
  }
`;

export const REORDER_TEMPLATE_TYPES = gql`
  ${TEMPLATE_TYPE_FIELDS}
  mutation ReorderTemplateTypes($ids: [ID!]!) {
    reorderTemplateTypes(ids: $ids) {
      ...TemplateTypeFields
    }
  }
`;

export const SET_TEMPLATE_SCOPE = gql`
  ${TEMPLATE_TYPE_FIELDS}
  mutation SetTemplateScope($typeId: ID!, $items: [TemplateScopeItemInput!]!) {
    setTemplateScope(typeId: $typeId, items: $items) {
      ...TemplateTypeFields
    }
  }
`;

// ---------------------------------------------------------------------
// The theme catalogue (journeys build plan T2). Staff-only: nothing in the
// portal reads a Theme. `licenseCost` is Root's cost in Toman, a decimal
// string — it is not customer money, so it needs no `money.read`.
// ---------------------------------------------------------------------

export type RtlSupport = 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN';

export type Theme = {
  id: string;
  name: string;
  vendor: string | null;
  /** https only, and never framed: render it as a link that opens in a new tab. */
  demoUrl: string | null;
  /** `/files/<id>`, a private staff-only route; null until a preview is uploaded. */
  previewUrl: string | null;
  rtlSupport: RtlSupport;
  licenseCost: string | null;
  notesFa: string | null;
  notesEn: string | null;
  active: boolean;
  typeIds: string[];
};

const THEME_FIELDS = gql`
  fragment ThemeFields on Theme {
    id
    name
    vendor
    demoUrl
    previewUrl
    rtlSupport
    licenseCost
    notesFa
    notesEn
    active
    typeIds
  }
`;

export const THEMES = gql`
  ${THEME_FIELDS}
  query Themes {
    themes {
      ...ThemeFields
    }
  }
`;

export const CREATE_THEME = gql`
  ${THEME_FIELDS}
  mutation CreateTheme(
    $name: String!
    $vendor: String
    $demoUrl: String
    $rtlSupport: RtlSupport
    $licenseCost: String
    $notesFa: String
    $notesEn: String
  ) {
    createTheme(
      name: $name
      vendor: $vendor
      demoUrl: $demoUrl
      rtlSupport: $rtlSupport
      licenseCost: $licenseCost
      notesFa: $notesFa
      notesEn: $notesEn
    ) {
      ...ThemeFields
    }
  }
`;

export const UPDATE_THEME = gql`
  ${THEME_FIELDS}
  mutation UpdateTheme(
    $id: ID!
    $name: String
    $vendor: String
    $demoUrl: String
    $rtlSupport: RtlSupport
    $licenseCost: String
    $notesFa: String
    $notesEn: String
    $active: Boolean
  ) {
    updateTheme(
      id: $id
      name: $name
      vendor: $vendor
      demoUrl: $demoUrl
      rtlSupport: $rtlSupport
      licenseCost: $licenseCost
      notesFa: $notesFa
      notesEn: $notesEn
      active: $active
    ) {
      ...ThemeFields
    }
  }
`;

export const SET_TEMPLATE_TYPE_THEMES = gql`
  ${THEME_FIELDS}
  mutation SetTemplateTypeThemes($typeId: ID!, $themeIds: [ID!]!) {
    setTemplateTypeThemes(typeId: $typeId, themeIds: $themeIds) {
      ...ThemeFields
    }
  }
`;

// ---------------------------------------------------------------------------
// Requests (journeys build plan J2). Every mutation returns the whole Request
// (thread included), so the drawer and the desk thread update from the
// mutation's own payload; the drawer additionally refetches on open and on
// window focus — there is no websocket.
// ---------------------------------------------------------------------------

export const MY_REQUESTS = gql`
  ${REQUEST_FIELDS}
  query MyRequests {
    myRequests {
      ...RequestFields
    }
  }
`;

export const ALL_REQUESTS = gql`
  ${REQUEST_FIELDS}
  query AllRequests($status: ProjectStatus) {
    allRequests(status: $status) {
      ...RequestFields
    }
  }
`;

export const REQUEST = gql`
  ${REQUEST_FIELDS}
  query Request($projectId: ID!) {
    request(projectId: $projectId) {
      ...RequestFields
    }
  }
`;

export const SUBMIT_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation SubmitRequest($title: String!, $body: String!, $lang: String!) {
    submitRequest(title: $title, body: $body, lang: $lang) {
      ...RequestFields
    }
  }
`;

export const POST_REQUEST_MESSAGE = gql`
  ${REQUEST_FIELDS}
  mutation PostRequestMessage($projectId: ID!, $body: String!) {
    postRequestMessage(projectId: $projectId, body: $body) {
      ...RequestFields
    }
  }
`;

export const ARCHIVE_REQUEST = gql`
  ${REQUEST_FIELDS}
  mutation ArchiveRequest($projectId: ID!, $reason: String!) {
    archiveRequest(projectId: $projectId, reason: $reason) {
      ...RequestFields
    }
  }
`;
