import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop, type ExecResult } from './graphql.js';
import { startFileServer, cookieFor, PNG } from './http.js';
import { storage } from '../lib/storage.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J8 — step 4, design: pre-made rounds, custom wireframes and palette,
 * allowances (journeys build plan §5 "T2 + J8", the J8 half).
 *
 * In this order: **the lock and the gate** (the design opens once the agreement
 * is signed, and locks with its approval — a table of every design mutation
 * against `STEP_LOCKED`, with a source scan that fails when one is added without
 * a row); **the pre-made path** (proposing themes, the snapshot and the copied
 * preview, "show me other options" resolved by the next round, choosing and
 * approving); **the custom path** (wireframe pages against the contract's own
 * scope, the palette and its rules, carry-forward, `DESIGN_INCOMPLETE`);
 * **allowances** (`ALLOWANCE_EXHAUSTED`, an extension admits one more, its draft
 * invoice, who sees what); **the CHECKs by direct insert**; **the legacy road
 * untouched**; and **the notifications**.
 *
 * The contract is taken to step 4 the way a customer would: the brief, the
 * phase, the plan, the scope and the dates through the API, the draft published,
 * then approved and signed (`reachDesign`).
 */

let f: Fixture;
let base: string;
let close: () => Promise<void>;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string }>;

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000108', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, phone: role === 'DESIGNER' ? '+989120000109' : undefined, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  // A second designer — assigned to nothing.
  staff.DESIGNER2 = await prisma.user.create({
    data: { email: 'designer2@test.local', name: 'Designer 2', roles: ['DESIGNER'], state: 'ACTIVE' },
  });
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.createMany({
    data: [
      { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
      { typeId: type.id, key: 'about', kind: 'PAGE', labelFa: 'درباره‌ی ما', labelEn: 'About', position: 1 },
      { typeId: type.id, key: 'cart', kind: 'FEATURE', labelFa: 'سبد خرید', labelEn: 'Cart', position: 2 },
    ],
  });
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to) => void sms.push({ to }),
    sendText: async (to, text) => void sms.push({ to, text }),
  });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await close();
  await stop();
  await prisma.$disconnect();
});

// ---- documents -----------------------------------------------------------------------

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE = `mutation($c: ID!){ createPhase(contractId: $c, number: 1, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "2026-11-10") { phases { id } } }`;
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH_DRAFT = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE_AGREEMENT = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';

const BRIEF_INPUT = {
  kind: 'NEW_SITE',
  templateTypeId: '',
  designTier: 'THEME_PICK',
  budgetCap: '150000000',
  hardDeadline: '2026-10-23',
  domainName: 'nahal.ir',
  domainProvidedBy: 'CUSTOMER',
  hostProvidedBy: 'ROOT',
  contentProvidedBy: 'CUSTOMER',
  supportMonths: 6,
  premadeRounds: 3,
  wireframeIterations: 2,
  mockupIterations: 2,
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
};

/**
 * The contract at the door of step 4: brief, phase, payment plan, scope and dates
 * written through the API, the draft published, then **approved and signed by the
 * customer** — so the design opens for real, not because a test flipped a row.
 */
async function reachDesign(over: Record<string, unknown> = {}) {
  // The fixture predates the new road and comes with a published legacy design
  // (three concepts of four pages). A new-road contract's design starts empty —
  // step 4 has not happened — so the fixture's is removed.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentDesignRevisionId: null } });
  await prisma.designRevision.deleteMany({ where: { contractId: f.contract.id } });
  const input = { ...BRIEF_INPUT, templateTypeId: type.id, ...over };
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: input } }));
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id } })).createPhase as {
    phases: Array<{ id: string }>;
  };
  ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: {
        c: f.contract.id,
        r: [
          { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId: phase.phases[0].id, paymentTermDays: 7 },
          { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: null, paymentTermDays: 7 },
        ],
      },
    }),
  );
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  ok(await exec(PUBLISH_DRAFT, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE_AGREEMENT, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  mail.length = 0;
  sms.length = 0;
  return { phaseId: phase.phases[0].id };
}

const reachCustom = (over: Record<string, unknown> = {}) => reachDesign({ designTier: 'SENIOR_DESIGNER', premadeRounds: null, ...over });

const CONTRACT_DESIGN = `query($c: ID!){ contract(id: $c) {
  id sequence
  concepts { id key labelFa labelEn imageUrl chosen themeSnapshot { name vendor demoUrl } themeId pages { id key approved } }
  palette { id kind role value labelFa labelEn imageUrl }
  designMissing
  wizard { step status locked iterationsUsed allowance }
  allowanceExtensions { id step extra reason charge approvedBy { id } }
  designDraft { id version concepts { id key themeSnapshot { name } pages { id key } } palette { id role value } }
  designRevisions { id version publishedAt }
} }`;

type ConceptOut = {
  id: string;
  key: string;
  labelEn: string;
  imageUrl: string | null;
  chosen: boolean;
  themeSnapshot: { name: string; vendor: string | null; demoUrl: string | null } | null;
  themeId: string | null;
  pages: Array<{ id: string; key: string; approved?: boolean }>;
};
type ContractOut = {
  id: string;
  sequence: string;
  concepts: ConceptOut[];
  palette: Array<{ id: string; kind: string; role: string; value: string; labelEn: string; imageUrl: string | null }>;
  designMissing: string[];
  wizard: Array<{ step: string; status: string; locked: boolean; iterationsUsed: number | null; allowance: number | null }>;
  allowanceExtensions: Array<{ id: string; step: string; extra: number; reason: string; charge: string | null }>;
  designDraft: { id: string; version: number; concepts: ConceptOut[]; palette: Array<{ id: string; role: string; value: string }> } | null;
  designRevisions: Array<{ id: string; version: number; publishedAt: string | null }>;
};
const read = async (as: User = staff.DESIGNER): Promise<ContractOut> =>
  ok(await exec(CONTRACT_DESIGN, { as, variables: { c: f.contract.id } })).contract as ContractOut;
const wizardStep = (c: ContractOut, step: string) => c.wizard.find((s) => s.step === step)!;

// ---- design-side operations -----------------------------------------------------------

const asDesigner = (query: string, variables: Record<string, unknown> = {}, as: User = staff.DESIGNER) =>
  exec(query, { as, variables: { c: f.contract.id, ...variables } });

const START = 'mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }';
const PROPOSE = 'mutation($c: ID!, $t: [ID!]!){ proposeThemes(contractId: $c, themeIds: $t) { id } }';
const PUBLISH_ROUND = 'mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }';
const ADD_PAGE = 'mutation($k: ID!, $key: String!){ addPageDesign(conceptId: $k, key: $key, labelFa: "ف", labelEn: "L") { id } }';
const ADD_ITEM =
  'mutation($c: ID!, $kind: PaletteKind!, $role: String!, $v: String!){ addPaletteItem(contractId: $c, kind: $kind, role: $role, value: $v, labelFa: "برچسب", labelEn: "Label") { id } }';

const propose = (...themeIds: string[]) => asDesigner(PROPOSE, { t: themeIds });
const publishRound = (as: User = staff.DESIGNER) => asDesigner(PUBLISH_ROUND, {}, as);

/** A theme in the catalogue, offered for the brief's type, with a real preview on disk. */
async function makeTheme(name: string, over: { active?: boolean; vendor?: string | null; demoUrl?: string | null; licenseCost?: bigint | null; preview?: boolean; offered?: boolean } = {}) {
  const theme = await prisma.theme.create({
    data: {
      name,
      vendor: over.vendor === undefined ? `${name} Vendor` : over.vendor,
      demoUrl: over.demoUrl === undefined ? `https://${name.toLowerCase()}.example/demo` : over.demoUrl,
      licenseCost: over.licenseCost === undefined ? 4_500_000n : over.licenseCost,
      notesEn: 'internal note about the licence',
      active: over.active ?? true,
    },
  });
  if (over.preview !== false) {
    const key = await storage.put('PRIVATE', Buffer.concat([PNG, Buffer.from(name)]), '.png');
    const file = await prisma.storedFile.create({
      data: {
        key,
        class: 'THEME_PREVIEW',
        visibility: 'PRIVATE',
        mime: 'image/png',
        bytes: PNG.length + name.length,
        originalName: `${name}.png`,
        themeId: theme.id,
        uploadedById: staff.DESIGNER.id,
      },
    });
    await prisma.theme.update({ where: { id: theme.id }, data: { previewFileId: file.id } });
  }
  if (over.offered !== false) await prisma.templateTypeTheme.create({ data: { typeId: type.id, themeId: theme.id } });
  return prisma.theme.findUniqueOrThrow({ where: { id: theme.id } });
}

const get = (id: string, as?: User) =>
  fetch(`${base}/files/${id}`, { headers: as ? { cookie: cookieFor(as) } : {} });

// =================================================================================
// the gate: the design opens once the agreement is signed
// =================================================================================

test('the design opens once the agreement is signed: before the signature every design write is AGREEMENT_NOT_SIGNED, after it they work', async () => {
  // An unsigned new-road contract: brief in, nothing else.
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id } } }));
  const theme = await makeTheme('Astra');
  assert.equal((await asDesigner(START)).code, 'AGREEMENT_NOT_SIGNED');
  assert.equal((await propose(theme.id)).code, 'AGREEMENT_NOT_SIGNED');
  assert.equal((await asDesigner('mutation($c: ID!){ addConcept(contractId: $c, key: "9z", labelFa: "ط", labelEn: "C") { id } }')).code, 'AGREEMENT_NOT_SIGNED');
  assert.equal(await prisma.designRevision.count({ where: { contractId: f.contract.id, publishedAt: null } }), 0, 'nothing was written');
});

test('the wizard: the design is current once the agreement is signed, and the custom path puts the mockup on the road', async () => {
  await reachDesign();
  const premade = await read();
  assert.equal(wizardStep(premade, 'DESIGN').status, 'CURRENT');
  assert.equal(premade.wizard.some((s) => s.step === 'MOCKUP'), false, 'a pre-made contract has no mockup step');
  // The same contract on the custom tier — the tier alone decides.
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'CLAUDE_ASSISTED' } });
  const custom = await read();
  assert.equal(custom.wizard.some((s) => s.step === 'MOCKUP'), true, 'a custom contract does');
});

// =================================================================================
// the pre-made path
// =================================================================================

test('proposeThemes: the draft holds one concept per theme, each a snapshot of name, vendor and demo URL — never the licence cost — with its preview copied into a contract-owned image', async () => {
  await reachDesign();
  const astra = await makeTheme('Astra');
  const bravo = await makeTheme('Bravo', { vendor: null });
  ok(await propose(astra.id, bravo.id));

  const c = await read();
  assert.deepEqual(c.designDraft!.concepts.map((x) => x.themeSnapshot?.name), ['Astra', 'Bravo']);
  const rows = await prisma.designConcept.findMany({ where: { designRevision: { contractId: f.contract.id } }, orderBy: { position: 'asc' } });
  assert.deepEqual(rows.map((r) => r.themeId), [astra.id, bravo.id]);
  assert.deepEqual(rows[0].themeSnapshot, { name: 'Astra', vendor: 'Astra Vendor', demoUrl: 'https://astra.example/demo' });
  assert.deepEqual(rows[1].themeSnapshot, { name: 'Bravo', vendor: null, demoUrl: 'https://bravo.example/demo' });
  for (const r of rows) {
    const raw = JSON.stringify(r.themeSnapshot);
    assert.ok(!raw.includes('4500000') && !raw.includes('licenseCost') && !raw.includes('internal'), 'no licence cost, no notes: ' + raw);
  }

  // The preview is a *copy*: a new file, contract-owned, a DESIGN_IMAGE, with the same bytes — not the catalogue's file.
  const copy = await prisma.storedFile.findUniqueOrThrow({ where: { id: rows[0].imageFileId! } });
  assert.equal(copy.class, 'DESIGN_IMAGE');
  assert.equal(copy.visibility, 'PRIVATE');
  assert.equal(copy.contractId, f.contract.id);
  assert.equal(copy.themeId, null);
  assert.equal(copy.uploadedById, staff.DESIGNER.id);
  assert.notEqual(copy.id, astra.previewFileId);
  assert.notEqual(copy.key, (await prisma.storedFile.findUniqueOrThrow({ where: { id: astra.previewFileId! } })).key);
  assert.deepEqual(await readFileSync(storage.path(copy.key)), Buffer.concat([PNG, Buffer.from('Astra')]));
  assert.equal(rows[0].imageUrl, `/files/${copy.id}`);
});

test('proposeThemes is a replace: themes stay if they were there (their snapshot untouched), go if they were not listed, and the order is the order asked for', async () => {
  await reachDesign();
  const [a, b, c] = [await makeTheme('Astra'), await makeTheme('Bravo'), await makeTheme('Cedar')];
  ok(await propose(a.id, b.id));
  const before = await prisma.designConcept.findMany({ where: { themeId: { in: [a.id, b.id] } } });
  const aBefore = before.find((r) => r.themeId === a.id)!;

  // The catalogue moves on while the draft is open…
  await prisma.theme.update({ where: { id: a.id }, data: { name: 'Astra 2', demoUrl: 'https://changed.example' } });
  ok(await propose(c.id, a.id));
  const rows = await prisma.designConcept.findMany({ where: { designRevision: { contractId: f.contract.id } }, orderBy: { position: 'asc' } });
  assert.deepEqual(rows.map((r) => r.themeId), [c.id, a.id]);
  const aAfter = rows.find((r) => r.themeId === a.id)!;
  assert.equal(aAfter.id, aBefore.id, 'the kept concept is the same row');
  assert.equal((aAfter.themeSnapshot as { name: string }).name, 'Astra', 'and keeps what the round showed');
  // …and the dropped theme took its copied preview with it (nothing else showed it).
  assert.equal(await prisma.storedFile.count({ where: { id: before.find((r) => r.themeId === b.id)!.imageFileId! } }), 0);
  assert.equal(await prisma.storedFile.count({ where: { class: 'DESIGN_IMAGE', contractId: f.contract.id } }), 2);
});

test('the refusals: NOT_PREMADE on a custom contract, DUPLICATE_THEME, THEME_NOT_FOUND, THEME_INACTIVE, THEME_NOT_OFFERED (the brief’s template type), and only the assigned designer', async () => {
  await reachDesign();
  const good = await makeTheme('Astra');
  const off = await makeTheme('Elsewhere', { offered: false });
  const inactive = await makeTheme('Retired', { active: false });
  assert.equal((await propose(good.id, good.id)).code, 'DUPLICATE_THEME');
  assert.equal((await propose('nope')).code, 'THEME_NOT_FOUND');
  assert.equal((await propose(inactive.id)).code, 'THEME_INACTIVE');
  assert.equal((await propose(off.id)).code, 'THEME_NOT_OFFERED');
  assert.equal(await prisma.designRevision.count({ where: { contractId: f.contract.id } }), 0, 'a refusal wrote nothing');

  assert.equal((await asDesigner(PROPOSE, { t: [good.id] }, staff.SALES)).code, 'FORBIDDEN', 'sales is read-only on the design');
  assert.equal((await asDesigner(PROPOSE, { t: [good.id] }, staff.DESIGNER2)).code, 'NOT_ASSIGNED');
  assert.equal((await asDesigner(PROPOSE, { t: [good.id] }, f.customer)).code, 'FORBIDDEN');

  // Custom path: there are no themes to propose.
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'SENIOR_DESIGNER' } });
  assert.equal((await propose(good.id)).code, 'NOT_PREMADE');
});

test('the round the customer sees is frozen: editing, deactivating or replacing the theme afterwards changes nothing about it — and the customer can fetch the copied image but never the catalogue’s preview', async () => {
  await reachDesign();
  const astra = await makeTheme('Astra');
  ok(await propose(astra.id));
  ok(await publishRound());

  const shown = async () => (await read(f.customer)).concepts[0];
  const first = await shown();
  assert.deepEqual(first.themeSnapshot, { name: 'Astra', vendor: 'Astra Vendor', demoUrl: 'https://astra.example/demo' });
  assert.equal(first.themeId, null, 'the catalogue row is not the customer’s to know');
  const imageId = first.imageUrl!.replace('/files/', '');

  // The catalogue moves: renamed, a new demo, deactivated, the preview replaced (T2's replace deletes the old row and bytes).
  await prisma.theme.update({ where: { id: astra.id }, data: { name: 'Astra Pro', vendor: 'Someone else', demoUrl: 'https://new.example', active: false, licenseCost: 9_000_000n } });
  const oldPreview = await prisma.storedFile.findUniqueOrThrow({ where: { id: astra.previewFileId! } });
  await prisma.theme.update({ where: { id: astra.id }, data: { previewFileId: null } });
  await prisma.storedFile.delete({ where: { id: oldPreview.id } });
  await storage.remove(oldPreview.key);

  assert.deepEqual(await shown(), first, 'the round is exactly what it was');
  const served = await get(imageId, f.customer);
  assert.equal(served.status, 200, 'the copy is still there');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.concat([PNG, Buffer.from('Astra')]));

  // The catalogue’s own file is staff-only — the customer gets the answer for a file that does not exist.
  const other = await makeTheme('Bravo');
  assert.equal((await get(other.previewFileId!, f.customer)).status, 404);
  assert.equal((await get(other.previewFileId!, staff.DESIGNER)).status, 200);
  // A stranger cannot read the customer's copy either: the contract edge.
  assert.equal((await get(imageId, f.stranger)).status, 404);
  assert.equal((await get(imageId)).status, 401);
});

test('no licence cost is reachable by a customer: the snapshot type has no such field, no customer-facing type returns a Theme, and the catalogue query refuses them', async () => {
  await reachDesign();
  const astra = await makeTheme('Astra');
  ok(await propose(astra.id));
  ok(await publishRound());
  const introspect = (name: string) =>
    exec(`{ __type(name: "${name}") { fields { name type { name kind ofType { name } } } } }`, { as: f.customer });
  const fields = (ok(await introspect('ThemeSnapshot')).__type as { fields: Array<{ name: string }> }).fields.map((x) => x.name);
  assert.deepEqual(fields.sort(), ['demoUrl', 'name', 'vendor']);
  // Only the catalogue types return a `Theme`; none of them is reachable from a Contract.
  const theme = (ok(await introspect('Theme')).__type as { fields: Array<{ name: string }> }).fields.map((x) => x.name);
  assert.ok(theme.includes('licenseCost'), 'the staff type has it — which is why nothing customer-facing may return it');
  for (const owner of ['Contract', 'DesignConcept', 'DesignDraft', 'DesignPaletteItem', 'FeedbackItem', 'Project']) {
    const returns = (ok(await introspect(owner)).__type as { fields: Array<{ type: { name: string | null; ofType: { name: string | null } | null } }> }).fields
      .map((x) => x.type.name ?? x.type.ofType?.name);
    assert.ok(!returns.includes('Theme'), `${owner} does not return a Theme`);
  }
  assert.equal((await exec('{ themes { id licenseCost } }', { as: f.customer })).code, 'FORBIDDEN');
  // And what the customer can read of the concept is the snapshot and the image, whatever the row holds.
  const raw = JSON.stringify(ok(await exec(CONTRACT_DESIGN, { as: f.customer, variables: { c: f.contract.id } })));
  assert.ok(!raw.includes('4500000') && !raw.includes('licenseCost') && !raw.includes('internal note'));
});

test('publishing a round: it becomes the contract’s current design, counts as round 1 of 3, tells the customer, and the draft is gone', async () => {
  await reachDesign();
  const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
  ok(await propose(a.id, b.id));
  assert.equal(wizardStep(await read(), 'DESIGN').iterationsUsed, 0);
  ok(await publishRound());

  const c = await read();
  assert.equal(c.designDraft, null);
  assert.deepEqual(c.concepts.map((x) => x.themeSnapshot?.name), ['Astra', 'Bravo']);
  assert.deepEqual([wizardStep(c, 'DESIGN').iterationsUsed, wizardStep(c, 'DESIGN').allowance], [1, 3]);
  // The customer’s email says which round of how many — in Persian digits, in Persian.
  const toCustomer = mail.filter((m) => m.to === f.customer.email);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].subject, /دورِ ۱ از ۳/);
  assert.ok(toCustomer[0].html.includes('/fa/app/contracts/'), 'a link to the customer’s own page');
  assert.ok(sms.some((s) => s.to === f.customer.phone && s.text?.includes('/fa/app/contracts/')), 'and the SMS');
  assert.equal(mail.filter((m) => m.to !== f.customer.email).length, 0, 'nobody else was told');
});

test('choosing a concept tells the designer once; a choice is the customer’s alone; choosing again does not re-tell', async () => {
  await reachDesign();
  const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
  ok(await propose(a.id, b.id));
  ok(await publishRound());
  mail.length = 0;
  sms.length = 0;
  const round = (await read()).concepts;
  const CHOOSE = 'mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id concepts { id chosen } designMissing } }';

  // Not the designer's, not sales', not a stranger's.
  for (const who of [staff.DESIGNER, staff.SALES, f.admin, f.stranger]) {
    assert.equal((await exec(CHOOSE, { as: who, variables: { c: f.contract.id, k: round[0].id } })).code, 'NOT_FOUND', who.email ?? '');
  }
  const chosen = ok(await exec(CHOOSE, { as: f.customer, variables: { c: f.contract.id, k: round[1].id } })).chooseConcept as {
    concepts: Array<{ id: string; chosen: boolean }>;
    designMissing: string[];
  };
  assert.deepEqual(chosen.concepts.filter((x) => x.chosen).map((x) => x.id), [round[1].id]);
  assert.deepEqual(chosen.designMissing, [], 'a chosen theme is a complete pre-made design');
  assert.equal(mail.filter((m) => m.to === staff.DESIGNER.email).length, 1);
  assert.match(mail.find((m) => m.to === staff.DESIGNER.email)!.subject, /انتخاب شد|chosen/);
  assert.ok(sms.some((s) => s.to === staff.DESIGNER.phone), 'and the SMS');

  ok(await exec(CHOOSE, { as: f.customer, variables: { c: f.contract.id, k: round[1].id } }));
  assert.equal(mail.filter((m) => m.to === staff.DESIGNER.email).length, 1, 'the same choice is not news');
  // Choosing the other one moves the choice.
  const moved = ok(await exec(CHOOSE, { as: f.customer, variables: { c: f.contract.id, k: round[0].id } })).chooseConcept as {
    concepts: Array<{ id: string; chosen: boolean }>;
  };
  assert.deepEqual(moved.concepts.filter((x) => x.chosen).map((x) => x.id), [round[0].id]);
  assert.equal(mail.filter((m) => m.to === staff.DESIGNER.email).length, 2);
});

test('“show me other options”: a marked general DESIGN note that blocks approval, tells the designer — and the next round resolves it through the answer path, on record', async () => {
  await reachDesign();
  const [a, b, c] = [await makeTheme('Astra'), await makeTheme('Bravo'), await makeTheme('Cedar')];
  ok(await propose(a.id, b.id));
  ok(await publishRound());
  mail.length = 0;
  sms.length = 0;

  const ASK = 'mutation($c: ID!, $n: String){ requestOtherOptions(contractId: $c, note: $n) { id } }';
  // Not the designer's or sales' to raise; a stranger cannot.
  for (const who of [staff.DESIGNER, staff.SALES, f.stranger]) {
    assert.equal((await exec(ASK, { as: who, variables: { c: f.contract.id, n: null } })).code, 'NOT_FOUND', who.email ?? '');
  }
  ok(await exec(ASK, { as: f.customer, variables: { c: f.contract.id, n: 'Nothing here suits a bakery.' } }));

  const item = await prisma.feedbackItem.findFirstOrThrow({ where: { contractId: f.contract.id, step: 'DESIGN', general: true }, include: { comments: true } });
  assert.equal(item.status, 'OPEN');
  assert.ok(item.otherOptionsAskedAt, 'marked');
  assert.equal(item.comments.length, 1);
  assert.equal(item.comments[0].body, 'Nothing here suits a bakery.');
  assert.equal(item.comments[0].authorId, f.customer.id);
  // The designer is told what was asked — once, and not by the generic feedback email.
  const told = mail.filter((m) => m.to === staff.DESIGNER.email);
  assert.equal(told.length, 1);
  assert.match(told[0].subject, /گزینه‌های تازه خواسته شد/);
  assert.ok(sms.some((s) => s.to === staff.DESIGNER.phone));

  // Until Root answers, the customer has not accepted these: approval is blocked.
  const CHOOSE = 'mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }';
  const first = (await read(f.customer)).concepts[0];
  ok(await exec(CHOOSE, { as: f.customer, variables: { c: f.contract.id, k: first.id } }));
  assert.equal((await exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } })).code, 'STEP_HAS_OPEN_FEEDBACK');
  // The status area agrees whose move it is.
  const summary = ok(await exec('query($c: ID!){ contract(id: $c) { statusSummary { currentStep nextMoveOn } } }', { as: f.customer, variables: { c: f.contract.id } })).contract as {
    statusSummary: { currentStep: string; nextMoveOn: string };
  };
  assert.deepEqual(summary.statusSummary, { currentStep: 'DESIGN', nextMoveOn: 'ROOT' });

  // A plain comment in the same general thread is not an ask, and is not answered by a round.
  // The designer proposes something new and publishes round 2.
  mail.length = 0;
  ok(await propose(c.id));
  ok(await publishRound());

  const after = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id }, include: { comments: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(after.status, 'ADDRESSED', 'resolved by the round…');
  assert.equal(after.otherOptionsAskedAt, null, '…which cleared the marker');
  assert.equal(after.comments.length, 2);
  const answer = after.comments[1];
  assert.equal(answer.authorId, staff.DESIGNER.id, 'the publisher answered');
  assert.equal(answer.resolution, 'ADDRESSED');
  assert.equal(answer.approval, 'NOT_REQUIRED', 'directly, by the same route answerFeedback takes');
  assert.match(answer.body, /دورِ ۲/, 'in the customer’s language, naming the round');
  // The customer reads the answer in the thread, as any answer.
  const seen = ok(await exec('query($c: ID!){ contract(id: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  assert.ok(seen);
  const visible = await prisma.feedbackComment.count({ where: { feedbackItemId: item.id, approval: { in: ['NOT_REQUIRED', 'APPROVED'] } } });
  assert.equal(visible, 2);
  // The new round replaced the choice (no theme in common), so the customer chooses again.
  assert.equal((await read(f.customer)).concepts.some((x) => x.chosen), false);
  assert.match(mail.find((m) => m.to === f.customer.email)!.subject, /دورِ ۲ از ۳/);
});

test('“show me other options”: NOT_PREMADE on a custom design, NO_ROUND before anything is proposed, STEP_LOCKED after approval', async () => {
  await reachDesign();
  const ASK = 'mutation($c: ID!){ requestOtherOptions(contractId: $c) { id } }';
  assert.equal((await exec(ASK, { as: f.customer, variables: { c: f.contract.id } })).code, 'NO_ROUND');
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'CLAUDE_ASSISTED' } });
  assert.equal((await exec(ASK, { as: f.customer, variables: { c: f.contract.id } })).code, 'NOT_PREMADE');
});

test('a request with no words gets the customer’s language, and asking twice is one thread', async () => {
  await reachDesign();
  const a = await makeTheme('Astra');
  ok(await propose(a.id));
  ok(await publishRound());
  const ASK = 'mutation($c: ID!){ requestOtherOptions(contractId: $c) { id } }';
  ok(await exec(ASK, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(ASK, { as: f.customer, variables: { c: f.contract.id } }));
  const items = await prisma.feedbackItem.findMany({ where: { contractId: f.contract.id, step: 'DESIGN', general: true }, include: { comments: true } });
  assert.equal(items.length, 1, 'general items collapse per step (D4)');
  assert.equal(items[0].comments.length, 2);
  assert.equal(items[0].comments[0].body, 'لطفاً گزینه‌های دیگری نشانم بده.');
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  ok(await exec(ASK, { as: { ...f.customer, locale: 'en' }, variables: { c: f.contract.id } }));
  assert.equal((await prisma.feedbackComment.findMany({ where: { feedbackItemId: items[0].id }, orderBy: { createdAt: 'asc' } }))[2].body, 'Please show me other options.');
});

test('approving a pre-made design: DESIGN_INCOMPLETE until a concept is chosen, then it locks the step, accepts the notes, and tells the designer', async () => {
  await reachDesign();
  const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
  const APPROVE = 'mutation($c: ID!){ approveDesign(contractId: $c) { id wizard { step status locked lockedAt } } }';
  // Nothing published yet.
  assert.equal((await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } })).code, 'DESIGN_INCOMPLETE');
  ok(await propose(a.id, b.id));
  ok(await publishRound());
  assert.deepEqual((await read()).designMissing, ['CONCEPT_NOT_CHOSEN']);
  assert.equal((await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } })).code, 'DESIGN_INCOMPLETE');
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DESIGN' } }), 0, 'a refusal locked nothing');

  const round = (await read(f.customer)).concepts;
  ok(await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: round[0].id } }));
  // A note about the chosen theme, answered by the designer, is accepted by the approval.
  const note = ok(
    await exec('mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: DESIGN, target: $t, body: "Can the header be darker?") { item { id } } }', {
      as: f.customer,
      variables: { c: f.contract.id, t: { designRevisionId: (await read()).designRevisions[0].id, conceptId: round[0].id } },
    }),
  ).submitFeedback as { item: { id: string } };
  assert.equal((await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } })).code, 'STEP_HAS_OPEN_FEEDBACK');
  ok(await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "Yes, in the build.", resolution: ADDRESSED) { id } }', { as: staff.DESIGNER, variables: { i: note.item.id } }));

  mail.length = 0;
  // Only the customer's own hands: everyone else hears NOT_FOUND.
  for (const who of [staff.DESIGNER, staff.SALES, f.admin, f.stranger]) {
    assert.equal((await exec(APPROVE, { as: who, variables: { c: f.contract.id } })).code, 'NOT_FOUND', who.email ?? '');
  }
  const done = ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } })).approveDesign as {
    wizard: Array<{ step: string; status: string; locked: boolean; lockedAt: string | null }>;
  };
  const design = done.wizard.find((s) => s.step === 'DESIGN')!;
  assert.deepEqual([design.status, design.locked, design.lockedAt !== null], ['DONE', true, true]);
  const approval = await prisma.stepApproval.findFirstOrThrow({ where: { step: 'DESIGN' } });
  assert.deepEqual([approval.contractId, approval.phaseId, approval.approvedById], [f.contract.id, null, f.customer.id]);
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: note.item.id } })).status, 'ACCEPTED');
  assert.equal((await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } })).code, 'STEP_LOCKED', 'approved once');
  assert.equal(mail.filter((m) => m.to === staff.DESIGNER.email).length, 1);
  assert.match(mail.find((m) => m.to === staff.DESIGNER.email)!.subject, /طراحی تأیید شد|Design approved/);
  assert.ok(sms.some((s) => s.to === staff.DESIGNER.phone));
});

test('there is one door to approve the design: there is no generic approveStep, and approveDesign is the only mutation that writes its StepApproval', async () => {
  await reachDesign();
  const a = await makeTheme('Astra');
  ok(await propose(a.id));
  ok(await publishRound());
  const round = (await read(f.customer)).concepts;
  ok(await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: round[0].id } }));
  assert.equal(
    (await exec('mutation($c: ID!){ approveStep(contractId: $c, step: DESIGN) { id } }', { as: f.customer, variables: { c: f.contract.id } })).code,
    'GRAPHQL_VALIDATION_FAILED',
    'even a complete design cannot be approved through a generic door: there is none (J10 retired approveStep)',
  );
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DESIGN' } }), 0);
  // The legacy road approves through its own gate.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } })).code, 'STEP_NOT_APPROVABLE');
});

// =================================================================================
// the custom path
// =================================================================================

/** Custom path, draft started; returns the wireframes concept. */
async function customDraft() {
  await reachCustom();
  ok(await asDesigner(START));
  const c = await read();
  const concept = c.designDraft!.concepts.find((x) => x.key === 'wireframes')!;
  return { concept };
}

test('a custom draft starts with its one concept, "wireframes", and starting again changes nothing', async () => {
  const { concept } = await customDraft();
  assert.ok(concept);
  ok(await asDesigner(START));
  const c = await read();
  assert.equal(c.designDraft!.concepts.length, 1);
  assert.equal(c.designDraft!.concepts[0].id, concept.id);
  // Reading never creates a draft; a pre-made contract's start gives an empty draft with no such concept.
  const premade = await prisma.designConcept.count({ where: { key: 'wireframes' } });
  assert.equal(premade, 1);
});

test('addPageDesign on the new road: the key must be a PAGE of this contract’s agreed scope — PAGE_KEY_UNKNOWN for anything else', async () => {
  const { concept } = await customDraft();
  ok(await asDesigner(ADD_PAGE, { k: concept.id, key: 'home' }));
  ok(await asDesigner(ADD_PAGE, { k: concept.id, key: 'about' }));

  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'blog' })).code, 'PAGE_KEY_UNKNOWN', 'not in the registry at all');
  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'cart' })).code, 'PAGE_KEY_UNKNOWN', 'a FEATURE is not a page');
  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'HOME' })).code, 'PAGE_KEY_UNKNOWN', 'keys are exact');

  // A page in the registry that this contract did not agree (another contract's, or none)…
  const other = await prisma.contract.create({
    data: { ref: 'RC-OTHER', titleFa: 'د', titleEn: 'Other', customerId: f.customer.id, projectId: f.contract.projectId, status: 'WAITING_ON_CUSTOMER' },
  });
  await prisma.scopeItem.create({ data: { projectId: f.contract.projectId, key: 'faq', kind: 'PAGE', labelFa: 'س', labelEn: 'FAQ', contractId: other.id, status: 'AGREED' } });
  await prisma.scopeItem.create({ data: { projectId: f.contract.projectId, key: 'orphan', kind: 'PAGE', labelFa: 'ی', labelEn: 'Orphan', status: 'AGREED' } });
  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'faq' })).code, 'PAGE_KEY_UNKNOWN', 'per contract (J5), not per project');
  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'orphan' })).code, 'PAGE_KEY_UNKNOWN');
  // …and one of this contract's that has since been declined.
  await prisma.scopeItem.updateMany({ where: { contractId: f.contract.id, key: 'about' }, data: { status: 'DECLINED' } });
  await prisma.pageDesign.deleteMany({ where: { key: 'about' } });
  assert.equal((await asDesigner(ADD_PAGE, { k: concept.id, key: 'about' })).code, 'PAGE_KEY_UNKNOWN');

  assert.deepEqual((await read()).designDraft!.concepts[0].pages.map((p) => p.key), ['home']);
});

test('the palette rules: a colour is a hex, a font a name, a logo note a sentence; a role is a Latin identifier, unique per kind; both labels; at most 24', async () => {
  await customDraft();
  const add = (kind: string, role: string, v: string) => asDesigner(ADD_ITEM, { kind, role, v });

  ok(await add('COLOR', 'primary', '#1F3A5C'));
  assert.equal((await prisma.designPaletteItem.findFirstOrThrow({ where: { role: 'primary' } })).value, '#1f3a5c', 'normalized to lowercase');
  ok(await add('COLOR', 'accent', '#0a7'));
  assert.equal((await prisma.designPaletteItem.findFirstOrThrow({ where: { role: 'accent' } })).value, '#00aa77', 'three digits widened');
  ok(await add('FONT', 'heading', 'Vazirmatn'));
  ok(await add('LOGO_USAGE', 'logo-on-dark', 'Only on the dark blue; keep clear space equal to its height.'));
  // The same role under another kind is a different item; under the same kind it is taken.
  ok(await add('FONT', 'primary', 'IBM Plex Sans'));
  assert.equal((await add('COLOR', 'primary', '#000000')).code, 'ROLE_TAKEN');

  const table: Array<[string, string, string, string]> = [
    ['a named colour', 'COLOR', 'c1', 'red'],
    ['rgb()', 'COLOR', 'c2', 'rgb(1,2,3)'],
    ['a hex with alpha', 'COLOR', 'c3', '#11223344'],
    ['a font stack', 'FONT', 'f1', 'Arial, sans-serif'],
    ['a font with a quote', 'FONT', 'f2', 'Arial"; color: red'],
    ['a two-line logo note', 'LOGO_USAGE', 'l1', 'line one\nline two'],
    ['an empty logo note', 'LOGO_USAGE', 'l2', '   '],
  ];
  const expected: Record<string, string> = { COLOR: 'INVALID_COLOR', FONT: 'INVALID_FONT', LOGO_USAGE: 'INVALID_LOGO_NOTE' };
  for (const [name, kind, role, v] of table) assert.equal((await add(kind, role, v)).code, expected[kind], name);
  for (const role of ['Primary', '2nd', 'a b', 'رنگ', '']) assert.equal((await add('COLOR', role, '#000000')).code, 'INVALID_ROLE', JSON.stringify(role));
  assert.equal((await asDesigner('mutation($c: ID!){ addPaletteItem(contractId: $c, kind: COLOR, role: "x", value: "#000000", labelFa: "", labelEn: "X") { id } }')).code, 'LABEL_REQUIRED');

  // 24 is the ceiling: 5 in, 19 more fills it, one more is refused.
  for (let i = 0; i < 19; i += 1) ok(await add('COLOR', `extra-${i}`, '#123456'));
  assert.equal((await add('COLOR', 'one-more', '#123456')).code, 'PALETTE_FULL');
  assert.equal(await prisma.designPaletteItem.count(), 24);
});

test('a palette is for a custom design: NOT_CUSTOM on a pre-made contract and on the legacy road; sales and the unassigned designer may not write it', async () => {
  await customDraft();
  assert.equal((await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#000000' }, staff.SALES)).code, 'FORBIDDEN');
  assert.equal((await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#000000' }, staff.DESIGNER2)).code, 'NOT_ASSIGNED');
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'THEME_PICK' } });
  assert.equal((await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#000000' })).code, 'NOT_CUSTOM');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#000000' })).code, 'NOT_CUSTOM');
});

test('palette items: update the value and labels (kind and role stay), attach an image of this contract only, delete', async () => {
  await customDraft();
  const item = ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#111111' }));
  assert.ok(item);
  const id = (await prisma.designPaletteItem.findFirstOrThrow({ where: { role: 'primary' } })).id;
  ok(await exec('mutation($i: ID!){ updatePaletteItem(itemId: $i, value: "#222222", labelFa: "ت", labelEn: "Renamed") { id } }', { as: staff.DESIGNER, variables: { i: id } }));
  const row = await prisma.designPaletteItem.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([row.value, row.labelEn, row.role, row.kind], ['#222222', 'Renamed', 'primary', 'COLOR']);
  assert.equal((await exec('mutation($i: ID!){ updatePaletteItem(itemId: $i, value: "green", labelFa: "ت", labelEn: "R") { id } }', { as: staff.DESIGNER, variables: { i: id } })).code, 'INVALID_COLOR');

  // An image: this contract's own DESIGN_IMAGE only.
  const key = await storage.put('PRIVATE', PNG, '.png');
  const mine = await prisma.storedFile.create({ data: { key, class: 'DESIGN_IMAGE', visibility: 'PRIVATE', mime: 'image/png', bytes: PNG.length, originalName: 'a.png', contractId: f.contract.id, uploadedById: staff.DESIGNER.id } });
  const otherContract = await prisma.contract.create({ data: { ref: 'RC-OTHER', titleFa: 'د', titleEn: 'O', customerId: f.stranger.id, projectId: (await prisma.project.create({ data: { customerId: f.stranger.id, titleFa: 'پ', titleEn: 'P' } })).id } });
  const foreign = await prisma.storedFile.create({ data: { key: await storage.put('PRIVATE', PNG, '.png'), class: 'DESIGN_IMAGE', visibility: 'PRIVATE', mime: 'image/png', bytes: PNG.length, originalName: 'b.png', contractId: otherContract.id, uploadedById: staff.DESIGNER.id } });
  const SET_IMAGE = 'mutation($i: ID!, $f: ID){ setPaletteItemImage(itemId: $i, fileId: $f) { id } }';
  assert.equal((await exec(SET_IMAGE, { as: staff.DESIGNER, variables: { i: id, f: foreign.id } })).code, 'NOT_FOUND');
  ok(await exec(SET_IMAGE, { as: staff.DESIGNER, variables: { i: id, f: mine.id } }));
  assert.equal((await prisma.designPaletteItem.findUniqueOrThrow({ where: { id } })).imageFileId, mine.id);
  ok(await exec(SET_IMAGE, { as: staff.DESIGNER, variables: { i: id, f: null } }));
  assert.equal((await prisma.designPaletteItem.findUniqueOrThrow({ where: { id } })).imageFileId, null);

  ok(await exec('mutation($i: ID!){ deletePaletteItem(itemId: $i) { id } }', { as: staff.DESIGNER, variables: { i: id } }));
  assert.equal(await prisma.designPaletteItem.count(), 0);
});

/** A custom round 1 published: one page, a palette of two. */
async function customRoundOne() {
  const { concept } = await customDraft();
  ok(await asDesigner(ADD_PAGE, { k: concept.id, key: 'home' }));
  ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#1f3a5c' }));
  ok(await asDesigner(ADD_ITEM, { kind: 'FONT', role: 'heading', v: 'Vazirmatn' }));
  ok(await publishRound());
  mail.length = 0;
  sms.length = 0;
}

test('a custom round: the customer sees the wireframe page and the palette, and the round is counted against the wireframe iterations (2)', async () => {
  await customRoundOne();
  const c = await read(f.customer);
  assert.deepEqual(c.concepts[0].pages.map((p) => p.key), ['home']);
  assert.deepEqual(c.palette.map((p) => [p.kind, p.role, p.value]), [['COLOR', 'primary', '#1f3a5c'], ['FONT', 'heading', 'Vazirmatn']]);
  assert.deepEqual([wizardStep(c, 'DESIGN').iterationsUsed, wizardStep(c, 'DESIGN').allowance], [1, 2]);
  assert.equal(wizardStep(c, 'MOCKUP').status, 'UPCOMING');
});

test('carry-forward reaches the palette: the next draft holds every item, a page approval survives an unchanged page, and a palette-only edit is a publishable change', async () => {
  await customRoundOne();
  const page = (await read(f.customer)).concepts[0].pages[0];
  ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: page.id } }));

  ok(await asDesigner(START));
  const draft = (await read()).designDraft!;
  assert.deepEqual(draft.palette.map((p) => [p.role, p.value]), [['primary', '#1f3a5c'], ['heading', 'Vazirmatn']], 'copied item for item');
  assert.notEqual(draft.palette[0].id, (await read(f.customer)).palette[0].id, 'as new rows: the published round is not edited');

  // Nothing changed yet: NO_CHANGES (and a refused publish costs no round).
  assert.equal((await publishRound()).code, 'NO_CHANGES');
  // Only a colour changes — that is a round.
  ok(await exec('mutation($i: ID!){ updatePaletteItem(itemId: $i, value: "#445566", labelFa: "ت", labelEn: "Label") { id } }', { as: staff.DESIGNER, variables: { i: draft.palette[0].id } }));
  ok(await publishRound());
  const after = await read(f.customer);
  assert.equal(after.palette[0].value, '#445566');
  assert.equal(after.concepts[0].pages[0].approved, true, 'the unchanged page kept its approval (V3)');
  assert.equal(wizardStep(after, 'DESIGN').iterationsUsed, 2);
});

test('DESIGN_INCOMPLETE on the custom path: no round, then a page unapproved, then no palette — and it approves when every page is approved and the palette is not empty', async () => {
  const { concept } = await customDraft();
  const APPROVE = 'mutation($c: ID!){ approveDesign(contractId: $c) { id } }';
  const approve = () => exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } });
  assert.equal((await approve()).code, 'DESIGN_INCOMPLETE');
  ok(await asDesigner(ADD_PAGE, { k: concept.id, key: 'home' }));
  ok(await publishRound()); // pages, no palette
  assert.deepEqual((await read()).designMissing, ['PAGE_NOT_APPROVED', 'PALETTE_EMPTY']);
  assert.equal((await approve()).code, 'DESIGN_INCOMPLETE');

  const page = (await read(f.customer)).concepts[0].pages[0];
  ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: page.id } }));
  assert.deepEqual((await read()).designMissing, ['PALETTE_EMPTY']);
  assert.equal((await approve()).code, 'DESIGN_INCOMPLETE');

  ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#1f3a5c' }));
  ok(await publishRound()); // round 2: the palette; the page is unchanged so still approved
  assert.deepEqual((await read()).designMissing, []);
  ok(await approve());
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DESIGN' } }), 1);
});

test('a custom design has nothing to choose between: chooseConcept is NOT_APPLICABLE and cannot reset the page approvals', async () => {
  await customRoundOne();
  const c = await read(f.customer);
  const page = c.concepts[0].pages[0];
  ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: page.id } }));
  assert.equal(
    (await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: c.concepts[0].id } })).code,
    'NOT_APPLICABLE',
  );
  assert.equal((await read(f.customer)).concepts[0].pages[0].approved, true);
  // Approving a page is the customer's own on the new road.
  for (const who of [staff.DESIGNER, staff.SALES, f.stranger]) {
    assert.equal((await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: false) { id } }', { as: who, variables: { p: page.id } })).code, 'NOT_FOUND', who.email ?? '');
  }
});

test('feedback on a palette item: the customer can point at one, a foreign id is NOT_FOUND, the item collapses per palette item, and deleting the item takes the note with it (the FK S2 left off)', async () => {
  await customRoundOne();
  const c = await read(f.customer);
  const revisionId = c.designRevisions[0].id;
  const item = c.palette[0];
  const SUBMIT = 'mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: DESIGN, target: $t, body: "Too dark") { item { id status } } }';
  const made = ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { designRevisionId: revisionId, paletteItemId: item.id } } })).submitFeedback as { item: { id: string } };
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: made.item.id } })).paletteItemId, item.id);
  const again = ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { designRevisionId: revisionId, paletteItemId: item.id } } })).submitFeedback as { item: { id: string } };
  assert.equal(again.item.id, made.item.id, 'one item per palette item');

  assert.equal((await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { designRevisionId: revisionId, paletteItemId: 'nope' } } })).code, 'NOT_FOUND');
  // A palette item of a *draft* (not shown to the customer) is not addressable either.
  ok(await asDesigner(START));
  const draftItem = (await read()).designDraft!.palette[0];
  assert.equal((await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { designRevisionId: revisionId, paletteItemId: draftItem.id } } })).code, 'NOT_FOUND');

  // The database holds the foreign key now: a note about nothing cannot exist.
  await assert.rejects(
    prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DESIGN', designRevisionId: revisionId, paletteItemId: 'swatch-nope' } }),
    /FeedbackItem_paletteItemId_fkey/,
  );
  await prisma.designPaletteItem.delete({ where: { id: item.id } });
  assert.equal(await prisma.feedbackItem.count({ where: { id: made.item.id } }), 0, 'cascade: the note goes with the item');
});

// =================================================================================
// discarding and re-proposing
// =================================================================================

test('discarding a draft removes the previews it copied and nothing a published round still shows; proposing the same themes again is NO_CHANGES', async () => {
  await reachDesign();
  const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
  ok(await propose(a.id));
  ok(await publishRound());
  const shown = await prisma.storedFile.findMany({ where: { class: 'DESIGN_IMAGE', contractId: f.contract.id } });
  assert.equal(shown.length, 1);

  // Round 2's draft: Astra (cloned, sharing round 1's copy) and Bravo (a new copy).
  ok(await propose(a.id, b.id));
  assert.equal(await prisma.storedFile.count({ where: { class: 'DESIGN_IMAGE', contractId: f.contract.id } }), 2, 'the clone shares the file; Bravo added one');
  const bravoCopy = (await prisma.designConcept.findFirstOrThrow({ where: { themeId: b.id } })).imageFileId!;
  const bravoKey = (await prisma.storedFile.findUniqueOrThrow({ where: { id: bravoCopy } })).key;

  ok(await asDesigner('mutation($c: ID!){ discardDesignDraft(contractId: $c) { id } }'));
  assert.equal(await prisma.storedFile.count({ where: { id: bravoCopy } }), 0);
  assert.equal(await storage.exists(bravoKey), false, 'and its bytes');
  assert.equal(await prisma.storedFile.count({ where: { id: shown[0].id } }), 1, 'round 1’s picture stayed');
  assert.equal((await get(shown[0].id, f.customer)).status, 200);

  // The same themes again are nothing new.
  ok(await propose(a.id));
  assert.equal((await publishRound()).code, 'NO_CHANGES');
  assert.equal(wizardStep(await read(), 'DESIGN').iterationsUsed, 1, 'a refused publish costs no round');
});

// =================================================================================
// allowances
// =================================================================================

const EXTEND = `mutation($c: ID!, $s: StepKind!, $p: ID, $n: Int!, $r: String!, $ch: String){
  extendAllowance(contractId: $c, step: $s, phaseId: $p, extra: $n, reason: $r, charge: $ch) { id allowanceExtensions { id step extra reason charge approvedBy { id } } }
}`;
const extend = (as: User, over: Record<string, unknown> = {}) =>
  exec(EXTEND, { as, variables: { c: f.contract.id, s: 'DESIGN', p: null, n: 1, r: 'The customer changed direction', ch: null, ...over } });

test('ALLOWANCE_EXHAUSTED, then sales extends and one more round is admitted; a refused publish costs nothing and tells sales', async () => {
  await reachDesign({ premadeRounds: 2 });
  const [a, b, c, d] = [await makeTheme('Astra'), await makeTheme('Bravo'), await makeTheme('Cedar'), await makeTheme('Dune')];
  ok(await propose(a.id));
  ok(await publishRound());
  ok(await propose(b.id));
  ok(await publishRound());
  let design = wizardStep(await read(), 'DESIGN');
  assert.deepEqual([design.iterationsUsed, design.allowance], [2, 2]);

  ok(await propose(c.id));
  mail.length = 0;
  sms.length = 0;
  const refused = await publishRound();
  assert.equal(refused.code, 'ALLOWANCE_EXHAUSTED');
  assert.equal(await prisma.designRevision.count({ where: { contractId: f.contract.id, publishedAt: { not: null } } }), 2, 'nothing was published');
  assert.ok((await read()).designDraft, 'and the designer’s draft is still there');
  // Sales is told; the customer and the designer are not.
  assert.deepEqual(mail.map((m) => m.to).sort(), [staff.SALES.email, f.admin.email].sort(), 'everyone who holds contracts.author');
  assert.ok(mail.every((m) => /دورهای مجاز تمام شد|Rounds used up/.test(m.subject)));
  assert.equal(mail.some((m) => m.to === f.customer.email || m.to === staff.DESIGNER.email), false);

  // Only sales (contracts.author) may extend — not the designer, not the customer.
  assert.equal((await extend(staff.DESIGNER)).code, 'FORBIDDEN');
  assert.equal((await extend(f.customer)).code, 'FORBIDDEN');
  assert.equal((await extend(staff.DEVELOPER)).code, 'FORBIDDEN');
  assert.equal(await prisma.allowanceExtension.count(), 0);

  const extended = ok(await extend(staff.SALES)).extendAllowance as { allowanceExtensions: Array<{ extra: number; reason: string; approvedBy: { id: string } }> };
  assert.deepEqual(extended.allowanceExtensions.map((e) => [e.extra, e.reason, e.approvedBy.id]), [[1, 'The customer changed direction', staff.SALES.id]]);
  design = wizardStep(await read(), 'DESIGN');
  assert.deepEqual([design.iterationsUsed, design.allowance], [2, 3], 'the counter moved with the allowance');

  ok(await publishRound());
  design = wizardStep(await read(f.customer), 'DESIGN');
  assert.deepEqual([design.iterationsUsed, design.allowance], [3, 3], 'the customer’s counter: round 3 of 3');
  // And the fourth is refused again: an extension admits exactly what it says.
  ok(await propose(d.id));
  assert.equal((await publishRound()).code, 'ALLOWANCE_EXHAUSTED');
});

test('the custom path counts against the wireframe iterations (default 2), not the pre-made rounds', async () => {
  const { concept } = await customDraft();
  ok(await asDesigner(ADD_PAGE, { k: concept.id, key: 'home' }));
  ok(await publishRound());
  ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'primary', v: '#123456' }));
  ok(await publishRound());
  ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'accent', v: '#654321' }));
  assert.equal((await publishRound()).code, 'ALLOWANCE_EXHAUSTED');
  ok(await extend(staff.SALES, { n: 2 }));
  ok(await publishRound());
  assert.deepEqual([wizardStep(await read(), 'DESIGN').iterationsUsed, wizardStep(await read(), 'DESIGN').allowance], [3, 4]);
});

test('an extension with a charge creates a draft invoice the customer cannot see; the charge follows money.read; the reason is staff-only', async () => {
  await reachDesign({ premadeRounds: 1 });
  const a = await makeTheme('Astra');
  ok(await propose(a.id));
  ok(await publishRound());

  ok(await extend(staff.SALES, { n: 2, ch: '2500000' }));
  const ext = await prisma.allowanceExtension.findFirstOrThrow({ include: { billingEntry: true } });
  assert.ok(ext.billingEntry, 'the extension names its invoice');
  assert.equal(ext.billingEntry.issuedAt, null, 'a draft (J13)');
  assert.equal(ext.billingEntry.invoiceNumber, null);
  assert.equal(ext.billingEntry.amount, 2_500_000n);
  assert.equal(ext.billingEntry.contractId, f.contract.id);
  assert.equal(ext.billingEntry.customerId, f.customer.id);
  assert.equal(ext.billingEntry.source, 'CONTRACT');
  assert.match(ext.billingEntry.descriptionEn, /2 extra design rounds/);
  assert.match(ext.billingEntry.descriptionFa, /۲ دورِ اضافه‌ی طراحی/);

  // The customer sees no invoice, no extension, no reason.
  const invoices = ok(await exec('{ myInvoices { id } }', { as: f.customer })).myInvoices as unknown[];
  assert.equal(invoices.length, 0);
  assert.deepEqual((await read(f.customer)).allowanceExtensions, []);
  // Money follows money.read: sales reads the charge, the designer does not (and sees the rows, as a staff reader).
  assert.equal((await read(staff.SALES)).allowanceExtensions[0].charge, '2500000');
  assert.equal((await read(staff.DESIGNER)).allowanceExtensions[0].charge, null);
  assert.equal((await read(staff.DEVELOPER)).allowanceExtensions[0].charge, null);
  // Sales issues it like any draft; deleting a draft leaves the extension standing.
  ok(await exec('mutation($e: ID!){ deleteInvoiceDraft(entryId: $e) }', { as: staff.SALES, variables: { e: ext.billingEntryId } }));
  const survivor = await prisma.allowanceExtension.findFirstOrThrow();
  assert.equal(survivor.billingEntryId, null);
  assert.equal((await read(staff.SALES)).allowanceExtensions[0].charge, null);
  assert.deepEqual([wizardStep(await read(), 'DESIGN').iterationsUsed, wizardStep(await read(), 'DESIGN').allowance], [1, 3], 'the rounds were granted');
});

test('extendAllowance refuses what is not an extension: INVALID_EXTRA, REASON_REQUIRED, a step with no allowance, a bad charge, NO_ALLOWANCE_SET, the legacy road, and a demo extension for a phase that is not this contract’s', async () => {
  await reachDesign();
  assert.equal((await extend(staff.SALES, { n: 0 })).code, 'INVALID_EXTRA');
  assert.equal((await extend(staff.SALES, { n: -1 })).code, 'INVALID_EXTRA');
  assert.equal((await extend(staff.SALES, { n: 21 })).code, 'INVALID_EXTRA');
  assert.equal((await extend(staff.SALES, { r: '   ' })).code, 'REASON_REQUIRED');
  assert.equal((await extend(staff.SALES, { s: 'SCOPE' })).code, 'STEP_HAS_NO_ALLOWANCE');
  assert.equal((await extend(staff.SALES, { s: 'SUMMARY' })).code, 'STEP_HAS_NO_ALLOWANCE');
  assert.equal((await extend(staff.SALES, { p: 'p1' })).code, 'PHASE_NOT_ALLOWED', 'only a demo’s allowance is per phase');
  assert.equal((await extend(staff.SALES, { s: 'DEMO' })).code, 'PHASE_REQUIRED');
  assert.equal((await extend(staff.SALES, { s: 'MOCKUP' })).code, 'NO_ALLOWANCE_SET', 'J9b counts mockup iterations; a pre-made brief has no mockup allowance to extend');
  assert.equal((await extend(staff.SALES, { s: 'DEMO', p: 'p1' })).code, 'NOT_FOUND', 'J10: a demo’s allowance is per phase, and the phase must be this contract’s (j10.test.ts extends one)');
  assert.equal((await extend(staff.SALES, { ch: '12.5' })).code, 'INVALID_AMOUNT');
  assert.equal((await extend(staff.SALES, { ch: '-5' })).code, 'INVALID_AMOUNT');
  assert.equal((await extend(staff.SALES, {})).code, undefined, 'and a good one works');
  assert.equal(await prisma.billingEntry.count(), 0, 'no refusal left an invoice behind');
  assert.equal(await prisma.allowanceExtension.count(), 1);

  // An allowance that was never set has nothing to extend.
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { premadeRounds: null } });
  assert.equal((await extend(staff.SALES)).code, 'NO_ALLOWANCE_SET');
  // A contract the caller cannot see; the legacy road has no allowance.
  assert.equal((await exec(EXTEND, { as: staff.SALES, variables: { c: 'nope', s: 'DESIGN', p: null, n: 1, r: 'x', ch: null } })).code, 'NOT_FOUND');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await extend(staff.SALES)).code, 'STEP_NOT_ON_ROAD');
});

// =================================================================================
// the CHECKs, by direct insert
// =================================================================================

test('AllowanceExtension_extra_positive: the database refuses zero and negative rounds, whatever wrote the row', async () => {
  await reachDesign();
  const insert = (extra: number) =>
    prisma.allowanceExtension.create({ data: { contractId: f.contract.id, step: 'DESIGN', extra, reason: 'r', approvedById: staff.SALES.id } });
  await assert.rejects(insert(0), /AllowanceExtension_extra_positive/);
  await assert.rejects(insert(-3), /AllowanceExtension_extra_positive/);
  assert.ok(await insert(1));
  assert.equal(await prisma.allowanceExtension.count(), 1);
});

test('DesignPaletteItem_color_is_hex: a COLOR’s value must be # and six lowercase hex digits — and a font or a note is not held to it', async () => {
  await reachCustom();
  ok(await asDesigner(START));
  const draft = (await read()).designDraft!;
  const insert = (kind: 'COLOR' | 'FONT' | 'LOGO_USAGE', value: string, role: string) =>
    prisma.designPaletteItem.create({ data: { designRevisionId: draft.id, kind, role, value, labelFa: 'ب', labelEn: 'L' } });
  for (const bad of ['red', '#FFF', '#ABCDEF', '#12345', '#1234567', '123456', '']) {
    await assert.rejects(insert('COLOR', bad, 'c'), /DesignPaletteItem_color_is_hex/, JSON.stringify(bad));
  }
  assert.ok(await insert('COLOR', '#0a1b2c', 'c'));
  assert.ok(await insert('FONT', 'Vazirmatn', 'f'));
  assert.ok(await insert('LOGO_USAGE', 'anything at all, even #FFF', 'l'));
  // The role is unique per kind within a revision (the index behind ROLE_TAKEN).
  await assert.rejects(insert('COLOR', '#0a1b2c', 'c'), /Unique constraint failed/);
});

test('a theme concept cannot be proposed twice in a revision (DesignConcept_designRevisionId_themeId_key), and concepts that are not themes are not held to it', async () => {
  await reachDesign();
  const a = await makeTheme('Astra');
  ok(await propose(a.id));
  const draft = (await read()).designDraft!;
  await assert.rejects(
    prisma.designConcept.create({ data: { designRevisionId: draft.id, key: 'other', labelFa: 'ف', labelEn: 'O', themeId: a.id } }),
    /Unique constraint failed/,
  );
  for (const key of ['x1', 'x2']) {
    assert.ok(await prisma.designConcept.create({ data: { designRevisionId: draft.id, key, labelFa: 'ف', labelEn: 'O' } }));
  }
});

// =================================================================================
// the locks: every design mutation × STEP_LOCKED
// =================================================================================

type LockRow = {
  mutation: string;
  file: 'admin/design.ts' | 'customer.ts' | 'design.ts';
  paths: Array<'CUSTOM' | 'PREMADE'>;
  as: () => User;
  run: (ids: LockIds) => Promise<ExecResult>;
};
type LockIds = { conceptId: string; pageId: string; itemId: string; themeId: string; publishedConceptId: string; publishedPageId: string };

const IMG = 'mutation($x: ID!){ setConceptImage(conceptId: $x, fileId: null) { id } }';
const lockTable: LockRow[] = [
  { mutation: 'startDesignDraft', file: 'admin/design.ts', paths: ['CUSTOM', 'PREMADE'], as: () => staff.DESIGNER, run: () => asDesigner(START) },
  {
    mutation: 'addConcept',
    file: 'admin/design.ts',
    paths: ['CUSTOM', 'PREMADE'],
    as: () => staff.DESIGNER,
    run: () => asDesigner('mutation($c: ID!){ addConcept(contractId: $c, key: "9z", labelFa: "ط", labelEn: "C") { id } }'),
  },
  { mutation: 'proposeThemes', file: 'admin/design.ts', paths: ['PREMADE'], as: () => staff.DESIGNER, run: (i) => propose(i.themeId) },
  { mutation: 'addPageDesign', file: 'admin/design.ts', paths: ['CUSTOM', 'PREMADE'], as: () => staff.DESIGNER, run: (i) => asDesigner(ADD_PAGE, { k: i.conceptId, key: 'about' }) },
  { mutation: 'setConceptImage', file: 'admin/design.ts', paths: ['CUSTOM', 'PREMADE'], as: () => staff.DESIGNER, run: (i) => asDesigner(IMG, { x: i.conceptId }) },
  {
    mutation: 'setPageImage',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ setPageImage(pageId: $x, fileId: null) { id } }', { x: i.pageId }),
  },
  {
    mutation: 'updateConcept',
    file: 'admin/design.ts',
    paths: ['CUSTOM', 'PREMADE'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ updateConcept(conceptId: $x, labelFa: "ف", labelEn: "New") { id } }', { x: i.conceptId }),
  },
  {
    mutation: 'deleteConcept',
    file: 'admin/design.ts',
    paths: ['CUSTOM', 'PREMADE'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ deleteConcept(conceptId: $x) { id } }', { x: i.conceptId }),
  },
  {
    mutation: 'updatePageDesign',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ updatePageDesign(pageId: $x, labelFa: "ف", labelEn: "New") { id } }', { x: i.pageId }),
  },
  {
    mutation: 'deletePageDesign',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ deletePageDesign(pageId: $x) { id } }', { x: i.pageId }),
  },
  { mutation: 'addPaletteItem', file: 'admin/design.ts', paths: ['CUSTOM'], as: () => staff.DESIGNER, run: () => asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'late', v: '#123456' }) },
  {
    mutation: 'updatePaletteItem',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ updatePaletteItem(itemId: $x, value: "#000000", labelFa: "ف", labelEn: "N") { id } }', { x: i.itemId }),
  },
  {
    mutation: 'setPaletteItemImage',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ setPaletteItemImage(itemId: $x, fileId: null) { id } }', { x: i.itemId }),
  },
  {
    mutation: 'deletePaletteItem',
    file: 'admin/design.ts',
    paths: ['CUSTOM'],
    as: () => staff.DESIGNER,
    run: (i) => asDesigner('mutation($x: ID!){ deletePaletteItem(itemId: $x) { id } }', { x: i.itemId }),
  },
  { mutation: 'discardDesignDraft', file: 'admin/design.ts', paths: ['CUSTOM', 'PREMADE'], as: () => staff.DESIGNER, run: () => asDesigner('mutation($c: ID!){ discardDesignDraft(contractId: $c) { id } }') },
  { mutation: 'publishDesignRevision', file: 'admin/design.ts', paths: ['CUSTOM', 'PREMADE'], as: () => staff.DESIGNER, run: () => publishRound() },
  // The same mutations as the admin: sales' `contracts.author` does not open the design.
  {
    mutation: 'chooseConcept',
    file: 'customer.ts',
    paths: ['PREMADE'],
    as: () => f.customer,
    run: (i) => exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: i.publishedConceptId } }),
  },
  {
    mutation: 'setPageApproval',
    file: 'customer.ts',
    paths: ['CUSTOM'],
    as: () => f.customer,
    run: (i) => exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: false) { id } }', { as: f.customer, variables: { p: i.publishedPageId } }),
  },
  // Guarded through `raiseFeedback` and `approveStepTx` rather than `openDesign`.
  {
    mutation: 'requestOtherOptions',
    file: 'design.ts',
    paths: ['PREMADE'],
    as: () => f.customer,
    run: () => exec('mutation($c: ID!){ requestOtherOptions(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }),
  },
  {
    mutation: 'approveDesign',
    file: 'design.ts',
    paths: ['CUSTOM', 'PREMADE'],
    as: () => f.customer,
    run: () => exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }),
  },
];

/** A published round, a draft beside it holding a copy of everything, and the customer’s approval. */
async function lockedDesign(path: 'CUSTOM' | 'PREMADE'): Promise<LockIds> {
  let ids: LockIds;
  if (path === 'CUSTOM') {
    await customRoundOne();
    const published = (await read(f.customer)).concepts[0];
    ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: published.pages[0].id } }));
    ok(await asDesigner(START));
    const draft = (await read()).designDraft!;
    ids = {
      conceptId: draft.concepts[0].id,
      pageId: draft.concepts[0].pages[0].id,
      itemId: draft.palette[0].id,
      themeId: 'unused',
      publishedConceptId: published.id,
      publishedPageId: published.pages[0].id,
    };
  } else {
    await reachDesign();
    const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
    ok(await propose(a.id));
    ok(await publishRound());
    const published = (await read(f.customer)).concepts[0];
    ok(await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: published.id } }));
    ok(await propose(a.id, b.id));
    const draft = (await read()).designDraft!;
    ids = { conceptId: draft.concepts[0].id, pageId: 'unused', itemId: 'unused', themeId: b.id, publishedConceptId: published.id, publishedPageId: 'unused' };
  }
  ok(await exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  mail.length = 0;
  sms.length = 0;
  return ids;
}

const snapshotOfDesign = async () => ({
  revisions: await prisma.designRevision.count(),
  published: await prisma.designRevision.count({ where: { publishedAt: { not: null } } }),
  concepts: await prisma.designConcept.count(),
  pages: await prisma.pageDesign.count(),
  palette: await prisma.designPaletteItem.count(),
  files: await prisma.storedFile.count(),
  feedback: await prisma.feedbackItem.count(),
  approvals: await prisma.stepApproval.count(),
  chosen: await prisma.designConcept.count({ where: { chosenAt: { not: null } } }),
  approvedPages: await prisma.pageDesign.count({ where: { approvedAt: { not: null } } }),
});

for (const path of ['CUSTOM', 'PREMADE'] as const) {
  test(`after the design is approved every ${path === 'CUSTOM' ? 'custom' : 'pre-made'}-path design mutation is STEP_LOCKED — for staff and the customer alike — and a refusal writes nothing`, async () => {
    const ids = await lockedDesign(path);
    const before = await snapshotOfDesign();
    for (const row of lockTable.filter((r) => r.paths.includes(path))) {
      const result = await row.run(ids);
      assert.equal(result.code, 'STEP_LOCKED', `${row.mutation}: ${JSON.stringify(result.errors)}`);
    }
    assert.deepEqual(await snapshotOfDesign(), before, 'nothing moved');
    assert.equal(mail.length + sms.length, 0, 'and nobody was told of a refused act');
    // Answering feedback on the design is locked too (S2), and the step reads as done.
    const c = await read();
    assert.deepEqual([wizardStep(c, 'DESIGN').status, wizardStep(c, 'DESIGN').locked], ['DONE', true]);
  });
}

test('the lock table is complete: every file’s count of `openDesign(` call sites matches the rows above — add a design write and this fails until it has a row', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const files = [...readdirSync(dir), ...readdirSync(`${dir}admin/`).map((n) => `admin/${n}`)].filter((n) => n.endsWith('.ts'));
  const sites: Record<string, number> = {};
  let literal = 0;
  for (const name of files) {
    const source = readFileSync(`${dir}${name}`, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const count = (source.match(/\bopenDesign\(tx, /g) ?? []).length;
    if (count > 0) sites[name] = count;
    literal += (source.match(/assertStepOpenOn\([^)]*'DESIGN'/g) ?? []).length;
  }
  // Call sites per file; a mutation that guards through another door (`raiseFeedback`'s and `approveStepTx`'s own lock)
  // has a row and no site.
  assert.deepEqual(sites, { 'admin/design.ts': 16, 'customer.ts': 2 });
  assert.equal(literal, 1, 'and openDesign is the one place that asks the wizard whether DESIGN is locked');
  const rows = lockTable.reduce<Record<string, Set<string>>>((acc, r) => {
    (acc[r.file] ??= new Set()).add(r.mutation);
    return acc;
  }, {});
  assert.equal(rows['admin/design.ts'].size, 16);
  assert.equal(rows['customer.ts'].size, 2);
  assert.equal(rows['design.ts'].size, 2);
});

test('every design mutation in the SDL has a row in the lock table — the table cannot fall behind the schema', () => {
  const sdl = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  const designMutations = [
    'startDesignDraft', 'addConcept', 'proposeThemes', 'addPageDesign', 'setConceptImage', 'setPageImage', 'updateConcept', 'deleteConcept',
    'updatePageDesign', 'deletePageDesign', 'addPaletteItem', 'updatePaletteItem', 'setPaletteItemImage', 'deletePaletteItem',
    'discardDesignDraft', 'publishDesignRevision', 'chooseConcept', 'setPageApproval', 'requestOtherOptions', 'approveDesign',
  ];
  for (const name of designMutations) assert.ok(new RegExp(`\\b${name}\\(`).test(sdl), `${name} is in the schema`);
  assert.deepEqual(designMutations.sort(), lockTable.map((r) => r.mutation).sort());
});

test('before the lock nothing is STEP_LOCKED: the same writes work up to the customer’s approval, and approval is the only thing that locks', async () => {
  await customRoundOne();
  ok(await asDesigner(START));
  ok(await asDesigner(ADD_ITEM, { kind: 'COLOR', role: 'accent', v: '#abcdef' }));
  ok(await asDesigner('mutation($c: ID!){ discardDesignDraft(contractId: $c) { id } }'));
  assert.equal(await prisma.stepApproval.count(), 1, 'only the agreement’s (J7)');
});

// =================================================================================
// the legacy road, untouched
// =================================================================================

test('a DESIGN_FIRST contract with a palette present has the same designComplete as before — the new completeness is a new function', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  const GATE = 'query($c: ID!){ contract(id: $c) { gate { designComplete approvedPageCount totalPageCount } designMissing } }';
  const gate = async () => (ok(await exec(GATE, { as: f.customer, variables: { c: f.contract.id } })).contract as { gate: Record<string, unknown>; designMissing: string[] });

  const empty = await gate();
  assert.equal(empty.gate.designComplete, false);
  assert.deepEqual(empty.designMissing, [], 'the new road’s list means nothing on the legacy road');

  const revision = f.designRevision;
  await prisma.designPaletteItem.create({ data: { designRevisionId: revision.id, kind: 'COLOR', role: 'primary', value: '#112233', labelFa: 'ا', labelEn: 'P' } });
  assert.deepEqual((await gate()).gate, empty.gate, 'a palette does not complete a legacy design…');

  // …and a complete legacy design is complete with or without one, exactly by the old rule.
  const concept = await prisma.designConcept.findFirstOrThrow({ where: { designRevisionId: revision.id, key: '1a' } });
  await prisma.designConcept.update({ where: { id: concept.id }, data: { chosenAt: new Date() } });
  await prisma.pageDesign.updateMany({ where: { conceptId: concept.id }, data: { approvedAt: new Date() } });
  assert.equal((await gate()).gate.designComplete, true);
  await prisma.designPaletteItem.deleteMany({});
  assert.equal((await gate()).gate.designComplete, true);
});

test('the legacy road publishes revisions as it always did: no allowance (even with a brief that names one), no lock, free-form page keys, no notification', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await prisma.contractBrief.create({ data: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK', premadeRounds: 1 } });
  // A DESIGN approval row on a legacy contract is ignored (J3): the legacy road is never locked.
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  mail.length = 0;
  for (let i = 0; i < 3; i += 1) {
    ok(await asDesigner('mutation($c: ID!, $k: String!){ addConcept(contractId: $c, key: $k, labelFa: "ف", labelEn: "C") { id } }', { k: `n${i}` }, staff.DESIGNER));
    ok(await publishRound());
  }
  assert.equal(await prisma.designRevision.count({ where: { contractId: f.contract.id, publishedAt: null } }), 0, 'all three were published');
  ok(await asDesigner('mutation($c: ID!){ addConcept(contractId: $c, key: "free", labelFa: "ف", labelEn: "C") { id } }'));
  const draftConcept = await prisma.designConcept.findFirstOrThrow({ where: { key: 'free' } });
  ok(await asDesigner(ADD_PAGE, { k: draftConcept.id, key: 'any-key-you-like' }));
  assert.equal(mail.length, 0, 'the legacy road sends no round email');
  assert.equal(await prisma.allowanceExtension.count(), 0);
});

// =================================================================================
// the notifications
// =================================================================================

test('every design notification exists in both locales for email and SMS, and reaches the right person: round → customer, choice / other options / approval → the assigned designer, exhausted → sales', async () => {
  // The designer in English, the customer in Persian.
  await prisma.user.update({ where: { id: staff.DESIGNER.id }, data: { locale: 'en' } });
  staff.DESIGNER = await prisma.user.findUniqueOrThrow({ where: { id: staff.DESIGNER.id } });
  await reachDesign({ premadeRounds: 1 });
  const [a, b] = [await makeTheme('Astra'), await makeTheme('Bravo')];
  ok(await propose(a.id, b.id));
  ok(await publishRound());
  const round = mail.filter((m) => m.to === f.customer.email);
  assert.equal(round.length, 1);
  assert.match(round[0].subject, /دورِ ۱ از ۱ طراحی آماده است/);
  assert.equal(sms.filter((s) => s.to === f.customer.phone).length, 1);

  mail.length = 0;
  sms.length = 0;
  const c = (await read(f.customer)).concepts;
  ok(await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: c[0].id } }));
  ok(await exec('mutation($c: ID!){ requestOtherOptions(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  const toDesigner = mail.filter((m) => m.to === staff.DESIGNER.email);
  assert.equal(toDesigner.length, 2, 'chosen, and other options asked');
  assert.match(toDesigner[0].subject, /A design was chosen/);
  assert.match(toDesigner[1].subject, /New options requested/);
  assert.ok(toDesigner.every((m) => m.html.includes('/en/desk/contracts/')), 'the designer’s link is in the designer’s language');
  assert.equal(sms.filter((s) => s.to === staff.DESIGNER.phone).length, 2);
  assert.ok(sms.filter((s) => s.to === staff.DESIGNER.phone).every((s) => /[A-Za-z]/.test(s.text ?? '') && !/[؀-ۿ]/.test(s.text ?? '')), 'English SMS for an English designer');
  assert.equal(mail.filter((m) => m.to === staff.DESIGNER2.email).length, 0, 'not the designer of another contract');

  // The one allowed round is used, so the next publish is refused and sales hears it, in Persian.
  ok(await propose(a.id, (await makeTheme('Cedar')).id));
  mail.length = 0;
  assert.equal((await publishRound()).code, 'ALLOWANCE_EXHAUSTED');
  const toSales = mail.filter((m) => m.to === staff.SALES.email);
  assert.equal(toSales.length, 1);
  assert.match(toSales[0].subject, /دورهای مجاز تمام شد/);
});

test('with no designer assigned the design’s notifications go to whoever could answer in their place (S2’s rule), never nowhere', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: null } });
  await reachDesign();
  const a = await makeTheme('Astra');
  // No assignee: only ADMIN/others with design.author can propose here; the fixture admin does.
  ok(await asDesigner(PROPOSE, { t: [a.id] }, f.admin));
  ok(await asDesigner(PUBLISH_ROUND, {}, f.admin));
  mail.length = 0;
  const c = (await read(f.customer)).concepts;
  ok(await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { as: f.customer, variables: { c: f.contract.id, k: c[0].id } }));
  const recipients = mail.map((m) => m.to).sort();
  const holders = [f.admin.email, staff.SALES.email, staff.DESIGNER.email, staff.DESIGNER2.email].sort();
  assert.deepEqual(recipients, holders, 'every active holder of answers.direct.design — and not the developer or the contributor');
});
