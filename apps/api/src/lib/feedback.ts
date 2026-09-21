/**
 * Feedback intake's own small rules (spec §6; build plan L3) — kept beside
 * `lib/scope.ts` and `lib/gate.ts` in spirit (house rule 3: one rule, one
 * file), pure and Prisma-free so interception is unit-testable without a
 * database, which is what "no model, no semantic matcher, no LLM call in the
 * intake path" (D4) actually buys: this function is a property check, not a
 * network call, and it has to stay that way for the interaction to "feel
 * instant."
 */

export type InterceptionReason = 'DECIDED' | 'TEMPORARY';

export type InterceptionResult =
  | { intercepted: false }
  | { intercepted: true; reason: InterceptionReason; scopeItemId: string };

/**
 * D4: "a comment on a `decided` or `temporary` scope item asks whether the
 * reviewer means to formally reopen it." Keyed off the *scope item itself* —
 * whichever frame line a comment targets, if that line points at a scope
 * item, this checks that item's own live flags. `decided` wins when an item
 * is somehow both (an item is rarely both in practice, but the check has to
 * pick one reason to report, and a settled decision is the stronger claim).
 *
 * Returns `{ intercepted: false }` for a target with no scope item at all —
 * a DemoPage, or a hand-authored DemoFrameLine — which is not a gap: those
 * targets have nothing "decided" or "temporary" to ask about in the first
 * place.
 */
export function checkInterception(
  scopeItem: { id: string; decidedAt: Date | null; temporary: boolean } | null,
): InterceptionResult {
  if (!scopeItem) return { intercepted: false };
  if (scopeItem.decidedAt !== null) return { intercepted: true, reason: 'DECIDED', scopeItemId: scopeItem.id };
  if (scopeItem.temporary) return { intercepted: true, reason: 'TEMPORARY', scopeItemId: scopeItem.id };
  return { intercepted: false };
}

/**
 * Build plan L3b.2's first rule, from the other side: ADDRESSED is the
 * developer's claim, not final, so a new comment against the same target
 * after it is exactly "the customer met it in the next review and reopened
 * it" — the honest reading is OPEN again, not a comment sitting silently
 * under a fate the customer has just contradicted. `submitFeedback` calls
 * this on every append to an existing item; see `resolvers/feedback.ts`.
 *
 * ACCEPTED and DECLINED are deliberately left alone here: whether a fully
 * closed item can be reopened by a stray comment is a decision this stage
 * does not make for anyone (see docs/development/L3b.md) — `acceptFeedback`
 * is the only door out of ADDRESSED in the other direction, and this stage
 * builds no door out of ACCEPTED or DECLINED at all.
 */
export function reopensOnComment(status: 'OPEN' | 'RATIFIED' | 'ADDRESSED' | 'ACCEPTED' | 'DECLINED'): boolean {
  return status === 'ADDRESSED';
}
