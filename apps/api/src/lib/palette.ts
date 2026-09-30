import type { PaletteKind } from '@prisma/client';

/**
 * The rules for a custom design's palette (journeys build plan J8): what a
 * colour, a font and a logo note may be. Pure, so the resolver, the unit test
 * and the database's own CHECK read one definition (house rule 3) — the colour
 * rule below is `DesignPaletteItem_color_is_hex`'s twin, and `j8.test.ts` holds
 * the two together by inserting through both.
 *
 * Checks answer with the refusal **code** the caller throws, or a normalized
 * value; the API returns codes and the desk says them in the reader's language
 * (house rule 6).
 *
 * ## The rules, in one list
 *
 * - **A colour is a hex**: `#rgb` or `#rrggbb`, either case, stored as
 *   lowercase six digits (`#0a7`  becomes `#00aa77`). No named colours, no
 *   `rgb()`, no alpha — a brand palette is opaque hex, and anything else would
 *   need a parser on every screen that draws a swatch. The value ends up in a
 *   `style` attribute, so "it is exactly `#` and hex digits" is also what makes
 *   it safe there.
 * - **A font is a family name**: 1 to 60 characters, letters and digits of any
 *   script plus space, hyphen, dot and underscore, starting with a letter or
 *   digit. No quotes, commas, semicolons, braces, parentheses or slashes — those
 *   are CSS syntax, and a font name is a name, not a `font-family` declaration.
 * - **A logo note** is up to 280 characters of text with no control characters
 *   (a newline is a control character — the note is a sentence, not a page).
 * - **A role** is a Latin identifier — lowercase letters, digits and hyphens,
 *   starting with a letter, up to 32 — because the mockup and the developer will
 *   key on it (`primary`, `heading`, `logo-dark`). Unique per kind within a
 *   revision (the table's unique index).
 * - **Both labels** are required, 1 to 80 characters.
 * - **At most 24 items** per revision.
 */

export const MAX_PALETTE_ITEMS = 24;
export const MAX_LABEL_LENGTH = 80;
export const MAX_FONT_LENGTH = 60;
export const MAX_LOGO_NOTE_LENGTH = 280;

export type PaletteProblem =
  | 'INVALID_COLOR'
  | 'INVALID_FONT'
  | 'INVALID_LOGO_NOTE'
  | 'INVALID_ROLE'
  | 'LABEL_REQUIRED'
  | 'LABEL_TOO_LONG';

/** The colour a person typed → the one the database holds, or null. */
export function normalizeColor(input: string): string | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  const six = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return `#${six}`;
}

const FONT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A palette item's value, checked and normalized for its kind. Returns the
 * value to store, or the problem code. Whitespace around the input is dropped.
 */
export function checkPaletteValue(kind: PaletteKind, raw: string): { value: string } | { problem: PaletteProblem } {
  const input = raw.trim();
  switch (kind) {
    case 'COLOR': {
      const color = normalizeColor(input);
      return color ? { value: color } : { problem: 'INVALID_COLOR' };
    }
    case 'FONT':
      return input.length >= 1 && input.length <= MAX_FONT_LENGTH && FONT_NAME.test(input)
        ? { value: input }
        : { problem: 'INVALID_FONT' };
    case 'LOGO_USAGE':
      return input.length >= 1 && input.length <= MAX_LOGO_NOTE_LENGTH && !CONTROL.test(input)
        ? { value: input }
        : { problem: 'INVALID_LOGO_NOTE' };
  }
}

export const checkRole = (role: string): boolean => ROLE.test(role);

/** Both labels present and short enough; trimmed. */
export function checkLabels(labelFa: string, labelEn: string): { labelFa: string; labelEn: string } | { problem: PaletteProblem } {
  const fa = labelFa.trim();
  const en = labelEn.trim();
  if (!fa || !en) return { problem: 'LABEL_REQUIRED' };
  if (fa.length > MAX_LABEL_LENGTH || en.length > MAX_LABEL_LENGTH) return { problem: 'LABEL_TOO_LONG' };
  return { labelFa: fa, labelEn: en };
}

/**
 * The whole item, in one call — what `addPaletteItem` and `updatePaletteItem`
 * ask. The role is checked here so a bad one is `INVALID_ROLE`, not a database
 * error about a unique index that has nothing to do with it.
 */
export function checkPaletteItem(input: {
  kind: PaletteKind;
  role: string;
  value: string;
  labelFa: string;
  labelEn: string;
}): { kind: PaletteKind; role: string; value: string; labelFa: string; labelEn: string } | { problem: PaletteProblem } {
  if (!checkRole(input.role)) return { problem: 'INVALID_ROLE' };
  const value = checkPaletteValue(input.kind, input.value);
  if ('problem' in value) return value;
  const labels = checkLabels(input.labelFa, input.labelEn);
  if ('problem' in labels) return labels;
  return { kind: input.kind, role: input.role, value: value.value, ...labels };
}
