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

// ---------------------------------------------------------------------------
// The MOCKUP branch (journeys build plan J9b)
// ---------------------------------------------------------------------------

export type MockupPageForFrame = {
  /** The registry `PAGE` item the page was declared from. */
  scopeItemId: string;
  labelFa: string;
  labelEn: string;
  /** The bundle shows this page: it is mapped to a path the bundle has. */
  inBundle: boolean;
};

/**
 * The lines that are the same on every mockup frame and are **rendered from
 * locale keys, never stored**: the API hands the web these codes (house rule 6 —
 * a code, not a sentence) and the web words them. Today there is one, the plan's
 * "a mockup: no real data, nothing is saved". A stored `DemoFrameLine` would
 * freeze whichever wording was current on the day it was generated, and would
 * have to carry a Persian and an English sentence written into a row — prose
 * that belongs to the interface, not to the project.
 */
export const MOCKUP_FIXED_LINES = ['MOCKUP_TEMPORARY'] as const;
export type MockupFixedLine = (typeof MOCKUP_FIXED_LINES)[number];

/**
 * A MOCKUP frame, **from design and not from build states** (journeys build plan
 * J9 — a mockup has no `IN_BUILD`/`IN_DEMO` items to read, and moving a scope item
 * along the registry's lifecycle because a picture of it exists would be a lie
 * about the site). Two buckets and a fixed line:
 *
 * - **NEW** — a registry page the bundle shows, because it is mapped to a path
 *   the bundle has. "Mapped in this iteration": the mapping is the designer's
 *   statement, per iteration, of which page each bundle file is, and the bundle
 *   is the iteration.
 * - **KNOWN_MISSING** — a registry page the bundle does not show: unmapped, or
 *   mapped to a path that is not in it. Named rather than discovered (F3's
 *   failure at Nahal, the same reason a site frame has the bucket).
 * - the fixed `TEMPORARY` line, `MOCKUP_TEMPORARY`, returned apart from `lines`
 *   because it is not a row.
 *
 * `DECIDED` is absent: a decision is a fact about the agreement, and the site
 * frame already says it project-wide; a mockup frame repeating it would be a
 * second place for it to disagree. One line per page, in the order given (the
 * registry's), so a page changing bucket between iterations is the same line
 * changing kind and its thread going with it — the resolver keeps the row.
 */
export function deriveMockupFrame(pages: readonly MockupPageForFrame[]): {
  lines: GeneratedLine[];
  fixed: readonly MockupFixedLine[];
} {
  return {
    lines: pages.map((p) => ({
      kind: p.inBundle ? ('NEW' as const) : ('KNOWN_MISSING' as const),
      scopeItemId: p.scopeItemId,
      textFa: p.labelFa,
      textEn: p.labelEn,
    })),
    fixed: MOCKUP_FIXED_LINES,
  };
}
