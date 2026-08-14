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
- Email (C0): invite and password reset, sent through a provider seam with a
  logging fallback when none is configured, templated in the recipient's own
  locale. (Reviewer-invite and new-comment were promised alongside these but
  not actually built until C2, below; contract-revised is still unbuilt —
  see the note under C2.)
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
- The Review Room's comments (C2): a thread anchors to `(blockId, start,
  end)` into a block's *rendered* plain text, not its markdown source — the
  string a reviewer actually selected, computed by `lib/anchor.ts` and
  verified against the live render on every read; a mismatch shows the
  thread detached, quote intact, never re-found. Root sees every thread; a
  reviewer sees only their own, filtered by one function
  (`threadsVisibleTo`) that also happens to be the entire permission check
  for replying to and resolving one — a thread not visible through it cannot
  be loaded at all. A new corpus-admin screen at `/desk/reviewAdmin`
  (`review.admin`) can invite and revoke reviewers; revoking is refused,
  not silently worked around, when reviewer is an account's only role.
  Two more mail templates exist now: reviewer-invite and new-comment (never
  sent to a different reviewer's thread than the one that changed).
- The Research Lab's agent (R4): "Ask the Lab" and "Ask this paper" — one
  component and one server-side code path, the candidate set narrowed to one
  entry for the pinned variant and nothing else. The rights boundary is
  structural, not a system-prompt request: `quotableFullText` is the single
  gate a `LINK_ONLY` entry's hosted text must pass before it may become a
  `file` document block, `buildDocumentBlocks` re-derives it itself rather
  than trusting a caller, and the database's own CHECK constraint from R1
  makes "LINK_ONLY with a hosted file" an impossible row regardless. A
  quotable entry's PDF is uploaded to the Files API once, cached on
  `StoredFile.anthropicFileId`, and never re-uploaded. The answer streams
  over hand-rolled SSE on `POST /ask` — plain HTTP, not GraphQL, the same
  reasoning upload/download already established — and every citation the
  model returns resolves back to a real entry URL. Rate limiting (a per-IP
  token bucket) and a daily spend ceiling that fails closed are both real,
  in front of the first endpoint in this app where an anonymous request
  spends money.
- The Persian pass's mechanical half (§1 of `persian-pass.md`): a general
  locale key-parity test, the numeral rule written into house rule 14 and
  five real font/digit-mismatch bugs it caught, four ZWNJ spelling
  inconsistencies normalized, and the confirmed lang/dir gap on Library
  titles and `/ask` citations closed with a new `<Text lang>` component. The
  founder's own read-through (§2) and the style guide's move into `root-sot`
  canon (§3.2) are explicitly not an engineer's call — see the dated note
  below.

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
~~An upload form~~, ~~creating a contract, entering article text, and
publishing a revision from the admin UI~~ — both built by the admin contract
workspace (V2) — and ~~Review Room comments~~, built by C2 below; see "Built
and working" above and the notes below.

**The Persian pass's mechanical half, against a real database and a real
browser — 2026-08-14.** `persian-pass.md` splits into two halves that need
different people: §1 (mechanical, the engineer's) and §2 (judgement — does
the Persian read as *written*, not translated — the founder's, and nobody
else's to call). This pass did §1 completely and stopped there on purpose;
§2 and one part of §3 are recorded below as open, not skipped.

Built on `main` after merging both C2 and R4 (each already carrying its own
review), so the audit ran against the whole surface the build plan lists
except R3 (still deferred on its own corpus-size gate).

**§1.1 — the key-parity test that didn't exist.** There was exactly one
(`changeAction.test.ts`, `log.*` only). `lib/localeParity.test.ts` is the
general one: every key in `en.json` in `fa.json` and back, plus two
subtler checks — no `fa` value byte-identical to its `en` counterpart, and
none containing Latin letters — both past a small allowlist (`Root`, `PDF`,
`DOI`, i18next's `{{var}}` interpolation, and the bare `v` that prefixes a
version number outside the braces). The corpus turned out to already have
zero missing keys either direction — five years of "every string in both
locales" discipline holding up under the first test that actually checks it.

**§1.2 — the numeral rule, written down and then broken by five things
already in the code.** The rule is now house rule 14: counts/totals/
pagination in the locale's own digits via `formatCount`; dates, times and
money the same way; years, DOIs, refs, version numbers, hashes and concept
keys stay Latin (`num-latin`) everywhere, citations included. Auditing every
numeric render against it found the *same* bug five separate times — a
correctly Persian-formatted number wrapped in `num-latin`, which forces the
Latin figure font onto digits that are already ۰-۹ — in the contracts list's
status chip counts, `ActivityTab`'s amendment count and concept×page tally,
the Library umbrella's entry total, the portal contract list's fee column,
and the print view's own fee line. Two more were i18next's `{{count}}`
templates (`detail.pending.designBody`, `detail.versions.awaiting`)
interpolating a raw JS number with no digit localization at all — `{{count}}`
is what i18next uses to *pick* a plural form, not to format one, so it prints
whatever `Number.prototype.toString` gives it regardless of locale. Fixed by
keeping `count` for plural selection and adding a second, pre-formatted `n`
for display; two more call sites with no plural form (`workspace.
carriedPages`/`resetPages`) got the same treatment without needing the extra
variable.

**§1.3 — the logical-properties sweep held clean.** The prescribed grep found
one hit, inside a comment explaining why the rule exists, not a real
`left:`/`margin-right:` anywhere in the stylesheets. The one `transform:
translate(-50%, -50%)` centering trick is the documented direction-agnostic
exception.

**§1.4 — the `:lang()` pair, verified by computed style, in both
directions.** Textually complete already (`:lang(fa)`/`:lang(en)` set the
same four custom properties and match `:root`'s Latin defaults exactly).
Live-verified past appearance into `getComputedStyle`: a throwaway
Persian-original, English-translated Library entry was created, published,
read and deleted specifically to prove the direction R2 never had a real
entry to test — the original column resolved to Vazirmatn at 28.8px leading
inside an English-locale page, the translation column to Inter at 24.8px
leading inside a Persian one, matching `:lang(fa)`'s `1.8` and `:lang(en)`'s
`1.55` exactly, crossing the block boundary correctly with nothing
hard-coded to the page's own locale.

**§1.5 — every Persian string read for ZWNJ, four real inconsistencies
found.** None were rendering bugs — in every case the letter the missing
ZWNJ would have separated already doesn't connect forward (ر, د, ا) — but
the same word was spelled two different ways in different places, which a
Persian reader does notice: «گفتگو» beside an already-established
«گفت‌وگو», and three status-label instances of «امضا شده»/«امضاشده» and
«تأیید شده»/«تأییدشده» where the fused, ZWNJ-joined form was already the
majority convention everywhere else the same word appears. Normalized to
match. The two newest mail templates (reviewer-invite, new-comment) were
read too and were already correct.

**§1.6 / §1.6.1 — the confirmed gap, closed; the names decision, made and
documented rather than fixed by reflex.** Every email/password/DOI/URL/year
input already carried the right `dir`, and the password toggle's logical
positioning was already correct. The gap the C2/R4 reviews had already found
and written into `persian-pass.md` §1.6.1 — a Library title rendered outside
the reader with no `lang`/`dir` at all, so a Persian title inside an English
list sits in the Latin face, LTR — is fixed once, as a component:
`components/Text.tsx` sets `lang` and `dir` from one source (`dirFor`), and
is wired into five places: the public Library list, its "recently added"
strand on the umbrella page, the desk Library list, the desk entry editor's
own heading, and the `/ask` citation panel — which needed `originalLang`
threading all the way from the resolver (added to both `PublicEntryRow` and
`LibraryEntryRow`'s GraphQL selection) through the SSE `done` event
(`entryOriginalLang`) to the client, since the citation payload had never
carried it. **Names were deliberately left alone.** The spec offered three
options — a stored language field, `lib/markdown.ts`'s `blockLocale` script
heuristic, or accepting the ambient direction — and asked for a decision, not
a reflex fix. `blockLocale` is tuned for multi-sentence prose and untested on
short proper nouns; retrofitting it would also have meant touching a dozen
more call sites (customer names, activity-log actors, the signed-in user's
own name in the shell) well past the two the review had actually flagged;
and a name switching script and font mid-sentence is arguably a worse
reading experience than the status quo. Decided: names render in the
ambient direction, documented in place at the two flagged call sites
(`ReviewAdmin.tsx`, `ReviewDocumentScreen.tsx`) so a future reflex fix finds
the reasoning first.

**§1.7 — print, re-verified against a real signed-less revision, in both
languages.** Jalali date, Persian digits, the sha256 hash, the ref and the
version number all rendered correctly — and turned up the same `num-latin`
bug as §1.2, in the print view's own fee line, which is now fixed too.

**§2 and §3.2 — explicitly not done here.** §2 is the founder reading the
Persian product end to end, alone, without the English beside it — "nobody
else can call this" is the spec's own words, and an engineer producing a
glossary or a terminology ruling would be exactly the reflex the mechanical
half exists to clear out of the way first. §3.2's style guide (the numeral
rule, the ZWNJ notes above, whatever §2 finds) belongs in `root-sot` canon,
which this repo doesn't have a working copy of. **§3.1 was settled**: yes,
the desk gets the same standard as the portal — already reflected above,
since the desk's own Library list, editor and Review Room screens got the
same fixes as the public-facing ones, not a lighter pass.

**Verified how:** typecheck and the full unit suite (30 web, 179 API),
integration suite (147) and e2e suite (29) are all green; the numeral and
lang/dir fixes were driven live in a real browser in both languages, not
just read from source.

**The Research Lab's agent, asked for real — 2026-08-12.**
R4 was the explicit next instruction — R3 stays deferred on the same
corpus-size gate that sent R1/R2 to C1 first, and C2 (Review Room comments)
remained the build plan's own "default next" but was not what was asked for.

**§0's boundary, held two ways, and proven both.** A `LINK_ONLY` entry's
hosted text must never enter a request — the build plan's own words are that
an agent holding it "would republish it a paragraph at a time, at scale,
under Root's name." That cannot be a system-prompt instruction, since nothing
stops a model from paraphrasing or a reader from asking directly, so it has
to be about what the request contains. `quotableFullText(entry)` is the one
function that decides, and `buildDocumentBlocks` calls it itself rather than
trusting a `fullTextIds` set a caller already computed — proven by a unit
test that hands it a LINK_ONLY entry deliberately pre-marked for full text
and asserts the block it produces is text-only regardless. Then, against the
real database: R1's own CHECK constraint
(`LibraryEntry_hosted_text_is_publishable`) already makes "LINK_ONLY with a
hosted file" an impossible row, confirmed by `assert.rejects` in the
integration suite rather than assumed. Two independent layers, and the
integration test asks a real question of a corpus holding one LINK_ONLY entry
beside one quotable entry with an actual uploaded PDF, in the same request,
and asserts exactly one `file`-sourced document block comes out the other
side.

**Retrieval found a real gap in reusing R2's query as written.** R2's search
box types a few keywords and the resolver does `searchText: { contains: term
}` — a whole `contains` argument has to appear as one substring. A full
question ("What does the beekeeping research say?") almost never appears
verbatim in an entry's stored abstract, so passing the question straight
through returned nothing for nearly every real question — caught by the
integration suite failing on exactly this, not spotted in review.
`extractSearchTerms` splits the folded question into words and matches an
entry containing *any* of them: still `searchText`/`foldPersian`, still no
`tsvector`, still no embeddings — R4.md §2.1's own reasoning ("retrieval that
returns everything plausible and lets a 1M-context model read it is both
simpler and better") applied to what "reuse R2's query" has to mean for a
sentence instead of a keyword.

**The transport is a plain route, not GraphQL, and hand-rolled SSE over a
`POST`, not `EventSource`.** Same reasoning `routes/files.ts` already
established for upload/download: a streamed response doesn't fit Apollo's
JSON contract. `EventSource` only does `GET`, and a `GET` would put the
question in a URL that lands in Nginx's own access log beside the visitor's
IP — exactly the "record of what someone is reading" §4 says never to
create — so the client reads the stream by hand off `fetch`'s
`ReadableStream` instead.

**Every string a reader sees is the client's, not the server's — found by
applying house rule 6 literally.** The first draft had the API compose
bilingual prose directly into error and refusal payloads; rewritten so every
SSE/JSON error carries a bare code (`RATE_LIMITED`, `RESTING`, `UNAVAILABLE`,
…) and `apps/web/src/lib/ask.ts` + `AskLab.tsx` own every displayed string
through `fa.json`/`en.json`, same as everywhere else in the app.

**Cost control, for real, not just described.** A hosted PDF is uploaded to
the Files API the first time a quotable entry is asked about and never
again — `StoredFile.anthropicFileId` (new column, its own migration) caches
the id, proven by an integration test that asks the same paper twice and
counts exactly one upload. The full-text selector is cheapest-first by byte
size against both a document-count cap and a cumulative-byte cap (the API's
32 MB request ceiling, not just R1's 25 MB per-file cap, is the real
constraint once a question can pull in several papers). The last document
block carries the cache breakpoint, paying off for a reader asking several
questions of the same pinned paper. A per-IP token bucket and a daily spend
ceiling that fails closed both sit in front of the model call, in-memory by
design — the same tradeoff §4 itself accepts for the bucket, and losing a
day's spend counter to a restart is the recoverable failure next to a
ceiling that silently stops enforcing.

**e2e stubs the transport a layer up from the wire, deliberately.** A byte-
exact mock of the real Messages API's SSE framing (content block deltas,
citation deltas, message-delta usage) is a lot of undocumented low-level
protocol to get right blind for one spec, and a subtly wrong mock is a false
green — worse than no e2e coverage. `ANTHROPIC_E2E_STUB=1` (env-only, and
`env.ts` refuses to boot with it set in production) swaps in a canned
in-process client at the same module seam the integration suite already
trusts, wired on by `playwright.config.ts` the same way it already injects
`JWT_SECRET`. The rights boundary and every refusal path stay the
integration suite's job, proven against the real database; the e2e spec's
job is only "does a real browser, streaming over the real wire, end up
showing a real citation link" — and it does.

**One thing this stage could not do.** §8 asks for a manual read of three
real questions against the live API, in both languages — the one part of
this stage that judges answer quality rather than code correctness. No
`ANTHROPIC_API_KEY` is reachable from this sandbox (checked directly, and via
`ant auth status` — the `ant` CLI itself isn't installed here), so that read
could not be done. Recorded rather than silently skipped, same as C1's
uncompletable root-sot wording fix. What *was* done instead: the full
browser pass below, live against `ANTHROPIC_E2E_STUB`, driving both "Ask the
Lab" and "Ask this paper" in both languages, including reading the RTL/font
computed styles on the answer panel and confirming the citation link's
`href` carries the right locale prefix.

Nginx needs a real block for the first time since C0 — `deploy/nginx/root.conf`
gained `location = /ask` with its own rate-limit zone (separate budget from
`/graphql`, since only one of the two spends money), `proxy_buffering off`
for the stream, and a longer read timeout than `/graphql`'s. `vite.config.ts`'s
dev/preview proxy gained `/ask` alongside `/graphql`/`/files`/`/upload`.

Tests: unit 169 (+21 — `askLab.ts`'s rights gate, retrieval, request/response
shape, and the upload-once seam), integration 130 (+11, including the two-
layer §0 proof above and the daily-ceiling/rate-limit refusals), e2e 28 (+1,
against the stubbed transport). `prisma migrate diff` reports no drift.

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

**The Review Room's comments, run against a real database — 2026-08-12.**
C2's whole design turns on one choice (§1): anchor to a block's *rendered*
plain text, not its markdown source. `marked`/`dompurify` emit no source
positions, and an offset into `**bold**` counts its own asterisks — rendered
text is the string a reviewer actually selected, and C1 already paid for the
precondition that makes it stable (`marked`/`dompurify` pinned exact, a
published block's markdown never changes). `lib/anchor.ts` is the whole
answer: `renderedPlainText`/`rangeToOffsets` reuse the same "prefix range's
string length" trick a browser's own selection reporting relies on, so they
agree with each other by construction; `offsetsToRange` walks back to a real
Range for round-tripping and for highlighting (`Range.extractContents`, which
already splits a partial text node at the boundary per spec — a **bold** in
the middle of a selection needs no special case). None of it touches
`document`/`window` directly, which is what let it be unit-tested over a
constructed fragment with `jsdom` (a new devDependency, test-only) rather
than a browser.

The quote column is the anchor's own witness (§1.1), checked on every read —
`verifyAnchor` — and a mismatch renders the thread **detached**: the quote
shown plain, unhighlighted, never re-found by fuzzy matching. A comment
highlighting the wrong words is worse than one highlighting nothing, because
a reviewer reads the highlight and not the quote.

**"Reviewers do not see each other's comments" turned out to double as the
entire write permission check, not just the read one** — the one design
payoff worth naming. `threadsVisibleTo(user)` (Root: no filter; a reviewer:
`authorId: me`) is used to *load* a thread before replying to or resolving
it; a thread that filter excludes was never fetched, so there is no second
"is this yours" check anywhere to forget or get backwards. Proven at both
ends: an integration test opens a thread as one reviewer and asserts a
second reviewer's `reviewDocument.threads` comes back empty while Root's
comes back with it, and a second test asserts replying to or resolving that
thread by id, as the second reviewer, is `NOT_FOUND` — indistinguishable
from a thread that never existed, never `FORBIDDEN` (house rule: existence
and ownership collapse into one answer). A hand-written CHECK
(`startOffset >= 0 AND endOffset > startOffset`) backs up the resolver's own
validation at the database, asserted directly with `assert.rejects` rather
than assumed.

Revoking a reviewer's role hit the exact constraint violation C2.md flagged
as "waiting in the revoke path": `User.roles` cannot go empty. Decided
explicitly rather than invented around — `revokeReviewer` refuses with a
plain `LAST_ROLE` code when it's the account's only role, rather than
silently demoting them to some fallback or leaving a row the database would
have rejected anyway. Revoking one of *several* roles removes only
`REVIEWER` and leaves every comment and thread the person wrote exactly
where it was — deleting a reviewer's record of the review would destroy the
thing the feature exists to produce.

C0's own promise turned out to be wrong twice over, both corrected here.
The root-sot build plan's §5b line — "bilingual templates … for invite,
reset, reviewer-invite, new-comment and contract-revised" — was never true;
C0 built two of five and said so honestly in its own header comment, but
nothing corrected the promise itself (`later-tracks.md`, footnoted now).
This repo's own README repeated the overclaim in its "Built and working"
list, corrected above. C2 writes two of the remaining three —
`reviewerInviteEmail`, `newCommentEmail` — both in the key-parity test
alongside invite/reset; `contract-revised` is still nobody's job yet.
**A real bug the fix surfaced**: `apps/api/.env` carries a live Resend key,
and neither `test:integration`'s npm script nor the e2e `webServer` env
overrode it — meaning the moment a resolver under test called `sendMail`
(nothing had, before C2), every test run would have placed a real outbound
call to Resend using fake `@test.local` addresses. Both now pin
`RESEND_API_KEY`/`MAIL_FROM` to the empty string, which `env.ts`'s existing
`emptyToUndefined` preprocessing already treats as unset — no new mechanism,
just two lines using one that was sitting there for a different reason
(docker-compose's blank-var interpolation).

Driven live in the browser in both languages: a reviewer selects a passage,
opens a thread, sees it highlighted with the comment attached; Root reads
the same document, sees the thread (a second seeded reviewer would not),
replies, and resolves it — the card collapses, stays readable, and the
highlight is still there on demand (T4: resolution is a state, not a hide).
In Persian, the cross-block refusal message and the compose form read
correctly RTL, and a selection inside a Persian block mixed with Latin words
(root-sot's canon does this) anchors on the same logical character offsets
as an all-Latin one — verified directly, not assumed, per T3. `migrate diff`
reports no drift; typecheck is clean in both workspaces; the web unit suite
(21, +13, all in the new `lib/anchor.test.ts`), the API unit suite (168, +10
in `lib/mailTemplates.test.ts`), the integration suite (135, +16, all in the
new `test/c2.test.ts`) and the e2e suite (28, +1) are all green.

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
