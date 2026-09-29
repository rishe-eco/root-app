import { GraphQLError } from 'graphql';
import type { Prisma, Project, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { clampLimit } from '../../lib/pagination.js';
import { requireUser, requireCapability, viewerOf, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { requestVisibleTo } from '../../lib/visibility.js';
import {
  acceptsMessages,
  checkArchiveReason,
  checkNewRequest,
  checkRequestMessage,
} from '../../lib/requests.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { requestMessagesPerUserPerHour, requestsPerUserPerDay } from '../../lib/rateLimit.js';
import { env } from '../../lib/env.js';

/**
 * Requests — a project before a contract (journeys build plan J2).
 *
 * A customer asks for something; it sits in their contracts list as a pending
 * row; opening it is a chat; sales archives it with a reason or converts it
 * into a contract (`createContract` with this project's id, in
 * `admin/contracts.ts`). The request is the *project* row's own columns
 * (`Project.request*`, status `REQUESTED`) and its thread is `RequestMessage`
 * — no second table for the request itself, because a request that becomes a
 * contract keeps being the same project.
 *
 * **Two audiences, one project, and the audience is the ownership edge.**
 * `requestVisibleTo` (lib/visibility.ts, house rule 3) is the one rule: the
 * customer who made it, or `contracts.readAll`. Everyone else — another
 * customer, a designer, a developer — gets `NOT_FOUND` (house rule 13), so the
 * resolver is no oracle for which project ids are requests.
 *
 * Lives outside `resolvers/admin/` for the reason `tickets.ts` and `demo.ts`
 * give: one concept with a customer half (ownership) and a staff half
 * (capability), and splitting it by actor would split the thread from its own
 * rules.
 */

const notFound = () => new GraphQLError('No such request.', { extensions: { code: 'NOT_FOUND' } });
const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });
const rateLimited = () => refuse('RATE_LIMITED', 'Too many requests. Try again later.');

/** The customer's link (portal) and the desk's link, in the recipient's own language. */
const portalUrl = (locale: string, projectId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/app/contracts?request=${projectId}`;
const deskUrl = (locale: string, projectId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/requests/${projectId}`;

/** What the desk calls a customer: their company where they have one. */
const displayName = (u: Pick<User, 'name' | 'clientName'>) => u.clientName ?? u.name;

/**
 * A request the actor may read, or `NOT_FOUND` — a missing project, a project
 * that never was a request, and someone else's request are one answer.
 */
async function loadRequestForActor(projectId: string, user: User): Promise<Project> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || !requestVisibleTo(user, project)) throw notFound();
  return project;
}

export const requestQueries = {
  /**
   * The customer's own requests that the contracts list must still show: a
   * pending one, an archived one (with its reason), and a converted one whose
   * contract they cannot open yet (sales is still drawing it up — without this
   * the row would vanish at the moment of conversion and reappear as a contract
   * days later, which reads as a request lost). Once a contract on the project
   * is published, the contract is the row and the thread is linked from it.
   */
  myRequests: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.project.findMany({
      where: {
        customerId: user.id,
        requestedAt: { not: null },
        OR: [
          { status: { in: ['REQUESTED', 'ARCHIVED'] } },
          { status: 'ACTIVE', contracts: { none: { publishedAt: { not: null } } } },
        ],
      },
      orderBy: { requestedAt: 'desc' },
    });
  },

  /** Staff (contracts.readAll) — the sales inbox. */
  allRequests: async (_p: unknown, args: { status?: Project['status'] | null; limit?: number | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.readAll');
    return prisma.project.findMany({
      where: { requestedAt: { not: null }, ...(args.status ? { status: args.status } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: clampLimit(args.limit, 100, 200),
    });
  },

  request: async (_p: unknown, args: { projectId: string }, ctx: Context) =>
    loadRequestForActor(args.projectId, requireUser(ctx)),
};

export const requestMutations = {
  /**
   * Any signed-in account can ask — the request belongs to whoever made it
   * (`customerId`), and ownership, not a role, is what later reads check
   * (house rules 1 and 2). `titleFa` and `titleEn` are placeholders holding
   * the customer's own title; sales replaces both at conversion.
   */
  submitRequest: async (_p: unknown, args: { title: string; body: string; lang: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const refusal = checkNewRequest(args);
    if (refusal) throw refuse(refusal, 'That request cannot be submitted.');
    // After validation, so a malformed request does not spend the budget.
    if (!requestsPerUserPerDay.check(user.id)) throw rateLimited();

    const title = args.title.trim();
    const project = await prisma.project.create({
      data: {
        customerId: user.id,
        titleFa: title,
        titleEn: title,
        status: 'REQUESTED',
        requestTitle: title,
        requestBody: args.body.trim(),
        requestLang: args.lang,
        requestedAt: new Date(),
      },
    });

    // Every account that can answer one — found by capability (J1's router
    // never throws, so a failed send cannot fail the submission).
    const recipients = await recipientsHolding('contracts.author');
    await Promise.all(
      recipients
        .filter((r) => r.id !== user.id)
        .map((r) =>
          notify(r, {
            kind: 'REQUEST_SUBMITTED',
            params: {
              recipientName: r.name,
              customerName: displayName(user),
              requestTitle: title,
              deskUrl: deskUrl(r.locale, project.id),
            },
          }),
        ),
    );
    return project;
  },

  /**
   * The project's customer, or a `contracts.author`. **The order of the
   * refusals is the point**: a request the caller cannot see is `NOT_FOUND`
   * whoever they are (another customer, a designer); one they can see but may
   * not write to is `FORBIDDEN`; and only then does the thread's own state
   * speak — `REQUEST_CLOSED` once the request is archived or converted, when
   * the conversation has moved on and what was said stays as it was.
   */
  postRequestMessage: async (_p: unknown, args: { projectId: string; body: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const project = await loadRequestForActor(args.projectId, user);
    const isCustomer = project.customerId === user.id;
    if (!isCustomer && !can(user, 'contracts.author')) {
      throw refuse('FORBIDDEN', 'You do not have access to that.');
    }
    if (!acceptsMessages(project.status)) {
      throw refuse('REQUEST_CLOSED', 'This request is closed; its thread is read-only.');
    }
    const refusal = checkRequestMessage(args.body);
    if (refusal) throw refuse(refusal, 'That message cannot be posted.');
    if (!requestMessagesPerUserPerHour.check(user.id)) throw rateLimited();

    // Re-checked in the write, under a row lock: two people acting at once
    // (sales archiving as the customer replies) must not leave a message on a
    // closed thread. `archiveRequest`'s conditional UPDATE waits on this lock,
    // so whichever commits first wins cleanly and the other sees its result.
    const created = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status" FROM "Project" WHERE "id" = ${project.id} FOR UPDATE`;
      if (rows[0]?.status !== 'REQUESTED') return false;
      await tx.requestMessage.create({ data: { projectId: project.id, authorId: user.id, body: args.body.trim() } });
      return true;
    });
    if (!created) throw refuse('REQUEST_CLOSED', 'This request is closed; its thread is read-only.');

    // The other side. A customer writing tells sales; sales writing tells the
    // customer. Never the writer — an ADMIN answering their own request does
    // not need to be told.
    const title = project.requestTitle ?? project.titleEn;
    if (isCustomer) {
      const recipients = await recipientsHolding('contracts.author');
      await Promise.all(
        recipients
          .filter((r) => r.id !== user.id)
          .map((r) =>
            notify(r, {
              kind: 'REQUEST_MESSAGE',
              params: { recipientName: r.name, requestTitle: title, url: deskUrl(r.locale, project.id) },
            }),
          ),
      );
    } else {
      const customer = await prisma.user.findUniqueOrThrow({ where: { id: project.customerId } });
      await notify(customer, {
        kind: 'REQUEST_MESSAGE',
        params: {
          recipientName: customer.name,
          requestTitle: title,
          url: portalUrl(customer.locale, project.id),
        },
      });
    }
    return prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  },

  /**
   * `contracts.author`. The capability is checked first, so someone without
   * it learns nothing about which ids are requests. The status flip is one
   * conditional `UPDATE … WHERE status = 'REQUESTED'`: archiving something
   * that was converted a moment ago (or archived by a colleague) writes
   * nothing and answers `REQUEST_CLOSED`, rather than reading a stale status
   * and overwriting a conversion.
   */
  archiveRequest: async (_p: unknown, args: { projectId: string; reason: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.author');
    const project = await loadRequestForActor(args.projectId, admin);
    const refusal = checkArchiveReason(args.reason);
    if (refusal) throw refuse(refusal, 'That request cannot be archived.');

    const reason = args.reason.trim();
    const { count } = await prisma.project.updateMany({
      where: { id: project.id, status: 'REQUESTED' },
      data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason, archivedById: admin.id },
    });
    if (count === 0) throw refuse('REQUEST_CLOSED', 'This request is already closed.');

    const customer = await prisma.user.findUniqueOrThrow({ where: { id: project.customerId } });
    await notify(customer, {
      kind: 'REQUEST_ARCHIVED',
      params: {
        customerName: customer.name,
        requestTitle: project.requestTitle ?? project.titleEn,
        reason,
        portalUrl: portalUrl(customer.locale, project.id),
      },
    });
    return prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  },
};

/**
 * The `Request` type over a `Project` row. `title`, `body` and `lang` are the
 * request's own columns under their plain names; the nullable-in-the-database
 * ones are non-null here because `requestVisibleTo` (every path in) only ever
 * lets a row with `requestedAt` set through.
 */
export const Request = {
  title: (p: Project) => p.requestTitle ?? p.titleEn,
  body: (p: Project) => p.requestBody ?? '',
  lang: (p: Project) => p.requestLang ?? 'fa',

  customer: (p: Project) => prisma.user.findUniqueOrThrow({ where: { id: p.customerId } }),

  messages: (p: Project) =>
    prisma.requestMessage.findMany({
      where: { projectId: p.id },
      include: { author: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),

  /**
   * The contract this request became. "The earliest on the project" is exact
   * here rather than a shortcut: only a `REQUESTED` project converts, so the
   * contract that ended the request is the project's first. Viewer-aware — a
   * customer is only pointed at one they can open (published).
   */
  contractId: async (p: Project, _a: unknown, ctx: Context) => {
    // `viewerOf`, not `requireUser` (J3): this field is reached through
    // `Contract.request`, so under "view as customer" it must answer as the
    // customer would be answered.
    const user = viewerOf(ctx);
    const where: Prisma.ContractWhereInput = {
      projectId: p.id,
      ...(can(user, 'contracts.readAll') ? {} : { publishedAt: { not: null } }),
    };
    const contract = await prisma.contract.findFirst({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return contract?.id ?? null;
  },
};
