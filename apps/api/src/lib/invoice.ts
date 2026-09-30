import type { Prisma, StepKind } from '@prisma/client';

/**
 * Invoices' own rules (journeys build plan J13) — one file for what an issued
 * invoice *is*, when a planned one may be issued, and when one is overdue
 * (house rule 3). Beside `lib/billing.ts`, which keeps the report and the lazy
 * subscription generator; this file is the part that has to be the same for
 * all three issuing paths, so none of them can number or date an invoice its
 * own way.
 *
 * Pure except `takeInvoiceNumber`, which is the one place the sequence is
 * read. **Every rule below is over rows the caller has loaded**, so the
 * resolver that answers "can this be issued?" for the desk and the one that
 * refuses the mutation ask the same function the same question — the button
 * cannot be enabled by one rule while the mutation enforces another.
 *
 * ## The plan rule (Q18, the founder's)
 *
 * A planned invoice may be issued when: the contract is **signed**
 * (`NOT_SIGNED`); the invoice before it in the plan has been **issued and
 * paid** (`PREVIOUS_UNPAID` — the first has no previous, so it needs only the
 * signature); and, if the row is tied to a phase, **that phase's demo has been
 * approved** (`PHASE_NOT_ACCEPTED`). The third reads a `StepApproval` of step
 * `DEMO` for that `phaseId` — the row J10 will write — so J10 has only to
 * produce it; before J10 nothing can, and a phase-tied invoice is unissuable,
 * which is right: no contract can have reached a demo yet.
 */

export const INVOICE_NUMBER_PREFIX = 'INV-';

/** `INV-000123` — Latin digits in every locale (house rule 14: an invoice
 *  number is an identifier, typed back and quoted on a bank slip). Six digits
 *  is a floor, not a ceiling: the millionth invoice is `INV-1000000`. */
export function formatInvoiceNumber(n: number | bigint): string {
  return `${INVOICE_NUMBER_PREFIX}${String(n).padStart(6, '0')}`;
}

/** The longest term a payment plan row may carry (`lib/plan.ts`'s `INVALID_TERM`
 *  bound), and so the longest a draft or the default may. */
export const MAX_PAYMENT_TERM_DAYS = 365;

/** A term is a whole number of days from 0 to 365. */
export function isValidPaymentTerm(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= MAX_PAYMENT_TERM_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `at` falls on — the calendar-day convention (PD-19). */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The due day: the issue day plus the term, as midnight UTC — exactly what a
 * Postgres `date` column stores and reads back (`lib/calendarDay.ts`). A term
 * of zero is due the day it is issued.
 */
export function dueDayFor(issuedAt: Date, termDays: number): Date {
  return new Date(utcDayStart(issuedAt).getTime() + termDays * DAY_MS);
}

/**
 * The four columns that make a row an issued invoice, from one place: the
 * number, the moment, the term it was issued with and the day it falls due. The
 * three issuing paths spread this into their write, and the CHECK
 * `BillingEntry_issued_is_complete` is the database's backstop for the fourth.
 */
export function issuedFields(input: { number: number | bigint; issuedAt: Date; termDays: number }) {
  return {
    invoiceNumber: formatInvoiceNumber(input.number),
    issuedAt: input.issuedAt,
    paymentTermDays: input.termDays,
    dueAt: dueDayFor(input.issuedAt, input.termDays),
  };
}

/**
 * The next number off `invoice_number_seq` (PD-11). **Call it inside the
 * issuing transaction**, after the row is known to be issuable and before it
 * is written: a rolled-back transaction burns its number, which is the price
 * of a counter that can never race, and is said so on the invoice screen.
 * Never `MAX()+1`, never a counter row.
 */
export async function takeInvoiceNumber(tx: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
  return rows[0].n;
}

export type InvoiceLike = { issuedAt: Date | null; dueAt: Date | null; paidAt: Date | null };

/** Issued, not paid, and its due day is before today (UTC). The due day is
 *  itself the last day to pay: an invoice is not overdue *on* it. A draft is
 *  never overdue, and neither is anything paid, however late. Derived on every
 *  read, never stored — the same discipline `Dependency.overdue` holds to. */
export function isOverdue(entry: InvoiceLike, now: Date): boolean {
  if (entry.issuedAt === null || entry.dueAt === null || entry.paidAt !== null) return false;
  return entry.dueAt.getTime() < utcDayStart(now).getTime();
}

// --- the plan rule -----------------------------------------------------------

export type IssueBlock = 'NOT_SIGNED' | 'PREVIOUS_UNPAID' | 'PHASE_NOT_ACCEPTED';

export type PlannedInvoiceRow = { id: string; ordinal: number; phaseId: string | null };
/** The entry a planned invoice was issued as — only what the rule reads. */
export type PlanEntry = { plannedInvoiceId: string | null; issuedAt: Date | null; paidAt: Date | null };
export type ApprovalRow = { step: StepKind; phaseId: string | null };

export type IssueVerdict = { ok: true } | { ok: false; reason: IssueBlock | 'ALREADY_ISSUED' };

/**
 * May the planned invoice at `index` (0-based, in ordinal order) be issued
 * now? `ALREADY_ISSUED` first — a row that has an invoice is not waiting on
 * anything — then the plan's three conditions in the order the customer would
 * meet them: signed, then the previous one paid, then the phase accepted.
 *
 * `plan` is the contract's planned invoices in ordinal order, `entries` the
 * billing entries that carry a `plannedInvoiceId` of that plan, `approvals`
 * the contract's step approvals, and `signed` whether the agreement is signed
 * (`agreementSignedAt`, lib/steps.ts).
 */
export function canIssuePlanned(
  plan: readonly PlannedInvoiceRow[],
  index: number,
  entries: readonly PlanEntry[],
  approvals: readonly ApprovalRow[],
  signed: boolean,
): IssueVerdict {
  const row = plan[index];
  const entryOf = (id: string) => entries.find((e) => e.plannedInvoiceId === id && e.issuedAt !== null);
  if (!row) throw new RangeError(`canIssuePlanned: no planned invoice at index ${index}`);
  if (entryOf(row.id)) return { ok: false, reason: 'ALREADY_ISSUED' };
  if (!signed) return { ok: false, reason: 'NOT_SIGNED' };
  if (index > 0) {
    const previous = entryOf(plan[index - 1].id);
    if (!previous || previous.paidAt === null) return { ok: false, reason: 'PREVIOUS_UNPAID' };
  }
  if (row.phaseId !== null && !approvals.some((a) => a.step === 'DEMO' && a.phaseId === row.phaseId)) {
    return { ok: false, reason: 'PHASE_NOT_ACCEPTED' };
  }
  return { ok: true };
}

export type PlannedInvoiceState = 'NOT_YET_ISSUABLE' | 'ISSUABLE' | 'ISSUED' | 'PAID' | 'OVERDUE';

/**
 * What one planned invoice looks like on the plan: the five states the plan's
 * API names, plus what it is waiting on. `OVERDUE` and `PAID` are the issued
 * entry's own state (`isOverdue`); the other three are `canIssuePlanned`'s.
 */
export function plannedInvoiceState(
  plan: readonly PlannedInvoiceRow[],
  index: number,
  entries: readonly (PlanEntry & { dueAt: Date | null })[],
  approvals: readonly ApprovalRow[],
  signed: boolean,
  now: Date,
): { state: PlannedInvoiceState; blockedBy: IssueBlock | null } {
  const verdict = canIssuePlanned(plan, index, entries, approvals, signed);
  if (verdict.ok) return { state: 'ISSUABLE', blockedBy: null };
  if (verdict.reason !== 'ALREADY_ISSUED') return { state: 'NOT_YET_ISSUABLE', blockedBy: verdict.reason };
  const entry = entries.find((e) => e.plannedInvoiceId === plan[index].id && e.issuedAt !== null)!;
  if (entry.paidAt !== null) return { state: 'PAID', blockedBy: null };
  return { state: isOverdue(entry, now) ? 'OVERDUE' : 'ISSUED', blockedBy: null };
}

/**
 * "The first invoice is paid" (Q11's second half of *started*), for a contract
 * that has a payment plan: the plan's first planned invoice has an entry, and
 * the entry is paid. Returns when — the paid-at — or null. A contract with **no
 * plan** has no first invoice to wait for, and the caller keeps `started =
 * signed` for it (`statusSummary.ts`): every legacy contract is that case.
 */
export function firstInvoicePaidAt(
  plan: readonly PlannedInvoiceRow[],
  entries: readonly PlanEntry[],
): Date | null {
  if (plan.length === 0) return null;
  const first = plan.reduce((a, b) => (b.ordinal < a.ordinal ? b : a));
  return entries.find((e) => e.plannedInvoiceId === first.id)?.paidAt ?? null;
}
