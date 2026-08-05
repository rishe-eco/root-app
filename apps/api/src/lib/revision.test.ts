import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractSnapshot, canonicalize, contentHash, draftState } from './revision.js';

const article = (number: number, bodyFa: string | null = null) => ({
  number,
  titleFa: `ماده ${number}`,
  titleEn: `Article ${number}`,
  bodyFa,
  bodyEn: null,
});

test('canonicalize sorts object keys so build order cannot change the bytes', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonicalize sorts nested keys too', () => {
  assert.equal(canonicalize({ x: { d: 1, c: 2 } }), '{"x":{"c":2,"d":1}}');
});

test('canonicalize preserves array order — article order is the contract order', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('a BigInt fee becomes a decimal string rather than throwing', () => {
  const snapshot = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt('180000000') },
    [],
  );
  assert.equal(snapshot.amount, '180000000');
  // The real regression this guards: JSON.stringify throws on BigInt, so a
  // snapshot that kept the raw value would blow up at the first publish.
  assert.doesNotThrow(() => contentHash(snapshot));
});

test('articles are ordered by number, not by the order they were passed', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const forward = buildContractSnapshot(contract, [article(1), article(2), article(3)]);
  const shuffled = buildContractSnapshot(contract, [article(3), article(1), article(2)]);
  assert.equal(contentHash(forward), contentHash(shuffled));
});

test('changing any article body changes the hash', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const before = buildContractSnapshot(contract, [article(1, 'اول')]);
  const after = buildContractSnapshot(contract, [article(1, 'دوم')]);
  assert.notEqual(contentHash(before), contentHash(after));
});

test('changing the fee changes the hash', () => {
  const articles = [article(1)];
  const a = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(1) },
    articles,
  );
  const b = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(2) },
    articles,
  );
  assert.notEqual(contentHash(a), contentHash(b));
});

test('the hash is sha256 hex', () => {
  const snapshot = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null },
    [],
  );
  assert.match(contentHash(snapshot), /^[0-9a-f]{64}$/);
});

test('draftState is dirty against a null current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const { dirty } = draftState(contract, [article(1)], null);
  assert.equal(dirty, true);
});

test('draftState is dirty against an unsealed current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  // A backfilled v1 has no contentHash yet — "no hash" must read as "dirty",
  // or the publish that would seal it can never be reached.
  const { dirty } = draftState(contract, [article(1)], { contentHash: null });
  assert.equal(dirty, true);
});

test('draftState is clean when the hash matches the current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const articles = [article(1)];
  const { hash } = draftState(contract, articles, null);
  const { dirty } = draftState(contract, articles, { contentHash: hash });
  assert.equal(dirty, false);
});

test('draftState goes dirty after an article body changes, clean again once reverted', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const { hash: published } = draftState(contract, [article(1, 'اول')], null);
  const current = { contentHash: published };

  const edited = draftState(contract, [article(1, 'دوم')], current);
  assert.equal(edited.dirty, true);

  const revertedBack = draftState(contract, [article(1, 'اول')], current);
  assert.equal(revertedBack.dirty, false);
});
