import { GraphQLError } from 'graphql';
import type {
  EntryType,
  EntryVisibility,
  LibraryEntry as LibraryEntryRow,
  Prisma,
  RightsBasis,
  TranslationProvenance,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { storage } from '../../lib/storage.js';
import { buildSearchText, foldPersian, makeSlug, publiclyVisible } from '../../lib/library.js';
import { clampLimit } from '../../lib/pagination.js';

/**
 * The Library's queries and mutations (R1). Guarded by capability, never by
 * role (house rule 1) — `library.write` is the contributor's whole remit,
 * `library.publish` and `library.editTree` are withheld from CONTRIBUTOR
 * (F3's grant table), and every mutation here goes through
 * `requireCapability` accordingly.
 */

const notFound = (what: string) =>
  new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

type LibraryEntryInput = {
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  authors: string;
  venue?: string | null;
  year?: number | null;
  doi?: string | null;
  sourceUrl?: string | null;
  abstractOriginal?: string | null;
  translationProvenance: TranslationProvenance;
  titleTranslated?: string | null;
  abstractTranslated?: string | null;
  translationCredit?: string | null;
  rightsBasis: RightsBasis;
  rightsNote?: string | null;
  visibility: EntryVisibility;
  slug?: string | null;
};

type LibraryConceptInput = { titleFa: string; titleEn: string; slug?: string | null };

/** What the editor reads and what every mutation returns. */
const entryInclude = {
  createdBy: true,
  concepts: { include: { concept: true } },
} satisfies Prisma.LibraryEntryInclude;

async function loadEntry(id: string) {
  const entry = await prisma.libraryEntry.findUnique({ where: { id }, include: entryInclude });
  if (!entry) throw notFound('entry');
  return entry;
}

/** The list screen's shape (§4.4, T1) — never the abstract, never unbounded. */
const rowSelect = {
  id: true,
  slug: true,
  type: true,
  originalLang: true,
  titleOriginal: true,
  titleTranslated: true,
  year: true,
  translationProvenance: true,
  rightsBasis: true,
  publishedAt: true,
  _count: { select: { concepts: true } },
} satisfies Prisma.LibraryEntrySelect;

type RowShape = Prisma.LibraryEntryGetPayload<{ select: typeof rowSelect }>;

const toRow = (r: RowShape) => ({
  id: r.id,
  slug: r.slug,
  type: r.type,
  originalLang: r.originalLang,
  titleOriginal: r.titleOriginal,
  titleTranslated: r.titleTranslated,
  year: r.year,
  translationProvenance: r.translationProvenance,
  rightsBasis: r.rightsBasis,
  publishedAt: r.publishedAt,
  conceptCount: r._count.concepts,
});

/** Deletes a StoredFile row inside a transaction. Caller must have already
 *  nulled the referencing fullTextFileId — `onDelete: Restrict` refuses this
 *  otherwise. Returns the row so its `key` can be unlinked from disk once the
 *  transaction actually commits (a filesystem operation cannot be rolled back
 *  with it). */
async function deleteStoredFileTx(tx: Prisma.TransactionClient, fileId: string) {
  const file = await tx.storedFile.findUnique({ where: { id: fileId } });
  if (file) await tx.storedFile.delete({ where: { id: file.id } });
  return file;
}

/** Best-effort disk cleanup after a transaction that removed a StoredFile row
 *  has committed. A failure here leaves an unreachable file on disk — the
 *  same recoverable state the upload route's own cleanup accepts — never a
 *  row pointing at bytes that are gone. */
async function removeBytes(file: { key: string } | null): Promise<void> {
  if (!file) return;
  await storage.remove(file.key).catch((err) => {
    console.error('[library] failed to remove orphaned bytes', file.key, err);
  });
}

/** T8: the one place `searchText` is rebuilt for an entry, from its current
 *  fields and its current concept tags. Called after any write that changes
 *  either half. */
async function refreshSearchText(entryId: string): Promise<void> {
  const entry = await prisma.libraryEntry.findUnique({ where: { id: entryId } });
  if (!entry) return;
  const links = await prisma.libraryEntryConcept.findMany({
    where: { entryId },
    include: { concept: true },
  });
  await prisma.libraryEntry.update({
    where: { id: entryId },
    data: { searchText: buildSearchText(entry, links.map((l) => l.concept)) },
  });
}

async function uniqueSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.libraryEntry.findMany({
    where: excludeId ? { id: { not: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((r) => r.slug));
}

async function uniqueConceptSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.libraryConcept.findMany({
    where: excludeId ? { id: { not: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((r) => r.slug));
}

export const libraryQueries = {
  libraryEntries: async (
    _p: unknown,
    args: { search?: string; type?: EntryType; limit?: number; offset?: number },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'library.write');
    const where: Prisma.LibraryEntryWhereInput = {
      ...(args.type ? { type: args.type } : {}),
      // searchText is already folded and lower-cased at write time
      // (buildSearchText); folding the needle the same way here is what
      // makes an Arabic-keyboard "كتاب" find a "کتاب" Root typed (§5.1).
      ...(args.search ? { searchText: { contains: foldPersian(args.search) } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.libraryEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: clampLimit(args.limit, 50, 100),
        skip: Math.max(args.offset ?? 0, 0),
        select: rowSelect,
      }),
      prisma.libraryEntry.count({ where }),
    ]);
    return { rows: rows.map(toRow), total };
  },

  libraryEntry: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.write');
    return loadEntry(args.id);
  },

  libraryConcepts: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'library.write');
    return prisma.libraryConcept.findMany({ orderBy: { titleEn: 'asc' } });
  },
};

/** The public list row (R2.md §2.3, T1) — thin like the staff row, plus
 *  fullTextUrl: whether a PDF exists is exactly what a reader browsing the
 *  list decides on before opening an entry. */
const publicRowSelect = {
  id: true,
  slug: true,
  type: true,
  originalLang: true,
  titleOriginal: true,
  titleTranslated: true,
  year: true,
  translationProvenance: true,
  rightsBasis: true,
  fullTextFileId: true,
  publishedAt: true,
  _count: { select: { concepts: true } },
} satisfies Prisma.LibraryEntrySelect;

type PublicRowShape = Prisma.LibraryEntryGetPayload<{ select: typeof publicRowSelect }>;

const toPublicRow = (r: PublicRowShape) => ({
  id: r.id,
  slug: r.slug,
  type: r.type,
  originalLang: r.originalLang,
  titleOriginal: r.titleOriginal,
  titleTranslated: r.titleTranslated,
  year: r.year,
  translationProvenance: r.translationProvenance,
  rightsBasis: r.rightsBasis,
  fullTextUrl: r.fullTextFileId ? `/files/${r.fullTextFileId}` : null,
  // Never null: every row this query returns matched publiclyVisible, which
  // requires publishedAt not null (T2's "not found" only applies below it).
  publishedAt: r.publishedAt as Date,
  conceptCount: r._count.concepts,
});

const publicEntryInclude = {
  concepts: { include: { concept: true } },
} satisfies Prisma.LibraryEntryInclude;

type PublicEntryShape = Prisma.LibraryEntryGetPayload<{ include: typeof publicEntryInclude }>;

/** §2.3's expose list, field by field — no searchText, no visibility, no
 *  fullTextFileId, no createdBy. Built once here rather than left to field
 *  resolvers, so there is exactly one funnel a public field can leak through. */
const toPublicEntry = (e: PublicEntryShape) => ({
  id: e.id,
  slug: e.slug,
  type: e.type,
  originalLang: e.originalLang,
  titleOriginal: e.titleOriginal,
  authors: e.authors,
  venue: e.venue,
  year: e.year,
  doi: e.doi,
  sourceUrl: e.sourceUrl,
  abstractOriginal: e.abstractOriginal,
  translationProvenance: e.translationProvenance,
  titleTranslated: e.titleTranslated,
  abstractTranslated: e.abstractTranslated,
  translationCredit: e.translationCredit,
  rightsBasis: e.rightsBasis,
  rightsNote: e.rightsNote,
  fullTextUrl: e.fullTextFileId ? `/files/${e.fullTextFileId}` : null,
  publishedAt: e.publishedAt as Date,
  concepts: e.concepts.map((lc) => ({
    slug: lc.concept.slug,
    titleFa: lc.concept.titleFa,
    titleEn: lc.concept.titleEn,
  })),
});

/**
 * The public reader's three queries (R2.md §2). No requireCapability
 * anywhere in this object — that omission is the point, and it is also why
 * every one of them filters through publiclyVisible rather than trusting a
 * caller-supplied flag. This is the first place in the app an unauthenticated
 * request reaches a resolver at all.
 */
export const publicLibraryQueries = {
  publicLibraryEntries: async (
    _p: unknown,
    args: { search?: string; type?: EntryType; conceptSlug?: string; limit?: number; offset?: number },
  ) => {
    const where: Prisma.LibraryEntryWhereInput = {
      ...publiclyVisible,
      ...(args.type ? { type: args.type } : {}),
      ...(args.search ? { searchText: { contains: foldPersian(args.search) } } : {}),
      ...(args.conceptSlug ? { concepts: { some: { concept: { slug: args.conceptSlug } } } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.libraryEntry.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        // §2.2: a smaller ceiling than the staff list's 100 — an anonymous
        // caller has no scrolling-their-own-corpus excuse for a big page.
        take: clampLimit(args.limit, 24, 60),
        skip: Math.max(args.offset ?? 0, 0),
        select: publicRowSelect,
      }),
      prisma.libraryEntry.count({ where }),
    ]);
    return { rows: rows.map(toPublicRow), total };
  },

  publicLibraryEntry: async (_p: unknown, args: { slug: string }) => {
    const entry = await prisma.libraryEntry.findFirst({
      where: { ...publiclyVisible, slug: args.slug },
      include: publicEntryInclude,
    });
    // T2: a draft's slug, a private entry's slug and a slug nobody ever used
    // are one answer here — not found — so this endpoint cannot be used to
    // learn which slugs exist as drafts.
    return entry ? toPublicEntry(entry) : null;
  },

  publicLibraryConcepts: async () => {
    const concepts = await prisma.libraryConcept.findMany({
      where: { entries: { some: { entry: publiclyVisible } } },
      orderBy: { titleEn: 'asc' },
    });
    return concepts.map((c) => ({ slug: c.slug, titleFa: c.titleFa, titleEn: c.titleEn }));
  },
};

export const libraryMutations = {
  createLibraryEntry: async (_p: unknown, args: { input: LibraryEntryInput }, ctx: Context) => {
    const user = requireCapability(ctx, 'library.write');
    const { input } = args;
    const slug = makeSlug(input.titleOriginal, await uniqueSlugs(), input.slug);

    const entry = await prisma.libraryEntry.create({
      data: {
        slug,
        type: input.type,
        originalLang: input.originalLang,
        titleOriginal: input.titleOriginal,
        authors: input.authors,
        venue: input.venue ?? null,
        year: input.year ?? null,
        doi: input.doi ?? null,
        sourceUrl: input.sourceUrl ?? null,
        abstractOriginal: input.abstractOriginal ?? null,
        translationProvenance: input.translationProvenance,
        titleTranslated: input.titleTranslated ?? null,
        abstractTranslated: input.abstractTranslated ?? null,
        translationCredit: input.translationCredit ?? null,
        rightsBasis: input.rightsBasis,
        rightsNote: input.rightsNote ?? null,
        visibility: input.visibility,
        searchText: buildSearchText(input, []),
        createdById: user.id,
      },
    });
    return loadEntry(entry.id);
  },

  updateLibraryEntry: async (
    _p: unknown,
    args: { id: string; input: LibraryEntryInput },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'library.write');
    const existing = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!existing) throw notFound('entry');
    const { input } = args;

    // T4: the slug is a URL, and only free to move before it has been handed
    // out.
    let slug = existing.slug;
    if (input.slug && input.slug !== existing.slug) {
      if (existing.publishedAt) {
        throw new GraphQLError('The slug cannot change once this entry is published.', {
          extensions: { code: 'SLUG_LOCKED' },
        });
      }
      slug = makeSlug(existing.titleOriginal, await uniqueSlugs(existing.id), input.slug);
    }

    const links = await prisma.libraryEntryConcept.findMany({
      where: { entryId: existing.id },
      include: { concept: true },
    });
    const searchText = buildSearchText(input, links.map((l) => l.concept));

    // §4.3: flipping rights or visibility so a hosted file is no longer
    // allowed must delete the bytes, not just the reference — the file sits
    // at a public URL Nginx serves with no code in the request, so "link
    // only" beside a PDF still on disk is the failure §1 exists to prevent.
    const mustDetach =
      existing.fullTextFileId !== null &&
      (input.rightsBasis === 'LINK_ONLY' || input.visibility === 'PRIVATE');

    let removedFile: { key: string } | null = null;
    await prisma.$transaction(async (tx) => {
      await tx.libraryEntry.update({
        where: { id: existing.id },
        data: {
          slug,
          type: input.type,
          originalLang: input.originalLang,
          titleOriginal: input.titleOriginal,
          authors: input.authors,
          venue: input.venue ?? null,
          year: input.year ?? null,
          doi: input.doi ?? null,
          sourceUrl: input.sourceUrl ?? null,
          abstractOriginal: input.abstractOriginal ?? null,
          translationProvenance: input.translationProvenance,
          titleTranslated: input.titleTranslated ?? null,
          abstractTranslated: input.abstractTranslated ?? null,
          translationCredit: input.translationCredit ?? null,
          rightsBasis: input.rightsBasis,
          rightsNote: input.rightsNote ?? null,
          visibility: input.visibility,
          searchText,
          ...(mustDetach ? { fullTextFileId: null } : {}),
        },
      });
      // Nulled above first — onDelete: Restrict refuses this otherwise.
      if (mustDetach && existing.fullTextFileId) {
        removedFile = await deleteStoredFileTx(tx, existing.fullTextFileId);
      }
    });
    await removeBytes(removedFile);

    return loadEntry(existing.id);
  },

  deleteLibraryEntry: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.write');
    const existing = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!existing) throw notFound('entry');

    // T3: deleting the entry does not delete its bytes on its own —
    // onDelete: Restrict only stops the *file* from being deleted while an
    // entry points at it. The reverse has to be done here, explicitly,
    // before the entry itself goes.
    let removedFile: { key: string } | null = null;
    await prisma.$transaction(async (tx) => {
      if (existing.fullTextFileId) {
        await tx.libraryEntry.update({ where: { id: existing.id }, data: { fullTextFileId: null } });
        removedFile = await deleteStoredFileTx(tx, existing.fullTextFileId);
      }
      await tx.libraryEntry.delete({ where: { id: existing.id } }); // cascades LibraryEntryConcept
    });
    await removeBytes(removedFile);
    return true;
  },

  setEntryConcepts: async (
    _p: unknown,
    args: { id: string; conceptIds: string[] },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'library.write');
    const entry = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!entry) throw notFound('entry');
    const concepts = await prisma.libraryConcept.findMany({ where: { id: { in: args.conceptIds } } });
    const searchText = buildSearchText(entry, concepts);

    await prisma.$transaction([
      prisma.libraryEntryConcept.deleteMany({ where: { entryId: entry.id } }),
      prisma.libraryEntryConcept.createMany({
        data: concepts.map((c) => ({ entryId: entry.id, conceptId: c.id })),
      }),
      prisma.libraryEntry.update({ where: { id: entry.id }, data: { searchText } }),
    ]);
    return loadEntry(entry.id);
  },

  detachEntryFullText: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.write');
    const entry = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!entry) throw notFound('entry');
    if (!entry.fullTextFileId) {
      throw new GraphQLError('This entry has no hosted file to detach.', {
        extensions: { code: 'NO_FILE' },
      });
    }

    let removedFile: { key: string } | null = null;
    const fileId = entry.fullTextFileId;
    await prisma.$transaction(async (tx) => {
      await tx.libraryEntry.update({ where: { id: entry.id }, data: { fullTextFileId: null } });
      removedFile = await deleteStoredFileTx(tx, fileId);
    });
    await removeBytes(removedFile);
    return loadEntry(entry.id);
  },

  publishLibraryEntry: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.publish');
    const entry = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!entry) throw notFound('entry');

    // §4.2: the CHECK covers this on every write already, and re-asserting a
    // rule the database already enforces is exactly the reasoning that goes
    // stale — but publish is the one moment nothing else here re-derives
    // the state, so it is asserted once more, deliberately.
    if (
      entry.fullTextFileId &&
      (entry.rightsBasis === 'LINK_ONLY' || entry.visibility !== 'PUBLIC')
    ) {
      throw new GraphQLError('The rights on this entry no longer allow a hosted file.', {
        extensions: { code: 'RIGHTS_FORBID_HOSTING' },
      });
    }

    if (!entry.publishedAt) {
      await prisma.libraryEntry.update({ where: { id: entry.id }, data: { publishedAt: new Date() } });
    }
    return loadEntry(entry.id);
  },

  unpublishLibraryEntry: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.publish');
    const entry = await prisma.libraryEntry.findUnique({ where: { id: args.id } });
    if (!entry) throw notFound('entry');
    await prisma.libraryEntry.update({ where: { id: entry.id }, data: { publishedAt: null } });
    return loadEntry(entry.id);
  },

  /** A contributor's own remit — filing an entry that needs a tag which does
   *  not exist yet should not require stopping to ask an admin (§4.2). */
  createLibraryConcept: async (_p: unknown, args: { input: LibraryConceptInput }, ctx: Context) => {
    requireCapability(ctx, 'library.write');
    const slug = makeSlug(args.input.titleEn, await uniqueConceptSlugs(), args.input.slug);
    return prisma.libraryConcept.create({
      data: { slug, titleFa: args.input.titleFa, titleEn: args.input.titleEn },
    });
  },

  /** Renaming and nesting the ontology is library.editTree, not
   *  library.write (§4.2) — this is R3's verb, not the contributor's. */
  updateLibraryConcept: async (
    _p: unknown,
    args: { id: string; input: LibraryConceptInput },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'library.editTree');
    const existing = await prisma.libraryConcept.findUnique({ where: { id: args.id } });
    if (!existing) throw notFound('concept');

    let slug = existing.slug;
    if (args.input.slug && args.input.slug !== existing.slug) {
      slug = makeSlug(args.input.titleEn, await uniqueConceptSlugs(existing.id), args.input.slug);
    }

    const linkedEntryIds = (
      await prisma.libraryEntryConcept.findMany({
        where: { conceptId: existing.id },
        select: { entryId: true },
      })
    ).map((l) => l.entryId);

    const updated = await prisma.libraryConcept.update({
      where: { id: existing.id },
      data: { slug, titleFa: args.input.titleFa, titleEn: args.input.titleEn },
    });
    // T8: a concept's titles contribute to every entry tagged with it.
    await Promise.all(linkedEntryIds.map((id) => refreshSearchText(id)));
    return updated;
  },

  deleteLibraryConcept: async (_p: unknown, args: { id: string }, ctx: Context) => {
    requireCapability(ctx, 'library.editTree');
    const existing = await prisma.libraryConcept.findUnique({ where: { id: args.id } });
    if (!existing) throw notFound('concept');

    const linkedEntryIds = (
      await prisma.libraryEntryConcept.findMany({
        where: { conceptId: existing.id },
        select: { entryId: true },
      })
    ).map((l) => l.entryId);

    await prisma.libraryConcept.delete({ where: { id: existing.id } }); // cascades the join rows
    await Promise.all(linkedEntryIds.map((id) => refreshSearchText(id)));
    return true;
  },
};

/** Field resolvers — what a LibraryEntry row looks like over the wire. */
export const LibraryEntry = {
  fullTextUrl: (e: LibraryEntryRow) => (e.fullTextFileId ? `/files/${e.fullTextFileId}` : null),
  concepts: (e: { concepts: Array<{ concept: unknown }> }) => e.concepts.map((lc) => lc.concept),
};
