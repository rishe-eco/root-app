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
import { rm } from 'node:fs/promises';

import { prisma } from '../lib/prisma.js';
import { buildContext } from '../context.js';
import { storage } from '../lib/storage.js';
import { UploadError, checkSize, policyFor, safeDownloadName, sniff, type ClassPolicy } from '../lib/files.js';
import { receiveFilePart } from '../lib/multipartStream.js';
import { validateBundle } from '../lib/mockupBundle.js';
import { can } from '../lib/capabilities.js';
import { canAuthorDesign, contractVisibleTo, contractVisibleToStaff } from '../lib/visibility.js';
import { hasToolGrant } from '../lib/toolGrants.js';
import { canSeeThemePreview } from '../lib/themes.js';
import type { FileClass, LibraryEntry, User } from '@prisma/client';

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
 * The streamed upload (journeys build plan D-9) — for the one class whose
 * ceiling is too large to buffer (`policy.streamed`, a 50 MB mockup bundle).
 *
 * The body goes to a temp file under `STORAGE_DIR` with a running byte count
 * (`lib/multipartStream.ts` — refused at the cap with `FILE_TOO_LARGE`, the
 * file removed), its first bytes are sniffed (a zip), `validateBundle` reads the
 * central directory (`BUNDLE_*`), and only then is the file moved into place
 * with the same atomic rename `storage.put` uses (`storage.adopt`). A file that
 * fails any step is removed; nothing half-received is ever a stored file.
 *
 * The owner and uploader checks — the caller is `design.author` **and** this
 * contract's designer (house rule 2) — already ran in the handler above, before
 * a byte of the body was read: an upload that will be refused for who is
 * sending it should not be received first.
 */
async function receiveStreamedUpload(
  req: Request,
  res: Response,
  args: { user: User; fileClass: FileClass; policy: ClassPolicy; contractId: string; contentType: string },
) {
  const { user, fileClass, policy, contractId, contentType } = args;

  // Same courtesy as `readBodyCapped`: an honest client that says its size up
  // front is refused before the transfer, not after 50 MB of it.
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > policy.maxBytes + ENVELOPE_SLACK) {
    throw new UploadError(413, 'FILE_TOO_LARGE', 'That upload is larger than this kind allows.');
  }

  const tempFile = await storage.tempPath();
  let key: string;
  let type: ReturnType<typeof sniff>;
  let received: Awaited<ReturnType<typeof receiveFilePart>>;
  try {
    try {
      received = await receiveFilePart(req as unknown as AsyncIterable<Buffer>, contentType, {
        field: 'file',
        destination: tempFile,
        maxFileBytes: policy.maxBytes,
        maxBodyBytes: policy.maxBytes + ENVELOPE_SLACK,
      });
    } catch (err) {
      // The request may be half-read. `readBodyCapped` destroys it here, which
      // also destroys the socket the refusal has to travel on; this asks the
      // server to close the connection *after* the answer instead.
      res.setHeader('Connection', 'close');
      throw err;
    }
    checkSize(received.bytes, policy);
    // What it *is*, from its own first bytes — then what it *holds*.
    type = sniff(received.head, policy);
    await validateBundle(tempFile);
    key = await storage.adopt(policy.visibility, tempFile, type.ext);
  } catch (err) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw err;
  }

  try {
    return await prisma.storedFile.create({
      data: {
        key,
        class: fileClass,
        visibility: policy.visibility,
        mime: type.mime,
        bytes: received.bytes,
        originalName: safeDownloadName(received.filename, type.ext),
        contractId,
        uploadedById: user.id,
      },
    });
  } catch (err) {
    // The bytes are in place and no row points at them — same cleanup as the
    // buffered path.
    await storage.remove(key).catch(() => undefined);
    throw err;
  }
}

/**
 * POST /upload?class=DESIGN_IMAGE&contractId=… or ?class=RESEARCH_TEXT&entryId=…
 * (or …&projectId=… for SERVICE_IMPORT, …&themeId=… for THEME_PREVIEW)
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
    // Build plan L7: `'projectOwner'` is not a capability at all — it is
    // checked below, once the named project is loaded, against ownership
    // rather than the capability table (house rule 2). Every other class's
    // uploader stays a plain capability check, unchanged.
    if (policy.uploader !== 'projectOwner' && !can(user, policy.uploader)) {
      throw new UploadError(403, 'FORBIDDEN', 'You do not have access to that.');
    }

    const contractId = typeof req.query.contractId === 'string' ? req.query.contractId : null;
    const entryId = typeof req.query.entryId === 'string' ? req.query.entryId : null;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const themeId = typeof req.query.themeId === 'string' ? req.query.themeId : null;

    let entry: LibraryEntry | null = null;
    let theme: { id: string } | null = null;
    if (policy.owner === 'contract') {
      if (!contractId) {
        throw new UploadError(
          400,
          'CONTRACT_REQUIRED',
          'This kind of file belongs to a contract; name which one.',
        );
      }
      const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        include: { project: { select: { status: true } } },
      });
      // Journeys build plan S1: the capability above says "may upload design
      // images at all"; this says "to *this* contract" — visible to the
      // uploader, and theirs to design. Same two answers, same two codes,
      // as `requireDesignAuthorOn` gives the resolvers.
      if (!contract || !contractVisibleTo(user, contract)) {
        throw new UploadError(404, 'NOT_FOUND', 'No such contract.');
      }
      if (policy.uploader === 'design.author' && !canAuthorDesign(user, contract)) {
        throw new UploadError(403, 'NOT_ASSIGNED', 'You are not the designer of this contract.');
      }
    } else if (policy.owner === 'project') {
      // Build plan L7 — the first upload a customer performs themself
      // (house rule 2: an ownership check against the project's own
      // customer, staff bypass, never a role test).
      if (!projectId) {
        throw new UploadError(400, 'PROJECT_REQUIRED', 'This kind of file belongs to a project; name which one.');
      }
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw new UploadError(404, 'NOT_FOUND', 'No such project.');
      }
      // Staff bypass is `customers.manage` — the desk's services surface
      // (journeys build plan S1; before it, `contracts.manage`).
      if (!can(user, 'customers.manage') && project.customerId !== user.id) {
        throw new UploadError(403, 'FORBIDDEN', 'You do not have access to that.');
      }
      // Journeys build plan S3: the only class owned by a project is the
      // product import, so its tool grant gates the customer's own upload the
      // way it gates the resolvers — "no such project", because for a customer
      // without the tool there is no place to upload to. Staff are unaffected.
      if (!can(user, 'customers.manage') && !(await hasToolGrant(user.id, 'PRODUCT_IMPORT'))) {
        throw new UploadError(404, 'NOT_FOUND', 'No such project.');
      }
    } else if (policy.owner === 'theme') {
      // Journeys build plan T2 — a catalogue preview. The capability above
      // (`templates.types`) is the whole authority; what remains is that the
      // theme exists. A theme belongs to no contract, so there is no
      // visibility or assignment edge to consult.
      if (!themeId) {
        throw new UploadError(400, 'THEME_REQUIRED', 'This kind of file belongs to a theme; name which one.');
      }
      theme = await prisma.theme.findUnique({ where: { id: themeId }, select: { id: true } });
      if (!theme) {
        throw new UploadError(404, 'NOT_FOUND', 'No such theme.');
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

    if (policy.streamed) {
      // Only contract-owned classes stream today (MOCKUP_BUNDLE); a future
      // streamed class with another owner needs its own owner handling below,
      // and should fail here, loudly, rather than store a file no one can read.
      if (policy.owner !== 'contract' || !contractId) {
        throw new Error(`streamed upload class ${fileClass} must be contract-owned`);
      }
      const stored = await receiveStreamedUpload(req, res, { user, fileClass, policy, contractId, contentType });
      res.status(201).json({
        id: stored.id,
        url: `/files/${stored.id}`,
        mime: stored.mime,
        bytes: stored.bytes,
        originalName: stored.originalName,
      });
      return;
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

    // The bytes of the preview this upload replaces, removed once the swap has
    // committed — never before, or a failed swap would leave a theme pointing
    // at nothing.
    let replacedKey: string | null = null;

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
            // Only the owner edge the class names is written. A stray
            // `contractId` on a theme upload would otherwise make the file
            // readable by that contract's customer (`contractVisibleTo`), and
            // the private-file CHECK would not notice: one owner is enough.
            contractId: policy.owner === 'contract' ? contractId : null,
            projectId: policy.owner === 'project' ? projectId : null,
            themeId: theme?.id ?? null,
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
        if (theme) {
          // One preview per theme: the new file replaces the old, in the same
          // transaction that points the theme at it. The theme row is locked
          // so two uploads racing cannot both find the same "old" file and
          // both delete it (the loser would otherwise roll back on a row that
          // is already gone).
          const [locked] = await tx.$queryRaw<Array<{ previewFileId: string | null }>>`
            SELECT "previewFileId" FROM "Theme" WHERE "id" = ${theme.id} FOR UPDATE`;
          await tx.theme.update({ where: { id: theme.id }, data: { previewFileId: file.id } });
          if (locked?.previewFileId) {
            const old = await tx.storedFile.findUnique({ where: { id: locked.previewFileId } });
            if (old) {
              await tx.storedFile.delete({ where: { id: old.id } });
              replacedKey = old.key;
            }
          }
        }
        return file;
      });
    } catch (err) {
      // The bytes are already on disk. Without this the file would linger with
      // no row pointing at it — unreachable, unowned, and counted by nothing.
      await storage.remove(key).catch(() => undefined);
      throw err;
    }

    if (replacedKey) await storage.remove(replacedKey).catch(() => undefined);

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
      include: {
        contract: {
          select: { customerId: true, publishedAt: true, status: true, project: { select: { status: true } } },
        },
        // Build plan L7 — a SERVICE_IMPORT file has no contract at all;
        // ownership runs through the project instead.
        project: { select: { customerId: true } },
        // Journeys build plan T2 — a THEME_PREVIEW file has neither; the
        // catalogue is staff-only, so the edge is a capability, not a row.
        theme: { select: { id: true } },
      },
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
      // Exactly the rule `loadForActor` applies to the contract itself —
      // `contractVisibleTo`, imported rather than restated (journeys build
      // plan S1). A design image is part of a contract, so it cannot be more
      // visible than the contract that owns it. A SERVICE_IMPORT file (build
      // plan L7) has no publishedAt-shaped gate to inherit — a project is
      // never "unpublished" the way a contract draft is — so its half is
      // ownership, or the services desk's `customers.manage`.
      //
      // A MOCKUP_BUNDLE (journeys build plan J9) is the one contract file the
      // customer's edge does not open: they view a mockup through a grant on
      // the mockup host, which shows only a *published* iteration, and this
      // route would otherwise hand them a draft iteration's raw zip to anyone
      // who learned its id. Staff — who upload it and check it — still read it.
      const visible =
        (file.contract !== null &&
          (file.class === 'MOCKUP_BUNDLE'
            ? contractVisibleToStaff(ctx.user, file.contract)
            : contractVisibleTo(ctx.user, file.contract))) ||
        (file.project !== null && (file.project.customerId === ctx.user.id || can(ctx.user, 'customers.manage'))) ||
        // A theme preview is the catalogue's, and the catalogue is staff-only
        // (`canSeeThemePreview`): a customer holds none of those capabilities,
        // so they get the same 404 as for a file that does not exist.
        (file.theme !== null && canSeeThemePreview(ctx.user));
      if (!visible) return deny();
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
