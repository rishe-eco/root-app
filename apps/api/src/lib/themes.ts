import type { User } from '@prisma/client';
import { can } from './capabilities.js';
import { isValidTomanAmount } from './billing.js';

/**
 * The rules for the theme catalogue (journeys build plan T2) — pure, so the
 * resolver, the file route and the unit test read one copy (house rule 3).
 *
 * Checks answer with the refusal **code** the caller throws, or null, like
 * `templateScope.ts`: the API returns codes and the desk says them in the
 * reader's language (house rule 6).
 */

/** Who may read the catalogue — the list, and each theme's licence cost.
 *  T1's `templateTypes` precedent: either template capability, or
 *  `contracts.author` (J8's proposer is a designer, and sales picks a type).
 *  Deliberately **not** `money.read`: see the note on `licenseCost` in
 *  resolvers/themes.ts. */
export function canReadThemes(user: Pick<User, 'roles'>): boolean {
  return can(user, 'templates.types') || can(user, 'templates.scope') || can(user, 'contracts.author');
}

/**
 * Who may open a theme's preview image (`GET /files/:id`, routes/files.ts).
 * Wider than `canReadThemes` by exactly the contract readers, because the
 * download route is where "any staff who can see a contract" and "any staff who
 * can see the catalogue" have to meet: a developer reads contracts and has no
 * business being refused an image that a design round will show them. Never a
 * customer — `CUSTOMER` holds none of these, which is the whole test — until
 * J8 copies the preview into a contract-owned `DESIGN_IMAGE`.
 */
export function canSeeThemePreview(user: Pick<User, 'roles'>): boolean {
  return canReadThemes(user) || can(user, 'contracts.readAll') || can(user, 'contracts.readActive');
}

/** Long enough for any real URL a vendor publishes; the database has no limit
 *  of its own to lean on, and `new URL` accepts anything. */
export const MAX_DEMO_URL_LENGTH = 2048;

/**
 * A theme's demo link must be a well-formed **https** URL.
 *
 * https-only is `admin/phases.ts`'s `assertHttps` rule (L2.2), kept as a
 * separate check because that one answers with staging-specific codes. The
 * reason differs, too: a staging URL is refused because a browser will not
 * frame mixed content; a theme demo is **never framed at all** (the plan's J8
 * `frame-src` decision), but it is opened by a customer in a new tab, and a
 * plain-http link there is a downgrade nobody chose.
 */
export function checkDemoUrl(url: string): 'INVALID_DEMO_URL' | 'DEMO_URL_NOT_HTTPS' | null {
  if (url.length > MAX_DEMO_URL_LENGTH) return 'INVALID_DEMO_URL';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'INVALID_DEMO_URL';
  }
  return parsed.protocol === 'https:' ? null : 'DEMO_URL_NOT_HTTPS';
}

/** Postgres `BIGINT`'s ceiling. `BigInt('9'.repeat(30))` is a fine JavaScript
 *  value and a database error with no code, so the parser refuses it first. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * A licence cost arriving as a GraphQL string: whole Toman, digits only (house
 * rule 9; `isValidTomanAmount` is L6's one door for that). `null` for an
 * invalid input, so a legitimate `0n` (a free theme) is not confused with a
 * refusal.
 */
export function parseLicenseCost(input: string): bigint | null {
  if (!isValidTomanAmount(input)) return null;
  const value = BigInt(input.trim());
  return value > BIGINT_MAX ? null : value;
}
