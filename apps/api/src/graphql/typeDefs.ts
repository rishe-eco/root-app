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
  The unpublished design revision, if one exists. Staff only.

  **Reading this never creates one.** The draft comes into being on the first
  edit, not on the first look — see draftDesignRevision.
  """
  type DesignDraft {
    id: ID!
    version: Int!
    concepts: [DesignConcept!]!
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
  }

  type StatusCount {
    status: ContractStatus!
    count: Int!
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

  type Query {
    me: User
    myContracts(status: ContractStatus): [Contract!]!
    contractStatusCounts: [StatusCount!]!
    contract(id: ID!): Contract

    "Admin only."
    allContracts: [Contract!]!
    allCustomers: [User!]!
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

    # --- minimal operational admin ---
    inviteCustomer(email: String!, name: String!, clientName: String): InviteResult!
    revokeInvite(userId: ID!): Boolean!
    createContract(input: CreateContractInput!): Contract!
    addConcept(contractId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!
    addPageDesign(conceptId: ID!, key: String!, labelFa: String!, labelEn: String!, imageUrl: String): Contract!

    """
    Attach a file already uploaded through POST /upload, or pass fileId: null
    to remove the image. The file must be a DESIGN_IMAGE belonging to this
    same contract; anything else is refused as not found.
    """
    setConceptImage(conceptId: ID!, fileId: ID): Contract!
    setPageImage(pageId: ID!, fileId: ID): Contract!
    addScopeItem(contractId: ID!, key: String!, labelFa: String!, labelEn: String!): Contract!
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
  }
`;
