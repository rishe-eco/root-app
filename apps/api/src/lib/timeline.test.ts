import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIMELINE_KINDS, timelineFor, type TimelineInput } from './timeline.js';

/**
 * Journeys build plan J3, PD-17 — the history rail is derived from dated rows.
 * Every source below is a row that already exists for another reason; none of
 * it is a log.
 */

const d = (day: number, hour = 0) => new Date(Date.UTC(2026, 8, day, hour));

const empty = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  requestedAt: null,
  publishedAt: null,
  customerId: 'cust',
  approvals: [],
  contractRevisions: [],
  designRevisions: [],
  builds: [],
  ...over,
});

test('no rows, no history', () => {
  assert.deepEqual(timelineFor(empty()), []);
});

test('every source becomes one item, newest first, each naming the side that acted', () => {
  const items = timelineFor(
    empty({
      requestedAt: d(1),
      publishedAt: d(2),
      approvals: [
        { id: 'a1', step: 'AGREEMENT', phaseNumber: null, approvedAt: d(9), approvedById: 'cust' },
        { id: 'a2', step: 'DEMO', phaseNumber: 2, approvedAt: d(12), approvedById: 'staff' },
      ],
      contractRevisions: [{ id: 'r1', version: 1, publishedAt: d(3), approvedAt: d(7), signedAt: d(8) }],
      designRevisions: [{ id: 'dr1', version: 1, publishedAt: d(4) }],
      builds: [{ id: 'b1', number: 3, publishedAt: d(11) }],
    }),
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.by, i.step, i.phaseNumber, i.number]),
    [
      ['STEP_APPROVED', 'ROOT', 'DEMO', 2, null],
      ['BUILD_PUBLISHED', 'ROOT', null, null, 3],
      ['STEP_APPROVED', 'CUSTOMER', 'AGREEMENT', null, null],
      ['CONTRACT_SIGNED', 'CUSTOMER', null, null, 1],
      ['REVISION_APPROVED', 'CUSTOMER', null, null, 1],
      ['DESIGN_PUBLISHED', 'ROOT', null, null, 1],
      ['REVISION_PUBLISHED', 'ROOT', null, null, 1],
      ['CONTRACT_HANDED_OVER', 'ROOT', null, null, null],
      ['REQUEST_SUBMITTED', 'CUSTOMER', null, null, null],
    ],
  );
});

test('J9b: a published mockup iteration is one item naming its ordinal, apart from the site builds', () => {
  const items = timelineFor(
    empty({
      builds: [{ id: 'b1', number: 1, publishedAt: d(11) }],
      mockupBuilds: [
        { id: 'm1', iteration: 1, publishedAt: d(5) },
        { id: 'm2', iteration: 2, publishedAt: d(8) },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.step, i.number]),
    [
      ['BUILD_PUBLISHED', null, 1],
      ['MOCKUP_PUBLISHED', 'MOCKUP', 2],
      ['MOCKUP_PUBLISHED', 'MOCKUP', 1],
    ],
  );
});

test('an unapproved, unsigned revision is just published', () => {
  const items = timelineFor(
    empty({ contractRevisions: [{ id: 'r1', version: 2, publishedAt: d(3), approvedAt: null, signedAt: null }] }),
  );
  assert.deepEqual(items.map((i) => i.kind), ['REVISION_PUBLISHED']);
});

test('ties are ordered by kind and then id, so the same rows always read the same way', () => {
  const at = d(5);
  const a = timelineFor(
    empty({
      contractRevisions: [
        { id: 'rb', version: 2, publishedAt: at, approvedAt: null, signedAt: null },
        { id: 'ra', version: 1, publishedAt: at, approvedAt: null, signedAt: null },
      ],
      builds: [{ id: 'b', number: 1, publishedAt: at }],
    }),
  );
  const b = timelineFor(
    empty({
      builds: [{ id: 'b', number: 1, publishedAt: at }],
      contractRevisions: [
        { id: 'ra', version: 1, publishedAt: at, approvedAt: null, signedAt: null },
        { id: 'rb', version: 2, publishedAt: at, approvedAt: null, signedAt: null },
      ],
    }),
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((i) => i.id), ['revision-ra', 'revision-rb', 'build-b']);
});

test('the request row is the resolver’s to withhold: null in, no item out', () => {
  assert.equal(timelineFor(empty({ requestedAt: null, publishedAt: d(1) })).some((i) => i.kind === 'REQUEST_SUBMITTED'), false);
});

test('every kind has a sentence in both locale files, and the SDL enum lists exactly the kinds', () => {
  for (const lang of ['fa', 'en']) {
    const messages = JSON.parse(
      readFileSync(new URL(`../../../web/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'),
    ) as { timeline?: Record<string, unknown> };
    for (const kind of TIMELINE_KINDS) {
      assert.equal(typeof messages.timeline?.[kind], 'string', `${lang}: timeline.${kind}`);
    }
  }
  const sdl = readFileSync(new URL('../graphql/typeDefs.ts', import.meta.url), 'utf8');
  const block = /enum TimelineKind \{([^}]*)\}/.exec(sdl)?.[1] ?? '';
  assert.deepEqual(block.split(/\s+/).filter(Boolean), [...TIMELINE_KINDS]);
});

test('J7: one act, one line — a revision approved at the very instant of the agreement’s approval is not listed twice; a different instant is', () => {
  const at = d(9, 10);
  const same = timelineFor(
    empty({
      approvals: [{ id: 'a1', step: 'AGREEMENT', phaseNumber: null, approvedAt: at, approvedById: 'cust' }],
      contractRevisions: [{ id: 'r1', version: 1, publishedAt: d(3), approvedAt: at, signedAt: d(10) }],
    }),
  );
  assert.deepEqual(same.map((i) => i.kind), ['CONTRACT_SIGNED', 'STEP_APPROVED', 'REVISION_PUBLISHED']);
  // The legacy road writes no such row, and its approval line is unchanged.
  const legacy = timelineFor(empty({ contractRevisions: [{ id: 'r1', version: 1, publishedAt: d(3), approvedAt: at, signedAt: null }] }));
  assert.deepEqual(legacy.map((i) => i.kind), ['REVISION_APPROVED', 'REVISION_PUBLISHED']);
  // An earlier v1 approval and a later agreement approval are two events.
  const two = timelineFor(
    empty({
      approvals: [{ id: 'a1', step: 'AGREEMENT', phaseNumber: null, approvedAt: d(9, 10), approvedById: 'cust' }],
      contractRevisions: [{ id: 'r1', version: 1, publishedAt: d(3), approvedAt: d(8), signedAt: null }],
    }),
  );
  assert.ok(two.some((i) => i.kind === 'REVISION_APPROVED'));
});
