import { GraphQLError } from 'graphql';
import type { Prisma, RtlSupport } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { canReadThemes, checkDemoUrl, parseLicenseCost } from '../../lib/themes.js';

/**
 * The theme catalogue (journeys build plan T2, the first half of T2 + J8).
 *
 * A designer (`templates.types`) keeps a list of ready-made site themes — name,
 * vendor, demo link, preview image, how well it handles RTL, what the licence
 * costs Root — and says which template types each is offered for. Reading is
 * as wide as T1's `templateTypes` (either template capability, or
 * `contracts.author`), through `canReadThemes`.
 *
 * **`licenseCost` is not gated by `money.read`, on purpose.** PD-14's
 * `money.read` protects what a *customer* pays or owes — `Contract.amount`,
 * `budgetCap`, the payment plan — so that a designer answering a customer's
 * comment does not read the numbers in it. A theme's licence cost is the
 * opposite kind of figure: what Root pays a vendor. It says nothing about any
 * customer, and the designer needs it to choose (plan Q-S18 lists it as one of
 * the four things the catalogue exists to show). What keeps it private is that
 * no customer-facing resolver returns a `Theme` at all; J8's snapshot of a
 * theme into a design round must therefore copy `name`, `vendor` and
 * `demoUrl` only.
 *
 * **There is no delete.** J8 snapshots themes into design rounds and points
 * `DesignConcept.themeId` here, so a theme that ever appeared in a round must
 * outlive it; `active: false` is the whole of "retire a theme".
 *
 * **The demo link is never framed.** Third-party demos refuse framing more
 * often than not and the portal's CSP does not allow them (the plan's J8
 * `frame-src` decision); every surface shows `demoUrl` as a link that opens in
 * a new tab.
 */

const include = { types: { select: { typeId: true } } } satisfies Prisma.ThemeInclude;

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

const notFound = () => refuse('NOT_FOUND', 'No such theme.');

const RTL_VALUES: readonly string[] = ['FULL', 'PARTIAL', 'NONE', 'UNKNOWN'] satisfies RtlSupport[];

/** Text a person typed: trimmed, and an empty string means "nothing" — which
 *  is how a form clears an optional field (a GraphQL `null` means "leave it
 *  alone" on update, the way `updateTemplateType` reads it). */
const cleaned = (value: string) => value.trim() || null;

function requireReader(ctx: Context) {
  const user = requireUser(ctx);
  if (!canReadThemes(user)) throw refuse('FORBIDDEN', 'You do not have access to that.');
  return user;
}

type ThemeFields = {
  name?: string | null;
  vendor?: string | null;
  demoUrl?: string | null;
  rtlSupport?: string | null;
  licenseCost?: string | null;
  notesFa?: string | null;
  notesEn?: string | null;
};

/**
 * Turns the optional arguments shared by create and update into a column
 * patch, refusing before anything is written. Omitted or null fields are not
 * in the patch; an empty string clears an optional column.
 */
function patchFrom(args: ThemeFields): Prisma.ThemeUpdateInput {
  const data: Prisma.ThemeUpdateInput = {};

  if (args.name != null) {
    const name = args.name.trim();
    if (!name) throw refuse('NAME_REQUIRED', 'A theme needs a name.');
    data.name = name;
  }
  if (args.vendor != null) data.vendor = cleaned(args.vendor);
  if (args.demoUrl != null) {
    const url = cleaned(args.demoUrl);
    if (url !== null) {
      const code = checkDemoUrl(url);
      if (code === 'INVALID_DEMO_URL') throw refuse(code, 'That is not a valid URL.');
      if (code === 'DEMO_URL_NOT_HTTPS') throw refuse(code, 'A demo link must be https.');
    }
    data.demoUrl = url;
  }
  if (args.rtlSupport != null) {
    if (!RTL_VALUES.includes(args.rtlSupport)) throw refuse('INVALID_RTL_SUPPORT', 'Unknown RTL support value.');
    data.rtlSupport = args.rtlSupport as RtlSupport;
  }
  if (args.licenseCost != null) {
    const raw = cleaned(args.licenseCost);
    if (raw === null) {
      data.licenseCost = null;
    } else {
      const cost = parseLicenseCost(raw);
      if (cost === null) {
        throw refuse('INVALID_AMOUNT', 'A licence cost is a whole number of Toman — no sign, no decimal point.');
      }
      data.licenseCost = cost;
    }
  }
  if (args.notesFa != null) data.notesFa = cleaned(args.notesFa);
  if (args.notesEn != null) data.notesEn = cleaned(args.notesEn);
  return data;
}

export const themeQueries = {
  /** `activeOnly` is the picker's view (what J8 will offer); the desk's
   *  Themes tab wants both, to reactivate. Name order, ties by age. */
  themes: async (_p: unknown, args: { activeOnly?: boolean | null }, ctx: Context) => {
    requireReader(ctx);
    return prisma.theme.findMany({
      where: args.activeOnly ? { active: true } : {},
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include,
    });
  },
};

export const themeMutations = {
  createTheme: async (
    _p: unknown,
    args: ThemeFields & { name: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'templates.types');
    const data = patchFrom(args);
    // `patchFrom` only sets `name` when it is non-null, and the schema makes it
    // required — so this is unreachable through GraphQL, and stated anyway.
    if (data.name === undefined) throw refuse('NAME_REQUIRED', 'A theme needs a name.');
    return prisma.theme.create({ data: data as Prisma.ThemeCreateInput, include });
  },

  /**
   * Omitted (or null) fields are left as they are; an empty string clears an
   * optional one. `active: false` is the whole of "retire a theme" — see the
   * file comment on why there is no delete. A deactivated theme keeps its
   * type assignments, so reactivating it puts it back where it was.
   */
  updateTheme: async (
    _p: unknown,
    args: ThemeFields & { id: string; active?: boolean | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'templates.types');
    const existing = await prisma.theme.findUnique({ where: { id: args.id }, select: { id: true } });
    if (!existing) throw notFound();

    const data = patchFrom(args);
    if (args.active != null) data.active = args.active;
    return prisma.theme.update({ where: { id: args.id }, data, include });
  },

  /**
   * Replace-all, like `setTemplateScope` and for the same reason: the set of
   * checkboxes on screen is the set, so there is no per-row merge to get wrong.
   * Everything a refusal could turn on is checked **before** the transaction
   * opens, so a refused input never touches the old assignments; the
   * transaction makes it all-or-nothing when something the checks cannot
   * foresee fails between the delete and the insert.
   *
   * The type row is locked `FOR UPDATE` for the transaction's length, the way
   * `setTemplateScope` locks it: without it two concurrent replaces both
   * delete, both insert, and the second dies on the composite key — a refusal
   * about a race nobody typed. With it the second waits, then replaces the
   * first's set (ordinary last-writer-wins).
   *
   * An **inactive** theme may be assigned, and is kept if it already was:
   * dropping it here would make deactivation lossy (reactivating it later
   * would find it unassigned). Whether it is *offered* is `activeOnly`'s job.
   *
   * Returns the whole catalogue, because the rows that changed are on both
   * sides of the replace (themes dropped from the type, themes added) and the
   * client's cache should not have to work out which.
   */
  setTemplateTypeThemes: async (_p: unknown, args: { typeId: string; themeIds: string[] }, ctx: Context) => {
    requireCapability(ctx, 'templates.types');
    const type = await prisma.templateType.findUnique({ where: { id: args.typeId }, select: { id: true } });
    if (!type) throw refuse('NOT_FOUND', 'No such template type.');

    if (new Set(args.themeIds).size !== args.themeIds.length) {
      throw refuse('DUPLICATE_THEME', 'A theme can be named only once in the list.');
    }
    const known = await prisma.theme.count({ where: { id: { in: args.themeIds } } });
    if (known !== args.themeIds.length) throw refuse('THEME_NOT_FOUND', 'One of those themes does not exist.');

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TemplateType" WHERE "id" = ${type.id} FOR UPDATE`;
      await tx.templateTypeTheme.deleteMany({ where: { typeId: type.id } });
      await tx.templateTypeTheme.createMany({
        data: args.themeIds.map((themeId) => ({ typeId: type.id, themeId })),
      });
    });
    return prisma.theme.findMany({
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include,
    });
  },
};

/** Field resolvers for the `Theme` type (registered in resolvers/index.ts). */
export const Theme = {
  // BigInt does not survive JSON (house rule 9; Contract.amount's precedent).
  licenseCost: (t: { licenseCost: bigint | null }) => (t.licenseCost === null ? null : t.licenseCost.toString()),
  // The same PRIVATE-file route every other class downloads through, which
  // re-checks who is asking on every request (routes/files.ts).
  previewUrl: (t: { previewFileId: string | null }) => (t.previewFileId ? `/files/${t.previewFileId}` : null),
  typeIds: (t: { types: Array<{ typeId: string }> }) => t.types.map((x) => x.typeId),
};
