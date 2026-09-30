import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../api');

/** Must agree with playwright.config.ts, which reads the same variable. */
export const TEST_DATABASE_URL = `postgresql://root:root@localhost:5432/${
  process.env.ROOT_TEST_DB || 'root_website_test'
}?schema=public`;

/** A minimal valid PNG, for specs that exercise the design-image upload flow. */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The accounts prisma/seed.ts creates. Phones match SEED_*_PHONE's own
 *  defaults there — the four second-factor roles and the customer each get
 *  one (journeys build plan J1, PD-20); CONTRIBUTOR and REVIEWER stay
 *  without one on purpose. */
export const ADMIN = { email: 'admin@root.local', password: 'change-me-please', phone: '+989120000001' };
export const CUSTOMER = { email: 'nahal@example.com', password: 'change-me-please', phone: '+989120000005' };
export const REVIEWER = { email: 'reviewer@root.local', password: 'change-me-please' };
export const REVIEWER2 = { email: 'reviewer2@root.local', password: 'change-me-please' };
export const CONTRIBUTOR = { email: 'contributor@root.local', password: 'change-me-please' };
// Journeys build plan S1 (P0-6): one account per new staff role — sales sees
// the whole book, the designer is assigned to the seeded contract alongside
// DEVELOPER (prisma/seed.ts). J1: each carries its seeded phone, which the
// second factor's code is sent to.
export const SALES = { email: 'sales@root.local', password: 'change-me-please', phone: '+989120000002' };
export const DESIGNER = { email: 'designer@root.local', password: 'change-me-please', phone: '+989120000003' };
export const DEVELOPER = { email: 'developer@root.local', password: 'change-me-please', phone: '+989120000004' };
export const CONTRACT_REF = 'RC-2026-014';
/** What the contracts list actually shows — the ref is not on that screen. */
export const CONTRACT_TITLE = 'Nahal website & portal';

/**
 * Empties the test database and re-seeds it, leaving the schema itself alone.
 *
 * Called from each spec that mutates, because the flow these tests drive ends
 * in a signature and a signature is terminal — a second run against the same
 * rows would be testing "already signed" instead of the gate.
 *
 * Truncates rather than `prisma migrate reset`, deliberately: a full reset
 * drops and recreates every type, including the enums, so the long-lived API
 * server started once for the whole suite (`webServer` in playwright.config)
 * keeps connections open across a schema it no longer matches — Postgres then
 * answers with "cache lookup failed for type NNNNN" the next time one of
 * those connections touches an array-of-enum column (`User.roles`), and the
 * failure lands on whichever spec happens to run next, not on the reset that
 * caused it. `apps/api/src/test/db.ts` already solved this for the
 * integration suite the same way; this mirrors it. `migrate deploy` first
 * keeps the schema current without ever dropping an existing type — it only
 * applies migrations that have not run yet.
 *
 * The URL is passed explicitly rather than inherited, so this cannot be
 * pointed at the development database by an environment that happens to be
 * set — truncating every table is not something to be casual with either.
 */
export function resetTestDatabase() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };

  // execSync (a shell), not execFileSync: on Windows `npx` is npx.cmd, which
  // Node will not spawn without one.
  execSync('npx prisma migrate deploy', {
    cwd: API_DIR,
    env,
    stdio: 'pipe',
    timeout: 60_000,
  });

  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `
      DO $$
      DECLARE tables text;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO tables
        FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%';
        IF tables IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
        END IF;
      END $$;
    `,
    stdio: 'pipe',
    timeout: 60_000,
  });

  execSync('npx tsx prisma/seed.ts', {
    cwd: API_DIR,
    env,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * Renames the contract's *draft* title, leaving the published revision alone.
 *
 * There is no mutation for this — nothing in the GraphQL surface edits a
 * contract's title after `createContract` — so it goes in as SQL. That is also
 * the honest reproduction: the drift this sets up is exactly what a direct
 * database edit, or the `updateContract` the admin screen will eventually want,
 * would produce.
 */
export function renameContractDraft(titleEn: string) {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `UPDATE "Contract" SET "titleEn" = '${titleEn.replace(/'/g, "''")}' WHERE "ref" = '${CONTRACT_REF}';`,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/** The seeded new-road contract (journeys build plan J3): `AGREEMENT_FIRST`, on
 *  the same customer's project as `CONTRACT_REF`, older-stamped so the
 *  customer's list still opens `CONTRACT_REF` first. */
export const WIZARD_CONTRACT_REF = 'RC-2026-021';
export const WIZARD_CONTRACT_TITLE = 'Nahal online shop';

/**
 * Puts a customer commitment three days past its due date on the seeded
 * project, straight into the database — the one input the attention module
 * needs that no screen this stage builds can create for a spec. (Sales can add
 * one through the Dependencies tab; that flow is L5's and has its own spec.)
 */
export function insertOverdueCustomerCommitment() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `
      INSERT INTO "Dependency" ("id", "projectId", "side", "titleFa", "titleEn", "dueAt", "createdById", "createdAt")
      SELECT 'e2e-overdue-commitment', p."id", 'CUSTOMER'::"DependencySide", 'ارسال دارایی‌های برند',
             'Send the brand assets', now() - interval '3 days', u."id", now()
      FROM "Project" p, "User" u
      WHERE p."id" = 'seed-project-nahal' AND u."email" = 'admin@root.local';
    `,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * A published demo on the seeded project, for the feedback spec (journeys build
 * plan S2): one phase, one demo with a frame, and two declared pages — straight
 * into the database, because the desk screens that author a demo are L2/L3's
 * and have their own coverage.
 *
 * The phase names the new-road contract (`WIZARD_CONTRACT_REF`) since J4 —
 * `Phase.contractId` — so the demo, and the demo step's approval, are on the
 * road this spec drives. (Before J4 the project's *first* contract owned every
 * phase, and this helper had to backdate the wizard contract to make it one.)
 */
export const E2E_PHASE_ID = 'e2e-phase';
export function insertPublishedDemo() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `
      INSERT INTO "Phase" ("id", "projectId", "contractId", "number", "titleFa", "titleEn", "updatedAt")
      SELECT '${E2E_PHASE_ID}', 'seed-project-nahal', c."id", 1, 'فاز ۱', 'Phase 1', now()
      FROM "Contract" c WHERE c."ref" = '${WIZARD_CONTRACT_REF}';
      INSERT INTO "Demo" ("id", "phaseId", "stagingUrl", "publishedAt", "updatedAt")
      VALUES ('e2e-demo', '${E2E_PHASE_ID}', 'https://staging.example.com', now(), now());
      INSERT INTO "DemoPage" ("id", "demoId", "key", "labelFa", "labelEn", "canonicalPath")
      VALUES ('e2e-page-home', 'e2e-demo', 'home', 'خانه', 'Home page', '/'),
             ('e2e-page-about', 'e2e-demo', 'about', 'درباره', 'About page', '/about');
      INSERT INTO "DemoFrame" ("id", "demoId", "authoredById", "updatedAt")
      SELECT 'e2e-frame', 'e2e-demo', u."id", now() FROM "User" u WHERE u."email" = 'admin@root.local';
    `,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * A new-road contract sales has *not* handed over yet (journeys build plan J4):
 * `AGREEMENT_FIRST`, unpublished, no brief, on the seeded customer's project.
 * `createContract` still makes legacy contracts (J7 flips that), and the seeded
 * wizard contract is already published — so the hand-over, and the
 * `BRIEF_MISSING` refusal in front of it, need one put in the database.
 */
export const DRAFT_CONTRACT_REF = 'RC-2026-022';
export const DRAFT_CONTRACT_TITLE = 'Nahal mobile app';
export function insertDraftNewRoadContract() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `
      INSERT INTO "Contract" ("id", "ref", "titleFa", "titleEn", "customerId", "projectId", "sequence", "status", "updatedAt")
      SELECT 'e2e-draft-contract', '${DRAFT_CONTRACT_REF}', 'اپلیکیشن موبایل نهال', '${DRAFT_CONTRACT_TITLE}',
             c."customerId", c."projectId", 'AGREEMENT_FIRST'::"ContractSequence", 'DRAFT'::"ContractStatus", now()
      FROM "Contract" c WHERE c."ref" = '${WIZARD_CONTRACT_REF}';
    `,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * A signed new-road contract with a two-row payment plan (journeys build plan
 * J13): the seeded wizard contract (`WIZARD_CONTRACT_REF`), a published
 * revision with the customer's signature, and a plan of a deposit and a
 * delivery payment — neither tied to a phase, so the second is issuable the
 * moment the first is paid.
 *
 * **Signing is a direct insert, and says so.** An `AGREEMENT_FIRST` contract
 * cannot be approved or signed through the API until J7 builds the agreement
 * gate, so this writes the rows signing writes — a revision made current and a
 * `Signature` on it, which is all `agreementSignedAt` (lib/steps.ts) reads. The
 * revision carries no snapshot: nothing in this spec renders the agreement. The plan is inserted too because `setPaymentPlan` is
 * the desk's step-1 form and `17-requirements` already drives that; this spec
 * is about what happens *after* it.
 */
export function insertSignedPaymentPlan() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execSync(`npx prisma db execute --stdin --url "${TEST_DATABASE_URL}"`, {
    cwd: API_DIR,
    input: `
      INSERT INTO "ContractRevision" ("id", "contractId", "version", "publishedAt", "approvedAt")
      SELECT 'e2e-revision', c."id", 1, now(), now()
      FROM "Contract" c WHERE c."ref" = '${WIZARD_CONTRACT_REF}';
      UPDATE "Contract" SET "currentContractRevisionId" = 'e2e-revision' WHERE "ref" = '${WIZARD_CONTRACT_REF}';
      INSERT INTO "Signature" ("id", "contractRevisionId", "signerId", "typedName")
      SELECT 'e2e-signature', 'e2e-revision', c."customerId", 'Nahal'
      FROM "Contract" c WHERE c."ref" = '${WIZARD_CONTRACT_REF}';
      INSERT INTO "PaymentPlan" ("id", "contractId", "split", "updatedAt")
      SELECT 'e2e-plan', c."id", 'INSTALLMENTS'::"PaymentSplit", now()
      FROM "Contract" c WHERE c."ref" = '${WIZARD_CONTRACT_REF}';
      INSERT INTO "PlannedInvoice" ("id", "planId", "ordinal", "labelFa", "labelEn", "amount", "paymentTermDays")
      VALUES ('e2e-pi-1', 'e2e-plan', 1, 'پیش‌پرداخت', 'Deposit', 50000000, 5),
             ('e2e-pi-2', 'e2e-plan', 2, 'تحویل', 'On delivery', 100000000, 10);
    `,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/** The API port `playwright.config.ts`'s webServer runs on — duplicated here
 *  rather than imported, same reasoning as TEST_DATABASE_URL above. */
const E2E_API_URL = `http://localhost:${process.env.E2E_API_PORT || 4101}`;

export type TestBlock = { id: string; kind: 'HEADING' | 'PARAGRAPH' | 'CODE' | 'LIST' | 'QUOTE' | 'TABLE'; depth?: number; text: string };

/**
 * Signs `who` in over the API (no browser), so a spec can do the part of a
 * story that is not what it is about. J1: sign-in takes an identifier, and the
 * four second-factor roles meet the factor — so this is the same two steps the
 * browser helper below takes, with the code read from the e2e outbox. The
 * request context keeps the cookie `verifySignInFactor` sets.
 */
export async function apiSignIn(
  request: APIRequestContext,
  who: { email: string; password: string; phone?: string },
): Promise<void> {
  await resetRateLimits();
  const signIn = await request.post(`${E2E_API_URL}/graphql`, {
    data: {
      query:
        'mutation($i:String!,$p:String!){ signIn(identifier:$i,password:$p){ user { id } factorChallengeId } }',
      variables: { i: who.email, p: who.password },
    },
  });
  const signInBody = await signIn.json();
  if (signInBody.errors) throw new Error(`apiSignIn failed: ${JSON.stringify(signInBody.errors)}`);
  const challengeId = signInBody.data.signIn.factorChallengeId as string | null;
  if (challengeId) {
    if (!who.phone) throw new Error(`apiSignIn: ${who.email} met the second factor and helpers.ts gave it no phone`);
    const code = await readSmsCode(who.phone);
    const factor = await request.post(`${E2E_API_URL}/graphql`, {
      data: {
        query: 'mutation($c:String!,$k:String!){ verifySignInFactor(challengeId:$c,code:$k){ user { id } } }',
        variables: { c: challengeId, k: code },
      },
    });
    const factorBody = await factor.json();
    if (factorBody.errors) throw new Error(`apiSignIn factor failed: ${JSON.stringify(factorBody.errors)}`);
  }
}

/** One GraphQL call as whoever `apiSignIn` signed in on this context; throws on any error. */
export async function gql<T = Record<string, unknown>>(
  request: APIRequestContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await request.post(`${E2E_API_URL}/graphql`, { data: { query, variables } });
  const body = await res.json();
  if (body.errors) throw new Error(`gql failed: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/**
 * Step 1 of the seeded new-road contract, completed through the API — the
 * brief, one phase with its end date and a payment plan — so a spec about step
 * 2 does not have to fill in step 1 by hand (`17-requirements` is the spec that
 * does). Sales does it, as sales would; the seeded contract has no fee, so any
 * plan is a plan that adds up.
 */
export async function completeStepOneViaApi(request: APIRequestContext, ref = WIZARD_CONTRACT_REF): Promise<string> {
  await apiSignIn(request, SALES);
  const { allContracts } = await gql<{ allContracts: Array<{ id: string; ref: string }> }>(request, '{ allContracts { id ref } }');
  const contract = allContracts.find((c) => c.ref === ref);
  if (!contract) throw new Error(`completeStepOneViaApi: no contract ${ref}`);
  const { templateTypes } = await gql<{ templateTypes: Array<{ id: string; slug: string }> }>(request, '{ templateTypes(activeOnly: true) { id slug } }');
  const store = templateTypes.find((t) => t.slug === 'store');
  if (!store) throw new Error('completeStepOneViaApi: the seeded store type is missing');
  await gql(request, 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }', {
    c: contract.id,
    i: {
      kind: 'NEW_SITE',
      templateTypeId: store.id,
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
    },
  });
  const { createPhase } = await gql<{ createPhase: { phases: Array<{ id: string }> } }>(
    request,
    'mutation($c: ID!){ createPhase(contractId: $c, number: 1, titleFa: "فاز اول", titleEn: "First phase", plannedEndAt: "2026-11-10") { phases { id } } }',
    { c: contract.id },
  );
  await gql(
    request,
    'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: LUMP_SUM, invoices: $r) { id } }',
    {
      c: contract.id,
      r: [{ labelFa: 'کل مبلغ', labelEn: 'The whole amount', amount: '150000000', phaseId: createPhase.phases[0].id, paymentTermDays: 7 }],
    },
  );
  return contract.id;
}

/**
 * Publishes a Review Room round by calling `publishReviewRound` directly —
 * the same mutation `prisma/publish-round.ts` calls, the same trust
 * boundary (C1.md §3.1), just without a real root-sot checkout to shell git
 * against. The CLI's own git-and-split half is exercised for real by a
 * throwaway repository instead (see the C1 build note); this is only ever
 * used to get a round into the database for the *reading* screens to show.
 */
export async function publishTestRound(
  request: APIRequestContext,
  opts: { sha: string; label?: string; documents: Array<{ path: string; title: string; order: number; blocks: TestBlock[] }> },
): Promise<{ id: string }> {
  await apiSignIn(request, ADMIN);

  const res = await request.post(`${E2E_API_URL}/graphql`, {
    data: {
      query: `
        mutation($sha:String!,$label:String,$documents:[ReviewDocumentInput!]!){
          publishReviewRound(sha:$sha,label:$label,documents:$documents){ id }
        }
      `,
      variables: { sha: opts.sha, label: opts.label ?? null, documents: opts.documents },
    },
  });
  const body = await res.json();
  if (body.errors) throw new Error(`publishTestRound failed: ${JSON.stringify(body.errors)}`);
  return body.data.publishReviewRound as { id: string };
}

/**
 * The e2e-only outbox onto `DevSmsTransport` (routes/smsOutbox.ts;
 * `SMS_E2E_OUTBOX=1` in playwright.config.ts's API env). Polled briefly
 * rather than fetched once: the factor code is created and sent
 * synchronously inside `signIn`'s own resolver, so in practice it is
 * already there the instant the factor screen renders, but a short retry
 * costs nothing and removes any doubt about ordering.
 */
/**
 * Node's fetch keeps connections alive, and the API closes idle ones after a
 * few seconds; a request that lands on a socket the server has just closed
 * fails with ECONNRESET before it was ever processed (seen in the J1 e2e
 * run). Retried once, for these test-only helper calls alone.
 */
async function e2eFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code !== 'ECONNRESET') throw err;
    return fetch(url, init);
  }
}

/** See routes/smsOutbox.ts's reset route: every sign-in starts with fresh
 *  budgets, so one spec cannot spend the next one's allowance. */
async function resetRateLimits(): Promise<void> {
  const res = await e2eFetch(`${E2E_API_URL}/__e2e/rate-limits/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`resetRateLimits: ${res.status}`);
}

async function readSmsCode(phone: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await e2eFetch(`${E2E_API_URL}/__e2e/sms-outbox?phone=${encodeURIComponent(phone)}`);
    if (res.ok) {
      const body = (await res.json()) as { code: string | null };
      if (body.code) return body.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`signIn: no SMS code turned up in the e2e outbox for ${phone}`);
}

/**
 * Signs in through the real form, so the session cookie is set the real way.
 *
 * Clears cookies first: `/portal` bounces an already-signed-in visitor
 * straight to `homeFor(me)` before the sign-in form ever renders, which
 * would otherwise hang a spec that switches identities mid-test waiting for
 * `#email` on a page that navigated away.
 *
 * Waits for navigation away from the sign-in page rather than a fixed
 * destination: a customer lands in `/app/`, staff land on `/desk` (F2's
 * `homeFor`), and this helper is shared by both.
 *
 * **Journeys build plan J1.** `DevSmsTransport` makes the staff second
 * factor live in this environment (development, and e2e runs on it too) —
 * not only for specs that mean to test it, but for every existing spec that
 * signs in as a factor-requiring role, `admin@root.local` very much
 * included. So this helper completes the factor transparently whenever it
 * meets one: sign in, and if that lands on `/portal/factor` instead of the
 * caller's destination, read the code the factor SMS carried from the e2e
 * outbox and finish the second step before returning — every existing
 * `signIn(page, X)` call site keeps working exactly as it read before this
 * stage, with no awareness that a factor exists.
 */
export async function signIn(
  page: Page,
  who: { email: string; password: string; phone?: string },
  lang = 'en',
) {
  await page.context().clearCookies();
  await resetRateLimits();
  await page.goto(`/${lang}/portal`);
  await page.locator('#email').fill(who.email);
  await page.locator('#password').fill(who.password);
  await page.getByRole('button', { name: /sign in|ورود/i }).click();
  await page.waitForURL((url) => !/\/portal\/?$/.test(url.pathname));

  if (/\/portal\/factor\/?$/.test(new URL(page.url()).pathname)) {
    if (!who.phone) {
      throw new Error(`signIn: ${who.email} reached the staff second factor but helpers.ts gave it no phone`);
    }
    const code = await readSmsCode(who.phone);
    await page.locator('#factor-code').fill(code);
    await page.getByRole('button', { name: /verify|تأیید/i }).click();
    await page.waitForURL((url) => !/\/portal\/factor\/?$/.test(url.pathname));
  }
}
