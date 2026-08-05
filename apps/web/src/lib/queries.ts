import { gql } from '@apollo/client';

export type Role = 'CUSTOMER' | 'ADMIN' | 'CONTRIBUTOR' | 'REVIEWER';

/**
 * Mirrors the server's `lib/capabilities.ts`. The UI branches on these and
 * never on `roles` — a person may hold several, so any `role === '…'` on this
 * side is wrong in the same way it was on the server, only quieter.
 */
export type Capability =
  | 'contracts.manage'
  | 'customers.manage'
  | 'library.write'
  | 'library.publish'
  | 'library.editTree'
  | 'review.participate'
  | 'review.admin';

export const can = (user: Pick<User, 'capabilities'> | null | undefined, cap: Capability) =>
  user?.capabilities.includes(cap) ?? false;

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
  | 'AMENDMENT_SIGNED';

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

export type Contract = {
  id: string;
  ref: string;
  titleFa: string;
  titleEn: string;
  status: ContractStatus;
  amount: string | null;
  customer: Pick<User, 'id' | 'name' | 'clientName'>;
  updatedAt: string;
  gate: Gate;
  concepts: DesignConcept[];
  scopeItems: ScopeItem[];
  articles: Article[];
  comments: Comment[];
  changeLog: ChangeLogEntry[];
  signature: Signature | null;
  revision: ContractRevision | null;
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
