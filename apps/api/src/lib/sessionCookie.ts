/**
 * The one shape the session cookie's set and clear share (P0-7, defect D-8).
 *
 * `__Host-` (`env.ts`'s `defaultCookieName`) is refused outright by the
 * browser on a `Set-Cookie` for that name if it carries a `Domain` attribute,
 * lacks `Secure`, or names a path other than `/` — and that refusal applies
 * exactly as much to a *clearing* `Set-Cookie` as to the one that sets the
 * session. `context.ts` used to build the clearing options by hand
 * (`{ path: '/' }` alone), which is silently wrong in production: the browser
 * would refuse it (no `Secure`, and once the name is `__Host-root_session`,
 * a bare `path: '/'` with no `Secure`/`sameSite` still fails the prefix's
 * rules) and sign-out would leave the cookie in place. One function for both
 * call sites makes that impossible to reintroduce — whatever `set` writes is
 * exactly what `clear` un-writes.
 *
 * `domain` never appears here, on purpose: a `Domain` attribute is exactly
 * what would let a cookie survive to be read by, or planted by, a sibling
 * subdomain — see `originCheck.ts`'s comment on the same threat model. Every
 * caller gets a host-only cookie by construction; there is no parameter that
 * could add one back.
 */
export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
};

/** `nodeEnv` rather than reading `env.NODE_ENV` itself, so the production
 *  shape is testable without a second process booted with `NODE_ENV=production`
 *  (env.test.ts's own reasoning, applied here too). */
export function sessionCookieOptions(nodeEnv: string): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // The `__Host-` prefix (production) requires Secure; plain-HTTP
    // development could not set it even if asked, so this already agrees
    // with `defaultCookieName`'s choice without needing to import it.
    secure: nodeEnv === 'production',
    path: '/',
  };
}
