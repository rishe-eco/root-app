# J9b — step 5, the mockup: demos, iterations, frames, approval, and the screens (the second half of J9)

**Built:** 2026-10-01/04 · **Plan:** `root-sot/ecosystem/working/root-studio-journeys-build-plan.md` §5 "J9" (API, web, tests, acceptance); PD-3, PD-9
**Branch:** `stage-j9b-mockup` — built by a Sonnet lane (`a92048a` → `e3c8505`, paused twice for the founder's usage limit), reviewed by Opus. J9a (`J9a.md`) built the host, grants, the streamed upload and the kinds.

On a custom-path contract, once the design is approved, the designer starts a **mockup**: a MOCKUP demo with a page per agreed `PAGE` item. Each iteration is a zip uploaded with progress, declared like a site build — a fate for every open note — mapped page by page, and published against the allowance. The customer browses it inside the portal's viewport on its own grant subdomain, comments per page, and approves; approval locks the step.

## 1 · What was built

- **API (`resolvers/mockupStep.ts`):** `openMockup` (the contract's row lock; `STEP_LOCKED`, `STEP_NOT_ON_ROAD`, `BRIEF_MISSING`, `NOT_CUSTOM`, `DESIGN_NOT_APPROVED`), `createMockupDemo` (`MOCKUP_DEMO_EXISTS`, `NO_PAGES`), `mapMockupPage` (`INVALID_PATH`, `PATH_ALREADY_MAPPED`; a blank path unmaps), `declareMockupBuild`, publishing through `publishBuild` widened by kind (allowance, `BUILD_SUPERSEDED`, `ALREADY_PUBLISHED`), `approveMockup` (the contract's own customer; `NO_PUBLISHED_MOCKUP`); `Contract.mockup`, `Demo.builds`, `Demo.fixedFrameLines`, `Demo.bundlePages`. **`resolvers/buildLedger.ts`** — L3b's declare logic shared by `declareBuild` and `declareMockupBuild`.
- **Frames:** derived and synced at declare, map and publish (`deriveMockupFrame`): `NEW` for pages mapped to a path the bundle has, `KNOWN_MISSING` for the rest — a page changing bucket is its line changing kind, so the customer's thread stays; the fixed `TEMPORARY` line is the code `MOCKUP_TEMPORARY`, worded from locale keys, never a row.
- **Allowance:** `iterationsUsed(MOCKUP)` = published mockup builds; `extendAllowance` accepts MOCKUP. **One approval writer:** `approveStep(MOCKUP)` refuses `STEP_NOT_APPROVABLE`, as for DESIGN.
- **J9a's owed items:** GraphQL `Demo.stagingUrl` nullable (readers fixed); `upload.ts` `ERROR_KEYS` for every `BUNDLE_*` code plus `CONTRACT_REQUIRED`, `NOT_ASSIGNED`, `NO_FILE` (a test holds both locales to `mockupBundle.ts`'s codes); a top-level `__MACOSX/` is **ignored** — still counted against the caps and checked for unsafe names, then dropped.
- **Web:** `MockupPanel` (customer and staff), `MockupAuthor` (start, upload with a progress bar, declare with a fate per note, page mapping pre-filled with `bundlePages` suggestions, publish, the ledger), `lib/frameOrigin.ts` — **the viewport accepts `postMessage` only from the grant's exact origin**, table-tested; `DemoViewport` takes a `src`. "Mockup 2 of 3" from the published count.
- **Notifications:** `MOCKUP_ITERATION_PUBLISHED` → the customer, `MOCKUP_APPROVED` → the designer (email + SMS, both locales); timeline `MOCKUP_PUBLISHED`.
- **CSP:** the production `frame-src` pinned byte for byte in `securityHeaders.test.ts`; a test asserts dev and e2e send no CSP of their own.

## 2 · Decided

1. Every mockup mutation is `design.author` + the contract's designer; `declareMockupBuild` also `answers.direct.mockup`. A developer on a mockup build hears `NOT_FOUND`, a designer on a site build `FORBIDDEN`.
2. Fates are written at declare (as for site builds); an abandoned draft burns a build number; declaring is free, publishing spends the allowance.
3. A mockup change entry may not name a scope item (`SCOPE_ITEM_NOT_ON_MOCKUP`) — a picture of a page must not move the registry to IN_DEMO.
4. An unmapped page is `canonicalPath ''`; `reportDemoPath` ignores unmapped pages on a mockup. Agreed `PAGE` items added after the mockup started are declared unmapped.
5. A mockup's `Demo.publishedAt` is written by its first published iteration; `NO_FRAME` cannot occur for mockups and `publishDemo` is untouched.

## 3 · Owed / for the founder

- **The designer cannot preview a draft iteration in the portal** — the mockup host serves only published builds (J9a), so the designer's first look in the viewport is the customer's. Decide whether that is acceptable or whether staff get a draft grant.
- The attention module and status area do not know about the mockup (the wizard counter and timeline do).
- The customer is told at publish, not when a fate is written at declare.

## 4 · Verification

typecheck clean · unit 965 API + 311 web · integration (targeted): `s1`, `s2`, `j8`, `j9b` (27) — 473; `j9a`, `l3`, `l3b`, `l4`, `files`, `j7` — 155 · e2e (targeted, Edge): `23-mockup` (5 — the plan's acceptance: design approval through two iterations to approval, the viewport, a root-relative link, mapping, a comment, the second iteration's fates), `22-mockup-host`, `21-design`, `16-feedback`, `14-wizard`, `03-desk` — 35 · no migration; `prisma migrate diff` empty. **M4's full suites run after J10 and J12.**

**Not verified:** anything by eye in either language; mobile widths; real Nginx, Docker image, TLS/DNS; real email or SMS; a charged mockup extension in the browser.
