import { GraphQLError } from 'graphql';
import type { Dependency, DependencySide, Prisma, User } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../../context.js';
import { can } from '../../../lib/capabilities.js';
import { boardRowIsComplete, changesLockedFields, verificationRequiresNote } from '../../../lib/dependency.js';
import { lockContract } from '../../../lib/stepApproval.js';
import { assertStepOpen, stepOnRoad } from '../../../lib/steps.js';
import { wizardStateOn } from '../wizard.js';
import { assertProjectActive, contractOnProject, reloadOnProject } from './shared.js';

/**
 * The dependency board (build plan L5; spec §7) — symmetric commitments,
 * customer-side and Root-side, one board under one rule. Part of the admin
 * barrel. Since journeys build plan S1, writing the board is
 * `contracts.author` (what is owed, by whom, by when is part of the
 * agreement). **Marking a row met is routed by `Dependency.technical`** (J4): a
 * technical row — the domain, the hosting — is verified by the developer
 * (`dependencies.verifyTechnical`, and only on a project they develop), every
 * other row by sales (`dependencies.verifyGeneral`). A row with a `briefKey`
 * (the desk's default list, or an extra's) cannot be deleted from here
 * (`BRIEF_OWNED`) — mark it not needed instead.
 *
 * **DX3a: this board and Requirements' "Who provides what, by when" panel are
 * one set of records** (decision log row 15). A row with `inBrief` is part of
 * the requirements the customer agrees to, and may be undecided (no side) or
 * undated; before the REQUIREMENTS step is locked, a row added here is `inBrief`
 * and shows in Requirements too. After the lock (the agreement approved) an
 * `inBrief` row's side, date, not-needed flag and title cannot change and it
 * cannot be deleted (`STEP_LOCKED`) — marking it delivered still works; a row
 * added after the lock is board-only and needs a side and a date
 * (`DEPENDENCY_INCOMPLETE`), exactly as before. It returns `Contract!` (T9 in
 * V2.md) — the one the caller names with the optional `contractId`, else the
 * project's first (`reloadOnProject`) — reached through `project.dependencies`.
 */

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/**
 * Who may verify (or un-verify) this row — the capability the row's flag names,
 * and for a technical row the ownership edge too (house rule 2, kept separate):
 * being *a* developer is the capability, being *this project's* developer — of
 * a live contract on it — is the edge, `NOT_ASSIGNED` if not.
 * `assignments.override` (ADMIN) is both.
 *
 * The capability is checked before the row is loaded, so someone who holds
 * neither verb learns nothing about which ids exist; the second check needs the
 * row, and answers `FORBIDDEN` (this verb is not yours) rather than `NOT_FOUND`
 * — a staff member holding one verb has just been shown the board row.
 */
function requireEitherVerifyVerb(ctx: Context): User {
  const user = requireUser(ctx);
  if (!can(user, 'dependencies.verifyGeneral') && !can(user, 'dependencies.verifyTechnical')) {
    throw new GraphQLError('You do not have access to that.', { extensions: { code: 'FORBIDDEN' } });
  }
  return user;
}

async function assertMayVerify(user: User, dep: Pick<Dependency, 'projectId' | 'technical'>): Promise<void> {
  const needed = dep.technical ? 'dependencies.verifyTechnical' : 'dependencies.verifyGeneral';
  if (!can(user, needed)) {
    throw new GraphQLError('You do not have access to that.', { extensions: { code: 'FORBIDDEN' } });
  }
  if (dep.technical && !can(user, 'assignments.override')) {
    const theirs = await prisma.contract.count({
      where: { projectId: dep.projectId, developerId: user.id, status: { not: 'DISCARDED' }, deliveredAt: null },
    });
    if (theirs === 0) {
      throw new GraphQLError('You are not the developer of this project.', { extensions: { code: 'NOT_ASSIGNED' } });
    }
  }
}

const incomplete = () =>
  new GraphQLError('A commitment on the board needs a side and a due date.', { extensions: { code: 'DEPENDENCY_INCOMPLETE' } });
const locked = () => new GraphQLError('That step is locked.', { extensions: { code: 'STEP_LOCKED' } });

/**
 * Where the requirements step stands on the contract the caller names, read
 * inside that contract's row lock so it cannot change under the write:
 * `OPEN` (a row is part of the requirements), `LOCKED` (the agreement is
 * approved) or `OFF_ROAD` (a legacy contract has no requirements step).
 */
async function requirementsState(tx: Prisma.TransactionClient, contractId: string): Promise<'OPEN' | 'LOCKED' | 'OFF_ROAD'> {
  await lockContract(tx, contractId);
  const state = await wizardStateOn(contractId, tx);
  if (!stepOnRoad(state.sequence, 'REQUIREMENTS')) return 'OFF_ROAD';
  try {
    assertStepOpen(state, 'REQUIREMENTS', null);
    return 'OPEN';
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions.code === 'STEP_LOCKED') return 'LOCKED';
    throw e;
  }
}

const dayOrNull = (value: string | Date | null | undefined): Date | null => (value ? new Date(value) : null);

export const dependencyMutations = {
  /** `side` names who owes it — CUSTOMER or ROOT, the same board, the same
   *  rule. Root's own commitments are created and tracked exactly like a
   *  customer's, on purpose (spec §7's symmetry: this must not become
   *  something that can only nag the customer).
   *
   *  DX3a: before the requirements are locked the row is `inBrief` — a handover
   *  item that appears in Requirements — and `side` and `dueAt` may be left
   *  out; after, it is board-only and needs both. */
  createDependency: async (
    _p: unknown,
    args: { projectId: string; side?: DependencySide | null; titleFa: string; titleEn: string; dueAt?: string | null; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const project = await prisma.project.findUnique({ where: { id: args.projectId } });
    if (!project) throw notFound('project');
    // A request has no commitments to track (J2).
    await assertProjectActive(project.id);
    const contractId = await contractOnProject(project.id, args.contractId);
    const titleFa = args.titleFa.trim();
    const titleEn = args.titleEn.trim();
    if (!titleFa || !titleEn) throw new GraphQLError('A commitment needs a title in both languages.', { extensions: { code: 'TITLE_REQUIRED' } });

    await prisma.$transaction(async (tx) => {
      const inBrief = (await requirementsState(tx, contractId)) === 'OPEN';
      const side = args.side ?? null;
      const dueAt = dayOrNull(args.dueAt);
      if (!inBrief && !boardRowIsComplete({ side, dueAt })) throw incomplete();
      await tx.dependency.create({
        data: { projectId: project.id, side, titleFa, titleEn, dueAt, inBrief, createdById: user.id },
      });
    });
    return reloadOnProject(project.id, args.contractId);
  },

  /** A replace of what is named: an omitted argument is left as it is, `null`
   *  clears (a side or a date — only a requirements row may be without them). */
  updateDependency: async (
    _p: unknown,
    args: {
      dependencyId: string;
      titleFa?: string | null;
      titleEn?: string | null;
      dueAt?: string | null;
      side?: DependencySide | null;
      notNeeded?: boolean | null;
      contractId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const found = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!found) throw notFound('dependency');
    const contractId = await contractOnProject(found.projectId, args.contractId);

    const edit: { side?: DependencySide | null; dueAt?: Date | null; notNeeded?: boolean; titleFa?: string; titleEn?: string } = {};
    if (args.titleFa != null) edit.titleFa = args.titleFa.trim();
    if (args.titleEn != null) edit.titleEn = args.titleEn.trim();
    if (edit.titleFa === '' || edit.titleEn === '') {
      throw new GraphQLError('A commitment needs a title in both languages.', { extensions: { code: 'TITLE_REQUIRED' } });
    }
    if ('dueAt' in args) edit.dueAt = dayOrNull(args.dueAt);
    if ('side' in args) edit.side = args.side ?? null;
    if (args.notNeeded != null) edit.notNeeded = args.notNeeded;

    await prisma.$transaction(async (tx) => {
      const state = await requirementsState(tx, contractId);
      // Read inside the lock: the row as it is now, not as the page last saw it.
      const dep = await tx.dependency.findUniqueOrThrow({ where: { id: found.id } });
      if (dep.inBrief) {
        if (state === 'LOCKED' && changesLockedFields(dep, edit)) throw locked();
      } else if (!boardRowIsComplete({ side: 'side' in edit ? edit.side : dep.side, dueAt: 'dueAt' in edit ? edit.dueAt : dep.dueAt })) {
        throw incomplete();
      }
      await tx.dependency.update({ where: { id: dep.id }, data: edit });
    });
    return reloadOnProject(found.projectId, args.contractId);
  },

  /**
   * Build plan L5's banked trap, held here structurally before the
   * database's own CHECK (`Dependency_verified_both_or_neither`) would
   * refuse it with a less specific code: "they said we have a host" is what
   * failed at the engagement this is drawn from; "we deployed a test file to
   * the host" is what `note` exists to hold. A blank or whitespace-only note
   * is refused exactly like an absent one.
   */
  verifyDependency: async (_p: unknown, args: { dependencyId: string; note: string; contractId?: string | null }, ctx: Context) => {
    const user = requireEitherVerifyVerb(ctx);
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');
    await assertMayVerify(user, dep);
    if (!verificationRequiresNote({ note: args.note })) {
      throw new GraphQLError('Say what was actually done to verify it.', {
        extensions: { code: 'VERIFICATION_NOTE_REQUIRED' },
      });
    }

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { verifiedAt: new Date(), verifiedById: user.id, verifiedNote: args.note.trim() },
    });
    return reloadOnProject(dep.projectId, args.contractId);
  },

  /** Clears a verification made in error — the same decide/undecide shape
   *  `ScopeItem` already uses (build plan L1), so a wrongly-verified row is
   *  reopened rather than left to lie. */
  unverifyDependency: async (_p: unknown, args: { dependencyId: string; contractId?: string | null }, ctx: Context) => {
    const user = requireEitherVerifyVerb(ctx);
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');
    await assertMayVerify(user, dep);

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { verifiedAt: null, verifiedById: null, verifiedNote: null },
    });
    return reloadOnProject(dep.projectId, args.contractId);
  },

  deleteDependency: async (_p: unknown, args: { dependencyId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const found = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!found) throw notFound('dependency');
    // The default list and the extras own their rows (J4, DX3a): deleting one here
    // would be undone by the next brief and leave Requirements claiming a handover
    // item the board does not hold. Mark it not needed instead.
    if (found.briefKey !== null) {
      throw new GraphQLError('This commitment comes from the requirements — mark it not needed instead.', {
        extensions: { code: 'BRIEF_OWNED' },
      });
    }
    const contractId = await contractOnProject(found.projectId, args.contractId);

    await prisma.$transaction(async (tx) => {
      const state = await requirementsState(tx, contractId);
      const dep = await tx.dependency.findUniqueOrThrow({ where: { id: found.id } });
      // What the customer agreed to is not for deleting; Requirements' lock covers it.
      if (dep.inBrief && state === 'LOCKED') throw locked();
      await tx.dependency.delete({ where: { id: dep.id } });
    });
    return reloadOnProject(found.projectId, args.contractId);
  },
};
