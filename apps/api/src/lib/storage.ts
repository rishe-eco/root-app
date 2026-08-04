/**
 * Where bytes live.
 *
 * Local disk, behind an interface — the decision recorded in the build plan
 * §F1. Files sit on the VPS, the public class is served by host Nginx straight
 * off disk, and the private class goes through `routes/files.ts`. Object
 * storage later is a second implementation of `Storage`, not a rewrite.
 *
 * The interface is deliberately four functions and no cleverness. Anything
 * richer — content types, signed URLs, lifecycle rules — is S3's vocabulary,
 * and adopting it now would mean designing for a provider we have not chosen.
 */

import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { env } from './env.js';

/** Mirrors `FileVisibility` in the schema; kept as a string union so this
 *  module does not depend on the Prisma client. */
export type Visibility = 'PRIVATE' | 'PUBLIC';

export type Storage = {
  /** Writes bytes and returns the key they can be read back with. */
  put(visibility: Visibility, data: Buffer, ext: string): Promise<string>;
  /** Where a *public* key is reachable from the browser. Throws for private
   *  keys, which are not addressable without an authorisation check. */
  url(key: string): string;
  /** An open stream for the bytes, for the private-serving route. */
  read(key: string): Readable;
  /** Absolute path on disk. Only for code that must hand a path to the OS. */
  path(key: string): string;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

/**
 * Keys are `<visibility>/<yyyy>/<mm>/<uuid><ext>`.
 *
 * The date segments keep any one directory from growing to a size that makes
 * `ls` and backup tooling miserable; the uuid is the whole filename because
 * the uploaded name is attacker-controlled and is never allowed near a path.
 * The visibility prefix is first so that Nginx can serve `public/` by location
 * match alone and can be pointed at a directory that provably contains nothing
 * private.
 */
function makeKey(visibility: Visibility, ext: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${visibility.toLowerCase()}/${yyyy}/${mm}/${randomUUID()}${ext}`;
}

/** The one function that turns a key into a path, so there is one place that
 *  can be wrong. A key that escapes STORAGE_DIR is refused rather than
 *  clamped — a caller producing one is a bug, not a user typing badly. */
function resolveKey(root: string, key: string): string {
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Storage key escapes STORAGE_DIR: ${key}`);
  }
  return full;
}

export function createLocalStorage(root: string, publicBase: string): Storage {
  const base = resolve(root);

  return {
    async put(visibility, data, ext) {
      const key = makeKey(visibility, ext);
      const full = resolveKey(base, key);
      await mkdir(dirname(full), { recursive: true });

      // Write to a neighbour and rename into place. Rename within a filesystem
      // is atomic, so a reader either sees the whole file or no file — never a
      // half-written image, which is the failure a crash mid-write would
      // otherwise leave behind for good.
      const tmp = `${full}.${randomUUID()}.part`;
      try {
        // Public files are read off disk by host Nginx running as www-data, so
        // they must be world-readable; private ones are read by this process
        // and nothing else, so they are not. Getting this backwards fails in
        // opposite ways — a 403 on every public file, or a private design
        // readable by any account on the box.
        await writeFile(tmp, data, { mode: visibility === 'PUBLIC' ? 0o644 : 0o600 });
        await rename(tmp, full);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return key;
    },

    url(key) {
      if (!key.startsWith('public/')) {
        throw new Error(
          `Refusing to build a public URL for a private key (${key}). ` +
            `Private files are reachable only through GET /files/:id.`,
        );
      }
      return `${publicBase}/${key.slice('public/'.length)}`;
    },

    read(key) {
      return createReadStream(resolveKey(base, key));
    },

    path(key) {
      return resolveKey(base, key);
    },

    async remove(key) {
      await rm(resolveKey(base, key), { force: true });
    },

    async exists(key) {
      try {
        await stat(resolveKey(base, key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const storage = createLocalStorage(env.STORAGE_DIR, env.PUBLIC_FILES_BASE);

/** Called once at boot. Failing here is better than failing on the first
 *  upload, which is the same principle env.ts applies to configuration. */
export async function ensureStorageReady(): Promise<void> {
  const base = resolve(env.STORAGE_DIR);
  // Same reasoning as the file modes in `put`: Nginx has to traverse into
  // public/, and has no business in private/.
  await mkdir(join(base, 'public'), { recursive: true, mode: 0o755 });
  await mkdir(join(base, 'private'), { recursive: true, mode: 0o700 });
}

export { makeKey as __makeKeyForTests, resolveKey as __resolveKeyForTests };
