import { GraphQLError } from 'graphql';
import type { DependencySide } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { verificationRequiresNote } from '../../../lib/dependency.js';
import { reload } from '../contracts.js';
import { firstContractId } from './shared.js';

/**
 * The dependency board (build plan L5; spec §7) — symmetric commitments,
 * customer-side and Root-side, one board under one rule. Part of the admin
 * barrel: every mutation here is `contracts.manage`, matching every other
 * registry-adjacent surface added since L1 (phases, demo frames), and
 * returns `Contract!` via `firstContractId` (T9 in V2.md), reached through
 * `project.dependencies`.
 */

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

export const dependencyMutations = {
  /** `side` names who owes it — CUSTOMER or ROOT, the same board, the same
   *  rule. Root's own commitments are created and tracked exactly like a
   *  customer's, on purpose (spec §7's symmetry: this must not become
   *  something that can only nag the customer). */
  createDependency: async (
    _p: unknown,
    args: { projectId: string; side: DependencySide; titleFa: string; titleEn: string; dueAt: string },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.manage');
    const project = await prisma.project.findUnique({ where: { id: args.projectId } });
    if (!project) throw notFound('project');

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
    return reload(await firstContractId(project.id));
  },

  updateDependency: async (
    _p: unknown,
    args: { dependencyId: string; titleFa: string; titleEn: string; dueAt: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { titleFa: args.titleFa, titleEn: args.titleEn, dueAt: new Date(args.dueAt) },
    });
    return reload(await firstContractId(dep.projectId));
  },

  /**
   * Build plan L5's banked trap, held here structurally before the
   * database's own CHECK (`Dependency_verified_both_or_neither`) would
   * refuse it with a less specific code: "they said we have a host" is what
   * failed at the engagement this is drawn from; "we deployed a test file to
   * the host" is what `note` exists to hold. A blank or whitespace-only note
   * is refused exactly like an absent one.
   */
  verifyDependency: async (_p: unknown, args: { dependencyId: string; note: string }, ctx: Context) => {
    const user = requireCapability(ctx, 'contracts.manage');
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');
    if (!verificationRequiresNote({ note: args.note })) {
      throw new GraphQLError('Say what was actually done to verify it.', {
        extensions: { code: 'VERIFICATION_NOTE_REQUIRED' },
      });
    }

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { verifiedAt: new Date(), verifiedById: user.id, verifiedNote: args.note.trim() },
    });
    return reload(await firstContractId(dep.projectId));
  },

  /** Clears a verification made in error — the same decide/undecide shape
   *  `ScopeItem` already uses (build plan L1), so a wrongly-verified row is
   *  reopened rather than left to lie. */
  unverifyDependency: async (_p: unknown, args: { dependencyId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');

    await prisma.dependency.update({
      where: { id: dep.id },
      data: { verifiedAt: null, verifiedById: null, verifiedNote: null },
    });
    return reload(await firstContractId(dep.projectId));
  },

  deleteDependency: async (_p: unknown, args: { dependencyId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const dep = await prisma.dependency.findUnique({ where: { id: args.dependencyId } });
    if (!dep) throw notFound('dependency');

    const projectId = dep.projectId;
    await prisma.dependency.delete({ where: { id: dep.id } });
    return reload(await firstContractId(projectId));
  },
};
