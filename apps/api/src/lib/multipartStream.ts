/**
 * Receiving **one file field** of a `multipart/form-data` body straight to disk,
 * without ever holding the file in memory (journeys build plan J9, defect D-9).
 *
 * `routes/files.ts` parses every other upload by buffering the whole body and
 * handing it to `Response#formData()` — right at 2–25 MB, and wrong at the 50 MB
 * of a mockup bundle: the collected chunks and the parsed copy would both be
 * alive at once, roughly 100 MB per concurrent upload on a VPS the runbook
 * already warns about. Node has no streaming multipart parser and this stage may
 * not add a dependency (`busboy` would be the usual one), so this is the small
 * one the job needs: exactly one named file field, written to a path the caller
 * chose, the rest of the envelope read and thrown away.
 *
 * **What memory this holds.** A pending buffer that is never longer than one
 * network chunk plus the length of a boundary delimiter. The file goes to a
 * write stream with back-pressure (`write()` returning false pauses the read
 * until `drain`), so a client faster than the disk is slowed by TCP rather than
 * queued in the heap. `multipartStream.test.ts` splits a body at every byte
 * offset to prove the boundary is found however the chunks fall.
 *
 * **What it refuses, and why it does not destroy the request.** The file field
 * larger than `maxFileBytes`, a whole body larger than `maxBodyBytes`, a body
 * that is not shaped like multipart (`MALFORMED_UPLOAD`), a second file field,
 * and a body without the named one (`NO_FILE`). On any of them the caller gets
 * an `UploadError` with the temp file already closed — and the request is
 * **left alone**: `for await`-ing a request and leaving early destroys the
 * socket, and a destroyed socket cannot carry the 413 back. This function
 * therefore drives the iterator by hand and never calls `return()` on it; the
 * caller answers, sends `Connection: close`, and lets the server close the
 * socket after the response.
 *
 * Not a general parser: no `filename*=` (RFC 5987) decoding, no nested
 * multipart, no charset negotiation, no per-part size limits other than the
 * named file. Every part that is not the file is skipped, not read into memory.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';

import { UploadError } from './files.js';

/** Enough for the headers of any part a browser sends; a header block past
 *  this is not a browser's, and is refused rather than accumulated. */
const MAX_HEADER_BYTES = 8 * 1024;

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export type FilePartOptions = {
  /** The field name the file must arrive under (`file`, as every class uses). */
  field: string;
  /** Where the bytes are written. Created with `wx`, so a colliding path is an error, not an overwrite. */
  destination: string;
  /** The file's own limit — refused past it, not truncated. */
  maxFileBytes: number;
  /** The whole request body's limit: the file plus the envelope and any other part. */
  maxBodyBytes: number;
};

export type FilePart = {
  /** The name the client gave the file (its `filename=` parameter), unsanitised — the caller's `safeDownloadName` cleans it. */
  filename: string;
  bytes: number;
  /** The file's first eight bytes, kept so the caller can sniff its type without reopening it. */
  head: Buffer;
};

const malformed = () => new UploadError(400, 'MALFORMED_UPLOAD', 'That upload could not be read.');
const tooLarge = () => new UploadError(413, 'FILE_TOO_LARGE', 'That upload is larger than this kind allows.');

/** The `boundary` parameter of a `multipart/form-data` content type, or a refusal. */
export function boundaryOf(contentType: string): string {
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw malformed();
  return boundary;
}

/** `name` and `filename` out of a part's `Content-Disposition`, or null. */
function parseDisposition(headers: string): { name: string; filename: string | null } | null {
  for (const line of headers.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-disposition') continue;
    const value = line.slice(colon + 1);
    const name = /[;\s]name="((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
    const filename = /[;\s]filename="((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
    if (name === undefined) return null;
    return { name, filename: filename === undefined ? null : filename.replace(/\\(.)/g, '$1') };
  }
  return null;
}

type State = 'PREAMBLE' | 'AFTER_DELIMITER' | 'HEADERS' | 'BODY' | 'DONE';

export async function receiveFilePart(
  source: AsyncIterable<Uint8Array>,
  contentType: string,
  options: FilePartOptions,
): Promise<FilePart> {
  const boundary = boundaryOf(contentType);
  // The first boundary has no CRLF before it, every later one does. Starting
  // with a virtual CRLF lets one delimiter — CRLF, dashes, boundary — find all
  // of them.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const holdBack = delimiter.length - 1;

  // The `as` casts are for the compiler, not the reader: these are assigned
  // inside the closures below, and TypeScript narrows a `let` to its
  // initialiser across function calls — so `state !== 'DONE'` after the loop
  // would be rejected as a comparison that can never be true.
  let state = 'PREAMBLE' as State;
  let pending: Buffer = Buffer.from(CRLF);
  let bodyBytes = 0;

  let sink = null as WriteStream | null;
  let sinkError = null as Error | null;
  let filename = null as string | null;
  let fileBytes = 0;
  let head: Buffer = Buffer.alloc(0);
  let inFile = false as boolean;

  const openSink = () => {
    const stream = createWriteStream(options.destination, { flags: 'wx', mode: 0o600 });
    stream.on('error', (err) => {
      sinkError = err;
    });
    return stream;
  };

  /** Bytes of the current part's body. Only the file's are kept. */
  const emit = async (bytes: Buffer): Promise<void> => {
    if (!inFile || bytes.length === 0) return;
    fileBytes += bytes.length;
    if (fileBytes > options.maxFileBytes) throw tooLarge();
    if (head.length < 8) head = Buffer.concat([head, bytes.subarray(0, 8 - head.length)]);
    if (sinkError) throw sinkError;
    if (!sink!.write(bytes)) await once(sink!, 'drain');
  };

  const closeSink = async (): Promise<void> => {
    if (!sink) return;
    const stream = sink;
    sink = null;
    if (!stream.closed) {
      stream.end();
      await once(stream, 'close');
    }
    if (sinkError) throw sinkError;
  };

  const drive = async (): Promise<void> => {
    for (;;) {
      if (state === 'PREAMBLE') {
        const at = pending.indexOf(delimiter);
        if (at < 0) {
          // Nothing before the first boundary matters; keep only what could be
          // the start of it.
          pending = pending.subarray(Math.max(0, pending.length - holdBack));
          return;
        }
        pending = pending.subarray(at + delimiter.length);
        state = 'AFTER_DELIMITER';
      } else if (state === 'AFTER_DELIMITER') {
        if (pending.length < 2) return;
        if (pending[0] === 0x2d && pending[1] === 0x2d) {
          // "--boundary--": the closing delimiter. Whatever follows is epilogue.
          pending = Buffer.alloc(0);
          state = 'DONE';
        } else if (pending[0] === 0x0d && pending[1] === 0x0a) {
          pending = pending.subarray(2);
          state = 'HEADERS';
        } else {
          throw malformed();
        }
      } else if (state === 'HEADERS') {
        const at = pending.indexOf(HEADER_END);
        if (at < 0) {
          if (pending.length > MAX_HEADER_BYTES) throw malformed();
          return;
        }
        if (at > MAX_HEADER_BYTES) throw malformed();
        const disposition = parseDisposition(pending.subarray(0, at).toString('utf8'));
        pending = pending.subarray(at + HEADER_END.length);
        if (!disposition) throw malformed();
        inFile = disposition.name === options.field && disposition.filename !== null;
        if (inFile) {
          // A second file field would be a second thing to store; one upload,
          // one file.
          if (filename !== null) throw malformed();
          filename = disposition.filename;
          sink = openSink();
        }
        state = 'BODY';
      } else if (state === 'BODY') {
        const at = pending.indexOf(delimiter);
        if (at >= 0) {
          await emit(pending.subarray(0, at));
          pending = pending.subarray(at + delimiter.length);
          if (inFile) await closeSink();
          inFile = false;
          state = 'AFTER_DELIMITER';
        } else {
          // Hold back a delimiter's worth: it may straddle this chunk and the next.
          const safe = pending.length - holdBack;
          if (safe > 0) {
            await emit(pending.subarray(0, safe));
            pending = pending.subarray(safe);
          }
          return;
        }
      } else {
        pending = Buffer.alloc(0);
        return;
      }
    }
  };

  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      bodyBytes += chunk.length;
      if (bodyBytes > options.maxBodyBytes) throw tooLarge();
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      await drive();
    }
    // The body ended. A well-formed one ended in its closing delimiter.
    if (state !== 'DONE') throw malformed();
    if (filename === null) throw new UploadError(400, 'NO_FILE', 'No "file" field in that upload.');
    await closeSink();
  } catch (err) {
    if (sink) {
      const stream: WriteStream = sink;
      sink = null;
      stream.destroy();
      if (!stream.closed) await once(stream, 'close').catch(() => undefined);
    }
    throw err;
  }

  return { filename, bytes: fileBytes, head };
}
