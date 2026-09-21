export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum Role {
    CUSTOMER
    ADMIN
    CONTRIBUTOR
    REVIEWER
    DEVELOPER
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
    email: String!
    name: String!
    roles: [Role!]!
    """
    What this person may do, unioned across their roles. Plain strings rather
    than an enum because the names are dotted ("contracts.manage") and a
    GraphQL enum value cannot contain a dot.

    **The client branches on these, never on roles.** Testing a role on the
    client has exactly the failure the server-side table exists to prevent —
    it just fails in a place that is harder to see.
    """
    capabilities: [String!]!
    clientName: String
    locale: String!
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
    imageUrl: String
    chosen: Boolean!
    pages: [PageDesign!]!
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

  enum ProjectStatus {
    ACTIVE
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
  }

  """
  Paired movements — one item out, one in (spec §4). Both parties confirm
  before it executes. **The customer-confirm half has no mutation yet** — see
  docs/development/L1.md.
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

  """
  The registry's owner (build plan D1). Phases, demos and dependencies (L2,
  L5) are not modelled yet — this is deliberately thin.
  """
  type Project {
    id: ID!
    titleFa: String!
    titleEn: String!
    status: ProjectStatus!
    scopeItems: [ScopeItem!]!
    scopeTrades: [ScopeTrade!]!
    "Ordered by number — build plan L2."
    phases: [Phase!]!
    "Derived fresh on every read (lib/phase.ts) — never a stored percentage (F5)."
    progress: ProjectProgress!
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
    stagingUrl: String!
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
    passing). Staff (contracts.manage) only; empty for anyone else, and
    empty is not a claim that nothing changed — see fields.ts's own comment.
    """
    unpromptedChanges: [BuildChangeEntry!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  Fates a feedback item can occupy (spec §6: "every item shows its fate —
  accepted / done / declined-because"). L3 wrote and read only OPEN and
  RATIFIED; build plan L3b is what actually writes ADDRESSED, ACCEPTED and
  DECLINED — present in the enum since L3 on the same precedent L1 used for
  ScopeStatus.ACCEPTED (built before anything could reach it).
  """
  enum FeedbackStatus {
    "Submitted, unratified — an opinion (F8), visible but inert."
    OPEN
    "The decider (D3) ratified the batch this item was part of — actionable."
    RATIFIED
    "L3b: the developer's claim, not the customer's acceptance."
    ADDRESSED
    "The customer met it in the next review and did not reopen it."
    ACCEPTED
    "Declined, with its reason — spec §6's declined-because."
    DECLINED
  }

  "One voice on a feedback item (spec §6, F8)."
  type FeedbackComment {
    id: ID!
    author: User!
    body: String!
    createdAt: DateTime!
  }

  """
  Per-item feedback intake (spec §6) — never a comment blob. Binds to a demo
  page or a frame line, exactly one of the two. Two submissions against the
  same target collapse into one row (D4) — see comments for the individual
  voices that pile up on it.
  """
  type FeedbackItem {
    id: ID!
    demoPage: DemoPage
    frameLine: DemoFrameLine
    status: FeedbackStatus!
    "Set when this item was filed against a decided/temporary scope item and the submitter chose to proceed (D4's interception)."
    reopenedScopeItem: ScopeItem
    ratifiedAt: DateTime
    ratifiedBy: User
    """
    Build plan L3b.2's first rule, as two fields rather than one: the
    developer's claim, and which build carried it. Not the customer's
    acceptance — see acceptedAt. Cleared the moment a new comment reopens
    the item (lib/feedback.ts's reopensOnComment).
    """
    addressedInBuild: Build
    "The second, separate write: the customer met this in the next review and did not reopen it. Set only by acceptFeedback, and only from ADDRESSED."
    acceptedAt: DateTime
    acceptedBy: User
    "Oldest first — the opening voice, then whoever piled on."
    comments: [FeedbackComment!]!
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
  # is gated on builds.author, never contracts.manage, and nothing here
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
    "The developer's claim. Requires the item to already be RATIFIED."
    ADDRESSED
    "Requires note — declined-*because*, structurally (L3b.2's third rule)."
    DECLINED
    """
    The explicit "still open, carried forward" — the only legal disposition
    for a merely-OPEN (unratified) item.
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
    "Latin figures, always (house rule 14) — project-wide and monotonic, never reset per phase."
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

  type Article {
    id: ID!
    number: Int!
    titleFa: String!
    titleEn: String!
    bodyFa: String
    bodyEn: String
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
    bodyFa: String!
    bodyEn: String!
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
    publishedAt: DateTime
    updatedAt: DateTime!
    gate: Gate!
    concepts: [DesignConcept!]!
    "Live — this project's whole registry, not only what is agreed. See agreedScopeItems for the frozen view."
    scopeItems: [ScopeItem!]!
    "Null until L1's migration runs, or for a contract with no project yet."
    project: Project
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

  type AuthPayload {
    user: User!
  }

  """
  Returned when an admin issues an invite. The raw link exists exactly once —
  here — and is never readable again.
  """
  type InviteResult {
    userId: ID!
    email: String!
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

  type Query {
    me: User
    myContracts(status: ContractStatus): [Contract!]!
    contractStatusCounts: [StatusCount!]!
    contract(id: ID!): Contract

    "Admin only."
    allContracts: [Contract!]!
    allCustomers: [User!]!

    "Staff. Counts across every contract — not the caller's own, unlike contractStatusCounts."
    allContractStatusCounts: [StatusCount!]!
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

    "Staff (contracts.manage). One project, with its registry and any trades."
    project(id: ID!): Project

    # --- Builds and the resolution ledger (build plan L3b) ---
    "Staff (builds.author). Every phase across every active project, thin — the build-authoring form's phase picker."
    phasesForBuilds: [BuildPhase!]!
    "Staff (builds.author). Every OPEN/RATIFIED feedback item on this project, oldest first — the queue declareBuild's disposition list must exhaust."
    openFeedbackQueue(projectId: ID!): [FeedbackItem!]!
    "Staff (builds.author). Every scope item on this project currently IN_BUILD and assigned to a phase."
    scopeItemsAwaitingBuild(projectId: ID!): [ScopeItem!]!
    "Staff (builds.author). Every build declared for this project, newest first."
    projectBuilds(projectId: ID!): [Build!]!
  }

  input CreateContractInput {
    customerId: ID!
    ref: String!
    titleFa: String!
    titleEn: String!
    amount: String
  }

  type Mutation {
    # --- auth ---
    signIn(email: String!, password: String!): AuthPayload!
    signOut: Boolean!
    acceptInvite(token: String!, name: String!, password: String!): AuthPayload!
    requestPasswordReset(email: String!): Boolean!
    resetPassword(token: String!, password: String!): AuthPayload!

    # --- customer actions on a contract ---
    chooseConcept(contractId: ID!, conceptId: ID!): Contract!
    setPageApproval(pageDesignId: ID!, approved: Boolean!): Contract!
    approveContract(contractId: ID!): Contract!
    setScopeItem(scopeItemId: ID!, checked: Boolean!): Contract!
    signContract(contractId: ID!, typedName: String!): Contract!
    addComment(contractId: ID!, body: String!, target: CommentTarget): Contract!

    """
    The amendment's own mini-gate: approve, then sign — without reopening
    the base contract, whose signature stays exactly as it was.
    """
    approveAmendment(amendmentId: ID!): Contract!
    signAmendment(amendmentId: ID!, typedName: String!): Contract!

    # --- minimal operational admin ---
    "locale defaults to the inviting admin's own locale when omitted."
    inviteCustomer(email: String!, name: String!, clientName: String, locale: String): InviteResult!
    revokeInvite(userId: ID!): Boolean!
    "review.admin, not customers.manage — inviting a specialist to read a corpus is not account administration (C2.md §5)."
    inviteReviewer(email: String!, name: String!, locale: String): InviteResult!
    "Drops REVIEWER from the account's role set. Refused if it is their only role — that would violate the non-empty-roles constraint (C2.md §5). Comments and threads are untouched."
    revokeReviewer(userId: ID!): Boolean!
    createContract(input: CreateContractInput!): Contract!
    "Fills an empty contract with the standard article titles and scope items. Refuses if either already has rows."
    applyContractTemplate(contractId: ID!): Contract!
    "The title and fee half of the draft. ref is not editable — see T1 in V2.md."
    updateContractDraft(contractId: ID!, titleFa: String!, titleEn: String!, amount: String): Contract!
    "Legal even when this article is inside the current published snapshot; the snapshot does not move."
    deleteArticle(contractId: ID!, number: Int!): Contract!
    addConcept(contractId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!
    "labelFa/labelEn only — key never changes; lib/design.ts matches on it for carry-forward."
    updateConcept(conceptId: ID!, labelFa: String!, labelEn: String!): Contract!
    "Pages cascade."
    deleteConcept(conceptId: ID!): Contract!
    addPageDesign(conceptId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!
    updatePageDesign(pageId: ID!, labelFa: String!, labelEn: String!): Contract!
    deletePageDesign(pageId: ID!): Contract!
    "Deletes the unpublished design revision and its concepts/pages."
    discardDesignDraft(contractId: ID!): Contract!

    """
    Attach a file already uploaded through POST /upload, or pass fileId: null
    to remove the image. The file must be a DESIGN_IMAGE belonging to this
    same contract; anything else is refused as not found.
    """
    setConceptImage(conceptId: ID!, fileId: ID): Contract!
    setPageImage(pageId: ID!, fileId: ID): Contract!
    "Created AGREED — Root adding it here is the agreement act. See CHECKLIST for the DECLINED-by-default seed."
    addScopeItem(contractId: ID!, key: String!, labelFa: String!, labelEn: String!): Contract!
    "Live to the customer the instant it is saved — ScopeItem is not versioned."
    updateScopeItem(scopeItemId: ID!, labelFa: String!, labelEn: String!): Contract!
    deleteScopeItem(scopeItemId: ID!): Contract!

    "reason is stored only when status is DECLINED; set otherwise, it is cleared."
    setScopeItemStatus(scopeItemId: ID!, status: ScopeStatus!, reason: String): Contract!
    "Full replace of all three flags in one call, since they are edited together on the registry screen."
    setScopeItemFlags(scopeItemId: ID!, temporary: Boolean!, outOfScope: Boolean!, adminWork: Boolean!): Contract!
    "Sets decidedAt to now and records the pointer. Refused if already decided — undecideScopeItem first."
    decideScopeItem(scopeItemId: ID!, note: String!): Contract!
    "Clears decidedAt and decidedNote together — see schema.prisma's CHECK."
    undecideScopeItem(scopeItemId: ID!): Contract!
    setScopeItemOrigin(scopeItemId: ID!, note: String, round: String): Contract!
    "Swaps position with the neighbour in that direction. A no-op at either end of the list."
    reorderScopeItem(scopeItemId: ID!, direction: ScopeMoveDirection!): Contract!

    """
    Proposes a paired movement: outItemId (must be AGREED or further along)
    moves toward TRADED, and a new item is created PROPOSED to move the other
    way. Neither actually moves until executeScopeTrade — see ScopeTrade.
    Returns the contract, like every other registry mutation (T9 in V2.md) —
    reach the new trade via project.scopeTrades.
    """
    proposeScopeTrade(projectId: ID!, outItemId: ID!, inKey: String!, inLabelFa: String!, inLabelEn: String!): Contract!
    "Root's confirmation. The customer's has no mutation yet — see docs/development/L1.md."
    confirmScopeTradeRoot(tradeId: ID!): Contract!
    "Refused until both rootConfirmedAt and customerConfirmedAt are set."
    executeScopeTrade(tradeId: ID!): Contract!

    # --- Phases and the live demo surface (build plan L2) ---
    "number is the project-scoped ordinal — @@unique([projectId, number])."
    createPhase(contractId: ID!, number: Int!, titleFa: String!, titleEn: String!, milestoneLabel: String): Contract!
    updatePhase(phaseId: ID!, titleFa: String!, titleEn: String!, milestoneLabel: String): Contract!
    deletePhase(phaseId: ID!): Contract!
    "phaseId: null unassigns the item from whatever phase it was on."
    assignScopeItemToPhase(scopeItemId: ID!, phaseId: ID): Contract!

    "stagingUrl must be HTTPS (L2.2) — refused otherwise, with a code naming why."
    createDemo(phaseId: ID!, stagingUrl: String!, buildRef: String): Contract!
    updateDemo(demoId: ID!, stagingUrl: String, buildRef: String, reviewWindowStart: DateTime, reviewWindowEnd: DateTime): Contract!
    deleteDemo(demoId: ID!): Contract!
    "canonicalPath is compared through lib/demoPages.ts's normalizePath — declare it in whatever raw shape is natural, not pre-normalized."
    declareDemoPage(demoId: ID!, key: String!, labelFa: String!, labelEn: String!, canonicalPath: String!, pageDesignId: ID): Contract!
    "labelFa/labelEn/canonicalPath and the design-image toggle, all in one call — the desk edits a declared page as one row, not five separate ones."
    updateDemoPage(demoPageId: ID!, labelFa: String!, labelEn: String!, canonicalPath: String!, pageDesignId: ID): Contract!
    deleteDemoPage(demoPageId: ID!): Contract!

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
    generateDemoFrame(demoId: ID!): Contract!
    "Freehand context beside the generated lines. Either field omitted leaves it unchanged; pass an empty string to clear one."
    updateDemoFrameSummary(demoId: ID!, summaryFa: String, summaryEn: String): Contract!
    "A line Root types by hand — no scope item behind it, so it can never trigger interception (D4). buildChangeEntryId, when given, writes up one of DemoFrame.unpromptedChanges (build plan L3b's third source)."
    addDemoFrameLine(demoId: ID!, kind: DemoFrameLineKind!, textFa: String!, textEn: String!, buildChangeEntryId: ID): Contract!
    updateDemoFrameLine(lineId: ID!, textFa: String!, textEn: String!): Contract!
    "Cascades to its feedback item, if any."
    deleteDemoFrameLine(lineId: ID!): Contract!
    "Refused without a frame authored first (NO_FRAME) — spec §6: 'a demo cannot be published naked.'"
    publishDemo(demoId: ID!): Contract!

    """
    Callable by Root or the project's own customer (house rule 2 — an
    ownership check against project.customerId, never a role test), like
    reportDemoPath. Exactly one of targetDemoPageId/targetFrameLineId.

    Intercepted (D4) when the target resolves to a decided or temporary
    scope item and confirmReopen is not yet true: nothing is written, and
    the result's interceptionReason/interceptionScopeItem are what the web
    renders into the "this was settled on ⟨date⟩ — reopen it?" prompt
    (house rule 6 — never sentence text from here). Resubmit identically
    with confirmReopen: true to proceed.

    A second submission against a target that already has an item appends a
    comment to it rather than creating a second one (D4's duplicate collapse).
    """
    submitFeedback(
      demoId: ID!
      targetDemoPageId: ID
      targetFrameLineId: ID
      body: String!
      confirmReopen: Boolean = false
    ): FeedbackSubmitResult!

    """
    The decider (D3: the project's own customer, or staff) ratifies a batch.
    Only items in the list that are currently OPEN and belong to this demo
    move to RATIFIED; anything else named is silently skipped, the same
    idempotent shape resolveReviewThread already uses.
    """
    ratifyFeedback(demoId: ID!, itemIds: [ID!]!): Contract!

    """
    The customer (or staff) confirms an ADDRESSED item is actually resolved
    (build plan L3b.2's second, separate write). Refused (NOT_ADDRESSED)
    from any status other than ADDRESSED.
    """
    acceptFeedback(itemId: ID!): FeedbackItem!

    # --- Builds and the resolution ledger (build plan L3b) ---
    """
    Staff (builds.author). Declares a build for a phase — number is
    project-wide and monotonic. Requires a disposition (ADDRESSED, DECLINED
    with its reason, or the explicit CARRIED_FORWARD) for every currently
    open feedback item on the project first (MISSING_DISPOSITION otherwise)
    — a fate must never be silent. Every FeedbackItem/ScopeItem transition a
    change entry implies happens now, not at publishBuild.
    """
    declareBuild(phaseId: ID!, ref: String, changes: [BuildChangeInput!]!): Build!
    "Staff (builds.author). Notifies the project's customer — a build they are not told about is a deployment, not a version. Refused a second time (ALREADY_PUBLISHED)."
    publishBuild(buildId: ID!): Build!

    setArticle(contractId: ID!, number: Int!, titleFa: String!, titleEn: String!, bodyFa: String, bodyEn: String): Contract!

    """
    Freeze the current draft as the next contract revision. Refused on a signed
    contract — that revision is terminal and changes go in as amendments.
    """
    publishContractRevision(contractId: ID!): Contract!
    "Publish the draft design revision, carrying forward unchanged approvals."
    publishDesignRevision(contractId: ID!): Contract!

    publishContract(contractId: ID!): Contract!
    setContractStatus(contractId: ID!, status: ContractStatus!): Contract!

    "The current contract revision must be signed."
    issueAmendment(contractId: ID!, titleFa: String!, titleEn: String!, bodyFa: String!, bodyEn: String!, relatesToArticle: Int): Contract!
    "Refused once published — the hash is recomputed on every write."
    updateAmendment(amendmentId: ID!, titleFa: String!, titleEn: String!, bodyFa: String!, bodyEn: String!, relatesToArticle: Int): Contract!
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
