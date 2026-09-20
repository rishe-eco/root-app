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
