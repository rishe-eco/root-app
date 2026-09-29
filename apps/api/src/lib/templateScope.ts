import { TEMPLATE_KINDS } from './templates.js';

/**
 * The shape rules for template types and their scope lists (journeys build
 * plan T1) — pure, so the resolver and its unit test read one copy.
 *
 * Each check answers with the refusal **code** the resolver throws, or null.
 * Codes rather than messages because the API returns codes and the desk turns
 * them into the user's language (house rule 6).
 */

/** Lowercase Latin words joined by single hyphens — `store`, `one-page-site`.
 *  An identifier (house rule 14): it is addressed by e2e and by later stages,
 *  and it must stay Latin wherever it is printed. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The same shape, for a scope key — and **no dot allowed**, which is what keeps
 * a template key out of the `checklist.*` namespace. A template key becomes a
 * `ScopeItem` key when a contract starts from the type, and the completeness
 * checklist's rows own that namespace (`lib/templates.ts`,
 * `applyContractTemplate`'s "already has scope items" guard): a template row
 * named `checklist.auth` would be invisible to that guard and collide with the
 * seeded row.
 */
export const KEY_PATTERN = SLUG_PATTERN;

/** Long enough for any real slug or key, short enough to stay a label-sized
 *  identifier; the database has no length limit of its own to lean on. */
export const MAX_IDENTIFIER_LENGTH = 60;

const wellFormed = (value: string, pattern: RegExp) =>
  value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && pattern.test(value);

export function checkSlug(slug: string): 'INVALID_SLUG' | null {
  return wellFormed(slug, SLUG_PATTERN) ? null : 'INVALID_SLUG';
}

export type TemplateScopeInput = { key: string; kind: string; labelFa: string; labelEn: string };

/**
 * The first refusal a proposed scope list earns, or null. Checked in the order
 * a person would fix them — malformed key, then a repeated one, then the kind,
 * then blank labels — and on the *whole* list before anything is written, so a
 * refusal can never leave a half-replaced list behind (the resolver's
 * transaction is the second line of defence, not the first).
 */
export function checkTemplateScope(
  items: readonly TemplateScopeInput[],
): 'INVALID_KEY' | 'DUPLICATE_TEMPLATE_KEY' | 'INVALID_TEMPLATE_KIND' | 'LABEL_REQUIRED' | null {
  if (items.some((i) => !wellFormed(i.key, KEY_PATTERN))) return 'INVALID_KEY';
  // Named on its own, not left to `@@unique([typeId, key])`: a unique
  // violation inside the transaction would surface as the generic
  // DUPLICATE_KEY ("something with that key already exists"), which tells a
  // person nothing about which row of the list they just typed is the twin.
  if (new Set(items.map((i) => i.key)).size !== items.length) return 'DUPLICATE_TEMPLATE_KEY';
  if (items.some((i) => !(TEMPLATE_KINDS as readonly string[]).includes(i.kind))) return 'INVALID_TEMPLATE_KIND';
  if (items.some((i) => i.labelFa.trim() === '' || i.labelEn.trim() === '')) return 'LABEL_REQUIRED';
  return null;
}
