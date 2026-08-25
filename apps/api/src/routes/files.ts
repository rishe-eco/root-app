/**
 * Upload and download, as plain HTTP.
 *
 * **Not through GraphQL** (build plan §F1). Multipart over GraphQL costs a
 * dependency and a transport special-case for no gain; Apollo stays JSON-only
 * and these two routes stay boring. They authenticate through the same
 * `buildContext` as `/graphql`, so there is one notion of who the caller is,
 * not two — which is also why an API token works here without this file
 * knowing anything about tokens. What it *does* have to know is scope, since
 * the plugin that enforces it only sees GraphQL operations; see the upload
 * handler.
 *
 * They also do not pass through `express.json({ limit: '1mb' })` — that
 * middleware is mounted on `/graphql` alone, so its limit is neither raised
 * nor circumvented here.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { prisma } from '../lib/prisma.js';
import { buildContext } from '../context.js';
import { storage } from '../lib/storage.js';
import { UploadError, checkSize, policyFor, safeDownloadName, sniff } from '../lib/files.js';
import { can } from '../lib/capabilities.js';
import type { LibraryEntry } from '@prisma/client';

export const filesRouter: Router = Router();

/** Express 4 does not catch a rejected promise from an async handler; without
 *  this the process gets an unhandled rejection and the client gets nothing. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/**
 * Reads the request body, refusing to buffer more than `cap` bytes.
 *
 * `Content-Length` is checked first because rejecting before the transfer is
 * kinder to both ends — but it is a claim, not a fact, so the running total is
 * what actually enforces the limit. Anything past the cap ends the request:
 * continuing to read would let one caller decide how much of this process's
 * memory to occupy.
 */
async function readBodyCapped(req: Request, cap: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    throw new UploadError(413, 'FILE_TOO_LARGE', 'That upload is larger than this kind allows.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > cap) {
      req.destroy();
      throw new UploadError(413, 'FILE_TOO_LARGE', 'That upload is larger than this kind allows.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Room for the multipart envelope — boundaries, part headers, the trailing
 *  boundary — on top of the file itself. The file's own size is checked
 *  separately, after parsing, against the exact class limit. */
const ENVELOPE_SLACK = 64 * 1024;

/**
 * POST /upload?class=DESIGN_IMAGE&contractId=… or ?class=RESEARCH_TEXT&entryId=…
 *
 * The class is in the query string rather than the body on purpose: it decides
 * the size limit, and a limit that can only be known after reading the whole
 * body is not a limit. Which owning-row parameter applies is decided by the
 * class's policy (`owner`, in lib/files.ts) — see R1.md §6.
 *
 * CSRF: the session cookie is `SameSite=Lax`, which browsers do not attach to
 * a cross-site POST, and CORS is pinned to APP_ORIGIN. That is the same
 * protection `/graphql` relies on — this route does not weaken it.
 */
filesRouter.post(
  '/upload',
  wrap(async (req, res) => {
    const ctx = await buildContext(req, res);
    if (!ctx.user) {
      throw new UploadError(401, 'UNAUTHENTICATED', 'You need to sign in.');
    }
    const user = ctx.user; // a local const, so narrowing survives into the transaction closure below

    // An upload is a write, and this route never reaches the Apollo plugin
    // that says so for `/graphql` (lib/tokenScope.ts). Without this line a
    // read-only token would be refused every mutation and still be able to
    // put a file in storage — the exact hole the plugin exists to close,
    // reopened by a transport that does not go through it.
    if (ctx.auth?.kind === 'apiToken' && ctx.auth.scope !== 'WRITE') {
      throw new UploadError(
        403,
        'TOKEN_READ_ONLY',
        'This API token is read-only. Issue a write-scoped token to upload.',
      );
    }

    const { fileClass, policy } = policyFor(String(req.query.class ?? ''));
    if (!can(user, policy.uploader)) {
      throw new UploadError(403, 'FORBIDDEN', 'You do not have access to that.');
    }

    const contractId = typeof req.query.contractId === 'string' ? req.query.contractId : null;
    const entryId = typeof req.query.entryId === 'string' ? req.query.entryId : null;

    let entry: LibraryEntry | null = null;
    if (policy.owner === 'contract') {
      if (!contractId) {
        throw new UploadError(
          400,
          'CONTRACT_REQUIRED',
          'This kind of file belongs to a contract; name which one.',
        );
      }
      const contract = await prisma.contract.findUnique({ where: { id: contractId } });
      if (!contract) {
        throw new UploadError(404, 'NOT_FOUND', 'No such contract.');
      }
    } else {
      // owner === 'entry' (R1.md §6). "No such thing", not "not allowed" —
      // house rule 13 — for the missing case; the rights refusal below is the
      // one place §1's rule is enforced at upload time, because RESEARCH_TEXT
      // is PUBLIC and Nginx serves it with no code in the request afterwards.
      if (!entryId) {
        throw new UploadError(
          400,
          'ENTRY_REQUIRED',
          'This kind of file belongs to a Library entry; name which one.',
        );
      }
      entry = await prisma.libraryEntry.findUnique({ where: { id: entryId } });
      if (!entry) {
        throw new UploadError(404, 'NOT_FOUND', 'No such entry.');
      }
      if (entry.rightsBasis === 'LINK_ONLY' || entry.visibility === 'PRIVATE') {
        throw new UploadError(
          403,
          'RIGHTS_FORBID_HOSTING',
          'The rights on this entry do not allow a hosted file.',
        );
      }
      if (entry.fullTextFileId) {
        throw new UploadError(
          409,
          'ALREADY_HAS_FILE',
          'This entry already has a hosted file. Detach it before uploading another.',
        );
      }
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      throw new UploadError(
        415,
        'NOT_MULTIPART',
        'Send the file as multipart/form-data with a "file" field.',
      );
    }

    const raw = await readBodyCapped(req, policy.maxBytes + ENVELOPE_SLACK);

    // Node parses multipart natively (>=20). A dependency here would buy
    // streaming to disk, which matters at sizes these classes do not reach —
    // and the same reasoning env.ts applies to dotenv applies here.
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
    } catch {
      throw new UploadError(400, 'MALFORMED_UPLOAD', 'That upload could not be read.');
    }

    const field = form.get('file');
    if (!(field instanceof File)) {
      throw new UploadError(400, 'NO_FILE', 'No "file" field in that upload.');
    }

    const data = Buffer.from(await field.arrayBuffer());
    checkSize(data.length, policy);
    // What it *is*, not what it says it is.
    const type = sniff(data, policy);

    const key = await storage.put(policy.visibility, data, type.ext);

    let stored;
    try {
      stored = await prisma.$transaction(async (tx) => {
        const file = await tx.storedFile.create({
          data: {
            key,
            class: fileClass,
            visibility: policy.visibility,
            mime: type.mime,
            bytes: data.length,
            originalName: safeDownloadName(field.name, type.ext),
            contractId,
            uploadedById: user.id,
          },
        });
        if (entry) {
          // Same transaction as the row write (R1.md §6, steps 2 & 4): if the
          // entry was flipped to LINK_ONLY or PRIVATE between the check above
          // and here, the hosted-text CHECK refuses this update and the whole
          // transaction — including the StoredFile row — rolls back. The
          // bytes are already on disk by then; the catch below cleans them up.
          await tx.libraryEntry.update({
            where: { id: entry.id },
            data: { fullTextFileId: file.id },
          });
        }
        return file;
      });
    } catch (err) {
      // The bytes are already on disk. Without this the file would linger with
      // no row pointing at it — unreachable, unowned, and counted by nothing.
      await storage.remove(key).catch(() => undefined);
      throw err;
    }

    res.status(201).json({
      id: stored.id,
      url: `/files/${stored.id}`,
      mime: stored.mime,
      bytes: stored.bytes,
      originalName: stored.originalName,
    });
  }),
);

/**
 * GET /files/:id[?download=1]
 *
 * In production Nginx serves the public class off disk and never reaches this
 * handler; the public branch here is what makes the same URL work in
 * development, where there is no Nginx at all.
 */
filesRouter.get(
  '/files/:id',
  wrap(async (req, res) => {
    const file = await prisma.storedFile.findUnique({
      where: { id: req.params.id },
      include: { contract: { select: { customerId: true, publishedAt: true } } },
    });

    // One answer for "no such file" and "not yours". Distinguishing them would
    // turn this route into a way to ask whether a given id exists.
    const deny = () => {
      res.status(404).json({ error: 'NOT_FOUND', message: 'No such file.' });
    };

    if (!file) return deny();

    if (file.visibility === 'PRIVATE') {
      const ctx = await buildContext(req, res);
      if (!ctx.user) {
        res.status(401).json({ error: 'UNAUTHENTICATED', message: 'You need to sign in.' });
        return;
      }
      if (!can(ctx.user, 'contracts.manage')) {
        // Exactly the rule `loadForActor` applies to the contract itself: your
        // own, and published. A design image is part of a contract, so it
        // cannot be more visible than the contract that owns it.
        const owned =
          file.contract !== null &&
          file.contract.customerId === ctx.user.id &&
          file.contract.publishedAt !== null;
        if (!owned) return deny();
      }
    }

    if (!(await storage.exists(file.key))) {
      // The row survived and the bytes did not — a restore that missed
      // STORAGE_DIR, most likely. Say so in the log; the client still gets 404.
      console.error(`[files] row ${file.id} points at a missing key: ${file.key}`);
      return deny();
    }

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.bytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The id addresses these exact bytes and an edit produces a new row, so the
    // response is immutable. `private` keeps it out of any shared cache, which
    // for a customer's unreleased design is the point.
    res.setHeader(
      'Cache-Control',
      file.visibility === 'PRIVATE'
        ? 'private, max-age=31536000, immutable'
        : 'public, max-age=31536000, immutable',
    );
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', contentDisposition(file.originalName));
    }

    await pipeline(storage.read(file.key) as Readable, res);
  }),
);

/**
 * `filename` for the browsers that only read ASCII, `filename*` for everyone
 * else. Persian filenames are the normal case in this product, not the edge
 * one, so the RFC 5987 form is the one that carries the real name and the
 * ASCII fallback is allowed to be ugly.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Turns an UploadError into its status; anything else is a real fault and is
 *  left to the app's error handling rather than dressed up as a client error. */
export function filesErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(err);
  if (err instanceof UploadError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error('[files] unhandled', err);
  res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong.' });
}
