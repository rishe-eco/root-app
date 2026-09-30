import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundaryOf, receiveFilePart } from './multipartStream.js';
import { UploadError } from './files.js';

const tmpRoot = await mkdtemp(join(tmpdir(), 'root-multipart-'));
after(() => rm(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const destination = () => join(tmpRoot, `part-${counter++}.bin`);

const BOUNDARY = 'xX-boundary-Xx';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** A multipart body the way a browser writes one: optional other fields, then the file. */
function body(
  file: Buffer,
  opts: { filename?: string; field?: string; before?: string[]; preamble?: string; epilogue?: string } = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from(opts.preamble ?? '')];
  for (const value of opts.before ?? []) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${opts.field ?? 'file'}"; filename="${opts.filename ?? 'bundle.zip'}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n${opts.epilogue ?? ''}`),
  );
  return Buffer.concat(parts);
}

async function* chunked(data: Buffer, sizes: number[]): AsyncGenerator<Buffer> {
  let at = 0;
  let i = 0;
  while (at < data.length) {
    const size = sizes[i++ % sizes.length];
    yield data.subarray(at, at + size);
    at += size;
  }
}

const OPTIONS = { field: 'file', maxFileBytes: 1024 * 1024, maxBodyBytes: 2 * 1024 * 1024 };

/** Bytes that contain the boundary's own leading characters, to tempt a naive search. */
const AWKWARD = Buffer.concat([
  Buffer.from('PK\x03\x04'),
  Buffer.from(`\r\n--${BOUNDARY.slice(0, 6)}\r\n-`),
  Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}`),
  Buffer.from('\r\n\r\n\r\n--\r\n'),
  Buffer.alloc(300, 0x7f),
]);

describe('boundaryOf', () => {
  test('reads a bare and a quoted boundary', () => {
    assert.equal(boundaryOf('multipart/form-data; boundary=abc123'), 'abc123');
    assert.equal(boundaryOf('multipart/form-data; boundary="a b:c"'), 'a b:c');
    assert.equal(boundaryOf('Multipart/Form-Data;Boundary=zz'), 'zz');
  });

  test('a content type with no boundary is malformed', () => {
    assert.throws(() => boundaryOf('multipart/form-data'), (e: unknown) => e instanceof UploadError && e.code === 'MALFORMED_UPLOAD');
  });
});

describe('receiveFilePart', () => {
  test('writes the file field to disk and reports its name, size and first bytes', async () => {
    const file = Buffer.from('PK\x03\x04 hello, mockup');
    const dest = destination();
    const result = await receiveFilePart(chunked(body(file), [1 << 20]), CONTENT_TYPE, { ...OPTIONS, destination: dest });
    assert.equal(result.filename, 'bundle.zip');
    assert.equal(result.bytes, file.length);
    assert.deepEqual(result.head, file.subarray(0, 8));
    assert.deepEqual(await readFile(dest), file);
  });

  test('finds the boundary however the network happens to cut the body — every chunk size from 1 to 40', async () => {
    const full = body(AWKWARD, { before: ['a note', 'another'], preamble: 'ignored preamble\r\n' });
    for (let size = 1; size <= 40; size += 1) {
      const dest = destination();
      const result = await receiveFilePart(chunked(full, [size]), CONTENT_TYPE, { ...OPTIONS, destination: dest });
      assert.equal(result.bytes, AWKWARD.length, `chunk size ${size}`);
      assert.deepEqual(await readFile(dest), AWKWARD, `chunk size ${size}`);
    }
  });

  test('irregular chunk sizes, including a delimiter split across three chunks', async () => {
    const full = body(AWKWARD);
    for (const sizes of [[3, 1, 7], [13, 2], [64, 1, 1, 1], [5]]) {
      const dest = destination();
      await receiveFilePart(chunked(full, sizes), CONTENT_TYPE, { ...OPTIONS, destination: dest });
      assert.deepEqual(await readFile(dest), AWKWARD, sizes.join(','));
    }
  });

  test('an empty file part is an empty file, and the caller decides that is refused', async () => {
    const dest = destination();
    const result = await receiveFilePart(chunked(body(Buffer.alloc(0)), [7]), CONTENT_TYPE, { ...OPTIONS, destination: dest });
    assert.equal(result.bytes, 0);
    assert.equal((await stat(dest)).size, 0);
  });

  test('fields before the file are skipped, not stored', async () => {
    const dest = destination();
    const file = Buffer.from('PK\x03\x04data');
    const result = await receiveFilePart(chunked(body(file, { before: ['x'.repeat(5000)] }), [100]), CONTENT_TYPE, {
      ...OPTIONS,
      destination: dest,
    });
    assert.equal(result.bytes, file.length);
    assert.deepEqual(await readFile(dest), file);
  });

  test('a file over maxFileBytes is refused FILE_TOO_LARGE partway through, and the request is not destroyed', async () => {
    let pulled = 0;
    let returned = false;
    const source: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        const inner = chunked(body(Buffer.alloc(200_000, 1)), [4096]);
        return {
          async next() {
            const r = await inner.next();
            if (!r.done) pulled += r.value.length;
            return r;
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await assert.rejects(
      receiveFilePart(source, CONTENT_TYPE, { ...OPTIONS, maxFileBytes: 10_000, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'FILE_TOO_LARGE' && e.status === 413,
    );
    assert.ok(pulled < 40_000, `read ${pulled} bytes after the cap — it should have stopped near it`);
    // for-await would call return() and destroy a real request's socket; the
    // 413 has to travel on that socket.
    assert.equal(returned, false);
  });

  test('a body over maxBodyBytes is refused even when the file field is small', async () => {
    await assert.rejects(
      receiveFilePart(chunked(body(Buffer.from('PK\x03\x04'), { epilogue: 'e'.repeat(50_000) }), [1000]), CONTENT_TYPE, {
        ...OPTIONS,
        maxBodyBytes: 10_000,
        destination: destination(),
      }),
      (e: unknown) => e instanceof UploadError && e.code === 'FILE_TOO_LARGE',
    );
  });

  test('a refused upload leaves its partial file to the caller, closed, not a dangling descriptor', async () => {
    const dest = destination();
    await assert.rejects(
      receiveFilePart(chunked(body(Buffer.alloc(50_000, 2)), [4096]), CONTENT_TYPE, { ...OPTIONS, maxFileBytes: 5000, destination: dest }),
    );
    // Closed: the caller can remove it (on Windows an open handle would make this fail).
    await rm(dest, { force: true });
    await assert.rejects(stat(dest));
  });

  test('a body with no file field is NO_FILE', async () => {
    await assert.rejects(
      receiveFilePart(chunked(body(Buffer.from('x'), { field: 'other' }), [9]), CONTENT_TYPE, { ...OPTIONS, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'NO_FILE',
    );
  });

  test('two file fields are malformed — one upload, one file', async () => {
    const two = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\nAAA\r\n`),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\n\r\nBBB\r\n--${BOUNDARY}--\r\n`),
    ]);
    await assert.rejects(
      receiveFilePart(chunked(two, [11]), CONTENT_TYPE, { ...OPTIONS, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'MALFORMED_UPLOAD',
    );
  });

  test('a truncated body (no closing delimiter) is malformed', async () => {
    const cut = body(Buffer.from('PK\x03\x04abcdef')).subarray(0, -12);
    await assert.rejects(
      receiveFilePart(chunked(cut, [8]), CONTENT_TYPE, { ...OPTIONS, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'MALFORMED_UPLOAD',
    );
  });

  test('a body that is not multipart at all is malformed', async () => {
    await assert.rejects(
      receiveFilePart(chunked(Buffer.from('{"json":true}'), [4]), CONTENT_TYPE, { ...OPTIONS, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'MALFORMED_UPLOAD',
    );
  });

  test('a header block that never ends is refused rather than accumulated', async () => {
    const endless = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n${'X-Pad: y\r\n'.repeat(3000)}`);
    await assert.rejects(
      receiveFilePart(chunked(endless, [512]), CONTENT_TYPE, { ...OPTIONS, destination: destination() }),
      (e: unknown) => e instanceof UploadError && e.code === 'MALFORMED_UPLOAD',
    );
  });

  test('a Persian filename comes through intact', async () => {
    const dest = destination();
    const result = await receiveFilePart(chunked(body(Buffer.from('PK\x03\x04'), { filename: 'ماکاپ نسخه ۲.zip' }), [10]), CONTENT_TYPE, {
      ...OPTIONS,
      destination: dest,
    });
    assert.equal(result.filename, 'ماکاپ نسخه ۲.zip');
  });

  test('never overwrites: the destination is opened exclusively', async () => {
    const dest = destination();
    await receiveFilePart(chunked(body(Buffer.from('one')), [50]), CONTENT_TYPE, { ...OPTIONS, destination: dest });
    await assert.rejects(receiveFilePart(chunked(body(Buffer.from('two')), [50]), CONTENT_TYPE, { ...OPTIONS, destination: dest }));
    assert.equal((await readFile(dest)).toString(), 'one');
  });
});
