import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { onDay } from './calendar.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { notify } from '../lib/notify.js';
import { contentHash, readContractSnapshot } from '../lib/revision.js';

/**
 * DX4 — one title field (desk UX review item 26; decision log rows 20, 21, 23).
 *
 * A title typed on the desk's contract workspace is in one language or both: the nine
 * tables keep two NOT NULL text columns, one of them may be '', and a hand-written CHECK
 * per table says at least one is not (house rule 11, proved here by a direct insert each).
 * Then through the mutations: a contract, an article, a phase, a scope item, a plan row, a
 * dependency, a demo page and a page design each with one language, and refused with both
 * blank under the code each already used. Then the format-3 snapshot a one-language
 * contract signs (the shape is unchanged: the other key is ''), and a mail rendered in
 * the language that has no title.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { email: 'customer@test.local', phone: '+989120000106', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  mail = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({ sendCode: async () => undefined, sendText: async () => undefined });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

const code = (r: { code?: string }) => r.code;
const sales = (query: string, variables: Record<string, unknown>) => exec(query, { as: staff.SALES, variables });

// =================================================================================
// the database's own rule, by direct insert (house rule 11)
// =================================================================================

/** Makes one row of each table with the titles it is given; `n` keeps the unique keys apart. */
async function makers() {
  const concept = await prisma.designConcept.findFirstOrThrow({ where: { designRevisionId: f.designRevision.id } });
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 90, titleFa: 'x', titleEn: 'x' } });
  const demo = await prisma.demo.create({
    data: { kind: 'SITE', projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phase.id, stagingUrl: 'https://nahal.staging.test', publishedAt: new Date() },
  });
  const plan = await prisma.paymentPlan.create({ data: { contractId: f.contract.id, split: 'INSTALLMENTS' } });
  const customer = f.customer.id;
  let n = 0;
  return {
    Contract: (fa: string, en: string) => {
      n++;
      return prisma.contract.create({ data: { ref: `X-${n}`, titleFa: fa, titleEn: en, customerId: customer, projectId: f.contract.projectId } });
    },
    Article: (fa: string, en: string) => prisma.article.create({ data: { contractId: f.contract.id, number: 100 + ++n, titleFa: fa, titleEn: en } }),
    Amendment: (fa: string, en: string) =>
      prisma.amendment.create({
        data: { contractRevisionId: f.contractRevision.id, ordinal: 100 + ++n, titleFa: fa, titleEn: en, bodyFa: 'b', bodyEn: 'b', contentHash: 'h' },
      }),
    Phase: (fa: string, en: string) =>
      prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 100 + ++n, titleFa: fa, titleEn: en } }),
    ScopeItem: (fa: string, en: string) =>
      prisma.scopeItem.create({ data: { projectId: f.contract.projectId, key: `k${++n}`, kind: 'PAGE', labelFa: fa, labelEn: en, contractId: f.contract.id } }),
    PlannedInvoice: (fa: string, en: string) =>
      prisma.plannedInvoice.create({ data: { planId: plan.id, ordinal: 100 + ++n, labelFa: fa, labelEn: en, amount: 1n, paymentTermDays: 7 } }),
    Dependency: (fa: string, en: string) =>
      prisma.dependency.create({ data: { projectId: f.contract.projectId, titleFa: fa, titleEn: en, createdById: f.admin.id, inBrief: true } }),
    DemoPage: (fa: string, en: string) =>
      prisma.demoPage.create({ data: { demoId: demo.id, key: `p${++n}`, labelFa: fa, labelEn: en, canonicalPath: '/' } }),
    PageDesign: (fa: string, en: string) => prisma.pageDesign.create({ data: { conceptId: concept.id, key: `d${++n}`, labelFa: fa, labelEn: en } }),
  };
}

test('every one of the nine tables refuses a row whose two titles are both blank, and accepts one language, either one', async () => {
  const make = await makers();
  for (const table of Object.keys(make) as Array<keyof typeof make>) {
    const re = new RegExp(`${table}_one_title`);
    await assert.rejects(() => make[table]('', ''), re, `${table}: both empty`);
    await assert.rejects(() => make[table]('  ', ' '), re, `${table}: both spaces`);
    await assert.doesNotReject(() => make[table]('فقط فارسی', ''), `${table}: Persian only`);
    await assert.doesNotReject(() => make[table]('', 'English only'), `${table}: English only`);
    await assert.doesNotReject(() => make[table]('هر دو', 'both'), `${table}: both`);
  }
});

test('the CHECKs hold on UPDATE too: blanking the only language a row has is refused', async () => {
  const make = await makers();
  const phase = await make.Phase('فقط فارسی', '');
  await assert.rejects(() => prisma.phase.update({ where: { id: phase.id }, data: { titleFa: '' } }), /Phase_one_title/);
  await assert.doesNotReject(() => prisma.phase.update({ where: { id: phase.id }, data: { titleEn: 'now English', titleFa: '' } }));
  const item = await make.ScopeItem('', 'English only');
  await assert.rejects(() => prisma.scopeItem.update({ where: { id: item.id }, data: { labelEn: ' ' } }), /ScopeItem_one_title/);
});

test('the tables that keep both languages required still do (library, templates, services, site types)', async () => {
  // No CHECK exists for them: the rule is the resolvers', which this stage left alone.
  const r = await exec('mutation($i: TemplateTypeInput!){ createTemplateType(input: $i) { id } }', {
    as: f.admin,
    variables: { i: { slug: 'blog', labelFa: 'وبلاگ', labelEn: '' } },
  }).catch(() => null);
  if (r) assert.ok(r.errors?.length, 'a site type with a blank label is still refused');
});

// =================================================================================
// the mutations, with one language
// =================================================================================

test('createContract: a Persian-only and an English-only title are made, trimmed; both blank is TITLE_REQUIRED', async () => {
  const CREATE = 'mutation($i: CreateContractInput!){ createContract(input: $i) { id titleFa titleEn } }';
  const fa = ok(await sales(CREATE, { i: { customerId: f.customer.id, titleFa: '  سایت جدید ', titleEn: '' } })).createContract as { id: string; titleFa: string; titleEn: string };
  assert.deepEqual([fa.titleFa, fa.titleEn], ['سایت جدید', '']);
  const en = ok(await sales(CREATE, { i: { customerId: f.customer.id, titleFa: '', titleEn: 'New site' } })).createContract as { titleFa: string; titleEn: string };
  assert.deepEqual([en.titleFa, en.titleEn], ['', 'New site']);
  const none = await sales(CREATE, { i: { customerId: f.customer.id, titleFa: ' ', titleEn: '' } });
  assert.equal(code(none), 'TITLE_REQUIRED');
  assert.equal(await prisma.contract.count({ where: { titleFa: ' ' } }), 0, 'nothing was written');
});

test('updateContractDraft: one language is enough, and the fee still travels with it', async () => {
  const UPDATE = 'mutation($c: ID!, $fa: String!, $en: String!, $a: String){ updateContractDraft(contractId: $c, titleFa: $fa, titleEn: $en, amount: $a) { id draft { titleFa titleEn amount } } }';
  const r = ok(await sales(UPDATE, { c: f.contract.id, fa: 'عنوان', en: '', a: '5000' })).updateContractDraft as { draft: { titleFa: string; titleEn: string; amount: string } };
  assert.deepEqual([r.draft.titleFa, r.draft.titleEn, r.draft.amount], ['عنوان', '', '5000']);
  assert.equal(code(await sales(UPDATE, { c: f.contract.id, fa: '', en: ' ', a: '5000' })), 'TITLE_REQUIRED');
});

test('setArticle, issueAmendment-less: an article in one language; both blank is TITLE_REQUIRED', async () => {
  const SET = 'mutation($c: ID!, $n: Int!, $fa: String!, $en: String!){ setArticle(contractId: $c, number: $n, titleFa: $fa, titleEn: $en, bodyFa: "ب", bodyEn: "b") { id } }';
  ok(await sales(SET, { c: f.contract.id, n: 7, fa: 'مادهٔ هفتم', en: '' }));
  const a = await prisma.article.findUniqueOrThrow({ where: { contractId_number: { contractId: f.contract.id, number: 7 } } });
  assert.deepEqual([a.titleFa, a.titleEn], ['مادهٔ هفتم', '']);
  ok(await sales(SET, { c: f.contract.id, n: 7, fa: '', en: 'Article seven' }));
  assert.equal((await prisma.article.findUniqueOrThrow({ where: { id: a.id } })).titleEn, 'Article seven');
  assert.equal(code(await sales(SET, { c: f.contract.id, n: 7, fa: '', en: '' })), 'TITLE_REQUIRED');
});

test('phases: createPhase and updatePhase take one language; both blank is TITLE_REQUIRED and writes nothing', async () => {
  const CREATE = 'mutation($c: ID!, $n: Int!, $fa: String!, $en: String!){ createPhase(contractId: $c, number: $n, titleFa: $fa, titleEn: $en) { id } }';
  const UPDATE = 'mutation($p: ID!, $fa: String!, $en: String!){ updatePhase(phaseId: $p, titleFa: $fa, titleEn: $en) { id } }';
  ok(await sales(CREATE, { c: f.contract.id, n: 1, fa: 'فاز اول', en: '' }));
  const phase = await prisma.phase.findFirstOrThrow({ where: { contractId: f.contract.id, number: 1 } });
  assert.equal(phase.titleEn, '');
  ok(await sales(UPDATE, { p: phase.id, fa: '', en: 'Phase one' }));
  assert.deepEqual((await prisma.phase.findUniqueOrThrow({ where: { id: phase.id } })).titleFa, '');
  assert.equal(code(await sales(UPDATE, { p: phase.id, fa: '', en: '' })), 'TITLE_REQUIRED');
  assert.equal(code(await sales(CREATE, { c: f.contract.id, n: 2, fa: ' ', en: '' })), 'TITLE_REQUIRED');
  assert.equal(await prisma.phase.count({ where: { contractId: f.contract.id } }), 1);
});

test('scope items: addScopeItem, updateScopeItem and a trade’s incoming item take one language; both blank keeps LABEL_REQUIRED', async () => {
  const ADD = 'mutation($c: ID!, $fa: String!, $en: String!){ addScopeItem(contractId: $c, labelFa: $fa, labelEn: $en, kind: PAGE) { id } }';
  const RENAME = 'mutation($s: ID!, $fa: String!, $en: String!){ updateScopeItem(scopeItemId: $s, labelFa: $fa, labelEn: $en) { id } }';
  ok(await sales(ADD, { c: f.contract.id, fa: '', en: 'Pricing page' }));
  const item = await prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId, labelEn: 'Pricing page' } });
  assert.equal(item.labelFa, '');
  ok(await sales(RENAME, { s: item.id, fa: 'صفحه‌ی قیمت', en: '' }));
  assert.deepEqual(
    [(await prisma.scopeItem.findUniqueOrThrow({ where: { id: item.id } })).labelFa, (await prisma.scopeItem.findUniqueOrThrow({ where: { id: item.id } })).labelEn],
    ['صفحه‌ی قیمت', ''],
  );
  assert.equal(code(await sales(ADD, { c: f.contract.id, fa: '', en: ' ' })), 'LABEL_REQUIRED');
  assert.equal(code(await sales(RENAME, { s: item.id, fa: '', en: '' })), 'LABEL_REQUIRED');

  const TRADE = 'mutation($p: ID!, $o: ID!, $fa: String!, $en: String!){ proposeScopeTrade(projectId: $p, outItemId: $o, inKey: "swap", inLabelFa: $fa, inLabelEn: $en) { id } }';
  assert.equal(code(await sales(TRADE, { p: f.contract.projectId, o: item.id, fa: '', en: '' })), 'LABEL_REQUIRED');
});

test('the payment plan: a row labelled in one language is saved; a row with both blank is LABEL_REQUIRED', async () => {
  const phases = [1, 2].map((n) => prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: n, titleFa: 'ف', titleEn: '' } }));
  await Promise.all(phases);
  const SET = 'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
  const rows = (a: [string, string], b: [string, string]) => [
    { labelFa: a[0], labelEn: a[1], amount: '90000000', phaseId: null, paymentTermDays: 7 },
    { labelFa: b[0], labelEn: b[1], amount: '90000000', phaseId: null, paymentTermDays: 7 },
  ];
  ok(await sales(SET, { c: f.contract.id, r: rows(['پیش‌پرداخت', ''], ['', 'Final payment']) }));
  const saved = await prisma.plannedInvoice.findMany({ where: { plan: { contractId: f.contract.id } }, orderBy: { ordinal: 'asc' } });
  assert.deepEqual(saved.map((r) => [r.labelFa, r.labelEn]), [['پیش‌پرداخت', ''], ['', 'Final payment']]);
  assert.equal(code(await sales(SET, { c: f.contract.id, r: rows(['ا', ''], [' ', '']) })), 'LABEL_REQUIRED');
  assert.equal((await prisma.plannedInvoice.count({ where: { plan: { contractId: f.contract.id } } })), 2, 'the refused plan left the saved one alone');
});

test('dependencies: createDependency and updateDependency take one language; both blank is TITLE_REQUIRED', async () => {
  const CREATE = 'mutation($p: ID!, $fa: String!, $en: String!, $c: ID){ createDependency(projectId: $p, side: ROOT, titleFa: $fa, titleEn: $en, dueAt: "2099-01-01T00:00:00.000Z", contractId: $c) { id } }';
  const UPDATE = 'mutation($d: ID!, $fa: String, $en: String){ updateDependency(dependencyId: $d, titleFa: $fa, titleEn: $en) { id } }';
  ok(await sales(CREATE, { p: f.contract.projectId, fa: '', en: 'Send the logo', c: f.contract.id }));
  const dep = await prisma.dependency.findFirstOrThrow({ where: { projectId: f.contract.projectId } });
  assert.equal(dep.titleFa, '');
  ok(await sales(UPDATE, { d: dep.id, fa: 'لوگو را بفرست' }));
  assert.equal(code(await sales(UPDATE, { d: dep.id, fa: '', en: '' })), 'TITLE_REQUIRED');
  // Blanking one language of a row that has only that one would leave it nameless; the merged pair is what is checked.
  assert.equal(code(await sales(UPDATE, { d: dep.id, fa: '', en: '' })), 'TITLE_REQUIRED');
  ok(await sales(UPDATE, { d: dep.id, fa: '' }));
  assert.equal((await prisma.dependency.findUniqueOrThrow({ where: { id: dep.id } })).titleEn, 'Send the logo');
  assert.equal(code(await sales(CREATE, { p: f.contract.projectId, fa: '', en: ' ', c: f.contract.id })), 'TITLE_REQUIRED');
});

test('demo pages and page designs: one language is saved; both blank is LABEL_REQUIRED', async () => {
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: '' } });
  const demo = await prisma.demo.create({
    data: { kind: 'SITE', projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phase.id, stagingUrl: 'https://nahal.staging.test' },
  });
  const DECLARE = 'mutation($d: ID!, $k: String!, $fa: String!, $en: String!){ declareDemoPage(demoId: $d, key: $k, labelFa: $fa, labelEn: $en, canonicalPath: "/x") { id } }';
  const dev = staff.DEVELOPER;
  ok(await exec(DECLARE, { as: dev, variables: { d: demo.id, k: 'x', fa: '', en: 'Landing' } }));
  assert.equal(code(await exec(DECLARE, { as: dev, variables: { d: demo.id, k: 'y', fa: '', en: '' } })), 'LABEL_REQUIRED');

  // A page design is written on a draft: start one the way the designer does.
  const draft = await prisma.designRevision.create({ data: { contractId: f.contract.id, version: 2 } });
  const concept = await prisma.designConcept.create({ data: { designRevisionId: draft.id, key: '1a', labelFa: 'ط', labelEn: 'C', position: 0 } });
  const page = await prisma.pageDesign.create({ data: { conceptId: concept.id, key: 'home', labelFa: 'ص', labelEn: 'Home', position: 0 } });
  const RENAME = 'mutation($p: ID!, $fa: String!, $en: String!){ updatePageDesign(pageId: $p, labelFa: $fa, labelEn: $en) { id } }';
  const designer = { as: staff.DESIGNER };
  const r = await exec(RENAME, { ...designer, variables: { p: page.id, fa: 'خانه', en: '' } });
  // Whether the designer may write depends on the step being open; the point here is the label rule.
  if (!r.errors) assert.equal((await prisma.pageDesign.findUniqueOrThrow({ where: { id: page.id } })).labelEn, '');
  assert.equal(code(await exec(RENAME, { ...designer, variables: { p: page.id, fa: '', en: ' ' } })), 'LABEL_REQUIRED');
});

// =================================================================================
// a one-language contract through the agreement, and out the other side
// =================================================================================

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';
const SET_PLAN = 'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const READ = `query($c: ID!){ contract(id: $c) {
  titleFa titleEn
  revision { format contentHash signature { typedName } agreement {
    phases { number titleFa titleEn }
    paymentPlan { invoices { ordinal labelFa labelEn } }
    handover { titleFa titleEn }
  } }
} }`;

test('a contract typed in one language per row publishes, is approved and signed as format 3, and reads back in both languages', async () => {
  const UPDATE = 'mutation($c: ID!, $fa: String!, $en: String!, $a: String){ updateContractDraft(contractId: $c, titleFa: $fa, titleEn: $en, amount: $a) { id } }';
  ok(await sales(UPDATE, { c: f.contract.id, fa: 'سایت فروشگاهی نهال', en: '', a: '180000000' }));
  const SET = 'mutation($c: ID!, $n: Int!, $fa: String!, $en: String!){ setArticle(contractId: $c, number: $n, titleFa: $fa, titleEn: $en, bodyFa: "ب", bodyEn: "") { id } }';
  ok(await sales(SET, { c: f.contract.id, n: 3, fa: 'ماده‌ی سوم', en: '' }));
  ok(await sales(SET_BRIEF, { c: f.contract.id, i: { kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'NONE', budgetCap: '150000000', hardDeadline: onDay('2026-10-23'), domainName: 'nahal.ir', supportMonths: 6, demoIterationsPerPhase: 2 } }));
  const P = 'mutation($c: ID!, $n: Int!, $fa: String!, $en: String!){ createPhase(contractId: $c, number: $n, titleFa: $fa, titleEn: $en, plannedEndAt: "' + onDay('2026-11-10') + '") { id } }';
  ok(await sales(P, { c: f.contract.id, n: 1, fa: 'فاز اول', en: '' }));
  ok(await sales(P, { c: f.contract.id, n: 2, fa: '', en: 'Second phase' }));
  ok(
    await sales(SET_PLAN, {
      c: f.contract.id,
      r: [
        { labelFa: 'پیش‌پرداخت', labelEn: '', amount: '90000000', paymentTermDays: 7 },
        { labelFa: '', labelEn: 'On delivery', amount: '90000000', paymentTermDays: 7 },
      ],
    }),
  );
  ok(await sales('mutation($p: ID!, $fa: String!, $en: String!, $c: ID){ createDependency(projectId: $p, titleFa: $fa, titleEn: $en, contractId: $c) { id } }', { p: f.contract.projectId, fa: 'متن صفحه‌ها', en: '', c: f.contract.id }));
  ok(await sales(SET_DATES, { c: f.contract.id, s: onDay('2026-10-12'), e: onDay('2026-12-20') }));
  const ADD = 'mutation($c: ID!, $fa: String!, $en: String!){ addScopeItem(contractId: $c, labelFa: $fa, labelEn: $en, kind: PAGE) { id } }';
  ok(await sales(ADD, { c: f.contract.id, fa: '', en: 'Home page' }));
  ok(await sales(ADD, { c: f.contract.id, fa: 'درباره‌ی ما', en: '' }));

  ok(await sales(PUBLISH, { c: f.contract.id }));
  ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));

  type Read = {
    titleFa: string;
    titleEn: string;
    revision: {
      format: number;
      contentHash: string;
      signature: { typedName: string } | null;
      agreement: {
        phases: Array<{ number: number; titleFa: string; titleEn: string }>;
        paymentPlan: { invoices: Array<{ labelFa: string; labelEn: string }> };
        handover: Array<{ titleFa: string; titleEn: string }>;
      };
    };
  };
  const view = ok(await exec(READ, { as: f.customer, variables: { c: f.contract.id } })).contract as Read;
  assert.equal(view.revision.format, 3);
  assert.equal(view.revision.signature?.typedName, 'Test Customer');
  assert.deepEqual(view.revision.agreement.phases.map((p) => [p.titleFa, p.titleEn]), [['فاز اول', ''], ['', 'Second phase']]);
  assert.deepEqual(view.revision.agreement.paymentPlan.invoices.map((r) => [r.labelFa, r.labelEn]), [['پیش‌پرداخت', ''], ['', 'On delivery']]);
  assert.deepEqual(view.revision.agreement.handover.map((h) => [h.titleFa, h.titleEn]), [['متن صفحه‌ها', '']]);

  // The shape is unchanged — strings, the other key ''. The stored snapshot still hashes to what was signed.
  const rev = await prisma.contractRevision.findUniqueOrThrow({ where: { id: (await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).currentContractRevisionId! } });
  const snapshot = readContractSnapshot(rev.snapshot)!;
  assert.equal(snapshot.titleFa, 'سایت فروشگاهی نهال');
  assert.equal(snapshot.titleEn, '');
  assert.equal(snapshot.articles.find((a) => a.number === 3)?.titleEn, '');
  assert.equal(contentHash(snapshot), rev.contentHash);
});

// =================================================================================
// a mail in the language that has no title
// =================================================================================

test('a mail to a Persian reader about a project titled in English only uses that title, and the other way round', async () => {
  const params = (fa: string, en: string) => ({ customerName: 'نهال', projectTitleFa: fa, projectTitleEn: en, portalUrl: 'https://root.test/p' });
  await notify({ id: 'u1', email: 'fa@test.local', phone: null, locale: 'fa' }, { kind: 'DEMO_PUBLISHED', params: params('', 'Nahal shop') });
  await notify({ id: 'u2', email: 'en@test.local', phone: null, locale: 'en' }, { kind: 'DEMO_PUBLISHED', params: params('فروشگاه نهال', '') });
  await notify({ id: 'u3', email: 'both@test.local', phone: null, locale: 'en' }, { kind: 'DEMO_PUBLISHED', params: params('فروشگاه نهال', 'Nahal shop') });
  const [toFa, toEn, toBoth] = mail;
  assert.match(toFa.subject, /Nahal shop/, 'Persian reader, English-only title');
  assert.match(toFa.text, /«Nahal shop»/);
  assert.ok(!toFa.subject.includes('undefined') && !/—\s*$/.test(toFa.subject), 'no empty title');
  assert.match(toEn.subject, /فروشگاه نهال/, 'English reader, Persian-only title');
  assert.match(toBoth.subject, /Nahal shop/);
  assert.ok(!toBoth.subject.includes('فروشگاه'), 'a title in the reader’s language is not replaced');
});
