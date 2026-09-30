/**
 * Reads a mockup bundle's zip **central directory** and decides whether it is
 * safe to accept — before a single byte of it is extracted, streamed, or
 * pointed at by a URL (build plan J9, PD-9, PD-16).
 *
 * `yauzl` opens a zip by seeking to the End Of Central Directory record and
 * reading the central directory that follows, which is what makes this cheap
 * even for a 200 MB upload: nothing here decompresses an entry's actual
 * bytes. That is also this module's hard limit — see "What this cannot see"
 * below.
 *
 * **Why `strictFileNames: true`.** yauzl already contains exactly the zip-slip
 * guard this file would otherwise have to re-write: `validateFileName()`
 * refuses a leading `/`, a drive letter (`C:`), a `..` path segment, and (only
 * under `strictFileNames`) a backslash. With `strictFileNames` left at its
 * default (`false`), a backslash is silently rewritten to a forward slash
 * before that check runs — accommodating a real .NET bug, per yauzl's own
 * README — which would make this file's own "refuse a backslash path" test
 * unobservable: by the time an entry reaches this code the backslash would
 * already be gone. Turning `strictFileNames` on trades that accommodation for
 * an explicit refusal instead, which is what house rule 3 (one rule, one
 * file) and this stage's brief both want: yauzl's own check does the zip-slip
 * work, this file does not reimplement it, and every offending entry ends the
 * whole read (`ZipFile#eachEntry()` rejects) rather than being silently
 * repaired.
 *
 * **What this cannot see.** The central directory's `uncompressedSize` and
 * `compressedSize` are the entry's own claims about itself — nothing here
 * decompresses to confirm them, and a crafted local file header can disagree
 * with the central directory's copy of the same fields. That is exactly the
 * gap this validator cannot close by reading the central directory harder:
 * **the serving side (J9, later) that actually streams an entry's bytes must
 * cap how many bytes it reads per entry against the declared size and refuse
 * to read past it, rather than trusting the central directory's number as a
 * guarantee of what decompression will actually produce.** This module's total
 * and per-entry ratio caps are a front-door filter against a bundle that is
 * gross about it, not a substitute for that streaming-side cap.
 *
 * **Other things a hostile central directory can try, and why they are
 * already covered:**
 *   - *Many small entries instead of one big one* — the entry-count cap
 *     bounds this regardless of any single entry's size.
 *   - *A handful of entries with an extreme compression ratio rather than one
 *     enormous one* — the per-entry ratio cap catches each on its own; it
 *     does not wait for the running total to look large.
 *   - *A stored (uncompressed) entry whose two size fields disagree* — for
 *     `compressionMethod === 0` they are defined to be equal; this file
 *     treats any mismatch as a lying header and folds it into the same ratio
 *     check (a zero-or-mismatched `compressedSize` reads as an infinite
 *     ratio).
 *   - *A central directory that lies about its own entry count or offsets* —
 *     left to yauzl's own EOCD/central-directory parser, which is what
 *     PD-16 names this dependency for; this file does not re-verify offsets
 *     it never dereferences.
 *   - *A "quine"-style self-referential archive, or nesting* — only a risk to
 *     something that extracts or recursively opens entries; this file does
 *     neither.
 */

import * as yauzl from 'yauzl';
import type { Entry } from 'yauzl';

import { UploadError } from './files.js';

/** J9's "Logic" section, verbatim. */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * The compression-ratio cap for a single entry (this file's own choice — J9
 * says "pick the cap, justify it").
 *
 * DEFLATE's own worst case (all-zero input) tops out around 1032:1; real
 * mockup assets — HTML, CSS, JS, and already-compressed images — essentially
 * never clear 10:1. A cap of 100:1 sits comfortably above every legitimate
 * asset this bundle will ever contain and comfortably below the theoretical
 * ceiling, so it catches a bomb (or a bomblet — see the module comment on why
 * this is checked per entry, not only on the running total) without ever
 * being a plausible false positive on real content.
 */
const MAX_COMPRESSION_RATIO = 100;

/**
 * The folder macOS's Finder adds beside whatever it zips (journeys build plan
 * J9b; J9a's owed item). "Compress" on a folder `site/` writes `site/…` **and**
 * `__MACOSX/site/._index.html` — AppleDouble resource forks, one per file, which
 * nobody authored and no browser will ever ask for. Left in, they fail the bundle
 * twice over: `__MACOSX` is a second top-level folder (`BUNDLE_NO_INDEX`, which
 * reads to a designer as "my index.html is right there"), and `._photo.jpg` is a
 * name with an allowed extension and bytes that are not an image.
 *
 * **Decided: ignore it, do not refuse it.** Refusing with a message is the right
 * call for anything a designer could have meant, and this is the one thing every
 * designer on a Mac produces without meaning anything; a refusal would teach them
 * to zip from a terminal. The entries are still *read* — they count toward the
 * entry and size caps and are checked for unsafe names and symlinks, because
 * ignoring what a hostile zip puts under this name would be a hole with a
 * friendly label — and then dropped: not in `entries`, so the router can never
 * serve one, and not in the top-level-folder count that decides the root. Only
 * the **top-level** folder is ignored; `site/__MACOSX/` is an ordinary folder with
 * ordinary (extension-checked) contents.
 */
const IGNORED_TOP_LEVEL = '__MACOSX';

/**
 * What a mockup bundle's entries may be — J9's "Logic" section, verbatim.
 * Directories are exempt (checked separately): a folder has no extension to
 * refuse.
 */
const ALLOWED_EXTENSIONS = new Set([
  'html',
  'css',
  'js',
  'mjs',
  'json',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp4',
  'webm',
  'txt',
]);

export type ValidatedBundle = {
  /**
   * The single top-level folder that contains the bundle's `index.html`,
   * written with a trailing slash — or `''` when `index.html` sits at the
   * zip's own root. Every key in `entries` has already had this prefix
   * removed, so the serving side never has to know it existed.
   */
  rootPrefix: string;
  /**
   * Every safely-nameable file entry (directories excluded — there is
   * nothing to serve for one), keyed by its normalized path **relative to
   * `rootPrefix`** — what an incoming request path is compared against —
   * mapped to the zip entry's own name, which is what the serving side reopens
   * to stream that entry's bytes.
   */
  entries: Map<string, string>;
};

/**
 * Reads `zipPath`'s central directory and either returns what the serving
 * side needs, or throws an `UploadError` carrying one of this module's
 * `BUNDLE_*` codes — the same shape `lib/files.ts` already gives every other
 * upload refusal, reused rather than duplicated (house rule 3) because J9's
 * upload route surfaces these codes unchanged; there is no second place that
 * would otherwise have to translate one shape into the other.
 */
export async function validateBundle(zipPath: string): Promise<ValidatedBundle> {
  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await yauzl.openPromise(zipPath, { strictFileNames: true });
  } catch (err) {
    // Anything from "this is not a zip at all" to a truncated or malformed
    // central directory lands here. None of J9's named codes fit "unreadable
    // as a zip" — it is not oversized, not path-unsafe, not a bad extension,
    // and not merely missing an index — so this file adds one, consistent
    // with the others in shape (a typed `BUNDLE_*` refusal) if not in name.
    throw new UploadError(
      400,
      'BUNDLE_UNREADABLE',
      `That file could not be read as a zip archive: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  let entryCount = 0;
  let totalUncompressedBytes = 0;
  const seenNormalizedLower = new Set<string>();
  const files: Array<{ normalizedPath: string; entryName: string; isDirectory: boolean }> = [];

  try {
    for await (const entry of zipfile.eachEntry()) {
      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        throw new UploadError(
          413,
          'BUNDLE_TOO_MANY_FILES',
          `That bundle has more than ${MAX_ENTRIES} entries.`,
        );
      }

      // `strictFileNames: true` has already refused (by rejecting this whole
      // iteration, from inside yauzl) any entry with a leading "/", a drive
      // letter, a ".." segment, or a backslash — see the module comment.
      // What is left to this file: a NUL byte (not a path-syntax question
      // yauzl's own check covers), an encrypted entry, a symlink, an entry
      // whose name collides with another once case-folded, the extension
      // allowlist, and the size/ratio caps.
      if (entry.fileName.includes('\0')) {
        throw new UploadError(
          400,
          'BUNDLE_PATH_UNSAFE',
          `Entry "${entry.fileName}" contains a NUL byte in its name.`,
        );
      }

      // General-purpose bit 0. J9's text does not name this case; a mockup
      // whose central directory the serving side cannot even confirm the
      // shape of without the (never-collected) decryption key is refused for
      // the same reason as every other case in this file — it cannot be
      // safely served — but it is not itself a path or size problem, so
      // `BUNDLE_PATH_UNSAFE` would misname the cause to whoever reads the
      // code back later. `BUNDLE_ENCRYPTED_ENTRY` says exactly what was
      // found.
      if (entry.isEncrypted()) {
        throw new UploadError(
          400,
          'BUNDLE_ENCRYPTED_ENTRY',
          `Entry "${entry.fileName}" is encrypted; this bundle cannot be served without its password.`,
        );
      }

      if (isSymlinkEntry(entry)) {
        throw new UploadError(
          400,
          'BUNDLE_PATH_UNSAFE',
          `Entry "${entry.fileName}" is a symlink, which this bundle format does not allow.`,
        );
      }

      const isDirectory = entry.fileName.endsWith('/');
      const normalizedPath = normalizeEntryPath(entry.fileName);
      const ignored = normalizedPath.split('/')[0] === IGNORED_TOP_LEVEL;
      const lowerKey = normalizedPath.toLowerCase();
      if (seenNormalizedLower.has(lowerKey)) {
        throw new UploadError(
          400,
          'BUNDLE_PATH_UNSAFE',
          `"${entry.fileName}" collides with another entry once case is ignored — the serving side may run on a case-insensitive filesystem.`,
        );
      }
      seenNormalizedLower.add(lowerKey);

      if (!isDirectory) {
        totalUncompressedBytes += entry.uncompressedSize;
        if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          throw new UploadError(
            413,
            'BUNDLE_TOO_LARGE',
            `That bundle is more than ${MAX_TOTAL_UNCOMPRESSED_BYTES / (1024 * 1024)} MB uncompressed.`,
          );
        }
        if (exceedsCompressionRatio(entry)) {
          throw new UploadError(
            413,
            'BUNDLE_TOO_LARGE',
            `Entry "${entry.fileName}" compresses at more than ${MAX_COMPRESSION_RATIO}:1 — refused as a likely zip bomb.`,
          );
        }

        const extension = extensionOf(normalizedPath);
        if (!ignored && !ALLOWED_EXTENSIONS.has(extension)) {
          throw new UploadError(
            415,
            'BUNDLE_TYPE_REFUSED',
            `"${entry.fileName}" is not one of the accepted file types for a mockup bundle.`,
          );
        }
      }

      if (!ignored) files.push({ normalizedPath, entryName: entry.fileName, isDirectory });
    }
  } catch (err) {
    // `eachEntry()`'s own promise rejects with a plain Error for anything
    // `strictFileNames` refused (see the module comment) — everything thrown
    // above is already an UploadError and passes straight through.
    if (err instanceof UploadError) throw err;
    throw new UploadError(
      400,
      'BUNDLE_PATH_UNSAFE',
      `That bundle contains an unsafe entry name: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  const rootPrefix = findRootPrefix(files);
  if (rootPrefix === null) {
    throw new UploadError(
      400,
      'BUNDLE_NO_INDEX',
      'That bundle has no index.html at its root, and no single top-level folder containing one.',
    );
  }

  const entries = new Map<string, string>();
  for (const file of files) {
    if (file.isDirectory) continue;
    entries.set(file.normalizedPath.slice(rootPrefix.length), file.entryName);
  }

  return { rootPrefix, entries };
}

/**
 * Unix-only: the top 16 bits of `externalFileAttributes` carry `st_mode` when
 * `versionMadeBy`'s host-OS byte says the entry was made on Unix (3) or macOS
 * (19, Darwin) — the two hosts a designer's zip is plausible to have been
 * built on, and the only ones that give symlinks this shape at all. `S_IFLNK`
 * is `0o120000`; masking to the top 4 bits of the 16-bit mode and comparing
 * against it is the standard test, same as `(stat.mode & S_IFMT) === S_IFLNK`
 * in C.
 */
function isSymlinkEntry(entry: Entry): boolean {
  const hostOs = entry.versionMadeBy >> 8;
  if (hostOs !== 3 && hostOs !== 19) return false;
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

/**
 * A lying or degenerate size pair reads as an infinite ratio rather than a
 * division by zero: a `compressedSize` of 0 paired with any real
 * `uncompressedSize` is not a real compressed stream (the smallest possible
 * DEFLATE output for non-empty input is never zero bytes), and for a stored
 * entry (`compressionMethod === 0`) the two sizes are defined to be equal —
 * anything else is the header lying about what it is, which is exactly the
 * "declared sizes can lie" case the module comment warns the serving side
 * about, and just as refusable here as a real bomb.
 */
function exceedsCompressionRatio(entry: Entry): boolean {
  if (entry.uncompressedSize === 0) return false;
  if (entry.compressedSize === 0) return true;
  if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) return true;
  return entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO;
}

/**
 * Collapses `.` segments and empty segments (from a directory's trailing
 * slash, or a stray doubled slash) out of an already-slash-only, already-
 * traversal-free name (yauzl's `strictFileNames` guard ran first). This is
 * normalization for comparison, not a safety check on its own — the safety
 * checks already happened before this is called.
 */
function normalizeEntryPath(fileName: string): string {
  const segments = fileName.split('/').filter((s) => s.length > 0 && s !== '.');
  const isDirectory = fileName.endsWith('/');
  return segments.join('/') + (isDirectory ? '/' : '');
}

function extensionOf(normalizedPath: string): string {
  const base = normalizedPath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  // No dot, or a dot with nothing after it (e.g. "README."): no extension,
  // which is not in the allowlist either — an extensionless asset is not
  // part of the shapes J9 names.
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * `null` means "refuse" (`BUNDLE_NO_INDEX`) — the caller turns that into the
 * typed error; every other return is the prefix to strip (`''` for a root
 * `index.html`).
 */
function findRootPrefix(files: Array<{ normalizedPath: string; isDirectory: boolean }>): string | null {
  const hasRootIndex = files.some((f) => !f.isDirectory && f.normalizedPath === 'index.html');
  if (hasRootIndex) return '';

  const topLevelSegments = new Set(files.map((f) => f.normalizedPath.split('/')[0]).filter((s) => s.length > 0));
  if (topLevelSegments.size !== 1) return null;

  const [folder] = topLevelSegments;
  const nestedIndex = `${folder}/index.html`;
  const hasNestedIndex = files.some((f) => !f.isDirectory && f.normalizedPath === nestedIndex);
  return hasNestedIndex ? `${folder}/` : null;
}
