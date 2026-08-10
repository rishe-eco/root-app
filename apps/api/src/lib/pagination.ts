/**
 * The page-size bound for every list query.
 *
 * **A GraphQL default is not a bound.** `limit: Int = 50` says what happens
 * when the caller says nothing; it says nothing about `limit: 999999`, which
 * returned the whole table. Defect D10 recorded that shape on `allContracts`
 * as acceptable debt because contracts are few and Root-created — the Library
 * is the corpus that is *meant* to grow, and R2 serves a list of it to
 * anonymous readers, at which point an unbounded page size stops being a
 * staff foot-gun and becomes the cheapest way to make the database work hard
 * from outside.
 *
 * **Clamped, not refused.** A caller asking for more than the maximum gets the
 * maximum, which is what they almost always meant; throwing would break a
 * client that was working. A caller asking for zero or a negative gets one —
 * `take: 0` in Prisma returns nothing, which reads as an empty corpus rather
 * than as a bad request.
 */
export function clampLimit(
  value: number | null | undefined,
  fallback: number,
  max: number,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
