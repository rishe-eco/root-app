export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum Role {
    CUSTOMER
    ADMIN
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
  }

  type User {
    id: ID!
    email: String!
    name: String!
    role: Role!
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
    addScopeItem(contractId: ID!, key: String!, labelFa: String!, labelEn: String!): Contract!
    setArticle(contractId: ID!, number: Int!, titleFa: String!, titleEn: String!, bodyFa: String, bodyEn: String): Contract!
    publishContract(contractId: ID!): Contract!
    setContractStatus(contractId: ID!, status: ContractStatus!): Contract!
  }
`;
