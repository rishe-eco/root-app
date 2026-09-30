import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yazl from 'yazl';

import {
  __clearBundleCacheForTests,
  bundleFor,
  contentTypeFor,
  entryRequestFor,
  injectReporter,
  isHtml,
  mockupHeaders,
  openEntry,
  reporterTag,
} from './mockupServe.js';

const APP = 'https://app.m-root.com';
const TAG = reporterTag(APP);

describe('entryRequestFor — a request path as a key in the bundle', () => {
  test('the root and any directory path serve that directory\'s index.html', () => {
    assert.deepEqual(entryRequestFor('/'), { key: 'index.html', directory: true });
    assert.deepEqual(entryRequestFor(''), { key: 'index.html', directory: true });
    assert.deepEqual(entryRequestFor('/docs/'), { key: 'docs/index.html', directory: true });
  });

  test('a file path is its own key; the leading slash is not part of it', () => {
    assert.deepEqual(entryRequestFor('/about.html'), { key: 'about.html', directory: false });
    assert.deepEqual(entryRequestFor('/css/app.css'), { key: 'css/app.css', directory: false });
  });

  test('doubled slashes and dot segments collapse', () => {
    assert.deepEqual(entryRequestFor('//css//./app.css'), { key: 'css/app.css', directory: false });
  });

  test('percent-encoding is decoded exactly once — a Persian file name is found, a double-encoded traversal is only a strange name', () => {
    assert.deepEqual(entryRequestFor('/%D8%AE%D8%A7%D9%86%D9%87.html'), { key: 'خانه.html', directory: false });
    assert.deepEqual(entryRequestFor('/%252e%252e/secret.html'), { key: '%2e%2e/secret.html', directory: false });
  });

  test('a traversal, a backslash, a NUL and broken escapes are refused outright', () => {
    for (const bad of ['/../etc/passwd', '/a/../../b', '/%2e%2e/x', '/a\\b', '/a%5Cb', '/a%00b', '/%E0%A4%A']) {
      assert.equal(entryRequestFor(bad), null, bad);
    }
  });
});

describe('contentTypeFor', () => {
  test('every extension the bundle validator allows has a type; unknown ones are opaque', () => {
    const expected: Record<string, string> = {
      'a.html': 'text/html; charset=utf-8',
      'a.css': 'text/css; charset=utf-8',
      'a.js': 'text/javascript; charset=utf-8',
      'a.mjs': 'text/javascript; charset=utf-8',
      'a.json': 'application/json; charset=utf-8',
      'a.png': 'image/png',
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.webp': 'image/webp',
      'a.gif': 'image/gif',
      'a.svg': 'image/svg+xml',
      'a.ico': 'image/x-icon',
      'a.woff': 'font/woff',
      'a.woff2': 'font/woff2',
      'a.ttf': 'font/ttf',
      'a.otf': 'font/otf',
      'a.mp4': 'video/mp4',
      'a.webm': 'video/webm',
      'a.txt': 'text/plain; charset=utf-8',
      'DIR/A.HTML': 'text/html; charset=utf-8',
      'noext': 'application/octet-stream',
      'a.exe': 'application/octet-stream',
    };
    for (const [key, type] of Object.entries(expected)) assert.equal(contentTypeFor(key), type, key);
    assert.equal(isHtml('x/index.html'), true);
    assert.equal(isHtml('x/app.js'), false);
  });
});

describe('injectReporter', () => {
  const inject = (html: string) => injectReporter(Buffer.from(html), TAG).toString();

  test('goes before </head>', () => {
    assert.equal(
      inject('<html><head><title>t</title></head><body>x</body></html>'),
      `<html><head><title>t</title>${TAG}</head><body>x</body></html>`,
    );
  });

  test('with no </head>, goes before </body>', () => {
    assert.equal(inject('<html><body>x</body></html>'), `<html><body>x${TAG}</body></html>`);
  });

  test('with neither, goes at the end', () => {
    assert.equal(inject('<p>just a fragment'), `<p>just a fragment${TAG}`);
  });

  test('matches the closing tags case-insensitively and tolerates whitespace in them', () => {
    assert.equal(inject('<HEAD></HEAD >'), `<HEAD>${TAG}</HEAD >`);
    assert.equal(inject('<BODY></BODY>'), `<BODY>${TAG}</BODY>`);
  });

  test('uses the first </head> and the last </body>', () => {
    assert.equal(inject('<head></head><script>"</head>"</script>'), `<head>${TAG}</head><script>"</head>"</script>`);
    assert.equal(inject('<body><script>"</body>"</script></body>'), `<body><script>"</body>"</script>${TAG}</body>`);
  });

  test('leaves every other byte alone — Persian text in UTF-8 and in Windows-1256 survives untouched', () => {
    const utf8 = Buffer.from('<head><meta charset="utf-8"></head><body>سلام دنیا ۱۲۳</body>');
    const out = injectReporter(utf8, TAG);
    assert.equal(out.toString(), `<head><meta charset="utf-8">${TAG}</head><body>سلام دنیا ۱۲۳</body>`);

    // Bytes that are not valid UTF-8 at all (0xE1 0xE3 is "لم" in Windows-1256).
    const legacy = Buffer.concat([Buffer.from('<head></head><body>'), Buffer.from([0xe1, 0xe3, 0xff, 0x80]), Buffer.from('</body>')]);
    const legacyOut = injectReporter(legacy, TAG);
    const at = legacyOut.indexOf(Buffer.from(TAG));
    assert.ok(at > 0);
    assert.deepEqual(Buffer.concat([legacyOut.subarray(0, at), legacyOut.subarray(at + TAG.length)]), legacy);
  });

  test('the tag names the reporter path and the portal origin as its target', () => {
    assert.equal(
      TAG,
      '<script src="/__root/reporter.js" data-enabled="true" data-root-origin="https://app.m-root.com"></script>',
    );
  });
});

describe('mockupHeaders', () => {
  test('are the plan\'s, exactly, with the portal as the only frame ancestor', () => {
    const h = mockupHeaders(APP);
    assert.equal(
      h['Content-Security-Policy'],
      "frame-ancestors https://app.m-root.com; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'none'",
    );
    assert.equal(h['Referrer-Policy'], 'no-referrer');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
  });

  test('never include a cookie', () => {
    assert.equal(Object.keys(mockupHeaders(APP)).some((k) => k.toLowerCase() === 'set-cookie'), false);
  });
});

describe('reading a stored bundle', () => {
  const tmp = mkdtemp(join(tmpdir(), 'root-mockup-serve-'));
  after(async () => rm(await tmp, { recursive: true, force: true }));

  async function zipFile(entries: Record<string, string | Buffer>): Promise<string> {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
      zip.outputStream.on('end', () => resolve());
      zip.outputStream.on('error', reject);
    });
    zip.end();
    await done;
    const path = join(await tmp, `b-${Math.random().toString(36).slice(2)}.zip`);
    await writeFile(path, Buffer.concat(chunks));
    return path;
  }

  const read = async (path: string, name: string) => {
    const opened = await openEntry(path, name);
    if (!opened) return null;
    const chunks: Buffer[] = [];
    for await (const c of opened.stream) chunks.push(c as Buffer);
    return { size: opened.size, body: Buffer.concat(chunks).toString() };
  };

  test('streams one entry out of the archive, and says how big it is', async () => {
    const path = await zipFile({ 'index.html': '<h1>hi</h1>', 'css/app.css': 'body{}' });
    assert.deepEqual(await read(path, 'css/app.css'), { size: 6, body: 'body{}' });
    assert.deepEqual(await read(path, 'index.html'), { size: 11, body: '<h1>hi</h1>' });
  });

  test('an entry the archive does not have is null, not an error', async () => {
    const path = await zipFile({ 'index.html': 'x' });
    assert.equal(await read(path, 'nope.html'), null);
  });

  test('bundleFor validates once per storage key and caches the name map', async () => {
    __clearBundleCacheForTests();
    const path = await zipFile({ 'site/index.html': 'x', 'site/a.css': 'y' });
    const first = await bundleFor('k1', path);
    assert.equal(first.rootPrefix, 'site/');
    assert.deepEqual([...first.entries.keys()].sort(), ['a.css', 'index.html']);
    // Same key: the same object, without reading the file again — proven by a
    // path that no longer exists.
    assert.equal(await bundleFor('k1', join(await tmp, 'gone.zip')), first);
  });

  test('a bundle that fails to read is not remembered as failed', async () => {
    __clearBundleCacheForTests();
    const missing = join(await tmp, 'not-yet.zip');
    await assert.rejects(bundleFor('k2', missing));
    const real = await zipFile({ 'index.html': 'x' });
    // Same key, now readable.
    assert.ok((await bundleFor('k2', real)).entries.has('index.html'));
  });
});
