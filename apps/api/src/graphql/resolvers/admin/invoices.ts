import { GraphQLError } from 'graphql';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../lib/env.js';
import { requireCapability, type Context } from '../../../context.js';
import { calendarDayString } from '../../../lib/calendarDay.js';
import { canIssuePlanned, issuedFields, takeInvoiceNumber, type IssueBlock } from '../../../lib/invoice.js';
import { lockContract } from '../../../lib/stepApproval.js';
import { notify } from '../../../lib/notify.js';
import { billingEntryInclude } from '../query.js';
import { reload } from '../contracts.js';
import { loadPlanFacts } from '../invoices.js';
import { notFound, parseAmountOrThrow, parseTermOrThrow } from './billing.js';

/**
 * An invoice's life after it is a draft (journeys build plan J13): edit or
 * delete a draft, issue it, issue a row of a payment plan. Creating a draft and
 * marking an invoice paid are `billing.ts`; what the customer reads is
 * `../invoices.ts`. Every mutation here is `billing.manage`, checked first
 * (`FORBIDDEN`, so no id leaks), and every one that decides "is this still a
 * draft / is this row still unissued" decides it **under a lock, inside the
 * transaction that writes** — a check made before the transaction is a check
 * against a row somebody else may be issuing this instant.
 *
 * **The number is taken last and inside** (`takeInvoiceNumber`, PD-11): after
 * the row is known to be issuable, so a refusal burns nothing; a rollback after
 * it burns one, which is the price of a counter that cannot race and is why the
 * invoice screen says numbers may skip.
 */

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

const BLOCK_MESSAGES: Record<IssueBlock | 'ALREADY_ISSUED', string> = {
  ALREADY_ISSUED: 'That payment has already been issued.',
  NOT_SIGNED: 'The agreement has not been signed yet, so nothing in its payment plan can be issued.',
  PREVIOUS_UNPAID: 'The payment before this one has not been paid yet.',
  PHASE_NOT_ACCEPTED: 'The phase this payment is tied to has not been accepted yet.',
};

/** Locks one entry's row for the rest of the transaction. */
const lockEntry = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT "id" FROM "BillingEntry" WHERE "id" = ${id} FOR UPDATE`;

/** The link in the notification: the customer's own page for this invoice, in
 *  the language they read. */
const invoiceUrl = (customer: { locale: string | null }, entryId: string) =>
  `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/invoices/${entryId}`;

/** Tells the customer, best-effort like every notification (`notify` never
 *  throws, and the invoice has already been issued). */
async function tellCustomer(entry: { id: string; customerId: string; amount: bigint; invoiceNumber: string | null; dueAt: Date | null }) {
  const customer = await prisma.user.findUnique({ where: { id: entry.customerId } });
  if (!customer || !entry.invoiceNumber || !entry.dueAt) return;
  await notify(customer, {
    kind: 'INVOICE_ISSUED',
    params: {
      customerName: customer.name,
      invoiceNumber: entry.invoiceNumber,
      amount: entry.amount.toString(),
      dueOn: calendarDayString(entry.dueAt),
      portalUrl: invoiceUrl(customer, entry.id),
    },
  });
}

export const invoiceMutations = {
  /**
   * Edits a draft — a replace: the form is the draft, so an omitted
   * `paymentTermDays` returns to "the default at issue". `NOT_A_DRAFT` once it
   * is issued: an issued invoice is what the customer was told, and changing it
   * would make the number mean two things.
   */
  updateInvoiceDraft: async (
    _p: unknown,
    args: { entryId: string; descriptionFa: string; descriptionEn: string; amount: string; paymentTermDays?: number | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'billing.manage');
    const amount = parseAmountOrThrow(args.amount);
    const paymentTermDays = parseTermOrThrow(args.paymentTermDays);
    await prisma.$transaction(async (tx) => {
      await lockEntry(tx, args.entryId);
      const entry = await tx.billingEntry.findUnique({ where: { id: args.entryId } });
      if (!entry) throw notFound('billing entry');
      if (entry.issuedAt !== null) throw refuse('NOT_A_DRAFT', 'An issued invoice cannot be edited.');
      await tx.billingEntry.update({
        where: { id: entry.id },
        data: { descriptionFa: args.descriptionFa, descriptionEn: args.descriptionEn, amount, paymentTermDays },
      });
    });
    return prisma.billingEntry.findUniqueOrThrow({ where: { id: args.entryId }, include: billingEntryInclude });
  },

  /**
   * Deletes a draft. An invoice is never deleted (`NOT_A_DRAFT`) — a mistaken
   * one is a record that was issued, and the ledger keeps it. A draft made
   * through a ticket or a service run releases that edge (`SetNull`), so the
   * ticket or run can be billed again.
   */
  deleteInvoiceDraft: async (_p: unknown, args: { entryId: string }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    await prisma.$transaction(async (tx) => {
      await lockEntry(tx, args.entryId);
      const entry = await tx.billingEntry.findUnique({ where: { id: args.entryId } });
      if (!entry) throw notFound('billing entry');
      if (entry.issuedAt !== null) throw refuse('NOT_A_DRAFT', 'An issued invoice cannot be deleted.');
      await tx.billingEntry.delete({ where: { id: entry.id } });
    });
    return true;
  },

  /**
   * Draft to issued: number from the sequence, dated now, due `paymentTermDays`
   * later (the draft's own, else `env.DEFAULT_PAYMENT_TERM_DAYS`). The term used
   * is written back onto the invoice so it is the term it was issued with for
   * good. `ALREADY_ISSUED` for a second press — including a concurrent one: the
   * row lock serializes them, and the loser finds it issued and takes no number.
   */
  issueInvoice: async (_p: unknown, args: { entryId: string }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    const issued = await prisma.$transaction(async (tx) => {
      await lockEntry(tx, args.entryId);
      const entry = await tx.billingEntry.findUnique({ where: { id: args.entryId } });
      if (!entry) throw notFound('billing entry');
      if (entry.issuedAt !== null) throw refuse('ALREADY_ISSUED', BLOCK_MESSAGES.ALREADY_ISSUED);
      const number = await takeInvoiceNumber(tx);
      return tx.billingEntry.update({
        where: { id: entry.id },
        data: issuedFields({ number, issuedAt: new Date(), termDays: entry.paymentTermDays ?? env.DEFAULT_PAYMENT_TERM_DAYS }),
      });
    });
    await tellCustomer(issued);
    return prisma.billingEntry.findUniqueOrThrow({ where: { id: issued.id }, include: billingEntryInclude });
  },

  /**
   * Issues one row of a contract's payment plan — the plan rule, Q18
   * (`canIssuePlanned`, lib/invoice.ts): signed, the previous row paid, the
   * phase's demo approved. **One function decides, and the desk's *Issue next*
   * button reads the same one** (`PlannedInvoice.state`), so a button that is
   * enabled is a mutation that will be accepted, barring a race — and the race
   * is closed here: the contract's row lock (`lockContract`, the one
   * `setPaymentPlan` and an unmark take too) serializes two presses, the loser
   * finds an entry and is `ALREADY_ISSUED`, and the unique
   * `BillingEntry.plannedInvoiceId` is the backstop should anything ever
   * bypass the lock.
   *
   * Returns the contract (T9): its plan now shows the invoice.
   */
  issuePlannedInvoice: async (_p: unknown, args: { plannedInvoiceId: string }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    const row = await prisma.plannedInvoice.findUnique({ where: { id: args.plannedInvoiceId }, include: { plan: true } });
    if (!row) throw notFound('planned invoice');
    const contractId = row.plan.contractId;

    const issued = await prisma
      .$transaction(async (tx) => {
        await lockContract(tx, contractId);
        const facts = await loadPlanFacts(tx, row.planId);
        const plan = facts.plan.invoices.map((i) => ({ id: i.id, ordinal: i.ordinal, phaseId: i.phaseId }));
        const verdict = canIssuePlanned(
          plan,
          plan.findIndex((r) => r.id === row.id),
          facts.entries,
          facts.approvals,
          facts.signedAt !== null,
        );
        if (!verdict.ok) throw refuse(verdict.reason, BLOCK_MESSAGES[verdict.reason]);

        const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, select: { customerId: true } });
        const number = await takeInvoiceNumber(tx);
        return tx.billingEntry.create({
          data: {
            customerId: contract.customerId,
            contractId,
            phaseId: row.phaseId,
            source: 'CONTRACT',
            descriptionFa: row.labelFa,
            descriptionEn: row.labelEn,
            amount: row.amount,
            plannedInvoiceId: row.id,
            ...issuedFields({ number, issuedAt: new Date(), termDays: row.paymentTermDays }),
          },
        });
      })
      .catch((err) => {
        // Only reachable if something got past the lock: the unique index says
        // this row already has its invoice, which is `ALREADY_ISSUED` exactly.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw refuse('ALREADY_ISSUED', BLOCK_MESSAGES.ALREADY_ISSUED);
        }
        throw err;
      });

    await tellCustomer(issued);
    return reload(contractId);
  },
};
