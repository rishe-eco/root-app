import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { createLocalStorage } from './storage.js';

const root = await mkdtemp(join(tmpdir(), 'root-storage-'));
after(() => rm(root, { recursive: true, force: true }));

const storage = createLocalStorage(root, 'https://example.com/public-files');

describe('keys', () => {
  test('are dated, sharded, and named by uuid rather than by the upload', async () => {
    const key = await storage.put('PRIVATE', Buffer.from('x'), '.png');
    assert.match(key, /^private\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  test('the visibility prefix is first, so Nginx can serve public by path alone', async () => {
    assert.ok((await storage.put('PUBLIC', Buffer.from('x'), '.pdf')).startsWith('public/'));
    assert.ok((await storage.put('PRIVATE', Buffer.from('x'), '.png')).startsWith('private/'));
  });

  test('two uploads of identical bytes do not collide', async () => {
    const a = await storage.put('PRIVATE', Buffer.from('same'), '.png');
    const b = await storage.put('PRIVATE', Buffer.from('same'), '.png');
    assert.notEqual(a, b);
  });
});

describe('reading back', () => {
  test('round-trips the exact bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const key = await storage.put('PRIVATE', bytes, '.png');
    assert.deepEqual(await readFile(storage.path(key)), bytes);
    assert.ok(await storage.exists(key));
  });

  test('exists() is false for a key that was never written', async () => {
    assert.equal(await storage.exists('private/2026/01/nope.png'), false);
  });

  test('remove() is idempotent — deleting twice is not an error', async () => {
    const key = await storage.put('PRIVATE', Buffer.from('x'), '.png');
    await storage.remove(key);
    await storage.remove(key);
    assert.equal(await storage.exists(key), false);
  });
});

describe('paths cannot escape STORAGE_DIR', () => {
  test('traversal is refused rather than clamped', () => {
    for (const key of ['../outside.png', 'private/../../etc/passwd', '../../..']) {
      assert.throws(() => storage.path(key), /escapes STORAGE_DIR/);
    }
  });

  test('an absolute key is refused too', () => {
    assert.throws(() => storage.path('/etc/passwd'), /escapes STORAGE_DIR/);
  });

  test('a legitimate key resolves inside the root', () => {
    const full = storage.path('private/2026/08/abc.png');
    assert.ok(isAbsolute(full));
    assert.ok(full.startsWith(root));
  });
});

describe('url()', () => {
  test('builds a public URL from a public key', async () => {
    const key = await storage.put('PUBLIC', Buffer.from('%PDF-'), '.pdf');
    assert.equal(storage.url(key), `https://example.com/public-files/${key.slice('public/'.length)}`);
  });

  /** The interface must make the unsafe thing impossible, not merely unlikely:
   *  a private file with a guessable public URL is the whole failure. */
  test('refuses to build one for a private key', async () => {
    const key = await storage.put('PRIVATE', Buffer.from('x'), '.png');
    assert.throws(() => storage.url(key), /private key/);
  });
});

describe('writes are atomic', () => {
  test('no .part files are left behind on success', async () => {
    const key = await storage.put('PRIVATE', Buffer.from('x'), '.png');
    const { readdir } = await import('node:fs/promises');
    const dir = storage.path(key).replace(/\/[^/]+$/, '');
    assert.equal((await readdir(dir)).some((f) => f.endsWith('.part')), false);
  });
});
