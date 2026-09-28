import { GraphQLError } from 'graphql';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import {
  canAuthorBuildOnProject,
  canAuthorDesign,
  contractVisibleTo,
  projectVisibleToStaff,
} from '../../lib/visibility.js';

/**
 * The two authoring guards that need a row, not just a capability (journeys
 * build plan S1): design work on a contract, and build work on a project.
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
    select: { customerId: true, publishedAt: true, status: true, designerId: true, project: { select: { status: true } } },
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

export async function requireBuildAuthorOnProject(ctx: Context, projectId: string): Promise<User> {
  const user = requireCapability(ctx, 'builds.author');
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      contracts: { select: { status: true, developerId: true } },
    },
  });
  // The staff half only: a customer is never a build author, so the
  // project's own customer edge must not count as visibility here.
  if (!project || !projectVisibleToStaff(user, project)) {
    throw new GraphQLError('No such project.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!canAuthorBuildOnProject(user, project.contracts)) {
    throw new GraphQLError('You are not the developer of this project.', {
      extensions: { code: 'NOT_ASSIGNED' },
    });
  }
  return user;
}
