import type { NextFunction, Request, Response } from 'express';
import { env } from './env.js';

/**
 * An Origin check on every state-changing, cookie-authenticated request
 * (P0-7, defect D-8).
 *
 * **The threat.** Staging sites (`*.staging.m-root.com`) and uploaded mockups
 * (`*.mockup.m-root.com`) will run code Root does not fully control, on
 * subdomains of the portal's own registrable domain (journeys build plan,
 * PD-8). To a browser those subdomains are *same-site* with the portal, so
 * the session cookie — `SameSite=Lax` — rides along on a request one of them
 * makes to `/upload`, `/ask` or `/graphql`. CORS does not stop this: CORS
 * blocks a script from *reading* a cross-origin response, never from
 * *sending* a same-site request, and a `multipart/form-data` or `text/plain`
 * POST is a "simple request" that never even triggers a preflight. Apollo's
 * own `csrfPrevention` (left on — see `index.ts`) closes exactly this hole
 * for `/graphql`; this module closes it for the two routes that are not
 * GraphQL and therefore not covered by that plugin at all.
 *
 * **The rule.** Refuse when *all three* hold: the method is not one of
 * `GET`/`HEAD`/`OPTIONS`; the request carries the session cookie
 * (`env.COOKIE_NAME`); and it carries an `Origin` header that is not exactly
 * the app's own. Everything else passes through, to whatever check the route
 * itself makes:
 *
 *   - **No session cookie** — a Bearer-token client or an anonymous request
 *     (the anonymous `/ask`) goes to its own checks. A stolen or forged
 *     Bearer token is a different problem this middleware is not for.
 *   - **No `Origin` header** — a non-browser client (curl, a server-to-server
 *     call). A browser always sends `Origin` on a cross-origin POST, and
 *     Chromium-family browsers send it on a same-origin POST too, so a real
 *     browser's genuine request is never silently let through by this branch.
 *   - **A safe method** — `GET`/`HEAD`/`OPTIONS` change nothing, so there is
 *     nothing here for a forged request to achieve, and refusing them would
 *     only break a plain cross-site link or a CORS preflight.
 *
 * **Why the cookie decides this and a Bearer token never does.** A cross-site
 * page cannot attach an `Authorization` header to a request without
 * triggering a CORS preflight, and `cors()` (mounted above this, pinned to
 * `env.APP_ORIGIN`) refuses that preflight for any other origin — so a
 * Bearer-token request from a foreign origin already cannot be made to carry
 * the token in the first place. Checking "does this request also present a
 * token" here would add a branch that can never change the answer; the simpler
 * rule is also not a weaker one.
 *
 * **`Origin: null`.** A sandboxed iframe or a `file:` page sends the literal
 * string `"null"` as its Origin. That string never equals `new URL(env.APP_
 * ORIGIN).origin` (which is always a real scheme and host), so it refuses like
 * any other foreign origin without needing a special case.
 *
 * **Why the comparison is against a parsed origin, not the raw config
 * string.** `env.APP_ORIGIN` is validated as a URL but not as being free of a
 * trailing slash; comparing `req.headers.origin` (which a browser never sends
 * with a trailing slash) against the raw string would then refuse every
 * legitimate request the moment an operator's `.env` had one.
 *
 * **A development side effect worth knowing about.** Apollo Sandbox, served
 * from the API's own port (e.g. `localhost:4000`), is a different origin from
 * `APP_ORIGIN` (`localhost:5173`) — so a mutation run from Sandbox while a
 * portal session cookie is present in the same browser is now refused. Sign
 * out first, or use an API token (`docs/development/api-tokens.md`) instead
 * of the cookie; nothing here affects Sandbox itself, only requests that
 * carry the portal's cookie.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginCheckInput = {
  /** `req.method`, compared case-insensitively — Express normalizes it, but
   *  the pure function does not assume its caller did. */
  method: string;
  /** Whether `req.cookies` carries `env.COOKIE_NAME`, not whether it is a
   *  *valid* session — an expired or tampered cookie is still a cookie a
   *  cross-site request could not have attached on its own, and refusing on
   *  its mere presence costs nothing a legitimate caller would notice. */
  hasSessionCookie: boolean;
  /** `req.headers.origin`, or `null` for "the header was absent" — never
   *  `undefined`, so a caller cannot forget the absent case by accident. */
  origin: string | null;
  /** `new URL(env.APP_ORIGIN).origin` — already normalized, see the module
   *  comment above. */
  appOrigin: string;
};

/**
 * The decision, on its own — no Express, no environment, so it is exhaustively
 * unit-testable (`originCheck.test.ts`) without booting a server.
 */
export function decideOriginCheck(input: OriginCheckInput): 'allow' | 'refuse' {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return 'allow';
  if (!input.hasSessionCookie) return 'allow';
  if (input.origin === null) return 'allow';
  return input.origin === input.appOrigin ? 'allow' : 'refuse';
}

// Computed once at module load, not per request: parsing is pure and
// `env.APP_ORIGIN` never changes while the process is running.
const APP_ORIGIN = new URL(env.APP_ORIGIN).origin;

/**
 * The middleware. Mounted in `index.ts` after `cookieParser()` (it reads
 * `req.cookies`) and before `filesRouter`, `askRouter` and `/graphql` (it must
 * run before any of them can act on the request).
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  const originHeader = req.headers.origin;
  const decision = decideOriginCheck({
    method: req.method,
    hasSessionCookie: Boolean(req.cookies?.[env.COOKIE_NAME]),
    origin: typeof originHeader === 'string' ? originHeader : null,
    appOrigin: APP_ORIGIN,
  });

  if (decision === 'refuse') {
    res.status(403).json({
      error: 'ORIGIN_REFUSED',
      message: 'This request did not come from the app itself.',
    });
    return;
  }

  next();
}
