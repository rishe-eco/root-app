import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryForward, diffDesign, type ConceptShape } from './design.js';

const APPROVED = new Date('2026-07-30T10:00:00Z');
const CHOSEN = new Date('2026-07-29T10:00:00Z');

const page = (key: string, imageUrl: string | null, approvedAt: Date | null = null) => ({
  key,
  imageUrl,
  approvedAt,
});

const revision = (pages: ReturnType<typeof page>[], chosen = true): ConceptShape[] => [
  { key: '1a', chosenAt: chosen ? CHOSEN : null, pages },
];

test('an untouched page keeps its approval', () => {
  const before = revision([page('home', '/a.png', APPROVED)]);
  const after = revision([page('home', '/a.png')]);
  const { approvals } = carryForward(before, after);
  assert.deepEqual(approvals, [{ conceptKey: '1a', pageKey: 'home', approvedAt: APPROVED }]);
});

test('a page whose image moved has to be re-approved', () => {
  const before = revision([page('home', '/a.png', APPROVED)]);
  const after = revision([page('home', '/b.png')]);
  assert.deepEqual(carryForward(before, after).approvals, []);
});

test('a new page is not approved by inheritance', () => {
  const before = revision([page('home', '/a.png', APPROVED)]);
  const after = revision([page('home', '/a.png'), page('about', '/c.png')]);
  const keys = carryForward(before, after).approvals.map((a) => a.pageKey);
  assert.deepEqual(keys, ['home']);
});

test('a one-page tweak asks for exactly one re-approval, not four', () => {
  const before = revision([
    page('home', '/1.png', APPROVED),
    page('about', '/2.png', APPROVED),
    page('contracts', '/3.png', APPROVED),
    page('portal', '/4.png', APPROVED),
  ]);
  const after = revision([
    page('home', '/1.png'),
    page('about', '/2-v2.png'),
    page('contracts', '/3.png'),
    page('portal', '/4.png'),
  ]);
  assert.equal(carryForward(before, after).approvals.length, 3);
});

test('an unapproved page does not become approved by carrying forward', () => {
  const before = revision([page('home', '/a.png', null)]);
  const after = revision([page('home', '/a.png')]);
  assert.deepEqual(carryForward(before, after).approvals, []);
});

test('the chosen concept carries forward when it still exists', () => {
  const before = revision([page('home', '/a.png', APPROVED)]);
  const after = revision([page('home', '/a.png')]);
  assert.equal(carryForward(before, after).chosenConceptKey, '1a');
});

test('the choice does not carry forward when that concept is gone', () => {
  const before = revision([page('home', '/a.png', APPROVED)]);
  const after: ConceptShape[] = [{ key: '1b', chosenAt: null, pages: [page('home', '/z.png')] }];
  assert.equal(carryForward(before, after).chosenConceptKey, null);
});

test('nothing carries forward from a revision with no prior', () => {
  const { approvals, chosenConceptKey } = carryForward([], revision([page('home', '/a.png')]));
  assert.deepEqual(approvals, []);
  assert.equal(chosenConceptKey, null);
});

test('the diff agrees with carry-forward about what changed', () => {
  const before = revision([page('home', '/1.png', APPROVED), page('about', '/2.png', APPROVED)]);
  const after = revision([page('home', '/1.png'), page('about', '/2-v2.png')]);

  const changed = diffDesign(before, after)
    .filter((c) => c.kind !== 'unchanged')
    .map((c) => c.pageKey);
  const carried = carryForward(before, after).approvals.map((a) => a.pageKey);

  assert.deepEqual(changed, ['about']);
  assert.deepEqual(carried, ['home']);
});

test('the diff reports added and removed pages', () => {
  const before = revision([page('home', '/1.png'), page('gone', '/x.png')]);
  const after = revision([page('home', '/1.png'), page('new', '/y.png')]);
  const byKind = Object.fromEntries(diffDesign(before, after).map((c) => [c.pageKey, c.kind]));
  assert.deepEqual(byKind, { home: 'unchanged', new: 'added', gone: 'removed' });
});
