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
  | 'INVALID_TERM';

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
  rows: ReadonlyArray<{ labelFa: string; labelEn: string; amount: string; paymentTermDays: number }>,
): PlanProblem | null {
  if (rows.length === 0) return 'PLAN_ROWS_REQUIRED';
  if (rows.length > MAX_PLAN_ROWS) return 'TOO_MANY_ROWS';
  for (const row of rows) {
    if (!row.labelFa.trim() || !row.labelEn.trim()) return 'LABEL_REQUIRED';
    if (!AMOUNT.test(row.amount)) return 'INVALID_AMOUNT';
    if (!Number.isInteger(row.paymentTermDays) || row.paymentTermDays < 0 || row.paymentTermDays > MAX_TERM_DAYS) {
      return 'INVALID_TERM';
    }
  }
  return null;
}
