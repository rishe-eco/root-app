import type { ContractStatus, ProjectStatus, User } from '@prisma/client';
import { can } from './capabilities.js';
import { isMoneyAnchored } from './feedbackRules.js';

/**
 * Which contracts a person sees, and which of them they may author — the
 * **ownership** half of the permission model (house rule 2), where
 * `capabilities.ts` is the surface half.
 *
 * Journeys build plan S1. Before this file, the staff side of every ownership
 * check was one bypass — `can(user, 'contracts.manage')` in `loadForActor`,
 * again in `loadDemoForActor`, again in the file route — and so the only two
 * answers were "every contract" and "your own". Three staff roles need a
 * third answer (the contracts still being worked) and a fourth (the ones you
 * are assigned to), and four copies of that logic would disagree within a
 * stage. So the answers live here, once, and every loader imports them.
 *
 * Pure functions over the rows' own columns: no database access, so each rule
 * is unit-tested as a table (`visibility.test.ts`) and the callers do the
 * loading.
 */

type Viewer = Pick<User, 'id' | 'roles'>;

type ContractForVisibility = {
  customerId: string;
  publishedAt: Date | null;
  status: ContractStatus;
  /** Required since J2 made `Contract.projectId` NOT NULL: every caller's
   *  query must select the project's status, and a caller that forgets is a
   *  type error rather than a contract silently read as active. */
  project: { status: ProjectStatus };
};

/**
 * Still being worked: not discarded, on an active project. The plan's third
 * clause — not yet delivered — arrives with `Contract.deliveredAt` in J11;
 * until then it is absent, not false, so every undelivered contract passes.
 *
 * "On an active project" is the whole answer to what the request statuses
 * mean here. A `REQUESTED` project has no contract yet, so there is nothing
 * to ask; but were one ever attached to a project that is not `ACTIVE`, it
 * would read as inactive — a request is not a project being worked, and
 * design and development (who hold `contracts.readActive`, never
 * `contracts.readAll`) must not see it. Sales sees requests through
 * `contracts.readAll`, and the customer through `requestVisibleTo` below.
 */
export function isActiveContract(c: Pick<ContractForVisibility, 'status' | 'project'>): boolean {
  if (c.status === 'DISCARDED') return false;
  return c.project.status === 'ACTIVE';
}

/**
 * The one answer to "may this person see this contract at all". The
 * customer who owns it, once it is published; anyone holding
 * `contracts.readAll`; anyone holding `contracts.readActive`, while it is
 * active. Unpublished contracts are visible to staff readers — a draft is
 * exactly what sales is working on, and a designer can be assigned before
 * the customer ever sees it.
 */
export function contractVisibleTo(user: Viewer, c: ContractForVisibility): boolean {
  return contractVisibleToStaff(user, c) || (c.customerId === user.id && c.publishedAt !== null);
}

/** The staff half alone — for authoring guards, where the customer's own edge
 *  must not count (a customer is never a build author; S1's fourth finding). */
export function contractVisibleToStaff(user: Viewer, c: Pick<ContractForVisibility, 'status' | 'project'>): boolean {
  if (can(user, 'contracts.readAll')) return true;
  return can(user, 'contracts.readActive') && isActiveContract(c);
}

/**
 * A staff reader of contracts at all — the question the field resolvers ask
 * ("show unpublished revisions?") *after* `loadForActor` has already decided
 * this person may see this contract. Never an answer about a row on its own.
 */
export function isContractReader(user: Viewer): boolean {
  return can(user, 'contracts.readAll') || can(user, 'contracts.readActive');
}

/**
 * Author this contract's design: the capability, and being its designer —
 * or holding `assignments.override`. Two mechanisms checked separately, as
 * house rule 2 says, because they answer two different questions: *may you
 * do design work at all*, and *is this one yours*.
 */
export function canAuthorDesign(user: Viewer, c: { designerId: string | null }): boolean {
  if (!can(user, 'design.author')) return false;
  return c.designerId === user.id || can(user, 'assignments.override');
}

/** The same pair for building: `builds.author`, and being the developer. */
export function canAuthorBuild(user: Viewer, c: { developerId: string | null }): boolean {
  if (!can(user, 'builds.author')) return false;
  return c.developerId === user.id || can(user, 'assignments.override');
}

/**
 * A developer's claim on one phase — journeys build plan J4 (PD-5). **A phase
 * belongs to a contract, and a contract has one developer**, so the claim on a
 * phase is that contract's own `developerId` (or `assignments.override`): the
 * two mechanisms of house rule 2, checked separately, exactly as
 * `canAuthorBuild` states them — this only adds that the contract must be one
 * the caller may see at all.
 *
 * It replaces S1's `canAuthorBuildOnProject`, which existed because a phase
 * belonged to the project, so "developer of *any* contract on it" was the best
 * answer available. With two contracts on a project that answer let the first
 * contract's developer author the second's demos. A discarded contract's
 * developer is out by the same rule as before: `contractVisibleToStaff` does
 * not admit a discarded contract to a `contracts.readActive` holder.
 */
export function canAuthorBuildOnPhase(
  user: Viewer,
  phaseContract: Pick<ContractForVisibility, 'status' | 'project'> & { developerId: string | null },
): boolean {
  return contractVisibleToStaff(user, phaseContract) && canAuthorBuild(user, phaseContract);
}

/**
 * The project-level question the developer's queue asks ("may I look at this
 * project's builds at all?"): the caller holds a claim on **at least one of the
 * project's phases**. `phaseContracts` are the contracts that own phases on the
 * project, not every contract on it — a project whose phases are all another
 * developer's is not the caller's, and one with no phases yet has no builds to
 * see. Both are `NOT_ASSIGNED`, which the desk never reaches: it opens these
 * queries from a phase `phasesForBuilds` offered.
 */
export function canAuthorBuildOnAnyPhase(
  user: Viewer,
  phaseContracts: Array<{ developerId: string | null; status: ContractStatus }>,
): boolean {
  if (!can(user, 'builds.author')) return false;
  if (can(user, 'assignments.override')) return true;
  return phaseContracts.some((c) => c.status !== 'DISCARDED' && c.developerId === user.id);
}

/**
 * A project is visible to a staff reader when any of its contracts is: the
 * project has no visibility of its own to decide, only its contracts do. The
 * customer's edge is the project's own `customerId` (L2's demo check).
 */
export function projectVisibleTo(
  user: Viewer,
  p: { customerId: string; status: ProjectStatus; contracts: Array<Pick<ContractForVisibility, 'status'>> },
): boolean {
  return p.customerId === user.id || projectVisibleToStaff(user, p);
}

/**
 * A request (journeys build plan J2) is read by the customer who made it and
 * by anyone holding `contracts.readAll` — sales, and ADMIN by construction.
 * **Not** by `contracts.readActive` (design, development): a request is
 * not a project being worked, it is a conversation with a prospect about
 * something that may never become one, and the designer has no business in
 * it until sales has turned it into a contract they are assigned to.
 *
 * Takes the project's own columns, so it answers the same for a request that
 * is pending, archived or already converted — the thread outlives the
 * status, read-only.
 */
export function requestVisibleTo(user: Viewer, p: { customerId: string; requestedAt: Date | null }): boolean {
  if (p.requestedAt === null) return false;
  return p.customerId === user.id || can(user, 'contracts.readAll');
}

/** The staff half alone — for authoring guards, where the customer's own
 *  edge must not count (a customer is never a build author). */
export function projectVisibleToStaff(
  user: Viewer,
  p: { status: ProjectStatus; contracts: Array<Pick<ContractForVisibility, 'status'>> },
): boolean {
  if (can(user, 'contracts.readAll')) return true;
  if (!can(user, 'contracts.readActive')) return false;
  return p.contracts.some((c) => isActiveContract({ status: c.status, project: { status: p.status } }));
}

/**
 * Root's private notes on a contract (journeys build plan J3): a staff reader
 * of contracts who may see *this* contract. Two clauses, because the first
 * alone would let a designer read the notes of a contract they cannot open.
 * **Never a customer** — not the owner, and not staff viewing as one, which is
 * why `viewAs` swaps the viewer rather than filtering afterwards: asked about
 * the customer, this returns false by construction.
 */
export function mayReadInternalNotes(user: Viewer, c: ContractForVisibility): boolean {
  return isContractReader(user) && contractVisibleTo(user, c);
}

/**
 * Whether an attention item is shown to this viewer (journeys build plan J3,
 * §6.3). The module computes every item that exists; what a viewer sees of
 * them is decided here, in the one file that holds visibility rules:
 *
 * - **`internal`** items are Root's own housekeeping (Root's late commitments,
 *   an inactive assignee, a demo not ready) — contract readers only. A
 *   customer seeing "Root is late" is not what the board is for (L5's
 *   `myOverdueDependencies` made the same choice).
 * - **`money`** items follow PD-21: only those who may read the contract's
 *   money (the customer, and staff holding `money.read`).
 *
 * Each later stage sets the two flags on the items it adds; this function
 * does not change.
 */
export function attentionVisibleTo(
  user: Viewer,
  c: { customerId: string },
  item: { internal: boolean; money: boolean },
): boolean {
  if (item.money && !mayReadMoney(user, c)) return false;
  if (item.internal && !isContractReader(user)) return false;
  return true;
}

/**
 * The contract's planned start and end (journeys build plan J3, Q12) are
 * proposed in the draft and frozen at approval (J7). Staff readers see them
 * always, since the draft is theirs; a customer sees them once `shownToCustomer`
 * — **which the loader (`resolvers/wizard.ts`, `plannedDatesShown`) makes true
 * from the moment a draft is published, or the agreement approved, whichever is
 * first.** J3 read it as "approval only"; J6's step 2b shows the proposed dates
 * beside the draft, where the customer can comment on them, so the rule moved
 * with it. The parameter is a plain boolean because *when* is the loader's
 * question and *whether a customer may* is this file's.
 */
export function mayReadPlannedDates(user: Viewer, shownToCustomer: boolean): boolean {
  return isContractReader(user) || shownToCustomer;
}

/**
 * PD-14, the part S1 could not leave for J4: the moment design and development
 * can read active contracts, the fee on those contracts is one field away.
 * The customer always reads their own; staff read it only with `money.read`.
 * S1 put the fee, the frozen fee and the draft behind it; **J4 adds the
 * brief's budget cap, the payment plan and its invoices, and the bodies of
 * sensitive articles** — published and draft — and feedback about any of them
 * (`visibleItem`). One function for every money field, so no field can decide
 * for itself who counts.
 */
export function mayReadMoney(user: Viewer, c: { customerId: string }): boolean {
  return c.customerId === user.id || can(user, 'money.read');
}

/**
 * An article's body (PD-14, J4): withheld when the article is `sensitive` — its
 * prose is about money — and the viewer may not read the contract's money. The
 * title and number are never withheld: that the article exists is not the
 * secret.
 */
export function mayReadArticleBody(user: Viewer, c: { customerId: string }, article: { sensitive: boolean }): boolean {
  return !article.sensitive || mayReadMoney(user, c);
}

/**
 * Whose email and phone a viewer may read (J3 review). `User` rows reach
 * customers through several edges — a contract's designer and developer, a
 * comment's author — and until this rule each carried the staff member's
 * email and phone to the customer. Contact details are for the account
 * itself and for the staff who work with accounts: contract readers, and
 * whoever manages customers, staff or the Review Room's corpus. Customers,
 * contributors and reviewers see no one's but their own.
 *
 * Checked on the `User` field itself, not per edge, so a later edge that
 * returns a `User` cannot reopen it.
 */
export function mayReadContactOf(viewer: Viewer, target: { id: string }): boolean {
  if (viewer.id === target.id) return true;
  return (
    isContractReader(viewer) ||
    can(viewer, 'customers.manage') ||
    can(viewer, 'staff.manage') ||
    // The Review Room's corpus admin lists its reviewers' emails (ReviewAdmin).
    can(viewer, 'review.admin')
  );
}

/**
 * Whether a comment on a feedback item is shown to this viewer (journeys build
 * plan S2, PD-4): **the customer projection.** A contract reader — sales, and
 * the designer and developer working it — sees every comment, pending and
 * declined answers included; anyone else sees the customer's own comments and
 * the staff answers that have reached them (`NOT_REQUIRED`, `APPROVED`).
 *
 * Asked of `viewerOf(ctx)`, never of the signed-in user, so it holds under
 * view-as-customer without a branch: sales looking as the customer is asked
 * about the customer, and a pending answer stays invisible to them.
 */
export function visibleComment(comment: { approval: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DECLINED' }, viewer: Viewer): boolean {
  return isContractReader(viewer) || comment.approval === 'NOT_REQUIRED' || comment.approval === 'APPROVED';
}

/**
 * PD-21: feedback about money — anchored to the budget, the payment plan or a
 * sensitive article — is itself about money, and a designer answering it would
 * read the numbers in the customer's own words. So it is hidden from any staff
 * viewer without `money.read`: the queue, the step panel, the attention module.
 * The customer always sees their own (`mayReadMoney`), and so does whoever
 * holds `money.read`, which is also who can answer it (SALES, ADMIN).
 */
export function visibleItem(
  item: { briefField: string | null; articleSensitive?: boolean },
  viewer: Viewer,
  contract: { customerId: string },
): boolean {
  return !isMoneyAnchored(item) || mayReadMoney(viewer, contract);
}
