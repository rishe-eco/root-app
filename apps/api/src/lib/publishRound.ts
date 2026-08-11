import type { Block } from './revision.js';
import { isSafeRepoPath, splitBlocks } from './reviewBlocks.js';

/**
 * The pure half of `prisma/publish-round.ts` — everything that does not
 * itself shell out to git, factored out so it can be unit-tested without a
 * real repository. `readFile` is the seam: the real CLI implements it with
 * `git show <sha>:<path>`, returning `null` when the path does not exist at
 * that sha; a test can fake that with a plain object.
 */

export type ManifestEntry = { path: string; title: string };
export type Manifest = { documents: ManifestEntry[] };

export function parseManifest(raw: string): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The manifest is not valid JSON.');
  }
  const documents = (data as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) {
    throw new Error('The manifest must have a "documents" array.');
  }
  for (const entry of documents) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Each manifest entry must be an object.');
    }
    const { path, title } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || typeof title !== 'string' || !path.trim() || !title.trim()) {
      throw new Error('Each manifest entry needs a non-empty string "path" and "title".');
    }
  }
  return { documents: documents as ManifestEntry[] };
}

export type RoundDocument = { path: string; title: string; order: number; blocks: Block[] };

/**
 * Reads and splits every allowlisted document. **A path the manifest names
 * that does not exist at the frozen sha fails the whole round**, thrown
 * before anything is sent — a partially published round is a corpus with a
 * hole a reviewer cannot see and will not ask about (C1.md §3.1).
 */
export function buildRoundDocuments(manifest: Manifest, readFile: (path: string) => string | null): RoundDocument[] {
  return manifest.documents.map((entry, order) => {
    if (!isSafeRepoPath(entry.path)) {
      throw new Error(`Refusing an unsafe path in the manifest: "${entry.path}".`);
    }
    const text = readFile(entry.path);
    if (text === null) {
      throw new Error(
        `The manifest names "${entry.path}", which does not exist at this sha. Refusing to publish any of this round.`,
      );
    }
    return { path: entry.path, title: entry.title, order, blocks: splitBlocks(text) };
  });
}
