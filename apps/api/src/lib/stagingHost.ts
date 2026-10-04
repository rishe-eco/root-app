/**
 * Which staging URLs a site demo may carry (journeys build plan J10; PD-8).
 *
 * A staging site is **deployed by the developer on Root's VPS**, one server
 * block per site under the `*.staging.m-root.com` wildcard — so the portal frames
 * only hosts Root controls (the portal's CSP `frame-src` names the same
 * wildcard, P0-2, and `deploy/README.md` says what a staging site must send).
 * Before J10 `createDemo` accepted any HTTPS URL at all, which made the viewport
 * an iframe onto anywhere a developer could type, running the reporter's
 * `postMessage` handshake with it.
 *
 * One rule file (house rule 3): `createDemo` and `updateDemo` — every path that
 * sets a SITE demo's URL — call `checkStagingUrl`, and nothing else decides
 * what a staging URL is.
 *
 * ## The rule
 *
 * - The host is **exactly one label** under `STAGING_BASE_DOMAIN` — a DNS label:
 *   lowercase letters, digits and hyphens, 1–63 characters, not starting or
 *   ending in a hyphen. Not the bare base, not two labels (`a.b.staging…`), and
 *   not a look-alike (`staging.m-root.com.evil.com`, which merely *contains* the
 *   base — the check is on the suffix, never on a substring).
 * - **No userinfo** (`https://staging.m-root.com@evil.com/` parses with the
 *   real host after the `@`; an address with credentials in it is refused
 *   outright whatever follows).
 * - **Production is strict**: `https` only, no explicit port (a staging site is
 *   one more server block on 443). **Development and e2e** accept `http` as well
 *   — a browser resolves `*.staging.localhost` to loopback with no DNS and no
 *   certificate, which is how e2e plays staging — and a port, because the local
 *   static server has to listen on one. The portal is itself plain `http` there,
 *   so there is no mixed content to protect against.
 * - **Case**: DNS names are case-insensitive and the URL parser lowercases the
 *   host, so `HTTPS://ACME.Staging.M-Root.com` *is* the same host and is
 *   accepted — and stored in its normalized form (`normalized` below), so the
 *   origin the viewport compares messages against is the one that was checked.
 *
 * Pure: no environment read, no database.
 */

export type StagingRefusal = 'INVALID_STAGING_URL' | 'STAGING_NOT_HTTPS' | 'STAGING_HOST_NOT_ALLOWED';

export type StagingCheck =
  | { ok: true; /** The URL as the parser normalizes it — what is stored. */ normalized: string; host: string }
  | { ok: false; reason: StagingRefusal };

/** A DNS label as a staging slug: what `<slug>.staging.m-root.com` may be. */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkStagingUrl(raw: string, options: { baseDomain: string; production: boolean }): StagingCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID_STAGING_URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'INVALID_STAGING_URL' };

  // The host rule first, so a wrong host is never reported as merely "not https":
  // someone who typed the wrong place needs to hear that, not to be told to add
  // an `s` and be refused again.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'STAGING_HOST_NOT_ALLOWED' };
  // `URL.hostname` is already lowercased and punycoded; a trailing dot is the DNS
  // root spelled out and is not a label of its own.
  const host = url.hostname.replace(/\.$/, '');
  const base = options.baseDomain.toLowerCase().replace(/\.$/, '');
  if (host === base || !host.endsWith(`.${base}`)) return { ok: false, reason: 'STAGING_HOST_NOT_ALLOWED' };
  const label = host.slice(0, host.length - base.length - 1);
  if (!SLUG.test(label)) return { ok: false, reason: 'STAGING_HOST_NOT_ALLOWED' };

  if (options.production) {
    if (url.protocol !== 'https:') return { ok: false, reason: 'STAGING_NOT_HTTPS' };
    if (url.port !== '') return { ok: false, reason: 'STAGING_HOST_NOT_ALLOWED' };
  }
  return { ok: true, normalized: url.href, host };
}
