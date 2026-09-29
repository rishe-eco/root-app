import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, cookieFor, upload, PNG, PDF } from './http.js';
import { storage } from '../lib/storage.js';

/**
 * T2 — the theme catalogue (journeys build plan §5 "T2 + J8", the catalogue
 * half). Everything on a contract is J8's and is not here.
 *
 * Seven things: each capability's half (a designer writes, sales and admin
 * read as the plan says, nobody else touches it); the **widened private-file
 * CHECK**, proven by direct insert; `setTemplateTypeThemes` as a replace-all
 * that a refusal cannot half-apply; the demo link's https rule; the licence
 * cost as a decimal string; the preview upload and its download guards over a
 * real socket; and that a theme is deactivated, never deleted.
 */

let f: Fixture;
let base: string;
let close: () => Promise<void>;
const staff: Record<string, User> = {};

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
});

after(async () => {
  await close();
  await stop();
  await prisma.$disconnect();
});

// ---- documents --------------------------------------------------------------

const FIELDS = 'id name vendor demoUrl previewUrl rtlSupport licenseCost notesFa notesEn active typeIds';
const THEMES = `query($activeOnly: Boolean){ themes(activeOnly: $activeOnly) { ${FIELDS} } }`;
const CREATE = `mutation($name: String!, $vendor: String, $demoUrl: String, $rtl: RtlSupport, $cost: String, $fa: String, $en: String){
  createTheme(name: $name, vendor: $vendor, demoUrl: $demoUrl, rtlSupport: $rtl, licenseCost: $cost, notesFa: $fa, notesEn: $en) { ${FIELDS} } }`;
const UPDATE = `mutation($id: ID!, $name: String, $vendor: String, $demoUrl: String, $rtl: RtlSupport, $cost: String, $fa: String, $en: String, $active: Boolean){
  updateTheme(id: $id, name: $name, vendor: $vendor, demoUrl: $demoUrl, rtlSupport: $rtl, licenseCost: $cost, notesFa: $fa, notesEn: $en, active: $active) { ${FIELDS} } }`;
const ASSIGN = `mutation($typeId: ID!, $themeIds: [ID!]!){ setTemplateTypeThemes(typeId: $typeId, themeIds: $themeIds) { id typeIds } }`;

type ThemeOut = {
  id: string;
  name: string;
  vendor: string | null;
  demoUrl: string | null;
  previewUrl: string | null;
  rtlSupport: string;
  licenseCost: string | null;
  notesFa: string | null;
  notesEn: string | null;
  active: boolean;
  typeIds: string[];
};

const makeTheme = (name: string, over: { active?: boolean; licenseCost?: bigint } = {}) =>
  prisma.theme.create({ data: { name, ...over } });

const makeType = (slug: string) =>
  prisma.templateType.create({ data: { slug, labelFa: `نوع ${slug}`, labelEn: `Type ${slug}` } });

async function assignedTo(typeId: string): Promise<string[]> {
  const rows = await prisma.templateTypeTheme.findMany({ where: { typeId } });
  return rows.map((r) => r.themeId).sort();
}

// ---- the capability halves -----------------------------------------------------

type Actor = 'ADMIN' | 'SALES' | 'DESIGNER' | 'DEVELOPER' | 'CONTRIBUTOR' | 'REVIEWER' | 'CUSTOMER';
const actor = (name: Actor): User => (name === 'ADMIN' ? f.admin : name === 'CUSTOMER' ? f.customer : staff[name]);

test('writing is templates.types — the designer and admin; reading is any template capability or contracts.author', async () => {
  const type = await makeType('store');
  const theme = await makeTheme('Existing');
  // [who, may write, may read]. SALES reads through templates.scope and
  // contracts.author; DEVELOPER holds neither, only contracts.readActive.
  const table: Array<[Actor, boolean, boolean]> = [
    ['ADMIN', true, true],
    ['DESIGNER', true, true],
    ['SALES', false, true],
    ['DEVELOPER', false, false],
    ['CONTRIBUTOR', false, false],
    ['REVIEWER', false, false],
    ['CUSTOMER', false, false],
  ];
  let n = 0;
  for (const [who, mayWrite, mayRead] of table) {
    const as = actor(who);
    n += 1;
    const listed = await exec(THEMES, { as });
    assert.equal(listed.code, mayRead ? undefined : 'FORBIDDEN', `${who} themes`);
    const created = await exec(CREATE, { as, variables: { name: `T${n}` } });
    assert.equal(created.code, mayWrite ? undefined : 'FORBIDDEN', `${who} createTheme`);
    const updated = await exec(UPDATE, { as, variables: { id: theme.id, active: true } });
    assert.equal(updated.code, mayWrite ? undefined : 'FORBIDDEN', `${who} updateTheme`);
    const assigned = await exec(ASSIGN, { as, variables: { typeId: type.id, themeIds: [theme.id] } });
    assert.equal(assigned.code, mayWrite ? undefined : 'FORBIDDEN', `${who} setTemplateTypeThemes`);
  }
});

test('an anonymous caller is UNAUTHENTICATED on every operation', async () => {
  const theme = await makeTheme('Existing');
  assert.equal((await exec(THEMES)).code, 'UNAUTHENTICATED');
  assert.equal((await exec(CREATE, { variables: { name: 'x' } })).code, 'UNAUTHENTICATED');
  assert.equal((await exec(UPDATE, { variables: { id: theme.id, active: false } })).code, 'UNAUTHENTICATED');
  assert.equal((await exec(ASSIGN, { variables: { typeId: 'x', themeIds: [] } })).code, 'UNAUTHENTICATED');
});

test('FORBIDDEN comes before NOT_FOUND: a refused writer learns nothing about which ids exist', async () => {
  assert.equal((await exec(UPDATE, { as: staff.SALES, variables: { id: 'no-such-theme', active: false } })).code, 'FORBIDDEN');
  assert.equal((await exec(ASSIGN, { as: staff.SALES, variables: { typeId: 'no-such-type', themeIds: [] } })).code, 'FORBIDDEN');
  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: 'no-such-theme', active: false } })).code, 'NOT_FOUND');
  assert.equal((await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: 'no-such-type', themeIds: [] } })).code, 'NOT_FOUND');
});

// ---- money -----------------------------------------------------------------------

test('licenseCost is Root\'s cost, not customer money: the designer (no money.read) reads it, as a decimal string', async () => {
  // Fixture sanity: this is the role the comment in resolvers/themes.ts is about.
  const { can } = await import('../lib/capabilities.js');
  assert.equal(can(staff.DESIGNER, 'money.read'), false);

  const made = ok(
    await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'Costly', cost: '9223372036854775807' } }),
  ).createTheme as ThemeOut;
  // BigInt does not survive JSON; the boundary carries it as a string (rule 9),
  // and the largest value BIGINT holds survives the round trip exactly.
  assert.equal(made.licenseCost, '9223372036854775807');

  const listed = ok(await exec(THEMES, { as: staff.DESIGNER })).themes as ThemeOut[];
  assert.equal(listed[0].licenseCost, '9223372036854775807');
  // Sales, who does hold money.read, sees the same.
  const bySales = ok(await exec(THEMES, { as: staff.SALES })).themes as ThemeOut[];
  assert.equal(bySales[0].licenseCost, '9223372036854775807');
});

test('licenseCost is whole Toman: a sign, a fraction, letters, or more than BIGINT holds is INVALID_AMOUNT and writes nothing', async () => {
  for (const cost of ['-1', '12.5', '1e6', 'abc', '99999999999999999999']) {
    const r = await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'Bad', cost } });
    assert.equal(r.code, 'INVALID_AMOUNT', cost);
  }
  assert.equal(await prisma.theme.count(), 0);

  // Zero is a real cost (a free theme), distinct from none.
  const free = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'Free', cost: '0' } })).createTheme as ThemeOut;
  assert.equal(free.licenseCost, '0');
  const none = ok(await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'Unknown cost' } })).createTheme as ThemeOut;
  assert.equal(none.licenseCost, null);
});

// ---- create / update -------------------------------------------------------------

test('createTheme: defaults are UNKNOWN RTL and active; text is trimmed; a blank name is NAME_REQUIRED', async () => {
  const made = ok(
    await exec(CREATE, {
      as: staff.DESIGNER,
      variables: { name: '  Astra  ', vendor: ' Vendor Co ', demoUrl: 'https://demo.example.com/astra', fa: 'یادداشت', en: '' },
    }),
  ).createTheme as ThemeOut;
  assert.equal(made.name, 'Astra');
  assert.equal(made.vendor, 'Vendor Co');
  assert.equal(made.rtlSupport, 'UNKNOWN');
  assert.equal(made.active, true);
  assert.equal(made.previewUrl, null);
  assert.deepEqual(made.typeIds, []);
  assert.equal(made.notesFa, 'یادداشت');
  assert.equal(made.notesEn, null, 'an empty string means none');

  assert.equal((await exec(CREATE, { as: staff.DESIGNER, variables: { name: '   ' } })).code, 'NAME_REQUIRED');
});

test('updateTheme: omitted fields are left alone, an empty string clears an optional one, RTL support is changeable', async () => {
  const made = ok(
    await exec(CREATE, {
      as: staff.DESIGNER,
      variables: { name: 'Astra', vendor: 'V', demoUrl: 'https://d.example.com', cost: '500', rtl: 'PARTIAL', en: 'note' },
    }),
  ).createTheme as ThemeOut;

  const renamed = ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id: made.id, name: 'Astra 2' } })).updateTheme as ThemeOut;
  assert.equal(renamed.name, 'Astra 2');
  assert.equal(renamed.vendor, 'V');
  assert.equal(renamed.demoUrl, 'https://d.example.com');
  assert.equal(renamed.licenseCost, '500');
  assert.equal(renamed.rtlSupport, 'PARTIAL');
  assert.equal(renamed.notesEn, 'note');

  const cleared = ok(
    await exec(UPDATE, {
      as: staff.DESIGNER,
      variables: { id: made.id, vendor: '', demoUrl: '', cost: '', en: '', rtl: 'FULL' },
    }),
  ).updateTheme as ThemeOut;
  assert.equal(cleared.vendor, null);
  assert.equal(cleared.demoUrl, null);
  assert.equal(cleared.licenseCost, null);
  assert.equal(cleared.notesEn, null);
  assert.equal(cleared.rtlSupport, 'FULL');
  assert.equal(cleared.name, 'Astra 2');

  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: made.id, name: ' ' } })).code, 'NAME_REQUIRED');
  assert.equal((await exec(UPDATE, { as: staff.DESIGNER, variables: { id: 'nope', name: 'x' } })).code, 'NOT_FOUND');
});

// ---- the demo link ---------------------------------------------------------------

test('demoUrl is https only: http and other schemes are DEMO_URL_NOT_HTTPS, garbage is INVALID_DEMO_URL — on create and on update', async () => {
  for (const url of ['http://demo.example.com', 'ftp://demo.example.com', 'javascript:alert(1)', 'data:text/html,hi']) {
    const r = await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'X', demoUrl: url } });
    assert.equal(r.code, 'DEMO_URL_NOT_HTTPS', url);
  }
  for (const url of ['not a url', 'demo.example.com', 'https://', `https://example.com/${'a'.repeat(2100)}`]) {
    const r = await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'X', demoUrl: url } });
    assert.equal(r.code, 'INVALID_DEMO_URL', url.slice(0, 40));
  }
  assert.equal(await prisma.theme.count(), 0);

  const made = ok(
    await exec(CREATE, { as: staff.DESIGNER, variables: { name: 'X', demoUrl: 'https://demo.example.com/a?b=1' } }),
  ).createTheme as ThemeOut;
  const bad = await exec(UPDATE, { as: staff.DESIGNER, variables: { id: made.id, demoUrl: 'http://demo.example.com' } });
  assert.equal(bad.code, 'DEMO_URL_NOT_HTTPS');
  // A refused update leaves the theme as it was — including the fields that
  // would have been valid on their own.
  const worse = await exec(UPDATE, { as: staff.DESIGNER, variables: { id: made.id, name: 'Renamed', demoUrl: 'http://x' } });
  assert.equal(worse.code, 'DEMO_URL_NOT_HTTPS');
  const after = await prisma.theme.findUniqueOrThrow({ where: { id: made.id } });
  assert.equal(after.demoUrl, 'https://demo.example.com/a?b=1');
  assert.equal(after.name, 'X');
});

// ---- deactivate, never delete -------------------------------------------------------

test('a theme is deactivated, never deleted: activeOnly excludes it, the full list keeps it, its assignments survive', async () => {
  const type = await makeType('store');
  const keep = await makeTheme('Keep');
  const retire = await makeTheme('Retire');
  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [keep.id, retire.id] } }));

  const off = ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id: retire.id, active: false } })).updateTheme as ThemeOut;
  assert.equal(off.active, false);

  const activeOnly = ok(await exec(THEMES, { as: staff.SALES, variables: { activeOnly: true } })).themes as ThemeOut[];
  assert.deepEqual(activeOnly.map((t) => t.name), ['Keep']);
  const all = ok(await exec(THEMES, { as: staff.SALES, variables: { activeOnly: false } })).themes as ThemeOut[];
  assert.deepEqual(all.map((t) => t.name), ['Keep', 'Retire']);
  assert.deepEqual(await assignedTo(type.id), [keep.id, retire.id].sort(), 'deactivating does not unassign');

  const on = ok(await exec(UPDATE, { as: staff.DESIGNER, variables: { id: retire.id, active: true } })).updateTheme as ThemeOut;
  assert.equal(on.active, true);
  assert.deepEqual(on.typeIds, [type.id]);
});

test('there is no delete mutation for a theme', async () => {
  const theme = await makeTheme('Keep');
  const r = await exec(`mutation($id: ID!){ deleteTheme(id: $id) { id } }`, { as: f.admin, variables: { id: theme.id } });
  assert.ok(r.errors.length > 0, 'the schema has no such field');
  assert.equal(await prisma.theme.count(), 1);
});

// ---- assignment: replace-all ---------------------------------------------------------

test('setTemplateTypeThemes replaces the whole set for one type and touches no other', async () => {
  const store = await makeType('store');
  const blog = await makeType('blog');
  const [a, b, c] = [await makeTheme('A'), await makeTheme('B'), await makeTheme('C')];
  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: blog.id, themeIds: [a.id] } }));

  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: store.id, themeIds: [a.id, b.id] } }));
  assert.deepEqual(await assignedTo(store.id), [a.id, b.id].sort());

  const returned = ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: store.id, themeIds: [c.id] } }))
    .setTemplateTypeThemes as Array<{ id: string; typeIds: string[] }>;
  assert.deepEqual(await assignedTo(store.id), [c.id], 'the old set is gone, not merged');
  assert.deepEqual(await assignedTo(blog.id), [a.id], 'another type is untouched');
  // The payload is the whole catalogue with fresh assignments on both sides of the replace.
  const byId = Object.fromEntries(returned.map((t) => [t.id, t.typeIds.sort()]));
  assert.deepEqual(byId, { [a.id]: [blog.id], [b.id]: [], [c.id]: [store.id] });

  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: store.id, themeIds: [] } }));
  assert.deepEqual(await assignedTo(store.id), [], 'an empty list clears the type');
});

test('a refused replace-all changes nothing: an unknown theme (THEME_NOT_FOUND) or a repeated one (DUPLICATE_THEME)', async () => {
  const type = await makeType('store');
  const [a, b] = [await makeTheme('A'), await makeTheme('B')];
  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [a.id] } }));

  const unknown = await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [b.id, 'no-such-theme'] } });
  assert.equal(unknown.code, 'THEME_NOT_FOUND');
  const twice = await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [b.id, b.id] } });
  assert.equal(twice.code, 'DUPLICATE_THEME');
  assert.deepEqual(await assignedTo(type.id), [a.id], 'the old set survives both refusals');
});

test('an inactive theme may be assigned, and stays assigned across a replace that names it', async () => {
  const type = await makeType('store');
  const off = await makeTheme('Off', { active: false });
  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [off.id] } }));
  ok(await exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: [off.id] } }));
  assert.deepEqual(await assignedTo(type.id), [off.id]);
});

test('two concurrent replaces for one type land as one whole set, never a mixture (the type row is locked FOR UPDATE)', async () => {
  const type = await makeType('store');
  const themes = await Promise.all(['A', 'B', 'C', 'D'].map((n) => makeTheme(n)));
  const setOne = [themes[0].id, themes[1].id].sort();
  const setTwo = [themes[2].id, themes[3].id].sort();

  for (let round = 0; round < 5; round++) {
    const [r1, r2] = await Promise.all([
      exec(ASSIGN, { as: staff.DESIGNER, variables: { typeId: type.id, themeIds: setOne } }),
      exec(ASSIGN, { as: f.admin, variables: { typeId: type.id, themeIds: setTwo } }),
    ]);
    ok(r1);
    ok(r2);
    const final = await assignedTo(type.id);
    assert.ok(
      JSON.stringify(final) === JSON.stringify(setOne) || JSON.stringify(final) === JSON.stringify(setTwo),
      `round ${round}: ${final.length} rows, not one of the two sets`,
    );
  }
});

test('the pair is unique in the database: the same theme twice on one type is refused', async () => {
  const type = await makeType('store');
  const theme = await makeTheme('A');
  await prisma.templateTypeTheme.create({ data: { typeId: type.id, themeId: theme.id } });
  await assert.rejects(() => prisma.templateTypeTheme.create({ data: { typeId: type.id, themeId: theme.id } }), /Unique constraint/i);
});

// ---- the widened private-file CHECK ----------------------------------------------------

/**
 * `StoredFile_private_has_owner`, widened a second time by this stage's
 * migration. Proven by direct insert, not through the route: the route only
 * ever writes what it means to, and a CHECK exists for the write that is not
 * the route's.
 */
const file = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  class: 'THEME_PREVIEW' as const,
  visibility: 'PRIVATE' as const,
  mime: 'image/png',
  bytes: 10,
  originalName: 'x.png',
  uploadedById: f.admin.id,
  ...over,
});

test('the CHECK accepts a private THEME_PREVIEW owned by a theme alone, and refuses one that names no owner at all', async () => {
  const theme = await makeTheme('A');
  const accepted = await prisma.storedFile.create({ data: file('private/2026/09/theme-ok.png', { themeId: theme.id }) });
  assert.equal(accepted.contractId, null);
  assert.equal(accepted.projectId, null);

  await assert.rejects(
    () => prisma.storedFile.create({ data: file('private/2026/09/theme-orphan.png') }),
    /StoredFile_private_has_owner/,
  );
});

test('…and the two older owners are still accepted, so the widening removed nothing', async () => {
  const forContract = await prisma.storedFile.create({
    data: file('private/2026/09/c.png', { class: 'DESIGN_IMAGE', contractId: f.contract.id }),
  });
  assert.equal(forContract.themeId, null);
  const forProject = await prisma.storedFile.create({
    data: file('private/2026/09/p.xlsx', { class: 'SERVICE_IMPORT', projectId: f.contract.projectId! }),
  });
  assert.equal(forProject.contractId, null);
  // A PUBLIC file still needs no owner.
  await prisma.storedFile.create({ data: file('public/2026/09/pub.pdf', { class: 'RESEARCH_TEXT', visibility: 'PUBLIC' }) });
});

// ---- the preview upload and its guards --------------------------------------------------

const get = (id: string, opts: { as?: { id: string } | null } = {}) =>
  fetch(`${base}/files/${id}`, { headers: opts.as ? { cookie: cookieFor(opts.as) } : {}, redirect: 'manual' });

const put = (themeId: string | null, as: { id: string } | null, over: Parameters<typeof upload>[1] = {}) =>
  upload(base, { as, fileClass: 'THEME_PREVIEW', themeId, filename: 'preview.png', ...over });

test('a designer uploads a preview: the theme points at it, the row is private and owned by the theme, previewUrl serves it', async () => {
  const theme = await makeTheme('Astra');
  const res = await put(theme.id, staff.DESIGNER);
  assert.equal(res.status, 201);

  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: res.body!.id } });
  assert.equal(row.class, 'THEME_PREVIEW');
  assert.equal(row.visibility, 'PRIVATE');
  assert.equal(row.themeId, theme.id);
  assert.equal(row.contractId, null);
  assert.equal(row.projectId, null);
  assert.equal(row.mime, 'image/png');
  assert.ok(await storage.exists(row.key));
  assert.equal((await prisma.theme.findUniqueOrThrow({ where: { id: theme.id } })).previewFileId, row.id);

  const listed = ok(await exec(THEMES, { as: staff.DESIGNER })).themes as ThemeOut[];
  assert.equal(listed[0].previewUrl, `/files/${row.id}`);
  const served = await get(row.id, { as: staff.DESIGNER });
  assert.equal(served.status, 200);
  assert.match(served.headers.get('cache-control') ?? '', /^private,/);
  await served.arrayBuffer();
});

test('uploading again replaces the preview: the old row and its bytes are gone, the theme points at the new file', async () => {
  const theme = await makeTheme('Astra');
  const first = await put(theme.id, staff.DESIGNER);
  const firstRow = await prisma.storedFile.findUniqueOrThrow({ where: { id: first.body!.id } });
  const second = await put(theme.id, staff.DESIGNER);
  assert.equal(second.status, 201);

  assert.equal(await prisma.storedFile.findUnique({ where: { id: firstRow.id } }), null, 'the old row is deleted');
  assert.equal(await storage.exists(firstRow.key), false, 'and so are its bytes');
  assert.equal((await prisma.theme.findUniqueOrThrow({ where: { id: theme.id } })).previewFileId, second.body!.id);
  assert.equal(await prisma.storedFile.count({ where: { themeId: theme.id } }), 1);
});

test('who may upload: templates.types only — sales, developer, contributor, reviewer, customer and anonymous are refused', async () => {
  const theme = await makeTheme('Astra');
  assert.equal((await put(theme.id, null)).status, 401);
  for (const who of ['SALES', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER', 'CUSTOMER'] as Actor[]) {
    const res = await put(theme.id, actor(who));
    assert.equal(res.status, 403, who);
    assert.equal(res.body!.error, 'FORBIDDEN', who);
  }
  assert.equal((await put(theme.id, f.admin)).status, 201, 'admin holds every capability');
  assert.equal(await prisma.storedFile.count({ where: { class: 'THEME_PREVIEW' } }), 1, 'nothing was written by a refused upload');
});

test('the upload must name a theme that exists, and holds the class limits: THEME_REQUIRED, NOT_FOUND, type, size', async () => {
  const theme = await makeTheme('Astra');
  const missing = await put(null, staff.DESIGNER);
  assert.equal(missing.status, 400);
  assert.equal(missing.body!.error, 'THEME_REQUIRED');

  const unknown = await put('no-such-theme', staff.DESIGNER);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body!.error, 'NOT_FOUND');

  // SVG and PDF are not images this class accepts; what matters is the bytes.
  const pdf = await put(theme.id, staff.DESIGNER, { body: PDF, filename: 'preview.png', type: 'image/png' });
  assert.equal(pdf.status, 415);
  const big = await put(theme.id, staff.DESIGNER, { body: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) });
  assert.equal(big.status, 413);
  assert.equal(await prisma.storedFile.count(), 0);
  assert.equal((await prisma.theme.findUniqueOrThrow({ where: { id: theme.id } })).previewFileId, null);
});

test('a stray contractId on a theme upload is not stored: the customer of that contract still cannot read the preview', async () => {
  const theme = await makeTheme('Astra');
  const res = await put(theme.id, staff.DESIGNER, { contractId: f.contract.id });
  assert.equal(res.status, 201);
  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: res.body!.id } });
  assert.equal(row.contractId, null, 'only the owner edge the class names is written');
  assert.equal((await get(row.id, { as: f.customer })).status, 404);
});

test('who may download a preview: any staff contract reader or template-capability holder — never a customer, a stranger, or anyone signed out', async () => {
  const theme = await makeTheme('Astra');
  const id = (await put(theme.id, staff.DESIGNER)).body!.id;

  assert.equal((await get(id)).status, 401);
  const expected: Array<[Actor, number]> = [
    ['ADMIN', 200],
    ['DESIGNER', 200],
    ['SALES', 200],
    ['DEVELOPER', 200], // contracts.readActive
    ['CONTRIBUTOR', 404],
    ['REVIEWER', 404],
    ['CUSTOMER', 404],
  ];
  for (const [who, status] of expected) {
    const res = await get(id, { as: actor(who) });
    assert.equal(res.status, status, who);
    await res.arrayBuffer();
  }
  // A customer who owns a contract is still not staff: 404, the same answer as
  // for a file that does not exist.
  assert.equal((await get(id, { as: f.stranger })).status, 404);
});
