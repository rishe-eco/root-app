import { GraphQLError } from 'graphql';
import { DateTimeResolver } from 'graphql-scalars';
import type { ChangeAction, ContractStatus, Prisma, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import {
  requireUser,
  requireRole,
  setSessionCookie,
  clearSessionCookie,
  type Context,
} from '../context.js';
import { signSession, newLinkToken, hashToken } from '../auth/tokens.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { computeGate, assertCanApproveContract, assertCanSign } from '../lib/gate.js';

/** Everything the detail screen needs, in one shape, fetched once. */
const contractInclude = {
  customer: true,
  concepts: { include: { pages: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
  scopeItems: { orderBy: { position: 'asc' } },
  articles: { orderBy: { number: 'asc' } },
  comments: { include: { author: true }, orderBy: { createdAt: 'asc' } },
  changeLogs: { include: { actor: true }, orderBy: { createdAt: 'desc' } },
  signature: { include: { signer: true } },
} satisfies Prisma.ContractInclude;

type FullContract = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

const loadContract = (id: string) =>
  prisma.contract.findUnique({ where: { id }, include: contractInclude });

/**
 * A customer may only ever touch their own contract, and only after Root has
 * published it. Admins see everything.
 */
async function loadForActor(id: string, user: User): Promise<FullContract> {
  const contract = await loadContract(id);
  if (!contract) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (user.role === 'ADMIN') return contract;
  if (contract.customerId !== user.id || contract.publishedAt === null) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  return contract;
}

async function log(
  contractId: string,
  actorId: string,
  action: ChangeAction,
  arg?: string | null,
) {
  await prisma.changeLog.create({ data: { contractId, actorId, action, arg: arg ?? null } });
}

/**
 * Automatic transitions are defaults, not rails (v3 §8) — Root can always
 * override with setContractStatus. Terminal states are left alone.
 */
async function nudgeStatus(contract: FullContract, next: ContractStatus) {
  if (contract.status === 'DONE' || contract.status === 'DISCARDED') return;
  if (contract.status === next) return;
  await prisma.contract.update({ where: { id: contract.id }, data: { status: next } });
}

const reload = async (id: string) => (await loadContract(id))!;

export const resolvers = {
  DateTime: DateTimeResolver,

  Contract: {
    // BigInt does not survive JSON; Toman amounts cross the wire as strings.
    amount: (c: FullContract) => (c.amount === null ? null : c.amount.toString()),
    gate: (c: FullContract) => computeGate(c),
    changeLog: (c: FullContract) => c.changeLogs,
  },

  DesignConcept: {
    chosen: (c: { chosenAt: Date | null }) => c.chosenAt !== null,
  },

  PageDesign: {
    approved: (p: { approvedAt: Date | null }) => p.approvedAt !== null,
  },

  ScopeItem: {
    checked: (s: { checkedAt: Date | null }) => s.checkedAt !== null,
  },

  Query: {
    me: (_p: unknown, _a: unknown, ctx: Context) => ctx.user,

    myContracts: async (_p: unknown, args: { status?: ContractStatus }, ctx: Context) => {
      const user = requireUser(ctx);
      return prisma.contract.findMany({
        where: {
          customerId: user.id,
          publishedAt: { not: null },
          ...(args.status ? { status: args.status } : {}),
        },
        include: contractInclude,
        orderBy: { updatedAt: 'desc' },
      });
    },

    contractStatusCounts: async (_p: unknown, _a: unknown, ctx: Context) => {
      const user = requireUser(ctx);
      const grouped = await prisma.contract.groupBy({
        by: ['status'],
        where: { customerId: user.id, publishedAt: { not: null } },
        _count: { _all: true },
      });
      return grouped.map((g) => ({ status: g.status, count: g._count._all }));
    },

    contract: async (_p: unknown, args: { id: string }, ctx: Context) =>
      loadForActor(args.id, requireUser(ctx)),

    allContracts: async (_p: unknown, _a: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return prisma.contract.findMany({ include: contractInclude, orderBy: { updatedAt: 'desc' } });
    },

    allCustomers: async (_p: unknown, _a: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return prisma.user.findMany({ where: { role: 'CUSTOMER' }, orderBy: { createdAt: 'desc' } });
    },
  },

  Mutation: {
    // ---- auth ------------------------------------------------------------

    signIn: async (_p: unknown, args: { email: string; password: string }, ctx: Context) => {
      const user = await prisma.user.findUnique({
        where: { email: args.email.trim().toLowerCase() },
      });
      // One message for both branches — never reveal which accounts exist.
      const bad = () =>
        new GraphQLError('That email and password do not match.', {
          extensions: { code: 'BAD_CREDENTIALS' },
        });

      if (!user || !user.passwordHash || user.state !== 'ACTIVE') throw bad();
      if (!(await verifyPassword(args.password, user.passwordHash))) throw bad();

      setSessionCookie(ctx.res, signSession({ sub: user.id, role: user.role }));
      return { user };
    },

    signOut: (_p: unknown, _a: unknown, ctx: Context) => {
      clearSessionCookie(ctx.res);
      return true;
    },

    acceptInvite: async (
      _p: unknown,
      args: { token: string; name: string; password: string },
      ctx: Context,
    ) => {
      if (args.password.length < MIN_PASSWORD_LENGTH) {
        throw new GraphQLError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, {
          extensions: { code: 'PASSWORD_TOO_SHORT' },
        });
      }
      const record = await prisma.authToken.findUnique({
        where: { tokenHash: hashToken(args.token) },
        include: { user: true },
      });
      if (
        !record ||
        record.purpose !== 'INVITE' ||
        record.usedAt ||
        record.revokedAt ||
        record.expiresAt < new Date()
      ) {
        throw new GraphQLError('This link is no longer valid.', {
          extensions: { code: 'TOKEN_INVALID' },
        });
      }

      const [user] = await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: {
            name: args.name.trim() || record.user.name,
            passwordHash: await hashPassword(args.password),
            state: 'ACTIVE',
          },
        }),
        prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      ]);

      setSessionCookie(ctx.res, signSession({ sub: user.id, role: user.role }));
      return { user };
    },

    requestPasswordReset: async (_p: unknown, args: { email: string }) => {
      const user = await prisma.user.findUnique({
        where: { email: args.email.trim().toLowerCase() },
      });
      // Always true: whether the address has an account is not ours to leak.
      if (!user || user.state !== 'ACTIVE') return true;

      const { raw, hash } = newLinkToken();
      const expiresAt = new Date(Date.now() + env.RESET_HOURS * 60 * 60 * 1000);
      await prisma.authToken.create({
        data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: hash, expiresAt },
      });

      // TODO(email): no mail provider is wired yet, so the link is logged for
      // an operator to pass on by hand. Swap this for the provider call.
      console.info(
        `[reset] ${user.email} -> ${env.APP_ORIGIN}/${user.locale}/portal/reset/${raw}`,
      );
      return true;
    },

    resetPassword: async (
      _p: unknown,
      args: { token: string; password: string },
      ctx: Context,
    ) => {
      if (args.password.length < MIN_PASSWORD_LENGTH) {
        throw new GraphQLError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, {
          extensions: { code: 'PASSWORD_TOO_SHORT' },
        });
      }
      const record = await prisma.authToken.findUnique({
        where: { tokenHash: hashToken(args.token) },
      });
      if (
        !record ||
        record.purpose !== 'PASSWORD_RESET' ||
        record.usedAt ||
        record.revokedAt ||
        record.expiresAt < new Date()
      ) {
        throw new GraphQLError('This link is no longer valid.', {
          extensions: { code: 'TOKEN_INVALID' },
        });
      }

      const [user] = await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash: await hashPassword(args.password), state: 'ACTIVE' },
        }),
        prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      ]);

      setSessionCookie(ctx.res, signSession({ sub: user.id, role: user.role }));
      return { user };
    },

    // ---- customer actions -------------------------------------------------

    chooseConcept: async (
      _p: unknown,
      args: { contractId: string; conceptId: string },
      ctx: Context,
    ) => {
      const user = requireUser(ctx);
      const contract = await loadForActor(args.contractId, user);
      const concept = contract.concepts.find((c) => c.id === args.conceptId);
      if (!concept) {
        throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
      }
      if (contract.contractApprovedAt) {
        throw new GraphQLError('The contract is already approved.', {
          extensions: { code: 'ALREADY_APPROVED' },
        });
      }

      // Choosing a different concept resets the page approvals beneath it —
      // approving pages of a design you then abandoned would be meaningless.
      await prisma.$transaction([
        prisma.designConcept.updateMany({
          where: { contractId: contract.id },
          data: { chosenAt: null },
        }),
        prisma.pageDesign.updateMany({
          where: { concept: { contractId: contract.id } },
          data: { approvedAt: null },
        }),
        prisma.designConcept.update({
          where: { id: concept.id },
          data: { chosenAt: new Date() },
        }),
      ]);

      await log(contract.id, user.id, 'CHOSE_CONCEPT', concept.key);
      return reload(contract.id);
    },

    setPageApproval: async (
      _p: unknown,
      args: { pageDesignId: string; approved: boolean },
      ctx: Context,
    ) => {
      const user = requireUser(ctx);
      const page = await prisma.pageDesign.findUnique({
        where: { id: args.pageDesignId },
        include: { concept: true },
      });
      if (!page) {
        throw new GraphQLError('No such page design.', { extensions: { code: 'NOT_FOUND' } });
      }
      const contract = await loadForActor(page.concept.contractId, user);
      if (contract.contractApprovedAt) {
        throw new GraphQLError('The contract is already approved.', {
          extensions: { code: 'ALREADY_APPROVED' },
        });
      }
      if (page.concept.chosenAt === null) {
        throw new GraphQLError('Choose this concept before approving its pages.', {
          extensions: { code: 'CONCEPT_NOT_CHOSEN' },
        });
      }

      await prisma.pageDesign.update({
        where: { id: page.id },
        data: { approvedAt: args.approved ? new Date() : null },
      });
      await log(
        contract.id,
        user.id,
        args.approved ? 'APPROVED_PAGE' : 'UNAPPROVED_PAGE',
        page.key,
      );

      const after = await reload(contract.id);
      const gateBefore = computeGate(contract);
      const gateAfter = computeGate(after);
      if (!gateBefore.designComplete && gateAfter.designComplete) {
        await log(contract.id, user.id, 'DESIGN_COMPLETE');
        await nudgeStatus(after, 'WAITING_ON_ROOT');
        return reload(contract.id);
      }
      return after;
    },

    approveContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
      const user = requireUser(ctx);
      const contract = await loadForActor(args.contractId, user);
      assertCanApproveContract(contract);

      await prisma.contract.update({
        where: { id: contract.id },
        data: { contractApprovedAt: new Date() },
      });
      await log(contract.id, user.id, 'APPROVED_CONTRACT');
      return reload(contract.id);
    },

    setScopeItem: async (
      _p: unknown,
      args: { scopeItemId: string; checked: boolean },
      ctx: Context,
    ) => {
      const user = requireUser(ctx);
      const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
      if (!item) {
        throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
      }
      const contract = await loadForActor(item.contractId, user);

      // Never gated — the checklist stays editable at every stage.
      await prisma.scopeItem.update({
        where: { id: item.id },
        data: { checkedAt: args.checked ? new Date() : null },
      });
      await log(contract.id, user.id, args.checked ? 'SCOPE_ON' : 'SCOPE_OFF', item.key);
      return reload(contract.id);
    },

    signContract: async (
      _p: unknown,
      args: { contractId: string; typedName: string },
      ctx: Context,
    ) => {
      const user = requireUser(ctx);
      const contract = await loadForActor(args.contractId, user);
      assertCanSign(contract);

      const typedName = args.typedName.trim();
      if (typedName.length < 2) {
        throw new GraphQLError('Type your full name to sign.', {
          extensions: { code: 'NAME_TOO_SHORT' },
        });
      }

      await prisma.signature.create({
        data: {
          contractId: contract.id,
          signerId: user.id,
          typedName,
          ip: ctx.req.ip ?? null,
          userAgent: ctx.req.get('user-agent') ?? null,
        },
      });
      await log(contract.id, user.id, 'SIGNED');

      // Approved & signed -> the build is live. A default, not a rail.
      await nudgeStatus(contract, 'IN_PROGRESS');
      return reload(contract.id);
    },

    addComment: async (
      _p: unknown,
      args: { contractId: string; body: string; target?: 'DESIGN' | 'CONTRACT' },
      ctx: Context,
    ) => {
      const user = requireUser(ctx);
      const contract = await loadForActor(args.contractId, user);
      const body = args.body.trim();
      if (!body) {
        throw new GraphQLError('Write something first.', { extensions: { code: 'EMPTY_COMMENT' } });
      }

      // Commenting is free at every stage, whatever the gate says.
      await prisma.comment.create({
        data: {
          contractId: contract.id,
          authorId: user.id,
          body,
          target: args.target ?? 'CONTRACT',
        },
      });
      await log(contract.id, user.id, 'COMMENTED');

      // A customer comment puts the ball in Root's court.
      if (user.role === 'CUSTOMER') await nudgeStatus(contract, 'WAITING_ON_ROOT');
      else await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');

      return reload(contract.id);
    },

    // ---- minimal operational admin ---------------------------------------

    inviteCustomer: async (
      _p: unknown,
      args: { email: string; name: string; clientName?: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const email = args.email.trim().toLowerCase();

      const user = await prisma.user.upsert({
        where: { email },
        create: { email, name: args.name.trim(), clientName: args.clientName ?? null },
        update: { name: args.name.trim(), clientName: args.clientName ?? null },
      });
      if (user.state === 'ACTIVE') {
        throw new GraphQLError('That account is already active.', {
          extensions: { code: 'ALREADY_ACTIVE' },
        });
      }

      const { raw, hash } = newLinkToken();
      const expiresAt = new Date(Date.now() + env.INVITE_DAYS * 24 * 60 * 60 * 1000);
      await prisma.authToken.create({
        data: { userId: user.id, purpose: 'INVITE', tokenHash: hash, expiresAt },
      });

      // No mail provider yet: the link is returned once, here, for Root to
      // pass on. It cannot be read again.
      const inviteUrl = `${env.APP_ORIGIN}/${user.locale}/portal/invite/${raw}`;
      return { userId: user.id, email: user.email, inviteUrl, expiresAt };
    },

    revokeInvite: async (_p: unknown, args: { userId: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      await prisma.authToken.updateMany({
        where: { userId: args.userId, purpose: 'INVITE', usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    },

    createContract: async (
      _p: unknown,
      args: {
        input: {
          customerId: string;
          ref: string;
          titleFa: string;
          titleEn: string;
          amount?: string;
        };
      },
      ctx: Context,
    ) => {
      const admin = requireRole(ctx, 'ADMIN');
      const { input } = args;
      const contract = await prisma.contract.create({
        data: {
          customerId: input.customerId,
          ref: input.ref,
          titleFa: input.titleFa,
          titleEn: input.titleEn,
          amount: input.amount ? BigInt(input.amount) : null,
        },
      });
      await log(contract.id, admin.id, 'CREATED');
      return reload(contract.id);
    },

    addConcept: async (
      _p: unknown,
      args: {
        contractId: string;
        key: string;
        labelFa: string;
        labelEn: string;
        imageUrl?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const count = await prisma.designConcept.count({ where: { contractId: args.contractId } });
      await prisma.designConcept.create({
        data: {
          contractId: args.contractId,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          imageUrl: args.imageUrl ?? null,
          position: count,
        },
      });
      return reload(args.contractId);
    },

    addPageDesign: async (
      _p: unknown,
      args: {
        conceptId: string;
        key: string;
        labelFa: string;
        labelEn: string;
        imageUrl?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const concept = await prisma.designConcept.findUnique({ where: { id: args.conceptId } });
      if (!concept) {
        throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
      }
      const count = await prisma.pageDesign.count({ where: { conceptId: concept.id } });
      await prisma.pageDesign.create({
        data: {
          conceptId: concept.id,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          imageUrl: args.imageUrl ?? null,
          position: count,
        },
      });
      return reload(concept.contractId);
    },

    addScopeItem: async (
      _p: unknown,
      args: { contractId: string; key: string; labelFa: string; labelEn: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const count = await prisma.scopeItem.count({ where: { contractId: args.contractId } });
      await prisma.scopeItem.create({
        data: {
          contractId: args.contractId,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          position: count,
        },
      });
      return reload(args.contractId);
    },

    setArticle: async (
      _p: unknown,
      args: {
        contractId: string;
        number: number;
        titleFa: string;
        titleEn: string;
        bodyFa?: string;
        bodyEn?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const { contractId, number, ...rest } = args;
      await prisma.article.upsert({
        where: { contractId_number: { contractId, number } },
        create: { contractId, number, ...rest },
        update: rest,
      });
      return reload(contractId);
    },

    publishContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
      const admin = requireRole(ctx, 'ADMIN');
      const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
      if (!contract) {
        throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
      }
      if (contract.publishedAt) return reload(contract.id);

      await prisma.contract.update({
        where: { id: contract.id },
        data: { publishedAt: new Date(), status: 'WAITING_ON_CUSTOMER' },
      });
      await log(contract.id, admin.id, 'PUBLISHED');
      return reload(contract.id);
    },

    setContractStatus: async (
      _p: unknown,
      args: { contractId: string; status: ContractStatus },
      ctx: Context,
    ) => {
      const admin = requireRole(ctx, 'ADMIN');
      // Permissive on purpose: from almost any status to almost any other,
      // with a manual override always available.
      await prisma.contract.update({
        where: { id: args.contractId },
        data: { status: args.status },
      });
      await log(args.contractId, admin.id, 'STATUS_CHANGED', args.status);
      return reload(args.contractId);
    },
  },
};
