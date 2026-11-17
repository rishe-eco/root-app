import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { EXTRA_COMMITMENT_KEYS } from '../../lib/brief.js';
import { checkSlug } from '../../lib/templateScope.js';

/**
 * The desk's default list of handover items (DX3a; `HandoverItemType`) — what a
 * new brief starts with: the domain, the hosting, the content, and whatever
 * sales adds (an SMS line) or retires. It follows `resolvers/templates.ts`'s
 * types list: add, rename, reorder, deactivate, and no delete.
 *
 * **Gated by `contracts.author`**, not `templates.types`. The types capability is
 * the designer's (kinds of site and the theme catalogue); a handover item is an
 * obligation in the agreement — who provides what, by when — and sales, who
 * holds `contracts.author` and writes the dependency board with it, is who
 * keeps it. The same capability reads the list, since writing it implies
 * reading it and nobody else has a use for it.
 *
 * Editing the list **never touches a row that exists**: a brief that was made
 * with the old list keeps the rows and titles it has (a signed agreement said
 * those), and a title changed here is the title of rows made from now on.
 */

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

const TITLE_REQUIRED = () => refuse('TITLE_REQUIRED', 'Both titles are required.');

const ordered = { orderBy: [{ position: 'asc' as const }, { key: 'asc' as const }] };

export const handoverTypeQueries = {
  handoverItemTypes: async (_p: unknown, args: { activeOnly?: boolean | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    return prisma.handoverItemType.findMany({ where: args.activeOnly ? { active: true } : {}, ...ordered });
  },
};

export const handoverTypeMutations = {
  createHandoverItemType: async (
    _p: unknown,
    args: { key: string; titleFa: string; titleEn: string; technical?: boolean | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    if (checkSlug(args.key)) throw refuse('INVALID_SLUG', 'A key is lowercase Latin letters, digits and hyphens.');
    // The extras' rows are the brief's own, synced by `syncBriefDependencies`; a list item with
    // their key would be claimed by it.
    if (EXTRA_COMMITMENT_KEYS.has(args.key)) throw refuse('HANDOVER_KEY_TAKEN', 'An item with that key already exists.');
    const titleFa = args.titleFa.trim();
    const titleEn = args.titleEn.trim();
    if (!titleFa || !titleEn) throw TITLE_REQUIRED();

    const last = await prisma.handoverItemType.aggregate({ _max: { position: true } });
    try {
      return await prisma.handoverItemType.create({
        data: { key: args.key, titleFa, titleEn, technical: args.technical ?? false, position: (last._max.position ?? -1) + 1 },
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw refuse('HANDOVER_KEY_TAKEN', 'An item with that key already exists.');
      }
      throw err;
    }
  },

  updateHandoverItemType: async (
    _p: unknown,
    args: { id: string; titleFa?: string | null; titleEn?: string | null; technical?: boolean | null; active?: boolean | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const existing = await prisma.handoverItemType.findUnique({ where: { id: args.id } });
    if (!existing) throw refuse('NOT_FOUND', 'No such handover item.');
    const data: { titleFa?: string; titleEn?: string; technical?: boolean; active?: boolean } = {};
    for (const field of ['titleFa', 'titleEn'] as const) {
      const value = args[field];
      if (value == null) continue;
      if (!value.trim()) throw TITLE_REQUIRED();
      data[field] = value.trim();
    }
    if (args.technical != null) data.technical = args.technical;
    if (args.active != null) data.active = args.active;
    return prisma.handoverItemType.update({ where: { id: args.id }, data });
  },

  /** The whole order, as `reorderTemplateTypes`: a stale screen that misses an item is refused and reloads. */
  reorderHandoverItemTypes: async (_p: unknown, args: { ids: string[] }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const all = await prisma.handoverItemType.findMany({ select: { id: true } });
    const known = new Set(all.map((t) => t.id));
    if (args.ids.length !== known.size || new Set(args.ids).size !== known.size || !args.ids.every((id) => known.has(id))) {
      throw refuse('REORDER_MISMATCH', 'The order must name every handover item exactly once.');
    }
    await prisma.$transaction(args.ids.map((id, position) => prisma.handoverItemType.update({ where: { id }, data: { position } })));
    return prisma.handoverItemType.findMany(ordered);
  },
};
