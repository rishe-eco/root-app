# Root Website — ریشه

The public front (Landing, About Us) plus the authenticated customer portal
(Contracts list and the interactive contract detail). Persian-first, bilingual,
full RTL.

**Source of truth:** `ecosystem/working/root-website-v3-overview.md` (the
application layer) and `ecosystem/working/root-website-requirements_2.md`
(process, type scale, spacing, i18n rules), both in the
[`rishe-eco/root-sot`](https://github.com/rishe-eco/root-sot) docs repo — locally
at `../root-sot/`. Where the two disagree about **colour**, neither wins —
`apps/web/src/styles/tokens.css` does; see "Design system" below.

---

## Quick start

```bash
npm install

docker compose up -d db                 # Postgres on :5432

cp apps/api/.env.example apps/api/.env  # then fill in JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

npm run prisma:migrate --workspace=apps/api   # create the schema
npm run seed --workspace=apps/api             # one contract + two accounts

# Only on a database that predates the revisions migration. The migration
# backfills v1 of both lineages but leaves the contract snapshot unsealed,
# because canonical hashing lives in src/lib/revision.ts and must not be
# forked into SQL. No-op on a fresh database.
npm run backfill --workspace=apps/api

npm run dev:api                         # API   → http://localhost:4000/graphql
npm run dev                             # Web   → http://localhost:5173
```

Seeded accounts are `admin@root.local` and `nahal@example.com`, both with the
password `change-me-please`. **Change them before this touches anything real.**

---

## Deployment

Full runbook in [`deploy/README.md`](deploy/README.md). The shape:

```
browser ──TLS──▶ host Nginx ──┬──▶ /srv/root/current   (static files)
                              └──▶ 127.0.0.1:4000      (api container) ──▶ db container
```

The API and Postgres run in Docker on the server. The web app is **built on
your machine** and uploaded as static files — `vite build` is the step most
likely to exhaust a small VPS's memory, and its output needs no runtime.

```bash
./deploy/release-web.sh you@your-vps      # from your machine
# and on the server:
cd /srv/root/app && git pull && docker compose -f docker-compose.prod.yml up -d --build
```

Four things about this are decisions, not defaults:

- **One origin, not two.** Host Nginx serves the SPA and proxies `/graphql` to
  the API on loopback. The session is an httpOnly `SameSite=Lax` cookie, so an
  API on its own subdomain would be cross-site and the browser would drop it —
  every customer silently logged out, with nothing to explain it. This is the
  production counterpart of the dev proxy in `vite.config.ts`, and it is why
  `VITE_GRAPHQL_URL` stays unset.
- **Host Nginx is the only proxy in the chain**, so `TRUST_PROXY_HOPS=1`. That
  number decides what `req.ip` reports, and `req.ip` is written to
  `Signature.ip` on a legal signing record. A second Nginx in a container was
  the earlier design; it bought nothing and made this number easy to get wrong.
- **Releases are directories and `current` is a symlink**, swapped with an
  atomic rename. Rsyncing into the live directory would serve, for a few
  seconds, an index.html naming assets that have not arrived yet. The symlink
  also records which commit is live and keeps the previous one for rollback.
- **Migrations run at container start**, in `apps/api/docker-entrypoint.sh`. A
  failed migration means the API refuses to boot, which is the intent: a server
  running against a schema it does not expect is worse than one that is down.
  `migrate deploy` only applies committed files — it never generates, never
  resets.

Seeding is *not* automatic and must not be run in production — it creates two
accounts whose password is in this repository. Use `create-admin` instead:

```bash
docker compose -f docker-compose.prod.yml exec -T api \
  npx tsx prisma/create-admin.ts you@example.com "Your Name"   # password on stdin
```

`docker-compose.yml` (no suffix) is the development file and brings up Postgres
alone, for `npm run dev` on the host. The two are separate rather than layered
because they disagree about the thing that matters: the dev file publishes
:5432 for a host-side Prisma CLI, and the production one publishes nothing.

---

## Layout

```
apps/web        Vite + React + TypeScript
  src/styles    tokens.css and kit.css (carried over verbatim from the
                design handoff) + the page-specific layout on top
  src/i18n      fa.json / en.json — every string in the product
  src/pages     Landing, About, reserved sections, 404
  src/portal    auth screens, app shell, contracts, contract detail
  src/admin     the thin operational admin
apps/api        Express + Apollo Server + Prisma
  prisma        schema.prisma, seed.ts, create-admin.ts
  src/graphql   typeDefs.ts  the SDL, one template literal
                resolvers/   split by who is acting, not by model:
                             contracts.ts  loading, the visibility rule, the log
                             fields.ts     what a row looks like over the wire
                             query.ts      reads
                             auth.ts       sign-in and the link-token flows
                             customer.ts   the gated actions on your contract
                             admin.ts      invites, drafts, publishing
  src/auth      password hashing, session and link tokens
  src/lib       gate.ts      the approval rule, in one place
                revision.ts  contract snapshots + canonical hashing
                design.ts    what "unchanged" means between design revisions
                logging.ts   which errors are faults and which are outcomes
                storage.ts   where bytes live — local disk behind an interface
                files.ts     what may be uploaded, and what it is allowed to be
  src/routes    files.ts     POST /upload and GET /files/:id, outside GraphQL
  Dockerfile    two-stage build on Debian — Prisma's engine wants glibc
  docker-entrypoint.sh        migrate, then start
deploy          README.md            the VPS runbook
                release-web.sh       build here, upload, swap the symlink
                nginx/               host Nginx site + security headers
docker-compose.yml            development: Postgres alone
docker-compose.prod.yml       the server: db + api
```

## Tests

Three layers, three commands, in ascending order of what they need.

```bash
npm test              # unit — pure functions, no database, ~0.5s
npm run test:integration   # resolvers against Postgres  (needs root_website_test)
npm run e2e           # the browser, against the built app
```

**Unit** (`apps/api/src/lib/*.test.ts`) covers the things that would be
expensive to get wrong quietly: canonical hashing, the design carry-forward
rule, the gate, what an error is allowed to tell a client, and one test that
reads all five files `ChangeAction` lives in and asserts they agree.

**Integration** (`apps/api/src/test/`) runs the real resolvers against a real
database — ownership, roles, and which refusal code comes back for each way of
asking too early. It refuses to start unless `DATABASE_URL` names a `*_test`
database, because it truncates every table it finds. Create it once with:

```bash
createdb root_website_test
DATABASE_URL="postgresql://root:root@localhost:5432/root_website_test?schema=public" \
  npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

**End-to-end** (`apps/web/e2e/`) drives the built app in a browser: the whole
gate flow as a customer, the admin, and the bilingual/RTL front. It starts its
own API on 4101 and preview server on 4173 against `root_website_test`, so it
never touches the dev servers or the dev database.

> **Playwright's browser download is geo-blocked from here** — the CDN answers
> `403 … not available in your location`. `playwright.config.ts` therefore sets
> `channel: 'chrome'` and drives the Chrome already installed on the machine.
> Nothing needs downloading; the browser version is whatever is installed.

## Design system

`tokens.css` and `kit.css` came from the handoff and are the portable layer —
edit them, not the components. Every colour, size, space and radius in this
repo is a token reference; there are no raw values in component CSS.

Two rules the token layer enforces for Persian, because breaking them is
silent: **never letter-space** Persian (it breaks the connected script) and
**never uppercase** it (Persian has no case). `base.css` undoes both for the
kit classes that apply them to Latin.

## Bilingual & RTL

The locale lives in the URL prefix (`/fa/...`, `/en/...`) and everything else
follows from it — the i18next language, `<html lang>`, `<html dir>`, the font
family, the line height. `/` redirects to the visitor's best guess.

All layout uses logical properties (`padding-inline`, `margin-inline-start`,
`inset-inline-start`), so RTL mirrors without a second stylesheet. No UI text
is typed into a component; adding a third language means adding one JSON file.

## The gate

The core rule of the contract detail page:

> design approved & complete → unlock *approve contract* → unlock *e-sign*

Design complete means a concept is chosen **and** every page under it is
approved. Choosing a different concept resets those approvals. Commenting and
the scope checklist are **never** gated.

This is computed and enforced in `apps/api/src/lib/gate.ts` and re-derived on
every read. The client's copy of the rule is a convenience for rendering — a
request that skips a step is refused by the server.

## Revisions

A contract grows **two independent chains of revisions** — one for the text,
one for the design — and they advance on separate clocks. Approval and
signature attach to a specific revision, never to the contract in the abstract,
so "you approved v1, this is v2" is something the model can actually say.

- **`ContractRevision`** is an immutable JSON snapshot plus a sha256
  `contentHash` — a legal document, and a hash is what a signature should stand
  against. The editable draft is the `Article` rows still on `Contract`;
  publishing freezes them. Once a revision is **signed** it is terminal:
  changes go in as **amendments**, because re-issuing a signed agreement would
  muddy which text is in force from when.
- **`DesignRevision`** stays relational — the customer approves pages one at a
  time. The draft is a revision with no `publishedAt`. On publish, approvals
  **carry forward** for pages whose image has not moved, so a one-page tweak
  asks for one re-approval rather than four.

The gate reads the *current* revisions and is otherwise unchanged. Spec:
`root-sot/ecosystem/working/root-website-versioning-and-admin.md`.

## Files

Uploads live on local disk behind an interface (`lib/storage.ts`), so object
storage later is a second implementation rather than a rewrite. They do **not**
go through GraphQL: `POST /upload` and `GET /files/:id` are plain Express
routes authenticated by the same session cookie, so Apollo stays JSON-only.

**Every file is public or private, and the split is structural, not a flag
checked at read time.** It is in the storage key's first path segment, on the
row, in a CHECK constraint, and in which of the two things serves the bytes:

- **Public** — Nginx serves it straight off `STORAGE_DIR/public/`, no Node
  involved. Nothing produces these yet; the Research Lab's hosted texts will.
- **Private** — every request goes through the API, which applies the same rule
  `loadForActor` applies to the contract: your own contract, and published.
  Admins see everything. A file whose contract is missing cannot exist — the
  database refuses the row, because a private file nobody owns is one nobody
  can ever be authorised to read.

What a file *is* comes from its own leading bytes, never from the browser's
`Content-Type` or the filename. Per-class limits and type allowlists live in
`lib/files.ts`; **SVG is accepted nowhere**, because it can carry script and
these are served from our own origin.

An image attaches to a concept or page through `setConceptImage` /
`setPageImage`, which write `imageUrl` and `imageFileId` together. Re-uploading
therefore changes `imageUrl`, which is exactly what makes `design.ts` treat the
page as changed and drop its approval — carry-forward starts working for a
reason rather than by accident.

## The printable contract

`/:lang/app/contracts/:id/print` renders the contract as a document, and a
**Download PDF** action on the detail screen opens it. The PDF itself comes
from the browser's own print dialog — there is no renderer on the server.

That is a Persian decision more than a convenience one. Setting Arabic-script
text needs contextual shaping; the pure-JS PDF libraries have none and would
produce disconnected, reversed letters, which in a legal document is not a
formatting flaw. A browser shapes it correctly, so the question was only ever
*which* browser. A headless one in the API image is the eventual answer for
PDFs Root generates itself — to email, or to archive — and it will render this
same route rather than a second document that could disagree with it.

**The page renders `contract.revision`, not the contract.** Title, fee and
articles all come out of the frozen snapshot, because `contentHash` is what a
signature attests to and a printed page must not show words the hash does not
cover. The fields of the same name on `Contract` are Root's working draft and
can already differ. Every sheet carries the reference, the revision number and
the full sha256, via a table `tfoot` — the one construct browsers both repeat
per page *and* reserve space for. A `position: fixed` footer repeats too, but
prints over the content, which put the strip across the signature.

## Change tracking

Every meaningful action is logged with actor and timestamp: comment, concept
choice, page approval and un-approval, design completion, contract approval,
scope toggle, signature, status change. This is what the later admin
review-flagging queue reads, so it is captured from the start.

Log entries store the *action* plus one variable argument; the sentence is
built in the reader's language on the client, so history reads correctly in
both languages.

## Contract status

Permissive by design. A contract does not march through the statuses in order —
Waiting on Customer and Waiting on Root are a "whose court is the ball in"
toggle, not stages. Any status can move to any other, and Root always has a
manual override in the admin. The automatic transitions are defaults, not
rails: a customer comment moves it to Waiting on Root, signing moves it to In
Progress.

---

## State of play

**Built and working**

- Landing and About, both languages, matching the handoff designs.
- Locked nav slots (blurred label + padlock), with `.sr-only` text for screen
  readers.
- Auth: sign in, invite acceptance, password reset request and completion.
  Sessions are httpOnly cookies; link tokens are stored only as hashes.
- Portal shell, contracts list with status filter chips and counts.
- Contract detail: all five sections, the gate, the rail's status stepper and
  the history log.
- Role-aware GraphQL API with the full Phase-1 mutation set.
- The staff shell at `/desk` (F2) and, inside it, the admin contract
  workspace (V2): create a contract, fill in its articles from a template
  or by hand, upload concept and page images, publish both lineages, hand
  the contract to the customer, and — once signed — issue an amendment and
  carry it to signature. No stage from here on needs the database or the
  GraphQL sandbox touched by hand.

**Verified how:** the public pages and the whole portal flow were driven in a
browser in both languages — concept choice, four page approvals, contract
approval and the e-signature unlocking in order. Both workspaces typecheck and
the web app builds clean.

**Revisions, run against a real database — 2026-08-02**

The revision layer described above is built and exercised end to end:
`migrate deploy` applies both migrations and `migrate diff` reports **no drift**
between the result and `schema.prisma`. The portal flow was driven in the
browser in both languages — concept choice, four page approvals, contract
approval, e-signature — and the client-facing GraphQL surface is unchanged,
which was the acceptance test.

Also exercised directly: the signature binds to contract revision v1 with
`signedHash` equal to that revision's `contentHash`; the CHECK constraint
rejects a signature with neither instrument set and one with both; publishing a
contract revision on a signed contract is refused; an admin edit to an article
stays in the draft while the customer keeps reading the signed snapshot; and
publishing design v2 with one changed page carried three approvals forward,
reset the fourth, and **left the signature and contract approval untouched**.

Two bugs this turned up, both fixed. `npm run seed` never loaded `.env` — it
only ever worked as `prisma db seed`, where the Prisma CLI loads it, so the
documented command was broken. And `setPageApproval` / `chooseConcept` refused
once the contract was approved, a guard that made sense when there was one
design and one contract: with independent lineages it reopened the design step
after a new revision and then refused every action that could close it.

Note the engine gap: `docker-compose.yml` pins Postgres 16 and this ran on a
local 14. Nothing here needs 15+, but the two should be brought into line.

Demo mode is gone. It mirrored the API in memory, gate rule included, and its
stated purpose — reviewing the portal before Postgres existed — ended when the
stack first ran on Postgres.

**Not built** — reserved, not started

- Services (the WooCommerce import), Billing and Support are modelled in the
  database and reserved in the nav, but the screens are honest stubs.
- A **server-rendered PDF**. The customer can print their contract to one from
  the browser (above); what is missing is a PDF Root can generate itself, to
  email or to archive. That needs a headless browser in the API image, and it
  will render the existing print route.

~~An upload form~~ and ~~creating a contract, entering article text, and
publishing a revision from the admin UI~~ — both built by the admin contract
workspace (V2); see "Built and working" above and the note below.

**Admin contract workspace, run against a real database — 2026-08-06.** The
full lifecycle was driven end to end in the browser, in both languages:
create a contract, apply the article template, publish the contract
revision, add a design concept and a page, upload a PNG to each and publish
the design revision, hand the contract to the customer, complete the design
and sign as the customer, then — back at the desk — issue an amendment,
publish it, and approve and sign it as the customer. The base signature was
untouched throughout, which is the property the two lineages (and now the
amendment layer) exist for. `migrate diff` reports no drift; typecheck, the
full unit and integration suites, and the e2e suite (22 specs, including the
one driving this flow) are all green.

**Run against a real database, 2026-08-01.** `prisma migrate dev` was generated
against Postgres and the result is committed as `20260801120713_init`, so the
schema is reproducible with `prisma migrate deploy`. The seed runs. One thing
did break, and it was the boot rather than the schema: the API validated
`process.env` but nothing populated it — the Prisma CLI loads `.env` on its own,
which is why migrate and seed worked while the server died on the first required
var. `apps/api/src/lib/env.ts` now calls `process.loadEnvFile()` before
validating, tolerating a missing file so injected-env production is unaffected.

## Open questions

1. **Email.** Nothing sends mail. Invite links are returned once by the
   `inviteCustomer` mutation and reset links are written to the API log, for an
   operator to pass on by hand. Both spots are marked `TODO(email)`.
2. **The contract text.** Articles 1–3 carry the real text from the handoff;
   4–15 have titles only and render a placeholder line. Paste the real
   articles in and they appear.
3. **Copy that is mine, not yours.** Landing, About, Contracts and the contract
   detail use your copy verbatim from the prototypes. The auth screens, the
   admin, the stub sections and the empty states are my drafts in both
   languages — read them.
4. **The landing CTA** is hidden — the hero ends at the lead paragraph. Its
   copy is still in the locale files under `landing.cta`, so bringing it back
   is one line in `pages/Landing.tsx` once its destination is decided.
5. **Locked slot behaviour.** The routes exist and say "coming later"; the nav
   does not link to them. Confirm that is the intent, or make them inert.

## Repo

`rishe-eco/root-app` — code only; the canon and specs live in the sibling
[`rishe-eco/root-sot`](https://github.com/rishe-eco/root-sot) docs repo, so the
two stay separate.

*Renamed 2026-07-29.* This was `root-website`, developed standalone and then
nested inside the docs folder. It moved out to `E:\_root\root-app` alongside its
siblings, adopting the planned `root-app` name; the branch was renamed `master`
→ `main` to match them. The three commits of history are unchanged.
