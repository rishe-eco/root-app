import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * L3b: builds and the resolution ledger (build plan §3 "L3b"; spec §6's
 * gap) — the four rules that make it honest (L3b.2): two fields for
 * "addressed" vs "accepted," no silent fate, declined-requires-reason held
 * by a CHECK, and monotonic project-wide numbering. Also the third source
 * (an unprompted build change) reaching a later review frame.
 *
 * **Changed by S2 (each expectation is listed in the stage's hand-off, and
 * none was changed silently):** the fixture submits through the generalized `submitFeedback` and
 * no longer ratifies; "accepted" is the customer's step approval, not
 * `acceptFeedback`; D3's "an unratified item can only be carried forward"
 * (NOT_RATIFIED) is gone with ratification; the open queue's items are `OPEN`,
 * not `RATIFIED`.
 */

let f: Fixture;
let developer: Awaited<ReturnType<typeof createDeveloper>>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  developer = await createDeveloper();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

/** A DEVELOPER account (build plan D6) — not seeded by `seedFixture`
 *  itself, since most suites never need one. Assigned as the fixture
 *  contract's developer: since journeys build plan S1 the builds queue and
 *  every build mutation are the *assigned* developer's (`s1.test.ts` covers
 *  the unassigned refusal). */
async function createDeveloper() {
  return prisma.user.create({
    data: {
      email: 'developer@test.local',
      name: 'Developer',
      roles: ['DEVELOPER'],
      state: 'ACTIVE',
      developedContracts: { connect: { id: f.contract.id } },
    },
  });
}

/** S2 (PD-2): the submission *is* the ratification, so what L3b's fixture
 *  called "ratified feedback" is simply an open item now. */
const SUBMIT_ON_PAGE = `
  mutation($c: ID!, $ph: ID!, $d: ID!, $p: ID!, $b: String!) {
    submitFeedback(contractId: $c, step: DEMO, phaseId: $ph, target: { demoId: $d, demoPageId: $p }, body: $b) {
      item { id status }
    }
  }
`;

/** A phase, a published demo with a frame, and one open feedback item on a
 *  declared page — the minimum declareBuild has something to disposition. */
async function seedOpenFeedback() {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://staging.example.com' } });
  const page = await prisma.demoPage.create({
    data: { demoId: demo.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' },
  });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const submitted = ok(
    await exec(SUBMIT_ON_PAGE, {
      as: f.customer,
      variables: { c: f.contract.id, ph: phase.id, d: demo.id, p: page.id, b: 'رنگِ دکمه اشتباه است' },
    }),
  );
  const itemId = (submitted.submitFeedback as { item: { id: string } }).item.id;
  return { projectId, phase, demo, page, itemId };
}

const DECLARE_BUILD = `
  mutation($phaseId: ID!, $ref: String, $changes: [BuildChangeInput!]!) {
    declareBuild(phaseId: $phaseId, ref: $ref, changes: $changes) {
      id number ref publishedAt
      changes { id outcome note noteLang feedbackItem { id status } scopeItem { id status } }
    }
  }
`;

// --- L3b.2 rule 1: two fields, never one ------------------------------------

test('declareBuild marking an item ADDRESSED does not make it ACCEPTED; the customer’s approval of the step is the second, separate write', async () => {
  const { phase, itemId } = await seedOpenFeedback();

  const declared = ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, ref: 'abc123', changes: [{ feedbackItemId: itemId, outcome: 'ADDRESSED', note: 'fixed the button colour', noteLang: 'en' }] },
    }),
  );
  const build = declared.declareBuild as { id: string; number: number };
  assert.equal(build.number, 1, 'a project\'s first build is number 1 — Latin, project-wide');

  const afterDeclare = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
  assert.equal(afterDeclare.status, 'ADDRESSED', 'the developer\'s claim moves the item to ADDRESSED');
  assert.equal(afterDeclare.addressedInBuildId, build.id);
  assert.equal(afterDeclare.acceptedAt, null, 'ADDRESSED must never imply ACCEPTED — that is a second, separate write');

  // The customer's own acceptance — a different mutation, a different actor,
  // and it accepts the step (S2), not the item: `acceptFeedback` is retired.
  ok(
    await exec('mutation($c: ID!, $p: ID!){ approveStep(contractId: $c, step: DEMO, phaseId: $p) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, p: phase.id },
    }),
  );
  const accepted = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
  assert.equal(accepted.status, 'ACCEPTED');
  assert.ok(accepted.acceptedAt);
  assert.equal(accepted.acceptedById, f.customer.id);
});

test('the step cannot be approved while the item is still open — a build that has not addressed it accepts nothing', async () => {
  const { phase } = await seedOpenFeedback();
  const result = await exec('mutation($c: ID!, $p: ID!){ approveStep(contractId: $c, step: DEMO, phaseId: $p) { id } }', {
    as: f.customer,
    variables: { c: f.contract.id, p: phase.id },
  });
  assert.equal(result.code, 'STEP_HAS_OPEN_FEEDBACK');
});

test('a new comment on an ADDRESSED item reopens it to OPEN, clearing the stale build pointer', async () => {
  const { phase, demo, page, itemId } = await seedOpenFeedback();
  ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'ADDRESSED', note: 'shipped', noteLang: 'en' }] },
    }),
  );

  ok(
    await exec(SUBMIT_ON_PAGE, {
      as: f.customer,
      variables: { c: f.contract.id, ph: phase.id, d: demo.id, p: page.id, b: 'هنوز درست نیست' },
    }),
  );

  const reopened = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
  assert.equal(reopened.status, 'OPEN', 'a comment against an ADDRESSED item is the customer reopening it');
  assert.equal(reopened.addressedInBuildId, null, 'the stale claim must not survive the reopening');
});

// --- L3b.2 rule 2: a fate must never be silent ------------------------------

test('declareBuild refuses (MISSING_DISPOSITION) when an open feedback item has no disposition', async () => {
  const { phase } = await seedOpenFeedback();
  const result = await exec(DECLARE_BUILD, { as: developer, variables: { phaseId: phase.id, changes: [] } });
  assert.equal(result.code, 'MISSING_DISPOSITION');
});

test('declareBuild succeeds with an honestly empty change list when nothing is open', async () => {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const declared = ok(await exec(DECLARE_BUILD, { as: developer, variables: { phaseId: phase.id, changes: [] } }));
  assert.equal((declared.declareBuild as { number: number }).number, 1);
});

test('an OPEN item takes any disposition — there is no ratification gate left (PD-2) — and a carried-forward one stays open', async () => {
  const { phase, itemId } = await seedOpenFeedback();

  // L3b: "a merely-OPEN item can only be carried forward" (NOT_RATIFIED). A
  // submission is its own ratification now, so the developer may address it.
  const carried = ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'CARRIED_FORWARD' }] },
    }),
  );
  assert.ok(carried.declareBuild);
  const stillOpen = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
  assert.equal(stillOpen.status, 'OPEN', 'carrying forward changes nothing about the item\'s own status');

  ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'ADDRESSED', note: 'x', noteLang: 'en' }] },
    }),
  );
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } })).status, 'ADDRESSED');
});

test('a disposition is the developer’s answer: a direct comment carrying the resolution, visible to the customer', async () => {
  const { phase, itemId } = await seedOpenFeedback();
  ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'DECLINED', note: 'already decided', noteLang: 'en' }] },
    }),
  );
  const answer = await prisma.feedbackComment.findFirstOrThrow({ where: { feedbackItemId: itemId, authorId: developer.id } });
  assert.equal(answer.resolution, 'DECLINED');
  assert.equal(answer.approval, 'NOT_REQUIRED', 'answers.direct.demo — no approval');
  assert.equal(answer.body, 'already decided');

  const seen = ok(
    await exec('query($c: ID!){ contract(id: $c) { feedbackItems(step: DEMO) { id status comments { body resolution approval } } } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  );
  const items = (seen.contract as { feedbackItems: Array<{ status: string; comments: Array<{ body: string; resolution: string | null }> }> }).feedbackItems;
  assert.equal(items[0].status, 'DECLINED');
  assert.ok(items[0].comments.some((c) => c.resolution === 'DECLINED' && c.body === 'already decided'));
});

// --- L3b.2 rule 3: declined requires its reason, structurally ---------------

test('declareBuild refuses (DECLINE_REASON_REQUIRED) at the API layer when a decline has no note', async () => {
  const { phase, itemId } = await seedOpenFeedback();
  const result = await exec(DECLARE_BUILD, {
    as: developer,
    variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'DECLINED' }] },
  });
  assert.equal(result.code, 'DECLINE_REASON_REQUIRED');
});

test('the database itself refuses a DECLINED entry with a null reason — the CHECK, not only the resolver', async () => {
  const { phase, itemId } = await seedOpenFeedback();
  const build = await prisma.build.create({
    data: { phaseId: phase.id, projectId: f.contract.projectId, number: 1, declaredById: developer.id },
  });
  await assert.rejects(
    () =>
      prisma.buildChangeEntry.create({
        data: { buildId: build.id, feedbackItemId: itemId, outcome: 'DECLINED', note: null },
      }),
    /BuildChangeEntry_declined_requires_note/,
    'BuildChangeEntry_declined_requires_note must fire even bypassing the resolver entirely',
  );
});

test('the database refuses a no-origin entry with no note — "the note is the entry"', async () => {
  const { phase } = await seedOpenFeedback();
  const build = await prisma.build.create({
    data: { phaseId: phase.id, projectId: f.contract.projectId, number: 1, declaredById: developer.id },
  });
  await assert.rejects(
    () => prisma.buildChangeEntry.create({ data: { buildId: build.id } }),
    /BuildChangeEntry_no_origin_requires_note/,
  );
});

test('the database refuses an entry naming both a feedback item and a scope item', async () => {
  const { phase, itemId } = await seedOpenFeedback();
  const scopeItem = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'x', kind: 'FEATURE', labelFa: 'ایکس', labelEn: 'X', status: 'IN_BUILD', phaseId: phase.id },
  });
  const build = await prisma.build.create({
    data: { phaseId: phase.id, projectId: f.contract.projectId, number: 1, declaredById: developer.id },
  });
  await assert.rejects(
    () =>
      prisma.buildChangeEntry.create({
        data: { buildId: build.id, feedbackItemId: itemId, scopeItemId: scopeItem.id, outcome: 'CARRIED_FORWARD' },
      }),
    /BuildChangeEntry_at_most_one_origin/,
  );
});

// --- L3b.2 rule 4: publishing a build notifies ------------------------------

test('publishBuild sets publishedAt and refuses a second time (ALREADY_PUBLISHED)', async () => {
  // A project with nothing open at all, so declareBuild's own disposition
  // requirement is satisfied trivially — this test is about publish, not intake.
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const declared = ok(await exec(DECLARE_BUILD, { as: developer, variables: { phaseId: phase.id, changes: [] } }));
  const buildId = (declared.declareBuild as { id: string }).id;

  const published = ok(await exec('mutation($id: ID!){ publishBuild(buildId: $id) { id publishedAt } }', { as: developer, variables: { id: buildId } }));
  assert.ok((published.publishBuild as { publishedAt: string }).publishedAt);

  const second = await exec('mutation($id: ID!){ publishBuild(buildId: $id) { id } }', { as: developer, variables: { id: buildId } });
  assert.equal(second.code, 'ALREADY_PUBLISHED');
});

// --- monotonic, project-wide numbering (L3b.3) ------------------------------

test('build numbers are project-wide and monotonic, never reset per phase', async () => {
  const { phase, itemId } = await seedOpenFeedback();
  const projectId = f.contract.projectId;
  const secondPhase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 2, titleFa: 'فاز ۲', titleEn: 'Phase 2' } });

  // ADDRESSED, not CARRIED_FORWARD — carrying forward deliberately leaves
  // the item open (L3b.2's second rule: nothing changed, so nothing about
  // its status should say otherwise), which would still owe the *next*
  // declareBuild call a disposition and defeat this test's own point.
  const first = ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ feedbackItemId: itemId, outcome: 'ADDRESSED', note: 'fixed', noteLang: 'en' }] },
    }),
  );
  assert.equal((first.declareBuild as { number: number }).number, 1);

  // A second build declared against a *different phase of the same project*
  // must be number 2, not 1 again — a per-phase counter would make "version
  // 2" ambiguous, which is exactly the trap build plan L3b.3 names.
  const second = ok(await exec(DECLARE_BUILD, { as: developer, variables: { phaseId: secondPhase.id, changes: [] } }));
  assert.equal((second.declareBuild as { number: number }).number, 2);
});

// --- scope-item origin: "this was on the plan" ------------------------------

test('a scope-item-origin change entry moves the item to IN_DEMO', async () => {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const scopeItem = await prisma.scopeItem.create({
    data: { projectId, key: 'checkout', kind: 'FEATURE', labelFa: 'پرداخت', labelEn: 'Checkout', status: 'IN_BUILD', phaseId: phase.id },
  });

  const declared = ok(
    await exec(DECLARE_BUILD, { as: developer, variables: { phaseId: phase.id, changes: [{ scopeItemId: scopeItem.id }] } }),
  );
  assert.ok(declared.declareBuild);

  const after = await prisma.scopeItem.findUniqueOrThrow({ where: { id: scopeItem.id } });
  assert.equal(after.status, 'IN_DEMO');
});

// --- the third source: an unprompted change --------------------------------

test('an unprompted (no-origin) change entry surfaces on the next demo\'s frame as unpromptedChanges, and addDemoFrameLine writes it up', async () => {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });

  const declared = ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ note: 'swapped the SMS provider', noteLang: 'en' }] },
    }),
  );
  const entryId = (declared.declareBuild as { changes: Array<{ id: string }> }).changes[0].id;

  const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://staging.example.com' } });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const UNPROMPTED_QUERY = `
    query($id: ID!) {
      contract(id: $id) {
        project {
          phases {
            demos { id frame { id unpromptedChanges { id note noteLang } } }
          }
        }
      }
    }
  `;
  const before = ok(await exec(UNPROMPTED_QUERY, { as: f.admin, variables: { id: f.contract.id } }));
  type Q = { project: { phases: Array<{ demos: Array<{ id: string; frame: { unpromptedChanges: Array<{ id: string }> } | null }> }> } };
  const demoRow = (before.contract as Q).project.phases.flatMap((p) => p.demos).find((d) => d.id === demo.id)!;
  assert.equal(demoRow.frame!.unpromptedChanges.length, 1);
  assert.equal(demoRow.frame!.unpromptedChanges[0].id, entryId);

  ok(
    await exec(
      'mutation($d: ID!, $e: ID!){ addDemoFrameLine(demoId: $d, kind: NEW, textFa: "تعویض سرویس پیامک", textEn: "Swapped the SMS provider", buildChangeEntryId: $e) { id } }',
      { as: f.admin, variables: { d: demo.id, e: entryId } },
    ),
  );

  const after = ok(await exec(UNPROMPTED_QUERY, { as: f.admin, variables: { id: f.contract.id } }));
  const demoAfter = (after.contract as Q).project.phases.flatMap((p) => p.demos).find((d) => d.id === demo.id)!;
  assert.equal(demoAfter.frame!.unpromptedChanges.length, 0, 'written up — no longer "not yet mentioned"');
});

test('unpromptedChanges is empty for a customer — staff-only, and empty is not a claim that nothing changed', async () => {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  ok(
    await exec(DECLARE_BUILD, {
      as: developer,
      variables: { phaseId: phase.id, changes: [{ note: 'internal refactor', noteLang: 'en' }] },
    }),
  );
  const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://staging.example.com' } });
  ok(await exec('mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));
  ok(await exec('mutation($d: ID!){ publishDemo(demoId: $d) { id } }', { as: f.admin, variables: { d: demo.id } }));

  const QUERY = `
    query($id: ID!) {
      contract(id: $id) {
        project { phases { demos { id frame { unpromptedChanges { id } } } } }
      }
    }
  `;
  const asCustomer = ok(await exec(QUERY, { as: f.customer, variables: { id: f.contract.id } }));
  type Q = { project: { phases: Array<{ demos: Array<{ frame: { unpromptedChanges: unknown[] } | null }> }> } };
  const demoRow = (asCustomer.contract as Q).project.phases.flatMap((p) => p.demos)[0];
  assert.deepEqual(demoRow.frame!.unpromptedChanges, []);
});

// --- capability boundary: builds.author, never contracts.manage ------------

test('a plain customer cannot call any builds.author-gated mutation or query', async () => {
  const { phase } = await seedOpenFeedback();
  const declareResult = await exec(DECLARE_BUILD, { as: f.customer, variables: { phaseId: phase.id, changes: [] } });
  assert.equal(declareResult.code, 'FORBIDDEN');

  const queueResult = await exec('query($p: ID!){ openFeedbackQueue(projectId: $p) { id } }', {
    as: f.customer,
    variables: { p: f.contract.projectId },
  });
  assert.equal(queueResult.code, 'FORBIDDEN');
});

test('a DEVELOPER (no contract verb, no money) can declare and publish builds, and reach the open queue', async () => {
  const { itemId, phase } = await seedOpenFeedback();
  const queue = ok(
    await exec('query($p: ID!){ openFeedbackQueue(projectId: $p) { id status } }', {
      as: developer,
      variables: { p: f.contract.projectId },
    }),
  );
  const items = queue.openFeedbackQueue as Array<{ id: string; status: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, itemId);
  assert.equal(items[0].status, 'OPEN');

  const phases = ok(await exec('query{ phasesForBuilds { id projectId } }', { as: developer }));
  assert.ok((phases.phasesForBuilds as Array<{ id: string }>).some((p) => p.id === phase.id));
});
