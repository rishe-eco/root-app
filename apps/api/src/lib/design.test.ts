import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  carryForward,
  designChanged,
  diffDesign,
  readThemeSnapshot,
  roundPublishedAnswer,
  snapshotTheme,
  themeConceptKey,
  type ConceptShape,
  type PaletteShape,
} from './design.js';

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

test('diffDesign never produces a kind outside the four known literals', () => {
  // The GraphQL layer maps these lower-case literals to PageChangeKind by an
  // exhaustive Record (fields.ts) — TypeScript catches a fifth literal there
  // at compile time, and this is the same invariant asserted from this side.
  const before = revision([page('home', '/1.png', APPROVED), page('gone', '/x.png')]);
  const after = revision([page('home', '/1.png'), page('new', '/y.png')]);
  const kinds = new Set(diffDesign(before, after).map((c) => c.kind));
  for (const k of kinds) {
    assert.ok(
      k === 'added' || k === 'changed' || k === 'removed' || k === 'unchanged',
      `unexpected kind: ${k}`,
    );
  }
});

// ---- the palette (journeys build plan J8) -----------------------------------------

const swatch = (role: string, value: string, over: Partial<PaletteShape> = {}): PaletteShape => ({
  kind: 'COLOR',
  role,
  value,
  labelFa: role,
  labelEn: role,
  imageFileId: null,
  ...over,
});

test('a palette-only edit is a change — a round that only moves a colour must still be publishable', () => {
  const concepts = revision([page('home', '/a.png', APPROVED)]);
  const before = { concepts, palette: [swatch('primary', '#112233')] };
  assert.equal(designChanged(before, { concepts, palette: [swatch('primary', '#112233')] }), false, 'nothing moved');
  assert.equal(designChanged(before, { concepts, palette: [swatch('primary', '#445566')] }), true, 'a colour moved');
  assert.equal(designChanged(before, { concepts, palette: [swatch('primary', '#112233'), swatch('accent', '#ffffff')] }), true, 'an item added');
  assert.equal(designChanged(before, { concepts, palette: [] }), true, 'an item removed');
  assert.equal(designChanged(before, { concepts, palette: [swatch('primary', '#112233', { labelEn: 'Brand blue' })] }), true, 'a label changed');
  assert.equal(designChanged(before, { concepts, palette: [swatch('primary', '#112233', { imageFileId: 'f1' })] }), true, 'a picture attached');
});

test('the same role under a different kind is a different item', () => {
  const concepts = revision([]);
  const before = { concepts, palette: [swatch('primary', '#112233')] };
  const after = { concepts, palette: [swatch('primary', 'Vazirmatn', { kind: 'FONT' })] };
  assert.equal(designChanged(before, after), true);
});

test('designChanged still says what diffDesign says about concepts and pages — and a new concept key is a change even with no pages', () => {
  const palette: PaletteShape[] = [];
  const a = revision([page('home', '/a.png')]);
  assert.equal(designChanged({ concepts: a, palette }, { concepts: revision([page('home', '/a.png')]), palette }), false);
  assert.equal(designChanged({ concepts: a, palette }, { concepts: revision([page('home', '/b.png')]), palette }), true);
  const themeRound = (...keys: string[]): ConceptShape[] => keys.map((key) => ({ key, chosenAt: null, pages: [] }));
  assert.equal(designChanged({ concepts: themeRound('theme-1'), palette }, { concepts: themeRound('theme-1'), palette }), false, 'the same themes again is nothing new');
  assert.equal(designChanged({ concepts: themeRound('theme-1'), palette }, { concepts: themeRound('theme-2'), palette }), true);
  assert.equal(designChanged({ concepts: themeRound('theme-1'), palette }, { concepts: themeRound('theme-1', 'theme-2'), palette }), true);
});

// ---- theme rounds (journeys build plan J8) ----------------------------------------

test('a theme snapshot holds name, vendor and demo URL — and nothing else, whatever it is handed', () => {
  const theme = {
    id: 't1',
    name: 'Astra',
    vendor: 'ThemeForest',
    demoUrl: 'https://astra.example/demo',
    licenseCost: 4_500_000n,
    notesFa: 'یادداشت داخلی',
    notesEn: 'internal note',
    previewFileId: 'f1',
    active: true,
  };
  const snapshot = snapshotTheme(theme);
  assert.deepEqual(snapshot, { name: 'Astra', vendor: 'ThemeForest', demoUrl: 'https://astra.example/demo' });
  assert.deepEqual(Object.keys(snapshot).sort(), ['demoUrl', 'name', 'vendor']);
  assert.ok(!JSON.stringify(snapshot).includes('4500000'), 'no licence cost');
  assert.ok(!JSON.stringify(snapshot).includes('internal'), 'no notes');
});

test('a stored snapshot reads back as the three known keys or nothing', () => {
  assert.deepEqual(readThemeSnapshot({ name: 'Astra', vendor: null, demoUrl: null }), { name: 'Astra', vendor: null, demoUrl: null });
  // Whatever else the JSON column happens to hold is dropped — a licence cost written by a bug never reaches a reader.
  assert.deepEqual(readThemeSnapshot({ name: 'Astra', vendor: 'V', demoUrl: 'https://x.example', licenseCost: '4500000' }), {
    name: 'Astra',
    vendor: 'V',
    demoUrl: 'https://x.example',
  });
  for (const bad of [null, undefined, 'x', 3, {}, { vendor: 'V' }, { name: 5 }]) assert.equal(readThemeSnapshot(bad), null, JSON.stringify(bad));
});

test('a theme’s concept key is stable and unique per theme, so a re-proposed theme is the same concept to carry-forward', () => {
  assert.equal(themeConceptKey('abc'), 'theme-abc');
  assert.notEqual(themeConceptKey('abc'), themeConceptKey('abd'));
  const round1: ConceptShape[] = [{ key: themeConceptKey('abc'), chosenAt: CHOSEN, pages: [] }];
  const round2: ConceptShape[] = [
    { key: themeConceptKey('abc'), chosenAt: null, pages: [] },
    { key: themeConceptKey('xyz'), chosenAt: null, pages: [] },
  ];
  assert.equal(carryForward(round1, round2).chosenConceptKey, 'theme-abc');
});

test('the answer that closes "show me other options" is in the customer’s language and names the round', () => {
  assert.match(roundPublishedAnswer('en', 2), /Round 2/);
  assert.match(roundPublishedAnswer('fa', 2), /دورِ ۲/);
  assert.notEqual(roundPublishedAnswer('en', 2), roundPublishedAnswer('fa', 2));
  assert.equal(roundPublishedAnswer(null, 3), roundPublishedAnswer('fa', 3), 'Persian is the default');
});
