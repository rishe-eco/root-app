import type { Contract, DesignConcept, DesignPaletteItem, PaletteKind, StepKind, Theme, WizardStep } from './queries';
import { designPath, type DesignPath } from './brief';

/**
 * Step 4's client-side vocabulary (journeys build plan J8): the small pure
 * functions the design panels draw with. The rules — which rounds are allowed,
 * what a palette value may be, what makes a design complete — are the API's
 * (`lib/allowance.ts`, `lib/palette.ts`, `lib/steps.ts`); this file names things
 * for a screen and keeps them out of React so they are unit-testable.
 */

/**
 * **Type specimens always render Persian text** (the plan's Latin-only-font
 * trap). A typeface chosen from a Latin sample can lack every Persian glyph and
 * nobody finds out until the mockup, when the first Persian heading falls back
 * to a system font. So a specimen is *both* lines, the Persian one first, and
 * there is no way to ask for one without the other: `specimenLines` is the only
 * source, and its test fails if the Persian line ever stops being Persian.
 *
 * These are sample text, not interface copy (house rule 6 is about the latter):
 * the point of a specimen is which script it is set in, and a locale file would
 * have to hold the Latin line inside `fa.json`, where the parity test forbids
 * Latin letters.
 */
export const SPECIMEN_PERSIAN = 'گروهی از کارشناسان طراحی وب را با دقت و زیبایی انجام می‌دهند. ۰۱۲۳۴۵۶۷۸۹';
export const SPECIMEN_LATIN = 'The quick brown fox jumps over the lazy dog. 0123456789';

export function specimenLines(): Array<{ lang: 'fa' | 'en'; dir: 'rtl' | 'ltr'; text: string }> {
  return [
    { lang: 'fa', dir: 'rtl', text: SPECIMEN_PERSIAN },
    { lang: 'en', dir: 'ltr', text: SPECIMEN_LATIN },
  ];
}

/**
 * A palette font name as a CSS `font-family` value: the chosen family, then the
 * generic `sans-serif` — **not** Root's own Persian face. A specimen that fell
 * back to Vazirmatn would show Persian text set beautifully in a font that does
 * not have it, which is exactly the failure the specimen is there to reveal.
 * The API only stores names of letters, digits, spaces, dots, hyphens and
 * underscores; the quote and backslash are dropped anyway, so this is safe to
 * put in a `style` whatever a future rule allows.
 */
export function fontFamilyFor(name: string): string {
  return `"${name.replace(/["\\]/g, '')}", sans-serif`;
}

/** A colour swatch's text colour: black or white, whichever reads on it. Only
 *  for a well-formed `#rrggbb` (which is all the API stores). */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#000000';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  // Perceived luminance (Rec. 601) — good enough to pick a foreground.
  return (299 * r + 587 * g + 114 * b) / 1000 > 140 ? '#000000' : '#ffffff';
}

export function paletteByKind(items: readonly DesignPaletteItem[]): Record<PaletteKind, DesignPaletteItem[]> {
  const out: Record<PaletteKind, DesignPaletteItem[]> = { COLOR: [], FONT: [], LOGO_USAGE: [] };
  for (const item of items) out[item.kind].push(item);
  return out;
}

/** The design path of a contract, from its brief's tier (`designPath`, the web's
 *  one copy of the API's `designPathOf`); null before there is a brief. */
export function pathOfContract(contract: Pick<Contract, 'brief'>): DesignPath | null {
  return contract.brief ? designPath(contract.brief.designTier) : null;
}

/** The themes the designer can propose for a brief's template type: **active
 *  and offered for that type** — the very filter `proposeThemes` applies. */
export function themesFor(themes: readonly Theme[], templateTypeId: string | null | undefined): Theme[] {
  if (!templateTypeId) return [];
  return themes.filter((t) => t.active && t.typeIds.includes(templateTypeId));
}

/** The concept the customer has chosen in the current round, if any. */
export const chosenConcept = (concepts: readonly DesignConcept[]): DesignConcept | null => concepts.find((c) => c.chosen) ?? null;

/** "Round 2 of 3": rounds used and allowed, from the wizard's design step. */
export function roundCounter(step: Pick<WizardStep, 'iterationsUsed' | 'allowance'>): { used: number; total: number | null } {
  return { used: step.iterationsUsed ?? 0, total: step.allowance };
}

/** The allowance is spent — the next publish will be refused. */
export const isExhausted = (c: { used: number; total: number | null }): boolean => c.total !== null && c.used >= c.total;

/** The published revision the customer is looking at: the newest with a `publishedAt`. */
export function currentRevisionId(contract: Pick<Contract, 'designRevisions'>): string | null {
  const published = (contract.designRevisions ?? []).filter((r) => r.publishedAt !== null);
  if (published.length === 0) return null;
  return published.reduce((a, b) => (b.version > a.version ? b : a)).id;
}

/** Steps whose panel this file serves. */
export const DESIGN_STEP: StepKind = 'DESIGN';
