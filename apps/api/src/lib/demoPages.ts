import { foldPersian } from './library.js';

/**
 * The path → page mapping (build plan L2.1: "the real feature"). Everything
 * else about the live-demo surface — the iframe, the viewport presets, the
 * design-image toggle — is small once a reported browser path can be turned
 * into "which declared page is this, if any." This file is that turn, and
 * nothing else touches it (house rule 3): the resolver that records a
 * reported path imports `matchDemoPath` rather than comparing strings itself.
 *
 * **What gets folded together, and what deliberately does not.** L2.1 names
 * five raw shapes for "the products page" — `/products`, `/products/`,
 * `/products?sort=price`, `/fa/products`, `/products/page/2` — and a
 * percent-encoded Persian slug, and says outright that collapsing them is
 * "between one and six different pages depending on a rule nobody has
 * written." This file is that rule, made explicit rather than left
 * ambiguous:
 *
 *   - trailing slash        → folded (a path is not a different page for it)
 *   - a query string        → dropped (sort order is not a different page)
 *   - a hash fragment        → dropped, same reasoning
 *   - a recognized locale prefix (`/fa/…`, `/en/…`) → folded — this mirrors
 *     the app's own bilingual routing (`lp(locale, path)`), where the same
 *     page exists at two locale-prefixed URLs by construction
 *   - percent-encoding       → decoded, so a Persian slug typed by hand and
 *     the same slug arriving percent-encoded compare equal
 *   - Persian/Arabic orthographic variants and digit scripts → folded,
 *     reusing `foldPersian` (R1's fold) rather than writing a second one
 *     (house rule 3) — this also lowercases the whole path, Latin segments
 *     included, which is accepted rather than avoided: URL paths are
 *     case-insensitive on most real servers, and writing a separate
 *     Latin-only case rule to preserve a distinction nobody asked for is
 *     exactly the "guessing at an undetermined rule" this file exists to
 *     avoid doing silently.
 *   - a pagination segment (`/products/page/2`) → **left alone, on purpose.**
 *     Whether that is the same page as `/products` or a different one is
 *     genuinely undecided business logic, not a string-normalization
 *     question, and collapsing it here would be guessing. A path like this
 *     either gets its own declared DemoPage or lands in the unmatched
 *     bucket — both honest outcomes; a silent collapse is not.
 */

const DEFAULT_LOCALES = ['fa', 'en'];

export type NormalizePathOptions = {
  /**
   * Drops a trailing `/index.html` (folds to the directory) and a trailing
   * `.html` (folds to the extensionless path) — build plan J9. A third,
   * optional parameter rather than folding into the existing `locales`
   * one: `locales` is a plain array today, every call site passes it
   * positionally, and turning the second parameter into an options bag
   * would be a breaking type change for every one of them for the sake of a
   * flag only one caller will ever set. A trailing optional parameter costs
   * nothing to a call site that does not know it exists.
   *
   * **Opt-in, and SITE demos never pass it.** A SITE demo's own server
   * decides for itself whether `/about` and `/about.html` are the same
   * page — that is business logic this file deliberately leaves alone (see
   * the file's own comment on pagination paths) — and folding the
   * extension away for every demo would silently overrule whatever that
   * server actually does. A MOCKUP demo is different: it is served *by this
   * app*, straight out of the uploaded zip, so `/about.html` is a fact
   * about the bundle's file names, not a fact about the site being copied.
   * The customer talks about "the about page"; a designer mapping a
   * registry page to a bundle path should not have to spell `.html` to
   * match a report of it, so only the MOCKUP path sets this option.
   */
  stripHtml?: boolean;
};

/**
 * Reduces a raw reported path (or a full URL) to its canonical form for
 * comparison. Never throws — a malformed input degrades to the least
 * surprising reading rather than crashing the mutation that calls this on
 * every page-change event.
 */
export function normalizePath(
  raw: string,
  locales: readonly string[] = DEFAULT_LOCALES,
  options: NormalizePathOptions = {},
): string {
  const pathname = extractPathname(raw);
  const decoded = decodeSafely(pathname);
  const folded = foldPersian(decoded);

  let segments = folded.split('/').filter((s) => s.length > 0);
  if (segments.length > 0 && locales.includes(segments[0])) {
    segments = segments.slice(1);
  }

  if (options.stripHtml && segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last === 'index.html') {
      segments = segments.slice(0, -1);
    } else if (last.endsWith('.html') && last.length > '.html'.length) {
      segments = [...segments.slice(0, -1), last.slice(0, -'.html'.length)];
    }
  }

  return '/' + segments.join('/');
}

function extractPathname(raw: string): string {
  const trimmed = raw.trim();
  // Only run this through the WHATWG URL parser when it actually looks like
  // an absolute URL. `new URL('//products/x', base)` reads "products" as a
  // *hostname* — a protocol-relative authority — not a path segment, which
  // would misparse exactly the malformed-but-still-a-path shape a
  // hand-typed `canonicalPath` (or a double slash from string concatenation
  // upstream) can plausibly have. A bare path never needs that parser at
  // all: splitting on the query/hash delimiters is exactly as correct and
  // does not carry the "//" ambiguity.
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      // Falls through to the plain split below.
    }
  }
  return trimmed.split(/[?#]/)[0] || '/';
}

function decodeSafely(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    // A malformed percent-escape (a lone "%") throws; the un-decoded string
    // is still a usable, if less friendly, canonical form.
    return pathname;
  }
}

export type DemoPageDeclaration = { id: string; canonicalPath: string };

export type PathMatch =
  | { kind: 'MATCHED'; pageId: string; normalizedPath: string }
  | { kind: 'UNMATCHED'; normalizedPath: string };

/**
 * Matches a reported path against a demo's declared page list. Pure, and the
 * only place this comparison is made — the resolver that persists the result
 * (creating or bumping a DemoUnmatchedPath row) calls this rather than
 * re-deriving "matched or not" itself.
 */
export function matchDemoPath(rawPath: string, pages: DemoPageDeclaration[]): PathMatch {
  const normalizedPath = normalizePath(rawPath);
  const page = pages.find((p) => normalizePath(p.canonicalPath) === normalizedPath);
  return page ? { kind: 'MATCHED', pageId: page.id, normalizedPath } : { kind: 'UNMATCHED', normalizedPath };
}
