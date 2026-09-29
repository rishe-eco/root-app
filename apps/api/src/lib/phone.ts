import { getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/**
 * Phone normalization (journeys build plan J1, PD-16). The phone *is* the
 * account key for a customer with no email — two spellings of one number
 * making two accounts is exactly the failure this file exists to rule out,
 * which is why `normalizePhone` is the only place in this codebase allowed
 * to turn a typed-in number into the E.164 string every other file compares,
 * stores and looks up by.
 *
 * `libphonenumber-js/min` (its trimmed metadata, PD-16 — the full metadata
 * set carries every country's numbering plan at a size this product never
 * needs) does the actual numbering-plan validation; what this file adds is
 * the input folding the plan's own accepted-spellings list requires, none of
 * which the library does for you:
 *
 *   - Persian (۰-۹) and Arabic-Indic (٠-٩) digits, folded to ASCII first —
 *     a customer typing on a Persian keyboard never sees their own input
 *     rejected for the digits it is written in.
 *   - A bare country-calling-code dial with no leading `+` or `00`
 *     (`98912…`) — not an IDD form any parser recognizes on its own, so it
 *     is turned into `+98912…` by hand before the library ever sees it.
 *   - Spaces and dashes, which are cosmetic everywhere a person might put
 *     them and carry no meaning to a numbering plan.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function foldDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => {
    const persianIndex = PERSIAN_DIGITS.indexOf(d);
    if (persianIndex !== -1) return String(persianIndex);
    return String(ARABIC_INDIC_DIGITS.indexOf(d));
  });
}

/**
 * `input` may be typed by a person (spaces, dashes, Persian digits — see
 * above) or already E.164 from a stored value being re-validated. Returns
 * E.164 (`+98912…`) on a number libphonenumber-js's numbering-plan check
 * accepts, `null` on anything it does not — never throws, so a caller never
 * has to wrap this in a try purely to reject bad input.
 */
export function normalizePhone(input: string, defaultRegion: CountryCode = 'IR'): string | null {
  if (typeof input !== 'string') return null;

  // Keep only `+` and digits, once the digits are ASCII. Everything else a
  // person might have typed — spaces, dashes, parentheses — carries no
  // meaning to a numbering plan and is dropped rather than validated against.
  const cleaned = foldDigits(input).replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  // "98912…" with no leading `+`/`00`: recognizable only because it starts
  // with the default region's own calling code *and* what is left is long
  // enough to be a real subscriber number — otherwise a national number that
  // merely happens to start with the same digits (unrelated in every other
  // numbering plan) would be silently reinterpreted as international.
  const callingCode = getCountryCallingCode(defaultRegion);
  let candidate = cleaned;
  if (!candidate.startsWith('+') && candidate.startsWith(callingCode) && candidate.length > callingCode.length + 6) {
    candidate = `+${candidate}`;
  }

  const parsed = candidate.startsWith('+')
    ? parsePhoneNumberFromString(candidate)
    : parsePhoneNumberFromString(candidate, defaultRegion);

  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** The last four digits of an E.164 number, for a UI that must confirm
 *  "we texted the number ending in ⟨these⟩" without ever showing the whole
 *  thing back — the same discipline `apiTokens.ts`'s `prefix` applies in
 *  the other direction (show only what cannot itself be replayed). */
export function lastFourDigits(e164: string): string {
  return e164.slice(-4);
}
