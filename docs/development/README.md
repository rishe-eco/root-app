# Development plan — how the remaining stages get built

**Written:** 2026-08-05 · **Revised 2026-08-10** · Against `root-app` @
`stage-v4-overview` + uncommitted brand-copy work
**For:** the engineer picking up the next stage. Read this file, then read *only*
your stage's file. They are written to be self-contained.

> **Tracks V, C and R4 are complete.** Everything through C2 and R4 is built
> and merged to `main`; the Persian pass's mechanical half (§1) closed on
> 2026-08-14. **What's left:** R3 (conditional on corpus size — check before
> starting it), and the Persian pass's §2 (the founder's own read-through)
> and §3.2 (moving the style guide into `root-sot` canon) — see the dated
> note in the root [`README.md`](../../README.md).

## ⚠ Nothing is merged

All six stages sit chained on `stage-v4-overview`; **`main` is still at
`478fb52`**, which is F3. Every `stage-*` branch is a link in that chain, not an
independent line of work.

Read `main` to learn what exists and you will be six stages behind. Merge before
starting R1, so that R1's branch is cut from something that reflects the app.

---

## The three layers, and which one wins

| Layer | Lives in | Answers | Wins on |
|---|---|---|---|
| **Specs** | `root-sot/ecosystem/working/root-website-*.md` | *what* to build | what |
| **Build plan** | `root-sot/ecosystem/working/root-website-build-plan.md` | *in what order* | order |
| **These files** | here, `docs/development/` | *how, against this code* | nothing |

Where a stage file and a spec disagree about **what**, the spec wins and the
stage file is wrong — say so rather than following it. Where a stage file
describes **this repository** and the repository disagrees, the repository wins:
every file:line reference here was read on 2026-08-05 and code moves.

These live in `root-app` rather than `root-sot` for one reason: they cite line
numbers and go stale with the code. The README's "code only" rule is about
canon, and a work order that dies when the code changes is not canon.

---

## Sequence

The build plan's linear order, with what is done:

```
F1   upload + storage            ✔ 2026-08-03 / 2026-08-04
F3   roles + capabilities        ✔ 2026-08-05
V1b  the draft, made readable    ✔ 2026-08-05  44b2a52          [V1b.md]
F2   the staff shell at /desk    ✔ 2026-08-05  337f952          [F2.md]
V2   admin contract workspace    ✔ 2026-08-06  ed3aac9          [V2.md]
V3   customer revised-banner     ✔ 2026-08-07  5b6182f          [V3.md]
V4   admin overview + queue      ✔ 2026-08-08  337ce1c          [V4.md]
C0   the email seam              ✔ 2026-08-08  4eb4106  ← early
     the tagline + hero          ✔ 2026-08-10             [tagline.md]
R1   Library model + editor      ✔ 2026-08-10  bc1f6aa          [R1.md]
R2   public reader + search      ✔ 2026-08-11  e267676          [R2.md]
C1   Review Room corpus          ✔ 2026-08-11  b5e6bed  ← early [C1.md]
C2   Review Room comments        ✔ 2026-08-13  6bd43bb          [C2.md]
R4   the agent                   ✔ 2026-08-13  c3fcf0f  ← early [R4.md]
──────────────────────────────── everything below is unbuilt ────────
R3   concept tree                ← conditional, see below       [R3.md]
the Persian pass                 ← §1 done 2026-08-14, §2/§3 open
                                                     [persian-pass.md]
```

**Every remaining stage has a build-ready file.** The Persian pass had never been
specified anywhere — the build plan lists it and never says what it is — so
[`persian-pass.md`](persian-pass.md) *proposes* what it is. Argue with that
definition before starting it.

**R3 carries a condition the others do not.** The build plan places it
*"deliberately after there are entries worth an ontology"*. If the corpus is
still a handful of entries when its turn comes, **skip it and take C1** — a
tree over twelve entries is worse than a flat tag list, and building it early
fixes the hierarchy before anyone knows what it should be.

**R1's review found five things; four are fixed and one carries into R2.**
Fixed on 2026-08-10: the unbounded `limit` (now `lib/pagination.ts`, used by
the Library *and* V4's two queries), the Persian-digit inconsistency in the
entry list, a gap in the fold drift-guard that checked the replaced characters
but not the stripped ones, and the `tsvector` deferral that had been decided
and never written into the code.

**What carries:** `:lang(fa)` in `tokens.css` sets custom properties that
inherit, and nothing resets them — so a Latin block inside a Persian page is
set in Vazirmatn at Persian leading. Invisible today, and R2's reader is
exactly the page that puts two languages on one screen. [`R2.md`](R2.md) §1.

**C0 was built out of order**, after V4 rather than after R3. The reason for
placing it late was sound and is unchanged — email's only hard deadline is the
Review Room — but its two call sites were already written and V2 had just made
the invite reachable from a screen, so it was opportunity rather than need.
Track C now inherits a built seam.

**Do one stage per branch, in order.**

There is also [`defects-found.md`](defects-found.md) — ten things found wrong
with the code by reading it before track V was built, each assigned to the stage
that should fix it. **Nine are now fixed**, inside their assigned stage, at no
schedule cost; the tenth is recorded debt. That file is kept as a closed ledger
rather than deleted, because the pattern it demonstrates is the reusable part:
the defect pass paid for itself, and **D1** in particular — a client-side guard
that would have deadlocked a customer the first time V2 published a design
revision on an approved contract — is a bug that only becomes *reachable*
because a later stage works, which is precisely the kind no stage's own testing
would have caught.

Do the same reading pass before R1.

---

## House rules

These are not style preferences. Each one is a rule this codebase already
enforces somewhere, and breaking it fails a test, a review, or a customer.

**1 · Never test a role. Test a capability.**
`user.roles` is a set. Any `role === 'X'` is wrong the moment someone holds two,
and it fails *silently and in an arbitrary direction*. The only file allowed to
read a role name is `apps/api/src/lib/capabilities.ts`. On the client, the same:
branch on `me.capabilities` via `can()` in `apps/web/src/lib/queries.ts:19`.

**2 · A capability and an ownership edge are different mechanisms, never merged.**
A capability answers *may you use this surface at all*. An ownership edge
answers *which rows do you see through it*. `loadForActor`
(`resolvers/contracts.ts:62`) is the ownership half; `requireCapability`
(`context.ts:45`) is the capability half. The one place these were merged —
`addComment` deciding whose court the ball is in — was found and fixed in F3;
it now reads `user.id === contract.customerId`. Do not re-merge them.

**3 · One rule, one file.**
The gate lives in `lib/gate.ts`. What "unchanged" means between design revisions
lives in `lib/design.ts`. Canonical serialization and hashing live in
`lib/revision.ts`. Who may do what lives in `lib/capabilities.ts`. If you need
one of these somewhere new, **import it**. A second implementation of any of
them will drift, and the visible copy will be the one that looks right while
the enforcing copy does something else. This has already happened once — see
defect **D1**.

**4 · Drafts are invisible until published.**
The contract's draft is the mutable `Article` rows plus title/fee on `Contract`;
publishing serializes them into an immutable snapshot. The design's draft is a
`DesignRevision` with `publishedAt: null`, edited in place. Nothing a customer
reads comes from a draft. **The one exception is `ScopeItem`**, which is not
versioned at all and is live the moment it is written — see V2.

**5 · A published revision is immutable. A signed one is terminal.**
`requireDraft` (`resolvers/admin.ts:32`) guards the first half. The second half
is `publishContractRevision` refusing with `CONTRACT_SIGNED`. Changes after
signature are amendments, never a v2.

**6 · Every user-facing string is in `fa.json` **and** `en.json`.**
No text is typed into a component. Adding a key to one locale and not the other
is the same bug as missing it, and only shows for half the customers — there is
a test that catches this for the `log.*` namespace
(`lib/changeAction.test.ts:115`) and nothing that catches it elsewhere. Persian
is **never letter-spaced** (it breaks the connected script) and **never
uppercased** (Persian has no case); `base.css` undoes both for kit classes that
apply them to Latin.

**7 · Layout uses logical properties only.**
`padding-inline`, `margin-inline-start`, `inset-inline-start`, `border-inline-end`.
RTL mirrors without a second stylesheet. A single `left:` or `margin-right:`
breaks Persian silently — it looks fine in English.

**8 · Every value in component CSS is a token reference.**
`tokens.css` and `kit.css` came from the design handoff and are the portable
layer. No raw colours, sizes, spaces or radii anywhere else.

**9 · `BigInt` becomes a decimal `String` at every boundary.**
`Contract.amount` is `BigInt?` and does not survive `JSON.stringify`. GraphQL
returns `String`; the snapshot stores a decimal string. Forgetting this throws
at the first publish, not at compile time.

**10 · Adding a `ChangeAction` touches five files.**
`prisma/schema.prisma`, `graphql/typeDefs.ts`, `web/src/portal/ContractDetail.tsx`
(the `logText` key map), `web/src/i18n/locales/en.json`, `…/fa.json`.
`lib/changeAction.test.ts` reads all five as text and asserts they agree —
it will fail loudly, which is the point. Do not work around it.

**11 · Constraints Prisma cannot express go into the migration by hand.**
There are three already: `StoredFile_private_has_owner`, the signature's
exactly-one-instrument check, and `User_roles_non_empty`. When you write one:
**`cardinality(x) > 0`, never `array_length(x, 1) > 0`** — `array_length`
returns NULL on an empty array, and a CHECK that evaluates to NULL *passes*.

**12 · Errors carry a code you chose.**
`new GraphQLError(message, { extensions: { code: 'SOMETHING' } })`. A code marks
the error as a deliberate outcome, which `lib/logging.ts` uses to decide whether
to log a stack. An error without one is treated as a bug and, in production, has
its message replaced. Codes are part of the interface — the integration tests
assert on them.

**13 · Refusals to a customer say "no such thing", not "not allowed".**
`loadForActor` answers `NOT_FOUND` for both a missing contract and someone
else's. Distinguishing them turns the resolver into an oracle for which ids
exist.

**14 · Digits are Persian, except identifiers.** Settled by the Persian pass
([`persian-pass.md`](persian-pass.md) §1.2), after finding the codebase
disagreeing with itself once already (R1's entry count).

| | Digits | Why |
|---|---|---|
| Counts, totals, pagination, tallies | **Persian** «۱۲», `formatCount` | prose numbers in a Persian sentence |
| Dates, times, money | **Persian** | already the case, via `Intl` and `fa-IR` |
| Years, DOIs, refs, version numbers, hashes, concept keys | **Latin**, `num-latin` | identifiers that are Latin wherever printed, including in citations |

`formatCount(n, locale)` (`apps/web/src/lib/format.ts`) is the one place that
runs a count through `Intl.NumberFormat` — call it rather than interpolating
a raw number, including into i18next's `{{count}}`, which selects a plural
form but does not localize the digits it is given. Where a template needs
both — a plural form *and* Persian display digits — pass `count` (the real
number, for plural selection) and a second variable carrying the formatted
string for display (see `detail.pending.designBody`, `detail.versions.awaiting`).

---

## Working agreement

**Branch per stage**, named as the build plan names it: `stage-v1b-draft`,
`stage-f2-desk`, `stage-v2-workspace`, and so on. Do not commit to `main`.

**Run, in this order, before calling a stage done:**

```bash
npm run typecheck            # both workspaces
npm test                     # unit — pure functions, no database, ~0.5s
npm run test:integration     # resolvers against Postgres (needs root_website_test)
npm run e2e                  # the browser, against the built app
```

The integration suite refuses to start unless `DATABASE_URL` names a `*_test`
database — it truncates every table it finds. Create it once:

```bash
createdb root_website_test
DATABASE_URL="postgresql://root:root@localhost:5432/root_website_test?schema=public" \
  npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Playwright's browser download is geo-blocked here; `playwright.config.ts` sets
`channel: 'chrome'` and drives the installed Chrome. Nothing needs downloading.

**Migrations.** Generate with `prisma migrate dev`, then **read the SQL it
produced** and add by hand anything Prisma cannot express. Verify with
`prisma migrate diff` reporting no drift between the applied result and
`schema.prisma`. Never edit a migration that has been applied anywhere but your
own machine.

**Verify in a browser, not only in tests.** Both languages. The portal in Persian
is the product; the English side is the translation. A change that only got
looked at in English has been looked at half.

**Done means:** the acceptance criterion in the stage file is demonstrated, all
four commands above are green, both languages were driven in a browser for
anything visible, and the stage file's "record what the build settled" section
has been filled in — the build plan's every stage carries a list of things the
plan did not know, and that list is the most useful thing each stage produces.

---

## Things that are true of this codebase and easy to get wrong

- **`apps/web` and `apps/api` are separate TypeScript projects.** Nothing is
  shared between them at the type level. `queries.ts` mirrors the server's types
  by hand and can drift — it already has (defect **D3**).
- **The API is ESM.** Relative imports carry a `.js` extension even in
  TypeScript source. `import { prisma } from '../../lib/prisma.js'`.
- **Dev is same-origin by proxy.** `vite.config.ts` proxies `/graphql`,
  `/files` and `/upload` to the API, because the session is an httpOnly
  `SameSite=Lax` cookie and a cross-site API would have it dropped. Production
  does the same through host Nginx. Never introduce a second origin.
- **`apps/api/dist/` and `apps/web/dist/` are local build output**, gitignored
  and stale on disk. Never read them to understand behaviour; a `grep` across
  the repo will hit them and show you last week's code.
- **`.claude/worktrees/` contains two old worktrees.** They are not the project.
- **No stage from V1b to R1 needs a deployment change.** New SPA routes are
  served by the existing `try_files $uri $uri/ /index.html`; `/upload`,
  `/files/` and `/public-files/` already have their Nginx blocks. The first
  thing that will need the runbook touched is C0's mail provider. Do not add
  Nginx config speculatively.
- **Postgres version drift:** `docker-compose.yml` pins 16, some development has
  run against a local 14. Nothing needs 15+ yet. If you add something that does
  (`MERGE`, `NULLS NOT DISTINCT`, multirange types), say so out loud.

---

## Files

| File | Stage | |
|---|---|---|
| [`defects-found.md`](defects-found.md) | ten found; nine fixed, one debt | closed ledger |
| [`V1b.md`](V1b.md) | the draft, made readable — API only | ✔ built |
| [`F2.md`](F2.md) | the staff shell at `/desk` | ✔ built |
| [`V2.md`](V2.md) | admin contract workspace | ✔ built |
| [`V3.md`](V3.md) | customer revised-banner and re-approval | ✔ built |
| [`V4.md`](V4.md) | admin overview and review queue | ✔ built |
| [`tagline.md`](tagline.md) | tagline, hero and descriptor — the brand copy pass | ✔ done |
| [`R1.md`](R1.md) | Library — model and admin entry editor | ✔ built |
| [`R2.md`](R2.md) | Library — public reader, list and search | ✔ built |
| [`C1.md`](C1.md) | Review Room — documents, snapshots, the corpus | ✔ built |
| [`C2.md`](C2.md) | Review Room — comments, threads, corpus admin | ✔ built |
| [`R4.md`](R4.md) | Library — the agent | ✔ built |
| [`R3.md`](R3.md) | Library — the concept tree | ready · **conditional** |
| [`persian-pass.md`](persian-pass.md) | the Persian pass | §1 ✔ 2026-08-14 · §2/§3 open |
| [`later-tracks.md`](later-tracks.md) | retired — every section superseded | archive |

**The built stage files are kept as written**, not rewritten to match what
shipped. They are the plan the build was measured against, and their value now
is in the places the build disagreed with them — the build plan's per-stage
"what this settled" notes record those. A stage file edited to match its own
outcome cannot teach anything about planning.
