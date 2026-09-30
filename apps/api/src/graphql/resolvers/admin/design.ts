import { GraphQLError } from 'graphql';
import type { PaletteKind, Prisma } from '@prisma/client';
import { extname } from 'node:path';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { requireDesignAuthorOn } from '../access.js';
import {
  carryForward,
  designChanged,
  roundPublishedAnswer,
  snapshotTheme,
  themeConceptKey,
} from '../../../lib/design.js';
import { answerRoute } from '../../../lib/feedbackRules.js';
import { assertWithinAllowance } from '../../../lib/allowance.js';
import { MAX_PALETTE_ITEMS, checkPaletteItem, type PaletteProblem } from '../../../lib/palette.js';
import { AGREED_STATUSES } from '../../../lib/scope.js';
import { storage } from '../../../lib/storage.js';
import { conceptsInclude, draftDesignRevision, log, nudgeStatus, reload } from '../contracts.js';
import { allowanceStateOn, tellSalesAllowanceExhausted } from '../allowance.js';
import { designPathOn, openDesign, tellCustomerOfRound } from '../design.js';
import { requireDraft, resolveDesignImage } from './shared.js';

/** The design draft: concepts, pages, images, the palette, the pre-made rounds,
 *  and publishing the lineage. Part of the L1 split of the former `admin.ts`; see
 *  `index.ts`.
 *
 *  Journeys build plan S1: `design.author`, then `requireDesignAuthorOn`
 *  once the contract is known — the capability first, so a caller without it
 *  gets FORBIDDEN before any lookup can tell them which ids exist.
 *
 *  **Journeys build plan J8: every write here opens the step the same way**, in a
 *  transaction of its own: `openDesign(tx, contractId)` (`resolvers/design.ts`) —
 *  the contract's row lock, then `assertStepOpenOn(DESIGN)` (`STEP_LOCKED` once the
 *  customer has approved the design, for staff too), then, on the new road, "the
 *  agreement is signed". The call sits in each mutation rather than in a wrapper
 *  so that `j8.test.ts`'s table — built by grepping for `openDesign(` — fails when
 *  a design write is added without a row. The legacy road (`DESIGN_FIRST`) is never
 *  locked (`computeWizard` ignores its approvals) and never gated on a signature,
 *  so none of this changes what it does. */

type Tx = Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

const PALETTE_MESSAGES: Record<PaletteProblem, string> = {
  INVALID_COLOR: 'A colour is a hex value like #1f3a5c.',
  INVALID_FONT: 'A font is a family name — letters, digits, spaces, hyphens and dots.',
  INVALID_LOGO_NOTE: 'A logo note is one short sentence.',
  INVALID_ROLE: 'A role is lowercase Latin letters, digits and hyphens, starting with a letter.',
  LABEL_REQUIRED: 'Both labels are required.',
  LABEL_TOO_LONG: 'A label is at most 80 characters.',
};

// --- looking an entity up by id (its contract is what the guards need) --------------

async function conceptContractId(conceptId: string): Promise<string> {
  const concept = await prisma.designConcept.findUnique({
    where: { id: conceptId },
    select: { designRevision: { select: { contractId: true } } },
  });
  if (!concept) throw notFound('concept');
  return concept.designRevision.contractId;
}

async function pageContractId(pageId: string): Promise<string> {
  const page = await prisma.pageDesign.findUnique({
    where: { id: pageId },
    select: { concept: { select: { designRevision: { select: { contractId: true } } } } },
  });
  if (!page) throw notFound('page');
  return page.concept.designRevision.contractId;
}

async function paletteItemContractId(itemId: string): Promise<string> {
  const item = await prisma.designPaletteItem.findUnique({
    where: { id: itemId },
    select: { designRevision: { select: { contractId: true } } },
  });
  if (!item) throw notFound('palette item');
  return item.designRevision.contractId;
}

/** The concept, re-read inside the transaction that will change it and checked
 *  to be part of a draft — the lookup above only found its contract. */
async function draftConcept(tx: Tx, conceptId: string) {
  const concept = await tx.designConcept.findUnique({ where: { id: conceptId }, include: { designRevision: true } });
  if (!concept) throw notFound('concept');
  requireDraft(concept.designRevision.publishedAt);
  return concept;
}

async function draftPage(tx: Tx, pageId: string) {
  const page = await tx.pageDesign.findUnique({
    where: { id: pageId },
    include: { concept: { include: { designRevision: true } } },
  });
  if (!page) throw notFound('page');
  requireDraft(page.concept.designRevision.publishedAt);
  return page;
}

async function draftPaletteItem(tx: Tx, itemId: string) {
  const item = await tx.designPaletteItem.findUnique({ where: { id: itemId }, include: { designRevision: true } });
  if (!item) throw notFound('palette item');
  requireDraft(item.designRevision.publishedAt);
  return item;
}

// --- theme rounds --------------------------------------------------------------------

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * **Copies a theme's preview into a contract-owned `DESIGN_IMAGE`** (journeys
 * build plan J8, T2's decision): new bytes under a new storage key and a new
 * `StoredFile` that names the *contract* as its owner, so the customer's access
 * to the image is the contract edge (`GET /files/:id` → `contractVisibleTo`) and
 * never a theme's — the `THEME_PREVIEW` stays staff-only — and so a later
 * catalogue edit (a replaced preview deletes the old row and bytes, T2) cannot
 * take a past round's picture away. `made` collects the new storage keys, so the
 * caller can remove the bytes if the transaction rolls back (the upload route's
 * rule: bytes on disk with no row are unreachable and uncounted).
 *
 * A theme with no preview, or whose bytes are missing, gets no image — the
 * gallery shows its placeholder — rather than failing the proposal.
 */
async function copyPreviewIntoContract(
  tx: Tx,
  theme: { previewFileId: string | null },
  contractId: string,
  uploaderId: string,
  made: string[],
): Promise<{ imageUrl: string; imageFileId: string } | null> {
  if (!theme.previewFileId) return null;
  const preview = await tx.storedFile.findUnique({ where: { id: theme.previewFileId } });
  if (!preview || !(await storage.exists(preview.key))) return null;
  const key = await storage.put('PRIVATE', await readAll(storage.read(preview.key)), extname(preview.key));
  made.push(key);
  const copy = await tx.storedFile.create({
    data: {
      key,
      class: 'DESIGN_IMAGE',
      visibility: 'PRIVATE',
      mime: preview.mime,
      bytes: preview.bytes,
      originalName: preview.originalName,
      contractId,
      uploadedById: uploaderId,
    },
  });
  return { imageUrl: `/files/${copy.id}`, imageFileId: copy.id };
}

/**
 * After some theme concepts have been deleted: the copied previews nothing else
 * points at any more are deleted too (row now, bytes after commit — the keys are
 * returned). "Nothing else" is a real check, not an assumption: a draft is cloned
 * from the published revision and shares its concepts' files, so a preview a
 * published round still shows must survive its draft being discarded. Only
 * *theme* concepts are cleaned up; the legacy uploads have always been left where
 * they are.
 */
async function releaseCopies(tx: Tx, fileIds: readonly (string | null)[]): Promise<string[]> {
  const removed: string[] = [];
  for (const id of new Set(fileIds.filter((x): x is string => x !== null))) {
    const [concepts, pages, items] = await Promise.all([
      tx.designConcept.count({ where: { imageFileId: id } }),
      tx.pageDesign.count({ where: { imageFileId: id } }),
      tx.designPaletteItem.count({ where: { imageFileId: id } }),
    ]);
    if (concepts + pages + items > 0) continue;
    const file = await tx.storedFile.findUnique({ where: { id } });
    if (!file || file.class !== 'DESIGN_IMAGE') continue;
    await tx.storedFile.delete({ where: { id } });
    removed.push(file.key);
  }
  return removed;
}

const removeBytes = (keys: readonly string[]) => Promise.all(keys.map((k) => storage.remove(k).catch(() => undefined)));

export const designMutations = {
  /**
   * **Starts a round.** Creates the design draft if there is none (idempotent —
   * `draftDesignRevision`'s "created on the first edit", made an explicit act so
   * the desk has a button for it, and so the custom path has a concept to hang a
   * page on before there is anything to edit). On the custom path the draft is
   * given its one concept, `wireframes` — a custom design has one direction, not
   * three to choose from, so the concept is a container and is never "chosen".
   */
  startDesignDraft: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    await requireDesignAuthorOn(ctx, args.contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, args.contractId);
      const draft = await draftDesignRevision(args.contractId, tx);
      if ((await designPathOn(tx, args.contractId)) === 'CUSTOM' && !draft.concepts.some((c) => c.key === 'wireframes')) {
        await tx.designConcept.create({
          data: {
            designRevisionId: draft.id,
            key: 'wireframes',
            labelFa: 'وایرفریم‌ها',
            labelEn: 'Wireframes',
            position: draft.concepts.length,
          },
        });
      }
    });
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
    requireCapability(ctx, 'design.author');
    await requireDesignAuthorOn(ctx, args.contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, args.contractId);
      // Writes land in the draft revision, never in the published one the
      // customer is looking at. Publishing is what makes them visible.
      const draft = await draftDesignRevision(args.contractId, tx);
      const count = await tx.designConcept.count({ where: { designRevisionId: draft.id } });
      await tx.designConcept.create({
        data: {
          designRevisionId: draft.id,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          imageUrl: args.imageUrl ?? null,
          position: count,
        },
      });
    });
    return reload(args.contractId);
  },

  /**
   * **A pre-made round** (journeys build plan J8): the draft's themes become
   * exactly `themeIds`, in that order. Each theme newly in the round becomes a
   * concept that **snapshots** the theme's name, vendor and demo URL (never its
   * licence cost — `snapshotTheme`) and **copies its preview into a contract-owned
   * `DESIGN_IMAGE`**; one already in the draft is kept as it is (its snapshot is
   * what the round showed, not what the catalogue says today); one no longer
   * listed is dropped. Concepts that are not themes are left alone.
   *
   * The catalogue is filtered the way the desk filters it: an **active** theme
   * **offered for the brief's template type** — so the list on screen and the
   * list the server accepts are one rule, and a theme deactivated after it was
   * proposed stays exactly as it was proposed.
   *
   * Refusals: `NOT_PREMADE` (the contract's design is not on the pre-made path),
   * `DUPLICATE_THEME`, `THEME_NOT_FOUND`, `THEME_INACTIVE`, `THEME_NOT_OFFERED`,
   * `STEP_LOCKED`, `AGREEMENT_NOT_SIGNED`.
   */
  proposeThemes: async (_p: unknown, args: { contractId: string; themeIds: string[] }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const author = await requireDesignAuthorOn(ctx, args.contractId);
    if ((await designPathOn(prisma, args.contractId)) !== 'PREMADE') {
      throw refuse('NOT_PREMADE', 'Themes are proposed on a pre-made design.');
    }
    if (new Set(args.themeIds).size !== args.themeIds.length) {
      throw refuse('DUPLICATE_THEME', 'A theme can be named only once in a round.');
    }
    const brief = await prisma.contractBrief.findUniqueOrThrow({
      where: { contractId: args.contractId },
      select: { templateTypeId: true },
    });
    const themes = await prisma.theme.findMany({
      where: { id: { in: args.themeIds } },
      include: { types: { select: { typeId: true } } },
    });
    if (themes.length !== args.themeIds.length) throw refuse('THEME_NOT_FOUND', 'One of those themes does not exist.');
    if (themes.some((t) => !t.active)) throw refuse('THEME_INACTIVE', 'A deactivated theme cannot be proposed.');
    if (themes.some((t) => !t.types.some((x) => x.typeId === brief.templateTypeId))) {
      throw refuse('THEME_NOT_OFFERED', 'That theme is not offered for this kind of site.');
    }
    const byId = new Map(themes.map((t) => [t.id, t]));

    const made: string[] = [];
    let released: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        await openDesign(tx, args.contractId);
        const draft = await draftDesignRevision(args.contractId, tx);
        const inDraft = new Map(draft.concepts.filter((c) => c.themeId !== null).map((c) => [c.themeId!, c]));

        const dropped = draft.concepts.filter((c) => c.themeId !== null && !args.themeIds.includes(c.themeId));
        if (dropped.length > 0) {
          await tx.designConcept.deleteMany({ where: { id: { in: dropped.map((c) => c.id) } } });
          released = await releaseCopies(tx, dropped.map((c) => c.imageFileId));
        }

        // Themes sit after any non-theme concept the draft already holds, in
        // the order asked for.
        const base = draft.concepts.filter((c) => c.themeId === null).length;
        for (const [index, themeId] of args.themeIds.entries()) {
          const kept = inDraft.get(themeId);
          if (kept) {
            await tx.designConcept.update({ where: { id: kept.id }, data: { position: base + index } });
            continue;
          }
          const theme = byId.get(themeId)!;
          const image = await copyPreviewIntoContract(tx, theme, args.contractId, author.id, made);
          await tx.designConcept.create({
            data: {
              designRevisionId: draft.id,
              key: themeConceptKey(theme.id),
              labelFa: theme.name,
              labelEn: theme.name,
              themeId: theme.id,
              themeSnapshot: snapshotTheme(theme),
              imageUrl: image?.imageUrl ?? null,
              imageFileId: image?.imageFileId ?? null,
              position: base + index,
            },
          });
        }
      });
    } catch (err) {
      // The bytes were written before the rows could be; with the rows rolled
      // back they are unreachable, so they go.
      await removeBytes(made);
      throw err;
    }
    await removeBytes(released);
    return reload(args.contractId);
  },

  /**
   * A page's wireframe slot. **On the new road the key must be a page of this
   * contract's agreed scope** (`PAGE_KEY_UNKNOWN`): a registry `PAGE` item that
   * *this* contract agreed (J5 made scope per contract) and that is still in the
   * agreement — a wireframe for a page nobody agreed to build, or that was declined,
   * is design work with no page to hang on. The legacy road's pages have always
   * been free-form keys, and stay so.
   */
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
    requireCapability(ctx, 'design.author');
    const contractId = await conceptContractId(args.conceptId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const concept = await draftConcept(tx, args.conceptId);
      const contract = await tx.contract.findUniqueOrThrow({
        where: { id: contractId },
        select: { sequence: true, projectId: true },
      });
      if (contract.sequence === 'AGREEMENT_FIRST') {
        const page = await tx.scopeItem.findFirst({
          where: { projectId: contract.projectId, contractId, kind: 'PAGE', key: args.key, status: { in: [...AGREED_STATUSES] } },
          select: { id: true },
        });
        if (!page) throw refuse('PAGE_KEY_UNKNOWN', 'That is not a page of this contract’s scope.');
      }
      const count = await tx.pageDesign.count({ where: { conceptId: concept.id } });
      await tx.pageDesign.create({
        data: {
          conceptId: concept.id,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          imageUrl: args.imageUrl ?? null,
          position: count,
        },
      });
    });
    return reload(contractId);
  },

  setConceptImage: async (
    _p: unknown,
    args: { conceptId: string; fileId: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'design.author');
    const contractId = await conceptContractId(args.conceptId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const concept = await draftConcept(tx, args.conceptId);
      const image = await resolveDesignImage(args.fileId, contractId);
      await tx.designConcept.update({ where: { id: concept.id }, data: image });
    });
    return reload(contractId);
  },

  setPageImage: async (
    _p: unknown,
    args: { pageId: string; fileId: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'design.author');
    const contractId = await pageContractId(args.pageId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const page = await draftPage(tx, args.pageId);
      const image = await resolveDesignImage(args.fileId, contractId);
      await tx.pageDesign.update({ where: { id: page.id }, data: image });
    });
    return reload(contractId);
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
    requireCapability(ctx, 'design.author');
    const contractId = await conceptContractId(args.conceptId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const concept = await draftConcept(tx, args.conceptId);
      await tx.designConcept.update({
        where: { id: concept.id },
        data: { labelFa: args.labelFa, labelEn: args.labelEn },
      });
    });
    return reload(contractId);
  },

  /** Pages cascade (schema.prisma: PageDesign.concept onDelete: Cascade). A theme
   *  concept also takes its copied preview with it when nothing else shows it. */
  deleteConcept: async (_p: unknown, args: { conceptId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const contractId = await conceptContractId(args.conceptId);
    await requireDesignAuthorOn(ctx, contractId);
    let released: string[] = [];
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const concept = await draftConcept(tx, args.conceptId);
      await tx.designConcept.delete({ where: { id: concept.id } });
      if (concept.themeId !== null) released = await releaseCopies(tx, [concept.imageFileId]);
    });
    await removeBytes(released);
    return reload(contractId);
  },

  updatePageDesign: async (
    _p: unknown,
    args: { pageId: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'design.author');
    const contractId = await pageContractId(args.pageId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const page = await draftPage(tx, args.pageId);
      await tx.pageDesign.update({
        where: { id: page.id },
        data: { labelFa: args.labelFa, labelEn: args.labelEn },
      });
    });
    return reload(contractId);
  },

  deletePageDesign: async (_p: unknown, args: { pageId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const contractId = await pageContractId(args.pageId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const page = await draftPage(tx, args.pageId);
      await tx.pageDesign.delete({ where: { id: page.id } });
    });
    return reload(contractId);
  },

  // --- the palette (custom path) ---------------------------------------------------

  /**
   * A colour, a font or a logo note in the draft's palette. **Custom path only**
   * (`NOT_CUSTOM`): a pre-made design is a theme, which brings its own; and a legacy
   * contract's design has no palette. The rules for the value are `lib/palette.ts`
   * (a colour is a hex, a font a name, a logo note a sentence — listed in its
   * header); the role is unique per kind (`ROLE_TAKEN`); at most 24 items
   * (`PALETTE_FULL`).
   */
  addPaletteItem: async (
    _p: unknown,
    args: { contractId: string; kind: PaletteKind; role: string; value: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'design.author');
    await requireDesignAuthorOn(ctx, args.contractId);
    if ((await designPathOn(prisma, args.contractId)) !== 'CUSTOM') {
      throw refuse('NOT_CUSTOM', 'A palette belongs to a custom design.');
    }
    const checked = checkPaletteItem(args);
    if ('problem' in checked) throw refuse(checked.problem, PALETTE_MESSAGES[checked.problem]);

    await prisma.$transaction(async (tx) => {
      await openDesign(tx, args.contractId);
      const draft = await draftDesignRevision(args.contractId, tx);
      if (draft.palette.length >= MAX_PALETTE_ITEMS) {
        throw refuse('PALETTE_FULL', `A palette holds at most ${MAX_PALETTE_ITEMS} items.`);
      }
      if (draft.palette.some((p) => p.kind === checked.kind && p.role === checked.role)) {
        throw refuse('ROLE_TAKEN', 'The palette already has an item with that role.');
      }
      await tx.designPaletteItem.create({
        data: { designRevisionId: draft.id, ...checked, position: draft.palette.length },
      });
    });
    return reload(args.contractId);
  },

  /** The value and the labels. Kind and role never change — the mockup and the
   *  developer key on the role, the way carry-forward keys on a concept's key. */
  updatePaletteItem: async (
    _p: unknown,
    args: { itemId: string; value: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'design.author');
    const contractId = await paletteItemContractId(args.itemId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const item = await draftPaletteItem(tx, args.itemId);
      const checked = checkPaletteItem({ kind: item.kind, role: item.role, value: args.value, labelFa: args.labelFa, labelEn: args.labelEn });
      if ('problem' in checked) throw refuse(checked.problem, PALETTE_MESSAGES[checked.problem]);
      await tx.designPaletteItem.update({
        where: { id: item.id },
        data: { value: checked.value, labelFa: checked.labelFa, labelEn: checked.labelEn },
      });
    });
    return reload(contractId);
  },

  /** A palette item's picture — a font specimen, the logo on a background. It
   *  must be this contract's own design image (`resolveDesignImage`). */
  setPaletteItemImage: async (_p: unknown, args: { itemId: string; fileId: string | null }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const contractId = await paletteItemContractId(args.itemId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const item = await draftPaletteItem(tx, args.itemId);
      const image = await resolveDesignImage(args.fileId, contractId);
      await tx.designPaletteItem.update({ where: { id: item.id }, data: { imageFileId: image.imageFileId } });
    });
    return reload(contractId);
  },

  deletePaletteItem: async (_p: unknown, args: { itemId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const contractId = await paletteItemContractId(args.itemId);
    await requireDesignAuthorOn(ctx, contractId);
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, contractId);
      const item = await draftPaletteItem(tx, args.itemId);
      await tx.designPaletteItem.delete({ where: { id: item.id } });
    });
    return reload(contractId);
  },

  /**
   * Deletes the unpublished design revision and its concepts/pages — the
   * counterpart to a draft that only ever comes into being on an edit
   * (`draftDesignRevision`). Without this, D6's NO_CHANGES guard is a trap:
   * an admin who opens the design tab, triggers a draft and changes their
   * mind would be stuck with a draft they can neither publish nor remove.
   * Copied theme previews nothing else shows go with it.
   */
  discardDesignDraft: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    await requireDesignAuthorOn(ctx, args.contractId);
    let released: string[] = [];
    await prisma.$transaction(async (tx) => {
      await openDesign(tx, args.contractId);
      const draft = await tx.designRevision.findFirst({
        where: { contractId: args.contractId, publishedAt: null },
        include: { concepts: { select: { themeId: true, imageFileId: true } } },
      });
      if (!draft) {
        throw new GraphQLError('There is no design draft to discard.', {
          extensions: { code: 'NO_DRAFT' },
        });
      }
      // Cascades to its concepts and their pages (schema.prisma onDelete: Cascade).
      await tx.designRevision.delete({ where: { id: draft.id } });
      released = await releaseCopies(tx, draft.concepts.filter((c) => c.themeId !== null).map((c) => c.imageFileId));
    });
    await removeBytes(released);
    return reload(args.contractId);
  },

  /**
   * Publishes the draft design revision — **a round**. Approvals carry forward for
   * pages whose image has not moved (`lib/design.ts`), so a one-page tweak asks for
   * one re-approval rather than four. The contract lineage is untouched — that
   * independence is the point of two lineages.
   *
   * **Journeys build plan J8.** On the new road the round is counted against the
   * allowance (`assertWithinAllowance`, `ALLOWANCE_EXHAUSTED` — sales is told, and
   * `extendAllowance` admits more); a palette-only change is a change
   * (`designChanged`); the customer is told a round is up; and **publishing
   * answers "show me other options"** — each open request gets a direct
   * `ADDRESSED` answer from the publisher, in the thread and on record (F9), by the
   * same route `answerFeedback` takes, never a silent status flip.
   */
  publishDesignRevision: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const author = await requireDesignAuthorOn(ctx, args.contractId);

    let published: { round: number; allowance: number | null };
    try {
      published = await prisma.$transaction(async (tx) => {
        await openDesign(tx, args.contractId);
        const contract = await tx.contract.findUnique({
          where: { id: args.contractId },
          include: { customer: true, currentDesignRevision: { include: conceptsInclude } },
        });
        if (!contract) throw notFound('contract');

        const draft = await tx.designRevision.findFirst({
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
        // did. One definition of "changed" (`designChanged`, lib/design.ts —
        // house rule 3), which since J8 includes the palette.
        if (
          !designChanged(
            { concepts: previous?.concepts ?? [], palette: previous?.palette ?? [] },
            { concepts: draft.concepts, palette: draft.palette },
          )
        ) {
          throw new GraphQLError('Nothing has changed since the last design revision.', {
            extensions: { code: 'NO_CHANGES' },
          });
        }

        // The allowance (J8): the new road's rounds are the brief's promise. The
        // legacy road has none (PD-7) and publishes as it always has.
        const newRoad = contract.sequence === 'AGREEMENT_FIRST';
        const before = newRoad ? await allowanceStateOn(tx, contract.id, 'DESIGN') : { used: null, allowance: null };
        if (newRoad) assertWithinAllowance(before);

        const { approvals, chosenConceptKey } = carryForward(
          previous?.concepts ?? [],
          draft.concepts,
        );
        const byKey = new Map(draft.concepts.map((c) => [c.key, c]));

        // One transaction (defect D2), same reasoning as publishContractRevision:
        // the carry-forward writes, the publish flip and the supersede must land
        // together or not at all.
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
        await log(contract.id, author.id, 'DESIGN_REVISED', `v${draft.version}`, tx);
        await nudgeStatus(contract, 'WAITING_ON_CUSTOMER', tx);

        const round = (before.used ?? 0) + 1;
        if (newRoad) {
          // "Show me other options" is answered by this round. The answer is an
          // ordinary resolving comment by the publisher, direct or pending by
          // `answerRoute` like any other (PD-3) — a pending one leaves the item
          // open for sales to approve, as it would anywhere — and the marker is
          // cleared either way: the request has been answered once.
          const asks = await tx.feedbackItem.findMany({
            where: { contractId: contract.id, step: 'DESIGN', general: true, otherOptionsAskedAt: { not: null }, status: 'OPEN' },
            select: { id: true },
          });
          const direct = answerRoute(author, 'DESIGN') === 'DIRECT';
          for (const ask of asks) {
            await tx.feedbackComment.create({
              data: {
                feedbackItemId: ask.id,
                authorId: author.id,
                body: roundPublishedAnswer(contract.customer.locale, round),
                resolution: 'ADDRESSED',
                approval: direct ? 'NOT_REQUIRED' : 'PENDING',
              },
            });
            await tx.feedbackItem.update({
              where: { id: ask.id },
              data: { otherOptionsAskedAt: null, ...(direct ? { status: 'ADDRESSED', addressedInBuildId: null } : {}) },
            });
          }
        }
        return { round, allowance: before.allowance };
      });
    } catch (err) {
      const e = (err as { extensions?: { code?: string; used?: number; allowance?: number } }).extensions;
      if (e?.code === 'ALLOWANCE_EXHAUSTED' && typeof e.used === 'number' && typeof e.allowance === 'number') {
        await tellSalesAllowanceExhausted(args.contractId, { used: e.used, allowance: e.allowance }, 'DESIGN');
      }
      throw err;
    }

    const after = await reload(args.contractId);
    if (after.sequence === 'AGREEMENT_FIRST') {
      const premade = (await designPathOn(prisma, after.id)) === 'PREMADE';
      await tellCustomerOfRound(after, published.round, published.allowance, premade);
    }
    return after;
  },
};
