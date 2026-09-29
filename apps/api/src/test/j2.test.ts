import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { CHECKLIST } from '../lib/templates.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import {
  contractOnProject,
  linkContractId,
  primaryContractId,
} from '../graphql/resolvers/admin/shared.js';

/**
 * J2 — requests: a project before a contract (journeys build plan §5 "J2").
 *
 * Eight things: the two database rules proven by direct insert (the CHECK,
 * and `Contract.projectId` NOT NULL — plus the migration's own guard, run
 * over a contract with no project); submitting; who may read a request (the
 * customer and `contracts.readAll`, and no one else — house rule 13); the
 * thread and when it closes; archiving; conversion, the second contract and
 * the refusals around them; the **`firstContractId` sweep** (every
 * project-scoped mutation returns the contract it is told to, and the link
 * helpers pick the contract they document); and the three notifications
 * through the dev transports.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string; code?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  // The fixture's customer gets a phone and Persian, like the seeded Nahal.
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const [i, role] of (['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]).entries()) {
    staff[role] = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}@test.local`,
        phone: `+98912000010${i}`,
        name: role,
        roles: [role],
        state: 'ACTIVE',
        locale: role === 'SALES' ? 'en' : 'fa',
      },
    });
  }
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to, code) => void sms.push({ to, code }),
    sendText: async (to, text) => void sms.push({ to, text }),
  });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// ---- documents ------------------------------------------------------------------

const REQUEST_FIELDS = `id title body lang status requestedAt archivedAt archivedReason contractId
  customer { id name clientName }
  messages { id body createdAt author { id name } }`;
const SUBMIT = `mutation($t: String!, $b: String!, $l: String!){ submitRequest(title: $t, body: $b, lang: $l) { ${REQUEST_FIELDS} } }`;
const POST = `mutation($p: ID!, $b: String!){ postRequestMessage(projectId: $p, body: $b) { ${REQUEST_FIELDS} } }`;
const ARCHIVE = `mutation($p: ID!, $r: String!){ archiveRequest(projectId: $p, reason: $r) { ${REQUEST_FIELDS} } }`;
const MINE = `{ myRequests { id status title archivedReason contractId } }`;
const ALL = `query($s: ProjectStatus){ allRequests(status: $s) { id status title customer { name } } }`;
const ONE = `query($p: ID!){ request(projectId: $p) { ${REQUEST_FIELDS} } }`;
const CREATE = `mutation($i: CreateContractInput!){
  createContract(input: $i) { id ref titleEn project { id status titleFa titleEn scopeItems { key contractId } }
    request { id status messages { body } } } }`;
const PUBLISH = `mutation($c: ID!){ publishContract(contractId: $c) { id } }`;

type Actor = 'ADMIN' | 'SALES' | 'DESIGNER' | 'DEVELOPER' | 'CONTRIBUTOR' | 'CUSTOMER' | 'STRANGER';
const actor = (name: Actor): User =>
  name === 'ADMIN' ? f.admin : name === 'CUSTOMER' ? f.customer : name === 'STRANGER' ? f.stranger : staff[name];

/** The customer submits a request; returns its (project) id. */
async function submit(title = 'A shop for our studio', body = 'We sell prints and want to sell them online.') {
  const data = ok(await exec(SUBMIT, { as: f.customer, variables: { t: title, b: body, l: 'en' } }));
  return (data.submitRequest as { id: string }).id;
}

/** Sales converts a request into a contract. */
async function convert(projectId: string, ref = 'RC-J2-001', as: User = staff.SALES) {
  const data = ok(
    await exec(CREATE, {
      as,
      variables: { i: { customerId: f.customer.id, ref, titleFa: 'فروشگاه', titleEn: 'The shop', projectId } },
    }),
  );
  return data.createContract as {
    id: string;
    project: { id: string; status: string; titleFa: string; titleEn: string; scopeItems: Array<{ key: string; contractId: string | null }> };
    request: { id: string; status: string; messages: Array<{ body: string }> } | null;
  };
}

// ---- the database rules, by direct insert ------------------------------------------

test('Project_archived_has_reason: an ARCHIVED project with no reason is refused by the database, not only the resolver', async () => {
  await assert.rejects(
    () =>
      prisma.project.create({
        data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'a', status: 'ARCHIVED' },
      }),
    /Project_archived_has_reason|check constraint/i,
  );
  // …and archiving an existing project by hand hits the same wall.
  const id = await submit();
  await assert.rejects(
    () => prisma.project.update({ where: { id }, data: { status: 'ARCHIVED' } }),
    /Project_archived_has_reason|check constraint/i,
  );
  // With a reason it is accepted, and a REQUESTED / ACTIVE one never needed one.
  await prisma.project.update({ where: { id }, data: { status: 'ARCHIVED', archivedReason: 'Out of scope' } });
  await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'a', status: 'REQUESTED' } });
});

test('Contract.projectId is NOT NULL: a direct insert of a contract with no project is refused', async () => {
  await assert.rejects(
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "Contract" ("id", "ref", "titleFa", "titleEn", "customerId", "updatedAt")
         VALUES ('orphan-contract', 'RC-ORPHAN', 'ا', 'a', '${f.customer.id}', now())`,
      ),
    /not-null|null value|23502/i,
  );
  const [col] = await prisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'Contract' AND column_name = 'projectId'`,
  );
  assert.equal(col.is_nullable, 'NO');
});

test('the migration refuses to make projectId required over a contract with no project — its own guard, run over a fixture', async () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20260929150000_j2_requests/migration.sql', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const block = sql.slice(sql.indexOf('-- VERIFY:BEGIN') + '-- VERIFY:BEGIN'.length, sql.indexOf('-- VERIFY:END')).trim();
  assert.match(block, /RAISE EXCEPTION/, 'the block is the guard');

  // Clean data: the guard is silent.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(block);
  });

  // A contract with no project (made possible only by un-requiring the column
  // inside this transaction): the guard raises, and the rollback is real.
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "Contract" ALTER COLUMN "projectId" DROP NOT NULL');
        await tx.$executeRawUnsafe(
          `INSERT INTO "Contract" ("id", "ref", "titleFa", "titleEn", "customerId", "updatedAt")
           VALUES ('orphan-contract', 'RC-ORPHAN', 'ا', 'a', '${f.customer.id}', now())`,
        );
        await tx.$executeRawUnsafe(block);
      }),
    /J2: 1 contract\(s\) have no project/,
  );
  const [col] = await prisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'Contract' AND column_name = 'projectId'`,
  );
  assert.equal(col.is_nullable, 'NO', 'the ALTER was rolled back with the failed guard');
});

test('NO_PROJECT is gone: nothing in the API source still throws it or branches on a null project', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(join(dir, entry.name));
    }
  };
  walk(root);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes("'NO_PROJECT'"), `${file} still names NO_PROJECT`);
    assert.ok(!/contract\.projectId!/.test(text), `${file} still asserts a non-null project`);
  }
});

// ---- submitting -----------------------------------------------------------------------

test('a customer submits a request: a REQUESTED project with placeholder titles, and nothing else', async () => {
  const data = ok(await exec(SUBMIT, { as: f.customer, variables: { t: '  A shop  ', b: ' Sell prints. ', l: 'fa' } }));
  const req = data.submitRequest as { id: string; title: string; body: string; lang: string; status: string; contractId: string | null; messages: unknown[] };
  assert.equal(req.status, 'REQUESTED');
  assert.equal(req.title, 'A shop', 'trimmed');
  assert.equal(req.body, 'Sell prints.');
  assert.equal(req.lang, 'fa');
  assert.equal(req.contractId, null);
  assert.deepEqual(req.messages, []);

  const project = await prisma.project.findUniqueOrThrow({ where: { id: req.id }, include: { scopeItems: true, contracts: true } });
  assert.equal(project.customerId, f.customer.id);
  assert.equal(project.titleFa, 'A shop', 'titleFa and titleEn hold the customer\'s title until sales replaces them');
  assert.equal(project.titleEn, 'A shop');
  assert.ok(project.requestedAt);
  assert.equal(project.scopeItems.length, 0, 'a request has no registry');
  assert.equal(project.contracts.length, 0, 'a request has no contract');
});

test('submitRequest refuses what cannot be a request, with codes', async () => {
  const cases: Array<[string, string, string, string]> = [
    ['   ', 'body', 'en', 'EMPTY_TITLE'],
    ['title', '  \n ', 'en', 'EMPTY_BODY'],
    ['x'.repeat(201), 'body', 'en', 'TOO_LONG'],
    ['title', 'y'.repeat(5001), 'en', 'TOO_LONG'],
    ['title', 'body', 'de', 'INVALID_LANG'],
  ];
  for (const [t, b, l, code] of cases) {
    const r = await exec(SUBMIT, { as: f.customer, variables: { t, b, l } });
    assert.equal(r.code, code, `${t.slice(0, 8)}/${l}`);
  }
  assert.equal(await prisma.project.count({ where: { requestedAt: { not: null } } }), 0, 'nothing was written');
  const anon = await exec(SUBMIT, { variables: { t: 'a', b: 'b', l: 'en' } });
  assert.equal(anon.code, 'UNAUTHENTICATED');
});

test('a flood is refused (RATE_LIMITED) before it spends anyone\'s SMS: ten requests a day, sixty messages an hour', async () => {
  for (let i = 0; i < 10; i++) await submit(`Request ${i}`);
  const eleventh = await exec(SUBMIT, { as: f.customer, variables: { t: 'One too many', b: 'b', l: 'en' } });
  assert.equal(eleventh.code, 'RATE_LIMITED');
  assert.equal(await prisma.project.count({ where: { customerId: f.customer.id, requestedAt: { not: null } } }), 10);
  // A different account has its own budget.
  ok(await exec(SUBMIT, { as: f.stranger, variables: { t: 'Mine', b: 'b', l: 'en' } }));

  const id = await submit('Chatty').catch(() => null);
  assert.equal(id, null, 'the customer is out of requests for today');
  const target = (await prisma.project.findFirstOrThrow({ where: { requestTitle: 'Request 0' } })).id;
  mail.length = 0;
  sms.length = 0;
  for (let i = 0; i < 60; i++) ok(await exec(POST, { as: f.customer, variables: { p: target, b: `m${i}` } }));
  const sixtyFirst = await exec(POST, { as: f.customer, variables: { p: target, b: 'one too many' } });
  assert.equal(sixtyFirst.code, 'RATE_LIMITED');
  assert.equal(await prisma.requestMessage.count({ where: { projectId: target } }), 60);
  assert.equal(smsTo(staff.SALES.phone).length, 60, 'and the refused one notified nobody');
});

// ---- who may read a request ---------------------------------------------------------------

test('a request is read by its customer and by contracts.readAll — and by no one else', async () => {
  const id = await submit();
  const readers: Array<[Actor, boolean]> = [
    ['CUSTOMER', true],
    ['SALES', true],
    ['ADMIN', true],
    ['STRANGER', false],
    ['DESIGNER', false],
    ['DEVELOPER', false],
    ['CONTRIBUTOR', false],
  ];
  for (const [who, may] of readers) {
    const r = await exec(ONE, { as: actor(who), variables: { p: id } });
    if (may) ok(r);
    else assert.equal(r.code, 'NOT_FOUND', `${who} reads someone else's request as "no such thing"`);
  }
  // A project id that never was a request is the same answer as one that does not exist.
  const plain = await exec(ONE, { as: f.admin, variables: { p: f.contract.projectId } });
  assert.equal(plain.code, 'NOT_FOUND');
  const missing = await exec(ONE, { as: f.admin, variables: { p: 'no-such-project' } });
  assert.equal(missing.code, 'NOT_FOUND');
});

test('lists: myRequests is the caller\'s own; allRequests is contracts.readAll and filters by status', async () => {
  const mine = await submit('Mine');
  const others = ok(await exec(SUBMIT, { as: f.stranger, variables: { t: 'Theirs', b: 'b', l: 'en' } })).submitRequest as { id: string };
  ok(await exec(ARCHIVE, { as: staff.SALES, variables: { p: others.id, r: 'Not a fit' } }));

  const myList = (ok(await exec(MINE, { as: f.customer })).myRequests as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(myList, [mine], 'the customer sees only their own');

  const all = (ok(await exec(ALL, { as: staff.SALES })).allRequests as Array<{ id: string; status: string }>);
  assert.deepEqual(all.map((r) => r.id).sort(), [mine, others.id].sort());
  const pending = (ok(await exec(ALL, { as: staff.SALES, variables: { s: 'REQUESTED' } })).allRequests as Array<{ id: string }>);
  assert.deepEqual(pending.map((r) => r.id), [mine]);
  const archived = (ok(await exec(ALL, { as: f.admin, variables: { s: 'ARCHIVED' } })).allRequests as Array<{ id: string }>);
  assert.deepEqual(archived.map((r) => r.id), [others.id]);

  for (const who of ['DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'CUSTOMER'] as Actor[]) {
    assert.equal((await exec(ALL, { as: actor(who) })).code, 'FORBIDDEN', who);
  }
  // The fixture's contract-project (never a request) is in neither list.
  assert.ok(!all.some((r) => r.id === f.contract.projectId));
});

// ---- the thread ------------------------------------------------------------------------------

test('the thread: both sides post, in order; each message carries its author\'s name and nothing more', async () => {
  const id = await submit();
  ok(await exec(POST, { as: f.customer, variables: { p: id, b: 'One more thing: Persian and English.' } }));
  ok(await exec(POST, { as: staff.SALES, variables: { p: id, b: 'Noted — can we call tomorrow?' } }));
  const req = ok(await exec(ONE, { as: f.customer, variables: { p: id } })).request as {
    messages: Array<{ body: string; author: { id: string; name: string } }>;
  };
  assert.deepEqual(req.messages.map((m) => m.body), ['One more thing: Persian and English.', 'Noted — can we call tomorrow?']);
  assert.deepEqual(req.messages.map((m) => m.author.name), ['Customer', 'SALES']);

  // The customer cannot ask for a staff member's email/phone/roles through a message: the type has no such field.
  const probe = await exec(
    `query($p: ID!){ request(projectId: $p) { messages { author { email phone roles } } } }`,
    { as: f.customer, variables: { p: id } },
  );
  assert.ok(probe.errors.length > 0, 'RequestParty exposes id, name and clientName only');
});

test('a customer cannot post to another customer\'s request — NOT_FOUND, and nothing is written', async () => {
  const id = await submit();
  const r = await exec(POST, { as: f.stranger, variables: { p: id, b: 'hello?' } });
  assert.equal(r.code, 'NOT_FOUND');
  // Design and development cannot see it, so it is "no such thing" for them too.
  for (const who of ['DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Actor[]) {
    assert.equal((await exec(POST, { as: actor(who), variables: { p: id, b: 'hi' } })).code, 'NOT_FOUND', who);
  }
  assert.equal(await prisma.requestMessage.count(), 0);
  // A project that is not a request at all.
  const plain = await exec(POST, { as: f.customer, variables: { p: f.contract.projectId, b: 'hi' } });
  assert.equal(plain.code, 'NOT_FOUND');
});

test('postRequestMessage validates the body, and refuses on a closed thread (REQUEST_CLOSED) — archived or converted', async () => {
  const id = await submit();
  assert.equal((await exec(POST, { as: f.customer, variables: { p: id, b: '   ' } })).code, 'EMPTY_COMMENT');
  assert.equal((await exec(POST, { as: f.customer, variables: { p: id, b: 'z'.repeat(5001) } })).code, 'TOO_LONG');

  ok(await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: 'Not for us' } }));
  assert.equal((await exec(POST, { as: f.customer, variables: { p: id, b: 'wait' } })).code, 'REQUEST_CLOSED');
  assert.equal((await exec(POST, { as: staff.SALES, variables: { p: id, b: 'sorry' } })).code, 'REQUEST_CLOSED');

  const second = await submit('Second');
  ok(await exec(POST, { as: f.customer, variables: { p: second, b: 'before conversion' } }));
  await convert(second);
  assert.equal((await exec(POST, { as: f.customer, variables: { p: second, b: 'after' } })).code, 'REQUEST_CLOSED');
  assert.equal((await exec(POST, { as: staff.SALES, variables: { p: second, b: 'after' } })).code, 'REQUEST_CLOSED');
  assert.equal(await prisma.requestMessage.count({ where: { projectId: second } }), 1, 'the thread is unchanged');
});

// ---- archiving --------------------------------------------------------------------------------

test('archiveRequest: contracts.author only, a reason is required, and the customer is shown it', async () => {
  const id = await submit();
  for (const who of ['CUSTOMER', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'STRANGER'] as Actor[]) {
    assert.equal((await exec(ARCHIVE, { as: actor(who), variables: { p: id, r: 'nope' } })).code, 'FORBIDDEN', who);
  }
  assert.equal((await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: '   ' } })).code, 'REASON_REQUIRED');
  assert.equal((await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: 'r'.repeat(1001) } })).code, 'TOO_LONG');
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).status, 'REQUESTED', 'refusals wrote nothing');

  const done = ok(await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: '  We only build sites for studios. ' } }))
    .archiveRequest as { status: string; archivedReason: string; archivedAt: string | null };
  assert.equal(done.status, 'ARCHIVED');
  assert.equal(done.archivedReason, 'We only build sites for studios.');
  assert.ok(done.archivedAt);

  const row = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert.equal(row.archivedById, staff.SALES.id);

  const mine = ok(await exec(MINE, { as: f.customer })).myRequests as Array<{ status: string; archivedReason: string | null }>;
  assert.deepEqual(mine.map((r) => [r.status, r.archivedReason]), [['ARCHIVED', 'We only build sites for studios.']]);

  // Archiving twice is REQUEST_CLOSED, not a second timestamp.
  assert.equal((await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: 'again' } })).code, 'REQUEST_CLOSED');
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).archivedAt?.getTime(), row.archivedAt?.getTime());
});

// ---- conversion, the second contract, and the refusals ------------------------------------------------

test('conversion: the contract attaches, the project flips to ACTIVE with sales\'s titles, the checklist is seeded, the thread stays', async () => {
  const id = await submit();
  ok(await exec(POST, { as: f.customer, variables: { p: id, b: 'Budget is flexible.' } }));

  const created = await convert(id);
  assert.equal(created.project.id, id, 'the contract is on the request\'s own project');
  assert.equal(created.project.status, 'ACTIVE');
  assert.equal(created.project.titleFa, 'فروشگاه');
  assert.equal(created.project.titleEn, 'The shop');
  assert.equal(created.project.scopeItems.length, CHECKLIST.length, 'the completeness checklist is seeded, once');
  assert.ok(created.project.scopeItems.every((s) => s.contractId === created.id), 'each row names its agreement');
  assert.equal(await prisma.project.count({ where: { customerId: f.customer.id } }), 2, 'no extra project was made (the fixture\'s and this one)');

  // The request survives: same columns, same thread, read-only.
  const kept = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert.equal(kept.requestTitle, 'A shop for our studio');
  assert.deepEqual(created.request?.messages.map((m) => m.body), ['Budget is flexible.']);
  assert.equal(created.request?.status, 'ACTIVE');
});

test('after conversion the request is linked from the contract to the customer and sales — not to design or development', async () => {
  const id = await submit();
  ok(await exec(POST, { as: f.customer, variables: { p: id, b: 'The origin of step 1.' } }));
  const contract = await convert(id);
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: contract.id } }));
  await prisma.contract.update({ where: { id: contract.id }, data: { designerId: staff.DESIGNER.id } });

  const Q = `query($c: ID!){ contract(id: $c) { id request { id status messages { body } contractId } } }`;
  for (const who of ['CUSTOMER', 'SALES', 'ADMIN'] as Actor[]) {
    const c = ok(await exec(Q, { as: actor(who), variables: { c: contract.id } })).contract as {
      request: { messages: Array<{ body: string }>; contractId: string } | null;
    };
    assert.deepEqual(c.request?.messages.map((m) => m.body), ['The origin of step 1.'], who);
    assert.equal(c.request?.contractId, contract.id, `${who}: the request points at the contract it became`);
  }
  const asDesigner = ok(await exec(Q, { as: staff.DESIGNER, variables: { c: contract.id } })).contract as { request: unknown };
  assert.equal(asDesigner.request, null, 'the assigned designer reads the contract, not the sales conversation before it');
  // A contract on a project that never was a request has none.
  const plain = ok(await exec(Q, { as: f.customer, variables: { c: f.contract.id } })).contract as { request: unknown };
  assert.equal(plain.request, null);
});

test('the customer\'s list keeps a converted request until a contract on it is published, then the contract is the row', async () => {
  const id = await submit();
  const contract = await convert(id);
  let mine = ok(await exec(MINE, { as: f.customer })).myRequests as Array<{ id: string; status: string; contractId: string | null }>;
  assert.deepEqual(mine.map((r) => [r.id, r.status, r.contractId]), [[id, 'ACTIVE', null]], 'converted, contract not yet openable: still shown, no link');

  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: contract.id } }));
  mine = ok(await exec(MINE, { as: f.customer })).myRequests as typeof mine;
  assert.deepEqual(mine, [], 'published: the contract is the row now');
  const one = ok(await exec(ONE, { as: f.customer, variables: { p: id } })).request as { contractId: string };
  assert.equal(one.contractId, contract.id, 'and the thread is still readable, pointing at it');
});

test('a second contract on an ACTIVE project (the Q5 case): it attaches, and the registry is neither reseeded nor claimed', async () => {
  const projectId = f.contract.projectId;
  const before = await prisma.scopeItem.count({ where: { projectId } });
  // A proposed trade item with no contract yet — the old `updateMany where contractId is null`
  // would have claimed it for the new contract.
  await prisma.scopeItem.create({
    data: { projectId, key: 'proposed-one', kind: 'FEATURE', labelFa: 'پ', labelEn: 'p', status: 'PROPOSED' },
  });

  const second = ok(
    await exec(CREATE, {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-J2-002', titleFa: 'ویژگی تازه', titleEn: 'A new feature', projectId } },
    }),
  ).createContract as { id: string; project: { id: string; status: string; titleEn: string } };

  assert.equal(second.project.id, projectId);
  assert.equal(second.project.status, 'ACTIVE');
  assert.equal(second.project.titleEn, 'Test contract', 'the project keeps its title; only a converted request takes sales\'s');
  const contracts = await prisma.contract.findMany({ where: { projectId } });
  assert.equal(contracts.length, 2);
  assert.equal(await prisma.scopeItem.count({ where: { projectId } }), before + 1, 'no checklist was seeded a second time');
  const proposed = await prisma.scopeItem.findFirstOrThrow({ where: { projectId, key: 'proposed-one' } });
  assert.equal(proposed.contractId, null, 'a row nobody has agreed is not claimed by the new contract');
});

test('PROJECT_CUSTOMER_MISMATCH: a contract for one customer cannot attach to another\'s project — and nothing is created or flipped', async () => {
  const id = await submit(); // the fixture customer's request
  const r = await exec(CREATE, {
    as: staff.SALES,
    variables: { i: { customerId: f.stranger.id, ref: 'RC-J2-X', titleFa: 'ا', titleEn: 'x', projectId: id } },
  });
  assert.equal(r.code, 'PROJECT_CUSTOMER_MISMATCH');
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).status, 'REQUESTED');
  assert.equal(await prisma.contract.count({ where: { ref: 'RC-J2-X' } }), 0);
  // …and the same for an ACTIVE project (the second-contract path).
  const r2 = await exec(CREATE, {
    as: staff.SALES,
    variables: { i: { customerId: f.stranger.id, ref: 'RC-J2-Y', titleFa: 'ا', titleEn: 'x', projectId: f.contract.projectId } },
  });
  assert.equal(r2.code, 'PROJECT_CUSTOMER_MISMATCH');
});

test('PROJECT_ARCHIVED: an archived request cannot become a contract; an unknown project is NOT_FOUND', async () => {
  const id = await submit();
  ok(await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: 'Not now' } }));
  const r = await exec(CREATE, {
    as: staff.SALES,
    variables: { i: { customerId: f.customer.id, ref: 'RC-J2-Z', titleFa: 'ا', titleEn: 'x', projectId: id } },
  });
  assert.equal(r.code, 'PROJECT_ARCHIVED');
  assert.equal(await prisma.contract.count({ where: { ref: 'RC-J2-Z' } }), 0);
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).status, 'ARCHIVED');

  const missing = await exec(CREATE, {
    as: staff.SALES,
    variables: { i: { customerId: f.customer.id, ref: 'RC-J2-W', titleFa: 'ا', titleEn: 'x', projectId: 'nope' } },
  });
  assert.equal(missing.code, 'NOT_FOUND');
});

test('a refused assignee leaves the request as it was (nothing is converted half-way)', async () => {
  const id = await submit();
  const r = await exec(CREATE, {
    as: staff.SALES,
    variables: {
      i: { customerId: f.customer.id, ref: 'RC-J2-A', titleFa: 'ا', titleEn: 'x', projectId: id, designerId: staff.DEVELOPER.id },
    },
  });
  assert.equal(r.code, 'ASSIGNEE_LACKS_CAPABILITY');
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).status, 'REQUESTED');
});

test('a duplicate ref rolls the whole conversion back — the request stays a request', async () => {
  const id = await submit();
  const r = await exec(CREATE, {
    as: staff.SALES,
    variables: { i: { customerId: f.customer.id, ref: f.contract.ref, titleFa: 'ا', titleEn: 'x', projectId: id } },
  });
  assert.ok(r.errors.length > 0);
  const row = await prisma.project.findUniqueOrThrow({ where: { id }, include: { scopeItems: true, contracts: true } });
  assert.equal(row.status, 'REQUESTED');
  assert.equal(row.scopeItems.length, 0);
  assert.equal(row.contracts.length, 0);
  assert.equal(row.titleEn, 'A shop for our studio', 'the placeholder titles were not overwritten');
});

test('two sales users converting the same request at once: both contracts attach, the checklist is seeded exactly once', async () => {
  const id = await submit();
  const results = await Promise.all([
    exec(CREATE, {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-RACE-1', titleFa: 'ا', titleEn: 'one', projectId: id } },
    }),
    exec(CREATE, {
      as: f.admin,
      variables: { i: { customerId: f.customer.id, ref: 'RC-RACE-2', titleFa: 'ب', titleEn: 'two', projectId: id } },
    }),
  ]);
  for (const r of results) ok(r);
  assert.equal(await prisma.contract.count({ where: { projectId: id } }), 2);
  assert.equal(await prisma.scopeItem.count({ where: { projectId: id } }), CHECKLIST.length);
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).status, 'ACTIVE');
});

test('createContract without a projectId is unchanged: a project of its own, the checklist named to its contract', async () => {
  const created = ok(
    await exec(CREATE, {
      as: staff.SALES,
      variables: { i: { customerId: f.customer.id, ref: 'RC-J2-PLAIN', titleFa: 'ا', titleEn: 'plain' } },
    }),
  ).createContract as { id: string; project: { status: string; scopeItems: Array<{ contractId: string | null }> } };
  assert.equal(created.project.status, 'ACTIVE');
  assert.equal(created.project.scopeItems.length, CHECKLIST.length);
  assert.ok(created.project.scopeItems.every((s) => s.contractId === created.id));
});

// ---- other surfaces a request must stay out of ---------------------------------------------------------------

test('a request holds no registry, dependencies or imports: those mutations refuse a non-active project, and the services panel never lists it', async () => {
  const id = await submit();
  const dep = await exec(
    'mutation($p: ID!){ createDependency(projectId: $p, side: ROOT, titleFa: "د", titleEn: "D", dueAt: "2026-11-01T00:00:00Z") { id } }',
    { as: staff.SALES, variables: { p: id } },
  );
  assert.equal(dep.code, 'PROJECT_NOT_ACTIVE');
  const mine = ok(await exec('{ myProjects { id } }', { as: f.customer })).myProjects as Array<{ id: string }>;
  assert.deepEqual(mine.map((p) => p.id), [f.contract.projectId], 'the request is not a project the services panel offers');
  const runs = await exec('query($p: ID!){ projectServiceRuns(projectId: $p) { id } }', { as: f.customer, variables: { p: id } });
  assert.equal(runs.code, 'NOT_FOUND');
});

test('design and development cannot reach a request through the project surfaces either', async () => {
  const id = await submit();
  for (const who of ['DESIGNER', 'DEVELOPER'] as Actor[]) {
    const p = ok(await exec('query($p: ID!){ project(id: $p) { id } }', { as: actor(who), variables: { p: id } })).project;
    assert.equal(p, null, `${who}: project(id) answers null for a request`);
    const list = ok(await exec('{ allContracts { id } }', { as: actor(who) })).allContracts as unknown[];
    assert.ok(Array.isArray(list));
  }
  const asSales = ok(await exec('query($p: ID!){ project(id: $p) { id status } }', { as: staff.SALES, variables: { p: id } })).project as { status: string };
  assert.equal(asSales.status, 'REQUESTED', 'sales sees the request as a project through contracts.readAll');
});

// ---- the firstContractId sweep -------------------------------------------------------------------------------------

/** A second contract on the fixture's project, with a phase, a scope item and a dependency to act on. */
async function twoContracts() {
  const projectId = f.contract.projectId;
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-J2-SECOND',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId,
      publishedAt: new Date('2026-09-20T00:00:00Z'),
      createdAt: new Date(Date.now() + 60_000),
    },
  });
  const item = await prisma.scopeItem.create({
    data: { projectId, key: 'blog', kind: 'FEATURE', labelFa: 'ب', labelEn: 'Blog', status: 'AGREED', contractId: second.id },
  });
  return { first: f.contract, second, item, projectId };
}

test('every project-scoped mutation returns the contract it is told to; unnamed, the project\'s first; another project\'s contract is NOT_FOUND', async () => {
  const { first, second, item, projectId } = await twoContracts();
  const phase = await prisma.phase.create({ data: { projectId, contractId: first.id, number: 1, titleFa: 'ف', titleEn: 'P1' } });
  const dep = await prisma.dependency.create({
    data: { projectId, side: 'ROOT', titleFa: 'د', titleEn: 'D', dueAt: new Date('2026-12-01T00:00:00Z'), createdById: f.admin.id },
  });
  const demo = await prisma.demo.create({ data: { phaseId: phase.id, stagingUrl: 'https://s.example.com' } });

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['updateScopeItem', 'mutation($c: ID, $i: ID!){ updateScopeItem(scopeItemId: $i, labelFa: "ب", labelEn: "Blog", contractId: $c) { id } }', { i: item.id }],
    ['setScopeItemStatus', 'mutation($c: ID, $i: ID!){ setScopeItemStatus(scopeItemId: $i, status: AGREED, contractId: $c) { id } }', { i: item.id }],
    ['reorderScopeItem', 'mutation($c: ID, $i: ID!){ reorderScopeItem(scopeItemId: $i, direction: UP, contractId: $c) { id } }', { i: item.id }],
    // (updatePhase left this list in J4: a phase names its contract, so it answers
    // with *that* contract and refuses another one — see j4.test.ts.)
    ['assignScopeItemToPhase', 'mutation($c: ID, $i: ID!, $p: ID){ assignScopeItemToPhase(scopeItemId: $i, phaseId: $p, contractId: $c) { id } }', { i: item.id, p: phase.id }],
    ['createDependency', 'mutation($c: ID, $p: ID!){ createDependency(projectId: $p, side: ROOT, titleFa: "د", titleEn: "E", dueAt: "2026-12-05T00:00:00Z", contractId: $c) { id } }', { p: projectId }],
    ['updateDependency', 'mutation($c: ID, $d: ID!){ updateDependency(dependencyId: $d, titleFa: "د", titleEn: "D", dueAt: "2026-12-01T00:00:00Z", contractId: $c) { id } }', { d: dep.id }],
    ['verifyDependency', 'mutation($c: ID, $d: ID!){ verifyDependency(dependencyId: $d, note: "checked the file", contractId: $c) { id } }', { d: dep.id }],
    ['updateDemo', 'mutation($c: ID, $d: ID!){ updateDemo(demoId: $d, buildRef: "abc", contractId: $c) { id } }', { d: demo.id }],
    ['updateDemoFrameSummary', 'mutation($c: ID, $d: ID!){ updateDemoFrameSummary(demoId: $d, summaryEn: "hi", contractId: $c) { id } }', { d: demo.id }],
    ['generateDemoFrame', 'mutation($c: ID, $d: ID!){ generateDemoFrame(demoId: $d, contractId: $c) { id } }', { d: demo.id }],
    ['publishDemo', 'mutation($c: ID, $d: ID!){ publishDemo(demoId: $d, contractId: $c) { id } }', { d: demo.id }],
  ];

  // A contract on a *different* project, to name wrongly.
  const otherProject = await prisma.project.create({ data: { customerId: f.stranger.id, titleFa: 'ا', titleEn: 'o' } });
  const foreign = await prisma.contract.create({
    data: { ref: 'RC-FOREIGN', titleFa: 'ا', titleEn: 'f', customerId: f.stranger.id, projectId: otherProject.id },
  });

  for (const [name, doc, vars] of calls) {
    const named = ok(await exec(doc, { as: f.admin, variables: { ...vars, c: second.id } }));
    assert.equal((named[name] as { id: string }).id, second.id, `${name}: names the second contract, gets the second contract`);
  }
  // Unnamed: the project's first — what every caller got before J2. (`publishDemo`/`verifyDependency`
  // are one-shot, so the unnamed and wrong-name variants run on the calls that repeat.)
  for (const [name, doc, vars] of calls) {
    if (['publishDemo', 'verifyDependency'].includes(name)) continue;
    const unnamed = ok(await exec(doc, { as: f.admin, variables: { ...vars, c: null } }));
    assert.equal((unnamed[name] as { id: string }).id, first.id, `${name}: unnamed → the project's first`);
    const wrong = await exec(doc, { as: f.admin, variables: { ...vars, c: foreign.id } });
    assert.equal(wrong.code, 'NOT_FOUND', `${name}: another project's contract is refused, not returned`);
  }
});

test('executeScopeTrade amends the contract that agreed the outgoing item, and agrees the incoming item to it', async () => {
  const { first, second, item, projectId } = await twoContracts();
  const incoming = await prisma.scopeItem.create({
    data: { projectId, key: 'shop', kind: 'FEATURE', labelFa: 'ف', labelEn: 'Shop', status: 'PROPOSED' },
  });
  const trade = await prisma.scopeTrade.create({
    data: {
      projectId,
      outItemId: item.id, // agreed by the SECOND contract
      inItemId: incoming.id,
      proposedById: f.admin.id,
      rootConfirmedAt: new Date(),
      customerConfirmedAt: new Date(),
    },
  });
  const r = ok(
    await exec('mutation($t: ID!, $c: ID){ executeScopeTrade(tradeId: $t, contractId: $c) { id } }', {
      as: f.admin,
      variables: { t: trade.id, c: second.id },
    }),
  );
  assert.equal((r.executeScopeTrade as { id: string }).id, second.id);
  const after = await prisma.scopeItem.findUniqueOrThrow({ where: { id: incoming.id } });
  assert.equal(after.status, 'AGREED');
  assert.equal(after.contractId, second.id, 'the trade agreed the item into the contract that agreed the one it replaced — not the first');
  assert.notEqual(after.contractId, first.id);
});

test('setScopeItem (the customer\'s tick): acts through the contract named, else the one that agreed the item, else the newest published', async () => {
  const { first, second, item, projectId } = await twoContracts(); // item.contractId = second
  const proposed = await prisma.scopeItem.create({
    data: { projectId, key: 'proposed-two', kind: 'FEATURE', labelFa: 'پ', labelEn: 'p', status: 'PROPOSED' },
  });
  const TICK = 'mutation($i: ID!, $c: ID){ setScopeItem(scopeItemId: $i, checked: true, contractId: $c) { id } }';
  const tick = async (as: User, i: string, c: string | null) =>
    exec(TICK, { as, variables: { i, c } });

  const named = ok(await tick(f.customer, item.id, first.id));
  assert.equal((named.setScopeItem as { id: string }).id, first.id, 'named: the contract the customer has open');
  const agreed = ok(await tick(f.customer, item.id, null));
  assert.equal((agreed.setScopeItem as { id: string }).id, second.id, 'unnamed: the contract that agreed the item');
  const neither = ok(await tick(f.customer, proposed.id, null));
  assert.equal((neither.setScopeItem as { id: string }).id, second.id, 'no agreeing contract either: the newest published one');

  // Not someone else's contract, not another project's, not an unpublished one.
  const otherProject = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'o' } });
  const elsewhere = await prisma.contract.create({
    data: { ref: 'RC-ELSEWHERE', titleFa: 'ا', titleEn: 'e', customerId: f.customer.id, projectId: otherProject.id, publishedAt: new Date() },
  });
  assert.equal((await tick(f.customer, item.id, elsewhere.id)).code, 'NOT_FOUND', 'the contract must be on the item\'s own project');
  assert.equal((await tick(f.stranger, item.id, first.id)).code, 'NOT_FOUND');
  assert.equal((await tick(f.stranger, item.id, null)).code, 'NOT_FOUND');
  const draft = await prisma.contract.create({
    data: { ref: 'RC-J2-DRAFT2', titleFa: 'ا', titleEn: 'd', customerId: f.customer.id, projectId },
  });
  assert.equal((await tick(f.customer, item.id, draft.id)).code, 'NOT_FOUND', 'an unpublished draft is not the customer\'s to act through');
});

test('linkContractId: the customer is pointed at the newest published live contract; staff at the newest live one', async () => {
  const { first, second, projectId } = await twoContracts(); // second is newer and published
  assert.equal(await linkContractId(projectId, 'customer'), second.id);
  assert.equal(await linkContractId(projectId, 'staff'), second.id);

  // A newer draft: staff follow the work, the customer cannot open it.
  const draft = await prisma.contract.create({
    data: {
      ref: 'RC-J2-DRAFT',
      titleFa: 'پیش‌نویس',
      titleEn: 'Draft',
      customerId: f.customer.id,
      projectId,
      createdAt: new Date(Date.now() + 120_000),
    },
  });
  assert.equal(await linkContractId(projectId, 'staff'), draft.id);
  assert.equal(await linkContractId(projectId, 'customer'), second.id, 'never an unpublished draft');

  // Discarded contracts are passed over.
  await prisma.contract.update({ where: { id: second.id }, data: { status: 'DISCARDED' } });
  await prisma.contract.update({ where: { id: draft.id }, data: { status: 'DISCARDED' } });
  assert.equal(await linkContractId(projectId, 'customer'), first.id);
  assert.equal(await linkContractId(projectId, 'staff'), first.id);

  // Everything discarded: fall back to the project's first rather than failing an act already done.
  await prisma.contract.update({ where: { id: first.id }, data: { status: 'DISCARDED' } });
  assert.equal(await linkContractId(projectId, 'staff'), first.id);
  assert.equal(await primaryContractId(projectId), first.id);
});

test('contractOnProject: the named contract if it is on the project, the first if none is named', async () => {
  const { first, second, projectId } = await twoContracts();
  assert.equal(await contractOnProject(projectId, second.id), second.id);
  assert.equal(await contractOnProject(projectId), first.id);
  assert.equal(await contractOnProject(projectId, null), first.id);
  await assert.rejects(() => contractOnProject(projectId, 'nope'), /No such contract/);
  const emptyProject = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'e' } });
  await assert.rejects(() => primaryContractId(emptyProject.id), /no contract yet/);
});

test('a developer of a discarded first contract loses the project\'s builds once a second contract has another developer', async () => {
  const { first, second, projectId } = await twoContracts();
  await prisma.contract.update({ where: { id: first.id }, data: { developerId: staff.DEVELOPER.id } });
  await prisma.contract.update({ where: { id: second.id }, data: { developerId: f.admin.id } });
  // Each contract delivers a phase of its own (J4) — the claim is on a phase,
  // and a phase is its own contract's.
  await prisma.phase.create({ data: { projectId, contractId: first.id, number: 1, titleFa: 'الف', titleEn: 'First' } });
  await prisma.phase.create({ data: { projectId, contractId: second.id, number: 1, titleFa: 'ب', titleEn: 'Second' } });
  const Q = 'query($p: ID!){ openFeedbackQueue(projectId: $p) { id } }';
  // Both live: a developer works the phases of the contract they develop.
  ok(await exec(Q, { as: staff.DEVELOPER, variables: { p: projectId } }));

  // The first is discarded and the project has moved on to a second contract
  // with another developer: the project is still visible to a developer
  // (its second contract is live) but is no longer theirs.
  await prisma.contract.update({ where: { id: first.id }, data: { status: 'DISCARDED' } });
  const r = await exec(Q, { as: staff.DEVELOPER, variables: { p: projectId } });
  assert.equal(r.code, 'NOT_ASSIGNED');
  ok(await exec(Q, { as: f.admin, variables: { p: projectId } }));
});

// ---- notifications, through the dev transports -------------------------------------------------------------------------

const mailTo = (email: string | null) => mail.filter((m) => m.to === email);
const smsTo = (phone: string | null) => sms.filter((s) => s.to === phone);

test('a new request notifies every active contracts.author holder — by capability, not role — by email and SMS, in their language', async () => {
  // A second SALES who is disabled, and a SALES-role account whose phone is its only identifier.
  await prisma.user.create({
    data: { email: 'gone@test.local', name: 'Gone', roles: ['SALES'], state: 'DISABLED', phone: '+989120000199' },
  });
  await prisma.user.create({
    data: { phone: '+989120000198', name: 'Phone only', roles: ['SALES'], state: 'ACTIVE', locale: 'fa' },
  });
  const id = await submit('A shop for our studio');

  // SALES (en) and ADMIN got the email; the disabled SALES, the designer, the developer and the contributor did not.
  const salesMail = mailTo(staff.SALES.email);
  assert.equal(salesMail.length, 1);
  assert.match(salesMail[0].subject, /New request from Test Studio/, 'the desk names a customer by company where there is one');
  assert.match(salesMail[0].text, /A shop for our studio/);
  assert.ok(salesMail[0].text.includes(`/en/desk/requests/${id}`), 'the link is the recipient\'s language and the request\'s desk page');
  assert.equal(mailTo(f.admin.email).length, 1);
  for (const who of ['gone@test.local', staff.DESIGNER.email, staff.DEVELOPER.email, staff.CONTRIBUTOR.email]) {
    assert.equal(mailTo(who).length, 0, `${who} is not told`);
  }
  // SMS: SALES has a phone, so does the phone-only account; the disabled one does not get one.
  assert.equal(smsTo(staff.SALES.phone).length, 1);
  assert.match(smsTo(staff.SALES.phone)[0].text!, /New request on Root: .*\/en\/desk\/requests\//);
  const phoneOnly = smsTo('+989120000198');
  assert.equal(phoneOnly.length, 1, 'a phone-only sales account is reached by SMS alone');
  assert.match(phoneOnly[0].text!, /درخواست تازه‌ای در ریشه ثبت شد/);
  assert.equal(smsTo('+989120000199').length, 0);
  assert.equal(smsTo(f.customer.phone).length, 0, 'the submitter is not told about their own request');
  assert.equal(mailTo(f.customer.email).length, 0);
});

test('a message goes to the other side only: customer → sales, sales → the customer (in Persian)', async () => {
  const id = await submit();
  mail.length = 0;
  sms.length = 0;

  ok(await exec(POST, { as: f.customer, variables: { p: id, b: 'Any news?' } }));
  assert.equal(mailTo(staff.SALES.email).length, 1);
  assert.equal(mailTo(f.admin.email).length, 1);
  assert.equal(mailTo(f.customer.email).length, 0, 'never the writer');
  assert.match(mailTo(staff.SALES.email)[0].subject, /New message on “A shop for our studio”/);
  assert.equal(smsTo(staff.SALES.phone).length, 1);
  assert.equal(smsTo(f.customer.phone).length, 0);

  mail.length = 0;
  sms.length = 0;
  ok(await exec(POST, { as: staff.SALES, variables: { p: id, b: 'Yes — sent you a call invite.' } }));
  const toCustomer = mailTo(f.customer.email);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].subject, /پیام تازه روی «A shop for our studio»/, 'the customer\'s locale is fa');
  assert.ok(toCustomer[0].text.includes(`/fa/app/contracts?request=${id}`), 'the link opens the drawer on the portal list');
  assert.equal(mailTo(staff.SALES.email).length, 0, 'never the writer');
  assert.equal(mailTo(f.admin.email).length, 0, 'sales talking to the customer does not notify other sales users');
  const customerSms = smsTo(f.customer.phone);
  assert.equal(customerSms.length, 1);
  assert.match(customerSms[0].text!, /پیام تازه‌ای روی یک درخواست در ریشه ثبت شد/);
});

test('archiving tells the customer, with the reason, by email and SMS', async () => {
  const id = await submit();
  mail.length = 0;
  sms.length = 0;
  ok(await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: 'We only build sites for studios.\nSorry!' } }));

  const toCustomer = mailTo(f.customer.email);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].subject, /درخواستِ شما بایگانی شد — A shop for our studio/);
  assert.ok(toCustomer[0].text.includes('We only build sites for studios.\nSorry!'), 'the reason, verbatim');
  assert.ok(toCustomer[0].html.includes('We only build sites for studios.<br>Sorry!'), 'and with its line breaks in the HTML');
  assert.equal(mail.length, 1, 'nobody else is told');
  const customerSms = smsTo(f.customer.phone);
  assert.equal(customerSms.length, 1);
  assert.match(customerSms[0].text!, /درخواست شما در ریشه بایگانی شد/);
  assert.ok(!customerSms[0].text!.includes('studios'), 'the reason is not in the SMS — it points at the page');
});

test('a refused act sends nothing', async () => {
  const id = await submit();
  mail.length = 0;
  sms.length = 0;
  await exec(POST, { as: f.stranger, variables: { p: id, b: 'hi' } });
  await exec(ARCHIVE, { as: f.customer, variables: { p: id, r: 'mine' } });
  await exec(ARCHIVE, { as: staff.SALES, variables: { p: id, r: '' } });
  assert.equal(mail.length, 0);
  assert.equal(sms.length, 0);
});
