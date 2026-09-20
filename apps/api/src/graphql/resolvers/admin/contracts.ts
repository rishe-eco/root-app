import { GraphQLError } from 'graphql';
import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { draftState } from '../../../lib/revision.js';
import { agreedScopeSnapshot } from '../../../lib/scope.js';
import { ARTICLES, SCOPE, CHECKLIST } from '../../../lib/templates.js';
import { loadContract, log, nudgeStatus, reload } from '../contracts.js';
import { asConcurrentPublish } from './shared.js';

/**
 * The contract draft (title, fee, articles) and its publish path, plus
 * project/contract creation. Part of the L1 split of the former `admin.ts`;
 * see `index.ts`.
 */
export const contractAdminMutations = {
  /**
   * Creates the project alongside the contract (build plan D1 / L1): L1 does
   * not build the screens that produce a project *before* a contract exists
   * (lifecycle spec §4 stages 1-2), so every contract gets one project of its
   * own here rather than requiring a separate "create project" step first. A
   * project spanning more than one contract (the wedge's design-then-build
   * pair, ADR 0001) is a schema-supported shape this mutation does not yet
   * offer a way to reach — see docs/development/L1.md.
   *
   * The completeness checklist (spec §3) is seeded on the project here, all
   * DECLINED, so a hole like Nahal's missing dashboard coverage is visible
   * from day one rather than discovered in review.
   */
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
    const admin = requireCapability(ctx, 'contracts.manage');
    const { input } = args;

    const project = await prisma.project.create({
      data: {
        customerId: input.customerId,
        titleFa: input.titleFa,
        titleEn: input.titleEn,
        scopeItems: {
          createMany: {
            data: CHECKLIST.map(([key, labelFa, labelEn], position) => ({
              key,
              labelFa,
              labelEn,
              position,
              status: 'DECLINED',
            })),
          },
        },
      },
    });

    const contract = await prisma.contract.create({
      data: {
        customerId: input.customerId,
        projectId: project.id,
        ref: input.ref,
        titleFa: input.titleFa,
        titleEn: input.titleEn,
        amount: input.amount ? BigInt(input.amount) : null,
      },
    });
    await log(contract.id, admin.id, 'CREATED');
    return reload(contract.id);
  },

  /**
   * Fills an empty contract with the standard fifteen article titles and six
   * scope items, so a contract created through the workspace does not force
   * Root through fifteen blank forms before there is anything to publish.
   *
   * Refuses rather than merging if either already has rows: a merge would
   * have to decide what to do about a number that already exists, and every
   * answer to that is a small surprise (V2.md §3.9).
   *
   * Only the SCOPE template's own items count against the "already has scope
   * items" guard — the completeness checklist seeded at project creation
   * (`checklist.*` keys) is a different mechanism and would otherwise make
   * this refuse on every contract, always (L1).
   */
  applyContractTemplate: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    // Only non-checklist scope rows count against "already has scope items" —
    // the completeness checklist seeded at project creation (`checklist.*`
    // keys) is a different mechanism, and without this exclusion this guard
    // would refuse on every contract, always (L1).
    const [articleCount, nonChecklistScopeCount] = await Promise.all([
      prisma.article.count({ where: { contractId: args.contractId } }),
      contract.projectId
        ? prisma.scopeItem.count({
            where: { projectId: contract.projectId, key: { not: { startsWith: 'checklist.' } } },
          })
        : Promise.resolve(0),
    ]);
    if (articleCount > 0 || nonChecklistScopeCount > 0) {
      throw new GraphQLError('This contract already has articles or scope items.', {
        extensions: { code: 'TEMPLATE_NOT_EMPTY' },
      });
    }
    if (!contract.projectId) {
      throw new GraphQLError('This contract has no project to hold scope items.', {
        extensions: { code: 'NO_PROJECT' },
      });
    }

    const existingCount = await prisma.scopeItem.count({ where: { projectId: contract.projectId } });

    await prisma.$transaction([
      prisma.article.createMany({
        data: ARTICLES.map(([number, titleFa, titleEn, bodyFa, bodyEn]) => ({
          contractId: args.contractId,
          number,
          titleFa,
          titleEn,
          bodyFa: bodyFa ?? null,
          bodyEn: bodyEn ?? null,
        })),
      }),
      prisma.scopeItem.createMany({
        data: SCOPE.map(([key, labelFa, labelEn], i) => ({
          projectId: contract.projectId!,
          key,
          labelFa,
          labelEn,
          position: existingCount + i,
          // Root typing this into the contract via the template is the
          // agreement act — see addScopeItem's own comment.
          status: 'AGREED' as const,
        })),
      }),
    ]);

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
    requireCapability(ctx, 'contracts.manage');
    const { contractId, number, ...rest } = args;
    await prisma.article.upsert({
      where: { contractId_number: { contractId, number } },
      create: { contractId, number, ...rest },
      update: rest,
    });
    return reload(contractId);
  },

  /**
   * The title and fee half of the draft. `ref` is deliberately not among the
   * arguments — it is frozen into every snapshot once published, and editing
   * it afterward would make the printed page disagree with the live contract
   * while the hash still verified (T1).
   */
  updateContractDraft: async (
    _p: unknown,
    args: { contractId: string; titleFa: string; titleEn: string; amount?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    await prisma.contract.update({
      where: { id: args.contractId },
      data: {
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        amount: args.amount ? BigInt(args.amount) : null,
      },
    });
    return reload(args.contractId);
  },

  /**
   * Legal even when this article number is inside the current published
   * snapshot (T5): the snapshot is frozen JSON and does not move. The
   * customer keeps reading the published text; the *next* publish is what
   * produces a contract without this article.
   */
  deleteArticle: async (
    _p: unknown,
    args: { contractId: string; number: number },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    await prisma.article.deleteMany({
      where: { contractId: args.contractId, number: args.number },
    });
    return reload(args.contractId);
  },

  /**
   * Freezes the current draft — title, fee, articles and the registry's
   * agreed scope set (build plan L1) — as the next contract revision and
   * makes it the live one.
   *
   * Pre-signature this simply replaces: the prior revision is superseded and
   * the customer re-approves. Once a revision is *signed* it is terminal, and
   * the way forward is an amendment, not a v2 — re-signing a replacement
   * would quietly retire the original instrument and muddy which text is in
   * force from when.
   */
  publishContractRevision: async (
    _p: unknown,
    args: { contractId: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const contract = await loadContract(args.contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }

    const current = contract.currentContractRevision;
    if (current?.signature) {
      throw new GraphQLError(
        'This contract is signed. Issue an amendment rather than a new revision.',
        { extensions: { code: 'CONTRACT_SIGNED' } },
      );
    }

    // Appendix 1 as a view of the registry (L1) — the agreed-or-beyond set,
    // in registry order, exactly as agreedScopeSnapshot defines "agreed".
    const scopeItems = agreedScopeSnapshot(contract.project?.scopeItems ?? []);
    const { snapshot, hash, dirty } = draftState(contract, contract.articles, current, scopeItems);
    if (!dirty) {
      throw new GraphQLError('Nothing has changed since the last revision.', {
        extensions: { code: 'NO_CHANGES' },
      });
    }

    // One transaction (defect D2): create/supersede/repoint/log/nudge either
    // all happen or none do. Before this, the revision was created outside
    // the transaction — a failure downstream could leave a published revision
    // superseding nothing and pointed at by nothing.
    try {
      await prisma.$transaction(async (tx) => {
        const latest = await tx.contractRevision.findFirst({
          where: { contractId: contract.id },
          orderBy: { version: 'desc' },
        });
        const now = new Date();
        const revision = await tx.contractRevision.create({
          data: {
            contractId: contract.id,
            version: (latest?.version ?? 0) + 1,
            snapshot,
            contentHash: hash,
            publishedAt: now,
          },
        });
        if (current) {
          await tx.contractRevision.update({
            where: { id: current.id },
            data: { supersededAt: now },
          });
        }
        await tx.contract.update({
          where: { id: contract.id },
          data: { currentContractRevisionId: revision.id },
        });
        await log(contract.id, admin.id, 'CONTRACT_REVISED', `v${revision.version}`, tx);
        await nudgeStatus(contract, 'WAITING_ON_CUSTOMER', tx);
      });
    } catch (err) {
      throw asConcurrentPublish(err);
    }

    return reload(contract.id);
  },

  publishContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.manage');
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
    const admin = requireCapability(ctx, 'contracts.manage');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    // Setting a contract to the status it already has must be a no-op — not
    // an equality check nudgeStatus already gets for free, but one this
    // resolver has to make itself, or the Needs-Root queue could be cleared
    // by touching a dropdown (V4 defect D7).
    if (contract.status === args.status) return reload(args.contractId);

    // Permissive on purpose: from almost any status to almost any other,
    // with a manual override always available.
    await prisma.contract.update({
      where: { id: args.contractId },
      data: { status: args.status, statusChangedAt: new Date() },
    });
    await log(args.contractId, admin.id, 'STATUS_CHANGED', args.status);
    return reload(args.contractId);
  },
};
