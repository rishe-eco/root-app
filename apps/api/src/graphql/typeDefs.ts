export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum Role {
    CUSTOMER
    ADMIN
    CONTRIBUTOR
    REVIEWER
    DEVELOPER
    "Journeys build plan S1."
    SALES
    "Journeys build plan S1."
    DESIGNER
  }

  "Journeys build plan S3."
  enum UserState {
    INVITED
    ACTIVE
    DISABLED
  }

  "Journeys build plan S3 — the tools a customer can be given. One value today."
  enum ToolKey {
    PRODUCT_IMPORT
  }

  enum ContractStatus {
    DRAFT
    WAITING_ON_CUSTOMER
    WAITING_ON_ROOT
    IN_PROGRESS
    FINAL_REVIEW
    DONE
    DISCARDED
  }

  enum CommentTarget {
    DESIGN
    CONTRACT
  }

  enum ChangeAction {
    CREATED
    PUBLISHED
    CHOSE_CONCEPT
    APPROVED_PAGE
    UNAPPROVED_PAGE
    DESIGN_COMPLETE
    APPROVED_CONTRACT
    SIGNED
    COMMENTED
    SCOPE_ON
    SCOPE_OFF
    STATUS_CHANGED
    CONTRACT_REVISED
    DESIGN_REVISED
    CONTRACT_AMENDED
    RE_APPROVED
    RE_SIGNED
    AMENDMENT_SIGNED
    AMENDMENT_APPROVED
  }

  type User {
    id: ID!
    "Journeys build plan J1: optional — a customer may be identified by phone alone. See phone below."
    email: String
    "E.164, normalized. Optional on the same terms as email — an account has at least one of the two, never neither (the User_has_identifier CHECK)."
    phone: String
    name: String!
    roles: [Role!]!
    """
    What this person may do, unioned across their roles. Plain strings rather
    than an enum because the names are dotted ("contracts.readAll") and a
    GraphQL enum value cannot contain a dot.

    **The client branches on these, never on roles.** Testing a role on the
    client has exactly the failure the server-side table exists to prevent —
    it just fails in a place that is harder to see.
    """
    capabilities: [String!]!
    clientName: String
    locale: String!
    "PD-10. While true, every mutation but setNewPassword (and reading me/signing out) refuses PASSWORD_CHANGE_REQUIRED."
    passwordChangeRequired: Boolean!
    "Journeys build plan S3. DISABLED accounts lose their session on the next request."
    state: UserState!
  }

  "An active tool grant (journeys build plan S3). A revoked one is history and is not listed."
  type ToolGrant {
    id: ID!
    tool: ToolKey!
    grantedAt: DateTime!
    grantedBy: User!
  }

  """
  One customer, everything sales needs on one page (journeys build plan S3).
  Each part answers to its own visibility rule rather than to the page's:
  contracts by contract visibility, tickets by tickets.answer, invoices by
  money.read. Requests join it with J2.
  """
  type CustomerProfile {
    "The customer's user id — so a client cache can tell two profiles apart and merge a mutation's result into the query's."
    id: ID!
    user: User!
    "Active grants only, oldest first."
    grants: [ToolGrant!]!
    contracts: [Contract!]!
    "Empty without tickets.answer."
    tickets: [Ticket!]!
    "The billing totals for this customer. Null without money.read — never zero, which would read as 'owes nothing'."
    invoices: BillingReport
  }

  type PageDesign {
    id: ID!
    key: String!
    labelFa: String!
    labelEn: String!
    imageUrl: String
    approved: Boolean!
    approvedAt: DateTime
  }

  type DesignConcept {
    id: ID!
    key: String!
    labelFa: String!
    labelEn: String!
    "For a pre-made round's theme: the copy of its preview, owned by this contract (J8)."
    imageUrl: String
    chosen: Boolean!
    pages: [PageDesign!]!
    """
    J8: a pre-made round's concept is a theme, as it was shown — name, vendor
    and demo URL taken when it was proposed. Never the licence cost. Null for
    a concept that is not a theme.
    """
    themeSnapshot: ThemeSnapshot
    "The catalogue row this came from. Staff only — null for a customer and under view-as. A round reads its snapshot, never this."
    themeId: ID
  }

  """
  What a design round remembers of a theme (journeys build plan J8). The demo
  is opened in a new tab and never framed: third-party demos refuse framing and
  the portal's CSP does not allow them.
  """
  type ThemeSnapshot {
    name: String!
    vendor: String
    demoUrl: String
  }

  "What a palette item is (J8): a colour is a hex, a font a family name, logo usage a short note."
  enum PaletteKind {
    COLOR
    FONT
    LOGO_USAGE
  }

  "One entry of a custom design's palette (J8), on the revision it was shown in."
  type DesignPaletteItem {
    id: ID!
    kind: PaletteKind!
    "A Latin identifier — primary, heading, logo-dark."
    role: String!
    "A lowercase #rrggbb, a font family name, or a note, by kind."
    value: String!
    labelFa: String!
    labelEn: String!
    "A specimen or a logo on a background, if there is one."
    imageUrl: String
    position: Int!
  }

  """
  Rounds sales granted beyond the brief's allowance (J8; journeys Q-S5). Staff
  only — a customer sees the resulting allowance ("round 2 of 4"), not why.
  """
  type AllowanceExtension {
    id: ID!
    step: StepKind!
    phaseId: ID
    extra: Int!
    reason: String!
    approvedBy: User!
    "The draft invoice's amount, as a decimal string. Null without money.read, and when the extension was free."
    charge: String
    createdAt: DateTime!
  }

  """
  Status lifecycle (build plan L1; spec §3): proposed at scoping, agreed once
  settled, in-build/in-demo as it moves through a phase (L2), accepted once a
  demo review closes it out (L3). DECLINED and TRADED are terminal.
  """
  enum ScopeStatus {
    PROPOSED
    AGREED
    IN_BUILD
    IN_DEMO
    ACCEPTED
    DECLINED
    TRADED
  }

  """
  What a registry row is (journeys build plan T1): a page, a feature, a
  deliverable, or one of the completeness checklist's standard areas (EXTRA).
  A template's own lists never hold EXTRA.
  """
  enum ScopeKind {
    PAGE
    FEATURE
    DELIVERABLE
    EXTRA
  }

  enum ProjectStatus {
    "Journeys build plan J2: a customer's request with no contract yet. Holds the request and its thread, nothing else."
    REQUESTED
    ACTIVE
    "Since J2, set only by archiving a request — always with a reason."
    ARCHIVED
  }

  enum ScopeMoveDirection {
    UP
    DOWN
  }

  """
  Appendix 1, grown from a flat tickable checklist into the registry every
  other document reads from (spec §3; build plan L1).

  checked is the customer's own tick, unrelated to status — see
  schema.prisma's note on ScopeItem for why the two are never conflated.
  """
  type ScopeItem {
    id: ID!
    key: String!
    labelFa: String!
    labelEn: String!
    position: Int!
    kind: ScopeKind!
    "The agreement that agreed this item (PD-5); null before any contract."
    contractId: ID
    checked: Boolean!
    status: ScopeStatus!
    "A known stand-in that will change — never gates anything."
    temporary: Boolean!
    outOfScope: Boolean!
    adminWork: Boolean!
    "Both null or both set — see schema.prisma's CHECK constraint."
    decidedAt: DateTime
    decidedNote: String
    "Set when status is DECLINED. Not required to be set — see schema.prisma."
    declinedReason: String
    "Who asked, in what context. Free text — no round object exists yet."
    originNote: String
    originRound: String
    originAskedAt: DateTime!
    """
    Which phase (build plan L2) is building this item, if any. Pre-existing
    gap found by L3's first successful e2e run: the web's own
    CONTRACT_FIELDS fragment has selected this since L2 shipped, and the
    Prisma column has existed just as long, but the GraphQL type never
    declared the field — so every query built from that fragment
    (MyContracts, AllContracts, CreateContract, …) failed schema validation
    outright. Fixed here rather than deferred, since it blocks any
    meaningful e2e verification of this stage's own new surface.
    """
    phaseId: ID
  }

  """
  A snapshot-frozen scope item — the shape Appendix 1 freezes into a published
  contract revision (build plan L1). No id, no status: a position in a frozen
  document, exactly like Article on Contract.articles.
  """
  type ScopeSnapshotItem {
    key: String!
    labelFa: String!
    labelEn: String!
    "Journeys build plan J7: format-2 snapshots freeze each item's kind so Appendix 1 can be grouped. Null for a format-1 revision."
    kind: ScopeKind
  }

  """
  Paired movements — one item out, one in (spec §4). Both parties confirm
  before it executes. The customer's half is confirmScopeTradeCustomer (J5) —
  the contract's own customer; executeScopeTrade succeeds once both have
  confirmed, and is the post-lock way to change a scope.
  """
  type ScopeTrade {
    id: ID!
    outItem: ScopeItem!
    inItem: ScopeItem!
    proposedBy: User!
    proposedAt: DateTime!
    rootConfirmedAt: DateTime
    customerConfirmedAt: DateTime
    executedAt: DateTime
  }

  enum ScopeProposalKind {
    ADD
    REMOVE
    RESTORE
  }

  enum ScopeProposalDecision {
    ACCEPTED
    DECLINED
  }

  """
  What a customer asked of their contract's scope (journeys build plan J5,
  step 2a), in their own words and language, and Root's decision on it. Not a
  registry row: an accepted ADD is when sales writes the bilingual item
  (createdItem). "The scope is confirmed" is derived — no proposal is left
  undecided.
  """
  type ScopeProposal {
    id: ID!
    kind: ScopeProposalKind!
    "The item a REMOVE or RESTORE is about; null for an ADD."
    scopeItem: ScopeItem
    "What an ADD is: a page, a feature or a deliverable."
    requestedKind: ScopeKind
    "The customer's words."
    text: String!
    "The language they wrote in — fa or en."
    lang: String!
    proposedBy: User!
    createdAt: DateTime!
    "Null while the proposal waits for Root."
    decidedAt: DateTime
    decision: ScopeProposalDecision
    "Set on a declined proposal — the customer reads it."
    declineReason: String
    "For an accepted ADD: the registry item sales created."
    createdItem: ScopeItem
  }

  """
  A note on the contract draft (journeys build plan J6) — a FeedbackItem of the
  DRAFT step with where its article is now. articleNumber is the article's number
  in the revision the note was written against (revisionVersion); the current
  revision may number it differently (currentArticleNumber), have changed its
  text (articleChangedSince), or no longer have it (articleGone — never guessed:
  a note whose article cannot be found by title says so).
  """
  type DraftNote {
    item: FeedbackItem!
    revisionVersion: Int!
    "True when the note is on the revision the customer is reading now."
    onCurrentRevision: Boolean!
    articleNumber: Int
    currentArticleNumber: Int
    articleChangedSince: Boolean!
    articleGone: Boolean!
  }

  """
  The registry's owner (build plan D1). Phases, demos and dependencies (L2,
  L5) are not modelled yet — this is deliberately thin.
  """
  type Project {
    id: ID!
    "Build plan L5: whose board this is, for a cross-project dependency dashboard."
    customer: User!
    titleFa: String!
    titleEn: String!
    status: ProjectStatus!
    scopeItems: [ScopeItem!]!
    scopeTrades: [ScopeTrade!]!
    "Ordered by number — build plan L2."
    phases: [Phase!]!
    "Derived fresh on every read (lib/phase.ts) — never a stored percentage (F5)."
    progress: ProjectProgress!
    "The dependency board (build plan L5) — every commitment, both sides, soonest-due first."
    dependencies: [Dependency!]!
    "The product-import panel's run history (build plan L7) — newest first."
    serviceRuns: [ServiceRun!]!
  }

  # ---------------------------------------------------------------------
  # Requests — a project before a contract (journeys build plan J2)
  # ---------------------------------------------------------------------

  """
  Who wrote a message, or who a request is from — deliberately not User:
  the customer reads the staff member's name and nothing else about them (no
  email, no phone, no roles), and sales reads the customer's name and company.
  """
  type RequestParty {
    id: ID!
    name: String!
    clientName: String
  }

  "One message in a request's thread. Append-only, and read by both sides — its own table, never shared with tickets or the staff-only notes (J3)."
  type RequestMessage {
    id: ID!
    author: RequestParty!
    body: String!
    createdAt: DateTime!
  }

  """
  What a customer asked for, before there is a contract — the request half of
  a project (the id is the project's). Read by the customer who made it and by
  contracts.readAll; anyone else gets NOT_FOUND, and design and development
  never see one. The thread outlives the status: after conversion it stays,
  read-only, linked from the contract.
  """
  type Request {
    id: ID!
    customer: RequestParty!
    "What the customer called it. Sales replaces the project's placeholder titles at conversion; this stays as asked."
    title: String!
    body: String!
    "The language it was written in — sales reads it in that language."
    lang: String!
    "REQUESTED (pending), ARCHIVED (with archivedReason), or ACTIVE (converted — the thread is now read-only)."
    status: ProjectStatus!
    requestedAt: DateTime!
    archivedAt: DateTime
    "Always present when status is ARCHIVED (Project_archived_has_reason)."
    archivedReason: String
    messages: [RequestMessage!]!
    """
    The contract this request became, once it has one this viewer may open —
    the earliest on the project; a customer only sees a published one. Null
    while pending or archived.
    """
    contractId: ID
  }

  # ---------------------------------------------------------------------
  # The dependency board (build plan L5; spec §7) — symmetric commitments,
  # customer-side and Root-side, one board under one rule.
  # ---------------------------------------------------------------------

  enum DependencySide {
    CUSTOMER
    ROOT
  }

  """
  One tracked commitment — owner (via side), a due date, and a verification
  step that is the whole feature (build plan L5's banked trap): "they said we
  have a host" is what failed at the engagement this is drawn from; "we
  deployed a test file to the host" is what verifiedNote exists to hold. A
  verifiedAt with no recorded *how* would rebuild exactly that promise.
  """
  type Dependency {
    id: ID!
    side: DependencySide!
    titleFa: String!
    titleEn: String!
    dueAt: DateTime!
    "Derived fresh on every read (lib/dependency.ts) — never a stored flag."
    overdue: Boolean!
    createdBy: User!
    createdAt: DateTime!
    verifiedAt: DateTime
    verifiedBy: User
    "What was actually done to verify it. Required together with verifiedAt/verifiedBy, never on its own."
    verifiedNote: String
    "Whose commitment this is — present so a cross-project list (the staff dashboard) can say."
    project: Project!
    """
    Journeys build plan J4: set when the step-1 brief owns this row (domain,
    host, content, gateway, smsLine or enamad). Such a row cannot be deleted
    from the board (BRIEF_OWNED) — change the requirements instead.
    """
    briefKey: String
    "Who verifies it: the developer (technical) or sales. Set by the brief's key."
    technical: Boolean!
  }

  # ---------------------------------------------------------------------
  # Phases and the live demo surface (build plan L2; spec §4 stage 6, §6)
  # ---------------------------------------------------------------------

  """
  Coarse progress. Deliberately has no "on track"/"at risk" field — nothing
  built so far carries a due date or a verified commitment to judge that
  against (that is L5's dependency board). See lib/phase.ts.
  """
  type ProjectProgress {
    totalPhases: Int!
    "Null only when the project has no phases yet."
    currentPhaseNumber: Int
    currentPhaseTitleFa: String
    currentPhaseTitleEn: String
    "Accepted scope items in the current phase, out of its total — DECLINED and TRADED items are excluded from both counts."
    itemsAcceptedInPhase: Int!
    itemsTotalInPhase: Int!
  }

  """
  A slice of the build, ordered. Nothing on this type is a status set by
  hand — see ProjectProgress for the derived read.
  """
  type Phase {
    id: ID!
    number: Int!
    titleFa: String!
    titleEn: String!
    "A stand-in for a real Milestone/BillingEntry linkage (L6) — free text for now."
    milestoneLabel: String
    "Journeys build plan J4 (PD-5): the contract this phase delivers."
    contractId: ID!
    "A calendar day (PD-19) — render in UTC. Null until sales dates it."
    plannedEndAt: DateTime
    scopeItems: [ScopeItem!]!
    "Newest first."
    demos: [Demo!]!
  }

  """
  A declared page on a demo — what a reported path is matched against
  (lib/demoPages.ts). Never inferred.
  """
  type DemoPage {
    id: ID!
    key: String!
    labelFa: String!
    labelEn: String!
    canonicalPath: String!
    "The design-image toggle (L2.1) — null until a page design is attached."
    pageDesign: PageDesign
  }

  """
  "A page we did not expect" (L2.2) — a reported path matching no declared
  DemoPage. A block string, not a quoted one: the inner quotes are part of
  the phrase the plan uses, and an escaped quote inside this template literal
  collapses to a bare quote before GraphQL ever sees it, which would end the
  description early and make the whole schema unparseable.
  """
  type DemoUnmatchedPath {
    id: ID!
    normalizedPath: String!
    firstSeenAt: DateTime!
    lastSeenAt: DateTime!
    count: Int!
  }

  """
  The live staging site, embedded (D2) — never a capture, never proxied.
  """
  type Demo {
    id: ID!
    """
    Journeys build plan J9: a site demo (L2's live staging site) or a mockup (an
    uploaded bundle, served by this app on a per-viewer subdomain).
    """
    kind: DemoKind!
    "Null exactly for a MOCKUP demo (J9): it is served at a per-view subdomain, never at a stored URL. Ask mockupViewUrl."
    stagingUrl: String
    "D2's build reference. A plain string until L3b's Build object exists."
    buildRef: String
    "Convention, not machinery (L2.2) — no deploy lock is implied by these dates."
    reviewWindowStart: DateTime
    reviewWindowEnd: DateTime
    """
    Null means draft — visible to staff only. Build plan L3, spec §6: "a demo
    cannot be published naked" — publishDemo refuses without a frame first.
    """
    publishedAt: DateTime
    "Null until generateDemoFrame has been called at least once."
    frame: DemoFrame
    pages: [DemoPage!]!
    "Visible so the desk can notice a route nobody declared, rather than it vanishing silently."
    unmatchedPaths: [DemoUnmatchedPath!]!
    "Every feedback item filed against this demo's pages or frame lines, newest first."
    feedbackItems: [FeedbackItem!]!
    """
    J9b: a MOCKUP demo's iterations, oldest first — the customer's are the published
    ones only. Empty for a site demo, whose builds hang off its phase.
    """
    builds: [Build!]!
    """
    J9b: frame lines every mockup has that are words of the interface, not rows —
    codes (MOCKUP_TEMPORARY) the web renders from its locale keys. Empty for a site demo.
    """
    fixedFrameLines: [String!]!
    """
    J9b, staff readers only: the page paths the newest bundle has (index.html is "/",
    about.html is "/about") — what the desk offers when the designer maps a page.
    """
    bundlePages: [String!]!
  }

  "What a demo shows (journeys build plan J9)."
  enum DemoKind {
    MOCKUP
    SITE
  }

  "What a build is a build of (journeys build plan J9): an uploaded mockup iteration or a state of the staging site."
  enum BuildKind {
    MOCKUP
    SITE
  }

  # ---------------------------------------------------------------------
  # Review frames and feedback intake (build plan L3; spec §6). Named
  # without the bare word "review" in any identifier throughout — see
  # schema.prisma's section comment for why (desk/sections.ts already has
  # review and reviewAdmin for the unrelated Review Room). The desk section
  # for this stage is "demos"; "review frame" and "demo review" stay prose.
  # ---------------------------------------------------------------------

  "The four buckets spec §6 asks the frame to project from the registry."
  enum DemoFrameLineKind {
    NEW
    KNOWN_MISSING
    TEMPORARY
    DECIDED
  }

  """
  One line of the frame — a commentable target in its own right, alongside a
  DemoPage. textFa/textEn are a snapshot of the source scope item's label at
  generation time (schema.prisma) — never recomputed live.
  """
  type DemoFrameLine {
    id: ID!
    kind: DemoFrameLineKind!
    textFa: String!
    textEn: String!
    position: Int!
    "Null for a line Root typed by hand, or one whose source item was later deleted. Interception (D4) reads this item's own temporary/decidedAt."
    scopeItem: ScopeItem
    "The one feedback item anchored to this line, if any (D4: duplicates collapse on target)."
    feedbackItem: FeedbackItem
    "Build plan L3b's third source, provenance only — set when this line is the PM's write-up of an unprompted build change."
    buildChangeEntry: BuildChangeEntry
  }

  """
  The review frame itself (spec §6). A demo cannot be published without one
  (publishDemo's NO_FRAME refusal) — authoring this is the gate, not a
  suggestion.
  """
  type DemoFrame {
    id: ID!
    "Freeform context beside the generated lines — optional."
    summaryFa: String
    summaryEn: String
    authoredBy: User!
    lines: [DemoFrameLine!]!
    """
    Build plan L3b's third source, not yet written up as a line of its own —
    "what's new" the registry cannot know about (a refactor, a fix found in
    passing). Staff (contract readers) only; empty for anyone else, and
    empty is not a claim that nothing changed — see fields.ts's own comment.
    """
    unpromptedChanges: [BuildChangeEntry!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  Fates a feedback item can occupy (spec §6: "every item shows its fate —
  accepted / done / declined-because"), on every step (journeys build plan S2,
  PD-1). RATIFIED is gone (PD-2): a submission is its own ratification.
  """
  enum FeedbackStatus {
    "Raised by the customer (or reopened) and not yet resolved by Root. Blocks the step's approval."
    OPEN
    "Root's claim that this is resolved. Not the customer's acceptance — see acceptedAt."
    ADDRESSED
    "Declined, with its reason — spec §6's declined-because. The customer may reopen it until the step is approved."
    DECLINED
    "Converted to a change ticket (createTicketFromFeedback) — a resolution the customer sees."
    MOVED
    "The step was approved with this item resolved (approveStep, and nothing else)."
    ACCEPTED
  }

  "What a staff answer resolves an item to (PD-4)."
  enum FeedbackResolution {
    ADDRESSED
    DECLINED
  }

  """
  Whether a staff answer has reached the customer (PD-3, PD-4). The customer
  — and sales viewing as the customer — is never shown a PENDING or DECLINED one.
  """
  enum AnswerApproval {
    NOT_REQUIRED
    PENDING
    APPROVED
    DECLINED
  }

  """
  One voice on a feedback item (spec §6, F8) — and, when staff wrote it, an
  answer (PD-4): a comment that may carry a resolution.
  """
  type FeedbackComment {
    id: ID!
    author: User!
    body: String!
    "Set on a staff answer that resolves the item; applied at once for a direct answer, at approval for a pending one."
    resolution: FeedbackResolution
    approval: AnswerApproval!
    "Staff only (null for the customer): who approved or declined it."
    approvedBy: User
    approvedAt: DateTime
    "Staff only: the reason a declined answer was declined — the author sees it."
    approvalNote: String
    "Staff only: the author's own words, kept when sales edited the answer before approving it."
    originalBody: String
    createdAt: DateTime!
  }

  """
  Per-item feedback intake (spec §6) — never a comment blob — on any step.
  An item binds to one anchor, whose kind depends on the step (the step's
  brief field, a scope item, an article of a revision, a design page /
  concept / palette item, a demo page or frame line), or to the step as a whole
  (general). Two submissions against the same target collapse into one row
  (D4); all general comments on one step are one thread.
  """
  type FeedbackItem {
    id: ID!
    contractId: ID!
    step: StepKind!
    "Set for a DEMO item; null for every other step."
    phaseId: ID
    general: Boolean!
    "REQUIREMENTS: the brief field the note is about."
    briefField: String
    "SCOPE: the registry item the note is about."
    anchorScopeItem: ScopeItem
    "DRAFT: the revision, and the article (Appendix 1 is article 15) if the note is about one."
    contractRevisionId: ID
    articleNumber: Int
    "DESIGN: the revision, and at most one of the concept, page or palette item."
    designRevisionId: ID
    conceptId: ID
    pageDesignId: ID
    paletteItemId: ID
    """
    J8: set on the DESIGN general item while a "show me other options" request
    waits for the next round — the round's publish answers it and clears this.
    """
    otherOptionsAskedAt: DateTime
    "MOCKUP and DEMO: the page or frame line."
    demoPage: DemoPage
    frameLine: DemoFrameLine
    status: FeedbackStatus!
    "Set when this item was filed against a decided/temporary scope item and the submitter chose to proceed (D4's interception)."
    reopenedScopeItem: ScopeItem
    """
    Build plan L3b.2's first rule, as two fields rather than one: the
    developer's claim, and which build carried it. Not the customer's
    acceptance — see acceptedAt. Cleared the moment a new comment reopens the
    item (lib/feedbackRules.ts's reopensOnComment).
    """
    addressedInBuild: Build
    "The customer's acceptance: written by the step's approval (approveStep) and nothing else."
    acceptedAt: DateTime
    acceptedBy: User
    "Oldest first — the opening voice, then whoever piled on. A customer never sees a pending or declined staff answer here."
    comments: [FeedbackComment!]!
    "Set once this item becomes a change ticket (build plan L4, createTicketFromFeedback) — never more than one, and never unset again."
    ticket: Ticket
    createdAt: DateTime!
  }

  "Why submitFeedback was intercepted (D4) — a code and its parameter, never a sentence (house rule 6)."
  enum FeedbackInterceptionReason {
    DECIDED
    TEMPORARY
  }

  """
  What submitting one piece of feedback actually did. House rule 6: the API
  returns a code and parameters, the web renders the sentence — the
  interception prompt is built client-side from interceptionReason and
  interceptionScopeItem's own decidedAt/decidedNote/temporary fields.
  """
  type FeedbackSubmitResult {
    "Null when interception blocked the write — see intercepted below."
    item: FeedbackItem
    "True whenever the target resolved to a decided/temporary scope item, whether or not the submitter had already confirmed past it."
    intercepted: Boolean!
    interceptionReason: FeedbackInterceptionReason
    "The scope item interception is asking about."
    interceptionScopeItem: ScopeItem
  }

  """
  What a piece of feedback is about (journeys build plan S2). Which fields may
  be set depends on the step, and the API refuses a mismatch with
  INVALID_TARGET: REQUIREMENTS — briefField; SCOPE — scopeItemId; DRAFT —
  contractRevisionId (+ articleNumber); DESIGN — designRevisionId (+ at most
  one of conceptId, pageDesignId, paletteItemId); MOCKUP and DEMO — demoId +
  exactly one of demoPageId, frameLineId. Every step also takes general: the
  step as a whole, where all such comments collapse into one thread.
  """
  input FeedbackTargetInput {
    general: Boolean
    briefField: String
    scopeItemId: ID
    contractRevisionId: ID
    articleNumber: Int
    designRevisionId: ID
    conceptId: ID
    pageDesignId: ID
    paletteItemId: ID
    demoId: ID
    demoPageId: ID
    frameLineId: ID
  }

  """
  One answer waiting in sales' queue (feedback.approveAnswers) — the comment,
  the item it is on, and enough of the contract to say where. Thin on purpose:
  never a Contract, which carries the fee.
  """
  type PendingAnswer {
    "The comment's id."
    id: ID!
    comment: FeedbackComment!
    item: FeedbackItem!
    contractId: ID!
    contractRef: String!
    contractTitleFa: String!
    contractTitleEn: String!
    step: StepKind!
    phaseNumber: Int
  }

  """
  One open item a staff member may answer (myFeedbackQueue): whether their
  answer would go straight to the customer (route), and whether it is theirs
  by assignment (mine) — the queue puts those first.
  """
  type FeedbackQueueEntry {
    item: FeedbackItem!
    contractId: ID!
    contractRef: String!
    contractTitleFa: String!
    contractTitleEn: String!
    route: AnswerRoute!
    mine: Boolean!
  }

  enum AnswerRoute {
    DIRECT
    NEEDS_APPROVAL
  }

  "What reporting one browser navigation actually did — not the whole contract, since this fires on every page change and both a customer and Root may call it."
  type DemoPathReport {
    matched: Boolean!
    page: DemoPage
    normalizedPath: String!
  }

  # ---------------------------------------------------------------------
  # Builds and the resolution ledger (build plan L3b; spec §6's gap). Named
  # without the bare word "revision" or "round" — see schema.prisma's own
  # comment on Build for why (L3b.3's first banked trap). Everything below
  # is gated on builds.author, never a contract verb, and nothing here
  # returns Contract! — see resolvers/builds.ts's own comment on why.
  # ---------------------------------------------------------------------

  "A phase, thin — the build-authoring form's phase picker (builds.author). Never touches Contract."
  type BuildPhase {
    id: ID!
    number: Int!
    titleFa: String!
    titleEn: String!
    projectId: ID!
    projectTitleFa: String!
    projectTitleEn: String!
  }

  """
  Which claim a change entry makes about a feedback item — never the
  customer's acceptance, which is FeedbackItem.acceptedAt, a separate write
  (build plan L3b.2's first rule).
  """
  enum BuildChangeOutcome {
    "The developer's claim — and, in the demo step, the developer's answer (S2): it resolves the item directly."
    ADDRESSED
    "Requires note — declined-*because*, structurally (L3b.2's third rule). The customer may reopen a declined item until the step is approved."
    DECLINED
    """
    The explicit "still open, carried forward" (a developer can say "not this
    build"). The item stays OPEN, so it still blocks the step's approval.
    """
    CARRIED_FORWARD
  }

  """
  One entry in a build's change list (build plan L3b.1) — a feedback item's
  disposition, a scope item shipping, or an unprompted change nobody asked
  for. One list, one optional origin, not two lists.
  """
  type BuildChangeEntry {
    id: ID!
    feedbackItem: FeedbackItem
    scopeItem: ScopeItem
    "Set exactly when feedbackItem is."
    outcome: BuildChangeOutcome
    """
    The authored prose — required (structurally) when outcome is DECLINED,
    or when there is no origin at all: "the note is the entry."
    """
    note: String
    """
    Which language note was authored in ("fa"/"en"), not a second required
    translation column. Null exactly when note is.
    """
    noteLang: String
    createdAt: DateTime!
  }

  """
  A declared state of the staging site, belonging to a phase (build plan
  L3b.1) — D2's bare Demo.buildRef string, grown into the object. Not a
  revision: nothing here is hash-sealed.
  """
  type Build {
    id: ID!
    "J9: a MOCKUP build is an iteration of the mockup (numbered apart from site builds)."
    kind: BuildKind!
    "Latin figures, always (house rule 14) — project-wide and monotonic per kind, never reset per phase."
    number: Int!
    deployedAt: DateTime!
    declaredBy: User!
    ref: String
    "Null means declared but not yet told to the customer (L3b.2's fourth rule)."
    publishedAt: DateTime
    changes: [BuildChangeEntry!]!
    createdAt: DateTime!
  }

  "One entry in declareBuild's change list — see BuildChangeEntry for what each field means once written."
  input BuildChangeInput {
    feedbackItemId: ID
    scopeItemId: ID
    outcome: BuildChangeOutcome
    note: String
    noteLang: String
  }

  # ---------------------------------------------------------------------
  # Tickets and the three channels (build plan L4; spec §5, §6). Surfaces
  # the as-built Ticket/TicketMessage models, modelled since the first
  # migration and unreachable from the API until now.
  # ---------------------------------------------------------------------

  """
  Beside the original three (build plan L4), never a customer's own choice
  directly (INVALID_TICKET_TYPE on createTicket) — moved here by staff via
  moveTicketChannel once a support ticket is recognized as one (spec §5).
  Counted by Query.adminRequestCount — the only input to the parked §10.2
  decision on whether site administration becomes a product.
  """
  enum TicketType {
    CHANGE_REQUEST
    BUG
    QUESTION
    ADMIN_REQUEST
  }

  enum TicketUrgency {
    URGENT
    NOT_URGENT
  }

  enum TicketStatus {
    OPEN
    IN_PROGRESS
    RESOLVED
    CLOSED
  }

  type TicketMessage {
    id: ID!
    author: User!
    body: String!
    createdAt: DateTime!
  }

  """
  Build plan L4: customerId and projectId are kept apart on purpose — a
  change ticket derived from a demo belongs to a project, a support ticket
  raised after delivery may not (banked trap: both, nullable where it
  matters, decided here rather than inherited).
  """
  type Ticket {
    id: ID!
    customer: User!
    "Null for a ticket with no engagement behind it — a support ticket after delivery, most often."
    project: Project
    type: TicketType!
    urgency: TicketUrgency!
    status: TicketStatus!
    subject: String!
    """
    Root marks a ticket billable for a major change request — the flag this
    schema has always modelled. The BillingEntry edge it would create stays
    L6's to build (build plan L4's second banked trap); nothing reads this
    flag yet.
    """
    billable: Boolean!
    """
    The charge this billable ticket produced, if any (build plan L6). Null while
    it is still a draft to anyone but billing (journeys build plan J13). **This
    field was queried by the web from L6 on and never declared here**, so every
    ticket query failed validation until J13 found it.
    """
    billingEntry: BillingEntry
    "The feedback item this ticket was converted from, if any (build plan L4) — which is then MOVED."
    sourceFeedbackItem: FeedbackItem
    "The page or frame line this concerns, snapshotted at conversion time — never a live view."
    briefPageFa: String
    briefPageEn: String
    "The reviewer's own words, verbatim, oldest first — the annotation."
    briefAnnotation: String
    "Written by whoever performed the conversion: what the page shows today."
    briefCurrentState: String
    "Written by whoever performed the conversion: what it should show instead. Together with briefCurrentState and the two fields above, this is the brief."
    briefDesiredState: String
    "Which language briefCurrentState/briefDesiredState were authored in. Null exactly when they are."
    briefLang: String
    "Oldest first."
    messages: [TicketMessage!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Article {
    id: ID!
    number: Int!
    titleFa: String!
    titleEn: String!
    "Null for a sensitive article when the viewer may not read the contract's money (PD-14)."
    bodyFa: String
    bodyEn: String
    "Journeys build plan J4, PD-14: this article's prose is about money."
    sensitive: Boolean!
  }

  type Comment {
    id: ID!
    author: User!
    target: CommentTarget!
    body: String!
    createdAt: DateTime!
  }

  type ChangeLogEntry {
    id: ID!
    actor: User!
    action: ChangeAction!
    arg: String
    createdAt: DateTime!
  }

  type Signature {
    id: ID!
    typedName: String!
    signedAt: DateTime!
    signer: User!
  }

  """
  A change made after signature. The signed revision is terminal, so an
  amendment is how the document moves — it carries its own hash and its own
  signature, independent of the revision it amends.
  """
  type Amendment {
    id: ID!
    ordinal: Int!
    titleFa: String!
    titleEn: String!
    "Null for a sensitive amendment when the viewer may not read the contract's money (J7, PD-14) — the hash still covers the whole text."
    bodyFa: String
    bodyEn: String
    "Journeys build plan J7: this amendment's prose is about money."
    sensitive: Boolean!
    contentHash: String!
    "An optional, non-authoritative display hint — never a supersede. See schema.prisma."
    relatesToArticle: Int
    publishedAt: DateTime
    approvedAt: DateTime
    signature: Signature
  }

  """
  The published revision the customer is actually reading.

  Its title and fee are the **frozen** copies out of the snapshot, not the
  fields of the same name on Contract — those are Root's working draft and can
  already differ. Anything that presents itself as the document (the printable
  view, and one day a server-rendered PDF) must read from here, so that what is
  displayed and what contentHash attests to cannot drift apart.
  """
  type ContractRevision {
    id: ID!
    version: Int!
    titleFa: String!
    titleEn: String!
    "Toman, as a decimal string — frozen at publication."
    amount: String

    """
    sha256 of the canonical snapshot, hex. Null means the revision is
    **unsealed** — a v1 created by the backfill migration before the backfill
    script has run. Signing refuses such a revision, and a printed copy says so
    rather than showing a blank.
    """
    contentHash: String

    publishedAt: DateTime
    approvedAt: DateTime
    signature: Signature
    "Published amendments, in order. Root's unpublished drafts are admin-only."
    amendments: [Amendment!]!
    "The snapshot's format: 1 for the legacy road and everything before J7, 2 for the new road's agreement."
    format: Int!
    "Journeys build plan J7: steps 1 and 2 as frozen into a format-2 snapshot — what the customer approves and signs. Null for format 1."
    agreement: AgreementSnapshot
  }

  """
  A format-2 snapshot's steps 1 and 2 (journeys build plan J7) — the brief,
  the allowances, the payment plan, the phases and the planned dates as they
  stood when the draft was published. **Money varies by viewer, and only for
  other staff**: budgetCap and paymentPlan are null for staff without money.read
  who are not the customer (the customer signs all of it).
  """
  type AgreementSnapshot {
    brief: SnapshotBrief
    allowances: SnapshotAllowances
    paymentPlan: SnapshotPaymentPlan
    phases: [SnapshotPhase!]!
    "Calendar days (PD-19) — render in UTC."
    plannedStartAt: DateTime
    plannedEndAt: DateTime
  }

  "The template type as it was named when the draft was published — a signed agreement keeps saying what it said."
  type SnapshotTemplateType {
    slug: String!
    labelFa: String!
    labelEn: String!
  }

  type SnapshotBrief {
    kind: BriefKind!
    existingSiteUrl: String
    templateType: SnapshotTemplateType!
    designTier: DesignTier!
    "Toman, decimal string. Null for staff without money.read who are not the customer."
    budgetCap: String
    idealDeadline: DateTime
    hardDeadline: DateTime
    domainName: String
    domainProvidedBy: DependencySide
    hostProvidedBy: DependencySide
    contentProvidedBy: DependencySide
    supportMonths: Int
  }

  type SnapshotAllowances {
    premadeRounds: Int
    wireframeIterations: Int!
    mockupIterations: Int
    demoIterationsPerPhase: Int
  }

  "The plan as approved — rows and terms, never whether an invoice has been issued or paid."
  type SnapshotPaymentPlan {
    split: PaymentSplit!
    "Toman, decimal string — the sum of the rows."
    total: String!
    invoices: [SnapshotInvoice!]!
  }

  type SnapshotInvoice {
    ordinal: Int!
    labelFa: String!
    labelEn: String!
    "Toman, decimal string."
    amount: String!
    phaseNumber: Int
    paymentTermDays: Int!
  }

  type SnapshotPhase {
    number: Int!
    titleFa: String!
    titleEn: String!
    plannedEndAt: DateTime
    milestoneLabel: String
  }

  """
  The gate is derived on the server, never trusted from the client:
  design approved & complete -> unlock approve contract -> unlock e-sign.
  """
  type Gate {
    designComplete: Boolean!
    contractApproved: Boolean!
    signed: Boolean!
    approvedPageCount: Int!
    totalPageCount: Int!
  }

  """
  Root's working copy: the mutable Article rows plus the title and fee on
  Contract. Nothing here has been handed to the customer — publishing is what
  does that.

  Staff only. Null for everyone else, rather than an error: the customer's own
  client never asks for it, and a refusal would confirm the field means something.
  """
  type ContractDraft {
    titleFa: String!
    titleEn: String!
    "Toman, as a decimal string."
    amount: String
    articles: [Article!]!
    "The hash this draft would publish as, from the same canonical form the publish path uses."
    contentHash: String!
    """
    Whether publishing would change anything. This is exactly the condition
    publishContractRevision enforces, so a disabled button and a NO_CHANGES
    refusal cannot disagree.
    """
    dirty: Boolean!
  }

  """
  Shared by a design page's change and a contract article's change (V3.md
  §3.2) — one enum, one set of members, rather than a second copy with the
  same four values under a different name.
  """
  enum ChangeKind {
    ADDED
    CHANGED
    REMOVED
    UNCHANGED
  }

  type PageChange {
    conceptKey: String!
    pageKey: String!
    kind: ChangeKind!
  }

  """
  What publishing this draft would do, computed with the same carryForward
  the publish path runs. Two implementations of this would drift, and the
  visible one would be the one that looks right while the gate did something
  else — so this is the pure function in lib/design.ts, not a second guess.
  """
  type CarryForwardPreview {
    "The concept whose choice survives, or null if the customer must choose again."
    chosenConceptKey: String
    carriedPageCount: Int!
    resetPageCount: Int!
    changes: [PageChange!]!
  }

  """
  The unpublished design revision, if one exists. Staff only.

  **Reading this never creates one.** The draft comes into being on the first
  edit, not on the first look — see draftDesignRevision.
  """
  type DesignDraft {
    id: ID!
    version: Int!
    concepts: [DesignConcept!]!
    palette: [DesignPaletteItem!]!
    carryForward: CarryForwardPreview!
  }

  "One entry in the contract lineage. A list of what happened, not a document."
  type ContractRevisionSummary {
    id: ID!
    version: Int!
    contentHash: String
    publishedAt: DateTime
    approvedAt: DateTime
    supersededAt: DateTime
    signedAt: DateTime
    amendmentCount: Int!
  }

  type DesignRevisionSummary {
    id: ID!
    version: Int!
    publishedAt: DateTime
    supersededAt: DateTime
    conceptCount: Int!
    pageCount: Int!
  }

  type ArticleChange {
    number: Int!
    titleFa: String!
    titleEn: String!
    kind: ChangeKind!
  }

  """
  What moved in the text since the revision the customer last approved.
  Present only while the current revision is itself unapproved — see
  PendingReview.
  """
  type ContractDiff {
    "The version the customer last approved."
    fromVersion: Int!
    toVersion: Int!
    titleChanged: Boolean!
    amountChanged: Boolean!
    articles: [ArticleChange!]!
  }

  """
  What has moved since the customer last acted, and null when nothing has.
  Derived on every read, exactly like the gate — the client never decides
  this, and a stale copy of it would be a banner asking for something
  already done.
  """
  type PendingReview {
    "The text was revised and wants approving again. Null when it was not."
    contractDiff: ContractDiff
    "Pages of the current design revision that are unapproved, with what Root did to each."
    designChanges: [PageChange!]!
    "A published amendment awaiting approval or signature."
    amendment: Amendment
  }

  type Contract {
    id: ID!
    ref: String!
    titleFa: String!
    titleEn: String!
    status: ContractStatus!
    amount: String
    customer: User!
    "Journeys build plan S1 — the assignment edges. Null when unassigned."
    designer: User
    developer: User
    publishedAt: DateTime
    updatedAt: DateTime!
    gate: Gate!
    concepts: [DesignConcept!]!
    "J8: the current published round's palette (a custom design's). Empty otherwise."
    palette: [DesignPaletteItem!]!
    """
    J8: what the new road's design step still lacks, as codes — CONCEPT_NOT_CHOSEN
    (pre-made); NO_PAGES, PAGE_NOT_APPROVED, PALETTE_EMPTY (custom); NO_ROUND,
    BRIEF_MISSING. approveDesign refuses (DESIGN_INCOMPLETE) on exactly this list.
    Empty for a legacy contract, whose design is complete when "gate" says so.
    """
    designMissing: [String!]!
    """
    J9b: this contract's mockup (step 5) — null on the pre-made path and before the
    designer starts it; a customer gets it once its first iteration is published.
    """
    mockup: Demo
    "J8: rounds granted beyond the brief. Staff readers only; empty for anyone else."
    allowanceExtensions: [AllowanceExtension!]!
    "Live — this project's whole registry, not only what is agreed. See agreedScopeItems for the frozen view."
    scopeItems: [ScopeItem!]!
    "Every contract has a project (required since J2)."
    project: Project!
    "J2: the request this contract's project began as, with its thread (read-only from here). Null for a project that never was a request, and for anyone but the customer and contracts.readAll."
    request: Request
    articles: [Article!]!
    """
    Appendix 1 as it was frozen into the current published revision — the
    registry's agreed set at that moment, not the live registry (build plan
    L1). Empty for a revision published before L1, since the snapshot gained
    this field only going forward — see schema.prisma's ContractSnapshot note.
    """
    agreedScopeItems: [ScopeSnapshotItem!]!
    comments: [Comment!]!
    changeLog: [ChangeLogEntry!]!
    signature: Signature
    "The published revision that articles came from. Null before the first publish."
    revision: ContractRevision
    "Staff only; null otherwise."
    draft: ContractDraft
    "Staff only; null otherwise."
    designDraft: DesignDraft
    "Both lineages, newest first. Non-staff see published revisions only."
    contractRevisions: [ContractRevisionSummary!]!
    designRevisions: [DesignRevisionSummary!]!
    "What has moved since the customer last acted. Null when there is nothing to show."
    pending: PendingReview

    "Journeys build plan J3, PD-7: which road this contract travels."
    sequence: ContractSequence!
    "The wizard, derived (lib/steps.ts) — in road order, one entry per step (per phase for demos)."
    wizard: [WizardStep!]!
    "The status area's fields, derived. Never reads ContractStatus."
    statusSummary: StatusSummary!
    "What is waiting on whom, as this viewer may see it — longest-waiting first."
    attention: [AttentionItem!]!
    "The history rail for new-road contracts (PD-17), newest first, derived from dated rows. Legacy contracts read changeLog."
    timeline: [TimelineItem!]!
    "Staff readers only; an empty list — never an error — for a customer, and under asCustomer."
    internalNotes: [InternalNote!]!
    """
    Journeys build plan S2: this contract's feedback, one model for every step
    (newest first), as this viewer may see it — a customer never sees a pending
    answer, and staff without money.read never see feedback about money
    (PD-21). Narrow by step (and, for the demo, phase).
    """
    feedbackItems(step: StepKind, phaseId: ID): [FeedbackItem!]!

    """
    Journeys build plan J4 — step 1. The brief (null until sales has written
    one); its budget cap is null to staff without money.read.
    """
    brief: ContractBrief
    "What step 1 still lacks, as codes; empty means the step is done. Never carries a value."
    briefCompleteness: [BriefMissing!]!
    "Null for staff without money.read who are not the customer (PD-14), and until a plan exists."
    paymentPlan: PaymentPlan
    "This contract's own phases (PD-5). Project.phases is every phase of the project."
    phases: [Phase!]!

    "Journeys build plan J5 — step 2a. Oldest first; the customer's words and Root's decisions."
    scopeProposals: [ScopeProposal!]!
    """
    Journeys build plan J6 — step 2b. The DRAFT notes anchored to an article of a
    revision, each with where its article is now. Filtered like feedbackItems
    (PD-21: a note on a sensitive article is hidden from staff without
    money.read). The draft-wide note stays on feedbackItems(step: DRAFT).
    """
    draftNotes: [DraftNote!]!
    """
    The planned start and end (Q12), calendar days: proposed in the draft, so a
    customer reads them from the moment a revision is published (or the
    agreement approved); null before, and when unset.
    """
    plannedStartAt: DateTime
    plannedEndAt: DateTime
  }

  enum BriefKind {
    NEW_SITE
    FEATURE_FOR_EXISTING
  }

  "PD-13: THEME_PICK is the pre-made path, the other two the custom one."
  enum DesignTier {
    THEME_PICK
    CLAUDE_ASSISTED
    SENIOR_DESIGNER
  }

  "Descriptive, not generative: the rows are the plan."
  enum PaymentSplit {
    LUMP_SUM
    INSTALLMENTS
    MONTHLY
  }

  """
  Step 1 as sales wrote it and the customer reads it. Dates are calendar days
  (PD-19): render them in UTC. budgetCap is money (PD-14) and is not
  Contract.amount — nothing prefills one from the other.
  """
  type ContractBrief {
    id: ID!
    kind: BriefKind!
    existingSiteUrl: String
    templateType: TemplateType!
    designTier: DesignTier!
    "Toman, as a decimal string. Null for staff without money.read who are not the customer."
    budgetCap: String
    idealDeadline: DateTime
    hardDeadline: DateTime
    domainName: String
    domainProvidedBy: DependencySide
    hostProvidedBy: DependencySide
    contentProvidedBy: DependencySide
    supportMonths: Int
    premadeRounds: Int
    wireframeIterations: Int!
    mockupIterations: Int
    demoIterationsPerPhase: Int
    updatedAt: DateTime!
  }

  "One thing step 1 still lacks. key names which commitment (or phase id) where the code is about one."
  type BriefMissing {
    code: String!
    key: String
  }

  type PaymentPlan {
    id: ID!
    split: PaymentSplit!
    "Toman, as a decimal string — the sum of the rows."
    total: String!
    invoices: [PlannedInvoice!]!
  }

  type PlannedInvoice {
    id: ID!
    ordinal: Int!
    labelFa: String!
    labelEn: String!
    "Toman, as a decimal string."
    amount: String!
    phaseId: ID
    paymentTermDays: Int!
    """
    Journeys build plan J13. Where this row stands: issued (and how it is
    doing), or issuable now, or waiting on something (blockedBy).
    """
    state: PlannedInvoiceState!
    "What an unissued row is waiting on; null once it can be issued or has been."
    blockedBy: IssueBlock
    "The invoice issued from this row. Null until then."
    invoice: BillingEntry
  }

  enum PlannedInvoiceState {
    NOT_YET_ISSUABLE
    ISSUABLE
    ISSUED
    PAID
    OVERDUE
  }

  "What keeps a planned invoice from being issued (lib/invoice.ts's canIssuePlanned)."
  enum IssueBlock {
    NOT_SIGNED
    PREVIOUS_UNPAID
    PHASE_NOT_ACCEPTED
  }

  input CommitmentInput {
    "domain, host, content, gateway, smsLine or enamad. Anything else is ignored."
    key: String!
    "Used for gateway, smsLine and enamad; the brief's own provider decides domain, host and content."
    side: DependencySide
    "YYYY-MM-DD. A commitment without a date is not created (COMMITMENT_UNDATED)."
    dueAt: String
  }

  """
  A replace, not a patch: an omitted optional field is cleared, and
  wireframeIterations returns to its default of two. Dates are YYYY-MM-DD.
  """
  input BriefInput {
    kind: BriefKind!
    existingSiteUrl: String
    templateTypeId: ID!
    designTier: DesignTier!
    "Toman, a whole number above zero, as a decimal string."
    budgetCap: String
    idealDeadline: String
    hardDeadline: String
    domainName: String
    domainProvidedBy: DependencySide
    hostProvidedBy: DependencySide
    contentProvidedBy: DependencySide
    supportMonths: Int
    premadeRounds: Int
    wireframeIterations: Int
    mockupIterations: Int
    demoIterationsPerPhase: Int
    commitments: [CommitmentInput!]
  }

  input PlannedInvoiceInput {
    labelFa: String!
    labelEn: String!
    "Toman, a whole number above zero, as a decimal string."
    amount: String!
    "Must be one of this contract's phases."
    phaseId: ID
    paymentTermDays: Int!
  }

  "Journeys build plan J3, PD-7."
  enum ContractSequence {
    DESIGN_FIRST
    AGREEMENT_FIRST
  }

  "The wizard's steps. lib/steps.ts is the one file that knows which a contract has."
  enum StepKind {
    REQUIREMENTS
    SCOPE
    DRAFT
    AGREEMENT
    DESIGN
    MOCKUP
    DEMO
    SUMMARY
  }

  enum StepStatus {
    DONE
    CURRENT
    UPCOMING
  }

  enum WaitingOn {
    CUSTOMER
    ROOT
  }

  "The staff job an attention item routes to. Not a Role: house rule 1."
  enum AttentionRole {
    SALES
    DESIGNER
    DEVELOPER
  }

  """
  Journeys build plan §6.3, whole — every kind is in the enum already so a
  later stage never edits the SDL to add one. lib/attention.ts says which are
  emitted; the sentences live in the locale files.
  """
  enum AttentionKind {
    STEP_WAITING
    DRAFT_TO_REVIEW
    ANSWER_PUBLISHED
    ANSWER_PENDING_APPROVAL
    PROPOSAL_DECIDED
    PROPOSAL_TO_DECIDE
    FEEDBACK_UNRESOLVED
    ROUND_PUBLISHED
    ITERATION_PUBLISHED
    DEMO_READY_TO_APPROVE
    COMMITMENT_OVERDUE
    INVOICE_DUE
    INVOICE_OVERDUE
    INVOICE_ISSUABLE
    REQUEST_MESSAGE
    TICKET_REPLY
    TRADE_TO_CONFIRM
    ALLOWANCE_EXHAUSTED
    DEMO_NOT_READY
    ASSIGNEE_INACTIVE
  }

  enum TimelineKind {
    REQUEST_SUBMITTED
    CONTRACT_HANDED_OVER
    STEP_APPROVED
    REVISION_PUBLISHED
    REVISION_APPROVED
    CONTRACT_SIGNED
    DESIGN_PUBLISHED
    BUILD_PUBLISHED
    MOCKUP_PUBLISHED
  }

  "One step of the road. A demo is one entry per phase; a new-road contract with no phase yet has one with phaseId null."
  type WizardStep {
    step: StepKind!
    phaseId: ID
    phaseNumber: Int
    status: StepStatus!
    "Locked by the approval that seals it — its own, or AGREEMENT's for REQUIREMENTS, SCOPE and DRAFT. Never true on a DESIGN_FIRST contract."
    locked: Boolean!
    lockedAt: DateTime
    "False only for SUMMARY."
    takesInput: Boolean!
    "J8–J10 fill these; null until a step has an allowance to count against."
    iterationsUsed: Int
    allowance: Int
    finishedAt: DateTime
  }

  "A name and a value for a sentence to interpolate. Numbers are decimal strings; the client localizes them."
  type AttentionParam {
    key: String!
    value: String!
  }

  type AttentionItem {
    kind: AttentionKind!
    "Which sentence of the kind: attention.<kind>.<variant>.<customer|staff> in the locale files."
    variant: String!
    contractId: ID!
    phaseId: ID
    waitingOn: WaitingOn!
    role: AttentionRole
    since: DateTime!
    params: [AttentionParam!]!
  }

  "The status area. Derived on every read; never from ContractStatus."
  type StatusSummary {
    "Signed. J13 adds 'and the first invoice is paid'."
    started: Boolean!
    startedAt: DateTime
    "Journeys build plan J7: when the customer approved the agreement (steps 1 to 3 locked from then). Null before, and on the legacy road."
    agreementApprovedAt: DateTime
    "When the current revision was signed, on both roads. Approval is not signing."
    signedAt: DateTime
    currentStep: StepKind
    currentPhaseId: ID
    currentPhaseNumber: Int
    "Null once every step is done."
    nextMoveOn: WaitingOn
    waitingOnRoot: Int!
    waitingOnCustomer: Int!
    "Calendar days (PD-19) — render in UTC. A customer sees them once the agreement is approved."
    plannedStartAt: DateTime
    plannedEndAt: DateTime
    overdueCount: Int!
    lastProgressAt: DateTime
    "Whole days since Root last showed progress; null if it never has."
    daysSinceProgress: Int
  }

  type TimelineItem {
    id: ID!
    at: DateTime!
    kind: TimelineKind!
    "Which side acted; the customer sees 'Root' for any staff member."
    by: WaitingOn!
    step: StepKind
    phaseNumber: Int
    "A revision version or a build number, where the sentence names one."
    number: Int
  }

  type NoteAuthor {
    id: ID!
    name: String!
  }

  "Root's private note on a contract. Staff only; append-only."
  type InternalNote {
    id: ID!
    body: String!
    createdAt: DateTime!
    author: NoteAuthor!
  }

  "Journeys build plan S1 — the two jobs a contract assigns: its designer and its developer."
  enum AssignmentJob {
    DESIGN
    BUILD
  }

  type StatusCount {
    status: ContractStatus!
    count: Int!
  }

  "A contract, thin. Enough to name and link to one, and nothing more — see fields.ts's note on why (V4 T1)."
  type ContractRef {
    id: ID!
    ref: String!
    titleFa: String!
    titleEn: String!
    status: ContractStatus!
    customerName: String!
    statusChangedAt: DateTime!
  }

  "One entry in the desk's activity feed. Reads across every contract, so the contract field stays thin (T1)."
  type ActivityItem {
    id: ID!
    contract: ContractRef!
    actor: User!
    action: ChangeAction!
    arg: String
    createdAt: DateTime!
  }

  # ---------------------------------------------------------------------
  # Billing — subscriptions, invoices, the report (build plan L6; spec §8).
  # BillingEntry existed and was unsurfaced; SUBSCRIPTION joins the original
  # three sources, and this stage builds the edge from a billable ticket
  # (build plan L4's second banked trap) and the milestone linkage (a phase's
  # own milestoneLabel, never a separate Milestone model — see
  # schema.prisma's own comment on BillingEntry.phaseId).
  # ---------------------------------------------------------------------

  enum BillingSource {
    CONTRACT
    SERVICE
    TICKET
    SUBSCRIPTION
  }

  enum SubscriptionPeriod {
    MONTHLY
    QUARTERLY
    YEARLY
  }

  """
  Recurring charges the customer signs up to (build plan L6; spec §8) — SMS
  API expense is the live case. Generates BillingEntry rows lazily, on read
  (lib/billing.ts) — there is no scheduler in this app, and lazy-on-read is
  the one option that cannot silently stop running, which is the failure
  mode that matters when the subject is money.
  """
  type Subscription {
    id: ID!
    customer: User!
    "Optional — an ongoing customer relationship may have no single project."
    project: Project
    labelFa: String!
    labelEn: String!
    "Toman, per period. A string — BigInt does not survive JSON."
    amount: String!
    period: SubscriptionPeriod!
    activeFrom: DateTime!
    "Null means ongoing."
    activeUntil: DateTime
    createdAt: DateTime!
  }

  """
  Record-keeping only — no payment gateway (schema.prisma's own comment on
  the model this surfaces). Created and marked paid by Root; a customer never
  writes one.
  """
  type BillingEntry {
    id: ID!
    customer: User!
    contract: Contract
    "The milestone whose acceptance releases this payment (spec §8), if any."
    phase: Phase
    "Set only for a SUBSCRIPTION-sourced entry — which period this bills for."
    subscription: Subscription
    periodStart: DateTime
    periodEnd: DateTime
    "The billable ticket this entry was created for (build plan L4/L6), if any."
    ticket: Ticket
    source: BillingSource!
    descriptionFa: String!
    descriptionEn: String!
    "Toman. A string — BigInt does not survive JSON."
    amount: String!
    """
    Null means a **draft** (journeys build plan J13): invisible to the customer
    everywhere, with no number and no due day.
    """
    issuedAt: DateTime
    "Null means outstanding."
    paidAt: DateTime
    "INV-000123 — Latin digits in every language. Null on a draft."
    invoiceNumber: String
    "A calendar day (PD-19): render it in UTC. Null on a draft."
    dueAt: DateTime
    "The term this invoice was issued with, or the draft's own; null on a draft without one."
    paymentTermDays: Int
    "The planned-invoice row this issued, if it came from a payment plan — what it waited on."
    plannedInvoice: PlannedInvoice
    "Issued, not paid, and past its due day. Derived on every read."
    overdue: Boolean!
  }

  "One row of the report's per-source breakdown."
  type BillingSourceTotal {
    source: BillingSource!
    totalIssued: String!
    totalPaid: String!
    totalOutstanding: String!
  }

  "The spend view (spec §8): totals over time, split by source, outstanding balance."
  type BillingReport {
    totalIssued: String!
    totalPaid: String!
    totalOutstanding: String!
    bySource: [BillingSourceTotal!]!
  }

  # ---------------------------------------------------------------------
  # Services — the product-import panel (build plan L7; spec §9). The first
  # of a class: "a service = a panel + a run history + a billing edge."
  # Upload -> validate -> preview diff -> explicit apply -> run history.
  # ---------------------------------------------------------------------

  enum ServiceRunStatus {
    UPLOADED
    "The gate — applyServiceRun refuses (NOT_PREVIEWED) from any other status."
    PREVIEWED
    "Committed — this run's rows become the store the next run diffs against."
    APPLIED
    "The file could not be read or validated at all — never partially previewed."
    FAILED
  }

  enum ServiceRowAction {
    CREATE
    UPDATE
    "Present in the upload and identical to what is already on record — counted, not dropped."
    UNCHANGED
    REJECTED
  }

  "One parsed row, kept whether or not the run is ever applied (spec §9: rejected rows carry their reason)."
  type ServiceRunRow {
    id: ID!
    rowNumber: Int!
    "Stored exactly as uploaded — never through R1's fold (lib/serviceImport.ts)."
    sku: String!
    nameFa: String!
    nameEn: String
    "Toman. A string — BigInt does not survive JSON. Null on a REJECTED row with no parseable price."
    price: String
    stock: Int
    action: ServiceRowAction!
    "Required exactly when action is REJECTED — see schema.prisma's CHECK."
    rejectReason: String
  }

  "Derived from a run's own rows, never stored (the same F5 discipline every other computed summary in this codebase holds to)."
  type ServiceRunSummary {
    createCount: Int!
    updateCount: Int!
    unchangedCount: Int!
    rejectedCount: Int!
  }

  """
  One upload's audit trail (spec §9: "each run is auditable... and
  chargeable"). A run exists the moment a file is attached, whether or not
  it is ever previewed or applied.
  """
  type ServiceRun {
    id: ID!
    project: Project!
    fileUrl: String!
    fileName: String!
    fileBytes: Int!
    uploadedBy: User!
    createdAt: DateTime!
    status: ServiceRunStatus!
    "Required exactly when status is FAILED."
    failureReason: String
    previewedAt: DateTime
    appliedAt: DateTime
    appliedBy: User
    "Oldest first, by position in the sheet."
    rows: [ServiceRunRow!]!
    summary: ServiceRunSummary!
    "Build plan L6's edge: the charge this run produced, if any."
    billingEntry: BillingEntry
  }

  # ---------------------------------------------------------------------
  # Library (R1) — bilingual as *data*. titleOriginal/titleTranslated and
  # the abstracts are rows, never locale-file keys (R1.md §0.1) — the
  # desk.library.* namespace in en.json/fa.json is the editor's chrome only.
  # ---------------------------------------------------------------------

  enum EntryType {
    PAPER
    BOOK
    ARTICLE
    ROOT_RESEARCH
  }

  enum TranslationProvenance {
    PUBLISHED
    ROOT
    NONE_YET
  }

  enum RightsBasis {
    PUBLIC_DOMAIN
    OPEN_LICENCE
    PERMISSION_GRANTED
    LINK_ONLY
  }

  enum EntryVisibility {
    PUBLIC
    PRIVATE
  }

  "Flat in R1 (§2.3) — R3 turns this into a tree."
  type LibraryConcept {
    id: ID!
    slug: String!
    titleFa: String!
    titleEn: String!
  }

  "Staff, in full, for the editor."
  type LibraryEntry {
    id: ID!
    slug: String!
    type: EntryType!

    originalLang: String!
    titleOriginal: String!
    authors: String!
    venue: String
    year: Int
    doi: String
    sourceUrl: String
    abstractOriginal: String

    translationProvenance: TranslationProvenance!
    titleTranslated: String
    abstractTranslated: String
    translationCredit: String

    rightsBasis: RightsBasis!
    rightsNote: String

    "Null whenever no file is hosted. The hosted-text CHECK in the migration is what actually enforces that LINK_ONLY and PRIVATE entries never have one — this is just what that state looks like from here."
    fullTextUrl: String

    visibility: EntryVisibility!
    "Null means draft."
    publishedAt: DateTime

    concepts: [LibraryConcept!]!

    createdBy: User!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "A Library entry, thin — the list screen's shape. Never the abstract, never unbounded (§4.4, T1)."
  type LibraryEntryRow {
    id: ID!
    slug: String!
    type: EntryType!
    originalLang: String!
    titleOriginal: String!
    titleTranslated: String
    year: Int
    translationProvenance: TranslationProvenance!
    rightsBasis: RightsBasis!
    publishedAt: DateTime
    conceptCount: Int!
  }

  type LibraryEntryPage {
    rows: [LibraryEntryRow!]!
    total: Int!
  }

  input LibraryEntryInput {
    type: EntryType!
    originalLang: String!
    titleOriginal: String!
    authors: String!
    venue: String
    year: Int
    doi: String
    sourceUrl: String
    abstractOriginal: String
    translationProvenance: TranslationProvenance!
    titleTranslated: String
    abstractTranslated: String
    translationCredit: String
    rightsBasis: RightsBasis!
    rightsNote: String
    visibility: EntryVisibility!
    "Overrides the title-derived slug. On update, refused once publishedAt is set (T4). Omit to leave an existing slug untouched."
    slug: String
  }

  input LibraryConceptInput {
    titleFa: String!
    titleEn: String!
    slug: String
  }

  # ---------------------------------------------------------------------
  # Library (R2) — the public reader. Separate types and separate resolvers
  # from the staff ones above, on purpose (R2.md §2.1): a boolean that
  # toggled the staff query's filter and shape would be two functions
  # wearing one name, and the failure mode is a draft leaking because
  # someone widened the shared selection. No id is exposed for a concept
  # here — the public taxonomy is addressed by slug, same as an entry.
  # ---------------------------------------------------------------------

  "Public. Only concepts with at least one publicly visible entry reach here."
  type PublicConcept {
    slug: String!
    titleFa: String!
    titleEn: String!
  }

  "Public, in full — see the withhold list in R2.md §2.3. No searchText, no visibility, no fullTextFileId, no createdBy."
  type PublicEntry {
    id: ID!
    slug: String!
    type: EntryType!

    originalLang: String!
    titleOriginal: String!
    authors: String!
    venue: String
    year: Int
    doi: String
    sourceUrl: String
    abstractOriginal: String

    translationProvenance: TranslationProvenance!
    titleTranslated: String
    abstractTranslated: String
    translationCredit: String

    rightsBasis: RightsBasis!
    rightsNote: String

    "Null when nothing is hosted — absent, not necessarily forbidden; rightsBasis is how a reader tells the two apart."
    fullTextUrl: String
    "Always set — every row this type describes is published (T2)."
    publishedAt: DateTime!

    concepts: [PublicConcept!]!
  }

  "Public list row — thin, same reasoning as LibraryEntryRow (T1)."
  type PublicEntryRow {
    id: ID!
    slug: String!
    type: EntryType!
    originalLang: String!
    titleOriginal: String!
    titleTranslated: String
    year: Int
    translationProvenance: TranslationProvenance!
    rightsBasis: RightsBasis!
    fullTextUrl: String
    publishedAt: DateTime!
    conceptCount: Int!
  }

  type PublicEntryPage {
    rows: [PublicEntryRow!]!
    total: Int!
  }

  # ---------------------------------------------------------------------
  # Review Room (C1) — a round is a frozen root-sot commit sha plus its
  # allowlisted documents at that sha, split into blocks at publish time.
  # No ReviewGrant type — one corpus, for anyone holding review.participate
  # (C1.md §1). review.admin is the only capability that may publish.
  # ---------------------------------------------------------------------

  enum BlockKind {
    HEADING
    PARAGRAPH
    CODE
    LIST
    QUOTE
    TABLE
  }

  type ReviewBlock {
    id: ID!
    kind: BlockKind!
    depth: Int
    text: String!
  }

  "Thin — the round list's document shape. No blocks (T1's discipline, applied here too)."
  type ReviewDocumentRef {
    id: ID!
    path: String!
    title: String!
    order: Int!
  }

  type ReviewRound {
    id: ID!
    sha: String!
    label: String
    publishedAt: DateTime!
    publishedBy: User!
    "In manifest order."
    documents: [ReviewDocumentRef!]!
  }

  "The round a document belongs to, thin — enough to show provenance beside the text."
  type ReviewRoundRef {
    id: ID!
    sha: String!
    label: String
    publishedAt: DateTime!
  }

  "One document, in full, rendered from its frozen blocks."
  type ReviewDocument {
    id: ID!
    path: String!
    title: String!
    order: Int!
    contentHash: String!
    blocks: [ReviewBlock!]!
    round: ReviewRoundRef!
    "Visible to Root always; to a reviewer, only the threads they opened (C2.md §3). No existence leak of anyone else's."
    threads: [ReviewThread!]!
  }

  input ReviewBlockInput {
    id: String!
    kind: BlockKind!
    depth: Int
    text: String!
  }

  input ReviewDocumentInput {
    path: String!
    title: String!
    order: Int!
    blocks: [ReviewBlockInput!]!
  }

  # ---------------------------------------------------------------------
  # Review Room — comments (C2). A thread anchors to (blockId, startOffset,
  # endOffset) into a block's *rendered* plain text, with quote as that
  # anchor's own witness (C2.md §1). Never a global document offset — see §1.2.
  # ---------------------------------------------------------------------

  type ReviewComment {
    id: ID!
    authorId: ID!
    author: User!
    body: String!
    createdAt: DateTime!
  }

  type ReviewThread {
    id: ID!
    documentId: ID!
    authorId: ID!
    author: User!
    blockId: ID!
    startOffset: Int!
    endOffset: Int!
    "The text the reviewer actually selected. Re-checked against the live render on read; a mismatch is shown detached, never re-found (C2.md §1.1)."
    quote: String!
    resolvedAt: DateTime
    resolvedById: ID
    resolvedBy: User
    createdAt: DateTime!
    "Oldest first — the opening comment, then the reply thread."
    comments: [ReviewComment!]!
  }

  """
  Journeys build plan J1: null user + a set factorChallengeId is what
  "signed in, but the staff second factor must clear first" looks like —
  signIn returns this instead of a session; pass factorChallengeId and the
  code the factor SMS carried to verifySignInFactor to actually get one.
  Every other auth mutation always sets user and never factorChallengeId.
  """
  type AuthPayload {
    user: User
    factorChallengeId: String
  }

  """
  Returned when an admin issues an invite. The raw link exists exactly once —
  here — and is never readable again.
  """
  type InviteResult {
    userId: ID!
    "Null for a phone-only invitee — the desk's own invite link is what gets handed over in that case."
    email: String
    inviteUrl: String!
    expiresAt: DateTime!
  }

  "What an API token may do. Never what its owner may do — that is read from the owner on every request."
  enum ApiTokenScope {
    "Queries only."
    READ
    "Queries and mutations."
    WRITE
  }

  """
  A personal access token for calling this API without a browser. The secret
  itself is not a field here and never will be: it is stored only as a digest,
  so the server could not return it even if asked.
  """
  type ApiToken {
    id: ID!
    name: String!
    "The leading characters, so a listed token can be told from the others."
    prefix: String!
    scope: ApiTokenScope!
    "Null until the token is used for the first time."
    lastUsedAt: DateTime
    "Null for a token that does not expire."
    expiresAt: DateTime
    "Set once revoked. A revoked token is kept, not deleted — the row is the record that it existed."
    revokedAt: DateTime
    createdAt: DateTime!
  }

  """
  The one and only time the secret is readable. Nothing stores it; if it is
  lost, the token is replaced rather than recovered.
  """
  type CreatedApiToken {
    apiToken: ApiToken!
    "The full token. Shown once, here, and never retrievable again."
    token: String!
  }

  # ---------------------------------------------------------------------
  # Template types and scope templates (journeys build plan T1)
  # ---------------------------------------------------------------------

  "A kind of site a designer manages as data, with the scope list its contracts start from."
  type TemplateType {
    id: ID!
    "Latin, lowercase, hyphenated."
    slug: String!
    labelFa: String!
    labelEn: String!
    position: Int!
    "Inactive types are hidden from pickers and kept for what already chose them. There is no delete."
    active: Boolean!
    items: [TemplateScopeItem!]!
  }

  type TemplateScopeItem {
    id: ID!
    key: String!
    "PAGE, FEATURE or DELIVERABLE — never EXTRA."
    kind: ScopeKind!
    labelFa: String!
    labelEn: String!
    position: Int!
  }

  "One line of a type's scope list, as setTemplateScope replaces it. Position is the order given."
  input TemplateScopeItemInput {
    key: String!
    kind: ScopeKind!
    labelFa: String!
    labelEn: String!
  }

  # ---------------------------------------------------------------------
  # The theme catalogue (journeys build plan T2)
  # ---------------------------------------------------------------------

  "How well a theme handles right-to-left layout. UNKNOWN is a real answer: not tried yet."
  enum RtlSupport {
    FULL
    PARTIAL
    NONE
    UNKNOWN
  }

  """
  A ready-made site theme a designer can offer on a pre-made contract. Staff
  only: nothing customer-facing returns one. There is no delete — active:
  false — because a design round will snapshot the theme it showed.
  """
  type Theme {
    id: ID!
    name: String!
    vendor: String
    """
    The vendor's live demo. https only, and never framed anywhere: render it as
    a link that opens in a new tab (third-party demos refuse framing and the
    portal's CSP does not allow them).
    """
    demoUrl: String
    "The preview image, /files/<id> — private, staff only. Null until one is uploaded."
    previewUrl: String
    rtlSupport: RtlSupport!
    """
    What the licence costs Root, in Toman, as a decimal string. Root's cost, not
    a customer's money, so money.read does not apply; whoever can read the
    catalogue can read it.
    """
    licenseCost: String
    notesFa: String
    notesEn: String
    active: Boolean!
    "The template types this theme is offered for."
    typeIds: [ID!]!
    createdAt: DateTime!
  }

  type Query {
    me: User
    myContracts(status: ContractStatus): [Contract!]!
    contractStatusCounts: [StatusCount!]!
    """
    A contract the caller may see. asCustomer (journeys build plan J3, "view as
    customer"): for any staff reader who may see the contract, the same query
    answered as the contract's own customer would receive it — every field
    resolver then reads through the customer's eyes (viewerOf), so it is the
    portal's rules, not a copy of them. NOT_FOUND for a contract the caller
    may not see at all; NOT_VISIBLE_TO_CUSTOMER for one they may but the
    customer may not (not handed over yet) — a code of its own, because the
    caller already knows the contract exists. A customer passing it gets
    their own view, unchanged.
    """
    contract(id: ID!, asCustomer: Boolean = false): Contract

    "Admin only."
    allContracts: [Contract!]!
    allCustomers: [User!]!
    "The tools the caller holds an active grant for — what the portal's rail offers (journeys build plan S3)."
    myTools: [ToolKey!]!
    "Staff (customers.manage). Null for an id that is not a customer, exactly as for one that does not exist."
    customer(id: ID!): CustomerProfile
    "Staff (staff.manage — ADMIN only). Every account, customers included, newest first. The Users place's list (PD-12)."
    allUsers: [User!]!

    "Staff. Counts across every contract — not the caller's own, unlike contractStatusCounts."
    allContractStatusCounts: [StatusCount!]!
    """
    Staff holding templates.types, templates.scope or contracts.author (J4's
    brief will pick a type). In position order, items in position order.
    activeOnly: true is the picker's view; the desk's Types tab wants both.
    """
    templateTypes(activeOnly: Boolean = false): [TemplateType!]!
    """
    Staff holding templates.types, templates.scope or contracts.author (T2).
    Name order. activeOnly: true is the picker's view; the desk's Themes tab
    wants both.
    """
    themes(activeOnly: Boolean = false): [Theme!]!
    "Staff (contracts.author). Journeys build plan S1: the active accounts assignContract would accept for this job."
    assignableUsers(job: AssignmentJob!): [User!]!
    "Staff. Contracts waiting on Root, longest-waiting first."
    needsRootQueue(limit: Int = 20): [ContractRef!]!
    """
    Staff. Recent activity across every contract, newest first. reviewOnly
    narrows it to customer actions that want a response from Root.
    """
    activity(limit: Int = 40, reviewOnly: Boolean = false): [ActivityItem!]!

    "Staff. Every entry, drafts included. Thin — see LibraryEntryRow."
    libraryEntries(search: String, type: EntryType, limit: Int = 50, offset: Int = 0): LibraryEntryPage!
    "Staff. One entry, in full, for the editor."
    libraryEntry(id: ID!): LibraryEntry
    "Staff. The tag picker needs these; R3 gives them a tree."
    libraryConcepts: [LibraryConcept!]!

    "Public. Published, public-visibility entries only (R2)."
    publicLibraryEntries(search: String, type: EntryType, conceptSlug: String, limit: Int = 24, offset: Int = 0): PublicEntryPage!
    "Public. One entry by its slug. Null for a draft, a private entry, or no such slug — the three are one answer (T2)."
    publicLibraryEntry(slug: String!): PublicEntry
    "Public. Concepts that have at least one publicly visible entry."
    publicLibraryConcepts: [PublicConcept!]!
    """
    Public. Whether this deployment has an Anthropic key configured, and so
    whether POST /ask can answer at all. False hides the Ask surface entirely
    rather than offering a box that always fails. A boolean about the server,
    not about the caller — it says nothing a rate limit or a spend ceiling
    would, both of which are decided per request inside the route.
    """
    askAvailable: Boolean!

    "Staff (review.participate). Rounds newest first."
    reviewRounds: [ReviewRound!]!
    "Staff (review.participate). One document from one round."
    reviewDocument(roundId: ID!, documentId: ID!): ReviewDocument
    "Staff (review.admin). Every account holding the reviewer role, for the corpus admin screen."
    reviewers: [User!]!

    "Staff (apiTokens.manage). The caller's own tokens, newest first, revoked ones included."
    myApiTokens: [ApiToken!]!

    "Staff (contracts.readAll or contracts.readActive). One project, with its registry and any trades."
    project(id: ID!): Project

    # --- Requests (journeys build plan J2) ---
    "The caller's own requests that are not yet a contract they can open — pending, archived, and converted-but-not-yet-published — newest first."
    myRequests: [Request!]!
    "Staff (contracts.readAll). Every request, optionally narrowed by status, newest first."
    allRequests(status: ProjectStatus, limit: Int = 100): [Request!]!
    "The customer who made it, or contracts.readAll. NOT_FOUND for anyone else — and for a project that never was a request."
    request(projectId: ID!): Request

    # --- Builds and the resolution ledger (build plan L3b) ---
    "Staff (builds.author). Every phase across every active project, thin — the build-authoring form's phase picker."
    phasesForBuilds: [BuildPhase!]!
    """
    Staff (builds.author). Every OPEN item of the demo step on this project
    (narrowed to one phase when given), oldest first — the queue declareBuild's
    disposition list must exhaust. Other steps' feedback is never in it.
    """
    openFeedbackQueue(projectId: ID!, phaseId: ID): [FeedbackItem!]!

    # --- Answers and the approval queue (journeys build plan S2) ---
    "Staff (feedback.approveAnswers). Every answer waiting for approval, oldest first."
    pendingAnswers: [PendingAnswer!]!
    """
    Staff (feedback.answer). Open items on contracts the caller can see that
    they may answer — those they are assigned to, in a step their direct
    answers cover, first; the rest each marked with the route their answer
    would take. Feedback about money is filtered out for anyone without
    money.read (PD-21).
    """
    myFeedbackQueue(limit: Int = 100): [FeedbackQueueEntry!]!
    "Staff (builds.author). Every scope item on this project currently IN_BUILD and assigned to a phase."
    scopeItemsAwaitingBuild(projectId: ID!): [ScopeItem!]!
    "Staff (builds.author). Every build declared for this project, newest first."
    projectBuilds(projectId: ID!): [Build!]!

    # --- Tickets and the three channels (build plan L4) ---
    "The caller's own tickets, newest first — the portal's support screen."
    myTickets: [Ticket!]!
    "Staff (tickets.answer). Every ticket, optionally filtered — the support desk's own queue."
    allTickets(status: TicketStatus, type: TicketType, projectId: ID): [Ticket!]!
    "Staff (tickets.answer). Every ADMIN_REQUEST ticket ever filed, regardless of status — spec §10.2's demand signal."
    adminRequestCount: Int!

    # --- The dependency board (build plan L5) ---
    "Staff (contracts.readAll). Every overdue dependency across every project, both sides — the full board."
    overdueDependencies: [Dependency!]!
    "The caller's own overdue CUSTOMER-side commitments, across every project they own."
    myOverdueDependencies: [Dependency!]!

    # --- Billing (build plan L6) ---
    """
    The caller's own **issued** invoices, newest first — lazily generates any
    newly-due subscription periods first (lib/billing.ts). A draft is never
    here (journeys build plan J13).
    """
    myInvoices: [BillingEntry!]!
    "One of the caller's own issued invoices. NOT_FOUND for anything else — a draft, someone else's, a missing id alike."
    invoice(id: ID!): BillingEntry!
    """
    Journeys build plan J9 (PD-9). The subdomain the caller's own copy of a
    mockup is served at — https://<grant-id>.<MOCKUP_BASE_DOMAIN>/ — for the
    demo's current **published** mockup build. Reuses the caller's unexpired
    grant or mints a 12-hour one. NOT_FOUND for a demo that is not a mockup or
    a contract the caller cannot see; NO_PUBLISHED_MOCKUP before the first
    iteration is published.
    """
    mockupViewUrl(demoId: ID!): String!
    "The caller's own spend report (spec §8)."
    myBillingReport: BillingReport!
    "The caller's own subscriptions."
    mySubscriptions: [Subscription!]!
    "Staff (billing.manage). Every billing entry — drafts included — optionally narrowed to one customer or one project, newest first."
    allBillingEntries(customerId: ID, projectId: ID): [BillingEntry!]!
    """
    Staff (billing.manage). The contracts that have a payment plan, optionally
    one customer's — the desk's billing screen shows each plan with its
    Issue-next action (journeys build plan J13).
    """
    contractsWithPaymentPlan(customerId: ID): [Contract!]!
    "Staff (billing.manage). The report across one customer, or across every customer when customerId is omitted."
    billingReport(customerId: ID): BillingReport!
    "Staff (billing.manage). Every subscription, optionally narrowed to one customer."
    allSubscriptions(customerId: ID): [Subscription!]!

    # --- Services (build plan L7) ---
    "The caller's own projects — the services panel's own way to find a project without a contract in hand."
    myProjects: [Project!]!
    "Staff, or the project's own customer. Newest first."
    projectServiceRuns(projectId: ID!): [ServiceRun!]!
    "Staff (customers.manage). Every run, optionally narrowed to one project — spec §11's desk-side service-runs list."
    allServiceRuns(projectId: ID): [ServiceRun!]!

    """
    Staff (staff.manage — ADMIN only). Whether an SMS provider is configured
    at all (PD-18) — never the provider's name or key. Feeds the desk's own
    banner warning that the staff second factor is unenforced while this is
    false in production.
    """
    smsConfigured: Boolean!
  }

  input CreateContractInput {
    customerId: ID!
    ref: String!
    titleFa: String!
    titleEn: String!
    amount: String
    "Journeys build plan S1 — sales picks both at creation. Refused: ASSIGNEE_LACKS_CAPABILITY, ASSIGNEE_INACTIVE."
    designerId: ID
    developerId: ID
    """
    Journeys build plan J2: attach to this project. A REQUESTED one is
    converted (status → ACTIVE, the contract attaches, the checklist is
    seeded); an ACTIVE one gets a second contract. Refused:
    PROJECT_CUSTOMER_MISMATCH, PROJECT_ARCHIVED.
    """
    projectId: ID
  }

  type Mutation {
    # --- auth ---
    "identifier is a phone or an email — an @ decides which (journeys build plan J1). One failure message for every branch, as always."
    signIn(identifier: String!, password: String!): AuthPayload!
    "PD-20: the code signIn sent to the account's phone. One refusal, CODE_INVALID, for wrong/expired/used/exhausted alike."
    verifySignInFactor(challengeId: String!, code: String!): AuthPayload!
    "Phone recovery, step 1. Always true — whether that phone has an account is not this call's to leak. SMS_UNAVAILABLE when no provider is configured (PD-18)."
    requestLoginCode(phone: String!): Boolean!
    "Phone recovery, step 2. Sets passwordChangeRequired — the account must set a new password before anything else."
    verifyLoginCode(phone: String!, code: String!): AuthPayload!
    "Clears passwordChangeRequired. The one mutation an account may still call while it is set."
    setNewPassword(password: String!): AuthPayload!
    signOut: Boolean!

    # --- Requests (journeys build plan J2) ---
    """
    A signed-in customer asks for something (a project before a contract). Creates a REQUESTED project and notifies every account holding contracts.author. Refused: EMPTY_TITLE, EMPTY_BODY, TOO_LONG, INVALID_LANG.
    """
    submitRequest(title: String!, body: String!, lang: String!): Request!
    """
    The customer who made it, or contracts.author, adds a message. Refused: NOT_FOUND (not yours to see), REQUEST_CLOSED (archived or converted — the thread is read-only), EMPTY_COMMENT, TOO_LONG. Notifies the other side.
    """
    postRequestMessage(projectId: ID!, body: String!): Request!
    """
    contracts.author. Archives a pending request; the reason is required and is sent to the customer. Refused: REASON_REQUIRED, TOO_LONG, REQUEST_CLOSED (already archived or converted).
    """
    archiveRequest(projectId: ID!, reason: String!): Request!
    acceptInvite(token: String!, name: String!, password: String!): AuthPayload!
    requestPasswordReset(email: String!): Boolean!
    resetPassword(token: String!, password: String!): AuthPayload!

    # --- customer actions on a contract ---
    chooseConcept(contractId: ID!, conceptId: ID!): Contract!
    setPageApproval(pageDesignId: ID!, approved: Boolean!): Contract!
    """
    Approve the contract text. On an AGREEMENT_FIRST contract (journeys build plan
    J7) this is the agreement gate — the contract's own customer only — and it
    locks steps 1 to 3 in the same transaction. Refused: ALREADY_APPROVED,
    NO_PUBLISHED_REVISION, SCOPE_UNCONFIRMED, PLAN_TOTAL_MISMATCH,
    DATES_INCOMPLETE, BRIEF_INCOMPLETE, REVISION_STALE (the steps have changed
    since the draft was published), STEP_HAS_OPEN_FEEDBACK,
    STEP_HAS_PENDING_ANSWERS. The legacy road keeps GATE_DESIGN_INCOMPLETE.
    """
    approveContract(contractId: ID!): Contract!
    """
    The legacy checklist tick. NOT_APPLICABLE on an AGREEMENT_FIRST contract
    (J5): there the customer proposes changes instead, and checkedAt is never
    written.
    """
    setScopeItem(scopeItemId: ID!, checked: Boolean!, contractId: ID): Contract!
    "On an AGREEMENT_FIRST contract, the contract's own customer only; sales is told."
    signContract(contractId: ID!, typedName: String!): Contract!
    """
    The legacy free thread. USE_FEEDBACK on an AGREEMENT_FIRST contract (J6):
    its notes are feedback, anchored and with a fate (submitFeedback).
    """
    addComment(contractId: ID!, body: String!, target: CommentTarget): Contract!

    # --- Step 2a — pages, features and deliverables (journeys build plan J5) ---
    """
    The contract's own customer. Proposes adding a page, feature or deliverable
    in their own words and language (lang: fa or en); nothing enters the registry
    until Root confirms it. NOT_FOUND (not theirs), STEP_NOT_ON_ROAD, INVALID_KIND
    (an EXTRA is step 1's), INVALID_LANG, EMPTY_PROPOSAL, PROPOSAL_TOO_LONG,
    STEP_LOCKED.
    """
    proposeScopeAddition(contractId: ID!, kind: ScopeKind!, text: String!, lang: String!): Contract!
    """
    The contract's own customer. Proposes taking an agreed item out, with why.
    ITEM_NOT_REMOVABLE, NOT_PROPOSABLE (an extra), PROPOSAL_PENDING, and the rest
    as proposeScopeAddition.
    """
    proposeScopeRemoval(scopeItemId: ID!, text: String!): Contract!
    "The contract's own customer. Proposes bringing a declined item back. ITEM_NOT_RESTORABLE, and the rest as proposeScopeRemoval."
    proposeRestore(scopeItemId: ID!, text: String!): Contract!
    """
    The customer's half of a scope trade. The contract's own customer only
    (NOT_FOUND for anyone else); works when SCOPE is locked — a trade is the
    post-lock way to change a scope. ALREADY_CONFIRMED, ALREADY_EXECUTED.
    """
    confirmScopeTradeCustomer(tradeId: ID!, contractId: ID): Contract!

    """
    The amendment's own mini-gate: approve, then sign — without reopening
    the base contract, whose signature stays exactly as it was.
    """
    approveAmendment(amendmentId: ID!): Contract!
    signAmendment(amendmentId: ID!, typedName: String!): Contract!

    # --- minimal operational admin ---
    "locale defaults to the inviting admin's own locale when omitted. Journeys build plan J1: phone is now the required identifier, email optional — the SMS carries the link; email too if given, and the desk always shows the link either way."
    inviteCustomer(phone: String!, name: String!, clientName: String, locale: String, email: String): InviteResult!
    revokeInvite(userId: ID!): Boolean!
    """
    Disable or restore an account (journeys build plan S3). customers.manage for
    a customer, staff.manage for anyone holding a staff role — a mixed account
    is a staff account. Disabling revokes every outstanding token in the same
    transaction. Refused: CANNOT_DISABLE_SELF, LAST_SUPERUSER, INVALID_STATE
    (INVITED is not something you set). Restoring an account that never
    accepted its invite returns it to INVITED.
    """
    setUserState(userId: ID!, state: UserState!): User!
    "customers.manage. Idempotent."
    grantTool(customerId: ID!, tool: ToolKey!): CustomerProfile!
    "customers.manage. Idempotent; the grant stays as history."
    revokeTool(customerId: ID!, tool: ToolKey!): CustomerProfile!
    """
    staff.manage. Staff roles only. A phone is required when any role needs the
    second factor (PHONE_REQUIRED_FOR_STAFF); otherwise a phone or an email.
    Refused: ROLES_REQUIRED, INVALID_ROLE, PHONE_INVALID, IDENTIFIER_REQUIRED,
    NAME_REQUIRED, ALREADY_ACTIVE, ACCOUNT_DISABLED, ACCOUNT_EXISTS (a customer),
    IDENTIFIER_CONFLICT. The desk always shows the link (PD-18).
    """
    inviteStaff(name: String!, roles: [Role!]!, phone: String, email: String, locale: String): InviteResult!
    """
    staff.manage. Replaces the role set. Refused: LAST_ROLE (an empty set),
    LAST_SUPERUSER (removing ADMIN from the last active administrator),
    PHONE_REQUIRED_FOR_STAFF (a factor role for an account with no phone).
    """
    setUserRoles(userId: ID!, roles: [Role!]!): User!
    "review.admin, not customers.manage — inviting a specialist to read a corpus is not account administration (C2.md §5)."
    inviteReviewer(email: String!, name: String!, locale: String): InviteResult!
    "Drops REVIEWER from the account's role set. Refused if it is their only role — that would violate the non-empty-roles constraint (C2.md §5). Comments and threads are untouched."
    revokeReviewer(userId: ID!): Boolean!
    createContract(input: CreateContractInput!): Contract!
    """
    Fills an empty contract with the standard article titles (their {{client}} and
    {{provider}} rendered) and — on a legacy contract — the six scope items.
    Refuses if this contract already has either. On an AGREEMENT_FIRST contract
    the scope comes from applyScopeTemplate, not from here.
    """
    applyContractTemplate(contractId: ID!): Contract!
    """
    contracts.author. Seeds this contract's scope from the template type its
    brief chose — agreed, and its own (a key the project already has takes the
    next free suffix). SCOPE_ALREADY_SEEDED, BRIEF_MISSING, TEMPLATE_SCOPE_EMPTY,
    STEP_NOT_ON_ROAD, STEP_LOCKED.
    """
    applyScopeTemplate(contractId: ID!): Contract!
    """
    contracts.author. Decides a customer's proposal. Accepting an ADD needs both
    labels (a key and a kind are optional: custom.<n>, and the kind they asked
    for); declining needs a reason the customer reads. ALREADY_DECIDED,
    REASON_REQUIRED, LABEL_REQUIRED, INVALID_KEY, KEY_TAKEN, ITEM_STATE_CHANGED,
    STEP_LOCKED.
    """
    decideScopeProposal(
      id: ID!
      decision: ScopeProposalDecision!
      labelFa: String
      labelEn: String
      key: String
      kind: ScopeKind
      declineReason: String
    ): Contract!
    """
    contracts.author. The contract's planned start and end (Q12) as YYYY-MM-DD
    days, a replace: an omitted day is cleared. INVALID_DATE, DATES_OUT_OF_ORDER,
    STEP_NOT_ON_ROAD, STEP_LOCKED.
    """
    setPlannedDates(contractId: ID!, plannedStartAt: String, plannedEndAt: String): Contract!
    "The title and fee half of the draft. ref is not editable — see T1 in V2.md. STEP_LOCKED once the agreement is approved (J7)."
    updateContractDraft(contractId: ID!, titleFa: String!, titleEn: String!, amount: String): Contract!
    "Legal even when this article is inside the current published snapshot; the snapshot does not move. STEP_LOCKED once the agreement is approved (J7)."
    deleteArticle(contractId: ID!, number: Int!): Contract!
    addConcept(contractId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!
    "labelFa/labelEn only — key never changes; lib/design.ts matches on it for carry-forward."
    updateConcept(conceptId: ID!, labelFa: String!, labelEn: String!): Contract!
    "Pages cascade."
    deleteConcept(conceptId: ID!): Contract!
    addPageDesign(conceptId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!
    updatePageDesign(pageId: ID!, labelFa: String!, labelEn: String!): Contract!
    deletePageDesign(pageId: ID!): Contract!
    "Deletes the unpublished design revision and its concepts/pages (and the copied previews nothing else shows)."
    discardDesignDraft(contractId: ID!): Contract!

    """
    design.author + the contract's designer (J8). Starts a round: creates the
    design draft if there is none (idempotent), and on the custom path gives it
    its one concept, "wireframes", to hang pages on. Every design write below
    is STEP_LOCKED once the customer has approved the design, and on the new
    road AGREEMENT_NOT_SIGNED until the agreement is signed.
    """
    startDesignDraft(contractId: ID!): Contract!
    """
    design.author + the contract's designer (J8). A pre-made round: the draft's
    themes become exactly themeIds, in that order. Each new one is snapshotted
    (name, vendor, demo URL — never the licence cost) and its preview copied into
    a contract-owned image. NOT_PREMADE, DUPLICATE_THEME, THEME_NOT_FOUND,
    THEME_INACTIVE, THEME_NOT_OFFERED (not assigned to the brief's template type).
    """
    proposeThemes(contractId: ID!, themeIds: [ID!]!): Contract!
    """
    design.author + the contract's designer (J8). A colour, a font or a logo note
    in the custom design's palette. NOT_CUSTOM, INVALID_COLOR / INVALID_FONT /
    INVALID_LOGO_NOTE, INVALID_ROLE, LABEL_REQUIRED, LABEL_TOO_LONG, ROLE_TAKEN,
    PALETTE_FULL.
    """
    addPaletteItem(contractId: ID!, kind: PaletteKind!, role: String!, value: String!, labelFa: String!, labelEn: String!): Contract!
    "The value and the labels; kind and role never change."
    updatePaletteItem(itemId: ID!, value: String!, labelFa: String!, labelEn: String!): Contract!
    "Attach a DESIGN_IMAGE of this contract (a font specimen, the logo on a background), or null to remove it."
    setPaletteItemImage(itemId: ID!, fileId: ID): Contract!
    deletePaletteItem(itemId: ID!): Contract!

    """
    contracts.author (J8; journeys Q-S5: a sales approval, optionally billed).
    Admits "extra" more rounds of a step; with "charge" (Toman, a decimal string,
    and billing.manage) it also creates a DRAFT invoice for it. Only DESIGN yet
    (STEP_NOT_BUILT for the others); the new road only (STEP_NOT_ON_ROAD).
    INVALID_EXTRA, REASON_REQUIRED, STEP_HAS_NO_ALLOWANCE, INVALID_AMOUNT,
    NO_ALLOWANCE_SET.
    """
    extendAllowance(contractId: ID!, step: StepKind!, phaseId: ID, extra: Int!, reason: String!, charge: String): Contract!

    """
    Attach a file already uploaded through POST /upload, or pass fileId: null
    to remove the image. The file must be a DESIGN_IMAGE belonging to this
    same contract; anything else is refused as not found.
    """
    setConceptImage(conceptId: ID!, fileId: ID): Contract!
    setPageImage(pageId: ID!, fileId: ID): Contract!
    """
    Created AGREED — Root adding it here is the agreement act. See CHECKLIST for
    the DECLINED-by-default seed. kind omitted: classified by its key, the way
    the T1 migration classified the rows that already existed.
    """
    addScopeItem(contractId: ID!, key: String!, labelFa: String!, labelEn: String!, kind: ScopeKind): Contract!
    "Live to the customer the instant it is saved — ScopeItem is not versioned."
    updateScopeItem(scopeItemId: ID!, labelFa: String!, labelEn: String!, contractId: ID): Contract!
    deleteScopeItem(scopeItemId: ID!, contractId: ID): Contract!

    "reason is stored only when status is DECLINED; set otherwise, it is cleared."
    setScopeItemStatus(scopeItemId: ID!, status: ScopeStatus!, reason: String, contractId: ID): Contract!
    "Full replace of all three flags in one call, since they are edited together on the registry screen."
    setScopeItemFlags(scopeItemId: ID!, temporary: Boolean!, outOfScope: Boolean!, adminWork: Boolean!, contractId: ID): Contract!
    "Sets decidedAt to now and records the pointer. Refused if already decided — undecideScopeItem first."
    decideScopeItem(scopeItemId: ID!, note: String!, contractId: ID): Contract!
    "Clears decidedAt and decidedNote together — see schema.prisma's CHECK."
    undecideScopeItem(scopeItemId: ID!, contractId: ID): Contract!
    setScopeItemOrigin(scopeItemId: ID!, note: String, round: String, contractId: ID): Contract!
    "Swaps position with the neighbour in that direction. A no-op at either end of the list."
    reorderScopeItem(scopeItemId: ID!, direction: ScopeMoveDirection!, contractId: ID): Contract!

    """
    Proposes a paired movement: outItemId (must be AGREED or further along)
    moves toward TRADED, and a new item is created PROPOSED to move the other
    way. Neither actually moves until executeScopeTrade — see ScopeTrade.
    Returns the contract, like every other registry mutation (T9 in V2.md) —
    reach the new trade via project.scopeTrades.
    """
    proposeScopeTrade(projectId: ID!, outItemId: ID!, inKey: String!, inLabelFa: String!, inLabelEn: String!, contractId: ID): Contract!
    "Root's confirmation. The customer's has no mutation yet — see docs/development/L1.md."
    confirmScopeTradeRoot(tradeId: ID!, contractId: ID): Contract!
    "Refused until both rootConfirmedAt and customerConfirmedAt are set."
    executeScopeTrade(tradeId: ID!, contractId: ID): Contract!

    # --- Template types and scope templates (build plan T1) ---
    "templates.types. Refused: INVALID_SLUG, LABEL_REQUIRED, TEMPLATE_SLUG_TAKEN."
    createTemplateType(slug: String!, labelFa: String!, labelEn: String!): TemplateType!
    "templates.types. Omitted fields are left alone. Refused: NOT_FOUND, INVALID_SLUG, LABEL_REQUIRED, TEMPLATE_SLUG_TAKEN. There is no delete — active: false."
    updateTemplateType(id: ID!, slug: String, labelFa: String, labelEn: String, active: Boolean): TemplateType!
    "templates.types. ids must name every type exactly once. Refused: REORDER_MISMATCH."
    reorderTemplateTypes(ids: [ID!]!): [TemplateType!]!
    """
    templates.scope. Replaces the type's whole list, in one transaction, in the
    order given. Refused: NOT_FOUND (typeId), INVALID_KEY, DUPLICATE_TEMPLATE_KEY,
    INVALID_TEMPLATE_KIND, LABEL_REQUIRED — and a refused input leaves the old
    list untouched.
    """
    setTemplateScope(typeId: ID!, items: [TemplateScopeItemInput!]!): TemplateType!

    # --- The theme catalogue (build plan T2) ---
    """
    templates.types. licenseCost is whole Toman as a string. Refused:
    NAME_REQUIRED, INVALID_DEMO_URL, DEMO_URL_NOT_HTTPS, INVALID_AMOUNT.
    An empty string means "none" for the optional fields.
    """
    createTheme(name: String!, vendor: String, demoUrl: String, rtlSupport: RtlSupport, licenseCost: String, notesFa: String, notesEn: String): Theme!
    """
    templates.types. Omitted (null) fields are left alone; an empty string clears
    an optional one. There is no delete — active: false. Refused: NOT_FOUND,
    NAME_REQUIRED, INVALID_DEMO_URL, DEMO_URL_NOT_HTTPS, INVALID_AMOUNT.
    """
    updateTheme(id: ID!, name: String, vendor: String, demoUrl: String, rtlSupport: RtlSupport, licenseCost: String, notesFa: String, notesEn: String, active: Boolean): Theme!
    """
    templates.types. Replaces the set of themes offered for one type, in one
    transaction; returns the whole catalogue (the rows that changed are on both
    sides of the replace). Refused: NOT_FOUND (typeId), DUPLICATE_THEME,
    THEME_NOT_FOUND — and a refused input leaves the old set untouched.
    """
    setTemplateTypeThemes(typeId: ID!, themeIds: [ID!]!): [Theme!]!

    # --- Phases and the live demo surface (build plan L2) ---
    """
    number is the contract-scoped ordinal (J4) — PHASE_NUMBER_TAKEN if this
    contract already has it. plannedEndAt is a YYYY-MM-DD calendar day
    (INVALID_DATE). Both phase writes are step 1's: STEP_LOCKED once the
    agreement is approved.
    """
    createPhase(contractId: ID!, number: Int!, titleFa: String!, titleEn: String!, milestoneLabel: String, plannedEndAt: String): Contract!
    "plannedEndAt: omitted leaves it, null clears it. contractId, when given, must be the phase's own contract."
    updatePhase(phaseId: ID!, titleFa: String!, titleEn: String!, milestoneLabel: String, plannedEndAt: String, contractId: ID): Contract!
    deletePhase(phaseId: ID!, contractId: ID): Contract!
    "phaseId: null unassigns the item from whatever phase it was on."
    assignScopeItemToPhase(scopeItemId: ID!, phaseId: ID, contractId: ID): Contract!

    "stagingUrl must be HTTPS (L2.2) — refused otherwise, with a code naming why."
    createDemo(phaseId: ID!, stagingUrl: String!, buildRef: String, contractId: ID): Contract!
    updateDemo(demoId: ID!, stagingUrl: String, buildRef: String, reviewWindowStart: DateTime, reviewWindowEnd: DateTime, contractId: ID): Contract!
    deleteDemo(demoId: ID!, contractId: ID): Contract!
    "canonicalPath is compared through lib/demoPages.ts's normalizePath — declare it in whatever raw shape is natural, not pre-normalized."
    declareDemoPage(demoId: ID!, key: String!, labelFa: String!, labelEn: String!, canonicalPath: String!, pageDesignId: ID, contractId: ID): Contract!
    "labelFa/labelEn/canonicalPath and the design-image toggle, all in one call — the desk edits a declared page as one row, not five separate ones."
    updateDemoPage(demoPageId: ID!, labelFa: String!, labelEn: String!, canonicalPath: String!, pageDesignId: ID, contractId: ID): Contract!
    deleteDemoPage(demoPageId: ID!, contractId: ID): Contract!

    """
    The reporter snippet's own call, made on every page-change event —
    matches the path against the demo's declared pages (lib/demoPages.ts)
    and records a miss rather than dropping it (L2.2). Callable by Root
    *or* the project's own customer, unlike every other mutation in this
    section: this is telemetry from a page either of them may be viewing,
    not a content edit, which is also why it returns a thin payload instead
    of the whole contract (house rule 2 — this is an ownership check against
    the project's customer, not a capability gate).
    """
    reportDemoPath(demoId: ID!, path: String!): DemoPathReport!

    # --- Review frames and feedback intake (build plan L3; spec §6) ---
    """
    Seeds or refreshes the frame's generated lines from the registry
    (lib/demoFrame.ts) — additive only, never deletes or edits an existing
    line, so a line a reviewer has already commented on is never silently
    pulled out from under that feedback. Creates the DemoFrame row itself if
    this is the first call for this demo.
    """
    generateDemoFrame(demoId: ID!, contractId: ID): Contract!
    "Freehand context beside the generated lines. Either field omitted leaves it unchanged; pass an empty string to clear one."
    updateDemoFrameSummary(demoId: ID!, summaryFa: String, summaryEn: String, contractId: ID): Contract!
    "A line Root types by hand — no scope item behind it, so it can never trigger interception (D4). buildChangeEntryId, when given, writes up one of DemoFrame.unpromptedChanges (build plan L3b's third source)."
    addDemoFrameLine(demoId: ID!, kind: DemoFrameLineKind!, textFa: String!, textEn: String!, buildChangeEntryId: ID, contractId: ID): Contract!
    updateDemoFrameLine(lineId: ID!, textFa: String!, textEn: String!, contractId: ID): Contract!
    "Cascades to its feedback item, if any."
    deleteDemoFrameLine(lineId: ID!, contractId: ID): Contract!
    "Refused without a frame authored first (NO_FRAME) — spec §6: 'a demo cannot be published naked.'"
    publishDemo(demoId: ID!, contractId: ID): Contract!

    # --- Feedback on every step, answers and the approval queue (journeys build plan S2) ---
    """
    The contract's own customer only (NOT_FOUND for anyone else, staff
    included — Root answers, it does not raise). Raises feedback on one step
    of the contract: target names the anchor (see FeedbackTargetInput), phaseId
    the phase of a DEMO. Refused STEP_LOCKED once the step is approved.

    Intercepted (D4) when the target resolves to a decided or temporary scope
    item — a SCOPE anchor, or a frame line with one — and confirmReopen is not
    yet true: nothing is written, and the result's interceptionReason /
    interceptionScopeItem are what the web renders into the "this was settled
    on ⟨date⟩ — reopen it?" prompt (house rule 6 — never sentence text from
    here). Resubmit identically with confirmReopen: true to proceed.

    A second submission against a target that already has an item appends a
    comment to it rather than creating a second one (D4's duplicate collapse),
    and reopens it if Root had resolved it (ADDRESSED, DECLINED or MOVED — the
    journeys §3.1 rule).
    """
    submitFeedback(
      contractId: ID!
      step: StepKind!
      phaseId: ID
      target: FeedbackTargetInput!
      body: String!
      confirmReopen: Boolean = false
    ): FeedbackSubmitResult!

    """
    Staff (feedback.answer), on a contract they can see and a step still open
    (STEP_LOCKED once approved — staff cannot answer on a locked step either).
    Writes a staff comment; whether it reaches the customer now (approval
    NOT_REQUIRED, and a resolution given is applied at once) or waits for sales
    (PENDING, the item stays OPEN) is answerRoute(caller, step) — the
    answers.direct.* capabilities. A declined resolution needs its reason in
    the body.
    """
    answerFeedback(itemId: ID!, body: String!, resolution: FeedbackResolution): FeedbackItem!

    """
    Staff (feedback.approveAnswers). Publishes a pending answer — as written,
    or with body edited (the original is kept) — and applies its resolution
    unless a later visible answer or customer comment has already spoken.
    """
    approveAnswer(commentId: ID!, body: String): FeedbackItem!

    """
    Staff (feedback.approveAnswers). Returns a pending answer to its author
    with the reason (REASON_REQUIRED without one) — the customer never sees it.
    """
    declineAnswer(commentId: ID!, reason: String!): FeedbackItem!

    """
    The contract's own customer only. Approves a step (journeys §3.1): refused
    while any comment on it is open (STEP_HAS_OPEN_FEEDBACK) or any answer is
    waiting for sales (STEP_HAS_PENDING_ANSWERS); otherwise accepts every
    resolved item at once and locks the step (STEP_LOCKED for anything after,
    staff included). phaseId is required for a DEMO. Only DEMO is approved here
    (STEP_NOT_APPROVABLE for the rest): the agreement is J7's gate, and the steps
    it seals are approved with it; the design and the mockup have their own
    doors, approveDesign (J8) and approveMockup (J9b).
    """
    approveStep(contractId: ID!, step: StepKind!, phaseId: ID): Contract!

    """
    The contract's own customer only (J8). "Show me other options" on a pre-made
    design: a general DESIGN note, marked, that the next round answers. "note"
    is optional — without it the comment says so in the customer's language.
    NOT_PREMADE, NO_ROUND, STEP_LOCKED.
    """
    requestOtherOptions(contractId: ID!, note: String): Contract!

    """
    The contract's own customer only (J8). Approves the design: approveStep's
    rule (STEP_HAS_OPEN_FEEDBACK, STEP_HAS_PENDING_ANSWERS) plus the path's own
    completeness — DESIGN_INCOMPLETE unless designMissing is empty. After it
    every design mutation is STEP_LOCKED. STEP_NOT_APPROVABLE on the legacy road.
    """
    approveDesign(contractId: ID!): Contract!

    # --- Step 5, the mockup (journeys build plan J9b) ---
    """
    Designer (design.author, and the contract's designer — NOT_ASSIGNED
    otherwise). Starts step 5: the contract's MOCKUP demo with a page per agreed
    PAGE item of the contract, unmapped. One per contract (MOCKUP_DEMO_EXISTS).
    STEP_LOCKED, STEP_NOT_ON_ROAD (legacy), BRIEF_MISSING, NOT_CUSTOM (the pre-made
    path has no mockup), DESIGN_NOT_APPROVED, NO_PAGES.
    """
    createMockupDemo(contractId: ID!): Contract!

    """
    Designer. Points one mockup page at a path in the bundle — about.html, /about.html
    and /about/ are one page; a blank path unmaps it. INVALID_PATH,
    PATH_ALREADY_MAPPED, STEP_LOCKED. Brings the frame up to date.
    """
    mapMockupPage(demoPageId: ID!, path: String!): Contract!

    """
    Designer (design.author + answers.direct.mockup, and the contract's designer).
    Declares a mockup iteration from an uploaded MOCKUP_BUNDLE of this contract —
    numbered per kind ("mockup 2"). Every open MOCKUP feedback item needs a
    disposition (MISSING_DISPOSITION otherwise), each the designer's direct answer;
    a change may not name a scope item (SCOPE_ITEM_NOT_ON_MOCKUP). FILE_ALREADY_USED
    for a bundle that is already an iteration. Declaring costs nothing; publishBuild
    spends the allowance.
    """
    declareMockupBuild(demoId: ID!, fileId: ID!, ref: String, changes: [BuildChangeInput!]!): Build!

    """
    The contract's own customer only (J9b). Approves the mockup: approveStep's rule
    (STEP_HAS_OPEN_FEEDBACK, STEP_HAS_PENDING_ANSWERS) plus a published iteration
    (NO_PUBLISHED_MOCKUP). After it every mockup mutation is STEP_LOCKED.
    """
    approveMockup(contractId: ID!): Contract!

    # --- Builds and the resolution ledger (build plan L3b) ---
    """
    Staff (builds.author). Declares a build for a phase — number is
    project-wide and monotonic. Requires a disposition (ADDRESSED, DECLINED
    with its reason, or the explicit CARRIED_FORWARD) for every currently
    open item of the demo step on that phase first (MISSING_DISPOSITION
    otherwise) — a fate must never be silent. A disposition is the
    developer's answer: it resolves the item directly, as a comment carrying
    the resolution. Every FeedbackItem/ScopeItem transition a
    change entry implies happens now, not at publishBuild.
    """
    declareBuild(phaseId: ID!, ref: String, changes: [BuildChangeInput!]!): Build!
    """
    Notifies the project's customer — a build they are not told about is a
    deployment, not a version. Refused a second time (ALREADY_PUBLISHED). A SITE build
    is the developer's (builds.author, and the phase's developer). A MOCKUP build
    (J9b) is the designer's (design.author, and the contract's designer): it checks
    the mockup allowance (ALLOWANCE_EXHAUSTED until extendAllowance admits one more),
    refuses an older draft once a newer iteration is out (BUILD_SUPERSEDED), brings the
    frame up to date and publishes the mockup demo with its first iteration.
    """
    publishBuild(buildId: ID!): Build!

    # --- Tickets and the three channels (build plan L4) ---
    """
    The customer's own support intake (spec §5) — the portal's support rail
    goes live. type may not be ADMIN_REQUEST here (INVALID_TICKET_TYPE) —
    that classification is staff's to apply, via moveTicketChannel, once a
    ticket is recognized as one.
    """
    createTicket(type: TicketType!, subject: String!, body: String!, urgency: TicketUrgency, projectId: ID): Ticket!
    "Staff, or the ticket's own customer (house rule 2)."
    addTicketMessage(ticketId: ID!, body: String!): Ticket!
    "Staff (tickets.answer)."
    setTicketStatus(ticketId: ID!, status: TicketStatus!): Ticket!
    "Staff (tickets.answer)."
    setTicketUrgency(ticketId: ID!, urgency: TicketUrgency!): Ticket!
    "Staff (tickets.answer). Only ever flips the flag — the BillingEntry edge is L6's, not built here."
    setTicketBillable(ticketId: ID!, billable: Boolean!): Ticket!
    """
    Moving a ticket between channels is a first-class action (spec §5), not
    a copy-paste that would lose its message history — this updates the row
    in place.
    """
    moveTicketChannel(ticketId: ID!, type: TicketType!): Ticket!
    """
    Staff (tickets.answer). An open feedback item becomes a change ticket —
    the brief (spec §5, §6) — and is itself MOVED, a resolution the customer
    sees. Refused (NOT_OPEN) unless the item is currently OPEN, and refused
    (ALREADY_CONVERTED) if one already exists for it. currentState/desiredState are written by whoever performs
    the conversion — see docs/development/L4.md for why this stage does not
    auto-generate them. lang is "fa" or "en" (INVALID_LANG otherwise).
    """
    createTicketFromFeedback(itemId: ID!, currentState: String!, desiredState: String!, lang: String!): Ticket!

    # --- The dependency board (build plan L5) ---
    """
    Staff (contracts.author). side names who owes it — CUSTOMER or ROOT, the
    same board, the same rule. Returns the whole contract (T9), reached via
    project.dependencies.
    """
    createDependency(projectId: ID!, side: DependencySide!, titleFa: String!, titleEn: String!, dueAt: DateTime!, contractId: ID): Contract!
    "Staff (contracts.author)."
    updateDependency(dependencyId: ID!, titleFa: String!, titleEn: String!, dueAt: DateTime!, contractId: ID): Contract!
    """
    Staff (dependencies.verifyGeneral). note is required (VERIFICATION_NOTE_REQUIRED
    otherwise) — "we deployed a test file to the host," never only a
    timestamp. This is the stage's own banked trap, held here structurally.
    """
    verifyDependency(dependencyId: ID!, note: String!, contractId: ID): Contract!
    "Staff (dependencies.verifyGeneral). Clears a verification made in error."
    unverifyDependency(dependencyId: ID!, contractId: ID): Contract!
    "Staff (contracts.author)."
    deleteDependency(dependencyId: ID!, contractId: ID): Contract!

    # --- Billing (build plan L6) ---
    """
    Staff (billing.manage). Authors a one-off **draft** — a contract milestone,
    a service run not billed through its own edge, or a manual ticket
    charge (journeys build plan J13: this was createBillingEntry, and issued
    the moment it was created). A draft is invisible to the customer until
    issueInvoice. source may not be SUBSCRIPTION here (INVALID_SOURCE) — those
    are only ever generated lazily from a Subscription's own periods (build
    plan L6's first banked trap: this mutation is not the scheduler).
    paymentTermDays omitted takes the default when the draft is issued.
    """
    createInvoiceDraft(customerId: ID!, contractId: ID, phaseId: ID, source: BillingSource!, descriptionFa: String!, descriptionEn: String!, amount: String!, paymentTermDays: Int): BillingEntry!
    "Staff (billing.manage). Edits a draft (NOT_A_DRAFT once it is issued). A replace: an omitted paymentTermDays is cleared."
    updateInvoiceDraft(entryId: ID!, descriptionFa: String!, descriptionEn: String!, amount: String!, paymentTermDays: Int): BillingEntry!
    "Staff (billing.manage). Deletes a draft (NOT_A_DRAFT once it is issued — an issued invoice is never deleted)."
    deleteInvoiceDraft(entryId: ID!): Boolean!
    """
    Staff (billing.manage). Draft to issued: takes the next number from the
    sequence, dates it now, and is due paymentTermDays later (the draft's own,
    else DEFAULT_PAYMENT_TERM_DAYS). Tells the customer. ALREADY_ISSUED if it is.
    """
    issueInvoice(entryId: ID!): BillingEntry!
    """
    Staff (billing.manage). Issues one row of a contract's payment plan
    (journeys build plan J13, Q18): refused NOT_SIGNED until the agreement is
    signed, PREVIOUS_UNPAID until the row before it is paid,
    PHASE_NOT_ACCEPTED while its phase's demo is not approved. A second press
    is ALREADY_ISSUED. Returns the contract, whose plan now shows the invoice.
    """
    issuePlannedInvoice(plannedInvoiceId: ID!): Contract!
    "Staff (billing.manage). NOT_ISSUED on a draft — there is nothing to pay yet."
    markBillingEntryPaid(entryId: ID!): BillingEntry!
    "Staff (billing.manage). Reverses a mark-paid made in error. SUCCESSOR_ISSUED if the next row of its payment plan has been issued since."
    unmarkBillingEntryPaid(entryId: ID!): BillingEntry!
    """
    Staff (billing.manage). Build plan L4's second banked trap, built here:
    the edge from a billable ticket to the charge it produces. Refused
    unless the ticket is billable (NOT_BILLABLE) or already billed
    (ALREADY_BILLED — the unique ticketId is the backstop).
    """
    createTicketBillingEntry(ticketId: ID!, amount: String!, descriptionFa: String!, descriptionEn: String!): BillingEntry!
    "Staff (billing.manage)."
    createSubscription(customerId: ID!, projectId: ID, labelFa: String!, labelEn: String!, amount: String!, period: SubscriptionPeriod!, activeFrom: DateTime!): Subscription!
    "Staff (billing.manage). label and amount only — period and activeFrom are fixed at creation; ending it is endSubscription, not an edit."
    updateSubscription(subscriptionId: ID!, labelFa: String!, labelEn: String!, amount: String!): Subscription!
    "Staff (billing.manage). Stops future periods from being generated past activeUntil. Refused if already ended (ALREADY_ENDED)."
    endSubscription(subscriptionId: ID!, activeUntil: DateTime!): Subscription!

    # --- Services (build plan L7) ---
    """
    Attaches a file already uploaded through POST /upload?class=SERVICE_IMPORT
    as a new run. Staff, or the project's own customer. Refused
    (ALREADY_ATTACHED) if the file already names a run.
    """
    createServiceRun(projectId: ID!, fileId: ID!): ServiceRun!
    """
    Parses and validates the run's file, then diffs it against the store —
    spec §9's "preview diff against the store." An unreadable file or a
    missing required column sets status FAILED with failureReason rather
    than raising an error — a legitimate outcome, not a client mistake.
    Refused (ALREADY_APPLIED) once the run has been applied.
    """
    previewServiceRun(runId: ID!): ServiceRun!
    """
    Build plan L7's banked trap: refused (NOT_PREVIEWED) unless the run is
    currently PREVIEWED, and refused (ALREADY_APPLIED) if it already is.
    There is no path from upload to apply that skips a preview.
    """
    applyServiceRun(runId: ID!): ServiceRun!
    """
    Staff (billing.manage). Build plan L6's edge: the charge an applied
    run produced. Refused (NOT_APPLIED) unless the run is APPLIED, and
    refused (ALREADY_BILLED) if one already exists. Returns the run.
    """
    createServiceRunBillingEntry(runId: ID!, amount: String!, descriptionFa: String!, descriptionEn: String!): ServiceRun!

    "sensitive (J4, PD-14): omitted, a new article takes the template's rule and an existing one keeps its flag. J7: STEP_LOCKED once the agreement is approved; SCHEDULE_IS_GENERATED for a body on Payment Schedule (article 5) of an AGREEMENT_FIRST contract — the plan is rendered there instead."
    setArticle(contractId: ID!, number: Int!, titleFa: String!, titleEn: String!, bodyFa: String, bodyEn: String, sensitive: Boolean): Contract!

    """
    Freeze the current draft as the next contract revision. Refused on a signed
    contract — that revision is terminal and changes go in as amendments. On an
    AGREEMENT_FIRST contract (J6) it is step 2b's hand-over and is also refused
    SCOPE_UNCONFIRMED (no scope yet, or a proposal undecided) and then
    BRIEF_INCOMPLETE (extensions.missing lists step 1's gaps); it tells the
    customer.
    """
    publishContractRevision(contractId: ID!): Contract!
    "Publish the draft design revision, carrying forward unchanged approvals."
    publishDesignRevision(contractId: ID!): Contract!

    """
    Hands the contract to the customer. On an AGREEMENT_FIRST contract this is
    handing over step 1 (J4): BRIEF_MISSING without a brief row, and the customer
    is told by email and SMS. Publishing what is published is a no-op.
    """
    publishContract(contractId: ID!): Contract!

    # --- Step 1 — requirements (journeys build plan J4) ---
    """
    contracts.author. Writes the brief and syncs its dependencies in the same
    transaction (one row per key, however often it is set; a provider switched
    to Root flips the row's side). STEP_NOT_ON_ROAD for a legacy contract,
    STEP_LOCKED once the agreement is approved; INVALID_BUDGET, INVALID_DEADLINE,
    DEADLINES_OUT_OF_ORDER, INVALID_SITE_URL, INVALID_SUPPORT_MONTHS,
    INVALID_ALLOWANCE, INVALID_DATE, TEMPLATE_TYPE_INACTIVE.
    """
    setBrief(contractId: ID!, input: BriefInput!): Contract!
    """
    contracts.author. An extra (a completeness-checklist area) in or out of
    scope — declined and agreed. NOT_AN_EXTRA for any other item,
    EXTRA_IN_PROGRESS to switch one off once work has started.
    """
    setExtra(scopeItemId: ID!, included: Boolean!, contractId: ID): Contract!
    """
    contracts.author. Replace-all, in the order given: the server stores exactly
    these rows and never regenerates them from the split. PLAN_ROWS_REQUIRED,
    TOO_MANY_ROWS, LABEL_REQUIRED, INVALID_AMOUNT, INVALID_TERM,
    PHASE_WRONG_CONTRACT, STEP_LOCKED.
    """
    setPaymentPlan(contractId: ID!, split: PaymentSplit!, invoices: [PlannedInvoiceInput!]!): Contract!
    setContractStatus(contractId: ID!, status: ContractStatus!): Contract!
    """
    Staff (contracts.author). Journeys build plan S1: who designs and who
    develops this contract. An omitted argument is left as is; null unassigns.
    Refused: ASSIGNEE_LACKS_CAPABILITY (the person cannot do that job),
    ASSIGNEE_INACTIVE (their account is not active).
    """
    assignContract(contractId: ID!, designerId: ID, developerId: ID): Contract!
    """
    Staff (contracts.readActive or contracts.readAll, and the contract visible
    to them). Journeys build plan J3: a private note on a contract — never read
    by a customer, and not by "view as customer". FORBIDDEN for anyone else
    (checked first), NOT_FOUND for a contract this reader cannot see,
    EMPTY_COMMENT / TOO_LONG for the text.
    """
    addInternalNote(contractId: ID!, body: String!): Contract!

    "The current contract revision must be signed."
    issueAmendment(contractId: ID!, titleFa: String!, titleEn: String!, bodyFa: String!, bodyEn: String!, relatesToArticle: Int, sensitive: Boolean): Contract!
    "Refused once published — the hash is recomputed on every write."
    updateAmendment(amendmentId: ID!, titleFa: String!, titleEn: String!, bodyFa: String!, bodyEn: String!, relatesToArticle: Int, sensitive: Boolean): Contract!
    "Refused once published."
    deleteAmendment(amendmentId: ID!): Contract!
    "Logs CONTRACT_AMENDED and nudges WAITING_ON_CUSTOMER."
    publishAmendment(amendmentId: ID!): Contract!

    # --- Library (R1) ---
    createLibraryEntry(input: LibraryEntryInput!): LibraryEntry!
    updateLibraryEntry(id: ID!, input: LibraryEntryInput!): LibraryEntry!
    "Removes any hosted file first (T3), then the entry."
    deleteLibraryEntry(id: ID!): Boolean!
    "Replaces the whole tag set."
    setEntryConcepts(id: ID!, conceptIds: [ID!]!): LibraryEntry!
    "Removes the hosted file (bytes and row) without changing rights or visibility. Replacing a file is this, then POST /upload."
    detachEntryFullText(id: ID!): LibraryEntry!
    publishLibraryEntry(id: ID!): LibraryEntry!
    unpublishLibraryEntry(id: ID!): LibraryEntry!
    "A contributor's own remit — filing an entry that needs a tag that does not exist yet should not require stopping to ask an admin."
    createLibraryConcept(input: LibraryConceptInput!): LibraryConcept!
    "Renaming and nesting the ontology is library.editTree, not library.write."
    updateLibraryConcept(id: ID!, input: LibraryConceptInput!): LibraryConcept!
    deleteLibraryConcept(id: ID!): Boolean!

    """
    Freezes a round: a root-sot commit sha and its allowlisted documents at
    that sha, already split into blocks by the publish CLI. review.admin
    only — the CLI is convenience, this mutation is the trust boundary
    (C1.md §3.1). Every path and block is revalidated here; contentHash is
    always recomputed from the blocks received, never taken from the request.
    Refused if a round for this sha already exists.
    """
    publishReviewRound(sha: String!, label: String, documents: [ReviewDocumentInput!]!): ReviewRound!

    "review.participate. Opens a thread anchored to one passage in one block, with its opening comment."
    openReviewThread(documentId: ID!, blockId: String!, startOffset: Int!, endOffset: Int!, quote: String!, body: String!): ReviewThread!
    "review.participate. The thread must already be visible to the caller — Root, or the thread's own author; loading it is the permission check."
    addReviewComment(threadId: ID!, body: String!): ReviewThread!
    "Idempotent — resolving an already-resolved thread just returns it."
    resolveReviewThread(threadId: ID!): ReviewThread!

    # --- API tokens ---
    """
    Issues a token and returns its secret, once. apiTokens.manage, and a
    signed-in session — a token may not mint another token, or one leak
    becomes permanent access.

    expiresInDays null means it does not expire.
    """
    createApiToken(name: String!, scope: ApiTokenScope!, expiresInDays: Int): CreatedApiToken!
    """
    Revokes one of the caller's own tokens, effective on the next request.
    Idempotent — revoking an already-revoked token returns it unchanged rather
    than failing, since the caller's intent is already satisfied.
    """
    revokeApiToken(id: ID!): ApiToken!
  }
`;
