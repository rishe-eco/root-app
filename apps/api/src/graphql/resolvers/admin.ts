import { GraphQLError } from 'graphql';
import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { requireCapability, type Context } from '../../context.js';
import { newLinkToken } from '../../auth/tokens.js';
import { draftState, buildAmendmentSnapshot, contentHash } from '../../lib/revision.js';
import { carryForward, diffDesign } from '../../lib/design.js';
import { ARTICLES, SCOPE } from '../../lib/templates.js';
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
 * Both publish mutations read `max(version)` and write `version + 1`inside
 * their transaction; two concurrent publishes hit `@@unique([contractId,
 * version])`, which is the protection working as intended. Left alone, that
 * surfaces to the caller as `DUPLICATE_KEY` ("something with that key
 * already exists"), which is unreadable in context — this rewrites it to
 * something a person can act on. Checked structurally rather than by
 * importing Prisma's error class, matching `lib/logging.ts`'s own P2002
 * handling.
 */
function asConcurrentPublish(err: unknown): unknown {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
    return new GraphQLError('Someone else published while you were working — reload and try again.', {
      extensions: { code: 'CONCURRENT_PUBLISH' },
    });
  }
  return err;
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

  /**
   * Fills an empty contract with the standard fifteen article titles and six
   * scope items, so a contract created through the workspace does not force
   * Root through fifteen blank forms before there is anything to publish.
   *
   * Refuses rather than merging if either already has rows: a merge would
   * have to decide what to do about a number that already exists, and every
   * answer to that is a small surprise (V2.md §3.9).
   */
  applyContractTemplate: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const [articleCount, scopeCount] = await Promise.all([
      prisma.article.count({ where: { contractId: args.contractId } }),
      prisma.scopeItem.count({ where: { contractId: args.contractId } }),
    ]);
    if (articleCount > 0 || scopeCount > 0) {
      throw new GraphQLError('This contract already has articles or scope items.', {
        extensions: { code: 'TEMPLATE_NOT_EMPTY' },
      });
    }

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
        data: SCOPE.map(([key, labelFa, labelEn], position) => ({
          contractId: args.contractId,
          key,
          labelFa,
          labelEn,
          position,
        })),
      }),
    ]);

    return reload(args.contractId);
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

  /**
   * `ScopeItem` is the odd one out (V2.md §5): not versioned, not snapshotted,
   * not hashed. A label edited here is visible to the customer the instant
   * it is saved — no draft, no publish, no `requireDraft` guard.
   */
  updateScopeItem: async (
    _p: unknown,
    args: { scopeItemId: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { labelFa: args.labelFa, labelEn: args.labelEn },
    });
    return reload(item.contractId);
  },

  deleteScopeItem: async (_p: unknown, args: { scopeItemId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    await prisma.scopeItem.delete({ where: { id: item.id } });
    return reload(item.contractId);
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

  /**
   * Layered on top of a signed base revision, never a replacement for one
   * (schema.prisma's note on `Amendment`). Unpublished and editable until
   * `publishAmendment`, matching the rest of the draft/publish split — but
   * `contentHash` is `NOT NULL` here, unlike a contract revision, so it is
   * sealed at creation and recomputed on every subsequent write (V2.md §3.2).
   */
  issueAmendment: async (
    _p: unknown,
    args: {
      contractId: string;
      titleFa: string;
      titleEn: string;
      bodyFa: string;
      bodyEn: string;
      relatesToArticle?: number | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const contract = await loadContract(args.contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    const current = contract.currentContractRevision;
    if (!current?.signature) {
      throw new GraphQLError('An amendment can only be issued against a signed contract.', {
        extensions: { code: 'CONTRACT_NOT_SIGNED' },
      });
    }

    const latest = await prisma.amendment.findFirst({
      where: { contractRevisionId: current.id },
      orderBy: { ordinal: 'desc' },
    });
    const ordinal = (latest?.ordinal ?? 0) + 1;
    const snapshot = buildAmendmentSnapshot({
      ordinal,
      titleFa: args.titleFa,
      titleEn: args.titleEn,
      bodyFa: args.bodyFa,
      bodyEn: args.bodyEn,
    });

    await prisma.amendment.create({
      data: {
        contractRevisionId: current.id,
        ordinal,
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        bodyFa: args.bodyFa,
        bodyEn: args.bodyEn,
        relatesToArticle: args.relatesToArticle ?? null,
        contentHash: contentHash(snapshot),
      },
    });
    return reload(contract.id);
  },

  /**
   * An amendment editable while unpublished must have its hash move with it,
   * or a typo means burning an ordinal. The hash is computed from the row
   * about to be written, never from the arguments in isolation — the two
   * cannot then disagree (V2.md §3.2, "the dangerous one").
   */
  updateAmendment: async (
    _p: unknown,
    args: {
      amendmentId: string;
      titleFa: string;
      titleEn: string;
      bodyFa: string;
      bodyEn: string;
      relatesToArticle?: number | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is published and cannot be edited.', {
        extensions: { code: 'REVISION_PUBLISHED' },
      });
    }

    const snapshot = buildAmendmentSnapshot({
      ordinal: amendment.ordinal,
      titleFa: args.titleFa,
      titleEn: args.titleEn,
      bodyFa: args.bodyFa,
      bodyEn: args.bodyEn,
    });
    await prisma.amendment.update({
      where: { id: amendment.id },
      data: {
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        bodyFa: args.bodyFa,
        bodyEn: args.bodyEn,
        relatesToArticle: args.relatesToArticle ?? null,
        contentHash: contentHash(snapshot),
      },
    });
    return reload(amendment.contractRevision.contractId);
  },

  deleteAmendment: async (_p: unknown, args: { amendmentId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is published and cannot be deleted.', {
        extensions: { code: 'REVISION_PUBLISHED' },
      });
    }
    await prisma.amendment.delete({ where: { id: amendment.id } });
    return reload(amendment.contractRevision.contractId);
  },

  publishAmendment: async (_p: unknown, args: { amendmentId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is already published.', {
        extensions: { code: 'ALREADY_PUBLISHED' },
      });
    }
    const contractId = amendment.contractRevision.contractId;
    const contract = await loadContract(contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }

    await prisma.amendment.update({
      where: { id: amendment.id },
      data: { publishedAt: new Date() },
    });
    await log(contractId, admin.id, 'CONTRACT_AMENDED', `A${amendment.ordinal}`);
    await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');
    return reload(contractId);
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
