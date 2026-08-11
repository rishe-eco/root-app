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
- The customer knowing that something moved (V3): a banner leads the contract
  detail page whenever the text was revised, the design was revised, or an
  amendment is waiting — naming what changed, in one sentence, with one
  action that always matches what the gate will actually accept. A version
  panel in the rail shows both lineages side by side, and the amendment gets
  its own approve-then-sign block without ever making the signed base look
  unfinished.
- The desk's Overview (V4): status tiles across every contract, a Needs-Root
  queue ordered by how long each one has been waiting, and a review queue of
  recent customer activity worth a look — dismissed by the contract's own
  status moving on, not by a flag. **Track V — V1b through V4 — is complete.**
- Email (C0): invite, reset, reviewer-invite, new-comment and
  contract-revised notifications, sent through a provider seam with a
  logging fallback when none is configured, templated in the recipient's own
  locale.
- The tagline and hero: one `Tagline` component renders the same adjectival
  face — currently "new" · «نو» — in the hero and the footer from a single
  locale key, so the two can no longer say different things.
- The Library (R1): a bilingual-as-data corpus at `/desk/library` — a
  Persian title and an English title as columns on the same row, not chosen
  by the reader's locale. Translation provenance and rights basis are
  required with no default, so nothing publishes with a decision nobody
  made. A hosted PDF can exist only when the entry is public and its rights
  allow hosting — enforced by a database CHECK and, since the file is served
  straight off disk once it exists, by the upload route at the only moment
  that rule can still be checked. Root can create an entry, tag it, host a
  file for it, and publish it; a contributor can do all of that except
  publish.
- The Library's public reader (R2): the first unauthenticated resolvers in
  the app. An anonymous visitor reaches `/:lang/library`, searches the
  Research Lab in either script, and reads an entry's original beside its
  translation, each in its own script and direction. `publicLibraryEntries`,
  `publicLibraryEntry` and `publicLibraryConcepts` are separate resolvers
  from the staff ones, filtered through `publiclyVisible`, and structurally
  incapable of returning a draft's `searchText` or `createdBy`. `/cast` and
  `/blog` redirect to `/library/cast` rather than 404.
- The Review Room's corpus (C1): a round freezes one `root-sot` commit sha
  plus its allowlisted documents at that sha into an ordered block list,
  hashed and stored — nothing about a round changes after publish. Publishing
  runs entirely outside the API, in `npm run publish-round`, which reads a
  manifest and shows files at the frozen sha with real `git`, then calls the
  same `publishReviewRound` mutation the trust boundary actually lives in —
  every path, block shape and hash is revalidated there, never trusted from
  the CLI. A reviewer reads exactly the published corpus at `/desk/review`
  and nothing else; there is no per-reviewer grant.

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
- **Review Room comments** (C2). C1 built the corpus and the reading surface
  only, deliberately — a comment model built casually beside a fresh document
  renderer is one C2 would have to migrate (C1.md T4).

~~An upload form~~ and ~~creating a contract, entering article text, and
publishing a revision from the admin UI~~ — both built by the admin contract
workspace (V2); see "Built and working" above and the note below.

**The Review Room's corpus, run against a real database — 2026-08-11.**
R3 (the Library's concept tree) was next in the build plan's sequence, but
its own stage file gates itself on corpus size — *"if the corpus is still a
handful of entries when R3's turn comes, say so and skip ahead to C1"* — and
the Library has exactly one entry, seeded during R1/R2's own manual
verification. Flagged and confirmed with the user before starting; C1 was
built instead, out of the build plan's stated order but by its own stated
condition.

C1's shape is lopsided on purpose: the reading surface is a thin GraphQL
layer over two tables, and almost all the actual design weight is in the
publish step — the first thing in this codebase that crosses from a git repo
the API cannot see into Postgres. `npm run publish-round --workspace=apps/api
-- --sot <path> --sha <40-char sha> [--manifest review-manifest.json] [--label
"…"]` runs entirely outside the API: it resolves and verifies the commit
(refusing a branch name, `HEAD`, or a dirty working tree), reads
`review-manifest.json` **at that sha** rather than off disk, and `git show`s
every allowlisted path at that sha — failing the *whole* round, loudly, the
moment one path is missing, so a partially published round can never happen.
Only the CLI ever touches git; the mutation it calls, `publishReviewRound`,
is the actual trust boundary — every path and block shape is revalidated
there, and `contentHash` is always computed server-side from the blocks
received, with no hash field in the mutation's input at all to even consider
trusting.

The decision the build plan's own §0 flagged as easy to get backwards, gotten
right: **allowlist, not denylist.** A document is outside the corpus until a
manifest names it, checked in root-sot's own version control — so adding a
document is a reviewable commit, and `personal-canon.md` stays out by
omission rather than by a rule that has to remember to exclude it. Proven at
both layers: a unit test builds a manifest that never mentions
`personal-canon.md` and asserts the file is never even read, and an
integration test publishes a round and asserts exactly the manifest's
documents were written, no more.

The block-list decision (§2) was the one the stage said C2 depends on
getting right: not rendered HTML (anchors shift when the renderer changes),
not one raw string with global offsets (couples a future comment UI to the
renderer emitting source positions), but an ordered list of small, typed
blocks — heading/paragraph/code/list/quote/table — split once at publish
time and frozen. A hand-rolled line classifier, not a full CommonMark parser:
splitting only has to produce stable, coarse chunks; a real parser
(`marked`, sanitized through `dompurify`, both pinned to an exact version)
renders each block's own markdown at read time. Hashing reuses
`lib/revision.ts`'s `canonicalize`/`contentHash` under a new
`DOCUMENT_SNAPSHOT_FORMAT` tag rather than `SNAPSHOT_FORMAT` — a shared
version number that means two different things means neither — and hashes
over the blocks alone, deliberately: renaming a document between rounds must
not change what its hash attests to.

C1.md flagged that R2's `:lang(en)` fix was a prerequisite in practice, since
root-sot's canon mixes English and Persian within one document the same way
the Library reader mixes an original and its translation. It was — and this
stage found the reverse case of the same script-detection question R2 didn't
have to answer: R2 always knew an entry's `originalLang`, but a Review Room
block has no language field at all. Solved with a small per-block script
guess (a proportion-of-Persian-characters heuristic) good enough for
choosing `lang`/`dir`, not a translation detector — verified live with
`getComputedStyle` on a Persian sub-heading and paragraph rendered inline
inside an otherwise-English document: `Vazirmatn`/rtl for the Persian
blocks, `Inter`/ltr for everything around them, in the same document, on the
same page.

No `ReviewGrant` model, on purpose (§1) — one corpus, for anyone holding
`review.participate`. Proven with the actual seeded reviewer account, not
just a capability check: signed in, they see exactly Overview and Review in
the desk nav (Library, Contracts and Customers absent), open the CLI-smoke
round below, and read a rendered document with real headings, a list, and a
fenced code block, in both languages. A customer navigating straight to
`/desk/review` is bounced to their own portal before the screen renders, the
same as every other desk section.

The publish step itself was run for real, twice — against a throwaway git
repository built for the purpose, not simulated: once through the success
path (a two-language markdown document with a heading, a Persian
sub-heading and paragraph, a list and a fenced code block, published and
read back with all six blocks split correctly), and three times through the
refusal paths — a branch name in place of a sha, a dirty working tree, and a
manifest naming a path that does not exist at the frozen sha — each refused
with no partial round left behind. `migrate diff` reports no schema drift;
typecheck is clean in both workspaces; the unit suite (158, +26 across
`lib/revision.test.ts`, `lib/reviewBlocks.test.ts` and
`lib/publishRound.test.ts`), the integration suite (119, +12) and the e2e
suite (27, +1, plus one existing F2-era test updated to expect the Review
section a reviewer now correctly sees) are all green.

**One thing this stage could not do**, recorded rather than silently
skipped: C1.md's own closing checklist asks for a wording fix in the build
plan's §5b, in `root-sot`'s own repository — which does not exist on this
machine (the API never reading a git tree turned out to apply to the
person building it, too). Left for whoever next has both repos checked out.

**The Library's public reader, run against a real database — 2026-08-11.**
R2's spec (§1) already knew the shape of the trap — `tokens.css` keys the
Persian type family and leading off `:lang(fa)`, and a Latin block nested
inside a Persian page inherits them because nothing resets them back — and
gave the fix as one `:lang(en)` block restating the Latin defaults. Building
the reader and checking it with the browser's own computed styles (not by
eye) found that the given fix is necessary but not sufficient in this
codebase: `.root-ui` is the *only* rule anywhere in the kit that reads
`var(--font-sans)` into an actual `font-family`, once, near the document
root. `font-family` is an inherited property, so every element below
`.root-ui` inherits that one already-resolved value — overriding the custom
property further down changes what a *fresh* `var()` read would produce, but
nothing below `.root-ui` performs one, so the rendered font never moves.
`:lang(en)` was setting `--font-sans` correctly and `font-family` was still
Vazirmatn. The fix that actually works re-declares `font-family:
var(--font-sans)` and `line-height: var(--leading-body)` **inside** both
`:lang(fa)` and `:lang(en)` themselves, not just their custom properties —
since `:lang()` matches the exact element carrying that `lang` attribute,
this forces the fresh substitution at precisely the point a nested language
boundary needs it, verified afterward with `getComputedStyle` on a `lang="en"`
column inside a Persian-locale page: `font-family` reads `Inter, system-ui,
…` and `line-height` reads the Latin 1.55, both correctly, with the
surrounding Persian chrome unaffected.

Two public queries were written from nothing, never as a flag on the staff
ones (§2.1): `publicLibraryEntries`/`publicLibraryEntry`/
`publicLibraryConcepts` carry no `requireCapability` at all — the first
resolvers in the app an anonymous request reaches — and return `PublicEntry`/
`PublicEntryRow`/`PublicConcept`, GraphQL types with no `searchText`,
`visibility`, `fullTextFileId` or `createdBy` field to ask for at all. A
draft's slug, a private entry's slug and a slug nobody used are one answer,
`null` (T2) — this endpoint cannot be used to learn which slugs exist as
drafts. The public list clamps to 60 rather than the staff list's 100 (§2.2)
— reusing R1 review's `clampLimit`, since an anonymous caller has no
scrolling-their-own-corpus excuse for a large page.

Citation (BibTeX and APA) is generated on read from the fields the entry
already has — `authors`, `titleOriginal`, `venue`, `year`, `doi`,
`sourceUrl` — never stored, so it cannot drift from them the way a cached
copy would the first time a venue typo is fixed (§6). It cites exactly what
the entry holds, in its own script; a Persian author's name is never given
an invented Latin transliteration.

`/cast` and `/blog` — both reserved routes since launch — now redirect to
`/library/cast` instead of 404ing, per the rule that a public URL that has
ever existed is not free to delete. The nav's `cast` slot graduated from
locked to a real `Library` link; `studio` and `journey` are still locked.
`/desk` was not touched at all (T7) — confirmed by re-running the desk
Library screens after the change and finding them identical.

Driven end to end in the browser: as admin, an English paper with a Root
Persian translation was created and published in `/desk` (unchanged, R1);
as an anonymous visitor with cookies cleared, the same entry was found by
searching a plain-English substring, opened, and read with both columns
visible — the English original in `lang="en" dir="ltr"`, the Persian
translation in `lang="fa" dir="rtl"`, on a page whose own document direction
is RTL throughout. Switching the language on that page landed on the exact
same entry rather than the list (T4), since the slug is not localised. A
concept badge on the entry linked to the list pre-filtered by that concept,
with a visible "clear filter" affordance. `migrate diff` reports no drift
(no schema changes this stage); typecheck is clean in both workspaces; the
API's unit suite (132, unchanged) and integration suite (107, +7) are green,
a new web-side unit suite exists for the first time (5 tests, `dirFor` and
`formatCitation`, wired into `npm test` via the same `tsx --test` pattern the
API already used) and passes, and the e2e suite (26, +1) is green including
the one console-flake retry the suite has carried since before this stage.

**What this stage decided, for R3 (§10):** the umbrella page was built as a
real screen rather than an immediate redirect to `/library/research` — Root
Cast is a named, real second strand already, and a visitor should be able to
see both exist even while only one is open; this can be revisited once a
second strand actually ships. The translation-request affordance for a
`NONE_YET` entry was deferred entirely, with no button that does nothing in
its place — the same call R2.md itself recommended. Concept counts on the
public side are per-entry only for now (`conceptCount` on the row,
`conceptSlug` as a filter); whether R3's tree needs rolled-up counts is still
open.

**The Library, run against a real database — 2026-08-10.** R1's spec (§1)
found a state neither of its two source rules resolves on its own: a
`PRIVATE` entry with a hosted PDF is invisible in every list and search, but
its full text still sits at a public URL, because `RESEARCH_TEXT` is served
by Nginx straight off disk with no code left in the request to check
anything. So the rule is one rule — a hosted file may exist only when the
entry is `PUBLIC` and its rights basis is not `LINK_ONLY` — held by a single
hand-written CHECK constraint that refuses both a bad insert and a bad
*update*: flipping a hosted entry to `LINK_ONLY` or `PRIVATE` now fails at
the database unless the file reference is cleared first, which is what
forces `updateLibraryEntry` to delete the bytes rather than silently orphan
them. The upload route was generalised the same way the spec asked
(`owner: 'contract' | 'entry'` instead of a contract-shaped
`requiresContract` flag) so a `RESEARCH_TEXT` upload has a row to check the
rule against at all — the only moment it can be checked, since nothing
downstream of Nginx ever sees the request again.

Two decisions the stage file left open (§11) got made and are recorded here
rather than re-derived by whoever writes R2. Persian search folding
(Arabic/Persian yeh and kaf, hamza-bearing alefs, ZWNJ, tatweel, harakat,
and both digit scripts, all folding to one form) is implemented once, in
JS, used by both the write path (`buildSearchText`) and the read path
(folding the query term) — not through the hand-written `library_fold()`
Postgres function the migration also carries, which stays as the spec's own
hand-verified reference and nothing calls at runtime. Two implementations of
the same fold that must agree is exactly the drift house rule 3 exists to
prevent; keeping both write and read on one JS function removes the
possibility rather than testing against it. Slugs keep a Persian title's own
script rather than transliterating it — «یادگیری-ماشین», not
`yadgiri-mashin` — and lock the moment an entry publishes (T4).

Driven end to end in the browser, in both languages: as admin, an entry was
created with both required-choice radio groups genuinely unpreselected (Save
stayed disabled until both were answered), tagged with a new concept, and
found by searching the concept's English title before the tag existed
nowhere in the entry's own text — proof the search-text rebuild on
`setEntryConcepts` actually ran. A PDF was uploaded, producing a working
"View file" link with no attach step of its own (the upload route sets
`fullTextFileId` inside the same transaction as the row), and the entry was
published — the badge and the button both updated from the mutation's
response with no manual refetch, which is Apollo's normalized cache doing
what it is supposed to. In Persian: the nav reads «کتابخانه», every label
and enum value is translated, the year field renders in Latin digits next to
a DOI that is always Latin (T4's `num-latin` choice, made once and applied
consistently), and the created-by line renders a real Jalali date through
the locale's own `Intl.DateTimeFormat` — no horizontal overflow, no console
errors. Signed in as the seeded contributor, the same entry's editor
rendered in full — reachable, not hidden — with "Publishing is not
available to you." where the publish control would be, and the concept
list's rename/delete disabled with the same reasoning (T6); a customer
navigating straight to `/desk/library` was bounced to their own portal
before the screen ever rendered. `migrate diff` reports no drift; typecheck
is clean in both workspaces; the unit suite (126, +6), the integration suite
(100, +16) and the e2e suite (25 specs, +1) are all green.

**The desk's Overview, run against a real database — 2026-08-08.** Track V —
V1b through V4 — is complete: the draft got a name on the wire, the staff
shell and admin workspace let Root run a contract end to end, the customer
learns when something moved, and now the desk answers "what needs me"
without clicking into anything.

Defect D7: nothing recorded *when* a contract entered its current status —
`updatedAt` bumps on any write, including a customer ticking a scope item, so
it could not order a "longest waiting" queue. Fixed with a `statusChangedAt`
column, written by both status writers (the automatic nudge and the manual
override) and only on a real transition — confirmed by an integration test
that sets a contract to the status it already has and checks the clock did
not move. Backfilled from `updatedAt` for existing rows rather than left at
the migration's own run time, which would have told the queue every contract
just arrived.

The three new queries are deliberately thin (`ContractRef`, not `Contract`):
`ActivityItem.contract` resolving through the usual `contractInclude` would
have dragged every concept, page, article, comment and change-log entry along
per row — forty rows reading themselves forty times over. The review queue's
ownership filter — a customer's own action, not any staff member's — is a
same-row comparison across two tables that Prisma's query builder cannot
express as a `where`, so it is filtered in application code against a capped
scan window instead of raw SQL, which felt like the wrong tool for a filter
this simple. The change-log sentence builder that used to live only in
`ContractDetail.tsx` is now `lib/changelog.ts`, imported by both the portal
and the desk — `changeAction.test.ts` now parses its new home, and still
fails loudly on a `ChangeAction` with nowhere to render.

Driven end to end in the browser, in both languages: a customer choosing a
concept, approving every page and leaving a comment nudges their contract
into Waiting on Root and produces three review-queue entries in a sentence
each, correctly excluding the four routine per-page approvals in between;
the tiles and the Needs-Root queue agree with that same transition; a
reviewer signed in to confirm the route renders its empty, honest state
rather than a page of FORBIDDEN errors, since Overview's nav slot is open to
any staff role but its data stays capability-guarded underneath. Tile counts
render in the locale's own digits — Persian shows «۱» beside «منتظر ریشه»,
not a Latin numeral forced onto a page that is otherwise entirely Persian.
`migrate diff` reports no drift; typecheck, the full unit suite (105), the
integration suite (84, +5) and the e2e suite (24 specs, +1) are all green.

**The pending-review banner, run against a real database — 2026-08-06.** V3
adds no re-approval logic — `approveContract` and `signContract` already
reopen on a fresh revision, and the prior approval already survives on the
superseded one (V1b). What was missing was the customer knowing that
something moved, and what: a `pending` field on `Contract`, derived fresh on
every read exactly like the gate, is null unless the text was revised, the
design was revised, or an amendment is waiting.

Driven end to end in the browser, in both languages: as the customer,
complete the design and sign a contract; as Root, revise one page's image
and publish a design v2; back as the customer, the banner reads "the design
changed — 1 page needs your approval," approving that one page (not four —
carry-forward is the same rule the workspace's preview already used) clears
it. Then, as Root, issue and publish an amendment on the signed contract: the
banner switches to naming the amendment, and — because both were pending at
once — correctly puts the design action first and the amendment second,
exactly matching the gate (`assertCanApproveContract` requires the design
complete first). The amendment's own approve-then-sign block worked from the
portal, and the base signature and "✓ Contract approved" never moved.
`border-inline-start` on the banner resolved to `border-right` under
`dir="rtl"`, and the Persian banner reads as a sentence with the count in
plain digits — no `+3/−1`, no `num-latin` forced onto the count. `migrate diff`
reports no drift (this stage adds no migration); typecheck, the full unit
suite (105), the integration suite (79, +7 for `pending`), and the e2e suite
(23 specs, +1 for the banner) are all green.

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
