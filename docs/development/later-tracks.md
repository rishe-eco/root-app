# Later tracks — R2–R4, C1–C2, and the Persian pass

> **Status, 2026-08-08.** Two sections here have been overtaken:
>
> - **C0 is built** (`4eb4106`, out of order — see the build plan §5b). Its
>   section below is kept because the banked traps were all real and all hit:
>   the reset resolver still returns `true` unconditionally, `inviteUrl` still
>   comes back from `inviteCustomer`, D9 closed there, and the templates got
>   their own key-parity test. It reads now as a scorecard for whether banking
>   traps in advance works. It did.
> - **R1 has its own file** — [`R1.md`](R1.md), build-ready and grounded in the
>   code as it is after V4. The R1 section below is superseded; read the file.
>
> What remains genuinely outlined-only: **R2, R3, R4, C1, C2** and the Persian
> pass.

**These are not build-ready.** The V-track files describe work I could ground
line by line in code that exists. These cannot be, because the code they touch
does not exist yet and because V2 will change what the desk looks like in ways
worth seeing before designing on top of it.

What this file is for: **banking the traps that are already knowable**, so they
are found while planning rather than at the end of a stage. Each section names
the spec that owns it, what has already been paid for, and the specific things
that will go wrong.

Write the full stage file for each of these when its turn comes, in the shape of
`V2.md`, and grounded in the code as it is then.

---

## C0 · The email seam

**Spec:** build plan §5b C0; Review Room §4. **Needs:** nothing.

Built as a **seam, not a provider integration** (founder direction, 2026-08-04).
`lib/mail.ts` with a `send` interface and a dev transport that logs the link
exactly as today's `TODO(email)` lines do. Bilingual templates in the
**recipient's** locale for invite, reset, reviewer-invite, new-comment and
contract-revised. Provider config validated at boot but **optional**, so a
missing provider degrades to logging rather than refusing to start. The provider
itself is wired by the founder.

**The two call sites that exist today:**

- `resolvers/admin.ts:92` — `inviteCustomer`, which returns the link once.
- `resolvers/auth.ts:95` — `requestPasswordReset`, which `console.info`s it.

### Banked traps

**A failed send must not fail `requestPasswordReset`.** That resolver returns
`true` unconditionally — "whether the address has an account is not ours to
leak" (`auth.ts:86`). If a send error propagates, the *presence* of an error
leaks exactly what the unconditional `true` was protecting, and so does the
timing difference. Catch, log, return true.

**Keep returning `inviteUrl` from `inviteCustomer`.** It is the fallback when
mail bounces or is not yet wired, it is already capability-guarded, and
`e2e/03-*.spec.ts` asserts it appears. Adding mail does not make it redundant.

**Defect D9 closes here.** `inviteCustomer` cannot set the invitee's locale, so
`User.locale` takes its `fa` default and every invite link is Persian. Templates
in the recipient's locale need the same field. Add `locale` to the mutation and
default it to the **inviting user's** locale, which is a better guess than the
schema's.

**This is the first user-facing text on the server.** Every string the product
shows lives in `apps/web/src/i18n/locales/*.json`; nothing on the API side has
ever needed a Persian sentence. The templates need their own bilingual source
and their own parity test — copy the shape of
`lib/changeAction.test.ts:115` ("en and fa carry exactly the same keys"), which
is the test that stops a sentence existing in one language only.

**Do not log the raw token once a provider is live.** The dev transport logging
the whole link is the point; the same line in production writes a bearer token
into a log file that is not treated as secret.

---

## R1 · Library — model and admin entry editor

**Spec:** Research Lab §3, §5, §7; build plan §5 R1. **Needs:** F1 ✔, F2, F3 ✔.

### Already paid for — do not rebuild it

- `capabilities.ts` already defines `library.write`, `library.publish` and
  `library.editTree`, and `CONTRIBUTOR` already grants exactly the first.
  R1 **consumes** F3 rather than extending it.
- `POLICY.RESEARCH_TEXT` already exists in `lib/files.ts:88` — `PUBLIC`, 25 MB,
  PDF only, `uploader: 'library.write'`, `requiresContract: false`. The upload
  route, the storage layer and the Nginx public alias are all built and tested.
- The desk gains one line in `DESK_SECTIONS`:
  `{ key: 'library', capability: 'library.write' }`.

### The two required enums with no default

A spec sentence of the form "always shown, never implied" only holds if omission
is impossible, and **a defaulted field is omission with a friendly face**. Both
of these are non-null with no `@default`:

- **Translation provenance** — published / Root / none yet.
- **Rights basis** — public domain / open licence / permission granted /
  link-only.

### Banked traps

**Link-only must be refused a file at upload, held by a CHECK constraint.**
Hosted full text is the `PUBLIC` class, which **Nginx serves straight off disk**
(`deploy/nginx/root.conf`, the `/public-files/` block) — the request never
reaches the API, so there is no code left in the path to consult a flag.
Enforced at read, the rule is a wish. This is the same shape as the
private-file-has-an-owner constraint already in the `stored_files` migration.

**A public file's URL is not `/files/:id`.** The upload route returns
`{ url: '/files/' + id }` unconditionally (`routes/files.ts:162`). That URL
*works* for a public file — the GET handler serves both classes, which is what
makes development work without Nginx — but storing it on a Library entry means
every download in production goes through Node and the `/public-files/` alias
never fires. Derive the public URL from `PUBLIC_FILES_BASE` + the storage key
(`lib/env.ts:75`), and consider making the upload response return the right one
per class rather than leaving it to each caller to remember.

**The bilingual full-text search wants a spike here, not a discovery in R2.**
Postgres `tsvector` is the right call — already the database, no new dependency
— but its Persian stemming is weak, and **one index across two scripts** is the
actual problem, not the stemming. Decide the shape (two columns, two indexes,
one `simple` configuration plus normalisation, or a third-party dictionary)
while R1 still owns the schema.

**Visibility is a field on the entry, not a folder someone remembers to check**
(Research Lab §4). The private register — `personal-canon.md` and its kin — is
never surfaced. Note that this is a *third* meaning of "private" in this
codebase, alongside `StoredFile.visibility` and `Contract.publishedAt`. Name the
field so it cannot be mistaken for either.

---

## R2 · Public reader, list and search

**Spec:** Research Lab §1, §2; build plan §5 R2. **Needs:** R1.

This is the stage that opens the content lock. `App.tsx` restructures: the
`cast` and `blog` Reserved routes stop being top-level and become children of
`library`, both **redirecting rather than 404-ing** — they have been reserved
public routes since launch, and a public URL that has ever existed is not free
to delete. (Contrast F2's `/admin`, which is deleted outright because it never
left the team. Same rule, opposite answer.) The locked `cast` nav slot in
`Nav.tsx` becomes the real **Library / کتابخانه** link at `/:lang/library`, and
`nav.cast` and `nav.locked` go with it.

### Banked traps

**The reader shows both languages at once, and the whole RTL system assumes one
direction per page.** Locale lives in the URL prefix and drives `<html dir>`,
the font family and the line height at the *document* level
(`lib/locale.ts:9-17`). Original-beside-translation needs two directions on one
page. This is genuinely new, not a wider column.

Specifically: a `dir="ltr"` island inside a `dir="rtl"` document re-bases every
logical property inside it — `padding-inline-start` flips to the left edge
within that island, which is correct and is also not what the rest of the
stylesheet was written expecting. Spike it against real Persian and English text
before designing the reader.

**`LocaleLayout` remounts on language switch** (`<Outlet key={locale} />`).
A reader with scroll position, an open passage or a search query loses all of
it. In the portal that is fine; in a reading surface it is not. This is where
that decision gets revisited.

---

## R3 · Concept tree

**Spec:** Research Lab §2, §5; build plan §5 R3. **Needs:** R1.

Self-referential hierarchy with a many-to-many to entries — **the one genuinely
new data shape in either spec.** Deliberately after there are entries worth an
ontology.

### Banked traps

- **Prisma does not do recursion.** Reading a subtree is `WITH RECURSIVE` via
  `$queryRaw`, or fetch-all-and-build-in-memory. At the size of an ontology one
  person maintains, in-memory is almost certainly right — say so rather than
  reaching for raw SQL by reflex.
- **Reparenting can create a cycle**, and nothing in a foreign key stops a node
  becoming its own ancestor. Check on write; a cycle makes every subsequent read
  hang rather than error.
- **"Hovering a node surfaces its related titles"** is a hover-triggered fetch
  over a many-to-many. Decide whether that is prefetched with the tree or lazy
  per node before building either.

---

## R4 · The agent

**Spec:** Research Lab §6; build plan §5 R4. **Needs:** R1 (which carries its scope).

Unblocked because its scope turned out to be a field: the rights basis.
**Link-only means cite, never quote**; every other basis means quote with
citation. An agent holding the full text of a paper Root may only link to would
republish it a paragraph at a time, at scale, under Root's name — which is the
failure the field exists to make unreachable.

When this is planned: read the `claude-api` skill before writing any of it, and
do not carry model ids or pricing from memory.

---

## C1 · The Review Room — documents, snapshots and the corpus

**Spec:** Review Room §3.1, §3.2; build plan §5b C1. **Needs:** F2, F3 ✔.

**Snapshot at review time**, and because the corpus is a git repo, the freeze is
a commit: **a review round is a sha.** An explicit publish step takes that sha
plus the allowlist, renders the named paths, and writes snapshots into Postgres
hashed with the same canonical serialization `lib/revision.ts` already uses.
**The API never reads a git tree**; `root-sot` is not on the VPS and is not
going there to make this work.

**One corpus for everyone, defined by an allowlist** — no per-reviewer grants.
The security surface is *what is in the corpus at all*, and the default points
allow: a denylist would make a private file committed six months from now
visible to every reviewer the moment it lands, with nobody asked.

### Banked traps

**The publish step has to get text across a 1 MB JSON limit.**
`express.json({ limit: '1mb' })` is mounted on `/graphql` (`src/index.ts:67`).
`root-sot` is 83 tracked markdown files; a publish mutation carrying a whole
round would exceed it. Options, in preference order: one document per call
(simple, resumable, and the natural granularity anyway); the existing upload
route with a new `FileClass`; or raising the limit, which is the one that also
raises it for everything else. Decide before writing the script.

**Reuse `canonicalize`, add a snapshot shape — do not add a second hasher.**
A document snapshot is its own shape (`format`, `path`, `sha`, `text`), but it
goes through the same `canonicalize` + sha256 in `lib/revision.ts`. That file's
header explains why there is exactly one of these; a markdown-specific hasher
would be the second, and the two would drift.

**The allowlist file is the security artifact.** `personal-canon.md` is the
concrete case the decision was made for. Wherever the allowlist lives, it needs
to be reviewable at a glance and hard to widen by accident — a manifest with one
path per line beats a glob.

**Where does the publish step run?** On the machine that has `root-sot` — the
founder's. That makes it a script authenticating as a staff user against the
deployed API, which means a long-lived credential or a session, and that is a
decision to make deliberately rather than by picking whatever works first.

---

## C2 · The Review Room — comments, threads and the corpus admin

**Spec:** Review Room §3.3; build plan §5b C2. **Needs:** C0, C1.

Passage-level anchoring, which the snapshot is what makes safe. Root replies
in-thread; threads resolve; **reviewers do not see each other's comments** —
parallel independent review, so one expert's read does not anchor another's.
Cutting a new round leaves existing threads attached to the round they were
written against, labelled, rather than re-anchored or dropped.

### Banked traps

**"Reviewers do not see each other's comments" is an ownership edge, not a
capability.** It is `authorId === user.id`, with staff seeing everything —
structurally the same rule as `loadForActor`. Asking a capability would get it
wrong for a reviewer who also holds another role. House rule 2, and this is the
third place in the project where that distinction decides a design.

**Character offsets over Persian text need one representation, stated.**
JavaScript strings are UTF-16; Postgres `substring` counts characters; a
document containing anything outside the BMP makes those two disagree and every
anchor after that point shifts. Pick code-point offsets computed with
`Array.from(text)` on both ends, **and store the anchored text alongside the
range** so a mismatch is detectable rather than silent. An anchor that quietly
points three characters left is worse than one that reports itself broken.

**The name is still open.** "Review Room" is a working handle; the route is
`/desk/review`. It is private, so it needs no public label and no Persian nav
string — which is exactly why it can wait until it is built.

**One workflow question is open and blocks nothing:** may Root cut round 2 while
round 1 is still being read? Lean: yes, both visible, round 1's threads labelled
as such. Decide inside this stage.

---

## The Persian pass

Last in the build plan's sequence, and unspecified. What it almost certainly
means, from the repo README's own open questions:

> **Copy that is mine, not yours.** Landing, About, Contracts and the contract
> detail use your copy verbatim from the prototypes. The auth screens, the
> admin, the stub sections and the empty states are my drafts in both
> languages — read them.

By the time this arrives, every string F2, V2, V3, V4 and the R/C tracks add
will be in that category too: written by a model, never read by a Persian
speaker. The pass is a founder reading `fa.json` end to end.

Two things that make it cheaper, and both are free if done as you go:

- **Keep `fa.json` and `en.json` key-for-key identical.** Only the `log.*`
  namespace is tested for this. Everything else is on the author.
- **Write the Persian first, or at least not as a translation.** Persian is the
  product's first language, not a rendering of the English. A string that reads
  as translated English is the thing this pass exists to catch, and it is much
  cheaper not to write it.
