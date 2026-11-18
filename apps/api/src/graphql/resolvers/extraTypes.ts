import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { checkSlug } from '../../lib/templateScope.js';

/**
 * The desk's default list of extras (DX6; `ExtraType`) — the areas every new
 * contract starts with, switched off until sales agrees one: payment,
 * notifications, legal, and whatever sales adds. It follows
 * `resolvers/handoverTypes.ts`: add, rename, reorder, deactivate, no delete,
 * and the same capability (`contracts.author`, sales, who agrees the extras).
 *
 * **The key is `checklist.<slug>`.** The caller types a slug; the prefix is
 * added here, because it is what `scopeKindForKey` and `EXTRA_COMMITMENT`
 * (lib/brief.ts) read: the three keys that imply a dependency stay keyed by
 * their `checklist.*` key, and no list item can claim a handover row.
 *
 * Editing the list **never touches a contract that was seeded**: its extras
 * are rows on the project carrying their own labels (a signed agreement said
 * those). A label changed here is the label of contracts made from now on.
 */

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

const LABEL_REQUIRED = () => refuse('LABEL_REQUIRED', 'Both names are required.');

const ordered = { orderBy: [{ position: 'asc' as const }, { key: 'asc' as const }] };

export const extraTypeQueries = {
  extraTypes: async (_p: unknown, args: { activeOnly?: boolean | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    return prisma.extraType.findMany({ where: args.activeOnly ? { active: true } : {}, ...ordered });
  },
};

export const extraTypeMutations = {
  createExtraType: async (_p: unknown, args: { slug: string; labelFa: string; labelEn: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    if (checkSlug(args.slug)) throw refuse('INVALID_SLUG', 'A key is lowercase Latin letters, digits and hyphens.');
    const labelFa = args.labelFa.trim();
    const labelEn = args.labelEn.trim();
    if (!labelFa || !labelEn) throw LABEL_REQUIRED();

    const last = await prisma.extraType.aggregate({ _max: { position: true } });
    try {
      return await prisma.extraType.create({
        data: { key: `checklist.${args.slug}`, labelFa, labelEn, position: (last._max.position ?? -1) + 1 },
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw refuse('EXTRA_KEY_TAKEN', 'An extra with that key already exists.');
      }
      throw err;
    }
  },

  updateExtraType: async (
    _p: unknown,
    args: { id: string; labelFa?: string | null; labelEn?: string | null; active?: boolean | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const existing = await prisma.extraType.findUnique({ where: { id: args.id } });
    if (!existing) throw refuse('NOT_FOUND', 'No such extra.');
    const data: { labelFa?: string; labelEn?: string; active?: boolean } = {};
    for (const field of ['labelFa', 'labelEn'] as const) {
      const value = args[field];
      if (value == null) continue;
      if (!value.trim()) throw LABEL_REQUIRED();
      data[field] = value.trim();
    }
    if (args.active != null) data.active = args.active;
    return prisma.extraType.update({ where: { id: args.id }, data });
  },

  /** The whole order, as `reorderHandoverItemTypes`: a stale screen that misses an extra is refused and reloads. */
  reorderExtraTypes: async (_p: unknown, args: { ids: string[] }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const all = await prisma.extraType.findMany({ select: { id: true } });
    const known = new Set(all.map((t) => t.id));
    if (args.ids.length !== known.size || new Set(args.ids).size !== known.size || !args.ids.every((id) => known.has(id))) {
      throw refuse('REORDER_MISMATCH', 'The order must name every extra exactly once.');
    }
    await prisma.$transaction(args.ids.map((id, position) => prisma.extraType.update({ where: { id }, data: { position } })));
    return prisma.extraType.findMany(ordered);
  },
};
