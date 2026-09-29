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
  project?: { status: ProjectStatus } | null;
};

/**
 * Still being worked: not discarded, on an active project. The plan's third
 * clause — not yet delivered — arrives with `Contract.deliveredAt` in J11;
 * until then it is absent, not false, so every undelivered contract passes.
 *
 * A contract with no project reads as active: `projectId` is nullable only
 * as a migration artefact (L1), and J2 makes it NOT NULL. Treating the
 * artefact as "inactive" would hide a live contract from its designer.
 */
export function isActiveContract(c: Pick<ContractForVisibility, 'status' | 'project'>): boolean {
  if (c.status === 'DISCARDED') return false;
  if (c.project && c.project.status !== 'ACTIVE') return false;
  return true;
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
 * on a project's demos is "developer of any contract on it" — and a project
 * has exactly one contract today (L1's `firstContractId`), so this is the
 * same answer as the contract's, stated so it survives a second contract.
 */
export function canAuthorBuildOnProject(user: Viewer, contracts: Array<{ developerId: string | null }>): boolean {
  if (!can(user, 'builds.author')) return false;
  if (can(user, 'assignments.override')) return true;
  return contracts.some((c) => c.developerId === user.id);
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
 * PD-14, the part S1 cannot leave for J4: the moment design and development
 * can read active contracts, the fee on those contracts is one field away.
 * The customer always reads their own; staff read it only with `money.read`.
 * J4 extends the same rule to the brief's budget, the payment plan and the
 * bodies of sensitive articles — this is the function they will call.
 */
export function mayReadMoney(user: Viewer, c: { customerId: string }): boolean {
  return c.customerId === user.id || can(user, 'money.read');
}
