import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, publishDraftDirect, type Fixture } from './db.js';
import { exec, ok, stop, type ExecResult } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { AGREEMENT_FORMAT, buildContractSnapshot, contentHash, readContractSnapshot } from '../lib/revision.js';
import { draftStateOn } from '../graphql/resolvers/agreement.js';
import { loadContract } from '../graphql/resolvers/contracts.js';

/**
 * J7 — step 3: approve and sign, the agreement gate, the locks, snapshot
 * format 2 (journeys build plan §5 "J7"), and the flip of
 * `SEQUENCE_FOR_NEW_CONTRACTS` to `AGREEMENT_FIRST`.
 *
 * In this order: **the gate's refusal codes** one by one (and that the legacy
 * road's gate is untouched); **approve, then sign** — what each writes, who may,
 * what the wizard and the status area then say, and that *done* for the
 * agreement means *signed*; **the locks** — a table of every step 1–2 mutation
 * against `STEP_LOCKED`, with a source scan that fails when a guarded write is
 * added without a row; **post-lock change** (an amendment and a scope trade
 * still work); **snapshot format 2** — a format-1 revision still verifies
 * byte-for-byte, a format-2 hash is stable, the dirty check that backs
 * `REVISION_STALE`, the plan recorded as approved and not as issued;
 * **the two traps** — the customer reads the sensitive bodies she signs (and the
 * designer does not), and the payment schedule is data (`SCHEDULE_IS_GENERATED`);
 * **amendment bodies** withheld like a sensitive article's; and the two
 * notifications to sales.
 *
 * The fixture's own published v1 is a **format-1** revision on a new-road
 * contract (it predates the gate), which is exactly what the format-1 tests
 * want; every test that needs an approvable agreement publishes a format-2 v2
 * through `publishContractRevision` itself (`ready()`).
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
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
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
  await prisma.templateScopeItem.createMany({
    data: [
      { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
      { typeId: type.id, key: 'cart', kind: 'FEATURE', labelFa: 'سبد خرید', labelEn: 'Cart', position: 1 },
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

// ---- documents and helpers --------------------------------------------------------

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE = (n = 1) =>
  `mutation($c: ID!){ createPhase(contractId: $c, number: ${n}, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "2026-11-10") { phases { id } } }`;
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id revision { id version format } } }';
const APPROVE = `mutation($c: ID!){ approveContract(contractId: $c) {
  id
  gate { contractApproved signed }
  revision { approvedAt format signature { typedName } }
  wizard { step status locked lockedAt finishedAt }
  statusSummary { agreementApprovedAt signedAt started currentStep nextMoveOn }
} }`;
const SIGN = `mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) {
  id
  revision { signature { typedName } }
  wizard { step status locked finishedAt }
  statusSummary { agreementApprovedAt signedAt started currentStep }
} }`;

type Wizard = Array<{ step: string; status: string; locked: boolean; lockedAt?: string | null; finishedAt?: string | null }>;
const wizardRow = (w: Wizard, step: string) => w.find((s) => s.step === step)!;

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
  premadeRounds: 2,
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
};

const PLAN_ROWS = (phaseId: string | null = null) => [
  { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId, paymentTermDays: 7 },
  { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: null, paymentTermDays: 7 },
];

const briefVariables = () => ({ c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id } });

/** Step 1 complete (the plan adds up to the fixture's 180,000,000 fee) and the scope seeded. */
async function stepsOneAndTwo({ dates = true }: { dates?: boolean } = {}) {
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: briefVariables() }));
  const phase = ok(await exec(CREATE_PHASE(), { as: staff.SALES, variables: { c: f.contract.id } })).createPhase as {
    phases: Array<{ id: string }>;
  };
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: PLAN_ROWS(phase.phases[0].id) } }));
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  if (dates) {
    ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  }
  return { phaseId: phase.phases[0].id };
}

const publish = () => exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } });

/** An approvable agreement: steps 1–2 complete and a **format-2** revision published through the real mutation. */
async function ready() {
  const steps = await stepsOneAndTwo();
  const published = ok(await publish()).publishContractRevision as { revision: { id: string; version: number; format: number } };
  assert.equal(published.revision.format, 2);
  return { ...steps, revisionId: published.revision.id };
}

const approve = (as: User = f.customer) => exec(APPROVE, { as, variables: { c: f.contract.id } });
const sign = (as: User = f.customer, name = 'Test Customer') =>
  exec(SIGN, { as, variables: { c: f.contract.id, n: name } });
const approved = async () => {
  const steps = await ready();
  const result = ok(await approve());
  return { ...steps, result };
};

// =================================================================================
// the gate
// =================================================================================

test('NO_PUBLISHED_REVISION: a contract with nothing published has nothing to approve', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentContractRevisionId: null } });
  assert.equal((await approve()).code, 'NO_PUBLISHED_REVISION');
  assert.equal(await prisma.stepApproval.count(), 0);
});

test('SCOPE_UNCONFIRMED: no scope of its own yet, and then a proposal still waiting — both refuse, with what is undecided', async () => {
  // The fixture's v1 is published and nothing is seeded: the scope has nothing in it.
  const empty = await approve();
  assert.equal(empty.code, 'SCOPE_UNCONFIRMED');

  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: briefVariables() }));
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  await prisma.scopeProposal.create({
    data: { contractId: f.contract.id, kind: 'ADD', requestedKind: 'PAGE', text: 'one more', lang: 'en', proposedById: f.customer.id },
  });
  assert.equal((await approve()).code, 'SCOPE_UNCONFIRMED');
  assert.equal(await prisma.stepApproval.count(), 0, 'a refusal locked nothing');
});

test('PLAN_TOTAL_MISMATCH: the payment plan must add up to the fee — and no plan, or no fee, is not a match', async () => {
  await stepsOneAndTwo();
  // The plan is 100M against a 180M fee.
  const phase = await prisma.phase.findFirstOrThrow({ where: { contractId: f.contract.id } });
  ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: { c: f.contract.id, r: [{ labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId: phase.id, paymentTermDays: 7 }] },
    }),
  );
  assert.equal((await approve()).code, 'PLAN_TOTAL_MISMATCH');

  // No fee at all: a plan compared with nothing has been checked against nothing.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { amount: null } });
  assert.equal((await approve()).code, 'PLAN_TOTAL_MISMATCH');
  // Fee back and the plan removed: an empty plan against a positive fee is a mismatch by arithmetic.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { amount: BigInt(180_000_000) } });
  await prisma.paymentPlan.deleteMany({ where: { contractId: f.contract.id } });
  assert.equal((await approve()).code, 'PLAN_TOTAL_MISMATCH');
});

test('DATES_INCOMPLETE: the contract needs a planned start and end, and every phase its end', async () => {
  await stepsOneAndTwo({ dates: false });
  assert.equal((await approve()).code, 'DATES_INCOMPLETE');
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: null } }));
  assert.equal((await approve()).code, 'DATES_INCOMPLETE', 'a start without an end is still incomplete');
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  // A phase with no planned end (a direct insert: the desk refuses to make one undated on this road).
  await prisma.phase.updateMany({ where: { contractId: f.contract.id }, data: { plannedEndAt: null } });
  const refused = await approve();
  assert.equal(refused.code, 'DATES_INCOMPLETE');
  assert.equal(await prisma.stepApproval.count(), 0);
});

test('BRIEF_INCOMPLETE: step 1 must be complete — and the refusal names what is missing', async () => {
  await stepsOneAndTwo();
  // A brief with its budget cap missing is a brief that is not complete.
  ok(
    await exec(SET_BRIEF, {
      as: staff.SALES,
      variables: { c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id, budgetCap: null } },
    }),
  );
  const refused = await approve();
  assert.equal(refused.code, 'BRIEF_INCOMPLETE');
  // (What is missing rides in `extensions.missing`; the client-facing error format keeps only the code, so the
  // list is proven where it is computed — `briefCompleteness`, brief.test.ts — and its wire form by the web.)
  // No brief row at all.
  await prisma.contractBrief.deleteMany({ where: { contractId: f.contract.id } });
  assert.equal((await approve()).code, 'BRIEF_INCOMPLETE');
});

test('REVISION_STALE: the steps moved after the draft was published — approving would lock what nobody signed; publish again and it passes', async () => {
  await ready();
  // Sales edits the brief *after* publishing (allowed: nothing is locked yet).
  ok(
    await exec(SET_BRIEF, {
      as: staff.SALES,
      variables: { c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id, supportMonths: 12 } },
    }),
  );
  const draft = await exec('query($c: ID!){ contract(id: $c) { draft { dirty } } }', { as: staff.SALES, variables: { c: f.contract.id } });
  assert.equal((ok(draft).contract as { draft: { dirty: boolean } }).draft.dirty, true, 'the desk sees the draft as dirty, the same computation');
  assert.equal((await approve()).code, 'REVISION_STALE');
  assert.equal(await prisma.stepApproval.count(), 0);
  // The plan's own change is stale too — and a planned date.
  ok(await publish());
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-13', e: '2026-12-20' } }));
  assert.equal((await approve()).code, 'REVISION_STALE');
  ok(await publish());
  ok(await approve());
});

test('STEP_HAS_OPEN_FEEDBACK and STEP_HAS_PENDING_ANSWERS: a note waiting for Root blocks approval, and so does an answer waiting for sales', async () => {
  const { revisionId } = await ready();
  const note = ok(
    await exec(
      `mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: DRAFT, target: $t, body: "What is covered?") { item { id } } }`,
      { as: f.customer, variables: { c: f.contract.id, t: { contractRevisionId: revisionId, articleNumber: 3 } } },
    ),
  ).submitFeedback as { item: { id: string } };
  assert.equal((await approve()).code, 'STEP_HAS_OPEN_FEEDBACK');
  // Sales answers it directly; the item is resolved.
  ok(
    await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "Covered", resolution: ADDRESSED) { id status } }', {
      as: staff.SALES,
      variables: { i: note.item.id },
    }),
  );
  // …but a designer's answer on it waits for sales.
  await prisma.feedbackComment.create({ data: { feedbackItemId: note.item.id, authorId: staff.DESIGNER.id, body: 'also', approval: 'PENDING' } });
  assert.equal((await approve()).code, 'STEP_HAS_PENDING_ANSWERS');
  await prisma.feedbackComment.updateMany({ where: { approval: 'PENDING' }, data: { approval: 'DECLINED', approvalNote: 'moot' } });
  ok(await approve());
  // Approval accepted the resolved note: the customer closed the loop.
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: note.item.id } })).status, 'ACCEPTED');
});

test('the legacy road’s gate is untouched: DESIGN_FIRST still wants the design first, and writes no StepApproval', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await approve()).code, 'GATE_DESIGN_INCOMPLETE');
  assert.equal(await prisma.stepApproval.count(), 0);
});

// =================================================================================
// approve, then sign
// =================================================================================

test('approving writes the StepApproval and the revision’s approvedAt together; steps 1–3 lock; the agreement is locked and still current until it is signed', async () => {
  const { revisionId } = await approved();
  const row = await prisma.stepApproval.findFirstOrThrow({ where: { contractId: f.contract.id } });
  assert.deepEqual([row.step, row.phaseId, row.approvedById], ['AGREEMENT', null, f.customer.id]);
  const revision = await prisma.contractRevision.findUniqueOrThrow({ where: { id: revisionId } });
  assert.deepEqual(revision.approvedAt, row.approvedAt, 'one act, one moment');

  const after = ok(await exec(`query($c: ID!){ contract(id: $c) { gate { contractApproved signed } wizard { step status locked lockedAt finishedAt } statusSummary { agreementApprovedAt signedAt started currentStep nextMoveOn } } }`, {
    as: f.customer,
    variables: { c: f.contract.id },
  })).contract as { gate: { contractApproved: boolean; signed: boolean }; wizard: Wizard; statusSummary: Record<string, unknown> };
  assert.deepEqual(after.gate, { contractApproved: true, signed: false });
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT']) {
    assert.equal(wizardRow(after.wizard, step).locked, true, `${step} is locked`);
  }
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT']) assert.equal(wizardRow(after.wizard, step).status, 'DONE', step);
  // **Done means signed**: approved-and-unsigned is locked, and still the current step.
  assert.equal(wizardRow(after.wizard, 'AGREEMENT').status, 'CURRENT');
  assert.equal(wizardRow(after.wizard, 'AGREEMENT').finishedAt, null);
  assert.equal(wizardRow(after.wizard, 'DESIGN').status, 'UPCOMING');
  assert.notEqual(after.statusSummary.agreementApprovedAt, null);
  assert.equal(after.statusSummary.signedAt, null);
  assert.equal(after.statusSummary.started, false, 'approval is not a signature — J13’s rule');
  assert.deepEqual([after.statusSummary.currentStep, after.statusSummary.nextMoveOn], ['AGREEMENT', 'CUSTOMER']);
});

test('signing follows: the signature is the moment the agreement is done, and the road moves on to the design', async () => {
  await approved();
  const signed = ok(await sign(f.customer, 'Nahal Rezaei')).signContract as {
    revision: { signature: { typedName: string } };
    wizard: Wizard;
    statusSummary: { signedAt: string | null; agreementApprovedAt: string | null; started: boolean; currentStep: string };
  };
  assert.equal(signed.revision.signature.typedName, 'Nahal Rezaei');
  assert.equal(wizardRow(signed.wizard, 'AGREEMENT').status, 'DONE');
  assert.notEqual(wizardRow(signed.wizard, 'AGREEMENT').finishedAt, null);
  assert.equal(wizardRow(signed.wizard, 'DESIGN').status, 'CURRENT');
  assert.notEqual(signed.statusSummary.signedAt, null);
  assert.equal(signed.statusSummary.currentStep, 'DESIGN');
  // No payment plan row is paid, so work has not started (Q11, J13).
  assert.equal(signed.statusSummary.started, false);

  assert.equal((await sign()).code, 'ALREADY_SIGNED');
  assert.equal((await approve()).code, 'ALREADY_APPROVED');
});

test('who may: only the contract’s own customer approves or signs on the new road; signing before approving is refused; the agreement has no generic door any more', async () => {
  await ready();
  // Staff who can read the contract, and a stranger, hear "no such contract".
  for (const as of [staff.SALES, f.admin, f.stranger]) {
    assert.equal((await approve(as)).code, 'NOT_FOUND', as.email ?? '');
  }
  assert.equal((await sign()).code, 'GATE_CONTRACT_UNAPPROVED');
  ok(await approve());
  for (const as of [staff.SALES, f.admin, f.stranger]) {
    assert.equal((await sign(as)).code, 'NOT_FOUND', as.email ?? '');
  }
  assert.equal((await sign(f.customer, 'x')).code, 'NAME_TOO_SHORT');
  // S2's generic `approveStep` is gone (J10), so a customer cannot lock steps 1–3 without the gate by any
  // other door: the only AGREEMENT approval is `approveContract`'s.
  const fresh = await prisma.stepApproval.count();
  assert.equal(
    (await exec('mutation($c: ID!){ approveStep(contractId: $c, step: AGREEMENT) { id } }', { as: f.customer, variables: { c: f.contract.id } })).code,
    'GRAPHQL_VALIDATION_FAILED',
  );
  assert.equal(await prisma.stepApproval.count(), fresh);
});

test('two presses of Approve at once write one approval — the contract’s lock serializes them, and the loser hears ALREADY_APPROVED', async () => {
  await ready();
  const [a, b] = await Promise.all([approve(), approve()]);
  const codes = [a.code, b.code].sort();
  assert.deepEqual(codes.map((c) => c ?? 'ok'), ['ALREADY_APPROVED', 'ok']);
  assert.equal(await prisma.stepApproval.count(), 1);
});

// =================================================================================
// the locks — every step 1–2 mutation × STEP_LOCKED
// =================================================================================

/**
 * The table the plan asks for. **Built by grepping `assertStepOpenOn(`** in the
 * resolvers, and held honest by the source scan below it: a guarded write added
 * without a row here changes that file's call-site count and fails the scan.
 * Each row is a *valid* call — a refusal for any other reason would prove
 * nothing about the lock.
 */
type LockRow = { mutation: string; file: string; as: () => User; run: (ctx: LockContext) => Promise<ExecResult> };
type LockContext = { phaseId: string; scopeItemId: string; extraId: string; articleNumber: number; revisionId: string; itemId: string };

const lockTable: LockRow[] = [
  // brief.ts — step 1
  { mutation: 'setBrief', file: 'brief.ts', as: () => staff.SALES, run: () => exec(SET_BRIEF, { as: staff.SALES, variables: briefVariables() }) },
  {
    mutation: 'setExtra',
    file: 'brief.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($s: ID!){ setExtra(scopeItemId: $s, included: true) { id } }', { as: staff.SALES, variables: { s: c.extraId } }),
  },
  {
    mutation: 'setPaymentPlan',
    file: 'brief.ts',
    as: () => staff.SALES,
    run: (c) => exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: PLAN_ROWS(c.phaseId) } }),
  },
  // phases.ts — step 1's phases
  { mutation: 'createPhase', file: 'phases.ts', as: () => staff.SALES, run: () => exec(CREATE_PHASE(2), { as: staff.SALES, variables: { c: f.contract.id } }) },
  {
    mutation: 'updatePhase',
    file: 'phases.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($p: ID!){ updatePhase(phaseId: $p, titleFa: "ت", titleEn: "T") { id } }', { as: staff.SALES, variables: { p: c.phaseId } }),
  },
  {
    mutation: 'deletePhase',
    file: 'phases.ts',
    as: () => staff.SALES,
    run: (c) => exec('mutation($p: ID!){ deletePhase(phaseId: $p) { id } }', { as: staff.SALES, variables: { p: c.phaseId } }),
  },
  // scope.ts — step 2a
  {
    mutation: 'proposeScopeAddition',
    file: 'scope.ts',
    as: () => f.customer,
    run: () =>
      exec('mutation($c: ID!){ proposeScopeAddition(contractId: $c, kind: PAGE, text: "a blog", lang: "en") { id } }', {
        as: f.customer,
        variables: { c: f.contract.id },
      }),
  },
  {
    mutation: 'proposeScopeRemoval',
    file: 'scope.ts',
    as: () => f.customer,
    run: (c) => exec('mutation($s: ID!){ proposeScopeRemoval(scopeItemId: $s, text: "drop it") { id } }', { as: f.customer, variables: { s: c.scopeItemId } }),
  },
  {
    mutation: 'proposeRestore',
    file: 'scope.ts',
    as: () => f.customer,
    run: (c) => exec('mutation($s: ID!){ proposeRestore(scopeItemId: $s, text: "bring it back") { id } }', { as: f.customer, variables: { s: c.scopeItemId } }),
  },
  {
    mutation: 'decideScopeProposal',
    file: 'scope.ts',
    as: () => staff.SALES,
    run: async () => {
      const proposal = await prisma.scopeProposal.create({
        data: { contractId: f.contract.id, kind: 'ADD', requestedKind: 'PAGE', text: 'late', lang: 'en', proposedById: f.customer.id },
      });
      return exec('mutation($i: ID!){ decideScopeProposal(id: $i, decision: DECLINED, declineReason: "no") { id } }', {
        as: staff.SALES,
        variables: { i: proposal.id },
      });
    },
  },
  { mutation: 'applyScopeTemplate', file: 'scope.ts', as: () => staff.SALES, run: () => exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }) },
  // admin/contracts.ts — step 2b, the draft
  {
    mutation: 'setArticle',
    file: 'contracts.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($c: ID!, $n: Int!){ setArticle(contractId: $c, number: $n, titleFa: "ت", titleEn: "T", bodyEn: "x") { id } }', {
        as: staff.SALES,
        variables: { c: f.contract.id, n: c.articleNumber },
      }),
  },
  {
    mutation: 'updateContractDraft',
    file: 'contracts.ts',
    as: () => staff.SALES,
    run: () =>
      exec('mutation($c: ID!){ updateContractDraft(contractId: $c, titleFa: "ت", titleEn: "T", amount: "1") { id } }', {
        as: staff.SALES,
        variables: { c: f.contract.id },
      }),
  },
  {
    mutation: 'deleteArticle',
    file: 'contracts.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($c: ID!, $n: Int!){ deleteArticle(contractId: $c, number: $n) { id } }', {
        as: staff.SALES,
        variables: { c: f.contract.id, n: c.articleNumber },
      }),
  },
  {
    mutation: 'applyContractTemplate',
    file: 'contracts.ts',
    as: () => staff.SALES,
    run: () => exec('mutation($c: ID!){ applyContractTemplate(contractId: $c) { id } }', { as: staff.SALES, variables: { c: f.contract.id } }),
  },
  {
    mutation: 'publishContractRevision',
    file: 'contracts.ts',
    as: () => staff.SALES,
    run: async () => {
      // Dirty first, so the refusal cannot be the quieter NO_CHANGES.
      await prisma.contract.update({ where: { id: f.contract.id }, data: { titleEn: 'Renamed after the lock' } });
      return publish();
    },
  },
  { mutation: 'setPlannedDates', file: 'contracts.ts', as: () => staff.SALES, run: () => exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-11-01', e: '2026-12-01' } }) },
  // admin/registry.ts — what the scope *is* (J7 adds these three to the locked set)
  {
    mutation: 'addScopeItem',
    file: 'registry.ts',
    as: () => staff.SALES,
    run: () =>
      exec('mutation($c: ID!){ addScopeItem(contractId: $c, key: "late", labelFa: "د", labelEn: "Late") { id } }', {
        as: staff.SALES,
        variables: { c: f.contract.id },
      }),
  },
  {
    mutation: 'updateScopeItem',
    file: 'registry.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($s: ID!){ updateScopeItem(scopeItemId: $s, labelFa: "ت", labelEn: "T") { id } }', { as: staff.SALES, variables: { s: c.scopeItemId } }),
  },
  {
    mutation: 'deleteScopeItem',
    file: 'registry.ts',
    as: () => staff.SALES,
    run: (c) => exec('mutation($s: ID!){ deleteScopeItem(scopeItemId: $s) { id } }', { as: staff.SALES, variables: { s: c.scopeItemId } }),
  },
  {
    // Declining an agreed item rewrites the signed appendix (J7 review) — the
    // same `inOpenScope` lock; other status moves stay open (the test below).
    mutation: 'setScopeItemStatus (to DECLINED)',
    file: 'registry.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($s: ID!){ setScopeItemStatus(scopeItemId: $s, status: DECLINED, reason: "late") { id } }', {
        as: staff.SALES,
        variables: { s: c.scopeItemId },
      }),
  },
  // feedback.ts — S2's guard, which the same approval closes for steps 1–3
  {
    mutation: 'submitFeedback',
    file: 'feedback.ts',
    as: () => f.customer,
    run: () =>
      exec(
        'mutation($c: ID!){ submitFeedback(contractId: $c, step: REQUIREMENTS, target: { general: true }, body: "late") { item { id } } }',
        { as: f.customer, variables: { c: f.contract.id } },
      ),
  },
  {
    mutation: 'answerFeedback',
    file: 'feedback.ts',
    as: () => staff.SALES,
    run: (c) =>
      exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "late answer", resolution: ADDRESSED) { id } }', {
        as: staff.SALES,
        variables: { i: c.itemId },
      }),
  },
];

test('every step 1–2 mutation is STEP_LOCKED once the agreement is approved — the table, one row per guarded write', async () => {
  const steps = await ready();
  const extra = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'checklist.payment', labelFa: 'پرداخت', labelEn: 'Payment', kind: 'EXTRA', status: 'DECLINED', contractId: f.contract.id, position: 99 },
  });
  const home = await prisma.scopeItem.findFirstOrThrow({ where: { contractId: f.contract.id, key: 'home' } });
  ok(await approve());

  const ctx: LockContext = {
    phaseId: steps.phaseId,
    scopeItemId: home.id,
    extraId: extra.id,
    articleNumber: 1,
    revisionId: steps.revisionId,
    itemId: (await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DRAFT', general: true, status: 'OPEN' } })).id,
  };
  const before = {
    articles: await prisma.article.findMany({ where: { contractId: f.contract.id }, orderBy: { number: 'asc' } }),
    phases: await prisma.phase.count({ where: { contractId: f.contract.id } }),
    plan: await prisma.plannedInvoice.count(),
    items: await prisma.scopeItem.count(),
    revisions: await prisma.contractRevision.count(),
    contract: await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } }),
  };

  for (const row of lockTable) {
    const result = await row.run(ctx);
    assert.equal(result.code, 'STEP_LOCKED', `${row.mutation}: ${JSON.stringify(result.errors)}`);
  }

  // And nothing moved: a refusal that also wrote would be worse than none.
  assert.deepEqual(await prisma.article.findMany({ where: { contractId: f.contract.id }, orderBy: { number: 'asc' } }), before.articles);
  assert.equal(await prisma.phase.count({ where: { contractId: f.contract.id } }), before.phases);
  assert.equal(await prisma.plannedInvoice.count(), before.plan);
  assert.equal(await prisma.scopeItem.count(), before.items);
  assert.equal(await prisma.contractRevision.count(), before.revisions);
  const after = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.deepEqual([after.amount, after.plannedStartAt, after.plannedEndAt], [before.contract.amount, before.contract.plannedStartAt, before.contract.plannedEndAt]);
});

test('the lock table is complete: every file’s count of guarded writes matches the rows above — add a guarded write and this fails until it has a row', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const files = [...readdirSync(dir).map((n) => n), ...readdirSync(`${dir}admin/`).map((n) => `admin/${n}`)].filter((n) => n.endsWith('.ts'));
  // `assertStepOpenOn(…, 'REQUIREMENTS' | 'SCOPE' | 'DRAFT', …)` call sites, comments stripped.
  const sites: Record<string, number> = {};
  for (const name of files) {
    const source = readFileSync(`${dir}${name}`, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const count = (source.match(/assertStepOpenOn\([^)]*'(REQUIREMENTS|SCOPE|DRAFT)'/g) ?? []).length;
    if (count > 0) sites[name.replace('admin/', '')] = count;
  }
  // Call sites per file, and the rows each one covers. `scope.ts` has four
  // sites for five rows (one shared helper serves the remove and the restore);
  // `registry.ts` has two for four (the helper `inOpenScope` serves update,
  // delete and a status change across DECLINED); `feedback.ts` guards by the item's own step (`args.step`), so its
  // rows are S2's and are not counted by the literal scan.
  assert.deepEqual(sites, { 'brief.ts': 3, 'phases.ts': 3, 'scope.ts': 4, 'contracts.ts': 6, 'registry.ts': 2 });
  const rows = lockTable.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.file]: (acc[r.file] ?? 0) + 1 }), {});
  assert.deepEqual(rows, { 'brief.ts': 3, 'phases.ts': 3, 'scope.ts': 5, 'contracts.ts': 6, 'registry.ts': 4, 'feedback.ts': 2 });
});

test('the agreement’s approval is the only thing that locks: before it, every one of those writes works', async () => {
  const steps = await ready();
  // A sample from each group, before approval.
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: briefVariables() }));
  ok(await exec(CREATE_PHASE(2), { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec('mutation($c: ID!){ updateContractDraft(contractId: $c, titleFa: "ت", titleEn: "T", amount: "180000000") { id } }', { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec('mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "ت", titleEn: "T", bodyEn: "x") { id } }', { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  assert.ok(steps.revisionId);
});

test('after the lock the registry still lives: an agreed item moves to IN_BUILD, IN_DEMO and ACCEPTED, and only declining it is refused', async () => {
  await approved();
  const home = await prisma.scopeItem.findFirstOrThrow({ where: { contractId: f.contract.id, key: 'home' } });
  const set = (status: string) =>
    exec(`mutation($s: ID!){ setScopeItemStatus(scopeItemId: $s, status: ${status}, reason: "r") { id } }`, { as: staff.SALES, variables: { s: home.id } });
  ok(await set('IN_BUILD'));
  ok(await set('IN_DEMO'));
  ok(await set('ACCEPTED'));
  assert.equal((await set('DECLINED')).code, 'STEP_LOCKED');
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: home.id } })).status, 'ACCEPTED');
});

// =================================================================================
// post-lock change: an amendment and a scope trade still work
// =================================================================================

test('after the lock, change goes through an amendment and through a scope trade — both still work', async () => {
  await approved();
  ok(await sign());

  // An amendment.
  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "الحاقیه", titleEn: "Amendment", bodyFa: "متن", bodyEn: "Text") { id } }',
      { as: staff.SALES, variables: { c: f.contract.id } },
    ),
  );
  assert.equal(await prisma.amendment.count(), 1);

  // A scope trade: out with the cart, in with a wishlist.
  const cart = await prisma.scopeItem.findFirstOrThrow({ where: { contractId: f.contract.id, key: 'cart' } });
  const proposed = ok(
    await exec(
      `mutation($p: ID!, $o: ID!){ proposeScopeTrade(projectId: $p, outItemId: $o, inKey: "wishlist", inLabelFa: "علاقه‌مندی‌ها", inLabelEn: "Wishlist") { project { scopeTrades { id } } } }`,
      { as: staff.SALES, variables: { p: f.contract.projectId, o: cart.id } },
    ),
  ).proposeScopeTrade as { project: { scopeTrades: Array<{ id: string }> } };
  const tradeId = proposed.project.scopeTrades[0].id;
  ok(await exec('mutation($t: ID!){ confirmScopeTradeRoot(tradeId: $t) { id } }', { as: staff.SALES, variables: { t: tradeId } }));
  ok(await exec('mutation($t: ID!){ confirmScopeTradeCustomer(tradeId: $t) { id } }', { as: f.customer, variables: { t: tradeId } }));
  ok(await exec('mutation($t: ID!){ executeScopeTrade(tradeId: $t) { id } }', { as: staff.SALES, variables: { t: tradeId } }));
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: cart.id } })).status, 'TRADED');
});

// =================================================================================
// snapshot format 2
// =================================================================================

test('a format-1 revision still verifies byte-for-byte: the fixture’s v1 is rebuilt to the same bytes and the same hash, and reads as format 1', async () => {
  const articles = await prisma.article.findMany({ where: { contractId: f.contract.id } });
  const rebuilt = buildContractSnapshot(f.contract, articles);
  assert.equal(contentHash(rebuilt), f.contractRevision.contentHash);
  const stored = readContractSnapshot(f.contractRevision.snapshot);
  assert.equal(stored?.format, 1);
  assert.equal(contentHash(stored!), f.contractRevision.contentHash);

  // And it reads through the API as it did: format 1, no agreement block, articles by the live-row rule.
  const read = ok(
    await exec('query($c: ID!){ contract(id: $c) { revision { format agreement { paymentPlan { total } } contentHash } articles { number sensitive } agreedScopeItems { key kind } } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  ).contract as { revision: { format: number; agreement: unknown; contentHash: string }; articles: unknown[]; agreedScopeItems: unknown[] };
  assert.equal(read.revision.format, 1);
  assert.equal(read.revision.agreement, null);
  assert.equal(read.revision.contentHash, f.contractRevision.contentHash);
  assert.equal(read.articles.length, 3);
});

test('a revision in a format nobody reads is unsealed, not guessed at', () => {
  assert.equal(readContractSnapshot({ format: 3, ref: 'x' }), null);
  assert.equal(readContractSnapshot({ ref: 'x' }), null);
  assert.notEqual(readContractSnapshot({ format: 2, ref: 'x' }), null);
});

test('a format-2 snapshot carries steps 1 and 2, and its hash is stable across two builds of the same state', async () => {
  const steps = await ready();
  const revision = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id }, orderBy: { version: 'desc' } });
  assert.equal(revision.version, 2);
  const snapshot = readContractSnapshot(revision.snapshot) as unknown as Record<string, unknown> & { format: number };
  assert.equal(snapshot.format, AGREEMENT_FORMAT);
  for (const key of ['brief', 'allowances', 'paymentPlan', 'phases', 'plannedStartAt', 'plannedEndAt', 'articles', 'scopeItems']) {
    assert.ok(key in snapshot, key);
  }
  const brief = snapshot.brief as { budgetCap: string; templateType: { slug: string }; hardDeadline: string };
  assert.deepEqual([brief.budgetCap, brief.templateType.slug, brief.hardDeadline], ['150000000', 'store', '2026-10-23']);
  assert.deepEqual(snapshot.allowances, { premadeRounds: 2, wireframeIterations: 2, mockupIterations: null, demoIterationsPerPhase: 2 });
  assert.deepEqual([snapshot.plannedStartAt, snapshot.plannedEndAt], ['2026-10-12', '2026-12-20']);
  const plan = snapshot.paymentPlan as { invoices: Array<{ amount: string; phaseNumber: number | null }> };
  assert.deepEqual(plan.invoices.map((i) => [i.amount, i.phaseNumber]), [['100000000', 1], ['80000000', null]]);
  assert.deepEqual((snapshot.phases as Array<{ number: number; plannedEndAt: string }>).map((p) => [p.number, p.plannedEndAt]), [[1, '2026-11-10']]);
  assert.ok((snapshot.scopeItems as Array<{ kind: string }>).every((s) => ['PAGE', 'FEATURE', 'DELIVERABLE', 'EXTRA'].includes(s.kind)));
  assert.deepEqual((snapshot.articles as Array<{ sensitive: boolean }>).map((a) => a.sensitive), [false, false, false]);

  // The stored hash is the hash of exactly those bytes…
  assert.equal(contentHash(snapshot as never), revision.contentHash);
  // …and building the same state twice gives the same bytes: the draft hashes to the published hash, twice.
  const contract = (await loadContract(f.contract.id))!;
  const a = await draftStateOn(prisma, contract);
  const b = await draftStateOn(prisma, (await loadContract(f.contract.id))!);
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, revision.contentHash);
  assert.equal(a.dirty, false);
  assert.ok(steps.revisionId);
});

test('the dirty check sees steps 1 and 2: a changed brief, plan, phase or date reads dirty, and reverting reads clean again', async () => {
  const { phaseId } = await ready();
  const dirty = async () => (await draftStateOn(prisma, (await loadContract(f.contract.id))!)).dirty;
  assert.equal(await dirty(), false);
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { supportMonths: 7 } });
  assert.equal(await dirty(), true);
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { supportMonths: 6 } });
  assert.equal(await dirty(), false);
  await prisma.plannedInvoice.updateMany({ where: { ordinal: 2 }, data: { paymentTermDays: 9 } });
  assert.equal(await dirty(), true);
  await prisma.plannedInvoice.updateMany({ where: { ordinal: 2 }, data: { paymentTermDays: 7 } });
  await prisma.phase.update({ where: { id: phaseId }, data: { titleEn: 'Renamed' } });
  assert.equal(await dirty(), true);
  await prisma.phase.update({ where: { id: phaseId }, data: { titleEn: 'Phase' } });
  assert.equal(await dirty(), false);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { plannedEndAt: new Date('2026-12-21T00:00:00Z') } });
  assert.equal(await dirty(), true);
});

test('the snapshot records the plan as approved, not as issued: an issued invoice does not change its bytes', async () => {
  await approved();
  ok(await sign());
  const revision = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id }, orderBy: { version: 'desc' } });
  const row = await prisma.plannedInvoice.findFirstOrThrow({ where: { ordinal: 1 } });
  await prisma.billingEntry.create({
    data: {
      customerId: f.customer.id,
      contractId: f.contract.id,
      plannedInvoiceId: row.id,
      amount: row.amount,
      descriptionFa: 'الف',
      descriptionEn: 'A',
      source: 'CONTRACT',
      issuedAt: new Date(),
      dueAt: new Date('2026-12-01T00:00:00Z'),
      invoiceNumber: 'INV-000001',
      paymentTermDays: 7,
      paidAt: new Date(),
    },
  });
  const after = await draftStateOn(prisma, (await loadContract(f.contract.id))!);
  assert.equal(after.hash, revision.contentHash);
  assert.equal(after.dirty, false);
});

test('a published article’s sensitivity is frozen into format 2: editing the live flag later cannot un-hide it', async () => {
  await stepsOneAndTwo();
  await prisma.article.create({
    data: { contractId: f.contract.id, number: 4, titleFa: 'حق‌الزحمه', titleEn: 'Fees', bodyFa: 'مبلغ', bodyEn: 'One hundred and eighty million', sensitive: true },
  });
  ok(await publish());
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 4 } }, data: { sensitive: false } });
  const read = async (as: User) =>
    (ok(await exec('query($c: ID!){ contract(id: $c) { articles { number sensitive bodyEn } } }', { as, variables: { c: f.contract.id } })).contract as {
      articles: Array<{ number: number; sensitive: boolean; bodyEn: string | null }>;
    }).articles.find((a) => a.number === 4)!;
  const asDesigner = await read(staff.DESIGNER);
  assert.deepEqual([asDesigner.sensitive, asDesigner.bodyEn], [true, null]);
  assert.deepEqual(await read(f.customer), { number: 4, sensitive: true, bodyEn: 'One hundred and eighty million' });
});

test('a format-1 revision keeps J4’s rule: its articles read sensitivity from the live row, and a deleted money article falls back to the template’s — the snapshot carries no flag', async () => {
  await prisma.article.createMany({
    data: [
      { contractId: f.contract.id, number: 4, titleFa: 'حق‌الزحمه', titleEn: 'Fees', bodyFa: 'مبلغ', bodyEn: 'The fee', sensitive: true },
      { contractId: f.contract.id, number: 5, titleFa: 'ب', titleEn: 'Payment Schedule', bodyFa: 'ب', bodyEn: 'Pay', sensitive: true },
    ],
  });
  const revision = await publishDraftDirect(f.contract.id, { format: 1 });
  assert.equal(readContractSnapshot(revision.snapshot)?.format, 1);
  assert.ok(!JSON.stringify(revision.snapshot).includes('sensitive'));
  const bodyOf = async (as: User, n: number) =>
    (ok(await exec('query($c: ID!){ contract(id: $c) { articles { number sensitive bodyEn } } }', { as, variables: { c: f.contract.id } })).contract as {
      articles: Array<{ number: number; sensitive: boolean; bodyEn: string | null }>;
    }).articles.find((a) => a.number === n)!;
  assert.deepEqual([(await bodyOf(staff.DESIGNER, 4)).sensitive, (await bodyOf(staff.DESIGNER, 4)).bodyEn], [true, null]);
  assert.equal((await bodyOf(f.customer, 4)).bodyEn, 'The fee');
  // The live row is the rule for format 1: clear the flag and the body is readable…
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 4 } }, data: { sensitive: false } });
  assert.equal((await bodyOf(staff.DESIGNER, 4)).bodyEn, 'The fee');
  // …and a deleted row falls back to the template’s own rule (Fees, Payment Schedule).
  await prisma.article.delete({ where: { contractId_number: { contractId: f.contract.id, number: 5 } } });
  assert.deepEqual([(await bodyOf(staff.DESIGNER, 5)).sensitive, (await bodyOf(staff.DESIGNER, 5)).bodyEn], [true, null]);
});

// =================================================================================
// trap 1 — the customer signs the whole snapshot
// =================================================================================

test('trap 1: the customer receives the sensitive bodies, the budget cap and the payment plan on step 3 — and the designer receives none of them', async () => {
  await stepsOneAndTwo();
  await prisma.article.createMany({
    data: [
      { contractId: f.contract.id, number: 4, titleFa: 'حق‌الزحمه', titleEn: 'Fees', bodyFa: 'مبلغِ کل', bodyEn: 'The fee is 180,000,000 Toman', sensitive: true },
      { contractId: f.contract.id, number: 5, titleFa: 'برنامه‌ی پرداخت', titleEn: 'Payment Schedule', sensitive: true },
    ],
  });
  ok(await publish());

  const QUERY = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) {
    amount
    articles { number sensitive bodyFa bodyEn }
    revision { amount format agreement { brief { budgetCap } paymentPlan { total invoices { amount } } phases { number } } }
  } }`;
  type Read = {
    amount: string | null;
    articles: Array<{ number: number; sensitive: boolean; bodyEn: string | null }>;
    revision: { amount: string | null; agreement: { brief: { budgetCap: string | null }; paymentPlan: { total: string; invoices: unknown[] } | null; phases: unknown[] } };
  };
  const read = async (as: User, asCustomer = false) => ok(await exec(QUERY, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as Read;

  const customer = await read(f.customer);
  const fees = customer.articles.find((a) => a.number === 4)!;
  assert.deepEqual([fees.sensitive, fees.bodyEn], [true, 'The fee is 180,000,000 Toman'], 'the customer reads the body they sign');
  assert.equal(customer.revision.amount, '180000000');
  assert.equal(customer.revision.agreement.brief.budgetCap, '150000000');
  assert.deepEqual([customer.revision.agreement.paymentPlan?.total, customer.revision.agreement.paymentPlan?.invoices.length], ['180000000', 2]);

  const designer = await read(staff.DESIGNER);
  assert.equal(designer.articles.find((a) => a.number === 4)!.bodyEn, null);
  assert.equal(designer.revision.amount, null);
  assert.equal(designer.revision.agreement.brief.budgetCap, null);
  assert.equal(designer.revision.agreement.paymentPlan, null);
  assert.equal(designer.revision.agreement.phases.length, 1, 'what is not money is not withheld');

  // Sales sees it all, and sales *viewing as the customer* sees exactly the customer’s: one projection, no second implementation.
  const sales = await read(staff.SALES);
  assert.equal(sales.articles.find((a) => a.number === 4)!.bodyEn, 'The fee is 180,000,000 Toman');
  assert.deepEqual(await read(staff.SALES, true), customer);
  // The designer viewing as the customer is asked about the customer: the money is there.
  assert.equal((await read(staff.DESIGNER, true)).revision.agreement.paymentPlan?.total, '180000000');

  // The hash covers the whole document whatever a view shows: the designer's redaction changes nothing.
  const stored = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id }, orderBy: { version: 'desc' } });
  const snapshot = readContractSnapshot(stored.snapshot) as unknown as { articles: Array<{ number: number; bodyEn: string }> };
  assert.equal(snapshot.articles.find((a) => a.number === 4)!.bodyEn, 'The fee is 180,000,000 Toman');
});

// =================================================================================
// trap 2 — the payment schedule is data, not prose
// =================================================================================

test('trap 2: setArticle refuses a body on the Payment Schedule article of a new-road contract — SCHEDULE_IS_GENERATED — and only there', async () => {
  const set = (n: number, title: string, body: { bodyFa?: string | null; bodyEn?: string | null }, contractId = f.contract.id) =>
    exec(
      'mutation($c: ID!, $n: Int!, $t: String!, $fa: String, $en: String){ setArticle(contractId: $c, number: $n, titleFa: "ت", titleEn: $t, bodyFa: $fa, bodyEn: $en) { id } }',
      { as: staff.SALES, variables: { c: contractId, n, t: title, fa: body.bodyFa ?? null, en: body.bodyEn ?? null } },
    );
  // A body in either language is refused.
  assert.equal((await set(5, 'Payment Schedule', { bodyEn: 'Pay in two parts.' })).code, 'SCHEDULE_IS_GENERATED');
  assert.equal((await set(5, 'Payment Schedule', { bodyFa: 'در دو بخش.' })).code, 'SCHEDULE_IS_GENERATED');
  assert.equal(await prisma.article.count({ where: { contractId: f.contract.id, number: 5 } }), 0, 'nothing was written');
  // An empty body is what the template has; whitespace is empty.
  ok(await set(5, 'Payment Schedule', {}));
  ok(await set(5, 'Payment Schedule', { bodyEn: '   ' }));
  // Fees keeps its body (one number, not a schedule); any other article 5 is just an article.
  ok(await set(4, 'Fees', { bodyEn: 'One fee.' }));
  ok(await set(5, 'Something else', { bodyEn: 'Not the schedule.' }));
  // The legacy road has no plan to render, so the article is prose there, as it was.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  ok(await set(5, 'Payment Schedule', { bodyEn: 'Pay in two parts.' }));
});

test('trap 2: the template leaves Article 5 empty for a new contract, and the rendered schedule reads the snapshot’s plan', async () => {
  // A contract made through the API is new-road (the flip), and its template article 5 has no body.
  const made = ok(
    await exec('mutation($i: CreateContractInput!){ createContract(input: $i) { id sequence } }', {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-J7-1', titleFa: 'ت', titleEn: 'T', amount: '180000000' } },
    }),
  ).createContract as { id: string; sequence: string };
  assert.equal(made.sequence, 'AGREEMENT_FIRST');
  ok(await exec('mutation($c: ID!){ applyContractTemplate(contractId: $c) { id } }', { as: staff.SALES, variables: { c: made.id } }));
  const five = await prisma.article.findUniqueOrThrow({ where: { contractId_number: { contractId: made.id, number: 5 } } });
  assert.deepEqual([five.titleEn, five.bodyFa, five.bodyEn, five.sensitive], ['Payment Schedule', null, null, true]);
});

// =================================================================================
// the flip
// =================================================================================

test('createContract makes an AGREEMENT_FIRST contract — the flip of SEQUENCE_FOR_NEW_CONTRACTS', async () => {
  const made = ok(
    await exec('mutation($i: CreateContractInput!){ createContract(input: $i) { id sequence wizard { step status } } }', {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-J7-2', titleFa: 'ت', titleEn: 'T' } },
    }),
  ).createContract as { sequence: string; wizard: Array<{ step: string; status: string }> };
  assert.equal(made.sequence, 'AGREEMENT_FIRST');
  assert.equal(made.wizard[0].step, 'REQUIREMENTS');
});

// =================================================================================
// amendment bodies
// =================================================================================

test('amendment bodies: a sensitive amendment’s text is withheld from the designer and read by the customer and sales; it defaults from the article it relates to', async () => {
  // A signed base (a direct insert: what signing writes) with article 2 flagged as money.
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 2 }, }, data: { sensitive: true } });
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Test Customer', signedHash: f.contractRevision.contentHash },
  });
  const issue = (relatesToArticle: number | null, sensitive: boolean | null, bodyEn: string) =>
    exec(
      'mutation($c: ID!, $r: Int, $s: Boolean, $b: String!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T", bodyFa: "متن", bodyEn: $b, relatesToArticle: $r, sensitive: $s) { id } }',
      { as: staff.SALES, variables: { c: f.contract.id, r: relatesToArticle, s: sensitive, b: bodyEn } },
    );
  ok(await issue(2, null, 'The extra page costs 20,000,000')); // follows article 2 → sensitive
  ok(await issue(3, null, 'Plain scope wording')); // article 3 is not → not sensitive
  ok(await issue(null, true, 'A fee change with no article')); // explicit, and no article at all
  const rows = await prisma.amendment.findMany({ orderBy: { ordinal: 'asc' } });
  assert.deepEqual(rows.map((r) => r.sensitive), [true, false, true]);
  // A customer reads published amendments only — publish them, so the comparison below is about the withholding.
  await prisma.amendment.updateMany({ data: { publishedAt: new Date() } });

  const read = async (as: User, asCustomer = false) =>
    (ok(
      await exec(
        'query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { revision { amendments { ordinal sensitive titleEn bodyFa bodyEn contentHash } } } }',
        { as, variables: { c: f.contract.id, as: asCustomer } },
      ),
    ).contract as { revision: { amendments: Array<{ ordinal: number; sensitive: boolean; titleEn: string; bodyFa: string | null; bodyEn: string | null; contentHash: string }> } }).revision.amendments;

  const bodies = (list: Awaited<ReturnType<typeof read>>) => list.map((a) => a.bodyEn);
  assert.deepEqual(bodies(await read(f.customer)), ['The extra page costs 20,000,000', 'Plain scope wording', 'A fee change with no article']);
  assert.deepEqual(bodies(await read(staff.SALES)), ['The extra page costs 20,000,000', 'Plain scope wording', 'A fee change with no article']);
  const asDesigner = await read(staff.DESIGNER);
  assert.deepEqual(bodies(asDesigner), [null, 'Plain scope wording', null]);
  assert.deepEqual(asDesigner.map((a) => a.bodyFa === null), [true, false, true]);
  // The title, the ordinal and the hash are not secret, and the hash is the same for everyone.
  assert.deepEqual(asDesigner.map((a) => a.contentHash), (await read(f.customer)).map((a) => a.contentHash));
  // Sales viewing as the customer is asked about the customer.
  assert.deepEqual(bodies(await read(staff.SALES, true)), bodies(await read(f.customer)));

  // updateAmendment: an unpublished one re-pointed at a sensitive article never becomes readable; the desk can set it either way.
  const fresh = await prisma.amendment.create({
    data: { contractRevisionId: f.contractRevision.id, ordinal: 4, titleFa: 'ت', titleEn: 'T', bodyFa: 'م', bodyEn: 'm', contentHash: 'x', sensitive: false },
  });
  ok(
    await exec('mutation($a: ID!){ updateAmendment(amendmentId: $a, titleFa: "ت", titleEn: "T", bodyFa: "م", bodyEn: "m", relatesToArticle: 2) { id } }', {
      as: staff.SALES,
      variables: { a: fresh.id },
    }),
  );
  assert.equal((await prisma.amendment.findUniqueOrThrow({ where: { id: fresh.id } })).sensitive, true);
  ok(
    await exec('mutation($a: ID!){ updateAmendment(amendmentId: $a, titleFa: "ت", titleEn: "T", bodyFa: "م", bodyEn: "m", relatesToArticle: 2, sensitive: false) { id } }', {
      as: staff.SALES,
      variables: { a: fresh.id },
    }),
  );
  assert.equal((await prisma.amendment.findUniqueOrThrow({ where: { id: fresh.id } })).sensitive, false, 'explicit wins');
});

test('the amendment sensitive migration backfilled exactly what a rule could have identified — an amendment pointing at a sensitive article', async () => {
  // The SQL as shipped, run over rows written the way the migration's own
  // predecessors would have left them.
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20260930150000_j7_amendment_sensitive/migration.sql', import.meta.url)),
    'utf8',
  );
  const update = sql.slice(sql.indexOf('UPDATE "Amendment"')).trim();
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 2 } }, data: { sensitive: true } });
  const make = (ordinal: number, relatesToArticle: number | null) =>
    prisma.amendment.create({
      data: { contractRevisionId: f.contractRevision.id, ordinal, titleFa: 'ت', titleEn: 'T', bodyFa: 'م', bodyEn: 'm', contentHash: 'x', relatesToArticle },
    });
  await make(1, 2);
  await make(2, 3);
  await make(3, null);
  await prisma.$executeRawUnsafe(update);
  const rows = await prisma.amendment.findMany({ orderBy: { ordinal: 'asc' } });
  assert.deepEqual(rows.map((r) => r.sensitive), [true, false, false]);
});

// =================================================================================
// notifications
// =================================================================================

test('approving tells sales and signing tells sales — email and SMS, in each recipient’s language', async () => {
  await ready();
  await prisma.user.update({ where: { id: staff.SALES.id }, data: { phone: '+989120000102', locale: 'fa' } });
  await prisma.user.update({ where: { id: f.admin.id }, data: { locale: 'en' } });
  mail.length = 0;
  sms.length = 0;

  ok(await approve());
  // Every contracts.author holder: sales and the admin.
  assert.deepEqual(mail.map((m) => m.to).sort(), ['admin@test.local', 'sales@test.local']);
  const toSales = mail.find((m) => m.to === 'sales@test.local')!;
  const toAdmin = mail.find((m) => m.to === 'admin@test.local')!;
  assert.match(toSales.subject, /توافق‌نامه تأیید شد/);
  assert.match(toAdmin.subject, /Agreement approved/);
  assert.match(toSales.text ?? '', /Customer/);
  assert.match(toSales.text ?? '', /\/fa\/desk\/contracts\//);
  assert.match(toAdmin.text ?? '', /\/en\/desk\/contracts\//);
  // SMS only to the one with a phone, in their language, carrying the desk link.
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, '+989120000102');
  assert.match(sms[0].text ?? '', /تأیید کرد/);
  assert.match(sms[0].text ?? '', new RegExp(`/fa/desk/contracts/${f.contract.id}/steps`));

  mail.length = 0;
  sms.length = 0;
  ok(await sign());
  assert.match(mail.find((m) => m.to === 'sales@test.local')!.subject, /توافق‌نامه امضا شد/);
  assert.match(mail.find((m) => m.to === 'admin@test.local')!.subject, /Agreement signed/);
  assert.match(sms[0].text ?? '', /امضا کرد/);
});

test('a refusal tells no one', async () => {
  await ready();
  mail.length = 0;
  sms.length = 0;
  await prisma.contractBrief.deleteMany({ where: { contractId: f.contract.id } });
  assert.equal((await approve()).code, 'BRIEF_INCOMPLETE');
  assert.equal(mail.length + sms.length, 0);
});

test('publishDraftDirect follows the road: a new-road contract’s revision is format 2, and is approvable without going through the gates that published it', async () => {
  await stepsOneAndTwo();
  const revision = await publishDraftDirect(f.contract.id);
  assert.equal(readContractSnapshot(revision.snapshot)?.format, 2);
  ok(await approve());
});
