/**
 * Whose `postMessage` the viewport believes (build plan L2.2; journeys build plan
 * J9b). A framed page — a staging site or a mockup — tells the portal which path
 * it is on (`snippets/demo-reporter`), and the portal acts on that message
 * (`reportDemoPath`). Without a check on the **sender's origin**, any page that
 * can post to this window could report paths into a demo's record.
 *
 * **The rule is equality with the frame's own origin, and nothing broader.** A
 * mockup is served at `https://<grant-id>.mockup.m-root.com/` — one subdomain per
 * viewer — so the tempting check, "ends with `.mockup.m-root.com`", would accept
 * every other viewer's mockup and any page Root serves under that wildcard. Equal
 * to `new URL(frameUrl).origin` accepts that one grant's page: the scheme, host and
 * port all have to match. (The reporter has the mirror-image duty on its side: it
 * posts to the portal's origin, not `*`.)
 *
 * Kept in a file of its own so the rule is table-tested (`frameOrigin.test.ts`)
 * rather than read off a component.
 */

/** The origin of a URL, or null when it does not parse — a viewport that cannot
 *  name its frame's origin listens to nobody, and never falls back to `*`. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    // `new URL('data:…').origin` is the string "null" — an opaque origin matches nothing.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Whether a message from `eventOrigin` may be trusted as coming from the page at `frameUrl`. */
export function acceptsFrameMessage(eventOrigin: string, frameUrl: string | null | undefined): boolean {
  const expected = originOf(frameUrl);
  return expected !== null && eventOrigin === expected;
}
