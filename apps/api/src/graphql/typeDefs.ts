export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum Role {
    CUSTOMER
    ADMIN
    CONTRIBUTOR
    REVIEWER
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

  type ScopeItem {
    id: ID!
    key: String!
    labelFa: String!
    labelEn: String!
    checked: Boolean!
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
    scopeItems: [ScopeItem!]!
    articles: [Article!]!
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

    "Staff (review.participate). Rounds newest first."
    reviewRounds: [ReviewRound!]!
    "Staff (review.participate). One document from one round."
    reviewDocument(roundId: ID!, documentId: ID!): ReviewDocument
    "Staff (review.admin). Every account holding the reviewer role, for the corpus admin screen."
    reviewers: [User!]!

    "Staff (apiTokens.manage). The caller's own tokens, newest first, revoked ones included."
    myApiTokens: [ApiToken!]!
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
    addScopeItem(contractId: ID!, key: String!, labelFa: String!, labelEn: String!): Contract!
    "Live to the customer the instant it is saved — ScopeItem is not versioned."
    updateScopeItem(scopeItemId: ID!, labelFa: String!, labelEn: String!): Contract!
    deleteScopeItem(scopeItemId: ID!): Contract!
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
