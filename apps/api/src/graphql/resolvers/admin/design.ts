import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { carryForward, diffDesign } from '../../../lib/design.js';
import { conceptsInclude, draftDesignRevision, loadContract, log, nudgeStatus, reload } from '../contracts.js';
import { requireDraft, resolveDesignImage } from './shared.js';

/** The design draft: concepts, pages, images, and publishing the lineage.
 *  Part of the L1 split of the former `admin.ts`; see `index.ts`. */
export const designMutations = {
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

  /**
   * Labels only. `key` never changes here — it is what `lib/design.ts`
   * matches on to decide carry-forward, so renaming it silently resets an
   * approval and looks like a bug in the gate.
   */
  updateConcept: async (
    _p: unknown,
    args: { conceptId: string; labelFa: string; labelEn: string },
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
    await prisma.designConcept.update({
      where: { id: concept.id },
      data: { labelFa: args.labelFa, labelEn: args.labelEn },
    });
    return reload(concept.designRevision.contractId);
  },

  /** Pages cascade (schema.prisma: PageDesign.concept onDelete: Cascade). */
  deleteConcept: async (_p: unknown, args: { conceptId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const concept = await prisma.designConcept.findUnique({
      where: { id: args.conceptId },
      include: { designRevision: true },
    });
    if (!concept) {
      throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
    }
    requireDraft(concept.designRevision.publishedAt);
    await prisma.designConcept.delete({ where: { id: concept.id } });
    return reload(concept.designRevision.contractId);
  },

  updatePageDesign: async (
    _p: unknown,
    args: { pageId: string; labelFa: string; labelEn: string },
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
    requireDraft(page.concept.designRevision.publishedAt);
    await prisma.pageDesign.update({
      where: { id: page.id },
      data: { labelFa: args.labelFa, labelEn: args.labelEn },
    });
    return reload(page.concept.designRevision.contractId);
  },

  deletePageDesign: async (_p: unknown, args: { pageId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const page = await prisma.pageDesign.findUnique({
      where: { id: args.pageId },
      include: { concept: { include: { designRevision: true } } },
    });
    if (!page) {
      throw new GraphQLError('No such page.', { extensions: { code: 'NOT_FOUND' } });
    }
    requireDraft(page.concept.designRevision.publishedAt);
    await prisma.pageDesign.delete({ where: { id: page.id } });
    return reload(page.concept.designRevision.contractId);
  },

  /**
   * Deletes the unpublished design revision and its concepts/pages — the
   * counterpart to a draft that only ever comes into being on an edit
   * (`draftDesignRevision`). Without this, D6's NO_CHANGES guard is a trap:
   * an admin who opens the design tab, triggers a draft and changes their
   * mind would be stuck with a draft they can neither publish nor remove.
   */
  discardDesignDraft: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const draft = await prisma.designRevision.findFirst({
      where: { contractId: args.contractId, publishedAt: null },
    });
    if (!draft) {
      throw new GraphQLError('There is no design draft to discard.', {
        extensions: { code: 'NO_DRAFT' },
      });
    }
    // Cascades to its concepts and their pages (schema.prisma onDelete: Cascade).
    await prisma.designRevision.delete({ where: { id: draft.id } });
    return reload(args.contractId);
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

    // Defect D6: publishContractRevision refuses a no-op; this sibling never
    // did. Reuses diffDesign rather than a second comparison (house rule 3).
    const previousKeys = new Set((previous?.concepts ?? []).map((c) => c.key));
    const draftKeys = new Set(draft.concepts.map((c) => c.key));
    const sameConceptKeys =
      previousKeys.size === draftKeys.size && [...previousKeys].every((k) => draftKeys.has(k));
    const changes = diffDesign(previous?.concepts ?? [], draft.concepts);
    if (sameConceptKeys && changes.every((c) => c.kind === 'unchanged')) {
      throw new GraphQLError('Nothing has changed since the last design revision.', {
        extensions: { code: 'NO_CHANGES' },
      });
    }

    const { approvals, chosenConceptKey } = carryForward(
      previous?.concepts ?? [],
      draft.concepts,
    );
    const byKey = new Map(draft.concepts.map((c) => [c.key, c]));

    // One transaction (defect D2), same reasoning as publishContractRevision:
    // the carry-forward writes, the publish flip and the supersede must land
    // together or not at all.
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const a of approvals) {
        const page = byKey.get(a.conceptKey)!.pages.find((p) => p.key === a.pageKey)!;
        await tx.pageDesign.update({ where: { id: page.id }, data: { approvedAt: a.approvedAt } });
      }
      if (chosenConceptKey) {
        await tx.designConcept.update({
          where: { id: byKey.get(chosenConceptKey)!.id },
          data: { chosenAt: previous!.concepts.find((c) => c.key === chosenConceptKey)!.chosenAt },
        });
      }
      await tx.designRevision.update({ where: { id: draft.id }, data: { publishedAt: now } });
      if (previous) {
        await tx.designRevision.update({
          where: { id: previous.id },
          data: { supersededAt: now },
        });
      }
      await tx.contract.update({
        where: { id: contract.id },
        data: { currentDesignRevisionId: draft.id },
      });
      await log(contract.id, admin.id, 'DESIGN_REVISED', `v${draft.version}`, tx);
      await nudgeStatus(contract, 'WAITING_ON_CUSTOMER', tx);
    });

    return reload(contract.id);
  },
};
