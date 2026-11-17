import type { Prisma } from '@prisma/client';

/**
 * The contract reference (desk UX review item 1, DX3b): `R-<Jalali year>-<NNN>`,
 * a running number that restarts each Jalali year — `R-1405-001`. Latin digits
 * (house rule 14: an identifier, not prose). Older references (`RC-2026-014`)
 * keep working and are simply not counted: only `R-<year>-n` takes part in the
 * numbering.
 *
 * The year comes from `Intl` with the `persian` calendar in `Asia/Tehran`
 * (decision log 12): no calendar dependency on the API, and the year turns at
 * Nowruz in Tehran, which is the business's year, wherever the server runs.
 */

const YEAR_FORMAT = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  year: 'numeric',
  timeZone: 'Asia/Tehran',
});

/** The Jalali year in Tehran at this instant (`2026-03-21` → 1405). */
export function jalaliYear(now: Date): number {
  const digits = YEAR_FORMAT.format(now).match(/\d+/);
  if (!digits) throw new Error(`jalaliYear: no year in ${YEAR_FORMAT.format(now)}`);
  return Number(digits[0]);
}

/** `R-1405-7` → 7 for that year, otherwise null. */
function numberIn(ref: string, year: number): number | null {
  const m = /^R-(\d{4})-(\d+)$/.exec(ref);
  return m && Number(m[1]) === year ? Number(m[2]) : null;
}

/** The reference for a given year and running number: three digits at least. */
export function formatRef(year: number, n: number): string {
  return `R-${year}-${String(n).padStart(3, '0')}`;
}

/** The next free number of the year, given the references that exist (pure, for the unit test). */
export function nextRefFrom(existing: readonly string[], now: Date): string {
  const year = jalaliYear(now);
  let max = 0;
  for (const ref of existing) {
    const n = numberIn(ref, year);
    if (n !== null && n > max) max = n;
  }
  return formatRef(year, max + 1);
}

/**
 * The next reference, read from the database. Inside the create transaction
 * the caller holds `lockContractRefs` first, so two creations cannot read the
 * same maximum; outside one (the form's prefill) it is a suggestion, and the
 * server picks again at creation.
 */
export async function nextRef(
  db: Pick<Prisma.TransactionClient, 'contract'>,
  now: Date = new Date(),
): Promise<string> {
  const year = jalaliYear(now);
  const rows = await db.contract.findMany({
    where: { ref: { startsWith: `R-${year}-` } },
    select: { ref: true },
  });
  return nextRefFrom(
    rows.map((r) => r.ref),
    now,
  );
}

/**
 * Serialises reference generation for the rest of the transaction. An advisory
 * lock rather than a retry on `P2002`: the generated number is the only thing
 * that can collide with itself, and a lock makes that impossible instead of
 * unlikely, with no second code path to test. (A hand-typed reference that
 * collides is a different thing — the caller answers it `REF_TAKEN`.)
 */
export async function lockContractRefs(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('contract-ref'))`;
}

/** What a reference may be (decision log 14): Latin letters, digits and dashes, 40 at most. */
export const REF_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
