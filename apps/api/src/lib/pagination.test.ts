import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLimit } from './pagination.js';

test('clampLimit: absent or unusable input falls back', () => {
  assert.equal(clampLimit(undefined, 50, 100), 50);
  assert.equal(clampLimit(null, 50, 100), 50);
  assert.equal(clampLimit(Number.NaN, 50, 100), 50);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY, 50, 100), 50);
});

test('clampLimit: a value inside the range is returned unchanged', () => {
  assert.equal(clampLimit(1, 50, 100), 1);
  assert.equal(clampLimit(24, 50, 100), 24);
  assert.equal(clampLimit(100, 50, 100), 100);
});

test('clampLimit: the bound is a bound — this is the whole point', () => {
  // The case that made this function exist: a GraphQL default is not a bound,
  // so `limit: 999999` returned the whole table.
  assert.equal(clampLimit(999999, 50, 100), 100);
  assert.equal(clampLimit(101, 50, 100), 100);
});

test('clampLimit: zero and negatives become one, not nothing', () => {
  // Prisma's `take: 0` returns no rows, which reads as an empty corpus rather
  // than as a bad request — so the floor is 1.
  assert.equal(clampLimit(0, 50, 100), 1);
  assert.equal(clampLimit(-5, 50, 100), 1);
});

test('clampLimit: a fractional limit is truncated, not rounded up past the max', () => {
  assert.equal(clampLimit(24.9, 50, 100), 24);
  assert.equal(clampLimit(100.9, 50, 100), 100);
});
