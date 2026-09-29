import type { ContractStatus, ProjectStatus, User } from '@prisma/client';
import { can } from './capabilities.js';

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
  if (can(user, 'contracts.readAll')) return true;
  if (can(user, 'contracts.readActive') && isActiveContract(c)) return true;
  return c.customerId === user.id && c.publishedAt !== null;
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
 * Projects hold demos, phases and builds; contracts hold assignees. Until
 * J4 puts a contract on each phase (`Phase.contractId`), a developer's claim
 * on a project's demos is "developer of any contract on it".
 *
 * Since J2 a project can hold a second contract (a new feature for an
 * existing site), so "any" is a real choice rather than a restatement: both
 * contracts' developers may work the shared demos. A **discarded** contract's
 * developer may not — the contract is dead, and a project that has moved on
 * to a second contract with a different developer must not leave the first
 * one holding the keys.
 */
export function canAuthorBuildOnProject(
  user: Viewer,
  contracts: Array<{ developerId: string | null; status: ContractStatus }>,
): boolean {
  if (!can(user, 'builds.author')) return false;
  if (can(user, 'assignments.override')) return true;
  return contracts.some((c) => c.status !== 'DISCARDED' && c.developerId === user.id);
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
 * proposed in the draft and frozen at approval (J7). A customer sees them once
 * the agreement is approved — the moment they stop being a proposal — and not
 * before; staff readers see them always, since the draft is theirs.
 */
export function mayReadPlannedDates(user: Viewer, agreementApproved: boolean): boolean {
  return isContractReader(user) || agreementApproved;
}

/**
 * PD-14, the part S1 cannot leave for J4: the moment design and development
 * can read active contracts, the fee on those contracts is one field away.
 * The customer always reads their own; staff read it only with `money.read`.
 * J4 extends the same rule to the brief's budget, the payment plan and the
 * bodies of sensitive articles — this is the function they will call.
 */
export function mayReadMoney(user: Viewer, c: { customerId: string }): boolean {
  return c.customerId === user.id || can(user, 'money.read');
}
