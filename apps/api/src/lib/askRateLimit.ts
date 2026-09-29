/**
 * Rate limiting stops being deferrable at R4 (R4.md §4): this is the first
 * endpoint where an anonymous request spends money. Minimum viable, per the
 * spec: a per-IP token bucket (cheap, in-memory, lost on restart — enough to
 * stop a loop) and a daily spend ceiling that fails closed. Both are
 * in-memory rather than persisted, the same tradeoff the spec accepts for
 * the bucket — an operator restart losing a day's spend counter is a rare
 * and recoverable failure; a ceiling that silently stops enforcing because a
 * migration broke is not, which is the case a database-backed counter would
 * actually risk.
 *
 * **The bucket itself moved to `lib/rateLimit.ts`** (journeys build plan J1,
 * PD-15): `routes/ask.ts` now checks `askBucket` there directly, with the
 * exact numbers this file used to hold (capacity 5, refill one every 30s) —
 * this file keeps only the spend ceiling, which is Ask-specific money
 * tracking, not a generic rate limiter, and was never part of what PD-15
 * asked to be generalized.
 *
 * Nginx `limit_req` (R4.md §4, item 1) is deployment configuration, not code
 * — out of scope here the same way C0's mail provider left Nginx alone
 * until there was a reason to touch it (see docs/development/README.md
 * "no stage from V1b to R1 needs a deployment change").
 */

import { askBucket } from './rateLimit.js';

/**
 * claude-opus-4-8 pricing, cached 2026-06-24 — $5/1M input, $25/1M output.
 * Recorded here rather than derived at request time because the Messages
 * API does not return a dollar figure, only token counts; if pricing
 * changes, this is the one constant to update.
 */
const INPUT_USD_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 25 / 1_000_000;
/** Cache reads are billed at roughly 0.1x input price (writes at ~1.25x);
 *  both are folded into this one estimate rather than tracked separately —
 *  the ceiling only needs to be conservative, not exact to the cent. */
const CACHE_READ_USD_PER_TOKEN = INPUT_USD_PER_TOKEN * 0.1;
const CACHE_WRITE_USD_PER_TOKEN = INPUT_USD_PER_TOKEN * 1.25;

export function estimateCostUsd(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): number {
  return (
    usage.input_tokens * INPUT_USD_PER_TOKEN +
    usage.output_tokens * OUTPUT_USD_PER_TOKEN +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ_USD_PER_TOKEN +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE_USD_PER_TOKEN
  );
}

/** A ceiling that fails closed is the difference between a bad day and a
 *  bad month (R4.md §4) — deliberately conservative for a feature with no
 *  production traffic history yet. */
export const DAILY_SPEND_CEILING_USD = 20;

let spentToday = 0;
let spendDay = utcDay(Date.now());

function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function rollSpendDay(now: number): void {
  const day = utcDay(now);
  if (day !== spendDay) {
    spendDay = day;
    spentToday = 0;
  }
}

export function spendCeilingExceeded(now: number = Date.now()): boolean {
  rollSpendDay(now);
  return spentToday >= DAILY_SPEND_CEILING_USD;
}

export function recordSpend(usd: number, now: number = Date.now()): void {
  rollSpendDay(now);
  spentToday += usd;
}

/** Test-only seam — resets both trackers between test files/cases so one
 *  test's IP or spend history cannot leak into the next. */
export function __resetAskRateLimitForTests(): void {
  askBucket.reset();
  spentToday = 0;
  spendDay = utcDay(Date.now());
}
