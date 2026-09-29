import { Router } from 'express';
import { devSmsTransport } from '../lib/sms.js';
import { normalizePhone } from '../lib/phone.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * The e2e-only route onto `DevSmsTransport`'s outbox (journeys build plan
 * J1) — the same precedent as R4.md §8's `ANTHROPIC_E2E_STUB`: a real
 * carrier round-trip is not something a Playwright spec can wait on, so
 * this reads back whatever the in-process dev transport already sent
 * instead. `env.ts` refuses `SMS_E2E_OUTBOX` outright in production, the
 * same guard already applied to `ANTHROPIC_E2E_STUB`, so this router
 * exists at all only when a test explicitly asked for it.
 *
 * **Mounted inside the normal app** (`index.ts`), beside `filesRouter` and
 * `askRouter`, not ahead of them — a plain path route with no special
 * placement, so that whenever J9's mockup host gets its own early,
 * Host-header-keyed routing in front of everything else, this route is
 * naturally behind it like every other ordinary route, never carved out an
 * exception for. Nothing about this router's own logic depends on running
 * early; the guard that keeps it out of production is `SMS_E2E_OUTBOX`
 * itself, checked once by `index.ts` before mounting it at all.
 */
export const smsOutboxRouter: Router = Router();

smsOutboxRouter.get('/__e2e/sms-outbox', (req, res) => {
  const transport = devSmsTransport();
  if (!transport) {
    // Never reachable in production (env.ts refuses the variable that would
    // mount this route at all), but a real provider swapped in for a test
    // still answers honestly rather than 500ing.
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    res.status(400).json({ error: 'BAD_REQUEST' });
    return;
  }

  const entry = transport.latestFor(phone);
  if (!entry) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  res.json({ code: entry.code ?? null, text: entry.text ?? null, at: entry.at });
});

/**
 * e2e-only, behind the same flag as the outbox above (env.ts refuses it in
 * production): empties every named rate-limit bucket. The e2e API is one
 * long-lived process for the whole suite and every spec signs in from the
 * same address, so J1's real budgets (10 sign-ins per 15 minutes per
 * identifier and per IP) tripped a third of the way through the run and
 * every later spec met "Too many attempts" (J1 review). Resetting before
 * each sign-in keeps the real budgets in force *within* a test — the rate
 * limits themselves are proven by rateLimit.test.ts and j1.test.ts — without
 * letting one spec spend the next one's allowance.
 */
smsOutboxRouter.post('/__e2e/rate-limits/reset', (_req, res) => {
  __resetNamedRateLimitsForTests();
  res.status(204).end();
});
