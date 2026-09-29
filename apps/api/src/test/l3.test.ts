import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * L3: review frames and feedback intake (build plan §3 "L3"; spec §6) — the
 * publish-without-frame refusal, duplicate collapse (D4), the interception
 * trigger (D4), and the ratification path (D3). The first stage in this
 * series with a real database from the start, so this is the first place
 * these four mechanisms are checked against real Postgres constraints
 * rather than only argued in comments.
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

/** A phase, a draft demo, one declared page, and one scope item on that
 *  phase — the minimum a frame can be generated from. Direct Prisma, not
 *  GraphQL: arranging fixture state through the same door `seedFixture`
 *  itself uses, so what is under test stays the L3 mutations alone. */
async function seedDemo(opts: { temporary?: boolean; decided?: boolean } = {}) {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({
    data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' },
  });
  const demo = await prisma.demo.create({
    data: { phaseId: phase.id, stagingUrl: 'https://staging.example.com' },
  });
  const page = await prisma.demoPage.create({
    data: { demoId: demo.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' },
  });
  const scopeItem = await prisma.scopeItem.create({
    data: {
      projectId,
      key: 'sms-auth',
      kind: 'FEATURE',
      labelFa: 'ورود بدون پیامک',
      labelEn: 'SMS-less auth',
      status: 'IN_DEMO',
      phaseId: phase.id,
      temporary: opts.temporary ?? false,
      decidedAt: opts.decided ? new Date('2026-01-01T00:00:00Z') : null,
      decidedNote: opts.decided ? 'Decided on a call, 2026-01-01' : null,
    },
  });
  return { phase, demo, page, scopeItem };
}

const FRAME_QUERY = `
  query($id: ID!) {
    contract(id: $id) {
      project {
        phases {
          demos {
            id
            publishedAt
            frame { id lines { id kind textFa textEn scopeItem { id } } }
          }
        }
      }
    }
  }
`;

type FrameQueryResult = {
  project: {
    phases: Array<{
      demos: Array<{
        id: string;
        publishedAt: string | null;
        frame: { id: string; lines: Array<{ id: string; kind: string; scopeItem: { id: string } | null }> } | null;
      }>;
    }>;
  };
};

async function fetchDemo(as: Fixture['admin'], demoId: string) {
  const data = ok(await exec(FRAME_QUERY, { as, variables: { id: f.contract.id } }));
  const contract = data.contract as FrameQueryResult;
  const demo = contract.project.phases.flatMap((p) => p.demos).find((d) => d.id === demoId);
  if (!demo) throw new Error('demo not found in query result');
  return demo;
}

// --- the publish-without-frame refusal ----------------------------------

test('publishDemo refuses without a frame (NO_FRAME), and succeeds once one exists', async () => {
  const { demo } = await seedDemo();

  const refused = await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', {
    as: f.admin,
    variables: { d: demo.id },
  });
  assert.equal(refused.code, 'NO_FRAME');

  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const after = await fetchDemo(f.admin, demo.id);
  assert.ok(after.publishedAt, 'publishedAt should be set once the frame exists and publishDemo succeeds');
});

test('a customer cannot see a draft demo, only a published one', async () => {
  const { demo } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const beforePublish = ok(await exec(FRAME_QUERY, { as: f.customer, variables: { id: f.contract.id } }));
  const draftVisible = (beforePublish.contract as FrameQueryResult).project.phases.flatMap((p) => p.demos);
  assert.equal(draftVisible.length, 0, 'a draft demo must not reach the customer query at all');

  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const afterPublish = ok(await exec(FRAME_QUERY, { as: f.customer, variables: { id: f.contract.id } }));
  const published = (afterPublish.contract as FrameQueryResult).project.phases.flatMap((p) => p.demos);
  assert.equal(published.length, 1);
  assert.equal(published[0].id, demo.id);
});

test('publishDemo is refused a second time (ALREADY_PUBLISHED)', async () => {
  const { demo } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  const second = await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } });
  assert.equal(second.code, 'ALREADY_PUBLISHED');
});

// --- generation from the registry ----------------------------------------

test('generateDemoFrame derives NEW from an IN_DEMO item on this phase, and is additive on a second call', async () => {
  const { demo, scopeItem } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const once = await fetchDemo(f.admin, demo.id);
  const newLines = once.frame!.lines.filter((l) => l.kind === 'NEW');
  assert.equal(newLines.length, 1);
  assert.equal(newLines[0].scopeItem?.id, scopeItem.id);

  // A hand-authored line survives a second generation call untouched, and no
  // second NEW line is created for the same (scope item, bucket) pair.
  ok(
    await exec(
      'mutation($d: ID!){ addDemoFrameLine(demoId: $d, kind: NEW, textFa: "خط دستی", textEn: "hand line") { id } }',
      { as: f.admin, variables: { d: demo.id } },
    ),
  );
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const twice = await fetchDemo(f.admin, demo.id);
  assert.equal(twice.frame!.lines.filter((l) => l.kind === 'NEW').length, 2, 'one generated + one hand-authored');
});

// --- duplicate collapse (D4) ---------------------------------------------

test('two submissions against the same page collapse into one feedback item (D4)', async () => {
  const { demo, page, phase } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const SUBMIT = `
    mutation($c: ID!, $ph: ID!, $d: ID!, $p: ID!, $b: String!) {
      submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, demoPageId: $p }, body: $b) {
        item { id comments { body } }
        intercepted
      }
    }
  `;
  const vars = (b: string) => ({ c: f.contract.id, ph: phase.id, d: demo.id, p: page.id, b });

  const first = ok(await exec(SUBMIT, { as: f.customer, variables: vars('رنگِ دکمه اشتباه است') }));
  const firstItem = (first.submitFeedback as { item: { id: string; comments: Array<{ body: string }> } }).item;
  assert.equal(firstItem.comments.length, 1);

  const second = ok(await exec(SUBMIT, { as: f.customer, variables: vars('دکمه هنوز اشتباه است') }));
  const secondItem = (second.submitFeedback as { item: { id: string; comments: Array<{ body: string }> } }).item;

  assert.equal(secondItem.id, firstItem.id, 'a second submission against the same page must collapse onto the same item');
  assert.equal(secondItem.comments.length, 2, 'the second submission appends a comment rather than nothing');

  const rows = await prisma.feedbackItem.count({ where: { demoPageId: page.id } });
  assert.equal(rows, 1, 'exactly one FeedbackItem row exists for this page — the unique index is what actually holds this');
});

// --- interception (D4) ---------------------------------------------------

test('a comment on a decided scope item is intercepted, writes nothing, and proceeds only with confirmReopen', async () => {
  const { demo, phase } = await seedDemo({ decided: true });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const withFrame = await fetchDemo(f.admin, demo.id);
  const decidedLine = withFrame.frame!.lines.find((l) => l.kind === 'DECIDED');
  assert.ok(decidedLine, 'generateDemoFrame should have produced a DECIDED line for a decided item');

  const SUBMIT = `
    mutation($c: ID!, $ph: ID!, $d: ID!, $l: ID!, $b: String!, $confirm: Boolean) {
      submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, frameLineId: $l }, body: $b, confirmReopen: $confirm) {
        item { id reopenedScopeItem { id } }
        intercepted
        interceptionReason
        interceptionScopeItem { id }
      }
    }
  `;

  const firstTry = ok(
    await exec(SUBMIT, {
      as: f.customer,
      variables: { c: f.contract.id, ph: phase.id, d: demo.id, l: decidedLine!.id, b: 'مگر این تصمیم گرفته نشده بود؟' },
    }),
  );
  const firstResult = firstTry.submitFeedback as {
    item: unknown;
    intercepted: boolean;
    interceptionReason: string;
    interceptionScopeItem: { id: string };
  };
  assert.equal(firstResult.item, null, 'interception must write nothing on the first, unconfirmed attempt');
  assert.equal(firstResult.intercepted, true);
  assert.equal(firstResult.interceptionReason, 'DECIDED');
  assert.equal(firstResult.interceptionScopeItem.id, decidedLine!.scopeItem!.id);

  const stillNone = await prisma.feedbackItem.count({ where: { frameLineId: decidedLine!.id } });
  assert.equal(stillNone, 0, 'no row should exist after the intercepted, unconfirmed attempt');

  const confirmed = ok(
    await exec(SUBMIT, {
      as: f.customer,
      variables: { c: f.contract.id, ph: phase.id, d: demo.id, l: decidedLine!.id, b: 'می‌خواهم رسماً بازش کنم', confirm: true },
    }),
  );
  const confirmedResult = confirmed.submitFeedback as { item: { id: string; reopenedScopeItem: { id: string } } };
  assert.ok(confirmedResult.item, 'confirmReopen: true must proceed and create the item');
  assert.equal(confirmedResult.item.reopenedScopeItem.id, decidedLine!.scopeItem!.id);
});

test('a comment on an ordinary (non-decided, non-temporary) line is never intercepted', async () => {
  const { demo, phase } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const withFrame = await fetchDemo(f.admin, demo.id);
  const newLine = withFrame.frame!.lines.find((l) => l.kind === 'NEW');

  const result = ok(
    await exec(
      'mutation($c: ID!, $ph: ID!, $d: ID!, $l: ID!, $b: String!){ submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, frameLineId: $l }, body: $b) { item { id } intercepted } }',
      { as: f.customer, variables: { c: f.contract.id, ph: phase.id, d: demo.id, l: newLine!.id, b: 'به نظرم خوب است' } },
    ),
  );
  const submitted = result.submitFeedback as { item: { id: string } | null; intercepted: boolean };
  assert.equal(submitted.intercepted, false);
  assert.ok(submitted.item, 'an unintercepted submission must create the item immediately');
});

// --- a submission is its own ratification (D3 → PD-2) ----------------------

test('a submission is its own ratification: the item is open and stamped at once, and ratifyFeedback is gone', async () => {
  // L3 tested "ratifyFeedback moves only the named OPEN items to RATIFIED, and
  // is idempotent about the rest". D3 made the customer the only account and
  // the decider, so S2 (PD-2) folded the act into the submission and retired
  // both the mutation and the status; what survives of the test is the record
  // of who decided, and that the second door is really shut.
  const { demo, page, phase } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const onPage = ok(
    await exec(
      'mutation($c: ID!, $ph: ID!, $d: ID!, $p: ID!, $b: String!){ submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, demoPageId: $p }, body: $b) { item { id status } } }',
      { as: f.customer, variables: { c: f.contract.id, ph: phase.id, d: demo.id, p: page.id, b: 'اول' } },
    ),
  );
  const submitted = (onPage.submitFeedback as { item: { id: string; status: string } }).item;
  assert.equal(submitted.status, 'OPEN');

  // D3: the decider is the project's own customer — an ownership edge, not a role.
  const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: submitted.id } });
  assert.equal(row.ratifiedById, f.customer.id);
  assert.ok(row.ratifiedAt, 'ratifiedAt is written at submit');

  for (const gone of [
    'mutation($d: ID!){ ratifyFeedback(demoId: $d, itemIds: []) { id } }',
    'mutation($i: ID!){ acceptFeedback(itemId: $i) { id } }',
  ]) {
    const result = await exec(gone, { as: f.customer, variables: gone.includes('$d') ? { d: demo.id } : { i: submitted.id } });
    assert.equal(result.code, 'GRAPHQL_VALIDATION_FAILED', 'the mutation no longer exists in the schema');
  }
});

test('a stranger cannot submit feedback on a project that is not theirs, and Root cannot submit as the customer (NOT_FOUND)', async () => {
  const { demo, page, phase } = await seedDemo();
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const SUBMIT =
    'mutation($c: ID!, $ph: ID!, $d: ID!, $p: ID!, $b: String!){ submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, demoPageId: $p }, body: $b) { intercepted } }';
  const variables = { c: f.contract.id, ph: phase.id, d: demo.id, p: page.id, b: 'نباید بتوانم' };

  assert.equal((await exec(SUBMIT, { as: f.stranger, variables })).code, 'NOT_FOUND');
  // L3 let staff submit (and skipped their own notification). Root answers; it
  // does not raise (S2) — a staff member who can see the contract gets the
  // same answer as a stranger.
  assert.equal((await exec(SUBMIT, { as: f.admin, variables })).code, 'NOT_FOUND');
});
