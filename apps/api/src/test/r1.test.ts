import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, upload, PDF } from './http.js';
import { storage } from '../lib/storage.js';
import { publiclyVisible } from '../lib/library.js';

/**
 * R1: the Library's schema rule (§1), the upload path that is the only
 * moment it can be enforced (§6), the transactional bytes-deletion on a
 * rights/visibility flip (§4.3), capability boundaries, and Persian search
 * folding (§5).
 */

let f: Fixture;
let contributor: Awaited<ReturnType<typeof prisma.user.create>>;
let base: string;
let close: () => Promise<void>;

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  contributor = await prisma.user.create({
    data: { email: 'contributor@test.local', name: 'Contributor', roles: ['CONTRIBUTOR'], state: 'ACTIVE' },
  });
});

after(async () => {
  await close();
  await stop();
  await prisma.$disconnect();
});

function entryInput(overrides: Record<string, unknown> = {}) {
  return {
    type: 'PAPER',
    originalLang: 'en',
    titleOriginal: 'Test Paper',
    authors: 'A. Author',
    translationProvenance: 'NONE_YET',
    rightsBasis: 'PUBLIC_DOMAIN',
    visibility: 'PUBLIC',
    ...overrides,
  };
}

const CREATE_ENTRY = `
  mutation($input: LibraryEntryInput!) {
    createLibraryEntry(input: $input) { id slug fullTextUrl rightsBasis visibility publishedAt }
  }
`;
const UPDATE_ENTRY = `
  mutation($id: ID!, $input: LibraryEntryInput!) {
    updateLibraryEntry(id: $id, input: $input) { id slug fullTextUrl rightsBasis visibility publishedAt }
  }
`;
const DELETE_ENTRY = `mutation($id: ID!){ deleteLibraryEntry(id: $id) }`;
const PUBLISH_ENTRY = `mutation($id: ID!){ publishLibraryEntry(id: $id){ id publishedAt } }`;
const ENTRIES_PAGE = `
  query($search: String, $limit: Int, $offset: Int) {
    libraryEntries(search: $search, limit: $limit, offset: $offset) { total rows { id } }
  }
`;

async function createEntry(overrides: Record<string, unknown> = {}) {
  const data = ok(await exec(CREATE_ENTRY, { as: contributor, variables: { input: entryInput(overrides) } }));
  return (data.createLibraryEntry as { id: string }).id;
}

// ---------------------------------------------------------------------------
// §2.1 — no default on the two required-choice enums
// ---------------------------------------------------------------------------

test('creating an entry without rightsBasis or translationProvenance is refused at the schema, not just the resolver', async () => {
  const mutation = `mutation($input: LibraryEntryInput!){ createLibraryEntry(input: $input){ id } }`;
  const full = entryInput() as Record<string, unknown>;

  const { rightsBasis: _r, ...noRights } = full;
  const r1 = await exec(mutation, { as: contributor, variables: { input: noRights } });
  assert.ok(r1.errors.length > 0, 'omitting rightsBasis must fail');
  assert.ok(!r1.data, 'a variable-validation failure must not run the resolver');

  const { translationProvenance: _t, ...noProv } = full;
  const r2 = await exec(mutation, { as: contributor, variables: { input: noProv } });
  assert.ok(r2.errors.length > 0, 'omitting translationProvenance must fail');
});

// ---------------------------------------------------------------------------
// §1 / §6 — the rule, enforced at the only moment RESEARCH_TEXT allows it
// ---------------------------------------------------------------------------

test('LINK_ONLY refuses a hosted file at upload, and leaves nothing behind', async () => {
  const entryId = await createEntry({ rightsBasis: 'LINK_ONLY' });
  const res = await upload(base, {
    as: contributor,
    fileClass: 'RESEARCH_TEXT',
    entryId,
    body: PDF,
    filename: 'paper.pdf',
    type: 'application/pdf',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body!.error, 'RIGHTS_FORBID_HOSTING');
  assert.equal(await prisma.storedFile.count(), 0);
});

test('PRIVATE refuses a hosted file the same way — the road the spec did not guard', async () => {
  const entryId = await createEntry({ visibility: 'PRIVATE' });
  const res = await upload(base, {
    as: contributor,
    fileClass: 'RESEARCH_TEXT',
    entryId,
    body: PDF,
    filename: 'paper.pdf',
    type: 'application/pdf',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body!.error, 'RIGHTS_FORBID_HOSTING');
  assert.equal(await prisma.storedFile.count(), 0);
});

test('a second upload onto an entry that already has a file is refused', async () => {
  const entryId = await createEntry();
  const first = await upload(base, { as: contributor, fileClass: 'RESEARCH_TEXT', entryId, body: PDF, filename: 'a.pdf', type: 'application/pdf' });
  assert.equal(first.status, 201);
  const second = await upload(base, { as: contributor, fileClass: 'RESEARCH_TEXT', entryId, body: PDF, filename: 'b.pdf', type: 'application/pdf' });
  assert.equal(second.status, 409);
  assert.equal(second.body!.error, 'ALREADY_HAS_FILE');
  assert.equal(await prisma.storedFile.count(), 1);
});

// ---------------------------------------------------------------------------
// §4.3 — flipping rights or visibility on a hosted entry deletes the bytes
// ---------------------------------------------------------------------------

test('flipping a hosted entry to LINK_ONLY deletes the bytes, not just the reference', async () => {
  const entryId = await createEntry();
  const up = await upload(base, { as: contributor, fileClass: 'RESEARCH_TEXT', entryId, body: PDF, filename: 'p.pdf', type: 'application/pdf' });
  assert.equal(up.status, 201);
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: up.body!.id } });
  assert.ok(await storage.exists(file.key));

  const updated = ok(
    await exec(UPDATE_ENTRY, { as: contributor, variables: { id: entryId, input: entryInput({ rightsBasis: 'LINK_ONLY' }) } }),
  );
  assert.equal((updated.updateLibraryEntry as { fullTextUrl: string | null }).fullTextUrl, null);
  assert.equal(await prisma.storedFile.count(), 0);
  assert.equal(await storage.exists(file.key), false);
});

test('flipping a hosted entry to PRIVATE deletes the bytes the same way', async () => {
  const entryId = await createEntry();
  const up = await upload(base, { as: contributor, fileClass: 'RESEARCH_TEXT', entryId, body: PDF, filename: 'p.pdf', type: 'application/pdf' });
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: up.body!.id } });

  ok(await exec(UPDATE_ENTRY, { as: contributor, variables: { id: entryId, input: entryInput({ visibility: 'PRIVATE' }) } }));
  assert.equal(await prisma.storedFile.count(), 0);
  assert.equal(await storage.exists(file.key), false);
});

test('deleteLibraryEntry on a hosted entry removes the file (T3)', async () => {
  const entryId = await createEntry();
  const up = await upload(base, { as: contributor, fileClass: 'RESEARCH_TEXT', entryId, body: PDF, filename: 'p.pdf', type: 'application/pdf' });
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: up.body!.id } });

  ok(await exec(DELETE_ENTRY, { as: contributor, variables: { id: entryId } }));
  assert.equal(await prisma.libraryEntry.count({ where: { id: entryId } }), 0);
  assert.equal(await prisma.storedFile.count(), 0);
  assert.equal(await storage.exists(file.key), false);
});

// ---------------------------------------------------------------------------
// Capability boundaries — house rule 1
// ---------------------------------------------------------------------------

test('a CONTRIBUTOR can create and update an entry, and is refused publishLibraryEntry', async () => {
  const entryId = await createEntry();
  ok(await exec(UPDATE_ENTRY, { as: contributor, variables: { id: entryId, input: entryInput({ titleOriginal: 'Revised' }) } }));
  const res = await exec(PUBLISH_ENTRY, { as: contributor, variables: { id: entryId } });
  assert.equal(res.code, 'FORBIDDEN');
});

test('a customer is refused every Library query and mutation', async () => {
  const entryId = await createEntry();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['query{ libraryEntries { total } }', {}],
    ['query($id:ID!){ libraryEntry(id:$id){ id } }', { id: entryId }],
    ['query{ libraryConcepts { id } }', {}],
    [CREATE_ENTRY, { input: entryInput() }],
    [PUBLISH_ENTRY, { id: entryId }],
  ];
  for (const [query, variables] of cases) {
    const r = await exec(query, { as: f.customer, variables });
    assert.equal(r.code, 'FORBIDDEN', query);
  }
});

// ---------------------------------------------------------------------------
// §2.2 — the three axes, and the one helper that reads them together
// ---------------------------------------------------------------------------

test('publiclyVisible excludes a draft, excludes a PRIVATE published entry, and includes a published public one', async () => {
  const draftId = await createEntry({ titleOriginal: 'Draft' });
  const privateId = await createEntry({ titleOriginal: 'Private', visibility: 'PRIVATE' });
  const publicId = await createEntry({ titleOriginal: 'Public' });
  void draftId;

  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: privateId } }));
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: publicId } }));

  const visible = await prisma.libraryEntry.findMany({ where: publiclyVisible, select: { titleOriginal: true } });
  assert.deepEqual(visible.map((e) => e.titleOriginal).sort(), ['Public']);
});

// ---------------------------------------------------------------------------
// §5 — Persian/Arabic search folding, the risk the spike actually found
// ---------------------------------------------------------------------------

test('search finds an entry typed with Arabic yeh/kaf when it was stored with Persian ones', async () => {
  await createEntry({ titleOriginal: 'کتاب روان‌شناسی', originalLang: 'fa' }); // stored with Persian keheh/yeh
  const data = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { search: 'كتاب' } })); // Arabic kaf
  assert.equal((data.libraryEntries as { total: number }).total, 1);
});

test('search matches across the ZWNJ boundary: می‌رود stored, میرود searched', async () => {
  await createEntry({ titleOriginal: 'وقتی می‌رود', originalLang: 'fa' });
  const data = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { search: 'میرود' } }));
  assert.equal((data.libraryEntries as { total: number }).total, 1);
});

// ---------------------------------------------------------------------------
// T1 — the list is thin and paginated from the first commit
// ---------------------------------------------------------------------------

test('libraryEntries respects limit/offset, and cannot return an abstract at all', async () => {
  for (let i = 0; i < 5; i += 1) await createEntry({ titleOriginal: `Entry ${i}` });

  const page1 = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { limit: 2, offset: 0 } }));
  const rows1 = (page1.libraryEntries as { total: number; rows: Array<{ id: string }> });
  assert.equal(rows1.rows.length, 2);
  assert.equal(rows1.total, 5);

  const page2 = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { limit: 2, offset: 2 } }));
  const rows2 = (page2.libraryEntries as { rows: Array<{ id: string }> }).rows;
  const ids1 = rows1.rows.map((r) => r.id);
  assert.ok(rows2.every((r) => !ids1.includes(r.id)));

  // Structurally impossible, not merely omitted by convention —
  // LibraryEntryRow has no abstract field for a query to ask for.
  const bad = await exec('query{ libraryEntries { rows { id abstractOriginal } } }', { as: contributor });
  assert.ok(bad.errors.length > 0, 'LibraryEntryRow must not have an abstractOriginal field');
});

// ---------------------------------------------------------------------------
// T8 / T4 — a few more R1-specific guarantees worth their own test
// ---------------------------------------------------------------------------

test('tagging an entry with a concept makes the concept title findable (T8)', async () => {
  const entryId = await createEntry({ titleOriginal: 'Unrelated title' });
  const concept = ok(
    await exec('mutation($input: LibraryConceptInput!){ createLibraryConcept(input:$input){ id } }', {
      as: contributor,
      variables: { input: { titleFa: 'روان‌شناسی', titleEn: 'Psychology' } },
    }),
  );
  const conceptId = (concept.createLibraryConcept as { id: string }).id;

  const before = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { search: 'Psychology' } }));
  assert.equal((before.libraryEntries as { total: number }).total, 0);

  ok(
    await exec('mutation($id:ID!,$conceptIds:[ID!]!){ setEntryConcepts(id:$id, conceptIds:$conceptIds){ id } }', {
      as: contributor,
      variables: { id: entryId, conceptIds: [conceptId] },
    }),
  );

  const after = ok(await exec(ENTRIES_PAGE, { as: contributor, variables: { search: 'Psychology' } }));
  assert.equal((after.libraryEntries as { total: number }).total, 1);
});

test('the slug cannot change once the entry is published (T4)', async () => {
  const entryId = await createEntry();
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: entryId } }));

  const res = await exec(UPDATE_ENTRY, {
    as: contributor,
    variables: { id: entryId, input: entryInput({ slug: 'a-brand-new-slug' }) },
  });
  assert.equal(res.code, 'SLUG_LOCKED');
});

test('the database itself refuses a hosted file on a LINK_ONLY row (the CHECK, directly)', async () => {
  const entryId = await createEntry();
  const file = await prisma.storedFile.create({
    data: {
      key: 'public/2026/08/orphan.pdf',
      class: 'RESEARCH_TEXT',
      visibility: 'PUBLIC',
      mime: 'application/pdf',
      bytes: 10,
      originalName: 'orphan.pdf',
      uploadedById: contributor.id,
    },
  });
  await assert.rejects(
    prisma.libraryEntry.update({
      where: { id: entryId },
      data: { rightsBasis: 'LINK_ONLY', fullTextFileId: file.id },
    }),
    /LibraryEntry_hosted_text_is_publishable|constraint/i,
  );
});
