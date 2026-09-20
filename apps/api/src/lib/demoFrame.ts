/**
 * The review frame's generation from the registry (spec §6; build plan L3):
 * "what's new, what's known-missing, what's temporary, what's decided and
 * when." Pure and Prisma-free, the same discipline `lib/scope.ts` and
 * `lib/demoPages.ts` already hold — this is the one place the four buckets
 * are decided, so `generateDemoFrame` (resolvers/admin/demoFrame.ts) calls
 * this rather than re-deriving the rule inline.
 *
 * Named `lib/demoFrame.ts`, not anything containing "review" — see
 * schema.prisma's section comment on `DemoFrame` for why.
 */

import { isAgreedOrBeyond } from './scope.js';

export type ScopeItemForFrame = {
  id: string;
  labelFa: string;
  labelEn: string;
  status: 'PROPOSED' | 'AGREED' | 'IN_BUILD' | 'IN_DEMO' | 'ACCEPTED' | 'DECLINED' | 'TRADED';
  temporary: boolean;
  decidedAt: Date | null;
  decidedNote: string | null;
  phaseId: string | null;
};

export type GeneratedLine = {
  kind: 'NEW' | 'KNOWN_MISSING' | 'TEMPORARY' | 'DECIDED';
  scopeItemId: string;
  textFa: string;
  textEn: string;
};

/**
 * Buckets the project's registry into the frame's four sections, for one
 * demo's own phase.
 *
 * - **NEW** — items on *this* phase that have reached `IN_DEMO`: what this
 *   demo is actually showing that the last one did not.
 * - **KNOWN_MISSING** — items on this phase still `IN_BUILD`: named rather
 *   than discovered in review (F3's own failure at Nahal — "nothing about
 *   deliberate design decisions or temporary states").
 * - **TEMPORARY** / **DECIDED** — read project-wide, not phase-scoped: a
 *   known stand-in or a settled decision does not stop mattering once its
 *   own phase closes, and a later phase's reviewer needs the same context a
 *   first-phase reviewer had. Both still require the item to be agreed or
 *   beyond (`lib/scope.ts`'s own test) — a declined item is not part of the
 *   build the frame is describing, whatever else is flagged on it.
 *
 * An item can land in more than one bucket (an `IN_DEMO` item that is also
 * `temporary` appears under both) — that is not a bug to collapse, it is two
 * true things about the same fact.
 *
 * `textFa`/`textEn` are the item's label **as of this call** — the caller is
 * expected to store them as a snapshot (schema.prisma's own note on
 * `DemoFrameLine`), not to re-read this function later and expect the same
 * strings if the registry has since changed.
 */
export function deriveFrameLines(phaseId: string, items: readonly ScopeItemForFrame[]): GeneratedLine[] {
  const lines: GeneratedLine[] = [];

  for (const item of items) {
    if (item.phaseId === phaseId && item.status === 'IN_DEMO') {
      lines.push({ kind: 'NEW', scopeItemId: item.id, textFa: item.labelFa, textEn: item.labelEn });
    }
    if (item.phaseId === phaseId && item.status === 'IN_BUILD') {
      lines.push({ kind: 'KNOWN_MISSING', scopeItemId: item.id, textFa: item.labelFa, textEn: item.labelEn });
    }
    if (item.temporary && isAgreedOrBeyond(item.status)) {
      lines.push({ kind: 'TEMPORARY', scopeItemId: item.id, textFa: item.labelFa, textEn: item.labelEn });
    }
    if (item.decidedAt !== null && isAgreedOrBeyond(item.status)) {
      lines.push({ kind: 'DECIDED', scopeItemId: item.id, textFa: item.labelFa, textEn: item.labelEn });
    }
  }

  return lines;
}
