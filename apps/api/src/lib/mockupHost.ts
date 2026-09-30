/**
 * The mockup host: turning a request's `Host` header into a view grant id,
 * and turning a grant id back into the URL it is reached at (build plan J9,
 * PD-9).
 *
 * A `MockupViewGrant`'s id **is** the DNS label it is served under —
 * `https://<grant-id>.mockup.m-root.com/` — so parsing the host a request
 * arrived on is the entire routing decision: it is what tells `index.ts`
 * whether this request is a mockup at all, before anything else (`/graphql`,
 * `/upload`, the SPA) is allowed to see it. Both directions of that trip —
 * host to id, id to url — live in this one file (house rule 3), because a
 * grant id has exactly one valid shape and every caller has to agree on it.
 */

const GRANT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Extracts the grant id from an incoming request's `Host` header, or `null`
 * if the host is not **exactly one** label under `baseDomain`, or that label
 * is not 32 lowercase hex characters.
 *
 * DNS names are case-insensitive — a browser or an intermediary may send
 * `ABCDEF….MOCKUP.M-ROOT.COM` and mean the same host as the lowercase form —
 * so the whole host is lowercased before anything else runs; nothing past
 * that point needs to know the request ever arrived in mixed case. Nothing
 * here confirms the label names a *live* grant, only that it has the right
 * shape — that is deliberate: this function is the fence that lets J9's
 * mockup router fall through to every other route for any host that is not
 * shaped like a mockup at all, and the actual grant lookup (unexpired, still
 * visible to this viewer) is a separate, later check against the database.
 */
export function grantIdFromHost(host: string, baseDomain: string): string | null {
  if (!host) return null;

  // The Host header carries a port for anything not on 80/443 — the local
  // and e2e form always does (`abc….mockup.localhost:4101`). Only the last
  // colon can be a port separator; a grant id is never an IP address, so
  // there is no IPv6-literal shape this function has to account for.
  const withoutPort = host.replace(/:\d+$/, '');

  // A trailing dot is the DNS root label spelled out — "example.com." and
  // "example.com" name the same host — stripped from both sides before
  // anything else runs, so it never counts as part of the base domain or as
  // its own (empty) label.
  const normalized = withoutPort.toLowerCase().replace(/\.$/, '');
  const base = baseDomain.toLowerCase().replace(/\.$/, '');

  if (normalized === base) return null; // the bare base domain — no label at all
  if (!normalized.endsWith(`.${base}`)) return null;

  const label = normalized.slice(0, normalized.length - base.length - 1);
  // "Exactly one label": a second dot in what is left over means two labels
  // under the base (e.g. "a.b.mockup.m-root.com") — refused outright, never
  // truncated to the first segment, which would silently accept a shape
  // nothing minted.
  if (label.length === 0 || label.includes('.')) return null;

  return GRANT_ID_PATTERN.test(label) ? label : null;
}

/**
 * Whether `host` is the mockup base domain **or anything under it** — the
 * question the fence at the top of `index.ts` asks (build plan J9, trap 1),
 * which is wider than `grantIdFromHost`'s on purpose.
 *
 * `grantIdFromHost` answers "is this a well-formed grant label", and returns
 * null for the bare base domain, for `abc.mockup.m-root.com`, for two labels
 * and for uppercase-that-is-not-hex. Every one of those is still a request
 * that arrived on the mockup wildcard, and none of them may fall through to the
 * portal: a fence keyed on `grantIdFromHost` alone would serve the whole app
 * (the SPA, `/graphql`) to `mockup.m-root.com` itself and to any malformed
 * label. So the fence keys on this — the whole subtree — and the mockup router
 * answers 404 for the ones that do not parse to a grant.
 */
export function isMockupHost(host: string, baseDomain: string): boolean {
  if (!host) return false;
  const normalized = host.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
  const base = baseDomain.toLowerCase().replace(/\.$/, '');
  return normalized === base || normalized.endsWith(`.${base}`);
}

export type MockupUrlOptions = {
  /** Defaults to `'https'` — production's only form (PD-8's wildcard cert). */
  protocol?: string;
  /** The local/e2e form carries a port; production never sets this. */
  port?: number;
};

/**
 * Builds the URL a grant is reached at: `https://<id>.<baseDomain>/` in
 * production. The local and e2e form (J9's own note: the mockup base domain
 * is `mockup.localhost` there, because every real browser resolves
 * `*.localhost` to loopback with no DNS or hosts-file entry) passes
 * `{ protocol: 'http', port }` instead, for
 * `http://<id>.mockup.localhost:<port>/`.
 */
export function mockupUrl(grantId: string, baseDomain: string, options: MockupUrlOptions = {}): string {
  const protocol = options.protocol ?? 'https';
  const port = options.port ? `:${options.port}` : '';
  return `${protocol}://${grantId}.${baseDomain}${port}/`;
}
