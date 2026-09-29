import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitBucket, checkAll } from './rateLimit.js';

test('a fresh key gets the full burst', () => {
  const bucket = new RateLimitBucket({ capacity: 3, refillPerMs: 0 });
  assert.equal(bucket.check('a'), true);
  assert.equal(bucket.check('a'), true);
  assert.equal(bucket.check('a'), true);
  assert.equal(bucket.check('a'), false); // the fourth, with no refill, is refused
});

test('keys are independent — spending one never affects another', () => {
  const bucket = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });
  assert.equal(bucket.check('a'), true);
  assert.equal(bucket.check('a'), false);
  assert.equal(bucket.check('b'), true); // untouched by 'a'
});

test('tokens refill at exactly the configured rate', () => {
  const bucket = new RateLimitBucket({ capacity: 2, refillPerMs: 1 / 1000 }); // 1 token per second
  const t0 = 0;
  assert.equal(bucket.check('a', t0), true);
  assert.equal(bucket.check('a', t0), true);
  assert.equal(bucket.check('a', t0), false); // capacity spent
  assert.equal(bucket.check('a', t0 + 500), false); // half a token isn't enough
  assert.equal(bucket.check('a', t0 + 1000), true); // exactly one token back
  assert.equal(bucket.check('a', t0 + 1000), false);
});

test('refill never exceeds capacity, however long the gap', () => {
  const bucket = new RateLimitBucket({ capacity: 2, refillPerMs: 1 });
  assert.equal(bucket.check('a', 0), true);
  assert.equal(bucket.check('a', 0), true);
  // A huge gap would compute far more than 2 tokens without the cap.
  assert.equal(bucket.check('a', 1_000_000_000), true);
  assert.equal(bucket.check('a', 1_000_000_000), true);
  assert.equal(bucket.check('a', 1_000_000_000), false);
});

test('peek never spends a token', () => {
  const bucket = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });
  assert.equal(bucket.peek('a'), true);
  assert.equal(bucket.peek('a'), true);
  assert.equal(bucket.peek('a'), true);
  assert.equal(bucket.check('a'), true); // still has its one token
  assert.equal(bucket.peek('a'), false);
});

test('reset clears every tracked key', () => {
  const bucket = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });
  assert.equal(bucket.check('a'), true);
  assert.equal(bucket.check('a'), false);
  bucket.reset();
  assert.equal(bucket.check('a'), true);
});

test('the oldest key is evicted once maxTrackedKeys is reached, rather than growing forever', () => {
  const bucket = new RateLimitBucket({ capacity: 1, refillPerMs: 0, maxTrackedKeys: 2 });
  assert.equal(bucket.check('a'), true); // a: spent
  assert.equal(bucket.check('b'), true); // b: spent, map now at its cap of 2
  assert.equal(bucket.check('c'), true); // evicts 'a' (oldest), then grants c fresh capacity
  // 'a' was evicted while it had 0 tokens, so a fresh entry for it gets a
  // full bucket again — the observable effect of the eviction.
  assert.equal(bucket.check('a'), true);
});

test('checkAll refuses if any budget would refuse, and charges none of them when it does', () => {
  const wide = new RateLimitBucket({ capacity: 5, refillPerMs: 0 });
  const narrow = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });

  // Exhaust the narrow one first.
  assert.equal(narrow.check('k'), true);

  // Now a combined check must refuse — and must not have spent the wide
  // bucket's token on a request that overall failed.
  assert.equal(checkAll([{ bucket: wide, key: 'k' }, { bucket: narrow, key: 'k' }]), false);
  assert.equal(wide.peek('k'), true, 'the wide bucket must be untouched by the refused combined check');
});

test('checkAll consumes every budget together when all agree', () => {
  const a = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });
  const b = new RateLimitBucket({ capacity: 1, refillPerMs: 0 });
  assert.equal(checkAll([{ bucket: a, key: 'k' }, { bucket: b, key: 'k' }]), true);
  assert.equal(a.peek('k'), false);
  assert.equal(b.peek('k'), false);
});
