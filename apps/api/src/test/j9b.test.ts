import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import * as yazl from 'yazl';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { onDay } from './calendar.js';
import { exec, ok, stop } from './graphql.js';
import { startFullApp } from './http.js';
import { storage } from '../lib/storage.js';
import { env } from '../lib/env.js';
import { __clearBundleCacheForTests } from '../lib/mockupServe.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J9b — step 5, the mockup: the designer's demo, its page mapping, its
 * iterations, the frame, the allowance, the approval and the lock (journeys build
 * plan §5 "J9", the half J9a left).
 *
 * In this order: **the road** (who can start a mockup, and when); **the guards**
 * (design authorship, not build authorship — every mutation against a developer,
 * another contract's designer, sales and the customer); **the mapping**;
 * **iterations** (numbering per kind beside site builds, the disposition rules over
 * the open MOCKUP items, `answers.direct.mockup`); **the frame** (from design, per
 * iteration); **the allowance** (`ALLOWANCE_EXHAUSTED` then an extension);
 * **approval and the lock** (a table of every mockup write against `STEP_LOCKED`,
 * with a source scan that fails when one is added without a row); **what the
 * customer sees and is told**.
 *
 * The contract is taken to the door of step 5 the way a customer would: a custom
 * brief, the scope, the draft approved and signed, the designer's wireframes and
 * palette, the customer approving every page and then the design (`reachMockup`).
 * The bundles are real zips, stored the way the upload route stores them; the
 * upload itself is J9a's.
 */

let f: Fixture;
let app: { base: string; port: number; close: () => Promise<void> };
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string }>;

before(async () => {
  await resetDatabase();
  app = await startFullApp();
});

beforeEach(async () => {
  await resetDatabase();
  __clearBundleCacheForTests();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000109', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, phone: role === 'DESIGNER' ? '+989120000110' : undefined, name: role, roles: [role], state: 'ACTIVE' },
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
  await app.close();
  await stop();
  await prisma.$disconnect();
});

// =================================================================================================
// Documents and fixtures
// =================================================================================================

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE = `mutation($c: ID!){ createPhase(contractId: $c, number: 1, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "${onDay('2026-11-10')}") { phases { id } } }`;
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
  designTier: 'SENIOR_DESIGNER',
  budgetCap: '150000000',
  hardDeadline: onDay('2026-10-23'),
  domainName: 'nahal.ir',
  domainProvidedBy: 'CUSTOMER',
  hostProvidedBy: 'ROOT',
  contentProvidedBy: 'CUSTOMER',
  supportMonths: 6,
  premadeRounds: null,
  wireframeIterations: 2,
  mockupIterations: 2,
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: onDay('2026-10-05') },
    { key: 'host', dueAt: onDay('2026-10-06') },
    { key: 'content', dueAt: onDay('2026-10-07') },
  ],
};

const asDesigner = (query: string, variables: Record<string, unknown> = {}, as: User = staff.DESIGNER) =>
  exec(query, { as, variables: { c: f.contract.id, ...variables } });

/** The contract at the door of step 4, taken there through the API (see j8.test.ts). */
async function reachDesign(over: Record<string, unknown> = {}) {
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
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: onDay('2026-10-12'), e: onDay('2026-12-20') } }));
  ok(await exec(PUBLISH_DRAFT, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE_AGREEMENT, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  return { phaseId: phase.phases[0].id };
}

const DRAFT_CONCEPT = 'query($c: ID!){ contract(id: $c) { designDraft { concepts { id key } } } }';
const CUSTOMER_PAGES = 'query($c: ID!){ contract(id: $c) { concepts { pages { id key } } } }';

/**
 * The contract at the door of **step 5**: a custom design taken through its wireframes
 * (`home` and `about`, the two PAGE items of the scope), palette and the customer's
 * approval of each page and then of the design.
 */
async function reachMockup(over: Record<string, unknown> = {}) {
  const reached = await reachDesign(over);
  ok(await asDesigner('mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }'));
  const draft = ok(await asDesigner(DRAFT_CONCEPT)).contract as { designDraft: { concepts: Array<{ id: string; key: string }> } };
  const concept = draft.designDraft.concepts.find((c) => c.key === 'wireframes')!;
  for (const key of ['home', 'about']) {
    ok(await asDesigner('mutation($k: ID!, $key: String!){ addPageDesign(conceptId: $k, key: $key, labelFa: "ف", labelEn: "L") { id } }', { k: concept.id, key }));
  }
  for (const [kind, role, value] of [['COLOR', 'primary', '#1f3a5c'], ['FONT', 'heading', 'Vazirmatn']]) {
    ok(
      await asDesigner(
        'mutation($c: ID!, $kind: PaletteKind!, $role: String!, $v: String!){ addPaletteItem(contractId: $c, kind: $kind, role: $role, value: $v, labelFa: "برچسب", labelEn: "Label") { id } }',
        { kind, role, v: value },
      ),
    );
  }
  ok(await asDesigner('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }'));
  const pages = (ok(await exec(CUSTOMER_PAGES, { as: f.customer, variables: { c: f.contract.id } })).contract as { concepts: Array<{ pages: Array<{ id: string }> }> }).concepts[0].pages;
  for (const page of pages) {
    ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: page.id } }));
  }
  ok(await exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  mail.length = 0;
  sms.length = 0;
  return reached;
}

/** A zip built in-process, as `mockupBundle.test.ts` and `j9a.test.ts` do. */
function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

const page = (title: string, body = '') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** Iteration one: only the home page. */
const V1: Record<string, string> = {
  'index.html': page('Home V1', '<a href="/about.html">About</a> HOME-V1'),
  'css/app.css': 'body { color: red; }',
};
/** Iteration two: the about page has arrived. */
const V2: Record<string, string> = {
  ...V1,
  'index.html': page('Home V2', '<a href="/about.html">About</a> HOME-V2'),
  'about.html': page('About V2', 'ABOUT-V2'),
};

/** A `MOCKUP_BUNDLE` stored the way the upload route stores one, owned by a contract. */
async function bundleFile(files: Record<string, string | Buffer> = V1, contractId: string = f.contract.id, uploader: User = staff.DESIGNER) {
  const zip = await zipOf(files);
  const key = await storage.put('PRIVATE', zip, '.zip');
  return prisma.storedFile.create({
    data: { key, class: 'MOCKUP_BUNDLE', visibility: 'PRIVATE', mime: 'application/zip', bytes: zip.length, originalName: 'mockup.zip', contractId, uploadedById: uploader.id },
  });
}

const CREATE_DEMO = 'mutation($c: ID!){ createMockupDemo(contractId: $c) { id } }';
const MAP = 'mutation($p: ID!, $path: String!){ mapMockupPage(demoPageId: $p, path: $path) { id } }';
const DECLARE =
  'mutation($d: ID!, $f: ID!, $ch: [BuildChangeInput!]!){ declareMockupBuild(demoId: $d, fileId: $f, changes: $ch) { id number kind publishedAt } }';
const PUBLISH = 'mutation($b: ID!){ publishBuild(buildId: $b) { id number kind publishedAt } }';
const APPROVE_MOCKUP = 'mutation($c: ID!){ approveMockup(contractId: $c) { id } }';

const MOCKUP_READ = `query($c: ID!){ contract(id: $c) {
  id
  wizard { step status locked iterationsUsed allowance }
  timeline { kind number step }
  mockup {
    id kind stagingUrl publishedAt fixedFrameLines bundlePages
    pages { id key canonicalPath }
    builds { id kind number publishedAt }
    frame { lines { id kind textEn scopeItem { key } feedbackItem { id status } } }
  }
} }`;

type MockupOut = {
  id: string;
  kind: string;
  stagingUrl: string | null;
  publishedAt: string | null;
  fixedFrameLines: string[];
  bundlePages: string[];
  pages: Array<{ id: string; key: string; canonicalPath: string }>;
  builds: Array<{ id: string; kind: string; number: number; publishedAt: string | null }>;
  frame: { lines: Array<{ id: string; kind: string; textEn: string; scopeItem: { key: string } | null; feedbackItem: { id: string; status: string } | null }> } | null;
};
type ContractOut = {
  id: string;
  wizard: Array<{ step: string; status: string; locked: boolean; iterationsUsed: number | null; allowance: number | null }>;
  timeline: Array<{ kind: string; number: number | null; step: string | null }>;
  mockup: MockupOut | null;
};
const read = async (as: User = staff.DESIGNER): Promise<ContractOut> =>
  ok(await exec(MOCKUP_READ, { as, variables: { c: f.contract.id } })).contract as ContractOut;
const wizardStep = (c: ContractOut, step: string) => c.wizard.find((s) => s.step === step)!;
const pageOf = (m: MockupOut, key: string) => m.pages.find((p) => p.key === key)!;
const lineOf = (m: MockupOut, key: string) => m.frame!.lines.find((l) => l.scopeItem?.key === key)!;

/** Step 5 started: the demo exists, pages declared and unmapped. */
async function startMockup(over: Record<string, unknown> = {}) {
  await reachMockup(over);
  ok(await asDesigner(CREATE_DEMO));
  return (await read()).mockup!;
}

type Change = { feedbackItemId?: string; scopeItemId?: string; outcome?: string; note?: string; noteLang?: string };

/** Declare (and optionally publish) an iteration as the designer; returns the build. */
async function iteration(demoId: string, files: Record<string, string | Buffer>, changes: Change[] = [], publish = true) {
  const file = await bundleFile(files);
  const build = ok(await asDesigner(DECLARE, { d: demoId, f: file.id, ch: changes })).declareMockupBuild as { id: string; number: number };
  if (publish) ok(await asDesigner(PUBLISH, { b: build.id }));
  return build;
}

const SUBMIT = `
  mutation($c: ID!, $t: FeedbackTargetInput!, $b: String!) {
    submitFeedback(contractId: $c, step: MOCKUP, target: $t, body: $b) { item { id status step } }
  }
`;
const comment = async (target: Record<string, unknown>, body = 'please change this') =>
  (ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: target, b: body } })).submitFeedback as { item: { id: string; status: string } }).item;

type Raw = { status: number; text: string };
/** A request with a `Host` of the test's choosing — `fetch` will not reliably send one. */
function raw(path: string, host: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: app.port, path, method: 'GET', headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const hostOf = (url: string) => new URL(url).host.replace(/:\d+$/, `:${env.PORT}`);

// =================================================================================================
// The road: who can start a mockup, and when
// =================================================================================================

test('createMockupDemo: a MOCKUP demo of this contract, one unmapped page per agreed PAGE item (not the feature), nothing published', async () => {
  await reachMockup();
  const before = await read();
  assert.equal(before.mockup, null, 'nothing until the designer starts');
  assert.equal(wizardStep(before, 'MOCKUP').status, 'CURRENT', 'the design is approved, so the mockup is the current step');

  ok(await asDesigner(CREATE_DEMO));
  const { mockup } = await read();
  assert.equal(mockup!.kind, 'MOCKUP');
  assert.equal(mockup!.stagingUrl, null, 'Demo.stagingUrl is nullable now — a mockup has no stored URL');
  assert.equal(mockup!.publishedAt, null);
  assert.deepEqual(mockup!.pages.map((p) => [p.key, p.canonicalPath]), [['home', ''], ['about', '']]);
  assert.deepEqual(mockup!.fixedFrameLines, ['MOCKUP_TEMPORARY']);
  assert.deepEqual(mockup!.builds, []);
  assert.equal(mockup!.frame, null, 'no frame until there is a bundle to describe');

  const demo = await prisma.demo.findUniqueOrThrow({ where: { id: mockup!.id } });
  assert.deepEqual([demo.kind, demo.contractId, demo.projectId, demo.phaseId, demo.stagingUrl], ['MOCKUP', f.contract.id, f.contract.projectId, null, null]);
  const labels = await prisma.demoPage.findMany({ where: { demoId: demo.id }, orderBy: { key: 'asc' } });
  assert.deepEqual(labels.map((p) => p.labelEn), ['About', 'Home page'], 'labelled from the registry');

  assert.equal((await asDesigner(CREATE_DEMO)).code, 'MOCKUP_DEMO_EXISTS');
  assert.equal(await prisma.demo.count({ where: { kind: 'MOCKUP' } }), 1);
});

test('createMockupDemo picks up only what is agreed: a declined page is not a page of the mockup', async () => {
  await reachMockup();
  await prisma.scopeItem.updateMany({ where: { contractId: f.contract.id, key: 'about' }, data: { status: 'DECLINED', declinedReason: 'r' } });
  ok(await asDesigner(CREATE_DEMO));
  assert.deepEqual((await read()).mockup!.pages.map((p) => p.key), ['home']);
});

test('createMockupDemo refuses in the road’s order: a locked step, a legacy contract, no brief, the pre-made path, an unapproved design, no pages', async () => {
  // The design is not approved yet.
  await reachDesign();
  assert.equal((await asDesigner(CREATE_DEMO)).code, 'DESIGN_NOT_APPROVED');
  // …pre-made has no mockup at all.
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'THEME_PICK' } });
  assert.equal((await asDesigner(CREATE_DEMO)).code, 'NOT_CUSTOM');
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'SENIOR_DESIGNER' } });
  // …no brief, no path.
  const brief = await prisma.contractBrief.findUniqueOrThrow({ where: { contractId: f.contract.id } });
  await prisma.contractBrief.delete({ where: { contractId: f.contract.id } });
  assert.equal((await asDesigner(CREATE_DEMO)).code, 'BRIEF_MISSING');
  await prisma.contractBrief.create({ data: { contractId: f.contract.id, kind: brief.kind, templateTypeId: type.id, designTier: 'SENIOR_DESIGNER', mockupIterations: 2 } });

  // Design approved, but nothing agreed to show.
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  await prisma.scopeItem.updateMany({ where: { contractId: f.contract.id, kind: 'PAGE' }, data: { status: 'DECLINED', declinedReason: 'r' } });
  assert.equal((await asDesigner(CREATE_DEMO)).code, 'NO_PAGES');
  assert.equal(await prisma.demo.count(), 0, 'and every refusal wrote nothing');

  // The legacy road has no mockup step.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await asDesigner(CREATE_DEMO)).code, 'STEP_NOT_ON_ROAD');
});

test('the admin stands in for the designer (assignments.override) — and only the admin', async () => {
  await reachMockup();
  ok(await exec(CREATE_DEMO.replace('$c', '$c'), { as: f.admin, variables: { c: f.contract.id } }));
  assert.equal(await prisma.demo.count({ where: { kind: 'MOCKUP' } }), 1);
});

// =================================================================================================
// The guards: design authorship, not build authorship
// =================================================================================================

test('every mockup mutation and its guard: a developer, sales, the customer and another contract’s designer are each refused, and a refusal writes nothing', async () => {
  const demo = await startMockup();
  const file = await bundleFile(V1);
  const draft = ok(await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [] })).declareMockupBuild as { id: string };
  const pageId = pageOf(demo, 'home').id;

  const snapshot = async () => ({
    pages: await prisma.demoPage.findMany({ orderBy: { id: 'asc' } }),
    builds: await prisma.build.findMany({ orderBy: { id: 'asc' } }),
    demos: await prisma.demo.count(),
    frames: await prisma.demoFrame.count(),
    files: await prisma.storedFile.count(),
  });
  const spare = await bundleFile(V2);
  const before = await snapshot();

  const rows: Array<[string, (as: User) => ReturnType<typeof exec>, Record<string, string>]> = [
    ['createMockupDemo', (as) => asDesigner(CREATE_DEMO, {}, as), { DEVELOPER: 'FORBIDDEN', SALES: 'FORBIDDEN', DESIGNER2: 'NOT_ASSIGNED', CUSTOMER: 'FORBIDDEN' }],
    ['mapMockupPage', (as) => asDesigner(MAP, { p: pageId, path: '/' }, as), { DEVELOPER: 'FORBIDDEN', SALES: 'FORBIDDEN', DESIGNER2: 'NOT_ASSIGNED', CUSTOMER: 'FORBIDDEN' }],
    ['declareMockupBuild', (as) => asDesigner(DECLARE, { d: demo.id, f: spare.id, ch: [] }, as), { DEVELOPER: 'FORBIDDEN', SALES: 'FORBIDDEN', DESIGNER2: 'NOT_ASSIGNED', CUSTOMER: 'FORBIDDEN' }],
    // publishBuild is one mutation on two surfaces: holding neither capability is FORBIDDEN, the developer's
    // (builds.author) is "no such build" — the mockup is not on their surface.
    ['publishBuild (a MOCKUP build)', (as) => asDesigner(PUBLISH, { b: draft.id }, as), { DEVELOPER: 'NOT_FOUND', SALES: 'FORBIDDEN', DESIGNER2: 'NOT_ASSIGNED', CUSTOMER: 'FORBIDDEN' }],
  ];
  const actors: Record<string, User> = { DEVELOPER: staff.DEVELOPER, SALES: staff.SALES, DESIGNER2: staff.DESIGNER2, CUSTOMER: f.customer };
  for (const [name, run, expected] of rows) {
    for (const [who, code] of Object.entries(expected)) {
      assert.equal((await run(actors[who])).code, code, `${name} as ${who}`);
    }
  }
  assert.deepEqual(await snapshot(), before, 'no refusal wrote anything');

  // The customer's own mutation: every staff role hears "no such contract", a stranger customer too.
  const stranger = await prisma.user.findUniqueOrThrow({ where: { email: 'stranger@test.local' } });
  for (const who of [f.admin, staff.SALES, staff.DESIGNER, staff.DESIGNER2, staff.DEVELOPER, stranger]) {
    assert.equal((await asDesigner(APPROVE_MOCKUP, {}, who)).code, 'NOT_FOUND', `approveMockup as ${who.email}`);
  }
  assert.equal(await prisma.stepApproval.count({ where: { step: 'MOCKUP' } }), 0);

  // The designer is the contract's designer: every one of the four works for them.
  ok(await asDesigner(MAP, { p: pageId, path: '/' }));
  ok(await asDesigner(PUBLISH, { b: draft.id }));
});

test('a SITE demo, page or build is not on the designer’s surface — NOT_FOUND, or FORBIDDEN where the capability is missing; another contract’s bundle is no bundle', async () => {
  const demo = await startMockup();
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 7, titleFa: 'ف', titleEn: 'P' } });
  const site = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://site.example.com', publishedAt: new Date() } });
  const sitePage = await prisma.demoPage.create({ data: { demoId: site.id, key: 'k', labelFa: 'ک', labelEn: 'K', canonicalPath: '/k' } });
  const siteBuild = await prisma.build.create({ data: { kind: 'SITE', projectId: f.contract.projectId, phaseId: phase.id, number: 1, declaredById: staff.DEVELOPER.id } });
  const file = await bundleFile(V1);

  assert.equal((await asDesigner(MAP, { p: sitePage.id, path: '/x' })).code, 'NOT_FOUND');
  assert.equal((await asDesigner(DECLARE, { d: site.id, f: file.id, ch: [] })).code, 'NOT_FOUND');
  // A designer asking to publish a site build: they hold design.author, not builds.author.
  assert.equal((await asDesigner(PUBLISH, { b: siteBuild.id })).code, 'FORBIDDEN');
  assert.equal((await prisma.build.findUniqueOrThrow({ where: { id: siteBuild.id } })).publishedAt, null);

  // A bundle uploaded to a different contract, and a file that is not a bundle.
  const other = await prisma.contract.create({
    data: { ref: 'RC-OTHER', titleFa: 'د', titleEn: 'Other', customerId: f.customer.id, projectId: f.contract.projectId, designerId: staff.DESIGNER.id },
  });
  const foreign = await bundleFile(V1, other.id);
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: foreign.id, ch: [] })).code, 'NOT_FOUND');
  const image = await prisma.storedFile.create({
    data: { key: await storage.put('PRIVATE', Buffer.from('x'), '.png'), class: 'DESIGN_IMAGE', visibility: 'PRIVATE', mime: 'image/png', bytes: 1, originalName: 'a.png', contractId: f.contract.id, uploadedById: staff.DESIGNER.id },
  });
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: image.id, ch: [] })).code, 'NOT_FOUND');
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: 'nope', ch: [] })).code, 'NOT_FOUND');
  assert.equal(await prisma.build.count({ where: { kind: 'MOCKUP' } }), 0);
});

// =================================================================================================
// The mapping
// =================================================================================================

test('mapMockupPage: every spelling of a page is one stored path; blank unmaps; two pages cannot share one; a path no bundle could hold is refused', async () => {
  const demo = await startMockup();
  const about = pageOf(demo, 'about').id;
  const home = pageOf(demo, 'home').id;
  for (const typed of ['about.html', '/about.html', '/about/', ' /About.HTML ']) {
    ok(await asDesigner(MAP, { p: about, path: typed }));
    assert.equal(pageOf((await read()).mockup!, 'about').canonicalPath, '/about', typed);
  }
  ok(await asDesigner(MAP, { p: home, path: 'index.html' }));
  assert.equal(pageOf((await read()).mockup!, 'home').canonicalPath, '/');

  assert.equal((await asDesigner(MAP, { p: home, path: '/about.html' })).code, 'PATH_ALREADY_MAPPED');
  assert.equal(pageOf((await read()).mockup!, 'home').canonicalPath, '/', 'and the refusal changed nothing');
  assert.equal((await asDesigner(MAP, { p: home, path: '/a\\b' })).code, 'INVALID_PATH');
  assert.equal((await asDesigner(MAP, { p: home, path: '/' + 'x'.repeat(400) })).code, 'INVALID_PATH');

  ok(await asDesigner(MAP, { p: about, path: '   ' }));
  assert.equal(pageOf((await read()).mockup!, 'about').canonicalPath, '', 'blank unmaps');
  ok(await asDesigner(MAP, { p: home, path: '/about' }));
  assert.equal(pageOf((await read()).mockup!, 'home').canonicalPath, '/about', 'and the freed path can be taken');
});

test('a reported path matches only mapped pages, through the same fold — an unmapped page never claims the home page', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V2);
  const REPORT = 'mutation($d: ID!, $p: String!){ reportDemoPath(demoId: $d, path: $p) { matched normalizedPath page { key } } }';
  const report = async (path: string) =>
    ok(await exec(REPORT, { as: f.customer, variables: { d: demo.id, p: path } })).reportDemoPath as { matched: boolean; page: { key: string } | null };

  // Nothing mapped: nothing matches — in particular "/" is not "home".
  assert.deepEqual(await report('/'), { matched: false, normalizedPath: '/', page: null });
  ok(await asDesigner(MAP, { p: pageOf(demo, 'about').id, path: 'about.html' }));
  assert.equal((await report('/about')).page?.key, 'about');
  assert.equal((await report('/about.html')).page?.key, 'about');
  assert.equal((await report('/about/?x=1')).page?.key, 'about');
  assert.equal((await report('/')).matched, false, 'home is still unmapped');
  assert.equal((await prisma.demoUnmatchedPath.count({ where: { demoId: demo.id } })), 1, 'and the unrouted path is counted, not lost');
});

// =================================================================================================
// Iterations: numbering, dispositions, direct answers
// =================================================================================================

test('numbered per kind: the mockup’s "mockup 2" and a site’s "version 1" beside it do not consume each other’s numbers', async () => {
  const demo = await startMockup();
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 7, titleFa: 'ف', titleEn: 'P' } });
  const one = await iteration(demo.id, V1);
  const site = ok(
    await exec('mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id number kind } }', {
      as: staff.DEVELOPER,
      variables: { p: phase.id, c: [{ note: 'first site build', noteLang: 'en' }] },
    }),
  ).declareBuild as { number: number; kind: string };
  const two = await iteration(demo.id, V2);
  assert.deepEqual([one.number, site.number, two.number, site.kind], [1, 1, 2, 'SITE']);
  const builds = await prisma.build.findMany({ where: { projectId: f.contract.projectId }, orderBy: [{ kind: 'asc' }, { number: 'asc' }] });
  assert.deepEqual(builds.map((b) => [b.kind, b.number]), [['MOCKUP', 1], ['MOCKUP', 2], ['SITE', 1]]);
  assert.equal(builds[0].demoId, demo.id);
  assert.equal(builds[0].phaseId, null);
  // …and a second SITE build is version 2 whatever the mockup has done.
  const again = ok(
    await exec('mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { number } }', {
      as: staff.DEVELOPER,
      variables: { p: phase.id, c: [{ note: 'second', noteLang: 'en' }] },
    }),
  ).declareBuild as { number: number };
  assert.equal(again.number, 2);
});

test('a bundle serves one iteration, and a change entry may not ship a registry item', async () => {
  const demo = await startMockup();
  const file = await bundleFile(V1);
  ok(await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [] }));
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [] })).code, 'FILE_ALREADY_USED');

  const item = await prisma.scopeItem.findFirstOrThrow({ where: { contractId: f.contract.id, key: 'home' } });
  await prisma.scopeItem.update({ where: { id: item.id }, data: { status: 'IN_BUILD' } });
  const next = await bundleFile(V2);
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: next.id, ch: [{ scopeItemId: item.id }] })).code, 'SCOPE_ITEM_NOT_ON_MOCKUP');
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'IN_BUILD', 'a picture of a page does not ship it');
  // An unprompted note is an entry like any other.
  ok(await asDesigner(DECLARE, { d: demo.id, f: next.id, ch: [{ note: 'tidied the footer', noteLang: 'en' }] }));
  assert.equal(await prisma.buildChangeEntry.count({ where: { feedbackItemId: null, scopeItemId: null } }), 1);
});

test('the second iteration’s fates: every open MOCKUP note needs a disposition, each a direct answer the customer sees — and only the mockup step’s notes count', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V1);
  const a = await comment({ demoId: demo.id, demoPageId: pageOf(demo, 'home').id }, 'the header is too tall');
  const b = await comment({ demoId: demo.id, demoPageId: pageOf(demo, 'about').id }, 'where is the team photo?');
  const c = await comment({ general: true }, 'overall: more whitespace');
  // Another step’s open note — the mockup’s build must neither require nor drain it.
  const foreign = await prisma.feedbackItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DRAFT', general: true, status: 'OPEN' },
  });

  const file = await bundleFile(V2);
  const missing = await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [{ feedbackItemId: a.id, outcome: 'ADDRESSED' }] });
  assert.equal(missing.code, 'MISSING_DISPOSITION');
  assert.equal(await prisma.build.count({ where: { kind: 'MOCKUP' } }), 1, 'a refused declaration wrote no build');
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: a.id } })).status, 'OPEN', 'and no fate');
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [{ feedbackItemId: a.id, outcome: 'DECLINED' }, { feedbackItemId: b.id, outcome: 'ADDRESSED' }, { feedbackItemId: c.id, outcome: 'CARRIED_FORWARD' }] })).code, 'DECLINE_REASON_REQUIRED');
  assert.equal((await asDesigner(DECLARE, { d: demo.id, f: file.id, ch: [{ feedbackItemId: foreign.id, outcome: 'ADDRESSED' }, { feedbackItemId: a.id, outcome: 'ADDRESSED' }, { feedbackItemId: b.id, outcome: 'ADDRESSED' }, { feedbackItemId: c.id, outcome: 'ADDRESSED' }] })).code, 'NOT_FOUND', 'another step’s item is not on this list');

  const build = ok(
    await asDesigner(DECLARE, {
      d: demo.id,
      f: file.id,
      ch: [
        { feedbackItemId: a.id, outcome: 'ADDRESSED', note: 'lowered to 72px', noteLang: 'en' },
        { feedbackItemId: b.id, outcome: 'DECLINED', note: 'the team photo comes with the content', noteLang: 'en' },
        { feedbackItemId: c.id, outcome: 'CARRIED_FORWARD' },
      ],
    }),
  ).declareMockupBuild as { id: string; number: number };
  assert.equal(build.number, 2);

  const rows = Object.fromEntries((await prisma.feedbackItem.findMany({ where: { step: 'MOCKUP' }, include: { comments: { orderBy: { createdAt: 'asc' } } } })).map((i) => [i.id, i]));
  assert.equal(rows[a.id].status, 'ADDRESSED');
  assert.equal(rows[a.id].addressedInBuildId, build.id);
  assert.equal(rows[b.id].status, 'DECLINED');
  assert.equal(rows[c.id].status, 'OPEN', 'carried forward: still blocks the step');
  // The answers are the designer's, direct (answers.direct.mockup): no sales approval is waiting.
  const answers = rows[a.id].comments.filter((x) => x.authorId === staff.DESIGNER.id);
  assert.deepEqual(answers.map((x) => [x.resolution, x.approval, x.body]), [['ADDRESSED', 'NOT_REQUIRED', 'lowered to 72px']]);
  assert.equal(await prisma.feedbackComment.count({ where: { approval: 'PENDING' } }), 0);
  // The other step’s item is exactly as it was.
  const untouched = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: foreign.id }, include: { comments: true } });
  assert.deepEqual([untouched.status, untouched.comments.length], ['OPEN', 0]);

  // The customer reads the fates in the thread once the iteration is out, and the declined one with its reason.
  ok(await asDesigner(PUBLISH, { b: build.id }));
  const thread = ok(await exec('query($c: ID!){ contract(id: $c) { feedbackItems(step: MOCKUP) { id status comments { body resolution approval } } } }', { as: f.customer, variables: { c: f.contract.id } }))
    .contract as { feedbackItems: Array<{ id: string; status: string; comments: Array<{ body: string; resolution: string | null }> }> };
  const byId = Object.fromEntries(thread.feedbackItems.map((i) => [i.id, i]));
  assert.equal(byId[b.id].status, 'DECLINED');
  assert.ok(byId[b.id].comments.some((x) => x.resolution === 'DECLINED' && x.body === 'the team photo comes with the content'));
  assert.ok(byId[a.id].comments.some((x) => x.resolution === 'ADDRESSED'));
});

test('answers.direct.mockup is the designer’s: a developer’s answer on a mockup note waits for sales, the designer’s does not', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V1);
  const item = await comment({ demoId: demo.id, demoPageId: pageOf(demo, 'home').id });
  const ANSWER = 'mutation($i: ID!, $b: String!, $r: FeedbackResolution){ answerFeedback(itemId: $i, body: $b, resolution: $r) { id status comments { approval } } }';

  const viaDeveloper = await exec(ANSWER, { as: staff.DEVELOPER, variables: { i: item.id, b: 'we will look', r: null } });
  assert.deepEqual(ok(viaDeveloper).answerFeedback, { id: item.id, status: 'OPEN', comments: [{ approval: 'NOT_REQUIRED' }, { approval: 'PENDING' }] });
  const viaDesigner = ok(await exec(ANSWER, { as: staff.DESIGNER, variables: { i: item.id, b: 'fixed', r: 'ADDRESSED' } })).answerFeedback as { status: string; comments: Array<{ approval: string }> };
  assert.equal(viaDesigner.status, 'ADDRESSED');
  assert.equal(viaDesigner.comments.at(-1)!.approval, 'NOT_REQUIRED');
});

// =================================================================================================
// The frame: from design, per iteration
// =================================================================================================

test('the frame is from design: NEW for pages the bundle shows, KNOWN_MISSING for the ones it does not, one fixed line that is a code — and a page changing bucket is the same line', async () => {
  const demo = await startMockup();
  ok(await asDesigner(MAP, { p: pageOf(demo, 'home').id, path: '/' }));
  // "about" is mapped to a path iteration one does not have.
  ok(await asDesigner(MAP, { p: pageOf(demo, 'about').id, path: '/about.html' }));
  await iteration(demo.id, V1);

  const first = (await read()).mockup!;
  assert.deepEqual(first.frame!.lines.map((l) => [l.scopeItem?.key, l.kind]), [['home', 'NEW'], ['about', 'KNOWN_MISSING']]);
  assert.deepEqual(first.bundlePages, ['/'], 'staff are told which pages the newest bundle has');
  assert.deepEqual(first.fixedFrameLines, ['MOCKUP_TEMPORARY'], 'the temporary line is a code for the web to word, never a stored sentence');
  assert.equal(await prisma.demoFrameLine.count({ where: { kind: 'TEMPORARY' } }), 0, 'and not a row');
  assert.equal(await prisma.demoFrameLine.count({ where: { kind: 'DECIDED' } }), 0);
  assert.equal(await prisma.scopeItem.count({ where: { status: { in: ['IN_BUILD', 'IN_DEMO'] } } }), 0, 'and the registry did not move');
  const aboutLine = lineOf(first, 'about');

  // The customer comments on the missing page’s line; iteration two brings the page.
  const onLine = await comment({ demoId: demo.id, frameLineId: aboutLine.id }, 'the about page is not here');
  await iteration(demo.id, V2, [{ feedbackItemId: onLine.id, outcome: 'ADDRESSED', note: 'added', noteLang: 'en' }]);

  const second = (await read()).mockup!;
  const moved = lineOf(second, 'about');
  assert.equal(moved.id, aboutLine.id, 'the same row');
  assert.equal(moved.kind, 'NEW');
  assert.equal(moved.feedbackItem?.id, onLine.id, 'and the customer’s thread went with it');
  assert.deepEqual(second.bundlePages.sort(), ['/', '/about']);
  assert.equal(second.frame!.lines.length, 2, 'one line per page, not a line per iteration');
});

test('an agreed page added after the mockup started becomes a page of it, and a mapping to a path the bundle lacks is missing rather than refused', async () => {
  const demo = await startMockup();
  await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'faq', labelFa: 'پرسش‌ها', labelEn: 'FAQ', kind: 'PAGE', status: 'AGREED', position: 9 },
  });
  ok(await asDesigner(MAP, { p: pageOf(demo, 'home').id, path: '/nowhere' }));
  await iteration(demo.id, V1);
  const after = (await read()).mockup!;
  assert.deepEqual(after.pages.map((p) => p.key).sort(), ['about', 'faq', 'home']);
  assert.deepEqual(after.frame!.lines.map((l) => l.kind), ['KNOWN_MISSING', 'KNOWN_MISSING', 'KNOWN_MISSING'], 'home is mapped to a path the bundle does not have');
});

// =================================================================================================
// The allowance
// =================================================================================================

test('the allowance: the iteration about to be published must fit (2 of 2) — ALLOWANCE_EXHAUSTED, sales is told, an extension admits one more, and declaring was always free', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V1);
  await iteration(demo.id, V2);
  let c = await read();
  assert.deepEqual([wizardStep(c, 'MOCKUP').iterationsUsed, wizardStep(c, 'MOCKUP').allowance], [2, 2]);

  // Declaring a third costs nothing; publishing it does not fit.
  const third = await iteration(demo.id, { ...V2, 'index.html': page('Home V3', 'HOME-V3') }, [], false);
  mail.length = 0;
  const refused = await asDesigner(PUBLISH, { b: third.id });
  assert.equal(refused.code, 'ALLOWANCE_EXHAUSTED');
  assert.equal((await prisma.build.findUniqueOrThrow({ where: { id: third.id } })).publishedAt, null);
  const told = mail.filter((m) => /Rounds used up|دورهای مجاز/.test(m.subject));
  assert.ok(told.some((m) => m.to === 'sales@test.local'), 'sales was told the mockup’s rounds are used up');
  assert.match(told[0].text ?? '', /Mockup|ماکت/, 'and which step');

  // The extension is sales’: a designer cannot raise their own allowance.
  const EXTEND = 'mutation($c: ID!, $s: StepKind!, $e: Int!){ extendAllowance(contractId: $c, step: $s, extra: $e, reason: "They asked for another look") { id } }';
  assert.equal((await asDesigner(EXTEND, { s: 'MOCKUP', e: 1 }, staff.DESIGNER)).code, 'FORBIDDEN');
  ok(await asDesigner(EXTEND, { s: 'MOCKUP', e: 1 }, staff.SALES));
  assert.equal((await prisma.allowanceExtension.findFirstOrThrow()).step, 'MOCKUP');
  ok(await asDesigner(PUBLISH, { b: third.id }));
  c = await read();
  assert.deepEqual([wizardStep(c, 'MOCKUP').iterationsUsed, wizardStep(c, 'MOCKUP').allowance], [3, 3], '"mockup 3 of 3"');
  // …and a fourth is out of rounds again.
  const fourth = await iteration(demo.id, { ...V2, 'index.html': page('Home V4', 'HOME-V4') }, [], false);
  assert.equal((await asDesigner(PUBLISH, { b: fourth.id })).code, 'ALLOWANCE_EXHAUSTED');
});

test('a charged mockup extension is a draft invoice worded for the mockup', async () => {
  await startMockup();
  ok(
    await exec('mutation($c: ID!){ extendAllowance(contractId: $c, step: MOCKUP, extra: 2, reason: "r", charge: "5000000") { id } }', {
      as: staff.SALES,
      variables: { c: f.contract.id },
    }),
  );
  const entry = await prisma.billingEntry.findFirstOrThrow({ where: { customerId: f.customer.id, amount: 5_000_000n } });
  assert.equal(entry.descriptionEn, '2 extra mockup rounds');
  assert.match(entry.descriptionFa, /ماکت/);
  assert.equal(entry.issuedAt, null, 'a draft: invisible to the customer until issued');
});

test('publishing: an older draft is superseded once a newer iteration is out, a build publishes once, and only a published iteration counts', async () => {
  const demo = await startMockup();
  const older = await iteration(demo.id, V1, [], false);
  const newer = await iteration(demo.id, V2, [], false);
  ok(await asDesigner(PUBLISH, { b: newer.id }));
  assert.equal((await asDesigner(PUBLISH, { b: older.id })).code, 'BUILD_SUPERSEDED');
  assert.equal((await asDesigner(PUBLISH, { b: newer.id })).code, 'ALREADY_PUBLISHED');
  const c = await read();
  assert.deepEqual([wizardStep(c, 'MOCKUP').iterationsUsed, c.mockup!.builds.filter((b) => b.publishedAt).length], [1, 1], 'one iteration reached the customer; the abandoned draft cost nothing');
  assert.notEqual(c.mockup!.publishedAt, null, 'the demo is published with its first iteration');
});

// =================================================================================================
// What the customer sees, and is told
// =================================================================================================

test('the customer sees nothing until an iteration is out, then the mockup with its published builds only — and their viewer URL opens the current one', async () => {
  const demo = await startMockup();
  const draft = await iteration(demo.id, V1, [], false);
  assert.equal((await read(f.customer)).mockup, null, 'a draft mockup is staff’s');
  assert.equal((await exec('query($d: ID!){ mockupViewUrl(demoId: $d) }', { as: f.customer, variables: { d: demo.id } })).code, 'NO_PUBLISHED_MOCKUP');

  ok(await asDesigner(PUBLISH, { b: draft.id }));
  let seen = (await read(f.customer)).mockup!;
  assert.deepEqual(seen.builds.map((b) => b.number), [1]);
  assert.equal(seen.stagingUrl, null);
  const url1 = ok(await exec('query($d: ID!){ mockupViewUrl(demoId: $d) }', { as: f.customer, variables: { d: demo.id } })).mockupViewUrl as string;
  assert.match((await raw('/', hostOf(url1))).text, /HOME-V1/);

  // Iteration two: a declared-but-unpublished draft is not shown; once published, a fresh view opens it.
  const second = await iteration(demo.id, V2, [], false);
  seen = (await read(f.customer)).mockup!;
  assert.deepEqual(seen.builds.map((b) => b.number), [1]);
  ok(await asDesigner(PUBLISH, { b: second.id }));
  seen = (await read(f.customer)).mockup!;
  assert.deepEqual(seen.builds.map((b) => b.number), [1, 2]);
  const url2 = ok(await exec('query($d: ID!){ mockupViewUrl(demoId: $d) }', { as: f.customer, variables: { d: demo.id } })).mockupViewUrl as string;
  assert.notEqual(url2, url1);
  const home = await raw('/', hostOf(url2));
  assert.match(home.text, /HOME-V2/);
  assert.equal((await raw('/about.html', hostOf(url2))).text.includes('ABOUT-V2'), true, 'the mockup’s own root-relative link resolves');
  assert.match((await raw('/', hostOf(url1))).text, /HOME-V1/, 'the old view is still the old iteration — a grant is pinned to its build');
});

test('the wizard and the history rail carry the mockup: the step is current, counts its iterations, and each publish is a timeline line', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V1);
  await iteration(demo.id, V2);
  const c = await read(f.customer);
  assert.deepEqual(wizardStep(c, 'MOCKUP'), { step: 'MOCKUP', status: 'CURRENT', locked: false, iterationsUsed: 2, allowance: 2 });
  assert.deepEqual(c.timeline.filter((t) => t.kind === 'MOCKUP_PUBLISHED').map((t) => [t.step, t.number]), [['MOCKUP', 2], ['MOCKUP', 1]]);
});

test('a published iteration tells the customer once — email and SMS, "mockup 2 of 2", in their locale — and approving tells the designer', async () => {
  const demo = await startMockup();
  await iteration(demo.id, V1);
  mail.length = 0;
  sms.length = 0;
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  await iteration(demo.id, V2);
  const toCustomer = mail.filter((m) => m.to === 'customer@test.local');
  assert.equal(toCustomer.length, 1, 'declaring tells nobody; publishing tells once');
  assert.match(toCustomer[0].subject, /Mockup 2 of 2 is ready/);
  assert.match(toCustomer[0].text ?? '', /\/en\/app\/contracts\//);
  assert.deepEqual(sms.map((s) => [s.to, /new mockup is ready/.test(s.text ?? '')]), [['+989120000109', true]]);

  // …in Persian for a Persian customer.
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'fa' } });
  mail.length = 0;
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { mockupIterations: 5 } });
  await iteration(demo.id, { ...V2, 'index.html': page('Home V3', 'HOME-V3') });
  assert.match(mail.find((m) => m.to === 'customer@test.local')!.subject, /ماکتِ ۳ از ۵ آماده است/);

  // The customer approves; the designer hears it, by email and by SMS.
  mail.length = 0;
  sms.length = 0;
  ok(await exec(APPROVE_MOCKUP, { as: f.customer, variables: { c: f.contract.id } }));
  const toDesigner = mail.filter((m) => m.to === 'designer@test.local');
  assert.equal(toDesigner.length, 1);
  assert.match(toDesigner[0].subject, /Mockup approved|ماکت تأیید شد/);
  assert.match(toDesigner[0].text ?? '', /\/desk\/contracts\/.+\/steps/);
  assert.deepEqual(sms.map((s) => s.to), ['+989120000110']);
});

// =================================================================================================
// Approval and the lock
// =================================================================================================

test('approveMockup: refused while a note is open or an answer waits, and until an iteration is out; then it locks the step — one approval writer', async () => {
  const demo = await startMockup();
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'NO_PUBLISHED_MOCKUP');
  await iteration(demo.id, V1, [], false);
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'NO_PUBLISHED_MOCKUP', 'a declared draft is not something the customer was shown');
  const draft = await prisma.build.findFirstOrThrow({ where: { kind: 'MOCKUP' } });
  ok(await asDesigner(PUBLISH, { b: draft.id }));

  const item = await comment({ demoId: demo.id, demoPageId: pageOf(demo, 'home').id });
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'STEP_HAS_OPEN_FEEDBACK');
  // A developer’s answer is pending sales’ approval, and blocks the step just as much.
  ok(await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "later", resolution: ADDRESSED) { id } }', { as: staff.DEVELOPER, variables: { i: item.id } }));
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'STEP_HAS_OPEN_FEEDBACK', 'still OPEN: the answer is pending');
  ok(await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "done", resolution: ADDRESSED) { id } }', { as: staff.DESIGNER, variables: { i: item.id } }));
  await prisma.feedbackComment.updateMany({ where: { approval: 'PENDING' }, data: { approval: 'APPROVED', approvedById: staff.SALES.id, approvedAt: new Date() } });
  ok(await asDesigner(APPROVE_MOCKUP, {}, f.customer));

  const approval = await prisma.stepApproval.findFirstOrThrow({ where: { contractId: f.contract.id, step: 'MOCKUP' } });
  assert.equal(approval.approvedById, f.customer.id);
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'ACCEPTED');
  const c = await read(f.customer);
  assert.deepEqual([wizardStep(c, 'MOCKUP').status, wizardStep(c, 'MOCKUP').locked], ['DONE', true]);
  assert.equal(wizardStep(c, 'DEMO').status, 'CURRENT', 'and the road moves on');

  // One approval writer: S2’s generic approveStep is gone (J10), and a second approval is the lock.
  assert.equal((await asDesigner('mutation($c: ID!){ approveStep(contractId: $c, step: MOCKUP) { id } }', {}, f.customer)).code, 'GRAPHQL_VALIDATION_FAILED');
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'STEP_LOCKED');
});

test('approveMockup on a pre-made contract and on the legacy road is not a step that exists', async () => {
  await reachDesign();
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'THEME_PICK' } });
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'STEP_NOT_ON_ROAD');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await asDesigner(APPROVE_MOCKUP, {}, f.customer)).code, 'STEP_NOT_APPROVABLE');
});

/** The mockup at the lock: an iteration approved, with what the table needs to name. */
async function lockedMockup() {
  const demo = await startMockup();
  const built = await iteration(demo.id, V1);
  const spare = await bundleFile(V2);
  const draft = await prisma.build.create({
    data: { kind: 'MOCKUP', projectId: f.contract.projectId, demoId: demo.id, bundleFileId: (await bundleFile({ ...V1, 'x.html': page('x') })).id, number: 9, declaredById: staff.DESIGNER.id },
  });
  ok(await asDesigner(APPROVE_MOCKUP, {}, f.customer));
  mail.length = 0;
  sms.length = 0;
  return { demo, built, spare, draft, pageId: pageOf(demo, 'home').id };
}

type LockIds = Awaited<ReturnType<typeof lockedMockup>>;
const lockTable: Array<{ mutation: string; run: (ids: LockIds) => ReturnType<typeof exec> }> = [
  { mutation: 'createMockupDemo', run: () => asDesigner(CREATE_DEMO) },
  { mutation: 'mapMockupPage', run: (ids) => asDesigner('mutation($c: ID!){ __typename }').then(() => prisma.demoPage.findFirstOrThrow({ where: { demoId: ids.demo.id } })).then((p) => asDesigner(MAP, { p: p.id, path: '/elsewhere' })) },
  { mutation: 'declareMockupBuild', run: (ids) => asDesigner(DECLARE, { d: ids.demo.id, f: ids.spare.id, ch: [] }) },
  { mutation: 'publishBuild', run: (ids) => asDesigner(PUBLISH, { b: ids.draft.id }) },
  { mutation: 'approveMockup', run: () => asDesigner(APPROVE_MOCKUP, {}, f.customer) },
  {
    mutation: 'submitFeedback',
    run: (ids) => exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { demoId: ids.demo.id, demoPageId: ids.pageId }, b: 'one more thing' } }),
  },
  {
    mutation: 'answerFeedback',
    run: async (ids) => {
      const item = await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'MOCKUP', general: true, status: 'OPEN' } });
      void ids;
      return exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "x", resolution: ADDRESSED) { id } }', { as: staff.DESIGNER, variables: { i: item.id } });
    },
  },
];

test('after the customer approves, every mockup mutation is STEP_LOCKED — for staff and the customer alike — and a refusal writes nothing', async () => {
  const ids = await lockedMockup();
  const snapshot = async () => ({
    builds: await prisma.build.count(),
    pages: await prisma.demoPage.findMany({ orderBy: { id: 'asc' } }),
    demos: await prisma.demo.count(),
    lines: await prisma.demoFrameLine.count(),
    feedback: await prisma.feedbackItem.count(),
    comments: await prisma.feedbackComment.count(),
    approvals: await prisma.stepApproval.count(),
    published: await prisma.build.count({ where: { publishedAt: { not: null } } }),
  });
  // The answerFeedback row adds an item; take the snapshot after seeding it once.
  const seeded = await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'MOCKUP', general: true, status: 'OPEN' } });
  const before = await snapshot();
  for (const row of lockTable.filter((r) => r.mutation !== 'answerFeedback')) {
    const result = await row.run(ids);
    assert.equal(result.code, 'STEP_LOCKED', `${row.mutation}: ${JSON.stringify(result.errors)}`);
  }
  const answered = await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "x", resolution: ADDRESSED) { id } }', { as: staff.DESIGNER, variables: { i: seeded.id } });
  assert.equal(answered.code, 'STEP_LOCKED', 'answerFeedback');
  assert.deepEqual(await snapshot(), before, 'nothing moved');
  assert.equal(mail.length + sms.length, 0, 'and nobody was told of a refused act');
});

test('the lock table is complete: the call sites of openMockup match the rows above — add a mockup write and this fails until it has a row', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const files = [...readdirSync(dir), ...readdirSync(`${dir}admin/`).map((n) => `admin/${n}`)].filter((n) => n.endsWith('.ts'));
  const sites: Record<string, number> = {};
  let literal = 0;
  for (const name of files) {
    const source = readFileSync(`${dir}${name}`, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const count = (source.match(/\bopenMockup\(tx, /g) ?? []).length;
    if (count > 0) sites[name] = count;
    literal += (source.match(/assertStepOpenOn\([^)]*'MOCKUP'/g) ?? []).length;
  }
  // createMockupDemo, mapMockupPage, declareMockupBuild’s guard, publishMockupBuild; the customer’s approval
  // and the feedback writes are guarded by `approveStepTx`’s and `raiseFeedback`’s own lock.
  assert.deepEqual(sites, { 'mockupStep.ts': 4 });
  // …and openMockup is the one place that asks the wizard whether MOCKUP is locked, apart from
  // declareMockupBuild’s early check (so a locked step is STEP_LOCKED whatever else is wrong).
  assert.equal(literal, 2);
  assert.equal(lockTable.length, 7);
});

test('every mockup mutation in the SDL has a row in the lock table — the table cannot fall behind the schema', () => {
  const sdl = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  const mockupMutations = ['createMockupDemo', 'mapMockupPage', 'declareMockupBuild', 'approveMockup'];
  for (const name of mockupMutations) assert.ok(new RegExp(`\\b${name}\\(`).test(sdl), `${name} is in the schema`);
  const rows = lockTable.map((r) => r.mutation);
  for (const name of mockupMutations) assert.ok(rows.includes(name), `${name} has a row`);
  assert.ok(rows.includes('publishBuild'), 'and publishBuild’s mockup branch has one');
});

test('before the lock nothing is STEP_LOCKED: the approval is the only thing that locks', async () => {
  const demo = await startMockup();
  ok(await asDesigner(MAP, { p: pageOf(demo, 'home').id, path: '/' }));
  await iteration(demo.id, V1);
  ok(await asDesigner(MAP, { p: pageOf(demo, 'home').id, path: '/index.html' }));
  assert.equal(await prisma.stepApproval.count({ where: { step: 'MOCKUP' } }), 0);
});

test('the developer’s and the demo’s own steps are untouched: a SITE demo approves through approveDemo (J10), and the legacy road never sees a mockup', async () => {
  await reachMockup();
  const phase = await prisma.phase.findFirstOrThrow({ where: { contractId: f.contract.id } });
  const site = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://site.example.com', publishedAt: new Date() } });
  void site;
  const result = await exec('mutation($c: ID!, $p: ID!){ approveDemo(contractId: $c, phaseId: $p) { id } }', { as: f.customer, variables: { c: f.contract.id, p: phase.id } });
  assert.equal(result.errors.length, 0, 'the demo step is approved through approveDemo');
});
