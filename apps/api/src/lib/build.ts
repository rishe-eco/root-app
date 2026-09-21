/**
 * Builds and the resolution ledger's own small rules (spec §6's gap; build
 * plan L3b) — kept beside `lib/scope.ts` and `lib/feedback.ts` in spirit
 * (house rule 3: one rule, one file), pure and Prisma-free so the four rules
 * that make this stage honest (L3b.2) are unit-testable without a database.
 */

export type FeedbackStatusLike = 'OPEN' | 'RATIFIED' | 'ADDRESSED' | 'ACCEPTED' | 'DECLINED';
export type BuildChangeOutcomeLike = 'ADDRESSED' | 'DECLINED' | 'CARRIED_FORWARD';

export type BuildChangeInputLike = {
  feedbackItemId?: string | null;
  scopeItemId?: string | null;
  outcome?: BuildChangeOutcomeLike | null;
  note?: string | null;
  noteLang?: string | null;
};

/**
 * Build plan L3b.2's second rule: "a fate must never be silent." Every
 * currently open (OPEN or RATIFIED) feedback item on the project must appear
 * exactly once among the change list's feedback-origin entries — including
 * the explicit CARRIED_FORWARD disposition. Returns the ids missing one;
 * empty means the list is honest. Unaddressed-by-omission is the dead-end
 * failure (F2) rebuilt one level down, so this is checked before anything is
 * written, not discovered after.
 */
export function missingDispositions(
  openFeedbackItemIds: readonly string[],
  changes: readonly BuildChangeInputLike[],
): string[] {
  const dispositioned = new Set(changes.map((c) => c.feedbackItemId).filter((id): id is string => !!id));
  return openFeedbackItemIds.filter((id) => !dispositioned.has(id));
}

/**
 * Build plan L3b.1's table: an entry is about a feedback item, a scope item,
 * or neither — never both at once. The database holds this too
 * (`BuildChangeEntry_at_most_one_origin`); this is the friendlier error
 * before that CHECK would ever fire.
 */
export function hasAtMostOneOrigin(change: BuildChangeInputLike): boolean {
  return !(change.feedbackItemId && change.scopeItemId);
}

/**
 * D3's ratification gate stays intact through this stage: a merely-OPEN
 * (unratified) feedback item is still just an opinion, and the only honest
 * thing a build can say about it is "still open, carried forward." Letting a
 * developer ADDRESS or DECLINE an item nobody has ratified yet would let a
 * build bypass the decider entirely — the same shape of silent, Root-favoured
 * break L3b.2's first rule warns about, one gate earlier.
 */
export function outcomeAllowedForStatus(outcome: BuildChangeOutcomeLike, status: FeedbackStatusLike): boolean {
  if (outcome === 'CARRIED_FORWARD') return status === 'OPEN' || status === 'RATIFIED';
  return status === 'RATIFIED';
}

/**
 * Build plan L3b.2's third rule, mirrored here for a resolver-level error
 * before the database's own CHECK (`BuildChangeEntry_declined_requires_note`)
 * would refuse it with a less specific code.
 */
export function declinedRequiresNote(change: BuildChangeInputLike): boolean {
  return change.outcome !== 'DECLINED' || !!change.note?.trim();
}

/**
 * L3b.1's third source: "the note *is* the entry" when there is no origin at
 * all. Mirrors `BuildChangeEntry_no_origin_requires_note`.
 */
export function noOriginRequiresNote(change: BuildChangeInputLike): boolean {
  if (change.feedbackItemId || change.scopeItemId) return true;
  return !!change.note?.trim();
}

/** A note and its language travel together, or not at all — one without the
 *  other is a column with no way to know what it means. */
export function noteAndLangTogether(change: BuildChangeInputLike): boolean {
  return !!change.note?.trim() === !!change.noteLang;
}

/**
 * The developer's claim, translated into the one FeedbackItem field it may
 * move — never ACCEPTED, which is L3b.2's whole point (two fields, never
 * one). CARRIED_FORWARD deliberately returns null: nothing changed, so
 * nothing about the row's status should say otherwise.
 */
export function nextFeedbackStatus(outcome: BuildChangeOutcomeLike): 'ADDRESSED' | 'DECLINED' | null {
  if (outcome === 'ADDRESSED') return 'ADDRESSED';
  if (outcome === 'DECLINED') return 'DECLINED';
  return null;
}

/**
 * Project-wide and monotonic (build plan L3b.3) — never per-phase, or
 * "version 2" is ambiguous the day a project has two phases each with a
 * build. `currentMax` is the highest existing number on the project, or
 * null for its first build ever.
 */
export function nextBuildNumber(currentMax: number | null): number {
  return (currentMax ?? 0) + 1;
}
