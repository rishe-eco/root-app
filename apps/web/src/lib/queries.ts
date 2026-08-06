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
  email: string;
  name: string;
  roles: Role[];
  capabilities: Capability[];
  clientName: string | null;
  locale: string;
};

export type PageDesign = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  imageUrl: string | null;
  approved: boolean;
};

export type DesignConcept = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  imageUrl: string | null;
  chosen: boolean;
  pages: PageDesign[];
};

export type ScopeItem = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  checked: boolean;
};

export type Article = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string | null;
  bodyEn: string | null;
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
  bodyFa: string;
  bodyEn: string;
  contentHash: string;
  relatesToArticle: number | null;
  publishedAt: string | null;
  approvedAt: string | null;
  signature: Signature | null;
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

export type Contract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  status: ContractStatus;
  amount: string | null;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  publishedAt: string | null;
  updatedAt: string;
  gate: Gate;
  concepts: DesignConcept[];
  scopeItems: ScopeItem[];
  articles: Article[];
  comments: Comment[];
  changeLog: ChangeLogEntry[];
  signature: Signature | null;
  revision: ContractRevision | null;
  // Non-staff see published revisions only — enforced server-side, not here.
  contractRevisions: ContractRevisionSummary[];
  designRevisions: DesignRevisionSummary[];
  pending: PendingReview | null;
  // Staff-only; present only on queries that select them (the workspace).
  draft?: ContractDraft | null;
  designDraft?: DesignDraft | null;
};

const USER_FIELDS = gql`
  fragment UserFields on User {
    id
    email
    name
    roles
    capabilities
    clientName
    locale
  }
`;

/** One shape for the detail screen, so every mutation can return it whole. */
export const CONTRACT_FIELDS = gql`
  fragment ContractFields on Contract {
    id
    ref
    titleFa
    titleEn
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
      checked
    }
    articles {
      id
      number
      titleFa
      titleEn
      bodyFa
      bodyEn
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
  fragment ContractWorkspaceFields on Contract {
    ...ContractFields
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
        pages {
          id
          key
          labelFa
          labelEn
          imageUrl
          approved
        }
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

export const CONTRACT = gql`
  ${CONTRACT_FIELDS}
  query Contract($id: ID!) {
    contract(id: $id) {
      ...ContractFields
    }
  }
`;

export const SIGN_IN = gql`
  ${USER_FIELDS}
  mutation SignIn($email: String!, $password: String!) {
    signIn(email: $email, password: $password) {
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
  mutation ChooseConcept($contractId: ID!, $conceptId: ID!) {
    chooseConcept(contractId: $contractId, conceptId: $conceptId) {
      ...ContractFields
    }
  }
`;

export const SET_PAGE_APPROVAL = gql`
  ${CONTRACT_FIELDS}
  mutation SetPageApproval($pageDesignId: ID!, $approved: Boolean!) {
    setPageApproval(pageDesignId: $pageDesignId, approved: $approved) {
      ...ContractFields
    }
  }
`;

export const APPROVE_CONTRACT = gql`
  ${CONTRACT_FIELDS}
  mutation ApproveContract($contractId: ID!) {
    approveContract(contractId: $contractId) {
      ...ContractFields
    }
  }
`;

export const SET_SCOPE_ITEM = gql`
  ${CONTRACT_FIELDS}
  mutation SetScopeItem($scopeItemId: ID!, $checked: Boolean!) {
    setScopeItem(scopeItemId: $scopeItemId, checked: $checked) {
      ...ContractFields
    }
  }
`;

export const SIGN_CONTRACT = gql`
  ${CONTRACT_FIELDS}
  mutation SignContract($contractId: ID!, $typedName: String!) {
    signContract(contractId: $contractId, typedName: $typedName) {
      ...ContractFields
    }
  }
`;

export const ADD_COMMENT = gql`
  ${CONTRACT_FIELDS}
  mutation AddComment($contractId: ID!, $body: String!, $target: CommentTarget) {
    addComment(contractId: $contractId, body: $body, target: $target) {
      ...ContractFields
    }
  }
`;

export const ALL_CONTRACTS = gql`
  ${CONTRACT_FIELDS}
  query AllContracts {
    allContracts {
      ...ContractFields
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

export const INVITE_CUSTOMER = gql`
  mutation InviteCustomer($email: String!, $name: String!, $clientName: String) {
    inviteCustomer(email: $email, name: $name, clientName: $clientName) {
      userId
      email
      inviteUrl
      expiresAt
    }
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
  mutation SetArticle($contractId: ID!, $number: Int!, $titleFa: String!, $titleEn: String!, $bodyFa: String, $bodyEn: String) {
    setArticle(contractId: $contractId, number: $number, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn) {
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
  mutation UpdateScopeItem($scopeItemId: ID!, $labelFa: String!, $labelEn: String!) {
    updateScopeItem(scopeItemId: $scopeItemId, labelFa: $labelFa, labelEn: $labelEn) {
      ...ContractWorkspaceFields
    }
  }
`;

export const DELETE_SCOPE_ITEM = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation DeleteScopeItem($scopeItemId: ID!) {
    deleteScopeItem(scopeItemId: $scopeItemId) {
      ...ContractWorkspaceFields
    }
  }
`;

export const ISSUE_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation IssueAmendment($contractId: ID!, $titleFa: String!, $titleEn: String!, $bodyFa: String!, $bodyEn: String!, $relatesToArticle: Int) {
    issueAmendment(contractId: $contractId, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn, relatesToArticle: $relatesToArticle) {
      ...ContractWorkspaceFields
    }
  }
`;

export const UPDATE_AMENDMENT = gql`
  ${CONTRACT_WORKSPACE_FIELDS}
  mutation UpdateAmendment($amendmentId: ID!, $titleFa: String!, $titleEn: String!, $bodyFa: String!, $bodyEn: String!, $relatesToArticle: Int) {
    updateAmendment(amendmentId: $amendmentId, titleFa: $titleFa, titleEn: $titleEn, bodyFa: $bodyFa, bodyEn: $bodyEn, relatesToArticle: $relatesToArticle) {
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
  mutation ApproveAmendment($amendmentId: ID!) {
    approveAmendment(amendmentId: $amendmentId) {
      ...ContractFields
    }
  }
`;

export const SIGN_AMENDMENT = gql`
  ${CONTRACT_FIELDS}
  mutation SignAmendment($amendmentId: ID!, $typedName: String!) {
    signAmendment(amendmentId: $amendmentId, typedName: $typedName) {
      ...ContractFields
    }
  }
`;
