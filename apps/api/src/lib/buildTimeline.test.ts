import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineOf } from './buildTimeline.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

test('phases come in order, each with its published builds oldest first, the demo’s first publication and the acceptance', () => {
  const entries = buildTimelineOf(
    [
      { id: 'p2', number: 2, titleFa: 'ب', titleEn: 'Second', plannedEndAt: d('2026-12-01'), demoPublishedAts: [], builds: [] },
      {
        id: 'p1',
        number: 1,
        titleFa: 'الف',
        titleEn: 'First',
        plannedEndAt: null,
        demoPublishedAts: [d('2026-10-09'), d('2026-10-05')],
        builds: [
          { id: 'b4', number: 4, publishedAt: d('2026-10-12') },
          { id: 'b3', number: 3, publishedAt: d('2026-10-05') },
        ],
      },
    ],
    [{ phaseId: 'p1', approvedAt: d('2026-10-20') }, { phaseId: null, approvedAt: d('2026-09-01') }, { phaseId: 'other', approvedAt: d('2026-09-02') }],
  );
  assert.deepEqual(entries.map((e) => e.phaseId), ['p1', 'p2']);
  assert.deepEqual(entries[0].builds.map((b) => b.id), ['b3', 'b4']);
  assert.equal(entries[0].demoPublishedAt?.toISOString(), d('2026-10-05').toISOString(), 'the first time the customer saw it');
  assert.equal(entries[0].acceptedAt?.toISOString(), d('2026-10-20').toISOString());
  assert.equal(entries[1].demoPublishedAt, null);
  assert.equal(entries[1].acceptedAt, null, 'an approval of another phase, or of a step with no phase, is not this phase’s');
  assert.equal(entries[1].plannedEndAt?.toISOString(), d('2026-12-01').toISOString());
});

test('no phases is an empty timeline, not an error', () => {
  assert.deepEqual(buildTimelineOf([], []), []);
});

test('two builds published at the same instant keep their numbers in order', () => {
  const at = d('2026-10-05');
  const [entry] = buildTimelineOf(
    [{ id: 'p', number: 1, titleFa: '', titleEn: '', plannedEndAt: null, demoPublishedAts: [], builds: [{ id: 'b2', number: 2, publishedAt: at }, { id: 'b1', number: 1, publishedAt: at }] }],
    [],
  );
  assert.deepEqual(entry.builds.map((b) => b.number), [1, 2]);
});
