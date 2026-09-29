import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { reload } from '../contracts.js';

/**
 * Small helpers shared across the admin mutation groups (build plan L1's
 * mechanical split of the former `admin.ts`, 951 lines and rising). Nothing
 * here changed behaviour when it moved — see `index.ts` for the barrel that
 * keeps `adminMutations`'s exported shape identical to before the split.
 */

export function requireDraft(publishedAt: Date | null): void {
  if (publishedAt !== null) {
    throw new GraphQLError('That revision is published and cannot be edited.', {
      extensions: { code: 'REVISION_PUBLISHED' },
    });
  }
}

/**
 * Both publish mutations read `max(version)` and write `version + 1` inside
 * their transaction; two concurrent publishes hit `@@unique([contractId,
 * version])`, which is the protection working as intended. Left alone, that
 * surfaces to the caller as `DUPLICATE_KEY` ("something with that key
 * already exists"), which is unreadable in context — this rewrites it to
 * something a person can act on. Checked structurally rather than by
 * importing Prisma's error class, matching `lib/logging.ts`'s own P2002
 * handling.
 */
export function asConcurrentPublish(err: unknown): unknown {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
    return new GraphQLError('Someone else published while you were working — reload and try again.', {
      extensions: { code: 'CONCURRENT_PUBLISH' },
    });
  }
  return err;
}

/**
 * Turns an uploaded file id into the pair of columns a concept or page stores,
 * refusing anything that is not this contract's own design image.
 *
 * The contract check is the one that matters. Upload records who owns a file;
 * without this, an admin could attach customer A's file to customer B's
 * contract, and the serving route — which authorises by the file's *own*
 * contract — would then refuse to show B an image sitting on B's page. The
 * wrong-looking half of that is the broken image; the real half is that A's
 * private design would be named on someone else's contract.
 *
 * A null id clears both columns, which is how an image is removed.
 */
export async function resolveDesignImage(
  fileId: string | null | undefined,
  contractId: string,
): Promise<{ imageUrl: string | null; imageFileId: string | null }> {
  if (!fileId) return { imageUrl: null, imageFileId: null };

  const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!file || file.class !== 'DESIGN_IMAGE' || file.contractId !== contractId) {
    throw new GraphQLError('No such file.', { extensions: { code: 'NOT_FOUND' } });
  }
  return { imageUrl: `/files/${file.id}`, imageFileId: file.id };
}

/**
 * Which contract a project-scoped mutation hands back — and every other place
 * a project has to be turned into *one* of its contracts.
 *
 * **Why this is three functions and not one.** Until J2 a project had exactly
 * one contract, so "the project's contract" was a fact and `firstContractId`
 * could state it. J2 lets a second contract attach to an ACTIVE project (the
 * founder's Q5: "a feature for an existing website" is a new contract on the
 * existing project), and now "the project's contract" is three different
 * questions with three different right answers. The old helper answered all
 * of them with "the earliest", which is right for none of them once there are
 * two, so it is gone and each question has its own name:
 *
 * - **Which contract is the caller looking at?** — `contractOnProject`, below.
 *   The desk's workspace is open on one contract; the mutation returns
 *   `Contract!` so Apollo's cache stays consistent (T9 in V2.md), and that must
 *   be *the contract the caller has open*, or the scope list they just edited
 *   refreshes on a sibling contract and not on their screen. Only the caller
 *   knows, so every such mutation takes an optional `contractId`.
 * - **Which contract does a notification link to?** — `linkContractId`. Nobody
 *   is looking at anything; the recipient will open whatever we point at.
 * - **Which contract opened this project?** — `primaryContractId`. Only for
 *   callers that genuinely mean "the first", and the fallback when a caller
 *   that cannot know (a script, an API token) names none.
 */
export async function primaryContractId(projectId: string): Promise<string> {
  const contract = await prisma.contract.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!contract) {
    throw new GraphQLError('This project has no contract yet.', { extensions: { code: 'NO_CONTRACT' } });
  }
  return contract.id;
}

/**
 * The contract a project-scoped mutation returns: the one the caller named,
 * checked to be on this project, or — when none is named — the project's first
 * (`primaryContractId`), which is what every caller before J2 got and is
 * still exact for a project with one contract.
 *
 * A contract that is not on this project is `NOT_FOUND` rather than quietly
 * ignored: a caller that names a contract of another project has a bug, and
 * returning it would hand back a contract the mutation never touched — which,
 * for a customer-callable mutation, would also be a read of someone else's.
 */
export async function contractOnProject(projectId: string, named?: string | null): Promise<string> {
  if (!named) return primaryContractId(projectId);
  const contract = await prisma.contract.findFirst({ where: { id: named, projectId }, select: { id: true } });
  if (!contract) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  return contract.id;
}

/** `reload(await contractOnProject(...))` — the last line of every project-scoped mutation. */
export async function reloadOnProject(projectId: string, named?: string | null) {
  return reload(await contractOnProject(projectId, named));
}

/**
 * The contract a notification about this project's *work* (a demo, a build, a
 * piece of feedback) links to. Nothing on a demo, a phase or a build says
 * which contract it belongs to until J4 puts `Phase.contractId` on phases, so
 * this is a policy, not a lookup: **the newest contract that is still alive**,
 * because work on a project with two contracts is, in the overwhelming case,
 * work on the newer one.
 *
 * The customer's link has to open, and a customer only opens a *published*
 * contract (`contractVisibleTo`) — so for a customer the newest published one
 * wins, and an unpublished draft never does. The staff link has no such
 * constraint. Either falls back to `primaryContractId` rather than failing:
 * this runs after the act it announces has already happened.
 */
export async function linkContractId(projectId: string, audience: 'customer' | 'staff'): Promise<string> {
  const alive = await prisma.contract.findFirst({
    where: {
      projectId,
      status: { not: 'DISCARDED' },
      ...(audience === 'customer' ? { publishedAt: { not: null } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return alive?.id ?? primaryContractId(projectId);
}

/**
 * A request has no registry, phases, demos or commitments — it is a
 * conversation (J2). The project-scoped mutations that take a bare
 * `projectId` refuse one that is not `ACTIVE`, rather than growing rows on a
 * project nobody is working.
 */
export async function assertProjectActive(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (!project) {
    throw new GraphQLError('No such project.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (project.status !== 'ACTIVE') {
    throw new GraphQLError('That project is not active.', { extensions: { code: 'PROJECT_NOT_ACTIVE' } });
  }
}
