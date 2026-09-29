import { GraphQLError } from 'graphql';
import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { can, type Capability } from '../../../lib/capabilities.js';
import { draftState } from '../../../lib/revision.js';
import { agreedScopeSnapshot } from '../../../lib/scope.js';
import { SEQUENCE_FOR_NEW_CONTRACTS } from '../../../lib/steps.js';
import { ARTICLES, SCOPE, CHECKLIST, scopeKindForKey } from '../../../lib/templates.js';
import { loadContract, log, nudgeStatus, reload } from '../contracts.js';
import { asConcurrentPublish } from './shared.js';

/**
 * The contract draft (title, fee, articles) and its publish path, plus
 * project/contract creation. Part of the L1 split of the former `admin.ts`;
 * see `index.ts`. Every mutation is `contracts.author` (journeys build plan
 * S1; before it, `contracts.manage`).
 */

/**
 * An assignee must be able to do the job they are assigned to, and be able
 * to sign in to do it — checked when sales assigns, never after: a designer
 * disabled later stays on the row as history, and J3 surfaces that to sales
 * as an attention item instead of silently routing work to nobody (plan S1).
 *
 * `undefined` means "leave as is", `null` means "unassign". The capability
 * is the one the assignment edge guards (`canAuthorDesign`,
 * `canAuthorBuild`), not a role — house rule 1.
 */
async function assertAssignable(userId: string | null | undefined, capability: Capability): Promise<void> {
  if (userId == null) return;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new GraphQLError('No such user.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!can(user, capability)) {
    throw new GraphQLError('That person cannot do this job.', {
      extensions: { code: 'ASSIGNEE_LACKS_CAPABILITY' },
    });
  }
  if (user.state !== 'ACTIVE') {
    throw new GraphQLError('That account is not active.', { extensions: { code: 'ASSIGNEE_INACTIVE' } });
  }
}
export const contractAdminMutations = {
  /**
   * Creates a contract — and, unless it is handed a project, the project
   * alongside it (build plan D1 / L1).
   *
   * **`projectId` (journeys build plan J2)** names the project the contract
   * attaches to, and the project's state decides what that means:
   *
   * - `REQUESTED` — **conversion.** The customer's request becomes a project
   *   in the same transaction that creates its contract: status → `ACTIVE`,
   *   the project takes the titles sales typed (the request's own were
   *   placeholders), and the completeness checklist is seeded, as for any new
   *   project. The request thread stays on the project, read-only.
   * - `ACTIVE` — **a second contract** on an existing project (the founder's
   *   Q5, lifecycle plan §0.3.5: "a feature for an existing website"). The
   *   registry and its checklist already exist and are not touched.
   * - `ARCHIVED` — refused, `PROJECT_ARCHIVED`.
   *
   * And it must be the same customer (`PROJECT_CUSTOMER_MISMATCH`): sales
   * picks the customer in the form, and a contract on customer A naming
   * customer B's project would put B's registry, demos and thread in front of
   * A. The project row is locked `FOR UPDATE` for the transaction, so two
   * sales users converting the same request cannot both see it `REQUESTED`.
   *
   * Without a `projectId` the behaviour is exactly what it was: a project of
   * the contract's own, its completeness checklist (spec §3) seeded all
   * DECLINED so a hole like Nahal's missing dashboard coverage is visible
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
        /** Journeys build plan S1 — sales picks both at creation (Q-S4). */
        designerId?: string | null;
        developerId?: string | null;
        /** Journeys build plan J2 — attach to this project (convert a request, or add a second contract). */
        projectId?: string | null;
      };
    },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.author');
    const { input } = args;
    // Before anything is written: a refused assignee must not leave a
    // project behind with no contract on it.
    await assertAssignable(input.designerId, 'design.author');
    await assertAssignable(input.developerId, 'builds.author');

    const contractId = await prisma.$transaction(async (tx) => {
      let projectId: string;
      // Whether this contract is the one that seeds the completeness
      // checklist: it is, for a project made here and for a converted
      // request; it is not for a second contract, whose project already has
      // its registry (seeding again would double every key).
      let seedsChecklist = true;

      if (input.projectId) {
        // Locked for the transaction — see the header. Raw, because Prisma
        // has no `FOR UPDATE`; the same idiom T1's `setTemplateScope` uses.
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({ where: { id: input.projectId } });
        if (!project) {
          throw new GraphQLError('No such project.', { extensions: { code: 'NOT_FOUND' } });
        }
        if (project.customerId !== input.customerId) {
          throw new GraphQLError('That project belongs to a different customer.', {
            extensions: { code: 'PROJECT_CUSTOMER_MISMATCH' },
          });
        }
        if (project.status === 'ARCHIVED') {
          throw new GraphQLError('That project is archived.', { extensions: { code: 'PROJECT_ARCHIVED' } });
        }
        projectId = project.id;
        if (project.status === 'REQUESTED') {
          await tx.project.update({
            where: { id: project.id },
            data: { status: 'ACTIVE', titleFa: input.titleFa, titleEn: input.titleEn },
          });
        } else {
          seedsChecklist = false;
        }
      } else {
        const project = await tx.project.create({
          data: { customerId: input.customerId, titleFa: input.titleFa, titleEn: input.titleEn },
        });
        projectId = project.id;
      }

      const contract = await tx.contract.create({
        data: {
          customerId: input.customerId,
          projectId,
          ref: input.ref,
          titleFa: input.titleFa,
          titleEn: input.titleEn,
          amount: input.amount ? BigInt(input.amount) : null,
          designerId: input.designerId ?? null,
          developerId: input.developerId ?? null,
          // Stated here, not left to the column's default — see the constant.
          sequence: SEQUENCE_FOR_NEW_CONTRACTS,
        },
      });
      if (seedsChecklist) {
        // Written after the contract, not with the project, so each row names
        // its agreement from birth (T1's `ScopeItem.contractId`) — rather than
        // a follow-up `updateMany where contractId is null`, which on a
        // project that already held a proposed item would claim that too.
        await tx.scopeItem.createMany({
          data: CHECKLIST.map(([key, labelFa, labelEn], position) => ({
            projectId,
            key,
            labelFa,
            labelEn,
            position,
            // Always EXTRA: the checklist is the one thing this creates.
            kind: 'EXTRA' as const,
            status: 'DECLINED' as const,
            contractId: contract.id,
          })),
        });
      }
      await log(contract.id, admin.id, 'CREATED', null, tx);
      return contract.id;
    },
    // Up from Prisma's five seconds: this waits on the project's row lock when
    // two people convert one request at once, and the checklist is a dozen
    // inserts — neither is slow, but a busy database should make it late, not
    // make it fail half-way.
    { timeout: 20_000 },
    );
    return reload(contractId);
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
    requireCapability(ctx, 'contracts.author');
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
      prisma.scopeItem.count({
        where: { projectId: contract.projectId, key: { not: { startsWith: 'checklist.' } } },
      }),
    ]);
    if (articleCount > 0 || nonChecklistScopeCount > 0) {
      throw new GraphQLError('This contract already has articles or scope items.', {
        extensions: { code: 'TEMPLATE_NOT_EMPTY' },
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
          projectId: contract.projectId,
          key,
          labelFa,
          labelEn,
          position: existingCount + i,
          kind: scopeKindForKey(key),
          contractId: args.contractId,
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
    requireCapability(ctx, 'contracts.author');
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
    requireCapability(ctx, 'contracts.author');
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
    requireCapability(ctx, 'contracts.author');
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
    const admin = requireCapability(ctx, 'contracts.author');
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
    const scopeItems = agreedScopeSnapshot(contract.project.scopeItems);
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
    const admin = requireCapability(ctx, 'contracts.author');
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
    const admin = requireCapability(ctx, 'contracts.author');
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

  /**
   * Journeys build plan S1: sales changes who designs and who develops a
   * contract (Q-S4). Either argument may be omitted (left as is) or null
   * (unassigned). Not logged: a `ChangeAction` costs five files (house rule
   * 10) and the journeys plan derives history from dated rows instead
   * (PD-17) — J3's timeline is where a reassignment will show, if it needs to.
   */
  assignContract: async (
    _p: unknown,
    args: { contractId: string; designerId?: string | null; developerId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    await assertAssignable(args.designerId, 'design.author');
    await assertAssignable(args.developerId, 'builds.author');
    await prisma.contract.update({
      where: { id: contract.id },
      data: { designerId: args.designerId, developerId: args.developerId },
    });
    return reload(contract.id);
  },
};
