import { GraphQLError } from 'graphql';
import type { Prisma, TicketStatus, TicketType, TicketUrgency } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, requireCapability, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { canChooseTicketType, briefPageFromTarget, compileAnnotation } from '../../lib/ticket.js';
import { lockContract } from '../../lib/stepApproval.js';
import { stepNamesFor } from '../../lib/mailTemplates.js';
import { feedbackItemInclude } from './feedback.js';

/**
 * Tickets and the three channels (build plan L4; spec §5, §6) — surfaces the
 * as-built `Ticket`/`TicketMessage` models, modelled since the first
 * migration and unreachable from the API until now.
 *
 * Lives outside `resolvers/admin/` on purpose, same reasoning as
 * `resolvers/demo.ts` and `resolvers/feedback.ts`: a customer reads and
 * replies to their *own* tickets (ownership, house rule 2), while staff read
 * every ticket, move it between channels, and convert a ratified feedback
 * item into one (capability). One file, because both halves are the same
 * concept — never a reason to split by actor the way `resolvers/admin/`
 * splits by domain.
 */

export const ticketInclude = {
  customer: true,
  project: true,
  sourceFeedbackItem: { include: feedbackItemInclude },
  messages: { orderBy: { createdAt: 'asc' as const }, include: { author: true } },
} satisfies Prisma.TicketInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/**
 * Staff, or the ticket's own customer — never a role test (house rule 2).
 * Same "no such thing, not 'not allowed'" shape `loadDemoForActor` already
 * uses (house rule 13): a ticket belonging to someone else is indistinguishable
 * from one that does not exist.
 */
async function loadTicketForActor(ticketId: string, user: { id: string; roles: unknown[] }) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: ticketInclude });
  if (!ticket) throw notFound('ticket');
  const staff = can(user as Parameters<typeof can>[0], 'tickets.answer');
  if (!staff && ticket.customerId !== user.id) throw notFound('ticket');
  return ticket;
}

export const ticketQueries = {
  /** The caller's own tickets, newest first. */
  myTickets: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.ticket.findMany({
      where: { customerId: user.id },
      include: ticketInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Staff (tickets.answer). Every ticket, optionally filtered — the support desk's own queue. */
  allTickets: async (
    _p: unknown,
    args: { status?: TicketStatus | null; type?: TicketType | null; projectId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'tickets.answer');
    return prisma.ticket.findMany({
      where: {
        ...(args.status ? { status: args.status } : {}),
        ...(args.type ? { type: args.type } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      include: ticketInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Staff (tickets.answer). Build plan L4, spec §10.2: the only input to
   * the parked business decision on whether site administration becomes a
   * product. Counts every ADMIN_REQUEST ticket regardless of its current
   * status — the signal this exists for is demand, not an open backlog.
   */
  adminRequestCount: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'tickets.answer');
    return prisma.ticket.count({ where: { type: 'ADMIN_REQUEST' } });
  },
};

export const ticketMutations = {
  /**
   * The customer's own support intake — the portal's `support` rail goes
   * live (build plan L4). Always creates the ticket under the caller's own
   * account; there is no "log a ticket for someone else" mutation here, the
   * same gap L1 left `inviteDeveloper` with (no generic on-behalf-of act
   * exists anywhere in this codebase yet).
   *
   * `type` may not be ADMIN_REQUEST for a non-staff caller (INVALID_TICKET_TYPE)
   * — see lib/ticket.ts's canChooseTicketType for why.
   */
  createTicket: async (
    _p: unknown,
    args: { type: TicketType; subject: string; body: string; urgency?: TicketUrgency | null; projectId?: string | null },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const staff = can(user, 'tickets.answer');
    if (!canChooseTicketType(staff, args.type)) {
      throw new GraphQLError('Only staff may file a ticket directly as an admin request.', {
        extensions: { code: 'INVALID_TICKET_TYPE' },
      });
    }

    const subject = args.subject.trim();
    if (!subject) throw new GraphQLError('A ticket needs a subject.', { extensions: { code: 'EMPTY_SUBJECT' } });
    const body = args.body.trim();
    if (!body) throw new GraphQLError('A ticket needs a first message.', { extensions: { code: 'EMPTY_COMMENT' } });

    let projectId: string | null = null;
    if (args.projectId) {
      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project || (!staff && project.customerId !== user.id)) throw notFound('project');
      projectId = project.id;
    }

    const ticket = await prisma.ticket.create({
      data: {
        customerId: user.id,
        projectId,
        type: args.type,
        urgency: args.urgency ?? 'NOT_URGENT',
        subject,
        messages: { create: { authorId: user.id, body } },
      },
      include: ticketInclude,
    });
    return ticket;
  },

  /** Staff, or the ticket's own customer (house rule 2). */
  addTicketMessage: async (_p: unknown, args: { ticketId: string; body: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const ticket = await loadTicketForActor(args.ticketId, user);
    const body = args.body.trim();
    if (!body) throw new GraphQLError('A message needs a body.', { extensions: { code: 'EMPTY_COMMENT' } });

    await prisma.ticketMessage.create({ data: { ticketId: ticket.id, authorId: user.id, body } });
    return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude });
  },

  /** Staff (tickets.answer). */
  setTicketStatus: async (_p: unknown, args: { ticketId: string; status: TicketStatus }, ctx: Context) => {
    requireCapability(ctx, 'tickets.answer');
    const ticket = await prisma.ticket.findUnique({ where: { id: args.ticketId } });
    if (!ticket) throw notFound('ticket');
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: args.status } });
    return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude });
  },

  /** Staff (tickets.answer). */
  setTicketUrgency: async (_p: unknown, args: { ticketId: string; urgency: TicketUrgency }, ctx: Context) => {
    requireCapability(ctx, 'tickets.answer');
    const ticket = await prisma.ticket.findUnique({ where: { id: args.ticketId } });
    if (!ticket) throw notFound('ticket');
    await prisma.ticket.update({ where: { id: ticket.id }, data: { urgency: args.urgency } });
    return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude });
  },

  /**
   * Staff (tickets.answer). Only ever flips the flag — the BillingEntry
   * edge this schema comment describes is L6's to build, not this stage's
   * (build plan L4's second banked trap: building it here means building it
   * twice).
   */
  setTicketBillable: async (_p: unknown, args: { ticketId: string; billable: boolean }, ctx: Context) => {
    requireCapability(ctx, 'tickets.answer');
    const ticket = await prisma.ticket.findUnique({ where: { id: args.ticketId } });
    if (!ticket) throw notFound('ticket');
    await prisma.ticket.update({ where: { id: ticket.id }, data: { billable: args.billable } });
    return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude });
  },

  /**
   * Staff (tickets.answer). Moving a ticket between channels is a
   * first-class action (spec §5), not a copy-paste that would lose its
   * message history — this updates the row in place. A "move" to the
   * channel it is already in is accepted rather than refused, matching this
   * codebase's general preference for idempotent admin actions over a
   * pedantic NO_OP error.
   */
  moveTicketChannel: async (_p: unknown, args: { ticketId: string; type: TicketType }, ctx: Context) => {
    requireCapability(ctx, 'tickets.answer');
    const ticket = await prisma.ticket.findUnique({ where: { id: args.ticketId } });
    if (!ticket) throw notFound('ticket');
    await prisma.ticket.update({ where: { id: ticket.id }, data: { type: args.type } });
    return prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude });
  },

  /**
   * "A ratified feedback item becomes a change ticket — it is the brief"
   * (build plan L4; spec §5, §6). Refused (NOT_RATIFIED) unless the item is
   * currently RATIFIED — D3's own gate, applied here exactly as L3b applied
   * it to `declareBuild`: an unratified item is still just an opinion.
   * Refused (ALREADY_CONVERTED) if a ticket already exists for it — the
   * unique `sourceFeedbackItemId` is the backstop.
   *
   * `currentState`/`desiredState` are written by whoever performs the
   * conversion, not auto-generated — see docs/development/L4.md for why.
   * `briefPageFa`/`briefPageEn`/`briefAnnotation` *are* auto-compiled: they
   * are facts already in hand (the target's own label, the comment thread
   * verbatim), not synthesis.
   */
  createTicketFromFeedback: async (
    _p: unknown,
    args: { itemId: string; currentState: string; desiredState: string; lang: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'tickets.answer');
    const item = await prisma.feedbackItem.findUnique({
      where: { id: args.itemId },
      include: {
        demoPage: true,
        frameLine: true,
        anchorScopeItem: true,
        ticket: true,
        project: { include: { customer: true } },
      },
    });
    if (!item) throw notFound('feedback item');
    if (item.ticket) {
      throw new GraphQLError('This item has already been converted to a ticket.', {
        extensions: { code: 'ALREADY_CONVERTED' },
      });
    }
    // S2: a submission is its own ratification (PD-2), so what makes an item
    // convertible is that it is still open — Root's answer is what it turns
    // into, and an item already answered, declined or accepted is not a
    // request for change any more (the customer reopens it first).
    if (item.status !== 'OPEN') {
      throw new GraphQLError('Only an open item can become a change ticket.', {
        extensions: { code: 'NOT_OPEN' },
      });
    }

    const currentState = args.currentState.trim();
    if (!currentState) {
      throw new GraphQLError('The current state needs a description.', { extensions: { code: 'CURRENT_STATE_REQUIRED' } });
    }
    const desiredState = args.desiredState.trim();
    if (!desiredState) {
      throw new GraphQLError('The desired state needs a description.', { extensions: { code: 'DESIRED_STATE_REQUIRED' } });
    }
    if (args.lang !== 'fa' && args.lang !== 'en') {
      throw new GraphQLError('lang must be "fa" or "en".', { extensions: { code: 'INVALID_LANG' } });
    }

    const comments = await prisma.feedbackComment.findMany({
      where: { feedbackItemId: item.id },
      orderBy: { createdAt: 'asc' },
      include: { author: true },
    });
    const page = briefPageFromTarget({ ...item, generalStepName: item.general ? stepNamesFor(item.step) : null });
    const project = item.project;
    const customer = project.customer;

    // The ticket and the item's new status are one act: an item that is
    // MOVED without a ticket, or a ticket whose item is still open in the
    // build queue, are both the silent half-states this stage exists to close.
    return prisma.$transaction(async (tx) => {
      await lockContract(tx, item.contractId);
      const ticket = await tx.ticket.create({
        data: {
          customerId: customer.id,
          projectId: project.id,
          sourceFeedbackItemId: item.id,
          type: 'CHANGE_REQUEST',
          subject: (customer.locale === 'en' ? page.en : page.fa) || page.fa || page.en,
          briefPageFa: page.fa,
          briefPageEn: page.en,
          briefAnnotation: compileAnnotation(comments),
          briefCurrentState: currentState,
          briefDesiredState: desiredState,
          briefLang: args.lang,
        },
        include: ticketInclude,
      });
      // §3.1 / S2: a resolution the customer sees ("moved to change request
      // #…"), which also takes the item out of the build queue by the one
      // definition of open — and which the customer can still reopen.
      await tx.feedbackItem.update({ where: { id: item.id }, data: { status: 'MOVED', addressedInBuildId: null } });
      return ticket;
    });
  },
};
