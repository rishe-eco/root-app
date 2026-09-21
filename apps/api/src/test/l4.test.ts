import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * L4: ratified item -> change ticket; the three channels (build plan §3
 * "L4"; spec §5, §6) — surfacing the as-built Ticket/TicketMessage models,
 * the ADMIN_REQUEST channel and its counter (spec §10.2), and moving a
 * ticket between channels as a first-class action.
 */

let f: Fixture;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

/** A phase, a published demo with a frame, and one RATIFIED feedback item on
 *  a declared page — the same shape L3b's own suite uses to get to a
 *  disposable item, since createTicketFromFeedback shares that precondition. */
async function seedRatifiedFeedback(body = 'رنگِ دکمه اشتباه است') {
  const projectId = f.contract.projectId!;
  const phase = await prisma.phase.create({ data: { projectId, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const demo = await prisma.demo.create({ data: { phaseId: phase.id, stagingUrl: 'https://staging.example.com' } });
  const page = await prisma.demoPage.create({
    data: { demoId: demo.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' },
  });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const submitted = ok(
    await exec(
      'mutation($d: ID!, $p: ID!, $b: String!){ submitFeedback(demoId: $d, targetDemoPageId: $p, body: $b) { item { id } } }',
      { as: f.customer, variables: { d: demo.id, p: page.id, b: body } },
    ),
  );
  const itemId = (submitted.submitFeedback as { item: { id: string } }).item.id;
  ok(
    await exec('mutation($d: ID!, $ids: [ID!]!){ ratifyFeedback(demoId: $d, itemIds: $ids) { id } }', {
      as: f.customer,
      variables: { d: demo.id, ids: [itemId] },
    }),
  );
  return { projectId, phase, demo, page, itemId };
}

const CREATE_TICKET_FROM_FEEDBACK = `
  mutation($itemId: ID!, $currentState: String!, $desiredState: String!, $lang: String!) {
    createTicketFromFeedback(itemId: $itemId, currentState: $currentState, desiredState: $desiredState, lang: $lang) {
      id type status subject
      briefPageFa briefPageEn briefAnnotation briefCurrentState briefDesiredState briefLang
      customer { id }
      project { id }
      sourceFeedbackItem { id }
    }
  }
`;

// --- "A ratified item becomes a change ticket — it is the brief" -----------

test('createTicketFromFeedback converts a RATIFIED item into a CHANGE_REQUEST ticket, with the brief populated', async () => {
  const { itemId } = await seedRatifiedFeedback('رنگِ دکمه اشتباه است');

  const result = ok(
    await exec(CREATE_TICKET_FROM_FEEDBACK, {
      as: f.admin,
      variables: { itemId, currentState: 'دکمه آبی است', desiredState: 'دکمه باید سبز باشد', lang: 'fa' },
    }),
  );
  const ticket = result.createTicketFromFeedback as {
    id: string;
    type: string;
    status: string;
    subject: string;
    briefPageFa: string | null;
    briefPageEn: string | null;
    briefAnnotation: string | null;
    briefCurrentState: string | null;
    briefDesiredState: string | null;
    briefLang: string | null;
    customer: { id: string };
    project: { id: string } | null;
    sourceFeedbackItem: { id: string };
  };

  assert.equal(ticket.type, 'CHANGE_REQUEST');
  assert.equal(ticket.status, 'OPEN');
  assert.equal(ticket.customer.id, f.customer.id, 'the customer comes from the project, not the caller');
  assert.equal(ticket.project?.id, f.contract.projectId);
  assert.equal(ticket.sourceFeedbackItem.id, itemId);
  // The brief: page and annotation compiled automatically, current/desired
  // state written by whoever performed the conversion (build plan L4).
  assert.equal(ticket.briefPageFa, 'خانه');
  assert.equal(ticket.briefPageEn, 'Home');
  assert.match(ticket.briefAnnotation ?? '', /رنگِ دکمه اشتباه است/);
  assert.match(ticket.briefAnnotation ?? '', new RegExp(f.customer.name));
  assert.equal(ticket.briefCurrentState, 'دکمه آبی است');
  assert.equal(ticket.briefDesiredState, 'دکمه باید سبز باشد');
  assert.equal(ticket.briefLang, 'fa');

  // Once converted, the item leaves the build-feedback queue — it is now
  // tracked through the ticket, and requiring a disposition for it forever
  // would mean the queue could never drain (see resolvers/builds.ts).
  const queue = ok(
    await exec('query($p: ID!){ openFeedbackQueue(projectId: $p) { id } }', {
      as: await prisma.user.create({ data: { email: 'dev@test.local', name: 'Dev', roles: ['DEVELOPER'], state: 'ACTIVE' } }),
      variables: { p: f.contract.projectId },
    }),
  );
  assert.deepEqual(queue.openFeedbackQueue, [], 'a converted item is no longer in the build queue');
});

test('createTicketFromFeedback refuses (NOT_RATIFIED) an item that is merely OPEN', async () => {
  const projectId = f.contract.projectId!;
  const phase = await prisma.phase.create({ data: { projectId, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const demo = await prisma.demo.create({ data: { phaseId: phase.id, stagingUrl: 'https://staging.example.com' } });
  const page = await prisma.demoPage.create({
    data: { demoId: demo.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' },
  });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  const submitted = ok(
    await exec(
      'mutation($d: ID!, $p: ID!, $b: String!){ submitFeedback(demoId: $d, targetDemoPageId: $p, body: $b) { item { id } } }',
      { as: f.customer, variables: { d: demo.id, p: page.id, b: 'یک نظر' } },
    ),
  );
  const itemId = (submitted.submitFeedback as { item: { id: string } }).item.id;

  const result = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.admin,
    variables: { itemId, currentState: 'x', desiredState: 'y', lang: 'en' },
  });
  assert.equal(result.code, 'NOT_RATIFIED');
});

test('createTicketFromFeedback refuses (ALREADY_CONVERTED) a second conversion of the same item', async () => {
  const { itemId } = await seedRatifiedFeedback();
  ok(
    await exec(CREATE_TICKET_FROM_FEEDBACK, {
      as: f.admin,
      variables: { itemId, currentState: 'x', desiredState: 'y', lang: 'en' },
    }),
  );
  const second = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.admin,
    variables: { itemId, currentState: 'x2', desiredState: 'y2', lang: 'en' },
  });
  assert.equal(second.code, 'ALREADY_CONVERTED');
});

test('createTicketFromFeedback requires both currentState and desiredState, and a valid lang', async () => {
  const { itemId } = await seedRatifiedFeedback();
  const noCurrent = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.admin,
    variables: { itemId, currentState: '   ', desiredState: 'y', lang: 'en' },
  });
  assert.equal(noCurrent.code, 'CURRENT_STATE_REQUIRED');

  const noDesired = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.admin,
    variables: { itemId, currentState: 'x', desiredState: '', lang: 'en' },
  });
  assert.equal(noDesired.code, 'DESIRED_STATE_REQUIRED');

  const badLang = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.admin,
    variables: { itemId, currentState: 'x', desiredState: 'y', lang: 'de' },
  });
  assert.equal(badLang.code, 'INVALID_LANG');
});

test('createTicketFromFeedback is refused for a customer and a DEVELOPER — builds.author is not contracts.manage', async () => {
  const { itemId } = await seedRatifiedFeedback();
  const developer = await prisma.user.create({
    data: { email: 'dev2@test.local', name: 'Dev', roles: ['DEVELOPER'], state: 'ACTIVE' },
  });
  const asCustomer = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: f.customer,
    variables: { itemId, currentState: 'x', desiredState: 'y', lang: 'en' },
  });
  assert.equal(asCustomer.code, 'FORBIDDEN');

  const asDeveloper = await exec(CREATE_TICKET_FROM_FEEDBACK, {
    as: developer,
    variables: { itemId, currentState: 'x', desiredState: 'y', lang: 'en' },
  });
  assert.equal(asDeveloper.code, 'FORBIDDEN');
});

// --- The three channels, and moving between them ----------------------------

const CREATE_TICKET = `
  mutation($type: TicketType!, $subject: String!, $body: String!) {
    createTicket(type: $type, subject: $subject, body: $body) { id type status subject customer { id } messages { body } }
  }
`;

test('the customer\'s own support intake — createTicket refuses ADMIN_REQUEST directly (INVALID_TICKET_TYPE)', async () => {
  const asAdminRequest = await exec(CREATE_TICKET, {
    as: f.customer,
    variables: { type: 'ADMIN_REQUEST', subject: 'یک درخواست', body: 'می‌خواهم یک صفحه اضافه کنم' },
  });
  assert.equal(asAdminRequest.code, 'INVALID_TICKET_TYPE');

  const asBug = ok(
    await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'BUG', subject: 'خطا', body: 'چیزی کار نمی‌کند' } }),
  );
  const ticket = asBug.createTicket as { type: string; customer: { id: string } };
  assert.equal(ticket.type, 'BUG');
  assert.equal(ticket.customer.id, f.customer.id);
});

test('staff may createTicket directly as ADMIN_REQUEST — the classification staff apply', async () => {
  const result = ok(
    await exec(CREATE_TICKET, { as: f.admin, variables: { type: 'ADMIN_REQUEST', subject: 'ورود ادمین', body: 'کمک می‌خواهد' } }),
  );
  assert.equal((result.createTicket as { type: string }).type, 'ADMIN_REQUEST');
});

test('moveTicketChannel is a first-class action — a support ticket recognized as an admin request moves in place, keeping its messages', async () => {
  const created = ok(
    await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'QUESTION', subject: 'چطور می‌توانم…', body: 'راهنمایی می‌خواهم' } }),
  );
  const ticket = created.createTicket as { id: string; messages: Array<{ body: string }> };
  assert.equal(ticket.messages.length, 1);

  const moved = ok(
    await exec('mutation($id: ID!, $t: TicketType!){ moveTicketChannel(ticketId: $id, type: $t) { id type messages { body } } }', {
      as: f.admin,
      variables: { id: ticket.id, t: 'ADMIN_REQUEST' },
    }),
  );
  const movedTicket = moved.moveTicketChannel as { type: string; messages: Array<{ body: string }> };
  assert.equal(movedTicket.type, 'ADMIN_REQUEST', 'the same row, moved — not a copy in a new channel');
  assert.equal(movedTicket.messages.length, 1, 'the message history survives the move');
  assert.equal(movedTicket.messages[0].body, 'راهنمایی می‌خواهم');
});

test('moveTicketChannel is refused for a customer (FORBIDDEN) and for a stranger\'s ticket (NOT_FOUND for staff would be wrong; staff sees every ticket)', async () => {
  const created = ok(
    await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'QUESTION', subject: 'س', body: 'ب' } }),
  );
  const ticketId = (created.createTicket as { id: string }).id;
  const asCustomer = await exec('mutation($id: ID!, $t: TicketType!){ moveTicketChannel(ticketId: $id, type: $t) { id } }', {
    as: f.customer,
    variables: { id: ticketId, t: 'ADMIN_REQUEST' },
  });
  assert.equal(asCustomer.code, 'FORBIDDEN');
});

// --- The ADMIN_REQUEST counter — a real, queryable number -------------------

test('adminRequestCount is a real number across every ADMIN_REQUEST ticket, regardless of status', async () => {
  const zero = ok(await exec('query{ adminRequestCount }', { as: f.admin }));
  assert.equal(zero.adminRequestCount, 0);

  const a = ok(await exec(CREATE_TICKET, { as: f.admin, variables: { type: 'ADMIN_REQUEST', subject: 'یک', body: 'ب' } }));
  await exec(CREATE_TICKET, { as: f.admin, variables: { type: 'ADMIN_REQUEST', subject: 'دو', body: 'ب' } });
  await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'BUG', subject: 'سه', body: 'ب' } });

  const two = ok(await exec('query{ adminRequestCount }', { as: f.admin }));
  assert.equal(two.adminRequestCount, 2, 'BUG tickets do not count; both ADMIN_REQUEST ones do');

  // Closing one does not shrink the count — it is a demand signal, not a backlog.
  const ticketId = (a.createTicket as { id: string }).id;
  ok(
    await exec('mutation($id: ID!, $s: TicketStatus!){ setTicketStatus(ticketId: $id, status: $s) { id } }', {
      as: f.admin,
      variables: { id: ticketId, s: 'CLOSED' },
    }),
  );
  const stillTwo = ok(await exec('query{ adminRequestCount }', { as: f.admin }));
  assert.equal(stillTwo.adminRequestCount, 2);
});

test('adminRequestCount is refused for a customer (FORBIDDEN)', async () => {
  const result = await exec('query{ adminRequestCount }', { as: f.customer });
  assert.equal(result.code, 'FORBIDDEN');
});

// --- Ownership: myTickets/allTickets, addTicketMessage ----------------------

test('myTickets is scoped to the caller; allTickets sees everyone\'s and can filter', async () => {
  ok(await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'BUG', subject: 'س۱', body: 'ب' } }));
  ok(await exec(CREATE_TICKET, { as: f.stranger, variables: { type: 'QUESTION', subject: 'س۲', body: 'ب' } }));

  const mine = ok(await exec('query{ myTickets { subject } }', { as: f.customer }));
  assert.equal((mine.myTickets as unknown[]).length, 1);

  const all = ok(await exec('query{ allTickets { subject } }', { as: f.admin }));
  assert.equal((all.allTickets as unknown[]).length, 2);

  const filtered = ok(await exec('query($t: TicketType){ allTickets(type: $t) { subject } }', { as: f.admin, variables: { t: 'BUG' } }));
  assert.equal((filtered.allTickets as unknown[]).length, 1);

  const forbidden = await exec('query{ allTickets { id } }', { as: f.customer });
  assert.equal(forbidden.code, 'FORBIDDEN');
});

test('addTicketMessage is refused (NOT_FOUND) for a stranger, and succeeds for the ticket\'s own customer or staff', async () => {
  const created = ok(await exec(CREATE_TICKET, { as: f.customer, variables: { type: 'BUG', subject: 'س', body: 'ب' } }));
  const ticketId = (created.createTicket as { id: string }).id;

  const asStranger = await exec('mutation($id: ID!, $b: String!){ addTicketMessage(ticketId: $id, body: $b) { id } }', {
    as: f.stranger,
    variables: { id: ticketId, b: 'سلام' },
  });
  assert.equal(asStranger.code, 'NOT_FOUND', 'house rule 13 — indistinguishable from a ticket that does not exist');

  const asOwner = ok(
    await exec('mutation($id: ID!, $b: String!){ addTicketMessage(ticketId: $id, body: $b) { messages { body } } }', {
      as: f.customer,
      variables: { id: ticketId, b: 'یک پیام دیگر' },
    }),
  );
  assert.equal((asOwner.addTicketMessage as { messages: unknown[] }).messages.length, 2);

  const asStaff = ok(
    await exec('mutation($id: ID!, $b: String!){ addTicketMessage(ticketId: $id, body: $b) { messages { body } } }', {
      as: f.admin,
      variables: { id: ticketId, b: 'پاسخِ ریشه' },
    }),
  );
  assert.equal((asStaff.addTicketMessage as { messages: unknown[] }).messages.length, 3);
});

// --- The database itself refuses a half-written brief -----------------------

test('the database itself refuses a brief with only some of its five columns set (Ticket_brief_all_or_none), bypassing the resolver', async () => {
  await assert.rejects(
    prisma.ticket.create({
      data: {
        customerId: f.customer.id,
        type: 'CHANGE_REQUEST',
        subject: 'ناقص',
        briefPageFa: 'یک صفحه',
        // briefPageEn, briefAnnotation, briefCurrentState, briefDesiredState, briefLang all left null
      },
    }),
    /Ticket_brief_all_or_none/,
  );
});
