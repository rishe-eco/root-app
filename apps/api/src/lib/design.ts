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
