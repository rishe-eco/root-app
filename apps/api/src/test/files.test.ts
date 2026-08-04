import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, cookieFor, upload, PNG } from './http.js';
import { storage } from '../lib/storage.js';

/**
 * Upload and download, against a real database and a real socket.
 *
 * The question this file exists to answer is the only one that can hurt
 * anybody: **can the wrong person read a customer's design?** Everything else
 * here — limits, types, error codes — is in service of that, because each is a
 * way of getting bytes onto our disk that we did not intend to accept.
 */

let f: Fixture;
let base: string;
let close: () => Promise<void>;

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await close();
  await stop();
  await prisma.$disconnect();
});

const get = (id: string, opts: { as?: { id: string } | null; download?: boolean } = {}) =>
  fetch(`${base}/files/${id}${opts.download ? '?download=1' : ''}`, {
    headers: opts.as ? { cookie: cookieFor(opts.as) } : {},
    redirect: 'manual',
  });

// ---------------------------------------------------------------------------
// Who may upload
// ---------------------------------------------------------------------------

test('an anonymous caller cannot upload', async () => {
  const res = await upload(base, { contractId: f.contract.id });
  assert.equal(res.status, 401);
  assert.equal(await prisma.storedFile.count(), 0);
});

test('a customer cannot upload a design image — only Root produces designs', async () => {
  const res = await upload(base, { as: f.customer, contractId: f.contract.id });
  assert.equal(res.status, 403);
  assert.equal(await prisma.storedFile.count(), 0);
});

test('an admin can, and the row records the class, visibility and owner', async () => {
  const res = await upload(base, { as: f.admin, contractId: f.contract.id });
  assert.equal(res.status, 201);

  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: res.body!.id } });
  assert.equal(row.class, 'DESIGN_IMAGE');
  assert.equal(row.visibility, 'PRIVATE');
  assert.equal(row.contractId, f.contract.id);
  assert.equal(row.uploadedById, f.admin.id);
  assert.equal(row.mime, 'image/png');
  assert.equal(row.bytes, PNG.length);
  assert.equal(res.body!.url, `/files/${row.id}`);
  assert.ok(await storage.exists(row.key));
});

// ---------------------------------------------------------------------------
// What may be uploaded
// ---------------------------------------------------------------------------

test('a design image must name the contract it belongs to', async () => {
  const res = await upload(base, { as: f.admin, contractId: null });
  assert.equal(res.status, 400);
  assert.equal(res.body!.error, 'CONTRACT_REQUIRED');
});

test('a contract that does not exist is refused', async () => {
  const res = await upload(base, { as: f.admin, contractId: 'no-such-contract' });
  assert.equal(res.status, 404);
});

test('an unknown class is refused rather than defaulted', async () => {
  const res = await upload(base, { as: f.admin, contractId: f.contract.id, fileClass: 'ANYTHING' });
  assert.equal(res.status, 400);
  assert.equal(res.body!.error, 'UNKNOWN_FILE_CLASS');
});

test('a PDF claiming to be a PNG is refused — the bytes decide', async () => {
  const res = await upload(base, {
    as: f.admin,
    contractId: f.contract.id,
    body: Buffer.from('%PDF-1.7\nnot a picture'),
    filename: 'mockup.png',
    type: 'image/png',
  });
  assert.equal(res.status, 415);
  assert.equal(res.body!.error, 'UNSUPPORTED_TYPE');
  assert.equal(await prisma.storedFile.count(), 0);
});

test('an oversize upload is refused and nothing is written', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
  const res = await upload(base, { as: f.admin, contractId: f.contract.id, body: big });
  assert.equal(res.status, 413);
  assert.equal(await prisma.storedFile.count(), 0);
});

test('an empty file is refused', async () => {
  const res = await upload(base, { as: f.admin, contractId: f.contract.id, body: Buffer.alloc(0) });
  assert.equal(res.status, 400);
  assert.equal(res.body!.error, 'EMPTY_FILE');
});

// ---------------------------------------------------------------------------
// Who may read — the part that matters
// ---------------------------------------------------------------------------

test('the owning customer can read their own design image', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  const res = await get(up.body!.id, { as: f.customer });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('another customer gets 404 — not 403, which would confirm the file exists', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  const res = await get(up.body!.id, { as: f.stranger });

  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'NOT_FOUND');
});

test('an anonymous caller cannot read a private file', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  assert.equal((await get(up.body!.id)).status, 401);
});

test('an admin can read any of them', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  assert.equal((await get(up.body!.id, { as: f.admin })).status, 200);
});

/**
 * The image is part of the contract, so it cannot be more visible than the
 * contract is — the same rule `loadForActor` applies to the contract itself.
 * Without this, an unpublished draft's designs would be readable by the
 * customer the moment a URL leaked, which is exactly what "not published yet"
 * is supposed to prevent.
 */
test('an unpublished contract hides its files from the customer, but not from Root', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });

  assert.equal((await get(up.body!.id, { as: f.customer })).status, 404);
  assert.equal((await get(up.body!.id, { as: f.admin })).status, 200);
});

test('an id that does not exist looks exactly like one that is not yours', async () => {
  const res = await get('no-such-file', { as: f.customer });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

test('without ?download the file is served inline', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  const res = await get(up.body!.id, { as: f.customer });
  assert.equal(res.headers.get('content-disposition'), null);
  await res.arrayBuffer();
});

test('a Persian filename survives the download header intact', async () => {
  const name = 'طرح-صفحه-اصلی.png';
  const up = await upload(base, { as: f.admin, contractId: f.contract.id, filename: name });
  const res = await get(up.body!.id, { as: f.customer, download: true });

  const cd = res.headers.get('content-disposition') ?? '';
  assert.match(cd, /^attachment;/);
  // The ASCII fallback is allowed to be mangled; the RFC 5987 form is the one
  // that has to carry the real name.
  const encoded = cd.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(encoded), name);
  await res.arrayBuffer();
});

test('a private file is never cached by a shared cache', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  const res = await get(up.body!.id, { as: f.customer });
  assert.match(res.headers.get('cache-control') ?? '', /^private,/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  await res.arrayBuffer();
});

test('a row whose bytes have gone missing is a 404, not a stack trace', async () => {
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: up.body!.id } });
  await storage.remove(row.key);

  assert.equal((await get(up.body!.id, { as: f.customer })).status, 404);
});

// ---------------------------------------------------------------------------
// Attaching an upload to a design
// ---------------------------------------------------------------------------

const ADD_CONCEPT = `
  mutation ($contractId: ID!) {
    addConcept(contractId: $contractId, key: "2a", labelFa: "طرح", labelEn: "Concept") { id }
  }
`;

const SET_CONCEPT_IMAGE = `
  mutation ($conceptId: ID!, $fileId: ID) {
    setConceptImage(conceptId: $conceptId, fileId: $fileId) { id }
  }
`;

/** The published revision is immutable, so edits land in a fresh draft. */
async function draftConcept() {
  ok(await exec(ADD_CONCEPT, { as: f.admin, variables: { contractId: f.contract.id } }));
  const revision = await prisma.designRevision.findFirstOrThrow({
    where: { contractId: f.contract.id, publishedAt: null },
    include: { concepts: { include: { pages: true } } },
  });
  return revision.concepts.find((c) => c.key === '2a')!;
}

test('attaching sets both halves of the image together', async () => {
  const concept = await draftConcept();
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });

  ok(await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: concept.id, fileId: up.body!.id },
  }));

  const after = await prisma.designConcept.findUniqueOrThrow({ where: { id: concept.id } });
  assert.equal(after.imageFileId, up.body!.id);
  assert.equal(after.imageUrl, `/files/${up.body!.id}`);
});

test('passing null clears both', async () => {
  const concept = await draftConcept();
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  ok(await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: concept.id, fileId: up.body!.id },
  }));

  ok(await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: concept.id, fileId: null },
  }));

  const after = await prisma.designConcept.findUniqueOrThrow({ where: { id: concept.id } });
  assert.equal(after.imageFileId, null);
  assert.equal(after.imageUrl, null);
});

/**
 * The cross-contract check. Serving authorises by the file's *own* contract,
 * so attaching A's file to B's design would put a name for A's private image
 * on B's page — and B could not see it, which is the harmless half.
 */
test("a file belonging to another contract cannot be attached", async () => {
  const other = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'دیگر',
      titleEn: 'Other',
      customerId: f.stranger.id,
      publishedAt: new Date(),
    },
  });
  const foreign = await upload(base, { as: f.admin, contractId: other.id });
  const concept = await draftConcept();

  const res = await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: concept.id, fileId: foreign.body!.id },
  });
  assert.equal(res.code, 'NOT_FOUND');
});

test('a published revision refuses the edit', async () => {
  const published = await prisma.designConcept.findFirstOrThrow({
    where: { designRevision: { contractId: f.contract.id, publishedAt: { not: null } } },
  });
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });

  const res = await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: published.id, fileId: up.body!.id },
  });
  assert.equal(res.code, 'REVISION_PUBLISHED');
});

test('a customer cannot attach images', async () => {
  const concept = await draftConcept();
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });

  const res = await exec(SET_CONCEPT_IMAGE, {
    as: f.customer,
    variables: { conceptId: concept.id, fileId: up.body!.id },
  });
  assert.equal(res.code, 'FORBIDDEN');
});

/**
 * A file a published revision points at must not be deletable — the approval
 * that revision carries is an approval *of that image*. The FK says so; this
 * checks the database actually enforces it.
 */
test('a file in use cannot be deleted out from under a revision', async () => {
  const concept = await draftConcept();
  const up = await upload(base, { as: f.admin, contractId: f.contract.id });
  ok(await exec(SET_CONCEPT_IMAGE, {
    as: f.admin,
    variables: { conceptId: concept.id, fileId: up.body!.id },
  }));

  await assert.rejects(prisma.storedFile.delete({ where: { id: up.body!.id } }));
});

/** The CHECK constraint from the migration: a private file nobody owns is a
 *  file nobody can ever be authorised to read, so the row must not exist. */
test('the database refuses a private file with no contract', async () => {
  await assert.rejects(
    prisma.storedFile.create({
      data: {
        key: 'private/2026/08/orphan.png',
        class: 'DESIGN_IMAGE',
        visibility: 'PRIVATE',
        mime: 'image/png',
        bytes: 10,
        originalName: 'orphan.png',
        uploadedById: f.admin.id,
      },
    }),
    /StoredFile_private_has_owner|constraint/i,
  );
});
