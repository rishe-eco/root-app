import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { checkSlug, checkTemplateScope, type TemplateScopeInput } from '../../lib/templateScope.js';

/**
 * Template types and their scope lists (journeys build plan T1).
 *
 * Two halves with two capabilities, on purpose, and never merged: a designer
 * keeps the *types* (`templates.types`), sales keeps what each type *contains*
 * (`templates.scope`, Q-S11). Reading is wider than either — the desk shows a
 * designer the scope list they cannot edit and sales the types they cannot —
 * and includes `contracts.author`, since J4's brief will have sales pick a type
 * and a picker that could not read its own options would be a bug waiting for
 * a role change. Today that third clause admits no one the first two do not
 * (SALES holds both `templates.scope` and `contracts.author`); it is written
 * out so the rule does not depend on that coincidence.
 *
 * **There is no delete.** J4's `ContractBrief.templateTypeId` will be
 * `onDelete: Restrict`, so a type in use could never be removed anyway; rather
 * than ship a delete that works today and starts failing when J4 lands, the
 * screen offers `active: false` and this file offers nothing else.
 */

const include = { items: { orderBy: [{ position: 'asc' as const }, { key: 'asc' as const }] } } satisfies Prisma.TemplateTypeInclude;

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

const notFound = () => refuse('NOT_FOUND', 'No such template type.');

const LABEL_REQUIRED = () => refuse('LABEL_REQUIRED', 'Both labels are required.');

/** A slug unique violation, as the refusal a person can act on. Checked
 *  structurally, like `asConcurrentPublish` (admin/shared.ts) and
 *  `lib/logging.ts`: no Prisma error class imported. */
function asSlugTaken(err: unknown): unknown {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
    return refuse('TEMPLATE_SLUG_TAKEN', 'A template type with that slug already exists.');
  }
  return err;
}

function requireReader(ctx: Context) {
  const user = requireUser(ctx);
  if (!can(user, 'templates.types') && !can(user, 'templates.scope') && !can(user, 'contracts.author')) {
    throw refuse('FORBIDDEN', 'You do not have access to that.');
  }
  return user;
}

export const templateQueries = {
  templateTypes: async (_p: unknown, args: { activeOnly?: boolean | null }, ctx: Context) => {
    requireReader(ctx);
    return prisma.templateType.findMany({
      where: args.activeOnly ? { active: true } : {},
      orderBy: [{ position: 'asc' }, { slug: 'asc' }],
      include,
    });
  },
};

export const templateMutations = {
  createTemplateType: async (
    _p: unknown,
    args: { slug: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'templates.types');
    if (checkSlug(args.slug)) throw refuse('INVALID_SLUG', 'A slug is lowercase Latin letters, digits and hyphens.');
    const labelFa = args.labelFa.trim();
    const labelEn = args.labelEn.trim();
    if (!labelFa || !labelEn) throw LABEL_REQUIRED();

    // Last in the list. Two creates racing can share a position; the list is
    // ordered by (position, slug), so they still read in a stable order and
    // `reorderTemplateTypes` settles it the first time anyone reorders.
    const last = await prisma.templateType.aggregate({ _max: { position: true } });
    try {
      return await prisma.templateType.create({
        data: { slug: args.slug, labelFa, labelEn, position: (last._max.position ?? -1) + 1 },
        include,
      });
    } catch (err) {
      throw asSlugTaken(err);
    }
  },

  /**
   * Omitted (or null) fields are left as they are. `active: false` is the
   * whole of "retire a type" — see the file comment on why there is no delete.
   */
  updateTemplateType: async (
    _p: unknown,
    args: { id: string; slug?: string | null; labelFa?: string | null; labelEn?: string | null; active?: boolean | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'templates.types');
    const existing = await prisma.templateType.findUnique({ where: { id: args.id } });
    if (!existing) throw notFound();

    const data: Prisma.TemplateTypeUpdateInput = {};
    if (args.slug != null) {
      if (checkSlug(args.slug)) throw refuse('INVALID_SLUG', 'A slug is lowercase Latin letters, digits and hyphens.');
      data.slug = args.slug;
    }
    for (const field of ['labelFa', 'labelEn'] as const) {
      const value = args[field];
      if (value == null) continue;
      if (!value.trim()) throw LABEL_REQUIRED();
      data[field] = value.trim();
    }
    if (args.active != null) data.active = args.active;

    try {
      return await prisma.templateType.update({ where: { id: args.id }, data, include });
    } catch (err) {
      throw asSlugTaken(err);
    }
  },

  /**
   * The whole order, not one move: `ids` must name every type exactly once. A
   * partial list would have to say where the unnamed types go, and every
   * answer is a small surprise; a stale screen that is missing a type another
   * designer just added is refused instead, and reloads.
   */
  reorderTemplateTypes: async (_p: unknown, args: { ids: string[] }, ctx: Context) => {
    requireCapability(ctx, 'templates.types');
    const all = await prisma.templateType.findMany({ select: { id: true } });
    const known = new Set(all.map((t) => t.id));
    if (args.ids.length !== known.size || new Set(args.ids).size !== known.size || !args.ids.every((id) => known.has(id))) {
      throw refuse('REORDER_MISMATCH', 'The order must name every template type exactly once.');
    }
    await prisma.$transaction(
      args.ids.map((id, position) => prisma.templateType.update({ where: { id }, data: { position } })),
    );
    return prisma.templateType.findMany({ orderBy: [{ position: 'asc' }, { slug: 'asc' }], include });
  },

  /**
   * Replace-all: the list on screen is the list, so there is no per-row merge
   * to get wrong. Everything a refusal could turn on is checked **before** the
   * transaction opens (`checkTemplateScope`), so a refused input never touches
   * the old list; the transaction is what makes it all-or-nothing when
   * something the checks cannot foresee fails between the delete and the
   * insert.
   *
   * The type row is locked for the transaction's length. Without it two
   * concurrent replaces both delete (the second finds nothing), both insert,
   * and the second dies on `@@unique([typeId, key])` — a refusal about a race
   * nobody typed. With it the second waits, then replaces the first's list,
   * which is the ordinary last-writer-wins a replace-all promises.
   */
  setTemplateScope: async (
    _p: unknown,
    args: { typeId: string; items: TemplateScopeInput[] },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'templates.scope');
    const type = await prisma.templateType.findUnique({ where: { id: args.typeId }, select: { id: true } });
    if (!type) throw notFound();

    const code = checkTemplateScope(args.items);
    if (code === 'INVALID_KEY') throw refuse(code, 'A key is lowercase Latin letters, digits and hyphens.');
    if (code === 'DUPLICATE_TEMPLATE_KEY') throw refuse(code, 'Two items in the list share a key.');
    if (code === 'INVALID_TEMPLATE_KIND') throw refuse(code, 'A template item is a page, a feature or a deliverable.');
    if (code === 'LABEL_REQUIRED') throw LABEL_REQUIRED();

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TemplateType" WHERE "id" = ${type.id} FOR UPDATE`;
      await tx.templateScopeItem.deleteMany({ where: { typeId: type.id } });
      await tx.templateScopeItem.createMany({
        data: args.items.map((item, position) => ({
          typeId: type.id,
          key: item.key,
          kind: item.kind as 'PAGE' | 'FEATURE' | 'DELIVERABLE',
          labelFa: item.labelFa.trim(),
          labelEn: item.labelEn.trim(),
          position,
        })),
      });
      return tx.templateType.findUniqueOrThrow({ where: { id: type.id }, include });
    });
  },
};
