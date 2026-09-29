/**
 * Keyed, configurable rate buckets (journeys build plan J1, PD-15) — the
 * generalization of what began as `askRateLimit.ts`'s one-off per-IP bucket
 * (R4.md §4, "the first endpoint where an anonymous request spends money").
 * `/ask` imports this file directly now, with its original numbers
 * unchanged (`askBucket`, below); everything sign-in needs — code requests
 * per phone and per IP, sign-in attempts per identifier and per IP — is
 * built on the same mechanism rather than a second one beside it (house
 * rule 3).
 *
 * In-memory, single process, lost on restart — the same trade `/ask`'s
 * bucket already accepted, for the same reason: an operator restart
 * resetting a sign-in limiter is the recoverable direction, and a
 * database-backed counter would risk the ceiling silently failing open
 * instead (a migration or an outage takes the *limit* down, not just the
 * count).
 */

export type RateLimitConfig = {
  /** The burst this key may spend all at once before it has to wait. */
  capacity: number;
  /** Tokens regained per millisecond. A bucket's long-run sustained rate is
   *  this number alone — `capacity` only ever affects how much of it can be
   *  spent in one instant. */
  refillPerMs: number;
  /** Bounds memory under sustained traffic from many distinct keys — the
   *  map is never allowed to grow without limit. */
  maxTrackedKeys?: number;
};

type Bucket = { tokens: number; lastRefill: number };

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

/**
 * One bucket per key. `peek`/`consume` are split, rather than one
 * check-and-spend call, so several independent budgets on the *same*
 * action (PD-15's "1/min and 5/day per phone" is two buckets, not one) can
 * be asked "would every one of you allow this" before any of them is
 * actually charged — see `checkAll` below, which is what every caller with
 * more than one budget should use instead of calling `check` per bucket by
 * hand.
 */
export class RateLimitBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxTrackedKeys: number;

  constructor(private readonly config: RateLimitConfig) {
    this.maxTrackedKeys = config.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  private tokensNow(bucket: Bucket, now: number): number {
    const elapsed = now - bucket.lastRefill;
    return Math.min(this.config.capacity, bucket.tokens + elapsed * this.config.refillPerMs);
  }

  /** Would this key currently be allowed through, without spending anything. */
  peek(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.config.capacity >= 1;
    return this.tokensNow(bucket, now) >= 1;
  }

  /** Spends one token unconditionally — callers that already know (via
   *  `peek`) that this is allowed. Never refuses on its own, so a caller
   *  that skips the peek can drive a bucket negative; every caller in this
   *  codebase goes through `check` or `checkAll` instead of calling this
   *  directly for that reason. */
  private consume(key: string, now: number): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxTrackedKeys) {
        // Evict the oldest-seen entry rather than let the map grow forever;
        // losing one stranger's bucket under this kind of pressure is the
        // acceptable failure, not refusing every new key.
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      bucket = { tokens: this.config.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = this.tokensNow(bucket, now) - 1;
    bucket.lastRefill = now;
  }

  /** Peek and, if allowed, consume — the single-budget case. */
  check(key: string, now: number = Date.now()): boolean {
    if (!this.peek(key, now)) return false;
    this.consume(key, now);
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Several independent budgets guarding one action (PD-15's per-phone *and*
 * per-IP limits on the same code request): all-or-nothing, and never spends
 * from a bucket whose sibling refused. Checking each `peek` first and
 * consuming only once every one agrees is what keeps a request that fails
 * bucket B from quietly costing bucket A a token it will never get back —
 * a caller that instead checked and consumed bucket A, then found B
 * refused, would have punished the key for a request that never happened.
 */
export function checkAll(checks: Array<{ bucket: RateLimitBucket; key: string }>, now: number = Date.now()): boolean {
  if (!checks.every(({ bucket, key }) => bucket.peek(key, now))) return false;
  for (const { bucket, key } of checks) bucket.check(key, now);
  return true;
}

/** capacity N over a period of `periodMs` — the sustained rate is exactly
 *  "N per period," with a burst of N allowed immediately. The one formula
 *  every named budget below is built from, so "10 per 15 minutes" reads
 *  off the call site instead of being reverse-engineered from a raw
 *  `refillPerMs`. */
const perPeriod = (capacity: number, periodMs: number): RateLimitConfig => ({
  capacity,
  refillPerMs: capacity / periodMs,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `/ask`'s own bucket (R4.md §4) — unchanged from before this file existed:
 *  a burst of 5, refilling at one every 30 seconds. */
export const askBucket = new RateLimitBucket({ capacity: 5, refillPerMs: 1 / 30_000 });

/** PD-15's own budgets for the phone/sign-in surfaces (J1). */
export const loginCodePerPhonePerMinute = new RateLimitBucket(perPeriod(1, MINUTE));
export const loginCodePerPhonePerDay = new RateLimitBucket(perPeriod(5, DAY));
export const loginCodePerIpPerHour = new RateLimitBucket(perPeriod(10, HOUR));
export const signInAttemptsPerIdentifier = new RateLimitBucket(perPeriod(10, 15 * MINUTE));
export const signInAttemptsPerIp = new RateLimitBucket(perPeriod(10, 15 * MINUTE));

/**
 * Journeys build plan J2. Every request and every message notifies every sales
 * account by email *and SMS* (`lib/notify.ts`), and an SMS costs money — so an
 * account that floods the thread, by script or by a stuck button, would spend
 * Root's budget and bury the inbox. Generous for any real conversation (ten
 * requests a day; a message a minute, sustained), and per account rather than
 * per address: the requests are signed-in acts.
 */
export const requestsPerUserPerDay = new RateLimitBucket(perPeriod(10, DAY));
export const requestMessagesPerUserPerHour = new RateLimitBucket(perPeriod(60, HOUR));

/** Test-only seam — every named bucket above, reset together, so one test
 *  file's identifiers and IPs cannot leak into the next (the same reasoning
 *  `askRateLimit.ts`'s own reset function already applied to its one bucket). */
export function __resetNamedRateLimitsForTests(): void {
  askBucket.reset();
  loginCodePerPhonePerMinute.reset();
  loginCodePerPhonePerDay.reset();
  loginCodePerIpPerHour.reset();
  signInAttemptsPerIdentifier.reset();
  signInAttemptsPerIp.reset();
  requestsPerUserPerDay.reset();
  requestMessagesPerUserPerHour.reset();
}
