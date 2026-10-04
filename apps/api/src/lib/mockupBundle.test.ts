import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yazl from 'yazl';

import { validateBundle } from './mockupBundle.js';
import { UploadError } from './files.js';

// ---------------------------------------------------------------------------
// Fixture building. No binary fixtures are committed (the stage brief's
// instruction) — every zip here is built in-process with yazl, then, for the
// handful of shapes yazl itself refuses to construct (a real zip attacker
// would not be so polite), patched byte-for-byte afterwards. Each patch has
// its own comment on exactly which bytes it is touching and why.
// ---------------------------------------------------------------------------

const tmpRoot = await mkdtemp(join(tmpdir(), 'root-mockup-bundle-'));
after(() => rm(tmpRoot, { recursive: true, force: true }));
let fixtureCounter = 0;

/** Drains a yazl ZipFile's output stream into a single Buffer. */
function zipToBuffer(build: (zip: yazl.ZipFile) => void): Promise<Buffer> {
  const zipfile = new yazl.ZipFile();
  build(zipfile);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zipfile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.end();
  });
}

async function writeFixture(buffer: Buffer): Promise<string> {
  const path = join(tmpRoot, `bundle-${fixtureCounter++}.zip`);
  await writeFile(path, buffer);
  return path;
}

/** Builds a zip with yazl and writes it straight to a temp file — the path
 *  every case that yazl itself is willing to construct (it will not write an
 *  absolute path, a ".." segment, or a backslash; see `renamedFixture` for
 *  those). */
async function fixture(build: (zip: yazl.ZipFile) => void): Promise<string> {
  return writeFixture(await zipToBuffer(build));
}

/**
 * Rewrites one entry's name in both the local file header and the central
 * directory record, after yazl has already written a well-formed zip under a
 * same-length placeholder name.
 *
 * yazl's own `validateMetadataPath` refuses an absolute path, a ".."
 * segment, and (after silently normalizing it) a backslash — exactly the
 * shapes this module exists to catch, which makes yazl unable to construct
 * them directly. A hostile zip is under no such obligation, so the fixture
 * has to be built the same way an attacker's tooling would produce one: write
 * a valid entry, then edit the name bytes in the archive itself. Keeping the
 * placeholder the same byte length as the real name means no other offset in
 * either header has to move.
 */
function renameEntry(zipBuffer: Buffer, placeholder: string, actualName: string): Buffer {
  assert.equal(placeholder.length, actualName.length, 'fixture bug: renamed entry must keep the same byte length');
  const patched = Buffer.from(zipBuffer);
  const from = Buffer.from(placeholder, 'ascii');
  const to = Buffer.from(actualName, 'ascii');
  let at = patched.indexOf(from);
  let replacements = 0;
  while (at >= 0) {
    to.copy(patched, at);
    replacements++;
    at = patched.indexOf(from, at + from.length);
  }
  // The name appears once in the local file header and once in the central
  // directory record — anything less means the rewrite missed one of them.
  assert.ok(replacements >= 2, `expected the placeholder in both zip headers, found ${replacements}`);
  return patched;
}

async function renamedFixture(actualName: string): Promise<string> {
  const placeholder = '~'.repeat(actualName.length);
  const buffer = await zipToBuffer((zip) => {
    zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
    zip.addBuffer(Buffer.from('payload'), placeholder);
  });
  return writeFixture(renameEntry(buffer, placeholder, actualName));
}

/**
 * Byte layout (APPNOTE.TXT §4.3.7 local file header, §4.3.12 central
 * directory file header): each record starts with a 4-byte signature
 * (`PK\x03\x04` / `PK\x01\x02`), found here by searching rather than by a
 * fixed offset because the local header precedes the entry's own bytes and
 * the central directory follows every local header. The general-purpose bit
 * flag sits at byte 6 of the local header and byte 8 of the central
 * directory record; the uncompressed-size field sits at byte 22 of the local
 * header and byte 24 of the central directory record. Both copies are
 * patched together — a real unzip tool trusts the central directory, but this
 * module's own error path (a caught exception from yauzl) does not
 * distinguish which copy it read, so both must agree for the fixture to
 * behave like a real bad zip rather than merely a malformed one.
 */
function findHeaders(buffer: Buffer): { lfhAt: number; cdfhAt: number } {
  const lfhAt = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const cdfhAt = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(lfhAt >= 0 && cdfhAt >= 0, 'fixture bug: could not locate zip headers to patch');
  return { lfhAt, cdfhAt };
}

/** Lies about an entry's uncompressed size in both headers, without touching
 *  a single byte of the actual (small) payload — exactly the "declared sizes
 *  in a zip header can lie" gap this module's own comment warns the serving
 *  side about, and the only way to exercise the 200 MB total cap without
 *  materializing 200+ MB in a unit test. */
function withLyingUncompressedSize(zipBuffer: Buffer, fakeSize: number): Buffer {
  const patched = Buffer.from(zipBuffer);
  const { lfhAt, cdfhAt } = findHeaders(patched);
  patched.writeUInt32LE(fakeSize >>> 0, lfhAt + 22);
  patched.writeUInt32LE(fakeSize >>> 0, cdfhAt + 24);
  return patched;
}

/** Sets general-purpose bit 0 (encrypted) in both headers, without actually
 *  encrypting the payload — validateBundle never reads the payload, only the
 *  flag, so this is a faithful fixture for "an encrypted entry" even though
 *  the bytes behind it are plain. */
function withEncryptedFlag(zipBuffer: Buffer): Buffer {
  const patched = Buffer.from(zipBuffer);
  const { lfhAt, cdfhAt } = findHeaders(patched);
  patched.writeUInt16LE(patched.readUInt16LE(lfhAt + 6) | 0x0001, lfhAt + 6);
  patched.writeUInt16LE(patched.readUInt16LE(cdfhAt + 8) | 0x0001, cdfhAt + 8);
  return patched;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof UploadError, `expected an UploadError, got ${String(err)}`);
    return (err as UploadError).code;
  }
  assert.fail('expected validateBundle to refuse this bundle');
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe('BUNDLE_PATH_UNSAFE', () => {
  test('a zip-slip entry ("../x.html") is refused', async () => {
    const path = await renamedFixture('../x.html');
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('an absolute path is refused', async () => {
    const path = await renamedFixture('/abs/evil.html');
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('a drive letter is refused', async () => {
    const path = await renamedFixture('C:evil.html');
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('a backslash path is refused', async () => {
    const path = await renamedFixture('assets\\app.html');
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('a NUL byte in the name is refused', async () => {
    const path = await renamedFixture('index.html\u0000.txt');
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('a symlink entry (Unix external attributes) is refused', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      // S_IFLNK (0o120000) with 0777 permissions — a real symlink's mode.
      zip.addBuffer(Buffer.from('/etc/passwd'), 'link.html', { mode: 0o120777 });
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });

  test('two names equal only after case-folding are refused (a case-insensitive filesystem may serve this later)', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      zip.addBuffer(Buffer.from('a'), 'A.html');
      zip.addBuffer(Buffer.from('b'), 'a.html');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_PATH_UNSAFE');
  });
});

// ---------------------------------------------------------------------------
// Encryption — not named in the plan's text; added here (see the module
// comment for why BUNDLE_PATH_UNSAFE would misname the cause).
// ---------------------------------------------------------------------------

test('BUNDLE_ENCRYPTED_ENTRY: an encrypted entry is refused', async () => {
  const clean = await zipToBuffer((zip) => {
    zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
    zip.addBuffer(Buffer.from('secret'), 'secret.js');
  });
  const path = await writeFixture(withEncryptedFlag(clean));
  assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_ENCRYPTED_ENTRY');
});

// ---------------------------------------------------------------------------
// Size and entry-count caps
// ---------------------------------------------------------------------------

describe('BUNDLE_TOO_LARGE', () => {
  test('a zip bomb — an entry whose compression ratio is absurd — is refused', async () => {
    // Five megabytes of zeros compresses to a few kilobytes under DEFLATE,
    // comfortably past the 100:1 cap and nowhere near needing 200 MB of
    // uncompressed total to prove the point.
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      zip.addBuffer(Buffer.alloc(5 * 1024 * 1024, 0), 'bomb.txt');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TOO_LARGE');
  });

  test('a total-size breach is refused, from the declared size alone', async () => {
    // The actual payload is a few bytes; only the header's own claim about
    // its uncompressed size is lied about, exactly the gap this module's
    // comment warns the serving side about.
    const clean = await zipToBuffer((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      zip.addBuffer(Buffer.from('tiny'), 'huge.txt', { compress: false });
    });
    const path = await writeFixture(withLyingUncompressedSize(clean, 300 * 1024 * 1024));
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TOO_LARGE');
  });

  test('a stored entry whose two size fields disagree is treated as a lying header, not trusted', async () => {
    const clean = await zipToBuffer((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      zip.addBuffer(Buffer.from('tiny'), 'stored.txt', { compress: false });
    });
    // A modest lie this time — small enough that it would not itself breach
    // the 200 MB total — isolating that this is caught by the
    // stored-method-sizes-must-match rule, not by the total cap.
    const path = await writeFixture(withLyingUncompressedSize(clean, 10 * 1024 * 1024));
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TOO_LARGE');
  });
});

test('BUNDLE_TOO_MANY_FILES: more than 2,000 entries is refused', async () => {
  const path = await fixture((zip) => {
    zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
    for (let i = 0; i < 2001; i++) {
      zip.addBuffer(Buffer.from('x'), `f${i}.txt`);
    }
  });
  assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TOO_MANY_FILES');
});

// ---------------------------------------------------------------------------
// The extension allowlist
// ---------------------------------------------------------------------------

test('BUNDLE_TYPE_REFUSED: an extension outside the allowlist is refused', async () => {
  const path = await fixture((zip) => {
    zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
    zip.addBuffer(Buffer.from('MZ'), 'payload.exe');
  });
  assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TYPE_REFUSED');
});

// ---------------------------------------------------------------------------
// index.html and the root prefix
// ---------------------------------------------------------------------------

describe('BUNDLE_NO_INDEX', () => {
  test('no index.html anywhere is refused', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'about.html');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_NO_INDEX');
  });

  test('two top-level folders, neither the root, is refused', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'folder1/index.html');
      zip.addBuffer(Buffer.from('body{}'), 'folder2/app.css');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_NO_INDEX');
  });

  test('an empty zip is refused', async () => {
    const path = await fixture(() => {
      // no entries at all
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_NO_INDEX');
  });
});

test('a single top-level folder containing index.html succeeds, and its prefix is computed', async () => {
  const path = await fixture((zip) => {
    zip.addEmptyDirectory('site/assets'); // directories are fine — no extension to refuse
    zip.addBuffer(Buffer.from('<html></html>'), 'site/index.html');
    zip.addBuffer(Buffer.from('body{}'), 'site/assets/app.css');
  });
  const result = await validateBundle(path);
  assert.equal(result.rootPrefix, 'site/');
  assert.equal(result.entries.size, 2);
  assert.equal(result.entries.get('index.html'), 'site/index.html');
  assert.equal(result.entries.get('assets/app.css'), 'site/assets/app.css');
  // The directory entry itself is not something the serving side ever
  // resolves a request to, so it is not in the returned map.
  assert.ok(![...result.entries.keys()].some((k) => k.endsWith('/')));
});

// ---------------------------------------------------------------------------
// The Finder zip (J9b): `__MACOSX/` beside the top folder is ignored
// ---------------------------------------------------------------------------

describe('a top-level __MACOSX/ folder', () => {
  test('is ignored: a Finder-made zip of one folder validates, and nothing of __MACOSX is servable', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'site/index.html');
      zip.addBuffer(Buffer.from('body{}'), 'site/css/app.css');
      // What Finder writes: an AppleDouble fork per file — an allowed extension over non-image bytes,
      // and a .DS_Store that would otherwise be BUNDLE_TYPE_REFUSED.
      zip.addBuffer(Buffer.from([0x00, 0x05, 0x16, 0x07]), '__MACOSX/site/._index.html');
      zip.addBuffer(Buffer.from([0x00, 0x05, 0x16, 0x07]), '__MACOSX/site/css/._app.css');
      zip.addBuffer(Buffer.from([0x00, 0x05, 0x16, 0x07]), '__MACOSX/._site');
      zip.addBuffer(Buffer.from([0x00]), '__MACOSX/.DS_Store');
    });
    const result = await validateBundle(path);
    assert.equal(result.rootPrefix, 'site/');
    assert.deepEqual([...result.entries.keys()].sort(), ['css/app.css', 'index.html']);
    assert.ok([...result.entries.values()].every((name) => !name.startsWith('__MACOSX')), 'no fork is in the served map');
  });

  test('is ignored beside a root index.html too', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      zip.addBuffer(Buffer.from([0x00]), '__MACOSX/._index.html');
    });
    const result = await validateBundle(path);
    assert.equal(result.rootPrefix, '');
    assert.deepEqual([...result.entries.keys()], ['index.html']);
  });

  test('is still read: its entries count toward the entry cap', async () => {
    const many = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
      for (let i = 0; i < 2000; i += 1) zip.addBuffer(Buffer.from('x'), `__MACOSX/._${i}.txt`);
    });
    assert.equal(await codeOf(validateBundle(many)), 'BUNDLE_TOO_MANY_FILES');
  });

  test('alone it is nothing: a zip with only __MACOSX/ still has no index', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from([0x00]), '__MACOSX/._index.html');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_NO_INDEX');
  });

  test('only the top-level folder is ignored: a nested __MACOSX/ is an ordinary folder, extension-checked', async () => {
    const path = await fixture((zip) => {
      zip.addBuffer(Buffer.from('<html></html>'), 'site/index.html');
      zip.addBuffer(Buffer.from([0x00]), 'site/__MACOSX/.DS_Store');
    });
    assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_TYPE_REFUSED');
  });
});

// ---------------------------------------------------------------------------
// Non-zip and unreadable input
// ---------------------------------------------------------------------------

test('BUNDLE_UNREADABLE: a file that is not a zip at all is refused', async () => {
  const path = join(tmpRoot, `bundle-${fixtureCounter++}.zip`);
  await writeFile(path, Buffer.from('this is not a zip file, just some bytes'));
  assert.equal(await codeOf(validateBundle(path)), 'BUNDLE_UNREADABLE');
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a well-formed bundle with index.html at the root validates', async () => {
  const path = await fixture((zip) => {
    zip.addBuffer(Buffer.from('<html></html>'), 'index.html');
    zip.addBuffer(Buffer.from('body{}'), 'css/app.css');
    zip.addBuffer(Buffer.from('console.log(1)'), 'js/app.js');
    zip.addBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'img/logo.png');
  });
  const result = await validateBundle(path);
  assert.equal(result.rootPrefix, '');
  assert.deepEqual(
    [...result.entries.keys()].sort(),
    ['css/app.css', 'img/logo.png', 'index.html', 'js/app.js'],
  );
  assert.equal(result.entries.get('index.html'), 'index.html');
});
