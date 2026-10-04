import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { clampLimit } from '../../lib/pagination.js';
import { ensureDueEntriesFor } from '../../lib/billing.js';
import { homeFor, needsRoot, type HomeContract } from '../../lib/home.js';
import { utcDayStart } from '../../lib/invoice.js';
import { attentionInputOf, loadFactsMany, pendingFactsOf, type WizardContract } from './wizard.js';
import { pendingNeeds, pendingOf, type PendingPrior } from './fields.js';

/**
 * The home screens' loader (journeys build plan J12): `myAttention` for the
 * customer's dashboard and each staff role's *My work*, and the desk's
 * Needs-Root queue re-pointed at the attention module.
 *
 * ## What it costs
 *
 * **A fixed number of queries, whatever the number of contracts** — the plan's
 * "one query per contract per item kind is too many for a sales user with every
 * contract". Reading a contract's attention takes three kinds of fact: the
 * contract's own rows (its revisions, its project's scope), the wizard's
 * (`loadFactsMany`, fifteen `IN` queries — the very loader the contract page
 * calls with a list of one) and the banner's earlier revisions (`pendingNeeds`
 * says which contracts need which, and they are fetched in three). On top of
 * those: the requests and their last messages (2), the tickets and theirs (2),
 * the contract-less invoices (1) and the customer's subscription catch-up (1).
 * `j12.test.ts` counts the statements and holds the count flat while the
 * number of contracts doubles; the figure it measures is in the stage record.
 *
 * What is *not* batched is `ensureDueEntriesFor`'s per-subscription loop,
 * which is the customer's own and runs only for subscriptions that have a
 * period to catch up on (the same call `myInvoices` makes).
 */

/**
 * A contract as the home screen reads it: a `select`, not an `include` — the
 * contract page's shape drags every comment, article and change-log line of
 * every contract (V4's trap T1, said again here), and the snapshot is attached
 * only to the contracts whose banner reads it. Everything the wizard's rules
 * (`WizardContract`), visibility (`ContractForVisibility`) and `pendingOf` read
 * is here, and nothing else.
 */
const homeSelect = {
  id: true,
  ref: true,
  titleFa: true,
  titleEn: true,
  customerId: true,
  projectId: true,
  sequence: true,
  status: true,
  statusChangedAt: true,
  amount: true,
  createdAt: true,
  publishedAt: true,
  deliveredAt: true,
  designerId: true,
  developerId: true,
  customer: { select: { name: true, clientName: true } },
  project: {
    select: {
      status: true,
      scopeItems: { select: { kind: true, contractId: true, originAskedAt: true, status: true, key: true } },
    },
  },
  currentContractRevision: {
    select: {
      id: true,
      version: true,
      approvedAt: true,
      contentHash: true,
      publishedAt: true,
      signature: { select: { signedAt: true } },
      amendments: {
        orderBy: { ordinal: 'asc' },
        select: { ordinal: true, publishedAt: true, approvedAt: true, signature: { select: { id: true } } },
      },
    },
  },
  currentDesignRevision: {
    select: {
      version: true,
      publishedAt: true,
      concepts: {
        orderBy: { position: 'asc' },
        select: { key: true, chosenAt: true, pages: { orderBy: { position: 'asc' }, select: { key: true, imageUrl: true, approvedAt: true } } },
      },
    },
  },
} satisfies Prisma.ContractSelect;

type HomeRow = Prisma.ContractGetPayload<{ select: typeof homeSelect }>;

/** What `pendingOf` needs of the contracts that need an earlier revision to
 *  compare against: three batched reads instead of two per contract. */
async function loadPriors(rows: HomeRow[]): Promise<{ priors: Map<string, PendingPrior>; snapshots: Map<string, unknown> }> {
  const needing = rows.map((c) => ({ c, needs: pendingNeeds({ ...c, currentContractRevision: c.currentContractRevision && { ...c.currentContractRevision, snapshot: null } }) }));
  const wantApproved = needing.filter((n) => n.needs.approvedContract);
  const wantDesign = needing.filter((n) => n.needs.previousDesignVersion !== null);

  const [approved, currentSnapshots, designs] = await Promise.all([
    wantApproved.length === 0
      ? []
      : prisma.contractRevision.findMany({
          where: { contractId: { in: wantApproved.map((n) => n.c.id) }, approvedAt: { not: null } },
          select: { contractId: true, version: true, snapshot: true },
        }),
    // The unapproved current revision's own snapshot — the one thing `pendingOf`
    // reads that the lean select left out, fetched for the contracts that read it.
    wantApproved.length === 0
      ? []
      : prisma.contractRevision.findMany({
          where: { id: { in: wantApproved.map((n) => n.c.currentContractRevision!.id) } },
          select: { id: true, snapshot: true },
        }),
    wantDesign.length === 0
      ? []
      : prisma.designRevision.findMany({
          where: { OR: wantDesign.map((n) => ({ contractId: n.c.id, version: n.needs.previousDesignVersion! })) },
          select: {
            contractId: true,
            concepts: {
              orderBy: { position: 'asc' },
              select: { key: true, chosenAt: true, pages: { orderBy: { position: 'asc' }, select: { key: true, imageUrl: true, approvedAt: true } } },
            },
          },
        }),
  ]);

  const priors = new Map<string, PendingPrior>();
  const snapshotOf = new Map(currentSnapshots.map((r) => [r.id, r.snapshot] as const));
  for (const { c } of needing) {
    const best = approved.filter((r) => r.contractId === c.id).reduce<(typeof approved)[number] | null>((a, r) => (a === null || r.version > a.version ? r : a), null);
    priors.set(c.id, {
      approvedContract: best ? { version: best.version, snapshot: best.snapshot } : null,
      previousDesign: designs.find((d) => d.contractId === c.id) ?? null,
    });
  }
  return { priors, snapshots: snapshotOf };
}

/**
 * Every contract matching `where`, with its attention input — the contract
 * page's own rule set (`attentionInputOf`) over batched rows. `now` is taken
 * once, so every contract in the list is judged against the same instant.
 */
export async function loadHomeContracts(where: Prisma.ContractWhereInput, now: Date): Promise<Array<HomeContract & { row: HomeRow }>> {
  const rows = await prisma.contract.findMany({ where, select: homeSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (rows.length === 0) return [];
  const [facts, { priors, snapshots }] = await Promise.all([loadFactsMany(rows), loadPriors(rows)]);

  return rows.map((row) => {
    const source = {
      currentContractRevision: row.currentContractRevision && {
        ...row.currentContractRevision,
        snapshot: snapshots.get(row.currentContractRevision.id) ?? null,
      },
      currentDesignRevision: row.currentDesignRevision,
    };
    const pending = pendingFactsOf(row, pendingOf(source, priors.get(row.id)!), now);
    return {
      id: row.id,
      ref: row.ref,
      titleFa: row.titleFa,
      titleEn: row.titleEn,
      customerId: row.customerId,
      customerName: row.customer.clientName ?? row.customer.name,
      sequence: row.sequence,
      status: row.status,
      publishedAt: row.publishedAt,
      deliveredAt: row.deliveredAt,
      designerId: row.designerId,
      developerId: row.developerId,
      project: { status: row.project.status },
      input: attentionInputOf(row satisfies WizardContract, facts.get(row.id)!, pending, now),
      row,
    };
  });
}

export const homeQueries = {
  /**
   * What is waiting on the caller (J12). Any signed-in account: **which
   * contracts and which items is `lib/home.ts`'s** (`homeFor`) — the ones the
   * caller owns as a customer, and the ones whose job they hold as staff, through
   * `contractVisibleToStaff` and the attention module's own visibility. What is
   * loaded here is only a *superset* of that, narrowed by where-clauses that
   * restate no rule: a staff reader of the whole book (`contracts.readAll`, or
   * `assignments.override`) loads every contract; a reader of active ones loads
   * the contracts they are the designer or developer of — and `homeFor` then
   * asks the real functions. Nobody learns anything they could not read from the
   * contract itself.
   */
  myAttention: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    const now = new Date();

    const wholeBook = can(user, 'contracts.readAll') || can(user, 'assignments.override');
    const staffWhere: Prisma.ContractWhereInput | null = wholeBook
      ? { customerId: { not: user.id } }
      : can(user, 'contracts.readActive')
        ? { deliveredAt: null, OR: [{ designerId: user.id }, { developerId: user.id }] }
        : null;
    // A customer's subscriptions come due on read (the same catch-up
    // `myInvoices` makes), so a period that has fallen due is on the list.
    await ensureDueEntriesFor(prisma, { customerId: user.id });

    const contracts = await loadHomeContracts(
      {
        status: { not: 'DISCARDED' },
        OR: [{ customerId: user.id, publishedAt: { not: null } }, ...(staffWhere ? [staffWhere] : [])],
      },
      now,
    );

    const readsRequests = can(user, 'contracts.readAll');
    const readsTickets = can(user, 'tickets.answer');
    const readsMoney = can(user, 'billing.manage') && can(user, 'money.read');
    const today = utcDayStart(now);

    const [requests, tickets, invoices] = await Promise.all([
      prisma.project.findMany({
        where: { status: 'REQUESTED', requestedAt: { not: null }, ...(readsRequests ? {} : { customerId: user.id }) },
        select: { id: true, requestTitle: true, titleEn: true, customerId: true, requestedAt: true, customer: { select: { name: true, clientName: true } } },
        orderBy: { requestedAt: 'asc' },
      }),
      prisma.ticket.findMany({
        where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, ...(readsTickets ? {} : { customerId: user.id }) },
        select: { id: true, subject: true, customerId: true, createdAt: true, customer: { select: { name: true, clientName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.billingEntry.findMany({
        where: {
          contractId: null,
          issuedAt: { not: null },
          paidAt: null,
          OR: [{ customerId: user.id }, ...(readsMoney ? [{ dueAt: { lt: today } }] : [])],
        },
        select: { id: true, customerId: true, invoiceNumber: true, issuedAt: true, dueAt: true, paidAt: true, customer: { select: { name: true, clientName: true } } },
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const [requestMessages, ticketMessages] = await Promise.all([
      requests.length === 0
        ? []
        : prisma.requestMessage.findMany({
            where: { projectId: { in: requests.map((r) => r.id) } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            distinct: ['projectId'],
            select: { projectId: true, authorId: true, createdAt: true },
          }),
      tickets.length === 0
        ? []
        : prisma.ticketMessage.findMany({
            where: { ticketId: { in: tickets.map((t) => t.id) } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            distinct: ['ticketId'],
            select: { ticketId: true, authorId: true, createdAt: true },
          }),
    ]);
    const lastRequest = new Map(requestMessages.map((m) => [m.projectId, { authorId: m.authorId, at: m.createdAt }] as const));
    const lastTicket = new Map(ticketMessages.map((m) => [m.ticketId, { authorId: m.authorId, at: m.createdAt }] as const));
    const name = (u: { name: string; clientName: string | null }) => u.clientName ?? u.name;

    const items = homeFor({
      viewer: user,
      now,
      contracts,
      requests: requests.map((r) => ({
        id: r.id,
        title: r.requestTitle ?? r.titleEn,
        customerId: r.customerId,
        customerName: name(r.customer),
        requestedAt: r.requestedAt!,
        lastMessage: lastRequest.get(r.id) ?? null,
      })),
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        customerId: t.customerId,
        customerName: name(t.customer),
        createdAt: t.createdAt,
        lastMessage: lastTicket.get(t.id) ?? null,
      })),
      accountInvoices: invoices.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        issuedAt: i.issuedAt,
        dueAt: i.dueAt,
        paidAt: i.paidAt,
        customerId: i.customerId,
        customerName: name(i.customer),
      })),
    });

    return items.map((i) => ({
      ...i,
      params: Object.entries(i.params).map(([key, value]) => ({ key, value: String(value) })),
    }));
  },

  /**
   * V4's queue, re-pointed (J12): contracts with something owed by Root, by the
   * attention module — not by `Contract.status`, which sales can set by hand and
   * which can say one thing at a time. Longest-waiting first; `since` is the
   * oldest thing owed, `count` how many things are. `contracts.readAll`, as it
   * was.
   */
  needsRootQueue: async (_p: unknown, args: { limit?: number }, ctx: Context) => {
    const user = requireCapability(ctx, 'contracts.readAll');
    const contracts = await loadHomeContracts({ status: { not: 'DISCARDED' }, deliveredAt: null }, new Date());
    const byId = new Map(contracts.map((c) => [c.id, c] as const));
    return needsRoot(user, contracts)
      .slice(0, clampLimit(args.limit, 20, 100))
      .map((e) => {
        const c = byId.get(e.contractId)!;
        return {
          contract: {
            id: c.id,
            ref: c.ref,
            titleFa: c.titleFa,
            titleEn: c.titleEn,
            status: c.status,
            statusChangedAt: c.row.statusChangedAt,
            customerName: c.row.customer.name,
          },
          since: e.since,
          count: e.count,
        };
      });
  },
};
