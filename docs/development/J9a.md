# J9a — the mockup host: kinds, the streamed bundle upload, view grants, the fence (the infrastructure half of J9)

**Built:** 2026-10-01 · **Plan:** `root-sot/ecosystem/working/root-studio-journeys-build-plan.md` §5 "J9" (prerequisites, schema, the upload, the router, traps 1–5), P0-5, P0-7, D-6, D-9, PD-8, PD-9
**Branch:** `stage-j9a-mockup-host` — built by a Sonnet lane (`ba04193` → `0e270bd`) **beside J8**, reviewed by Opus. J9 was split: this half needs nothing from the design step; **J9b** (`createMockupDemo`, `mapMockupPage`, `declareMockupBuild`, the allowance on publish, the MOCKUP frame branch, `approveMockup`, and all the web) follows J8.

A mockup is uploaded code, served to the customer on its own `*.mockup.m-root.com` subdomain. This stage builds everything that makes that safe to serve: the demo and build **kinds**, a **streamed** upload for bundles, per-viewer **view grants** whose id is the subdomain label, and the **fence** — on a mockup host nothing of the app exists but the mockup router.

## 1 · What was built

- **Migration `20261001110000_j9_mockups`:** `DemoKind` / `BuildKind` (backfilled `SITE`, then `NOT NULL`), `Demo.projectId` (backfilled) and `Demo.contractId?`, `Demo.phaseId` / `stagingUrl` and `Build.phaseId` nullable, `Build.demoId?`, `Build.bundleFileId?` (`Restrict`), the build unique now `(projectId, kind, number)`, `MockupViewGrant`, `FileClass.MOCKUP_BUNDLE`. CHECKs `Demo_site_has_phase_and_url`, `Build_site_has_phase`, `Build_mockup_has_bundle`, `MockupViewGrant_id_shape`, each proven by direct insert; the backfill and its guard run as shipped. `StoredFile_private_has_owner` needed no widening (a contract is already an owner).
- **Streamed upload (D-9):** `lib/multipartStream.ts` (a bounded single-file multipart receiver — no new dependency), `storage.tempPath` / `adopt` (the same atomic rename as `put`), `routes/files.ts` `receiveStreamedUpload` for `MOCKUP_BUNDLE` only: a running byte count refused at 50 MB (`FILE_TOO_LARGE`, the temp file removed, the rest of the body drained so the client reads the 413), the zip sniffed, J9-pre's `validateBundle`, then adopted. Every other class keeps the buffered path. The uploader is `design.author` and the contract's designer.
- **The fence:** `app.use(mockupFence)` is the **first** mount in `index.ts`, ahead of `cookieParser`, CORS, the origin check and every router; a text test keeps it first. `isMockupHost` covers the whole `*.mockup.<base>` subtree (a malformed label is fenced too, not passed to the portal). **The host is the raw `Host` header, not `req.hostname`** — with `trust proxy` on, Express would take a client's `X-Forwarded-Host`, which a mockup script can send to its own origin.
- **`routes/mockups.ts`:** GET/HEAD only; the grant re-checked on every request (unexpired, viewer active and still able to see the contract, build a published mockup); entries looked up in a cached name map of normalized keys (**served from the zip**, no extraction — no zip-slip or symlink surface); a directory redirect built from the normalized key; reporter injection before `</head>` / `</body>` / at the end, HTML capped; the plan's CSP, `Referrer-Policy: no-referrer`, `nosniff` on every response including 404s; never `Set-Cookie`.
- **Grants:** `mockupViewUrl(demoId)` (a Query that may write) — the contract's customer or visible staff; reuses an unexpired grant per (build, viewer) with at least 15 minutes left, else mints 32 hex from `crypto.randomBytes`, 12-hour expiry, the viewer's expired grants deleted lazily. Pinned to their build.
- **Deploy (not deployed):** `deploy/nginx/mockup.conf` — one `location /` proxying to the API, `Host` passed, **`X-Forwarded-Host` blanked, `Cookie` stripped**; `root.conf`'s `/upload` body limit 26m → 51m; `securityHeaders.test.ts` holds both; `deploy/README.md` — the block, `--cert-name`, a `curl` check, storage growth, a `tmp/` sweep. The Dockerfile copies `snippets/` (the reporter lives outside `apps/api`). `MOCKUP_BASE_DOMAIN` (`mockup.localhost` in dev and e2e).

## 2 · Decided

1. **Nullable fallout** narrows on kind (`siteDemo()` in `access.ts`) — every SITE path behaves as before; `DemoFrame.unpromptedChanges` keys on `demoId` for a mockup (`phaseId: null` would have matched every mockup build of every project); `publishBuild` refuses a phase-less build. Sites touched: `access.ts`, `admin/phases.ts`, `admin/demoFrame.ts`, `demo.ts`, `demoPages.ts`, `builds.ts`, `fields.ts`, and fixtures in `j2`–`j4`, `l3`, `l3b`, `l4`, `s1`, `s2`, e2e `insertPublishedDemo`.
2. **`GET /files/:id` for a `MOCKUP_BUNDLE` is staff-only** — the customer views through a grant, which only ever shows a published build.
3. The developer surface answers `NOT_FOUND` for mockup demos and builds; **J9b decides the designer's guards.**
4. No `Range` support (video seeking limited); no clean URLs (`/about` does not serve `about.html`).
5. Dev URLs are `http://<id>.<base>:<API port>` — Vite proxies only `/graphql`, `/upload`, `/files`.

## 3 · Owed to J9b

- GraphQL `Demo.stagingUrl` is still `String!` — make it nullable when mockup demos are exposed.
- `apps/web/src/lib/upload.ts` `ERROR_KEYS` lacks `BUNDLE_*` (including `BUNDLE_UNREADABLE`, `BUNDLE_ENCRYPTED_ENTRY`), `CONTRACT_REQUIRED`, `NOT_ASSIGNED`, `NO_FILE` — strings in both languages.
- A Finder-made zip has `__MACOSX/` beside its top folder and is refused `BUNDLE_NO_INDEX`; the desk should say so (or `validateBundle` should ignore `__MACOSX/`).

## 4 · Verification

typecheck clean · unit 842 · integration (targeted): the SITE files `l3`, `l3b`, `l4`, `s1`, `s2`, `files`, `t2`, `j2`, `j3`, `j4` — 485; `apiTokens`, `j1`, `j13`, `j5`, `j6`, `j7`, `l5`–`l7`, `r4`, `resolvers`, `s3`, `t1`, `v2` — 326; `j9a` — 51 · e2e (targeted, Edge): `22-mockup-host` (7) — real `*.mockup.localhost` subdomains — plus `16`, `14`, `03`, `17`, `15`, `04` — 33 · `prisma migrate diff`: no difference. **M4's full suites run after J8–J12.**

**Not verified:** Nginx itself (the confs are checked as text); the Docker image build; production TLS and wildcard DNS (P0-5); the heap bound is process-wide and shared with the test client.
