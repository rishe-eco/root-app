/**
 * What "unchanged" means between two design revisions.
 *
 * One definition, used twice: the carry-forward rule when a revision is
 * published, and the diff the customer is shown. Two implementations of this
 * would drift, and the visible one would be the one that *looks* right while
 * the gate quietly did something else.
 */

export type PageShape = {
  key: string;
  imageUrl: string | null;
  approvedAt: Date | null;
};

export type ConceptShape = {
  key: string;
  chosenAt: Date | null;
  pages: PageShape[];
};

/** Same page, same image — the customer has nothing new to look at. */
export function pageUnchanged(before: PageShape | undefined, after: PageShape): boolean {
  return before !== undefined && before.imageUrl === after.imageUrl;
}

export type PageChange = {
  conceptKey: string;
  pageKey: string;
  kind: 'added' | 'changed' | 'removed' | 'unchanged';
};

export function diffDesign(before: ConceptShape[], after: ConceptShape[]): PageChange[] {
  const changes: PageChange[] = [];
  const beforeByKey = new Map(before.map((c) => [c.key, c]));

  for (const concept of after) {
    const prior = beforeByKey.get(concept.key);
    const priorPages = new Map((prior?.pages ?? []).map((p) => [p.key, p]));
    for (const page of concept.pages) {
      const priorPage = priorPages.get(page.key);
      changes.push({
        conceptKey: concept.key,
        pageKey: page.key,
        kind:
          priorPage === undefined
            ? 'added'
            : pageUnchanged(priorPage, page)
              ? 'unchanged'
              : 'changed',
      });
      priorPages.delete(page.key);
    }
    for (const gone of priorPages.keys()) {
      changes.push({ conceptKey: concept.key, pageKey: gone, kind: 'removed' });
    }
  }

  const afterKeys = new Set(after.map((c) => c.key));
  for (const concept of before) {
    if (afterKeys.has(concept.key)) continue;
    for (const page of concept.pages) {
      changes.push({ conceptKey: concept.key, pageKey: page.key, kind: 'removed' });
    }
  }

  return changes;
}

export type CarriedApproval = { conceptKey: string; pageKey: string; approvedAt: Date };

/**
 * Which approvals survive into a newly published revision.
 *
 * A page keeps its approval if it was approved before and its image has not
 * moved; a changed or new page resets. The chosen concept carries forward if
 * that concept still exists, so a one-page tweak asks for one re-approval
 * rather than four.
 *
 * This does not loosen the gate — `designComplete` still requires every page in
 * the *current* revision approved. Carry-forward only pre-fills the ones that
 * already were.
 */
export function carryForward(
  before: ConceptShape[],
  after: ConceptShape[],
): { approvals: CarriedApproval[]; chosenConceptKey: string | null } {
  const beforeByKey = new Map(before.map((c) => [c.key, c]));
  const approvals: CarriedApproval[] = [];

  for (const concept of after) {
    const prior = beforeByKey.get(concept.key);
    if (!prior) continue;
    const priorPages = new Map(prior.pages.map((p) => [p.key, p]));
    for (const page of concept.pages) {
      const priorPage = priorPages.get(page.key);
      if (priorPage?.approvedAt && pageUnchanged(priorPage, page)) {
        approvals.push({
          conceptKey: concept.key,
          pageKey: page.key,
          approvedAt: priorPage.approvedAt,
        });
      }
    }
  }

  const previouslyChosen = before.find((c) => c.chosenAt !== null) ?? null;
  const stillExists =
    previouslyChosen !== null && after.some((c) => c.key === previouslyChosen.key);

  return { approvals, chosenConceptKey: stillExists ? previouslyChosen!.key : null };
}

// --- the palette (journeys build plan J8) -----------------------------------------

/**
 * The palette, for the two questions this file answers about a revision:
 * "did anything change?" (a round that changes only a colour must still be
 * publishable, or `NO_CHANGES` would refuse it) and "what is copied into the
 * next draft?". A palette item carries no approval — the customer approves the
 * design as a whole — so unlike a page there is nothing to *carry*, only to
 * *copy*; `draftDesignRevision` does the copying and this is the shape it
 * copies.
 */
export type PaletteShape = {
  kind: string;
  role: string;
  value: string;
  labelFa: string;
  labelEn: string;
  imageFileId: string | null;
};

const paletteKey = (p: Pick<PaletteShape, 'kind' | 'role'>) => `${p.kind}:${p.role}`;

/** Same kind and role, same everything the customer would see. */
export function paletteItemUnchanged(before: PaletteShape | undefined, after: PaletteShape): boolean {
  return (
    before !== undefined &&
    before.value === after.value &&
    before.labelFa === after.labelFa &&
    before.labelEn === after.labelEn &&
    before.imageFileId === after.imageFileId
  );
}

/** Whether the draft's palette differs from the published one in any item. */
export function paletteChanged(before: readonly PaletteShape[], after: readonly PaletteShape[]): boolean {
  if (before.length !== after.length) return true;
  const priorByKey = new Map(before.map((p) => [paletteKey(p), p]));
  return after.some((p) => !paletteItemUnchanged(priorByKey.get(paletteKey(p)), p));
}

/**
 * **Whether publishing the draft would change anything** — the condition
 * `publishDesignRevision` refuses (`NO_CHANGES`) when false, and the one place
 * it is written now that a revision is concepts, pages *and* palette. The
 * concept and page comparison is `diffDesign`, unchanged; a palette-only edit
 * used to be invisible to it.
 */
export function designChanged(
  before: { concepts: ConceptShape[]; palette: readonly PaletteShape[] },
  after: { concepts: ConceptShape[]; palette: readonly PaletteShape[] },
): boolean {
  const previousKeys = new Set(before.concepts.map((c) => c.key));
  const draftKeys = new Set(after.concepts.map((c) => c.key));
  const sameConceptKeys = previousKeys.size === draftKeys.size && [...previousKeys].every((k) => draftKeys.has(k));
  if (!sameConceptKeys) return true;
  if (diffDesign(before.concepts, after.concepts).some((c) => c.kind !== 'unchanged')) return true;
  return paletteChanged(before.palette, after.palette);
}

// --- theme rounds (journeys build plan J8) ----------------------------------------

/**
 * What a design round remembers of a theme (journeys build plan J8, T2's
 * decision): **name, vendor and demo URL, and nothing else.** Never the licence
 * cost — that is Root's procurement figure, and the round is read by the
 * customer — and never the notes. `snapshotTheme` picks exactly these three keys
 * by name, so a theme row (or a future column on it) handed in whole cannot leak
 * through a spread; `design.test.ts` hands it a theme with a licence cost and
 * checks the result has none.
 */
export type ThemeSnapshot = { name: string; vendor: string | null; demoUrl: string | null };

export function snapshotTheme(theme: { name: string; vendor: string | null; demoUrl: string | null }): ThemeSnapshot {
  return { name: theme.name, vendor: theme.vendor, demoUrl: theme.demoUrl };
}

/** A stored snapshot read back: the three known keys or nothing. The column is
 *  JSON, so what the database holds is not trusted to be what was written. */
export function readThemeSnapshot(value: unknown): ThemeSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string') return null;
  return {
    name: v.name,
    vendor: typeof v.vendor === 'string' ? v.vendor : null,
    demoUrl: typeof v.demoUrl === 'string' ? v.demoUrl : null,
  };
}

/** A theme concept's key within a round — stable across rounds, so a theme that
 *  is proposed again in a later round is the same concept to `carryForward`
 *  (and keeps a choice the customer already made), and unique within one. */
export const themeConceptKey = (themeId: string): string => `theme-${themeId}`;

/** What the customer's "show me other options" says when they add no words of
 *  their own — a comment in the thread like any other, in their language. */
export function otherOptionsAskBody(locale: string | null | undefined): string {
  return locale === 'en' ? 'Please show me other options.' : 'لطفاً گزینه‌های دیگری نشانم بده.';
}

/**
 * What the designer's answer says when a new round resolves "show me other
 * options" — the closure on record (journeys spec F9), written into the thread
 * in the customer's language because it is a comment the customer reads, not a
 * code. The round is a count, so Persian prose gets Persian digits (house rule 14).
 */
export function roundPublishedAnswer(locale: string | null | undefined, round: number): string {
  return locale === 'en'
    ? `Round ${round} is up with new options — have a look and pick the one you like.`
    : `دورِ ${new Intl.NumberFormat('fa-IR').format(round)} با گزینه‌های تازه منتشر شد؛ نگاهی بینداز و آنکه را می‌پسندی انتخاب کن.`;
}
