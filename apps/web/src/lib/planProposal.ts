import { dayToJalali } from './jalali';

/**
 * The desk form's *proposal* of payment-plan rows from a split (journeys build
 * plan J4). **The split is descriptive, the rows are the plan**: this only fills
 * the form in — lump sum → one row, installments → N rows the user picks,
 * monthly → N rows labelled by month from the planned start — and sales edits
 * every cell before saving. The server stores exactly the rows it is given and
 * never regenerates them from the split (`setPaymentPlan`), so nothing here is
 * a rule; it is a convenience that must not surprise.
 *
 * Pure: no React, no clock (the caller passes `today`), no i18n instance — the
 * labels arrive as functions, one per language, because a row's label is stored
 * in *both* languages whichever one the desk is read in.
 *
 * Amounts are `bigint` Toman, split so **the rows always add up to the total to
 * the last Toman** (the remainder goes one Toman at a time to the first rows —
 * never a rounding step that leaves the plan a Toman short of the fee).
 */

export type Split = 'LUMP_SUM' | 'INSTALLMENTS' | 'MONTHLY';

export type ProposedRow = {
  labelFa: string;
  labelEn: string;
  /** A decimal string of Toman, or '' when there is no total to divide. */
  amount: string;
  phaseId: string | null;
  paymentTermDays: number;
};

export type Labeller = {
  lump: () => string;
  /** "Installment 2 of 4". */
  installment: (n: number, of: number) => string;
  /** "Aban 1405" — the month, named in this language. */
  month: (monthNumber: number, year: number) => string;
};

/** Even shares that add up exactly: the first `total % count` rows carry one more Toman. */
export function evenShares(total: bigint, count: number): bigint[] {
  if (count < 1) return [];
  const n = BigInt(count);
  const base = total / n;
  const extra = Number(total % n);
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1n : 0n));
}

/** The Jalali month `offset` months after a starting `(year, month)`. */
export function addJalaliMonths(year: number, month: number, offset: number): { jy: number; jm: number } {
  const index = year * 12 + (month - 1) + offset;
  return { jy: Math.floor(index / 12), jm: (index % 12) + 1 };
}

export function proposeRows(input: {
  split: Split;
  /** The fee being paid off, if there is one — `Contract.amount`, never the brief's budget cap. */
  total: bigint | null;
  /** How many rows, for installments and monthly. Ignored for a lump sum. */
  count: number;
  /** This contract's phases, in order. Installments link to them when there are exactly as many. */
  phases: ReadonlyArray<{ id: string }>;
  /** The planned start (`YYYY-MM-DD`) — where a monthly plan's first month comes from. */
  start: string | null;
  /** Today, `YYYY-MM-DD`, for a monthly plan with no start. */
  today: string;
  termDays?: number;
  fa: Labeller;
  en: Labeller;
}): ProposedRow[] {
  const term = input.termDays ?? 7;
  const rows = input.split === 'LUMP_SUM' ? 1 : Math.max(1, Math.min(Math.floor(input.count), 36));
  const shares = input.total !== null && input.total > 0n ? evenShares(input.total, rows) : null;
  const amount = (i: number) => (shares ? shares[i].toString() : '');

  if (input.split === 'LUMP_SUM') {
    return [{ labelFa: input.fa.lump(), labelEn: input.en.lump(), amount: amount(0), phaseId: null, paymentTermDays: term }];
  }

  if (input.split === 'INSTALLMENTS') {
    const linked = input.phases.length === rows;
    return Array.from({ length: rows }, (_, i) => ({
      labelFa: input.fa.installment(i + 1, rows),
      labelEn: input.en.installment(i + 1, rows),
      amount: amount(i),
      phaseId: linked ? input.phases[i].id : null,
      paymentTermDays: term,
    }));
  }

  const first = dayToJalali(input.start ?? '') ?? dayToJalali(input.today);
  if (!first) return [];
  return Array.from({ length: rows }, (_, i) => {
    const { jy, jm } = addJalaliMonths(first.jy, first.jm, i);
    return {
      labelFa: input.fa.month(jm, jy),
      labelEn: input.en.month(jm, jy),
      amount: amount(i),
      phaseId: null,
      paymentTermDays: term,
    };
  });
}
