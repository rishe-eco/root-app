import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J10 — step 6, the demo: the staging host rule, readiness, the page-map
 * confirmation, the allowance per phase, the "how to test" line, the per-phase
 * approval, the lock, and the invoice it makes issuable (journeys build plan §5
 * "J10").
 *
 * In this order: **the staging host rule** (`createDemo` and `updateDemo`);
 * **readiness** — a browser's claim, recorded with who: who may record it, what
 * clears it, what it gates (`DEMO_NOT_READY`), and the CHECK by direct insert;
 * **the page map** (`PAGE_MAP_UNCONFIRMED`, and an edit un-confirming a draft
 * build); **the allowance per phase** (`ALLOWANCE_EXHAUSTED`, then an extension);
 * **the HOW_TO_TEST line**; **`approveDemo`** (preconditions, and that only that
 * phase's agreed items are accepted); **the lock** — a table of every developer
 * write against `STEP_LOCKED` with a source scan that fails when one is added
 * without a row, as `j7`, `j8` and `j9b` do; **J13's `PHASE_NOT_ACCEPTED` flip
 * through the real mutation**; **the build timeline**; and **J11's close through
 * the real approval** (J11's own tests insert the `StepApproval` by hand).
 *
 * The contract is taken to the door of step 6 the way a customer would: a custom
 * brief with two phases, the scope, the draft approved and signed
 * (`reachDemos`). Staging itself is not served here — readiness is the browser's
 * claim, and the claim is what these tests make through the mutation (the first
 * time the real snippet runs in a browser is e2e `23-demo`).
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000209', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}@test.local`,
        phone: role === 'DEVELOPER' ? '+989120000210' : role === 'SALES' ? '+989120000211' : undefined,
        name: role,
        roles: [role],
        state: 'ACTIVE',
      },
    });
  }
  // A second developer — assigned to nothing.
  staff.DEVELOPER2 = await prisma.user.create({
    data: { email: 'developer2@test.local', name: 'Developer 2', roles: ['DEVELOPER'], state: 'ACTIVE' },
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
  await stop();
  await prisma.$disconnect();
});

// =================================================================================================
// Documents and fixtures
// =================================================================================================

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE =
  'mutation($c: ID!, $n: Int!, $e: String!){ createPhase(contractId: $c, number: $n, titleFa: "فاز", titleEn: "Phase", plannedEndAt: $e) { id } }';
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH_DRAFT = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE_AGREEMENT = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';
const ASSIGN = 'mutation($i: ID!, $p: ID){ assignScopeItemToPhase(scopeItemId: $i, phaseId: $p) { id } }';

const BRIEF_INPUT = {
  kind: 'NEW_SITE',
  templateTypeId: '',
  designTier: 'SENIOR_DESIGNER',
  budgetCap: '150000000',
  hardDeadline: '2026-10-23',
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
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
};

let phase1: { id: string };
let phase2: { id: string };
let plannedRows: Array<{ id: string; phaseId: string | null }>;
const secondContractItem: { id?: string } = {};

/**
 * The contract at the door of step 6: a signed agreement on the new road with two
 * phases (home and about in the first, cart in the second), a payment plan whose two
 * invoices fall due at the phases' acceptance, and the registry's items filed under
 * their phases at the statuses a build would have left them in.
 */
async function reachDemos(over: Record<string, unknown> = {}) {
  const input = { ...BRIEF_INPUT, templateTypeId: type.id, ...over };
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: input } }));
  for (const [n, end] of [[1, '2026-11-10'], [2, '2026-12-10']] as const) {
    ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n, e: end } }));
  }
  const phases = await prisma.phase.findMany({ where: { contractId: f.contract.id }, orderBy: { number: 'asc' } });
  [phase1, phase2] = phases;
  ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: {
        c: f.contract.id,
        r: [
          { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId: phase1.id, paymentTermDays: 7 },
          { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: phase2.id, paymentTermDays: 7 },
        ],
      },
    }),
  );
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  ok(await exec(PUBLISH_DRAFT, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE_AGREEMENT, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));

  const item = (key: string) => prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId, key } });
  for (const [key, phase, status] of [
    ['home', phase1, 'IN_DEMO'],
    ['about', phase1, 'IN_BUILD'],
    ['cart', phase2, 'AGREED'],
  ] as const) {
    const it = await item(key);
    ok(await exec(ASSIGN, { as: staff.SALES, variables: { i: it.id, p: phase.id } }));
    await prisma.scopeItem.update({ where: { id: it.id }, data: { status } });
  }
  // What approving phase 1 must leave alone, filed under it all the same: a proposal not agreed,
  // an item declined, and an item of ANOTHER contract on this project (the registry is the project's).
  await prisma.scopeItem.createMany({
    data: [
      { projectId: f.contract.projectId, contractId: f.contract.id, key: 'proposed', kind: 'FEATURE', status: 'PROPOSED', labelFa: 'پ', labelEn: 'Proposed', phaseId: phase1.id },
      { projectId: f.contract.projectId, contractId: f.contract.id, key: 'declined', kind: 'FEATURE', status: 'DECLINED', declinedReason: 'No', labelFa: 'د', labelEn: 'Declined', phaseId: phase1.id },
    ],
  });
  const other = await prisma.contract.create({
    data: { ref: 'RC-TEST-002', titleFa: 'دوم', titleEn: 'Second', customerId: f.customer.id, projectId: f.contract.projectId, status: 'WAITING_ON_CUSTOMER', publishedAt: new Date() },
  });
  const foreign = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: other.id, key: 'foreign', kind: 'FEATURE', status: 'IN_DEMO', labelFa: 'خ', labelEn: 'Foreign', phaseId: phase1.id },
  });
  secondContractItem.id = foreign.id;
  const plan = await prisma.plannedInvoice.findMany({ where: { plan: { contractId: f.contract.id } }, orderBy: { ordinal: 'asc' } });
  plannedRows = plan.map((p) => ({ id: p.id, phaseId: p.phaseId }));
  mail.length = 0;
  sms.length = 0;
}

const asDev = (query: string, variables: Record<string, unknown> = {}, as: User = staff.DEVELOPER) => exec(query, { as, variables });

const CREATE_DEMO = 'mutation($p: ID!, $u: String!){ createDemo(phaseId: $p, stagingUrl: $u) { id } }';
const UPDATE_DEMO = 'mutation($d: ID!, $u: String, $r: String){ updateDemo(demoId: $d, stagingUrl: $u, buildRef: $r) { id } }';
const DELETE_DEMO = 'mutation($d: ID!){ deleteDemo(demoId: $d) { id } }';
const DECLARE_PAGE =
  'mutation($d: ID!, $k: String!, $p: String!){ declareDemoPage(demoId: $d, key: $k, labelFa: "ص", labelEn: "Page", canonicalPath: $p) { id } }';
const UPDATE_PAGE =
  'mutation($p: ID!, $path: String!){ updateDemoPage(demoPageId: $p, labelFa: "ص", labelEn: "Page", canonicalPath: $path) { id } }';
const DELETE_PAGE = 'mutation($p: ID!){ deleteDemoPage(demoPageId: $p) { id } }';
const GEN_FRAME = 'mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }';
const FRAME_SUMMARY = 'mutation($d: ID!){ updateDemoFrameSummary(demoId: $d, summaryFa: "خ", summaryEn: "S") { id } }';
const ADD_LINE =
  'mutation($d: ID!, $k: DemoFrameLineKind!, $en: String!){ addDemoFrameLine(demoId: $d, kind: $k, textFa: "ف", textEn: $en) { id } }';
const UPDATE_LINE = 'mutation($l: ID!){ updateDemoFrameLine(lineId: $l, textFa: "ف", textEn: "Edited") { id } }';
const DELETE_LINE = 'mutation($l: ID!){ deleteDemoFrameLine(lineId: $l) { id } }';
const VERIFY = 'mutation($d: ID!, $o: String!){ verifyDemoReadiness(demoId: $d, origin: $o) { id } }';
const PUBLISH_DEMO = 'mutation($d: ID!){ publishDemo(demoId: $d) { id } }';
const DECLARE_BUILD =
  'mutation($p: ID!, $ch: [BuildChangeInput!]!){ declareBuild(phaseId: $p, ref: "v", changes: $ch) { id number publishedAt pageMapConfirmedAt } }';
const CONFIRM_MAP = 'mutation($b: ID!){ confirmPageMap(buildId: $b) { id pageMapConfirmedAt } }';
const PUBLISH_BUILD = 'mutation($b: ID!){ publishBuild(buildId: $b) { id number publishedAt } }';
const APPROVE_DEMO = 'mutation($c: ID!, $p: ID!){ approveDemo(contractId: $c, phaseId: $p) { id wizard { step phaseId locked } } }';
const EXTEND =
  'mutation($c: ID!, $p: ID, $x: Int!){ extendAllowance(contractId: $c, step: DEMO, phaseId: $p, extra: $x, reason: "They asked for another look") { id } }';
const SUBMIT = `
  mutation($c: ID!, $p: ID, $t: FeedbackTargetInput!, $b: String!) {
    submitFeedback(contractId: $c, step: DEMO, phaseId: $p, target: $t, body: $b) { item { id status } }
  }
`;
const ANSWER = 'mutation($i: ID!){ answerFeedback(itemId: $i, body: "done", resolution: ADDRESSED) { id } }';
const ISSUE_PLANNED = 'mutation($p: ID!){ issuePlannedInvoice(plannedInvoiceId: $p) { id } }';
const READ_PLAN =
  'query($c: ID!){ contract(id: $c) { paymentPlan { invoices { id state blockedBy phaseId } } } }';

const READ = `query($c: ID!){ contract(id: $c) {
  id
  wizard { step phaseId status locked iterationsUsed allowance }
  buildTimeline { phaseId number plannedEndAt demoPublishedAt acceptedAt builds { id number publishedAt } }
  phases { id number
    builds { id number publishedAt pageMapConfirmedAt }
    demos { id stagingUrl readyAt readyVerifiedBy { id } publishedAt
      pages { id key canonicalPath }
      frame { lines { id kind textEn } } }
  }
} }`;

type PhaseOut = {
  id: string;
  number: number;
  builds: Array<{ id: string; number: number; publishedAt: string | null; pageMapConfirmedAt: string | null }>;
  demos: Array<{
    id: string;
    stagingUrl: string | null;
    readyAt: string | null;
    readyVerifiedBy: { id: string } | null;
    publishedAt: string | null;
    pages: Array<{ id: string; key: string; canonicalPath: string }>;
    frame: { lines: Array<{ id: string; kind: string; textEn: string }> } | null;
  }>;
};
type ContractOut = {
  id: string;
  wizard: Array<{ step: string; phaseId: string | null; status: string; locked: boolean; iterationsUsed: number | null; allowance: number | null }>;
  buildTimeline: Array<{
    phaseId: string;
    number: number;
    plannedEndAt: string | null;
    demoPublishedAt: string | null;
    acceptedAt: string | null;
    builds: Array<{ id: string; number: number; publishedAt: string }>;
  }>;
  phases: PhaseOut[];
};
const read = async (as: User = staff.DEVELOPER): Promise<ContractOut> =>
  ok(await exec(READ, { as, variables: { c: f.contract.id } })).contract as ContractOut;
const phaseOut = (c: ContractOut, id: string) => c.phases.find((p) => p.id === id)!;
const demoStep = (c: ContractOut, id: string) => c.wizard.find((s) => s.step === 'DEMO' && s.phaseId === id)!;

const ORIGIN = 'http://nahal.staging.localhost:5179';

/** The phase's SITE demo, created through the API with two pages declared (home at /, about at /about). */
async function createSiteDemo(phaseId: string, origin = ORIGIN, pages = true) {
  ok(await asDev(CREATE_DEMO, { p: phaseId, u: `${origin}/` }));
  const demo = await prisma.demo.findFirstOrThrow({ where: { phaseId, kind: 'SITE' }, orderBy: { createdAt: 'desc' } });
  if (pages) {
    ok(await asDev(DECLARE_PAGE, { d: demo.id, k: 'home', p: '/' }));
    ok(await asDev(DECLARE_PAGE, { d: demo.id, k: 'about', p: '/about' }));
  }
  return demo;
}

/** …made ready, framed and published — the demo as the customer first sees it. */
async function publishedDemo(phaseId: string, origin = ORIGIN) {
  const demo = await createSiteDemo(phaseId, origin);
  ok(await asDev(GEN_FRAME, { d: demo.id }));
  ok(await asDev(VERIFY, { d: demo.id, o: origin }));
  ok(await asDev(PUBLISH_DEMO, { d: demo.id }));
  return prisma.demo.findUniqueOrThrow({ where: { id: demo.id } });
}

type Change = { feedbackItemId?: string; scopeItemId?: string; outcome?: string; note?: string; noteLang?: string };

/** One iteration as the developer would submit it: declare, confirm the page map, and (optionally) publish. */
async function iteration(phaseId: string, changes: Change[] = [], publish = true) {
  const build = ok(await asDev(DECLARE_BUILD, { p: phaseId, ch: changes })).declareBuild as { id: string; number: number };
  ok(await asDev(CONFIRM_MAP, { b: build.id }));
  if (publish) ok(await asDev(PUBLISH_BUILD, { b: build.id }));
  return build;
}

const comment = async (target: Record<string, unknown>, phaseId: string, body = 'please change this') =>
  (ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, p: phaseId, t: target, b: body } })).submitFeedback as {
    item: { id: string; status: string };
  }).item;

const approve = (phaseId: string, as: User = f.customer) => exec(APPROVE_DEMO, { as, variables: { c: f.contract.id, p: phaseId } });

// =================================================================================================
// The staging host rule
// =================================================================================================

test('createDemo: the host must be exactly one label under STAGING_BASE_DOMAIN — a look-alike, two labels, the bare base, userinfo and another base are refused and write nothing', async () => {
  await reachDemos();
  const refused: Array<[string, string]> = [
    ['https://staging.localhost.evil.com/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://nahal.staging.localhost.evil.com/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://evilstaging.localhost/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://a.b.staging.localhost/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://staging.localhost/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://user:pw@nahal.staging.localhost/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://staging.localhost@evil.com/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://nahal.staging.m-root.com/', 'STAGING_HOST_NOT_ALLOWED'],
    ['https://-a.staging.localhost/', 'STAGING_HOST_NOT_ALLOWED'],
    ['ftp://nahal.staging.localhost/', 'INVALID_STAGING_URL'],
    ['not a url', 'INVALID_STAGING_URL'],
  ];
  for (const [url, code] of refused) {
    assert.equal((await asDev(CREATE_DEMO, { p: phase1.id, u: url })).code, code, url);
  }
  assert.equal(await prisma.demo.count(), 0, 'a refusal writes nothing');

  // What development and e2e accept — http, a port — and the case rule: DNS is case-insensitive,
  // so the same host in capitals is accepted and stored lowercased, the form that was checked.
  ok(await asDev(CREATE_DEMO, { p: phase1.id, u: 'http://nahal.staging.localhost:5179/' }));
  ok(await asDev(CREATE_DEMO, { p: phase2.id, u: 'HTTP://Nahal.STAGING.Localhost:5179/Shop' }));
  assert.equal((await prisma.demo.findFirstOrThrow({ where: { phaseId: phase1.id } })).stagingUrl, 'http://nahal.staging.localhost:5179/');
  assert.equal((await prisma.demo.findFirstOrThrow({ where: { phaseId: phase2.id } })).stagingUrl, 'http://nahal.staging.localhost:5179/Shop');
});

test('updateDemo asks the same question, and the guards come before it: someone who may not touch the phase is not told what a staging URL may be', async () => {
  await reachDemos();
  const demo = await createSiteDemo(phase1.id);
  for (const url of ['https://staging.localhost.evil.com/', 'https://a.b.staging.localhost/', 'https://staging.localhost/', 'https://u@nahal.staging.localhost/']) {
    assert.equal((await asDev(UPDATE_DEMO, { d: demo.id, u: url })).code, 'STAGING_HOST_NOT_ALLOWED', url);
  }
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).stagingUrl, `${ORIGIN}/`, 'unchanged');
  // The guards first.
  const bad = 'https://staging.localhost.evil.com/';
  assert.equal((await asDev(CREATE_DEMO, { p: phase2.id, u: bad }, staff.DESIGNER)).code, 'FORBIDDEN');
  assert.equal((await asDev(CREATE_DEMO, { p: phase2.id, u: bad }, staff.DEVELOPER2)).code, 'NOT_ASSIGNED');
  assert.equal((await asDev(CREATE_DEMO, { p: phase2.id, u: bad }, f.customer)).code, 'FORBIDDEN');
  assert.equal((await asDev(UPDATE_DEMO, { d: demo.id, u: bad }, staff.DEVELOPER2)).code, 'NOT_ASSIGNED');
});

// =================================================================================================
// Readiness — a browser's claim, recorded with who
// =================================================================================================

test('DEMO_NOT_READY: a demo with a frame cannot be published until a browser has heard from the staging site; then it can, and the customer is told by email and SMS', async () => {
  await reachDemos();
  const demo = await createSiteDemo(phase1.id);
  ok(await asDev(GEN_FRAME, { d: demo.id }));
  // The frame gate keeps its place: NO_FRAME is checked first, readiness second.
  const other = await createSiteDemo(phase2.id, 'http://other.staging.localhost:5179');
  assert.equal((await asDev(PUBLISH_DEMO, { d: other.id })).code, 'NO_FRAME');

  assert.equal((await asDev(PUBLISH_DEMO, { d: demo.id })).code, 'DEMO_NOT_READY');
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).publishedAt, null);
  assert.equal(mail.length + sms.length, 0, 'a refused publish tells nobody');

  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }));
  ok(await asDev(PUBLISH_DEMO, { d: demo.id }));
  assert.ok((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).publishedAt);
  assert.equal((await asDev(PUBLISH_DEMO, { d: demo.id })).code, 'ALREADY_PUBLISHED');

  // The customer is told: email in Persian, and one SMS with the link and nothing else.
  const told = mail.filter((m) => m.to === f.customer.email);
  assert.equal(told.length, 1);
  assert.match(told[0].subject, /دموی تازه/);
  const texts = sms.filter((s) => s.to === f.customer.phone);
  assert.equal(texts.length, 1);
  assert.match(texts[0].text!, /\/fa\/app\/contracts\//);
});

test('who may record readiness: the phase’s developer, or sales; never a designer, the customer or another contract’s developer', async () => {
  await reachDemos();
  const demo = await createSiteDemo(phase1.id);
  for (const who of [staff.DESIGNER, f.customer]) {
    assert.equal((await asDev(VERIFY, { d: demo.id, o: ORIGIN }, who)).code, 'FORBIDDEN', who.email ?? '');
  }
  assert.equal((await asDev(VERIFY, { d: demo.id, o: ORIGIN }, staff.DEVELOPER2)).code, 'NOT_ASSIGNED');
  assert.equal((await asDev(VERIFY, { d: demo.id, o: ORIGIN }, f.stranger)).code, 'FORBIDDEN');
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).readyAt, null, 'nothing was recorded');

  // Sales may — and the claim carries sales, not the developer.
  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }, staff.SALES));
  const row = await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } });
  assert.ok(row.readyAt);
  assert.equal(row.readyVerifiedById, staff.SALES.id);
});

test('readiness is recorded with who, the first claim stands, and the staging origin must be the demo’s current one', async () => {
  await reachDemos();
  const demo = await createSiteDemo(phase1.id);
  // A claim about some other origin is not a claim about this demo.
  assert.equal((await asDev(VERIFY, { d: demo.id, o: 'https://evil.example' })).code, 'READINESS_ORIGIN_MISMATCH');
  assert.equal((await asDev(VERIFY, { d: demo.id, o: 'http://nahal.staging.localhost:5180' })).code, 'READINESS_ORIGIN_MISMATCH', 'the port is part of the origin');
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).readyAt, null);

  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }));
  const first = await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } });
  assert.equal(first.readyVerifiedById, staff.DEVELOPER.id);
  // A second report leaves the first claim, and its claimant, standing.
  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }, staff.SALES));
  const second = await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } });
  assert.equal(second.readyVerifiedById, staff.DEVELOPER.id);
  assert.equal(second.readyAt!.getTime(), first.readyAt!.getTime());

  // Staff read who; the customer is not told who verified a deployment — nor whether.
  assert.equal(phaseOut(await read(staff.SALES), phase1.id).demos[0].readyVerifiedBy?.id, staff.DEVELOPER.id);
  await publishDemoNow(demo.id);
  const asCustomer = phaseOut(await read(f.customer), phase1.id).demos[0];
  assert.equal(asCustomer.readyAt, null);
  assert.equal(asCustomer.readyVerifiedBy, null);
});

async function publishDemoNow(demoId: string) {
  ok(await asDev(GEN_FRAME, { d: demoId }));
  ok(await asDev(PUBLISH_DEMO, { d: demoId }));
}

test('a changed staging URL clears readiness (and the demo must be heard from again); the same URL, or another field, does not', async () => {
  await reachDemos();
  const demo = await createSiteDemo(phase1.id);
  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }));
  const ready = () => prisma.demo.findUniqueOrThrow({ where: { id: demo.id } });

  ok(await asDev(UPDATE_DEMO, { d: demo.id, r: 'abc123' }));
  assert.ok((await ready()).readyAt, 'another field leaves the claim');
  ok(await asDev(UPDATE_DEMO, { d: demo.id, u: `${ORIGIN.toUpperCase().replace('HTTP', 'http')}/` }));
  assert.ok((await ready()).readyAt, 'the same host, spelled differently, is the same URL');

  ok(await asDev(UPDATE_DEMO, { d: demo.id, u: 'http://newsite.staging.localhost:5179/' }));
  const cleared = await ready();
  assert.deepEqual([cleared.readyAt, cleared.readyVerifiedById], [null, null]);
  // The old origin is no longer this demo's, so a stale browser cannot re-assert it.
  assert.equal((await asDev(VERIFY, { d: demo.id, o: ORIGIN })).code, 'READINESS_ORIGIN_MISMATCH');
  ok(await asDev(VERIFY, { d: demo.id, o: 'http://newsite.staging.localhost:5179' }));
  assert.ok((await ready()).readyAt);
});

test('a published demo whose URL is changed is no longer ready, and publishing builds is not refused for it (the plan’s gate is on publishDemo)', async () => {
  await reachDemos();
  const demo = await publishedDemo(phase1.id);
  ok(await asDev(UPDATE_DEMO, { d: demo.id, u: 'http://moved.staging.localhost:5179/' }));
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).readyAt, null);
  assert.ok((await prisma.demo.findUniqueOrThrow({ where: { id: demo.id } })).publishedAt, 'it stays published');
  assert.equal(phaseOut(await read(staff.SALES), phase1.id).demos[0].readyAt, null, 'and the desk can see it needs the check again');
});

test('a mockup has no readiness to record: verifyDemoReadiness on a MOCKUP demo is "no such demo"', async () => {
  await reachDemos();
  const mockup = await prisma.demo.create({ data: { kind: 'MOCKUP', projectId: f.contract.projectId, contractId: f.contract.id } });
  assert.equal((await asDev(VERIFY, { d: mockup.id, o: ORIGIN })).code, 'NOT_FOUND');
  assert.equal((await asDev(VERIFY, { d: 'nope', o: ORIGIN })).code, 'NOT_FOUND');
});

test('Demo_ready_has_a_verifier: readiness is time and claimant together, and only a SITE demo has one — proven by direct insert', async () => {
  await reachDemos();
  const base = { projectId: f.contract.projectId };
  await assert.rejects(
    prisma.demo.create({ data: { ...base, phaseId: phase1.id, stagingUrl: 'http://a.staging.localhost/', readyAt: new Date() } }),
    /Demo_ready_has_a_verifier/,
    'a time with no claimant',
  );
  await assert.rejects(
    prisma.demo.create({ data: { ...base, phaseId: phase1.id, stagingUrl: 'http://a.staging.localhost/', readyVerifiedById: staff.DEVELOPER.id } }),
    /Demo_ready_has_a_verifier/,
    'a claimant with no time',
  );
  await assert.rejects(
    prisma.demo.create({ data: { ...base, kind: 'MOCKUP', contractId: f.contract.id, readyAt: new Date(), readyVerifiedById: staff.DEVELOPER.id } }),
    /Demo_ready_has_a_verifier/,
    'a mockup is never "ready"',
  );
  await prisma.demo.create({ data: { ...base, phaseId: phase1.id, stagingUrl: 'http://a.staging.localhost/', readyAt: new Date(), readyVerifiedById: staff.DEVELOPER.id } });
  const demo = await prisma.demo.create({ data: { ...base, phaseId: phase2.id, stagingUrl: 'http://b.staging.localhost/' } });
  await assert.rejects(prisma.demo.update({ where: { id: demo.id }, data: { readyVerifiedById: null, readyAt: new Date() } }), /Demo_ready_has_a_verifier/);
  // A verifier cannot be deleted out from under the claim.
  await prisma.demo.update({ where: { id: demo.id }, data: { readyAt: new Date(), readyVerifiedById: staff.DEVELOPER2.id } });
  await assert.rejects(prisma.user.delete({ where: { id: staff.DEVELOPER2.id } }));
});

// =================================================================================================
// The page map, confirmed per build
// =================================================================================================

test('PAGE_MAP_UNCONFIRMED: a build cannot be published until the developer has confirmed the page map for it — and an edit of the map un-confirms an unpublished build', async () => {
  await reachDemos();
  const demo = await publishedDemo(phase1.id);
  mail.length = 0;
  sms.length = 0;
  const build = ok(await asDev(DECLARE_BUILD, { p: phase1.id, ch: [] })).declareBuild as { id: string; pageMapConfirmedAt: string | null };
  assert.equal(build.pageMapConfirmedAt, null);
  assert.equal((await asDev(PUBLISH_BUILD, { b: build.id })).code, 'PAGE_MAP_UNCONFIRMED');
  assert.equal(await prisma.build.count({ where: { publishedAt: { not: null } } }), 0);
  assert.equal(mail.filter((m) => m.to === f.customer.email).length, 0, 'a refused publish tells nobody');

  // Confirmation is the phase’s developer’s: not sales, a designer, the customer or another developer.
  for (const [who, code] of [[staff.SALES, 'FORBIDDEN'], [staff.DESIGNER, 'FORBIDDEN'], [f.customer, 'FORBIDDEN'], [staff.DEVELOPER2, 'NOT_ASSIGNED']] as const) {
    assert.equal((await asDev(CONFIRM_MAP, { b: build.id }, who)).code, code, who.email ?? '');
  }
  ok(await asDev(CONFIRM_MAP, { b: build.id }));
  assert.ok((await prisma.build.findUniqueOrThrow({ where: { id: build.id } })).pageMapConfirmedAt);

  // The map moves after it was confirmed: the confirmation attested to a different map.
  const about = await prisma.demoPage.findFirstOrThrow({ where: { demoId: demo.id, key: 'about' } });
  ok(await asDev(UPDATE_PAGE, { p: about.id, path: '/about-us' }));
  assert.equal((await prisma.build.findUniqueOrThrow({ where: { id: build.id } })).pageMapConfirmedAt, null);
  assert.equal((await asDev(PUBLISH_BUILD, { b: build.id })).code, 'PAGE_MAP_UNCONFIRMED');
  ok(await asDev(DECLARE_PAGE, { d: demo.id, k: 'contact', p: '/contact' }));
  ok(await asDev(CONFIRM_MAP, { b: build.id }));
  ok(await asDev(DELETE_PAGE, { p: (await prisma.demoPage.findFirstOrThrow({ where: { demoId: demo.id, key: 'contact' } })).id }));
  assert.equal((await prisma.build.findUniqueOrThrow({ where: { id: build.id } })).pageMapConfirmedAt, null, 'deleting a page un-confirms too');

  ok(await asDev(CONFIRM_MAP, { b: build.id }));
  ok(await asDev(PUBLISH_BUILD, { b: build.id }));
  // A published build keeps what it was published with: later edits do not reach back.
  ok(await asDev(UPDATE_PAGE, { p: about.id, path: '/about' }));
  const published = await prisma.build.findUniqueOrThrow({ where: { id: build.id } });
  assert.ok(published.publishedAt && published.pageMapConfirmedAt);
  assert.equal((await asDev(CONFIRM_MAP, { b: build.id })).code, 'ALREADY_PUBLISHED');

  // The customer was told: email and SMS.
  assert.equal(mail.filter((m) => m.to === f.customer.email).length, 1);
  assert.equal(sms.filter((s) => s.to === f.customer.phone).length, 1);
});

test('the page map is per phase: a phase with no demo has no map to confirm (NO_DEMO); another phase’s edit does not un-confirm this phase’s build', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  const b2 = ok(await asDev(DECLARE_BUILD, { p: phase2.id, ch: [] })).declareBuild as { id: string };
  assert.equal((await asDev(CONFIRM_MAP, { b: b2.id })).code, 'NO_DEMO');

  const b1 = ok(await asDev(DECLARE_BUILD, { p: phase1.id, ch: [] })).declareBuild as { id: string };
  ok(await asDev(CONFIRM_MAP, { b: b1.id }));
  const demo2 = await createSiteDemo(phase2.id, 'http://second.staging.localhost:5179', false);
  ok(await asDev(DECLARE_PAGE, { d: demo2.id, k: 'cart', p: '/cart' }));
  assert.ok((await prisma.build.findUniqueOrThrow({ where: { id: b1.id } })).pageMapConfirmedAt, 'phase 2’s map is not phase 1’s');
  ok(await asDev(CONFIRM_MAP, { b: b2.id }));
  const mine = phaseOut(await read(staff.DEVELOPER), phase1.id).builds;
  assert.equal(mine.length, 1, 'a phase lists its own builds');
  assert.ok(mine[0].pageMapConfirmedAt);
  assert.equal(phaseOut(await read(f.customer), phase1.id).builds.length, 0, 'the customer sees published builds only');
});

// =================================================================================================
// The allowance, per phase
// =================================================================================================

test('ALLOWANCE_EXHAUSTED per phase: two published builds spend phase 1’s two rounds and not phase 2’s; sales is told; an extension for the phase admits one more', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  await publishedDemo(phase2.id, 'http://second.staging.localhost:5179');
  await iteration(phase1.id);
  await iteration(phase1.id);
  let c = await read(staff.SALES);
  assert.deepEqual([demoStep(c, phase1.id).iterationsUsed, demoStep(c, phase1.id).allowance], [2, 2]);
  assert.deepEqual([demoStep(c, phase2.id).iterationsUsed, demoStep(c, phase2.id).allowance], [0, 2], 'a phase nothing was published for has used none, which is not "not counted"');

  mail.length = 0;
  sms.length = 0;
  const third = await iteration(phase1.id, [], false);
  const refused = await asDev(PUBLISH_BUILD, { b: third.id });
  assert.equal(refused.code, 'ALLOWANCE_EXHAUSTED');
  assert.equal(await prisma.build.count({ where: { phaseId: phase1.id, publishedAt: { not: null } } }), 2);
  assert.equal(mail.filter((m) => m.to === f.customer.email).length, 0, 'the customer is not told of a build that was refused');
  const salesMail = mail.filter((m) => m.to === staff.SALES.email);
  assert.equal(salesMail.length, 1, 'sales is told the rounds are used up');
  assert.ok(sms.some((s) => s.to === staff.SALES.phone));

  // Phase 2 is its own allowance (Q-S6): its first round publishes.
  const other = await iteration(phase2.id);
  assert.ok((await prisma.build.findUniqueOrThrow({ where: { id: other.id } })).publishedAt);

  // The extension is sales’ and for a phase of this contract.
  assert.equal((await exec(EXTEND, { as: staff.DEVELOPER, variables: { c: f.contract.id, p: phase1.id, x: 1 } })).code, 'FORBIDDEN');
  assert.equal((await exec(EXTEND, { as: staff.SALES, variables: { c: f.contract.id, p: null, x: 1 } })).code, 'PHASE_REQUIRED');
  const elsewhere = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: (await prisma.contract.findFirstOrThrow({ where: { ref: 'RC-TEST-002' } })).id, number: 1, titleFa: 'ف', titleEn: 'P' } });
  assert.equal((await exec(EXTEND, { as: staff.SALES, variables: { c: f.contract.id, p: elsewhere.id, x: 1 } })).code, 'NOT_FOUND', 'another contract’s phase');
  ok(await exec(EXTEND, { as: staff.SALES, variables: { c: f.contract.id, p: phase1.id, x: 1 } }));
  c = await read(staff.SALES);
  assert.deepEqual([demoStep(c, phase1.id).iterationsUsed, demoStep(c, phase1.id).allowance], [2, 3]);
  assert.equal(demoStep(c, phase2.id).allowance, 2, 'phase 2 is not extended');
  ok(await asDev(PUBLISH_BUILD, { b: third.id }));
  assert.equal(demoStep(await read(f.customer), phase1.id).iterationsUsed, 3);
  assert.equal((await iterationRefusal(phase1.id)).code, 'ALLOWANCE_EXHAUSTED', 'and the fourth is refused again');
});

async function iterationRefusal(phaseId: string) {
  const build = await iteration(phaseId, [], false);
  return asDev(PUBLISH_BUILD, { b: build.id });
}

test('declaring costs nothing: an abandoned draft does not spend a round, and a legacy contract has no allowance to run out', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  await iteration(phase1.id, [], false);
  await iteration(phase1.id, [], false);
  await iteration(phase1.id, [], false);
  assert.equal(demoStep(await read(staff.SALES), phase1.id).iterationsUsed, 0);
  await iteration(phase1.id);
  assert.equal(demoStep(await read(staff.SALES), phase1.id).iterationsUsed, 1);

  // The legacy road has no brief and therefore no allowance: nothing is refused for rounds.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await prisma.contractBrief.deleteMany({ where: { contractId: f.contract.id } });
  await iteration(phase1.id);
  await iteration(phase1.id);
  await iteration(phase1.id);
  assert.equal(await prisma.build.count({ where: { phaseId: phase1.id, publishedAt: { not: null } } }), 4);
});

// =================================================================================================
// The HOW_TO_TEST line
// =================================================================================================

test('HOW_TO_TEST: a frame line the developer types by hand — staging-only access details — which the customer reads and may comment on', async () => {
  await reachDemos();
  const demo = await publishedDemo(phase1.id);
  ok(await asDev(ADD_LINE, { d: demo.id, k: 'HOW_TO_TEST', en: 'Staging login: demo@staging.test / sandbox card 4242…' }));
  const row = await prisma.demoFrameLine.findFirstOrThrow({ where: { kind: 'HOW_TO_TEST', frame: { demoId: demo.id } } });
  const line = { id: row.id };
  assert.equal(row.kind, 'HOW_TO_TEST');
  assert.equal(row.scopeItemId, null, 'typed by hand: no registry item behind it, so it can never trigger interception');
  const lines = phaseOut(await read(f.customer), phase1.id).demos[0].frame!.lines;
  assert.ok(lines.some((l) => l.kind === 'HOW_TO_TEST'));
  const item = await comment({ demoId: demo.id, frameLineId: line.id }, phase1.id, 'The login does not work for me');
  assert.equal(item.status, 'OPEN');
  // Regenerating the frame from the registry never touches a hand-typed line.
  ok(await asDev(GEN_FRAME, { d: demo.id }));
  assert.ok(await prisma.demoFrameLine.findUnique({ where: { id: line.id } }));
  // Only the developer of the phase types it.
  assert.equal((await asDev(ADD_LINE, { d: demo.id, k: 'HOW_TO_TEST', en: 'x' }, staff.DEVELOPER2)).code, 'NOT_ASSIGNED');
  assert.equal((await asDev(ADD_LINE, { d: demo.id, k: 'HOW_TO_TEST', en: 'x' }, staff.DESIGNER)).code, 'FORBIDDEN');
});

// =================================================================================================
// approveDemo
// =================================================================================================

test('approveDemo: refused until the phase’s demo is published, then while a note is open or an answer waits — then it accepts, locks, and tells the developer and sales', async () => {
  await reachDemos();
  assert.equal((await approve(phase1.id)).code, 'NO_PUBLISHED_DEMO', 'there is no demo at all');
  const demo = await createSiteDemo(phase1.id);
  assert.equal((await approve(phase1.id)).code, 'NO_PUBLISHED_DEMO', 'a draft demo is not something the customer was shown');
  ok(await asDev(GEN_FRAME, { d: demo.id }));
  ok(await asDev(VERIFY, { d: demo.id, o: ORIGIN }));
  ok(await asDev(PUBLISH_DEMO, { d: demo.id }));
  await iteration(phase1.id);
  mail.length = 0;
  sms.length = 0;

  const home = await prisma.demoPage.findFirstOrThrow({ where: { demoId: demo.id, key: 'home' } });
  const item = await comment({ demoId: demo.id, demoPageId: home.id }, phase1.id);
  assert.equal((await approve(phase1.id)).code, 'STEP_HAS_OPEN_FEEDBACK');
  ok(await asDev(ANSWER, { i: item.id }));

  const approved = ok(await approve(phase1.id)).approveDemo as { wizard: Array<{ step: string; phaseId: string | null; locked: boolean }> };
  assert.equal(approved.wizard.find((s) => s.step === 'DEMO' && s.phaseId === phase1.id)!.locked, true);
  assert.equal(approved.wizard.find((s) => s.step === 'DEMO' && s.phaseId === phase2.id)!.locked, false, 'only that phase');
  const row = await prisma.stepApproval.findFirstOrThrow({ where: { contractId: f.contract.id, step: 'DEMO' } });
  assert.deepEqual([row.phaseId, row.approvedById], [phase1.id, f.customer.id]);
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'ACCEPTED');
  assert.equal((await approve(phase1.id)).code, 'STEP_LOCKED', 'a second approval is the lock');

  // Told: the developer and sales — once each, by email and SMS, in the desk's language.
  for (const who of [staff.DEVELOPER, staff.SALES]) {
    const m = mail.filter((x) => x.to === who.email && /Phase 1 accepted|فازِ ۱ پذیرفته شد/.test(x.subject));
    assert.equal(m.length, 1, who.email ?? '');
    assert.match(m[0].subject, /Phase 1 accepted|فازِ ۱ پذیرفته شد/);
    assert.equal(sms.filter((s) => s.to === who.phone).length, 1, `${who.email} sms`);
  }
  assert.equal(mail.filter((x) => x.to === f.customer.email).length, 0, 'the customer is not told of their own act');
});

test('approveDemo accepts only that phase’s agreed items: not another phase’s, not another contract’s, not a proposal or a declined item', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  const statusOf = async (key: string) => (await prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId, key } })).status;
  assert.deepEqual([await statusOf('home'), await statusOf('about'), await statusOf('cart')], ['IN_DEMO', 'IN_BUILD', 'AGREED']);

  ok(await approve(phase1.id));
  assert.equal(await statusOf('home'), 'ACCEPTED');
  assert.equal(await statusOf('about'), 'ACCEPTED', 'an agreed item of the phase, whether or not a build had shipped it');
  assert.equal(await statusOf('cart'), 'AGREED', 'phase 2’s item');
  assert.equal(await statusOf('foreign'), 'IN_DEMO', 'an item of another contract that happens to be filed under this phase');
  assert.equal(await statusOf('proposed'), 'PROPOSED');
  assert.equal(await statusOf('declined'), 'DECLINED');
  assert.equal((await prisma.scopeItem.findFirstOrThrow({ where: { key: 'declined' } })).declinedReason, 'No');
});

test('approveDemo: the contract’s own customer only, a phase of this contract, the new road', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  for (const who of [f.admin, staff.SALES, staff.DEVELOPER, f.stranger]) {
    assert.equal((await approve(phase1.id, who)).code, 'NOT_FOUND', who.email ?? '');
  }
  const elsewhere = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: (await prisma.contract.findFirstOrThrow({ where: { ref: 'RC-TEST-002' } })).id, number: 1, titleFa: 'ف', titleEn: 'P' } });
  assert.equal((await approve(elsewhere.id)).code, 'STEP_NOT_ON_ROAD', 'another contract’s phase');
  assert.equal((await approve('not-a-phase')).code, 'STEP_NOT_ON_ROAD');
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DEMO' } }), 0, 'nothing was written by a refusal');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await approve(phase1.id)).code, 'STEP_NOT_APPROVABLE');
});

test('two presses of Approve at once write one approval; the loser is the lock', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  const codes = (await Promise.all([approve(phase1.id), approve(phase1.id)])).map((r) => r.code ?? 'ok').sort();
  assert.deepEqual(codes, ['STEP_LOCKED', 'ok']);
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DEMO', phaseId: phase1.id } }), 1);
});

// =================================================================================================
// The lock
// =================================================================================================

/** Phase 1 at the lock: published, approved — with a draft build, a hand-typed line and a page to name in the table. */
async function lockedPhase() {
  const demo = await publishedDemo(phase1.id);
  ok(await asDev(ADD_LINE, { d: demo.id, k: 'HOW_TO_TEST', en: 'Staging login' }));
  const line = await prisma.demoFrameLine.findFirstOrThrow({ where: { kind: 'HOW_TO_TEST', frame: { demoId: demo.id } } });
  const page = await prisma.demoPage.findFirstOrThrow({ where: { demoId: demo.id, key: 'home' } });
  const draft = await iteration(phase1.id, [], false);
  const unconfirmed = ok(await asDev(DECLARE_BUILD, { p: phase1.id, ch: [] })).declareBuild as { id: string };
  await iteration(phase1.id);
  ok(await approve(phase1.id));
  mail.length = 0;
  sms.length = 0;
  return { demo, lineId: line.id, pageId: page.id, draft, unconfirmed };
}
type LockIds = Awaited<ReturnType<typeof lockedPhase>>;

const lockTable: Array<{ mutation: string; run: (ids: LockIds) => ReturnType<typeof exec> }> = [
  { mutation: 'createDemo', run: () => asDev(CREATE_DEMO, { p: phase1.id, u: 'http://again.staging.localhost:5179/' }) },
  { mutation: 'updateDemo', run: (ids) => asDev(UPDATE_DEMO, { d: ids.demo.id, r: 'late' }) },
  { mutation: 'deleteDemo', run: (ids) => asDev(DELETE_DEMO, { d: ids.demo.id }) },
  { mutation: 'declareDemoPage', run: (ids) => asDev(DECLARE_PAGE, { d: ids.demo.id, k: 'late', p: '/late' }) },
  { mutation: 'updateDemoPage', run: (ids) => asDev(UPDATE_PAGE, { p: ids.pageId, path: '/elsewhere' }) },
  { mutation: 'deleteDemoPage', run: (ids) => asDev(DELETE_PAGE, { p: ids.pageId }) },
  { mutation: 'generateDemoFrame', run: (ids) => asDev(GEN_FRAME, { d: ids.demo.id }) },
  { mutation: 'updateDemoFrameSummary', run: (ids) => asDev(FRAME_SUMMARY, { d: ids.demo.id }) },
  { mutation: 'addDemoFrameLine', run: (ids) => asDev(ADD_LINE, { d: ids.demo.id, k: 'HOW_TO_TEST', en: 'late' }) },
  { mutation: 'updateDemoFrameLine', run: (ids) => asDev(UPDATE_LINE, { l: ids.lineId }) },
  { mutation: 'deleteDemoFrameLine', run: (ids) => asDev(DELETE_LINE, { l: ids.lineId }) },
  { mutation: 'publishDemo', run: (ids) => asDev(PUBLISH_DEMO, { d: ids.demo.id }) },
  { mutation: 'verifyDemoReadiness', run: (ids) => asDev(VERIFY, { d: ids.demo.id, o: ORIGIN }) },
  { mutation: 'declareBuild', run: () => asDev(DECLARE_BUILD, { p: phase1.id, ch: [] }) },
  { mutation: 'confirmPageMap', run: (ids) => asDev(CONFIRM_MAP, { b: ids.unconfirmed.id }) },
  { mutation: 'publishBuild', run: (ids) => asDev(PUBLISH_BUILD, { b: ids.draft.id }) },
  { mutation: 'approveDemo', run: () => approve(phase1.id) },
  {
    mutation: 'submitFeedback',
    run: (ids) => exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, p: phase1.id, t: { demoId: ids.demo.id, demoPageId: ids.pageId }, b: 'one more thing' } }),
  },
  {
    mutation: 'answerFeedback',
    run: async () => {
      const item = await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DEMO', phaseId: phase1.id, general: true, status: 'OPEN' } });
      return exec(ANSWER, { as: staff.DEVELOPER, variables: { i: item.id } });
    },
  },
  { mutation: 'deletePhase', run: () => exec('mutation($p: ID!){ deletePhase(phaseId: $p) { id } }', { as: staff.SALES, variables: { p: phase1.id } }) },
];

test('after the customer approves a phase, every developer write to it is STEP_LOCKED — and a refusal writes nothing and tells nobody', async () => {
  await reachDemos();
  const ids = await lockedPhase();
  const snapshot = async () => ({
    demos: await prisma.demo.findMany({ orderBy: { id: 'asc' } }),
    pages: await prisma.demoPage.findMany({ orderBy: { id: 'asc' } }),
    lines: await prisma.demoFrameLine.findMany({ orderBy: { id: 'asc' } }),
    frames: await prisma.demoFrame.findMany({ orderBy: { id: 'asc' } }),
    builds: await prisma.build.findMany({ orderBy: { id: 'asc' } }),
    feedback: await prisma.feedbackItem.count(),
    comments: await prisma.feedbackComment.count(),
    approvals: await prisma.stepApproval.count(),
    phases: await prisma.phase.count(),
  });
  // The answerFeedback row adds an item; seed it once so the snapshot is taken after.
  const seeded = await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DEMO', phaseId: phase1.id, general: true, status: 'OPEN' } });
  const before = await snapshot();
  for (const row of lockTable.filter((r) => r.mutation !== 'answerFeedback')) {
    const result = await row.run(ids);
    assert.equal(result.code, 'STEP_LOCKED', `${row.mutation}: ${JSON.stringify(result.errors)}`);
  }
  assert.equal((await exec(ANSWER, { as: staff.DEVELOPER, variables: { i: seeded.id } })).code, 'STEP_LOCKED', 'answerFeedback');
  assert.deepEqual(await snapshot(), before, 'nothing moved');
  assert.equal(mail.length + sms.length, 0, 'and nobody was told of a refused act');
});

test('the lock is per phase: phase 2 is untouched by phase 1’s approval, and nothing was locked before it', async () => {
  await reachDemos();
  // Before: no write is locked.
  const demo = await publishedDemo(phase1.id);
  ok(await asDev(UPDATE_DEMO, { d: demo.id, r: 'before' }));
  assert.equal(await prisma.stepApproval.count({ where: { step: 'DEMO' } }), 0);
  ok(await approve(phase1.id));

  const demo2 = await publishedDemo(phase2.id, 'http://second.staging.localhost:5179');
  ok(await asDev(UPDATE_DEMO, { d: demo2.id, r: 'after' }));
  await iteration(phase2.id);
  const customer = await read(f.customer);
  assert.deepEqual([demoStep(customer, phase1.id).locked, demoStep(customer, phase2.id).locked], [true, false]);
  ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, p: phase2.id, t: { general: true }, b: 'still open' } }));
});

test('the lock table is complete: the call sites of openDemo match the rows above — add a demo write and this fails until it has a row', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const files = [...readdirSync(dir), ...readdirSync(`${dir}admin/`).map((n) => `admin/${n}`)].filter((n) => n.endsWith('.ts'));
  const sites: Record<string, number> = {};
  const early: Record<string, number> = {};
  for (const name of files) {
    const source = readFileSync(`${dir}${name}`, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const count = (source.match(/\bopenDemo\(tx, /g) ?? []).length;
    if (count > 0) sites[name] = count;
    const asks = (source.match(/assertStepOpenOn\([^)]*'DEMO'/g) ?? []).length;
    if (asks > 0) early[name] = asks;
  }
  assert.deepEqual(sites, {
    // createDemo, updateDemo, deleteDemo, declareDemoPage, updateDemoPage, deleteDemoPage
    'admin/phases.ts': 6,
    // generateDemoFrame, updateDemoFrameSummary, addDemoFrameLine, updateDemoFrameLine, deleteDemoFrameLine, publishDemo
    'admin/demoFrame.ts': 6,
    // declareBuild's guard
    'builds.ts': 1,
    // verifyDemoReadiness, confirmPageMap, publishSiteBuild (publishBuild's site branch)
    'demoStep.ts': 3,
  });
  // …and the places that ask the wizard about DEMO directly: openDemo itself, the early checks that make a
  // locked phase STEP_LOCKED whatever else is wrong (declareBuild, publishDemo), and deletePhase's guard.
  assert.deepEqual(early, { 'demoStep.ts': 1, 'builds.ts': 1, 'admin/demoFrame.ts': 1, 'admin/phases.ts': 1 });
  assert.equal(lockTable.length, 20);
});

test('every demo mutation in the SDL has a row in the lock table — the table cannot fall behind the schema', () => {
  const sdl = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  const demoMutations = [
    'createDemo', 'updateDemo', 'deleteDemo', 'declareDemoPage', 'updateDemoPage', 'deleteDemoPage', 'generateDemoFrame',
    'updateDemoFrameSummary', 'addDemoFrameLine', 'updateDemoFrameLine', 'deleteDemoFrameLine', 'publishDemo',
    'verifyDemoReadiness', 'confirmPageMap', 'declareBuild', 'publishBuild', 'approveDemo',
  ];
  const rows = lockTable.map((r) => r.mutation);
  for (const name of demoMutations) {
    assert.ok(new RegExp(`\\b${name}\\(`).test(sdl), `${name} is in the schema`);
    assert.ok(rows.includes(name), `${name} has a row`);
  }
  // Every Mutation field of the demo's own resolver files is one of them.
  const resolvers = readFileSync(fileURLToPath(new URL('../graphql/resolvers/demoStep.ts', import.meta.url)), 'utf8');
  for (const [, name] of resolvers.matchAll(/^  (\w+): async \(_p: unknown, args/gm)) {
    assert.ok(rows.includes(name), `demoStep.ts's ${name} has a row`);
  }
});

// =================================================================================================
// J13's flip, through the real mutation
// =================================================================================================

test('a phase-tied planned invoice is PHASE_NOT_ACCEPTED until the customer approves that phase — and issuable the moment approveDemo writes its row', async () => {
  await reachDemos();
  const issue = (rowId: string) => exec(ISSUE_PLANNED, { as: staff.SALES, variables: { p: rowId } });
  const states = async () =>
    (ok(await exec(READ_PLAN, { as: staff.SALES, variables: { c: f.contract.id } })).contract as {
      paymentPlan: { invoices: Array<{ state: string; blockedBy: string | null }> };
    }).paymentPlan.invoices.map((r) => (r.blockedBy ? `${r.state}/${r.blockedBy}` : r.state));
  const [first, second] = plannedRows;
  assert.equal(first.phaseId, phase1.id);

  assert.deepEqual(await states(), ['NOT_YET_ISSUABLE/PHASE_NOT_ACCEPTED', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  assert.equal((await issue(first.id)).code, 'PHASE_NOT_ACCEPTED');
  // A published demo is not an accepted one; neither is a different phase's approval.
  await publishedDemo(phase1.id);
  await publishedDemo(phase2.id, 'http://second.staging.localhost:5179');
  assert.equal((await issue(first.id)).code, 'PHASE_NOT_ACCEPTED', 'published, not approved');
  ok(await approve(phase2.id));
  assert.equal((await issue(first.id)).code, 'PHASE_NOT_ACCEPTED', 'another phase’s approval');

  ok(await approve(phase1.id));
  assert.deepEqual(await states(), ['ISSUABLE', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  ok(await issue(first.id));
  const entry = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: first.id } });
  assert.equal(entry.phaseId, phase1.id);
  assert.ok(entry.invoiceNumber && entry.issuedAt);
  void second;
});

// =================================================================================================
// The build timeline (Q22)
// =================================================================================================

test('Contract.buildTimeline: phases in order with their published builds and dates — drafts are not facts the customer can read', async () => {
  await reachDemos();
  await publishedDemo(phase1.id);
  const b1 = await iteration(phase1.id);
  const draft = await iteration(phase1.id, [], false);
  const customer = (await read(f.customer)).buildTimeline;
  assert.deepEqual(customer.map((p) => p.number), [1, 2]);
  assert.deepEqual(customer[0].builds.map((b) => b.id), [b1.id], 'only the published build');
  assert.ok(customer[0].demoPublishedAt);
  assert.equal(customer[0].acceptedAt, null);
  assert.equal(customer[0].plannedEndAt?.slice(0, 10), '2026-11-10');
  assert.deepEqual(customer[1], { phaseId: phase2.id, number: 2, plannedEndAt: customer[1].plannedEndAt, demoPublishedAt: null, acceptedAt: null, builds: [] });
  assert.ok(!customer[0].builds.some((b) => b.id === draft.id));

  ok(await asDev(PUBLISH_BUILD, { b: draft.id }));
  ok(await approve(phase1.id));
  const staffView = (await read(staff.SALES)).buildTimeline;
  assert.deepEqual(staffView[0].builds.map((b) => b.number), [1, 2]);
  assert.ok(staffView[0].acceptedAt);
  // Latin figures for numbers is the web's; the API carries plain integers.
  assert.deepEqual(staffView.map((p) => p.number), [1, 2]);
});

// =================================================================================================
// J11's close, through the real approval
// =================================================================================================

test('closeContract through approveDemo: PHASES_NOT_ACCEPTED until the customer has approved every phase — then sales closes, and the summary counts each phase’s demo rounds', async () => {
  await reachDemos();
  const CLOSE = 'mutation($c: ID!){ closeContract(contractId: $c) { id status deliveredAt } }';
  const close = () => exec(CLOSE, { as: staff.SALES, variables: { c: f.contract.id } });
  await publishedDemo(phase1.id);
  await publishedDemo(phase2.id, 'http://second.staging.localhost:5179');
  await iteration(phase1.id);
  await iteration(phase1.id);
  await iteration(phase2.id);

  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED');
  ok(await approve(phase1.id));
  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED', 'one phase of two');
  ok(await approve(phase2.id));
  const closed = ok(await close()).closeContract as { status: string; deliveredAt: string };
  assert.equal(closed.status, 'DONE');
  assert.ok(closed.deliveredAt);

  // J11's summary followed: a phase's demo rounds are counted now (they read "not counted" until J10).
  const summary = (ok(await exec(
    'query($c: ID!){ contract(id: $c) { summary { steps { step phaseNumber iterationsUsed allowance extensions finishedAt } dates { phases { number acceptedAt } } } } }',
    { as: f.customer, variables: { c: f.contract.id } },
  )).contract as { summary: { steps: Array<{ step: string; phaseNumber: number | null; iterationsUsed: number | null; allowance: number | null; extensions: number; finishedAt: string | null }>; dates: { phases: Array<{ number: number; acceptedAt: string | null }> } } }).summary;
  const demoRows = summary.steps.filter((s) => s.step === 'DEMO');
  assert.deepEqual(demoRows.map((s) => [s.phaseNumber, s.iterationsUsed, s.allowance, s.extensions]), [[1, 2, 2, 0], [2, 1, 2, 0]]);
  assert.ok(demoRows.every((s) => s.finishedAt), 'each phase’s finish is its approval date');
  assert.ok(summary.dates.phases.every((p) => p.acceptedAt));
});

test('the generic approveStep mutation is gone — a phase is approved through approveDemo and nothing else writes its StepApproval', () => {
  const sdl = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  assert.equal(/\bapproveStep\b\s*\(/.test(sdl), false);
  assert.ok(/\bapproveDemo\(contractId: ID!, phaseId: ID!\): Contract!/.test(sdl));
});
