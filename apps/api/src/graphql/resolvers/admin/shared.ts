import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';

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
 * Every mutation on a Project-owned object (`ScopeItem`, `Phase`, `Demo`, …)
 * that must still return `Contract!` (T9 in V2.md) picks the project's
 * earliest-created contract to reload — this is exactly right while a
 * project has at most one contract (true of everything L1/L2 create) and is
 * a named, commented shortcut for the day a project has two. First used by
 * L1's registry mutations; L2's phase and demo mutations reuse it rather
 * than growing a second copy (house rule 3). Throws `NO_CONTRACT` rather
 * than guessing if a project somehow has none.
 */
export async function firstContractId(projectId: string): Promise<string> {
  const contract = await prisma.contract.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  if (!contract) {
    throw new GraphQLError('This project has no contract yet.', { extensions: { code: 'NO_CONTRACT' } });
  }
  return contract.id;
}
