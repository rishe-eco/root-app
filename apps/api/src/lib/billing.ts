/**
 * Billing's own small rules (spec §8; build plan L6) — kept beside
 * `lib/dependency.ts` and `lib/ticket.ts` in spirit (house rule 3: one rule,
 * one file), pure and Prisma-free except for `ensureSubscriptionEntries`,
 * which is the one place this stage touches the database at all.
 *
 * **The scheduler decision (build plan L6's first banked trap), recorded
 * here because this is the file that embodies it.** The API is a plain
 * Express process; nothing in this codebase runs a job on a timer. Three
 * options were on the table — generate lazily on read, a `npm run bill`
 * script under system cron, or a real scheduler (BullMQ, a Postgres-backed
 * queue, …). **Lazy-on-read is what this file does, and it is the only one
 * of the three that cannot silently stop running.** A cron entry can be
 * dropped by a deploy that forgets to reinstall it; a scheduler process can
 * die and nobody notices until a customer asks where their invoice is. Lazy
 * generation has no "is it still running" question to ask — the next time
 * anyone opens billing (the portal's own rail, or the desk's report), the
 * entries that should already exist are computed and written before the
 * read returns. The cost is that a subscription accruing quietly with nobody
 * ever opening billing for it produces no entries until someone does — an
 * acceptable trade at this volume (spec §8 names SMS as "the cheapest
 * recurring probe"), and one the plan itself calls "almost certainly right."
 */

import type { BillingSource, SubscriptionPeriod, Prisma, PrismaClient } from '@prisma/client';

export type SubscriptionLike = {
  id: string;
  customerId: string;
  amount: bigint;
  period: SubscriptionPeriod;
  activeFrom: Date;
  activeUntil: Date | null;
};

const PERIOD_MONTHS: Record<SubscriptionPeriod, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

/**
 * Adds one period to a date, calendar-month aware — never a fixed day count
 * (30, 90, 365), which would drift a "monthly" subscription against the
 * calendar month it is meant to track (a charge on the 31st slipping to the
 * 2nd of the month after next, say). `setUTCMonth`'s own overflow handling
 * does the month-length arithmetic; UTC throughout so this never depends on
 * the server's local timezone.
 */
export function addPeriod(date: Date, period: SubscriptionPeriod): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + PERIOD_MONTHS[period]);
  return d;
}

export type DuePeriod = { start: Date; end: Date };

/**
 * Every period whose start has already passed, from `activeFrom` up to
 * `min(activeUntil, asOf)` — a period becomes due **at its own start**: a
 * subscription is charged for the period it is entering, matching how a
 * plan is normally billed ("your March invoice" arrives in March, not at
 * March's end). A subscription created today with `activeFrom: now` is
 * therefore due for its first period immediately — this is intentional, not
 * an off-by-one: the first charge is the one that made the subscription
 * real.
 *
 * Pure, and the only place this arithmetic happens — `ensureSubscriptionEntries`
 * below calls this and nothing else in the codebase re-derives period
 * boundaries.
 */
export function duePeriods(sub: SubscriptionLike, asOf: Date = new Date()): DuePeriod[] {
  const periods: DuePeriod[] = [];
  const ceiling = sub.activeUntil && sub.activeUntil.getTime() < asOf.getTime() ? sub.activeUntil : asOf;
  let start = sub.activeFrom;
  // A guard against a pathological period length is unnecessary — the enum
  // only ever names MONTHLY/QUARTERLY/YEARLY, all of which strictly advance
  // `start` — but the loop still terminates on its own the moment `start`
  // passes `ceiling`, which is the only condition that matters here.
  while (start.getTime() <= ceiling.getTime()) {
    const end = addPeriod(start, sub.period);
    periods.push({ start, end });
    start = end;
  }
  return periods;
}

type PrismaLike = Pick<PrismaClient, 'subscription' | 'billingEntry'>;

/**
 * Writes every due-and-not-yet-billed period for one subscription. Called
 * wherever billing is opened — never on a timer (see this file's own
 * top comment).
 *
 * **The idempotency guarantee is the database's, not this function's.**
 * `createMany({ skipDuplicates: true })` is a single statement backed by
 * `BillingEntry_subscriptionId_periodStart_key` (the migration's unique
 * index) — two concurrent calls computing the same due period each attempt
 * the insert, and Postgres silently drops the second rather than raising a
 * constraint violation this function would have to catch. This is build
 * plan L6's own banked trap named directly: "a lazy generator that
 * double-charges on a refresh is the worst bug in this stage," and it is
 * structurally impossible here rather than merely tested against.
 */
export async function ensureSubscriptionEntries(
  prisma: PrismaLike,
  subscriptionId: string,
  asOf: Date = new Date(),
): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return;
  const periods = duePeriods(sub, asOf);
  if (periods.length === 0) return;

  await prisma.billingEntry.createMany({
    data: periods.map((p) => ({
      customerId: sub.customerId,
      source: 'SUBSCRIPTION' as const,
      // The subscription's own bilingual label already says what this charge
      // is for ("SMS API" / "پیامک"); the period itself is carried on
      // periodStart/periodEnd as real DateTime columns rather than baked into
      // this string, so the web renders it through the locale-aware date
      // helpers (house rule 14) instead of a server-authored Latin-digit date
      // sitting inside translated prose.
      descriptionFa: sub.labelFa,
      descriptionEn: sub.labelEn,
      amount: sub.amount,
      subscriptionId: sub.id,
      periodStart: p.start,
      periodEnd: p.end,
      issuedAt: p.start,
    })),
    skipDuplicates: true,
  });
}

/** Ensures every subscription matching `where` is caught up before its
 *  entries are read — the plural form `Query.allBillingEntries`/`billingReport`
 *  and friends call, since a staff-side read spans many customers at once. */
export async function ensureDueEntriesFor(
  prisma: PrismaLike,
  where: Prisma.SubscriptionWhereInput = {},
  asOf: Date = new Date(),
): Promise<void> {
  const subs = await prisma.subscription.findMany({ where, select: { id: true } });
  for (const s of subs) {
    await ensureSubscriptionEntries(prisma, s.id, asOf);
  }
}

/** A Toman amount arriving as a GraphQL string argument: digits only, no
 *  sign, no decimal point — the same discipline `BigInt(input)` gets
 *  elsewhere in this codebase, made checkable before the native constructor
 *  throws an uncoded error. "no float ever touches a charge" (build plan
 *  L6's second banked trap) starts here, at the one door new money enters
 *  through by hand. */
export function isValidTomanAmount(input: string): boolean {
  return /^\d+$/.test(input.trim());
}

export type BillingEntryLike = { source: BillingSource; amount: bigint; paidAt: Date | null };
export type BillingSourceTotal = {
  source: BillingSource;
  totalIssued: bigint;
  totalPaid: bigint;
  totalOutstanding: bigint;
};
export type BillingReport = {
  totalIssued: bigint;
  totalPaid: bigint;
  totalOutstanding: bigint;
  bySource: BillingSourceTotal[];
};

/**
 * The report (spec §8): totals over time, split by source, outstanding
 * balance. Pure — the resolver supplies whichever entries are in scope (one
 * customer's, or every customer's), and this never re-queries.
 */
export function computeBillingReport(entries: readonly BillingEntryLike[]): BillingReport {
  const bySourceMap = new Map<BillingSource, { issued: bigint; paid: bigint }>();
  for (const e of entries) {
    const cur = bySourceMap.get(e.source) ?? { issued: 0n, paid: 0n };
    cur.issued += e.amount;
    if (e.paidAt) cur.paid += e.amount;
    bySourceMap.set(e.source, cur);
  }
  const bySource = [...bySourceMap.entries()].map(([source, v]) => ({
    source,
    totalIssued: v.issued,
    totalPaid: v.paid,
    totalOutstanding: v.issued - v.paid,
  }));
  const totalIssued = bySource.reduce((s, r) => s + r.totalIssued, 0n);
  const totalPaid = bySource.reduce((s, r) => s + r.totalPaid, 0n);
  return { totalIssued, totalPaid, totalOutstanding: totalIssued - totalPaid, bySource };
}
