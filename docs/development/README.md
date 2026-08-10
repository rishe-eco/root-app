# Development plan — how the remaining stages get built

**Written:** 2026-08-05 · **Revised 2026-08-10** · Against `root-app` @
`stage-v4-overview` + uncommitted brand-copy work
**For:** the engineer picking up the next stage. Read this file, then read *only*
your stage's file. They are written to be self-contained.

> **Track V is complete.** V1b, F2, V2, V3, V4 and C0 are built, and the brand
> copy pass ([`tagline.md`](tagline.md)) closed on 2026-08-10.
> **R1 is next** — [`R1.md`](R1.md). One thing comes before it: **merging the
> chain**, below.

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
──────────────────────────────── everything below is unbuilt ────────
     the tagline + hero          ✔ 2026-08-10             [tagline.md]
R1   Library model + editor      ← next, build-ready            [R1.md]
R2   public reader + search      ┐
R3   concept tree                │  outlined only, not yet
C1   Review Room corpus          ├─ specified to build depth [later-tracks.md]
C2   Review Room comments        │
R4   the agent                   ┘
the Persian pass
```

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
| [`R1.md`](R1.md) | Library — model and admin entry editor | **next** |
| [`later-tracks.md`](later-tracks.md) | R2–R4, C1–C2 — outline and banked traps | |

**The built stage files are kept as written**, not rewritten to match what
shipped. They are the plan the build was measured against, and their value now
is in the places the build disagreed with them — the build plan's per-stage
"what this settled" notes record those. A stage file edited to match its own
outcome cannot teach anything about planning.
