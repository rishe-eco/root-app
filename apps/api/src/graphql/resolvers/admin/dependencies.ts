import { GraphQLError } from 'graphql';
import type { Dependency, DependencySide, User } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../../context.js';
import { can } from '../../../lib/capabilities.js';
import { verificationRequiresNote } from '../../../lib/dependency.js';
import { assertProjectActive, reloadOnProject } from './shared.js';

/**
 * The dependency board (build plan L5; spec §7) — symmetric commitments,
 * customer-side and Root-side, one board under one rule. Part of the admin
 * barrel. Since journeys build plan S1, writing the board is
 * `contracts.author` (what is owed, by whom, by when is part of the
 * agreement). **Marking a row met is routed by `Dependency.technical`** (J4): a
 * technical row — the domain, the hosting — is verified by the developer
 * (`dependencies.verifyTechnical`, and only on a project they develop), every
 * other row by sales (`dependencies.verifyGeneral`). A row the step-1 brief
 * created (`briefKey`) is the brief's: it cannot be deleted from here
 * (`BRIEF_OWNED`) — change the brief instead. It returns `Contract!` (T9 in
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

export const dependencyMutations = {
  /** `side` names who owes it — CUSTOMER or ROOT, the same board, the same
   *  rule. Root's own commitments are created and tracked exactly like a
   *  customer's, on purpose (spec §7's symmetry: this must not become
   *  something that can only nag the customer). */
  createDependency: async (
    _p: unknown,
    args: { projectId: string; side: DependencySide; titleFa: string; titleEn: string; dueAt: string; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const project = await prisma.project.findUnique({ where: { id: args.projectId } });
    if (!project) throw notFound('project');
    // A request has no commitments to track (J2).
    await assertProjectActive(project.id);

    await prisma.dependency.create({
      data: {
        projectId: project.id,
        side: args.side,
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        dueAt: new Date(args.dueAt),
        createdById: user.id,
      },
    });
    return reloadOnProject(project.id, args.contractId);
  },

  updateDependency: async (
    _p: unknown,
    args: { dependencyId: string; titleFa: string; titleEn: string; dueAt: string; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { titleFa: args.titleFa, titleEn: args.titleEn, dueAt: new Date(args.dueAt) },
    });
    return reloadOnProject(dep.projectId, args.contractId);
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
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');
    // The brief owns this row (J4): deleting it here would be undone by the next
    // save of the brief and would leave the brief claiming a commitment the
    // board does not hold. Change the brief instead.
    if (dep.briefKey !== null) {
      throw new GraphQLError('This commitment comes from the requirements — change the requirements instead.', {
        extensions: { code: 'BRIEF_OWNED' },
      });
    }

    const projectId = dep.projectId;
    await prisma.dependency.delete({ where: { id: dep.id } });
    return reloadOnProject(projectId, args.contractId);
  },
};
