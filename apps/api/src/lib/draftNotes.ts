import { diffSnapshots, type ArticleSnapshot, type ContractSnapshot } from './revision.js';

/**
 * Where a note on the draft's article is *now* (journeys build plan J6) — pure,
 * so `draftNotes.test.ts` can table-test the trap the plan names.
 *
 * ## The trap: article numbers shift
 *
 * A DRAFT note is anchored to `(contractRevisionId, articleNumber)` — the
 * revision it was written against and the article's number **in that
 * revision**. Publishing v2 can insert an article before the one the note is
 * about, and the note's article is then number 4 in v2 while the note still
 * says 3. Two wrong answers are easy: read "article 3" in v2 (a different
 * article, so the note silently re-points), or compare `diffSnapshots` by
 * number (which reports 3 as changed and 4 as added, and is wrong about both).
 *
 * So "the same article in the current revision" is found by **title, then
 * number**, and **never guessed**:
 *
 * 1. The anchor article is read in the note's own revision (`before`). If it is
 *    not there the note names nothing.
 * 2. Candidates in the current revision are the articles with the same title —
 *    Persian or English, so a fixed typo in one language does not orphan a note
 *    that the other still identifies.
 * 3. A candidate with the same number wins; failing that, a single candidate at
 *    another number is the article, moved; several at other numbers, or none,
 *    is "this note's article no longer exists" — and so is an article whose
 *    number survived but whose title did not, which is a different article
 *    under the old one's number until someone says otherwise.
 *
 * **"Changed" is the machinery that already decides it** (`diffSnapshots`,
 * V3's banner): the found pair is renumbered to a common number and handed to
 * it, so a note's "changed in v3" marker and the customer's revised-banner can
 * never disagree about what a change is. A pure renumbering — same title, same
 * text, a new position — is *not* a change of the article; it is reported
 * separately as `currentNumber`, and the panel says "now article 4".
 */

export type ArticleNoteState = {
  /** No article in the current revision is this note's. `changed` is false. */
  gone: boolean;
  /** The article's title or text differs between the note's revision and the current one. */
  changed: boolean;
  /** The article's number in the current revision — differs from the note's own after a shift. Null when `gone`. */
  currentNumber: number | null;
};

const GONE: ArticleNoteState = { gone: true, changed: false, currentNumber: null };

const sameTitle = (a: ArticleSnapshot, b: ArticleSnapshot) => a.titleFa === b.titleFa || a.titleEn === b.titleEn;

export function articleStateSince(
  before: ContractSnapshot | null,
  articleNumber: number,
  after: ContractSnapshot | null,
): ArticleNoteState {
  const anchor = before?.articles.find((a) => a.number === articleNumber);
  if (!anchor || !after) return GONE;

  const candidates = after.articles.filter((a) => sameTitle(a, anchor));
  const found = candidates.find((a) => a.number === articleNumber) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!found) return GONE;

  // `diffSnapshots` compares by number, so hand it the pair under one number:
  // the definition of "changed" (both titles, both bodies) stays its own.
  const [verdict] = diffSnapshots(
    { ...before!, articles: [anchor] },
    { ...after, articles: [{ ...found, number: anchor.number }] },
  ).articles;
  return { gone: false, changed: verdict.kind === 'changed', currentNumber: found.number };
}
