import { GraphQLError } from 'graphql';
import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { requireCapability, type Context } from '../../context.js';
import { newLinkToken } from '../../auth/tokens.js';
import { draftState } from '../../lib/revision.js';
import { carryForward } from '../../lib/design.js';
import {
  conceptsInclude,
  draftDesignRevision,
  loadContract,
  log,
  nudgeStatus,
  reload,
} from './contracts.js';

/**
 * Everything only Root may do: invites, authoring a contract's draft, and
 * publishing.
 *
 * The dividing line that matters here is **draft versus published**. Every
 * authoring mutation writes to a draft — `Article` rows for the contract, an
 * unpublished `DesignRevision` for the design — and none of it reaches the
 * customer until a publish mutation freezes it. That is why editing an article
 * appears to do nothing from the outside, and why `requireDraft` exists.
 *
 * This is also the file the admin workspace will grow into, so it is the one
 * worth keeping legible.
 */

function requireDraft(publishedAt: Date | null): void {
  if (publishedAt !== null) {
    throw new GraphQLError('That revision is published and cannot be edited.', {
      extensions: { code: 'REVISION_PUBLISHED' },
    });
  }
}

/**
 * Turns an uploaded file id into the pair of columns a concept or page stores,
 * refusing anything that is not this contract's own design image.
 *
 * The contract check is the one that matters. Upload records who owns a file;
 * without this, an admin could attach customer A's file to customer B's
 * contract, and the serving route — which authorises by the file's *own*
 * contract — would then refuse to show B an image sitting on B's page. The
 * wrong-looking half of that is the broken image; the real half is that A's
 * private design would be named on someone else's contract.
 *
 * A null id clears both columns, which is how an image is removed.
 */
async function resolveDesignImage(
  fileId: string | null | undefined,
  contractId: string,
): Promise<{ imageUrl: string | null; imageFileId: string | null }> {
  if (!fileId) return { imageUrl: null, imageFileId: null };

  const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!file || file.class !== 'DESIGN_IMAGE' || file.contractId !== contractId) {
    throw new GraphQLError('No such file.', { extensions: { code: 'NOT_FOUND' } });
  }
  return { imageUrl: `/files/${file.id}`, imageFileId: file.id };
}

export const adminMutations = {
  inviteCustomer: async (
    _p: unknown,
    args: { email: string; name: string; clientName?: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'customers.manage');
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
    requireCapability(ctx, 'customers.manage');
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
    const admin = requireCapability(ctx, 'contracts.manage');
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
    requireCapability(ctx, 'contracts.manage');
    // Writes land in the draft revision, never in the published one the
    // customer is looking at. Publishing is what makes them visible.
    const draft = await draftDesignRevision(args.contractId);
    const count = await prisma.designConcept.count({
      where: { designRevisionId: draft.id },
    });
    await prisma.designConcept.create({
      data: {
        designRevisionId: draft.id,
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
    requireCapability(ctx, 'contracts.manage');
    const concept = await prisma.designConcept.findUnique({
      where: { id: args.conceptId },
      include: { designRevision: true },
    });
    if (!concept) {
      throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
    }
    requireDraft(concept.designRevision.publishedAt);
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
    return reload(concept.designRevision.contractId);
  },

  setConceptImage: async (
    _p: unknown,
    args: { conceptId: string; fileId: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const concept = await prisma.designConcept.findUnique({
      where: { id: args.conceptId },
      include: { designRevision: true },
    });
    if (!concept) {
      throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
    }
    requireDraft(concept.designRevision.publishedAt);
    const image = await resolveDesignImage(args.fileId, concept.designRevision.contractId);
    await prisma.designConcept.update({ where: { id: concept.id }, data: image });
    return reload(concept.designRevision.contractId);
  },

  setPageImage: async (
    _p: unknown,
    args: { pageId: string; fileId: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const page = await prisma.pageDesign.findUnique({
      where: { id: args.pageId },
      include: { concept: { include: { designRevision: true } } },
    });
    if (!page) {
      throw new GraphQLError('No such page.', { extensions: { code: 'NOT_FOUND' } });
    }
    const revision = page.concept.designRevision;
    requireDraft(revision.publishedAt);
    const image = await resolveDesignImage(args.fileId, revision.contractId);
    await prisma.pageDesign.update({ where: { id: page.id }, data: image });
    return reload(revision.contractId);
  },

  addScopeItem: async (
    _p: unknown,
    args: { contractId: string; key: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
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
   * Freezes the current draft — title, fee and articles — as the next
   * contract revision and makes it the live one.
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

    const { snapshot, hash, dirty } = draftState(contract, contract.articles, current);
    if (!dirty) {
      throw new GraphQLError('Nothing has changed since the last revision.', {
        extensions: { code: 'NO_CHANGES' },
      });
    }

    const now = new Date();
    const latest = await prisma.contractRevision.findFirst({
      where: { contractId: contract.id },
      orderBy: { version: 'desc' },
    });

    const revision = await prisma.contractRevision.create({
      data: {
        contractId: contract.id,
        version: (latest?.version ?? 0) + 1,
        snapshot,
        contentHash: hash,
        publishedAt: now,
      },
    });

    await prisma.$transaction([
      ...(current
        ? [
            prisma.contractRevision.update({
              where: { id: current.id },
              data: { supersededAt: now },
            }),
          ]
        : []),
      prisma.contract.update({
        where: { id: contract.id },
        data: { currentContractRevisionId: revision.id },
      }),
    ]);

    await log(contract.id, admin.id, 'CONTRACT_REVISED', `v${revision.version}`);
    await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');
    return reload(contract.id);
  },

  /**
   * Publishes the draft design revision. Approvals carry forward for pages
   * whose image has not moved (`lib/design.ts`), so a one-page tweak asks for
   * one re-approval rather than four. The contract lineage is untouched —
   * that independence is the point of two lineages.
   */
  publishDesignRevision: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const contract = await loadContract(args.contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }

    const draft = await prisma.designRevision.findFirst({
      where: { contractId: contract.id, publishedAt: null },
      include: conceptsInclude,
    });
    if (!draft) {
      throw new GraphQLError('There is no design draft to publish.', {
        extensions: { code: 'NO_DRAFT' },
      });
    }

    const previous = contract.currentDesignRevision;
    const { approvals, chosenConceptKey } = carryForward(
      previous?.concepts ?? [],
      draft.concepts,
    );

    const now = new Date();
    const byKey = new Map(draft.concepts.map((c) => [c.key, c]));

    await prisma.$transaction([
      ...approvals.map((a) => {
        const page = byKey.get(a.conceptKey)!.pages.find((p) => p.key === a.pageKey)!;
        return prisma.pageDesign.update({
          where: { id: page.id },
          data: { approvedAt: a.approvedAt },
        });
      }),
      ...(chosenConceptKey
        ? [
            prisma.designConcept.update({
              where: { id: byKey.get(chosenConceptKey)!.id },
              data: { chosenAt: previous!.concepts.find((c) => c.key === chosenConceptKey)!
                .chosenAt },
            }),
          ]
        : []),
      prisma.designRevision.update({
        where: { id: draft.id },
        data: { publishedAt: now },
      }),
      ...(previous
        ? [
            prisma.designRevision.update({
              where: { id: previous.id },
              data: { supersededAt: now },
            }),
          ]
        : []),
      prisma.contract.update({
        where: { id: contract.id },
        data: { currentDesignRevisionId: draft.id },
      }),
    ]);

    await log(contract.id, admin.id, 'DESIGN_REVISED', `v${draft.version}`);
    await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');
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
    // Permissive on purpose: from almost any status to almost any other,
    // with a manual override always available.
    await prisma.contract.update({
      where: { id: args.contractId },
      data: { status: args.status },
    });
    await log(args.contractId, admin.id, 'STATUS_CHANGED', args.status);
    return reload(args.contractId);
  },
};
