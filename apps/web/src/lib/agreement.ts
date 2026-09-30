import type { ScopeKind } from './queries';

/**
 * The agreement's own small rules on the web side (journeys build plan J7).
 * Pure, so `agreement.test.ts` can table-test them; the components read them
 * from here rather than restating them (house rule 3 — and `apps/web` cannot
 * import from `apps/api`, so the two mirrored rules below are pinned against the
 * API's source by that test).
 */

/**
 * **The article the payment plan renders** — *Payment Schedule*, article 5,
 * matched by number and English title, exactly as the API's
 * `isPaymentScheduleArticle` (`apps/api/src/lib/templates.ts`) matches it. On
 * the new road its body is empty and the renderer shows the plan beneath its
 * title (`AgreementDocument`); the desk's article editor disables the body there
 * and says why. Mirrored, not imported: `agreement.test.ts` reads the API's
 * function and fails if the two ever differ.
 */
export function isPaymentScheduleArticle(number: number, titleEn: string): boolean {
  return number === 5 && titleEn === 'Payment Schedule';
}

/** Appendix 1's groups, in the order a reader looks for them. `EXTRA` is the
 *  completeness checklist's standing questions (J4's "extras"). */
export const SCOPE_KIND_ORDER: readonly ScopeKind[] = ['PAGE', 'FEATURE', 'DELIVERABLE', 'EXTRA'];

/**
 * A format-2 appendix grouped by kind, in `SCOPE_KIND_ORDER`, each group in the
 * order the API froze it (the registry's own). An item with no kind — a format-1
 * revision's, which the API returns with `kind: null` — falls in a single
 * ungrouped list rather than being guessed into one, so the same function
 * serves both formats and the caller renders `null` as a plain list.
 */
export function groupScopeByKind<T extends { kind?: ScopeKind | null }>(
  items: readonly T[],
): Array<{ kind: ScopeKind | null; items: T[] }> {
  if (items.every((i) => !i.kind)) return items.length === 0 ? [] : [{ kind: null, items: [...items] }];
  const groups: Array<{ kind: ScopeKind | null; items: T[] }> = [];
  for (const kind of SCOPE_KIND_ORDER) {
    const inKind = items.filter((i) => i.kind === kind);
    if (inKind.length > 0) groups.push({ kind, items: inKind });
  }
  const ungrouped = items.filter((i) => !i.kind);
  if (ungrouped.length > 0) groups.push({ kind: null, items: ungrouped });
  return groups;
}
