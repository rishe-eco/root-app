import { GraphQLError } from 'graphql';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import {
  canAuthorBuildOnAnyPhase,
  canAuthorBuildOnPhase,
  canAuthorDesign,
  contractVisibleTo,
  contractVisibleToStaff,
  projectVisibleToStaff,
} from '../../lib/visibility.js';

/**
 * The authoring guards that need a row, not just a capability (journeys build
 * plan S1): design work on a contract, and build work on a phase or a project.
 * `lib/visibility.ts` decides; this file loads what it needs and turns "no"
 * into the right code.
 *
 * **Why two codes.** A contract the caller cannot see at all is `NOT_FOUND`
 * (house rule 13 — "no such thing", never "not allowed"). A contract they
 * *can* see but are not assigned to is `NOT_ASSIGNED`: the desk has just
 * shown it to them, so `NOT_FOUND` would be a lie they can see through, and
 * the true answer tells them what to do about it — ask sales to assign them.
 *
 * Order: the capability first, so someone without it gets `FORBIDDEN`
 * whatever row they name, rather than learning which ids exist.
 */

export async function requireDesignAuthorOn(ctx: Context, contractId: string): Promise<User> {
  const user = requireCapability(ctx, 'design.author');
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { customerId: true, publishedAt: true, status: true, deliveredAt: true, designerId: true, project: { select: { status: true } } },
  });
  if (!contract || !contractVisibleTo(user, contract)) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!canAuthorDesign(user, contract)) {
    throw new GraphQLError('You are not the designer of this contract.', {
      extensions: { code: 'NOT_ASSIGNED' },
    });
  }
  return user;
}

/**
 * The developer surface's view of a demo: a **SITE** demo, with its phase.
 *
 * Journeys build plan J9 made `Demo.phaseId` nullable — a `MOCKUP` demo has
 * no phase, and the database says so (`Demo_site_has_phase_and_url`: a SITE
 * demo always has one). Every `builds.author` mutation on a demo reads its
 * phase (for the assignment edge and for the contract it returns), so this is
 * the one place that turns "no phase" into an answer instead of a null
 * dereference or a `!` that would hide it: a MOCKUP demo is not on this
 * surface at all, and "no such demo" is the honest reply — a designer's
 * mockup is authored through J9b's own mutations, under `design.author`.
 *
 * Returns the demo with `phase` and `phaseId` narrowed to non-null, so a
 * caller reads `demo.phase.projectId` exactly as it did before J9.
 */
export function siteDemo<T extends { phase: unknown; phaseId: string | null }>(
  demo: T,
): Omit<T, 'phase' | 'phaseId'> & { phase: NonNullable<T['phase']>; phaseId: string } {
  if (!demo.phase || demo.phaseId === null) {
    throw new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });
  }
  return { ...demo, phase: demo.phase, phaseId: demo.phaseId } as Omit<T, 'phase' | 'phaseId'> & {
    phase: NonNullable<T['phase']>;
    phaseId: string;
  };
}

/**
 * Build work on one phase (journeys build plan J4): a phase belongs to a
 * contract, so the claim is that contract's own developer — `canAuthorBuildOnPhase`.
 * The staff half of visibility only: a customer is never a build author, so
 * the project's own customer edge must not count here.
 */
export async function requireBuildAuthorOnPhase(ctx: Context, phaseId: string): Promise<User> {
  const user = requireCapability(ctx, 'builds.author');
  const phase = await prisma.phase.findUnique({
    where: { id: phaseId },
    select: { contract: { select: { status: true, deliveredAt: true, developerId: true, project: { select: { status: true } } } } },
  });
  if (!phase || !contractVisibleToStaff(user, phase.contract)) {
    throw new GraphQLError('No such phase.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!canAuthorBuildOnPhase(user, phase.contract)) {
    throw new GraphQLError('You are not the developer of this phase.', {
      extensions: { code: 'NOT_ASSIGNED' },
    });
  }
  return user;
}

/**
 * The project-level guard for the developer's queue reads — the caller has a
 * claim on at least one of the project's phases (`canAuthorBuildOnAnyPhase`).
 * The reads themselves are then narrowed to the phases the caller holds
 * (`buildPhaseScope`), so a project with two contracts and two developers gives
 * each of them their own queue.
 */
export async function requireBuildAuthorOnProject(ctx: Context, projectId: string): Promise<User> {
  const user = requireCapability(ctx, 'builds.author');
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      contracts: { select: { status: true, deliveredAt: true } },
      phases: { select: { contract: { select: { status: true, deliveredAt: true, developerId: true } } } },
    },
  });
  // The staff half only: a customer is never a build author, so the
  // project's own customer edge must not count as visibility here.
  if (!project || !projectVisibleToStaff(user, project)) {
    throw new GraphQLError('No such project.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!canAuthorBuildOnAnyPhase(user, project.phases.map((p) => p.contract))) {
    throw new GraphQLError('You are not the developer of this project.', {
      extensions: { code: 'NOT_ASSIGNED' },
    });
  }
  return user;
}

/**
 * The phases a build author works, as a `where` on `Phase` — every phase for
 * `assignments.override`, otherwise those whose contract the caller develops
 * and that are not discarded. What the developer's queue reads filter by, so
 * the queue and the guards above agree about whose work a phase is.
 */
export function buildPhaseScope(user: User): Prisma.PhaseWhereInput {
  if (can(user, 'assignments.override')) return {};
  return { contract: { developerId: user.id, status: { not: 'DISCARDED' }, deliveredAt: null } };
}
