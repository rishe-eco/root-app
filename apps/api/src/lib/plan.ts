/**
 * The payment plan's own rules (journeys build plan J4, house rule 3): what a
 * set of planned invoices adds up to, whether that is the fee, and which rows
 * are refused before they reach the database's CHECKs. Pure, `bigint` all the
 * way — Toman have no sub-unit and a float has no business here.
 *
 * **The split is descriptive, the rows are the plan.** Nothing in this file
 * turns a split into rows: the desk form *proposes* rows from the split
 * (`apps/web/src/lib/planProposal.ts`) and sales edits them before saving, and
 * `setPaymentPlan` stores exactly the rows it is given.
 */

import { parseCalendarDay } from './calendarDay.js';
import { hasOneTitle } from './titles.js';

export type PlannedRow = {
  labelFa: string;
  labelEn: string;
  amount: bigint;
  paymentTermDays: number;
};

/** The sum of a plan's rows. */
export function planTotal(plan: { invoices: ReadonlyArray<{ amount: bigint }> }): bigint {
  return plan.invoices.reduce((sum, row) => sum + row.amount, 0n);
}

/**
 * Whether the plan adds up to the fee — the precondition J7's agreement gate
 * will hold ("the payment plan sums to the fee"). **No fee is not a match**: a
 * plan compared with nothing has been checked against nothing, and the gate
 * that reads this must not treat "not set yet" as "correct". An empty plan
 * against a positive fee is a mismatch by arithmetic.
 */
export function planMatchesFee(plan: { invoices: ReadonlyArray<{ amount: bigint }> }, amount: bigint | null): boolean {
  return amount !== null && planTotal(plan) === amount;
}

/** More rows than a monthly plan over two years — a typo is the only way here. */
export const MAX_PLAN_ROWS = 36;
/** A term past a year is a typo for days; "on delivery" is 0. */
export const MAX_TERM_DAYS = 365;

export type PlanProblem =
  | 'PLAN_ROWS_REQUIRED'
  | 'TOO_MANY_ROWS'
  | 'LABEL_REQUIRED'
  | 'INVALID_AMOUNT'
  | 'INVALID_TERM'
  | 'INVALID_DATE'
  | 'PHASE_AND_DATE';

/** A positive whole number of Toman as a decimal string — same test as the
 *  brief's budget, restated over `PlannedRow`'s own input shape. */
const AMOUNT = /^[1-9]\d{0,14}$/;

/**
 * The refusals that need no database, first problem wins, in the order the
 * form's columns run: rows, labels, amount, term. The amount test is on the
 * *string* the API received, before it becomes a `bigint` — `BigInt('1e3')`
 * throws and `BigInt('')` is zero, and neither is an answer.
 */
export function checkPlanRows(
  rows: ReadonlyArray<{
    labelFa: string;
    labelEn: string;
    amount: string;
    paymentTermDays: number;
    phaseId?: string | null;
    /** DX2b: the day a row falls due, `YYYY-MM-DD` off the wire. */
    dueOn?: string | null;
  }>,
): PlanProblem | null {
  if (rows.length === 0) return 'PLAN_ROWS_REQUIRED';
  if (rows.length > MAX_PLAN_ROWS) return 'TOO_MANY_ROWS';
  for (const row of rows) {
    // DX4: a label in one language is enough; LABEL_REQUIRED now means both are blank.
    if (!hasOneTitle(row.labelFa, row.labelEn)) return 'LABEL_REQUIRED';
    if (!AMOUNT.test(row.amount)) return 'INVALID_AMOUNT';
    if (!Number.isInteger(row.paymentTermDays) || row.paymentTermDays < 0 || row.paymentTermDays > MAX_TERM_DAYS) {
      return 'INVALID_TERM';
    }
    // DX2b: a row is due on signing, on a phase being done, or on a date — at most one of the last two.
    if (row.dueOn) {
      if (parseCalendarDay(row.dueOn) === null) return 'INVALID_DATE';
      if (row.phaseId) return 'PHASE_AND_DATE';
    }
  }
  return null;
}
