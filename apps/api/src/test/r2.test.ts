import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * R2: the public reader's three queries (§2) — no session at all reaches
 * any of these, so every `exec` below either omits `as` or passes it
 * explicitly as the point under test. Filtered through publiclyVisible,
 * clamped to a smaller ceiling than the staff list, and shaped so a draft
 * cannot leak through a field a later change adds to the wrong type.
 */

let f: Fixture;
let contributor: Awaited<ReturnType<typeof prisma.user.create>>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  contributor = await prisma.user.create({
    data: { email: 'contributor@test.local', name: 'Contributor', roles: ['CONTRIBUTOR'], state: 'ACTIVE' },
  });
});

after(async () => {
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

const CREATE_ENTRY = `mutation($input: LibraryEntryInput!){ createLibraryEntry(input:$input){ id slug } }`;
const PUBLISH_ENTRY = `mutation($id: ID!){ publishLibraryEntry(id:$id){ id publishedAt } }`;
const CREATE_CONCEPT = `mutation($input: LibraryConceptInput!){ createLibraryConcept(input:$input){ id slug } }`;
const SET_CONCEPTS = `mutation($id:ID!,$conceptIds:[ID!]!){ setEntryConcepts(id:$id, conceptIds:$conceptIds){ id } }`;

const PUBLIC_ENTRIES = `
  query($search: String, $type: EntryType, $conceptSlug: String, $limit: Int, $offset: Int) {
    publicLibraryEntries(search: $search, type: $type, conceptSlug: $conceptSlug, limit: $limit, offset: $offset) {
      total
      rows { id slug titleOriginal }
    }
  }
`;
const PUBLIC_CONCEPTS = `query{ publicLibraryConcepts { slug titleEn } }`;

async function createEntry(overrides: Record<string, unknown> = {}) {
  const data = ok(await exec(CREATE_ENTRY, { as: contributor, variables: { input: entryInput(overrides) } }));
  return data.createLibraryEntry as { id: string; slug: string };
}

// ---------------------------------------------------------------------------
// §2.1 / T1 — separate resolvers, separate shapes, and publiclyVisible only
// ---------------------------------------------------------------------------

test('publicLibraryEntries excludes a draft and a PRIVATE published entry, includes a published public one — anonymous, no session at all', async () => {
  const draft = await createEntry({ titleOriginal: 'Draft' });
  const priv = await createEntry({ titleOriginal: 'Private', visibility: 'PRIVATE' });
  const pub = await createEntry({ titleOriginal: 'Public' });
  void draft;
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: priv.id } }));
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: pub.id } }));

  // `as` omitted entirely: this is what an anonymous visitor's request is.
  const data = ok(await exec(PUBLIC_ENTRIES, { variables: {} }));
  const rows = (data.publicLibraryEntries as { rows: Array<{ titleOriginal: string }> }).rows;
  assert.deepEqual(rows.map((r) => r.titleOriginal), ['Public']);
});

test('the public row and the public entry have no searchText, createdBy, visibility or fullTextFileId field — the SDL shape refuses them, not a convention', async () => {
  const rowLeaks = [
    'query{ publicLibraryEntries { rows { id searchText } } }',
    'query{ publicLibraryEntries { rows { id createdBy { id } } } }',
  ];
  for (const q of rowLeaks) {
    const bad = await exec(q);
    assert.ok(bad.errors.length > 0, `PublicEntryRow must not expose this field: ${q}`);
  }

  const entryLeaks = [
    'query($slug:String!){ publicLibraryEntry(slug:$slug){ id visibility } }',
    'query($slug:String!){ publicLibraryEntry(slug:$slug){ id fullTextFileId } }',
    'query($slug:String!){ publicLibraryEntry(slug:$slug){ id searchText } }',
  ];
  for (const q of entryLeaks) {
    const bad = await exec(q, { variables: { slug: 'whatever' } });
    assert.ok(bad.errors.length > 0, `PublicEntry must not expose this field: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// T2 — a draft, a private entry and a wrong slug are one answer
// ---------------------------------------------------------------------------

test('publicLibraryEntry returns null for a draft slug, a private entry slug, and nonsense — indistinguishably', async () => {
  const draft = await createEntry({ titleOriginal: 'Draft' });
  const priv = await createEntry({ titleOriginal: 'Private', visibility: 'PRIVATE' });
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: priv.id } }));

  const q = `query($slug: String!){ publicLibraryEntry(slug: $slug) { id } }`;
  for (const slug of [draft.slug, priv.slug, 'no-such-slug-at-all']) {
    const data = ok(await exec(q, { variables: { slug } }));
    assert.equal(data.publicLibraryEntry, null, slug);
  }
});

// ---------------------------------------------------------------------------
// §2.2 — a smaller, real ceiling, not just the general clampLimit unit test
// ---------------------------------------------------------------------------

test('limit: 999999 is clamped to the public ceiling (60), which is lower than the staff one (100)', async () => {
  const rows = Array.from({ length: 61 }, (_, i) => ({
    slug: `entry-${i}`,
    type: 'PAPER' as const,
    originalLang: 'en',
    titleOriginal: `Entry ${i}`,
    authors: 'A. Author',
    translationProvenance: 'NONE_YET' as const,
    rightsBasis: 'PUBLIC_DOMAIN' as const,
    visibility: 'PUBLIC' as const,
    publishedAt: new Date(),
    searchText: `entry ${i}`,
    createdById: contributor.id,
  }));
  await prisma.libraryEntry.createMany({ data: rows });

  const data = ok(await exec(PUBLIC_ENTRIES, { variables: { limit: 999999 } }));
  const { total, rows: got } = data.publicLibraryEntries as { total: number; rows: unknown[] };
  assert.equal(total, 61, 'the count itself is not clamped, only the page');
  assert.equal(got.length, 60);
});

// ---------------------------------------------------------------------------
// §5 — the R1 folding property, re-asserted through the public path
// ---------------------------------------------------------------------------

test('public search finds an entry typed with Arabic yeh/kaf when it was stored with Persian ones', async () => {
  const e = await createEntry({ titleOriginal: 'کتاب روان‌شناسی', originalLang: 'fa' });
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: e.id } }));

  const data = ok(await exec(PUBLIC_ENTRIES, { variables: { search: 'كتاب' } })); // Arabic kaf
  assert.equal((data.publicLibraryEntries as { total: number }).total, 1);
});

// ---------------------------------------------------------------------------
// conceptSlug — the filter the public list needs for a concept's own page
// ---------------------------------------------------------------------------

test('publicLibraryEntries filters by conceptSlug', async () => {
  const concept = ok(
    await exec(CREATE_CONCEPT, { as: contributor, variables: { input: { titleFa: 'روان‌شناسی', titleEn: 'Psychology' } } }),
  );
  const { id: conceptId, slug: conceptSlug } = concept.createLibraryConcept as { id: string; slug: string };

  const tagged = await createEntry({ titleOriginal: 'Tagged' });
  const untagged = await createEntry({ titleOriginal: 'Untagged' });
  ok(await exec(SET_CONCEPTS, { as: contributor, variables: { id: tagged.id, conceptIds: [conceptId] } }));
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: tagged.id } }));
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: untagged.id } }));

  const data = ok(await exec(PUBLIC_ENTRIES, { variables: { conceptSlug } }));
  const rows = (data.publicLibraryEntries as { rows: Array<{ titleOriginal: string }> }).rows;
  assert.deepEqual(rows.map((r) => r.titleOriginal), ['Tagged']);
});

// ---------------------------------------------------------------------------
// publicLibraryConcepts — only concepts a visitor could actually reach
// ---------------------------------------------------------------------------

test('publicLibraryConcepts omits a concept whose only entry is a draft', async () => {
  const draftOnly = ok(
    await exec(CREATE_CONCEPT, { as: contributor, variables: { input: { titleFa: 'پیش‌نویس', titleEn: 'DraftOnly' } } }),
  );
  const published = ok(
    await exec(CREATE_CONCEPT, { as: contributor, variables: { input: { titleFa: 'منتشرشده', titleEn: 'Published' } } }),
  );
  const draftOnlyId = (draftOnly.createLibraryConcept as { id: string }).id;
  const publishedId = (published.createLibraryConcept as { id: string }).id;

  const draftEntry = await createEntry({ titleOriginal: 'Draft holder' });
  ok(await exec(SET_CONCEPTS, { as: contributor, variables: { id: draftEntry.id, conceptIds: [draftOnlyId] } }));

  const pubEntry = await createEntry({ titleOriginal: 'Published holder' });
  ok(await exec(SET_CONCEPTS, { as: contributor, variables: { id: pubEntry.id, conceptIds: [publishedId] } }));
  ok(await exec(PUBLISH_ENTRY, { as: f.admin, variables: { id: pubEntry.id } }));

  const data = ok(await exec(PUBLIC_CONCEPTS));
  const names = (data.publicLibraryConcepts as Array<{ titleEn: string }>).map((c) => c.titleEn);
  assert.deepEqual(names, ['Published']);
});
