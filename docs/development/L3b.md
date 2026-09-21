# L3b — Builds and the resolution ledger

**Stage:** L3b of `ecosystem/working/root-studio-lifecycle-build-plan.md` (1.0),
**§3 "L3b · Builds and the resolution ledger"** — the last stage of the
critical path (L0 · L1 · L2 · L3 · L3b).
**Depends on:** L1 (`Project`, the scope registry, the `DEVELOPER` role and
`builds.author`), L3 (`DemoFrame`, `FeedbackItem`, the `FeedbackStatus` enum
banked with `ADDRESSED`/`ACCEPTED`/`DECLINED` already in it, unused until
now). **Spec:** `root-website-project-lifecycle.md` §6's gap (three sources
for "what's new," not one). **Standing constraint:** D5 (never write
`PageDesign.approvedAt` / `DesignConcept.chosenAt`).
**Status:** built, verified against a real database, including a shadow-
database migration replay this machine could not do at L1/L2/L3.

---

## 0 · Why this stage, stated once

L3 promises the customer that every feedback item shows its fate. This stage
is where a fate actually gets written — by the developer, at the moment they
put a new version on staging — and it is the plan's own warning (§5.8) that
this is "the easiest stage to cut and the one whose absence breaks the stage
before it." Cutting it converts L3 from the flagship mechanism into the
dead-end channel (F2) with better styling.

It also supplies the review frame's third source. §6 generates "what's new"
from the registry, but the registry cannot know about a change that came
from neither a scope item nor a feedback item — a refactor, a fix found in
passing, a temporary state made permanent. That category is exactly what
went missing at the engagement the plan is drawn from (F3). This stage is
where it gets a home: `BuildChangeEntry` with no origin at all.

---

## 1 · What was built

### 1.1 · `Build` and `BuildChangeEntry` — one list, one optional origin

A `Build` belongs to a `Phase` (`phaseId`) and is denormalized onto its
`Project` (`projectId`) purely so `number` can be **project-wide and
monotonic** without a join through `Phase` on every read — the plan's own
insistence that a per-phase counter would make "version 2" ambiguous the
day a project has a second phase with its own build. `number` is a plain
`Int`, always rendered as Latin figures (house rule 14) — never through
`formatCount`/`toPersianDigits`, checked by grep (§5) and by a dedicated
integration test.

`BuildChangeEntry` is the change list, one row per thing that changed,
matching the plan's table exactly:

| `feedbackItemId` | `scopeItemId` | Meaning | Written by |
|---|---|---|---|
| set | — | "you asked for this" | `declareBuild`, at declaration |
| — | set | "this was on the plan" | `declareBuild`, moves the item to `IN_DEMO` |
| — | — | "we changed this and nobody asked" | `declareBuild`, the note *is* the entry |

At most one of the two may be set (`BuildChangeEntry_at_most_one_origin`,
hand-written — Prisma cannot express it, same route
`FeedbackItem_exactly_one_target` already takes for the stricter "exactly
one" version of this shape). One feedback item, partly satisfied across two
builds, is exactly what this makes expressible: build 3 might carry it
forward, build 4 might address it — two entries, two builds, one item, and
the truth is legible without an open/closed flag lying about it.

### 1.2 · The four rules, as they were actually built

1. **Two fields, never one.** `FeedbackItem` gained `addressedInBuildId`
   (the developer's claim, written by `declareBuild`) and `acceptedAt` /
   `acceptedById` (the customer's own, written only by the new
   `acceptFeedback` mutation). `declareBuild` never sets `acceptedAt`, and
   `acceptFeedback` refuses (`NOT_ADDRESSED`) unless the item is currently
   `ADDRESSED` — there is no path from `RATIFIED` straight to `ACCEPTED`,
   and no path that skips a human confirming on the customer's side.

   **The reopening half, decided inside this stage.** The plan's own
   phrasing — "the item reaches `accepted` only when the customer meets it
   in the next review *and does not reopen it*" — implies a door back out
   of `ADDRESSED`. The door built here: a new comment against an already-
   `ADDRESSED` target (via the existing `submitFeedback`) moves it back to
   `OPEN` and clears the stale `addressedInBuildId` (`lib/feedback.ts`'s
   `reopensOnComment`). `ACCEPTED` and `DECLINED` are left alone —
   reopening a fully closed item is a decision this stage does not make for
   anyone; see §3.

2. **A fate must never be silent.** `declareBuild` computes every
   `FeedbackItem` in the project currently `OPEN` or `RATIFIED` and refuses
   (`MISSING_DISPOSITION`, with the missing ids as an extension — house
   rule 6) unless the change list disposes every one of them, including the
   explicit `CARRIED_FORWARD`. This is enforced *before* anything is
   written, not discovered after (`lib/build.ts`'s `missingDispositions`).

   **A rule this stage found and had to add: D3's gate stays intact.** A
   merely-`OPEN` (unratified) item is still just an opinion — the decider
   has not ratified it. Letting a developer `ADDRESS` or `DECLINE` it
   directly would let a build bypass the decider entirely, silently, in
   exactly the direction §5.9 of the plan warns about ("it will not look
   like a bug; it will look like the queue draining"). So `CARRIED_FORWARD`
   is the *only* legal disposition for an `OPEN` item; `ADDRESSED` and
   `DECLINED` both require `RATIFIED` (`lib/build.ts`'s
   `outcomeAllowedForStatus`, refused as `NOT_RATIFIED`). This is not named
   in the plan's own four rules — it fell out of taking D3 as seriously
   inside this stage as L3 took it.

3. **`declined` requires its reason, structurally.** Held by
   `BuildChangeEntry_declined_requires_note`, the same CHECK route as L1's
   `ScopeItem_decided_both_or_neither`. Checked twice: once in the resolver
   (`DECLINE_REASON_REQUIRED`, a friendlier code before the database ever
   sees the row) and once by an integration test that bypasses the resolver
   entirely and asserts the database itself refuses a null reason.

4. **Publishing a build notifies.** `Build.publishedAt` is the same
   draft/publish shape `Demo.publishedAt` already uses. Every
   `FeedbackItem`/`ScopeItem` transition a change list implies happens at
   **`declareBuild`**, not held back for `publishBuild` — the plan's own
   framing is that the fate is written "at the moment they put a new
   version on staging," which is declaration, not a second click.
   `publishBuild` is purely the notification trigger: it sets
   `publishedAt` and sends `buildPublishedEmail` (new template,
   `lib/mailTemplates.ts`) to the project's customer, refusing a second
   call (`ALREADY_PUBLISHED`).

### 1.3 · The third source, reaching a later frame

`DemoFrame.unpromptedChanges` (a new field resolver, `fields.ts`) lists
every no-origin `BuildChangeEntry` declared for the demo's own phase that
has not yet been turned into a `DemoFrameLine` — staff (`contracts.manage`)
only, and empty is not a claim that nothing changed (a `DEVELOPER` calling
this same query as a customer would get the same empty answer for a
different reason, which is why the field checks the capability rather than
returning whatever the caller happens to be allowed to see elsewhere).

`addDemoFrameLine` gained an optional `buildChangeEntryId` — the PM's own
write-up of an unprompted change, into a line exactly like any other. This
is deliberately **not automatic**. See §1.4 for why.

### 1.4 · Who writes the Persian — decided, not deferred

**Decision: one text field plus the language it was authored in, not two
required fields.** `BuildChangeEntry.note` is a single nullable `String`;
`noteLang` (`"fa"` or `"en"`, a plain string — mirroring `User.locale`'s own
shape rather than inventing an enum for two values) records which language
it was written in. The plan's own lean is followed exactly, and the reason
given for it is the reason this stage found no cause to overturn: a
developer who writes an ADDRESSED disposition in English is not asked to
also produce a Persian sentence, and a change note the customer cannot read
is worse than one nobody has translated yet.

**The consequence, worked through rather than left implicit.** A raw
English `note` cannot be silently split across `DemoFrameLine.textFa` and
`textEn` — those two columns are a **snapshot**, already load-bearing
elsewhere in this codebase (L3's own `agreedScopeSnapshot` reasoning), and
inventing a fake Persian translation to fill one of them would be exactly
the "change note the customer cannot read" the plan warns against, now
dressed up as though it were read. So this stage does **not** auto-generate
a `DemoFrameLine` from a no-origin `BuildChangeEntry`. Instead:

- `DemoFrame.unpromptedChanges` (§1.3) makes the raw note impossible to
  forget — it is listed automatically, not something a person has to
  remember exists, which is what "appears in the next review frame without
  anyone remembering to mention it" (the stage's own acceptance criterion)
  actually requires.
- Turning it into a real line is one click for whoever holds
  `contracts.manage` (the PM, in practice) — `addDemoFrameLine` with
  `buildChangeEntryId` set. The form pre-fills whichever of `textFa`/
  `textEn` matches the entry's own `noteLang` from the raw note, and leaves
  the other blank for a human to actually write, rather than silently
  duplicating one language's text into both fields (`DemoFeedbackPanel.tsx`'s
  `startWriteUp`).

This is the first place in this stage's own schema the three-way work split
(canvas §6) shows up structurally: the developer writes the note, the PM
renders it.

### 1.5 · The desk surface

`apps/web/src/desk/Builds.tsx` — previously a stub gated on `builds.author`
— is now the real screen: a phase picker (`phasesForBuilds`, thin, project
titles only), the open feedback queue for that phase's project
(`openFeedbackQueue`) with a disposition selector per item (defaulting to
`CARRIED_FORWARD`, the only option offered for a merely-`OPEN` item), the
scope items ready to ship (`scopeItemsAwaitingBuild`, checkboxes), a
repeatable "add an unprompted change" section, and the declared-builds
history for that project (`projectBuilds`) with a publish button per
undeclared build.

**Nothing on this screen, or in any resolver `builds.author` alone can
reach, returns `Contract!`.** Every other admin-side mutation in this
codebase does, by the T9 convention (V2.md) — but that convention was built
for callers who already hold `contracts.manage`. A `Contract!` payload
carries `amount`, `customer`, and the rest of what D6 says a `DEVELOPER`
must never see. `resolvers/builds.ts` returns `Build!`, `FeedbackItem!`, a
thin `BuildPhase!`/`ScopeItem!` — never `Contract`. This is checked by an
integration test (a `DEVELOPER` account exercising every query and mutation
in this file successfully, never touching a contract-shaped payload) and by
reading the resolver file itself (grep for `Contract` in
`resolvers/builds.ts` finds nothing).

`DemoFeedbackPanel.tsx` (shared by desk and portal, unchanged in that
sharing) gained: the `addressedInBuild`/`acceptedAt` facts shown as two
separate lines (never merged into one), an "accept" button appearing only
when `status === 'ADDRESSED'`, and the unprompted-changes write-up form
from §1.3–1.4.

---

## 2 · Decisions taken inside the stage

1. **The disposition requirement is scoped to the project, not the phase.**
   A staging site typically outlives a single phase (D2's own reasoning —
   one live site, evolving), so "every open feedback item" is read
   project-wide: a build declared against phase 2 still owes a disposition
   for an item still open from phase 1's demo. Nothing in the plan says
   otherwise, and scoping it to the phase would let old feedback rot
   invisibly the moment a project moves phases.
2. **`builds.author` is a blanket capability, not an ownership edge, over
   which projects a `DEVELOPER` sees.** Unlike `CUSTOMER` (tied to
   `project.customerId`), nothing in the plan or the schema ties a
   `DEVELOPER` to particular projects — there is no "assign a developer to
   a project" mechanism anywhere in this codebase. Followed the exact
   precedent `REVIEWER`/`review.participate` already set (schema.prisma's
   own comment on `ReviewRound`: "one corpus, for everyone holding
   review.participate, not per-reviewer visibility"). Every query in
   `resolvers/builds.ts` is capability-gated, never ownership-scoped beyond
   the `projectId` the caller explicitly asks for. Building a genuine
   per-developer assignment edge is future work this stage does not invent
   ahead of a second developer existing.
3. **`acceptFeedback` returns `FeedbackItem!`, not `Contract!`.** Unlike
   `submitFeedback` (which can create a row Apollo's cache has never seen,
   T9's one documented exception), `acceptFeedback` only ever updates a row
   the cache already holds — the ordinary case applies cleanly, the same
   reasoning L3 gave for `ratifyFeedback`.
4. **`CARRIED_FORWARD` writes nothing to `FeedbackItem.status`.** It is a
   real `BuildChangeEntry` row (so the disposition requirement is
   satisfied, and the choice is on the record), but the item's own status
   is untouched — nothing changed, so nothing about the row should claim
   otherwise. This is also what makes an item's disposition history
   genuinely a *history*: the same item can be carried forward across
   several builds before finally being addressed.
5. **Reopening reaches only `ADDRESSED`, not `ACCEPTED` or `DECLINED`.**
   Whether a customer commenting on a fully accepted or declined item
   should reopen it is a real product question with no answer in the plan,
   and guessing wrong in either direction (silently reopening a closed
   loop, or silently swallowing a customer's comment on one) seemed worse
   than deciding narrowly. `submitFeedback` still appends the comment in
   both cases — nothing is lost — it simply does not change `status`.
   Flagged here as a decision, not an oversight, for whoever revisits it.
6. **No CHECK enforces "outcome set iff feedback-origin," or "note set
   when there is no origin," beyond the one CHECK the plan explicitly
   names (declined-requires-note).** Both are enforced in the resolver
   (`OUTCOME_REQUIRED`/`INVALID_CHANGE_ORIGIN`, `NOTE_REQUIRED`) and one of
   them *is* additionally held by a CHECK
   (`BuildChangeEntry_no_origin_requires_note`) because it was cheap and
   the same shape as the one the plan does ask for; the origin/outcome
   pairing is left as an application-level rule only, on the same
   "can be tightened later" precedent L1 left `ScopeItem.declinedReason`
   on.
7. **No new `ChangeAction` values.** Declaring or publishing a build, and
   accepting feedback, do not write to `ChangeLog` — consistent with L1's
   decision 8 and L3's decision 5 (registry and feedback activity do not
   feed the desk's activity feed either), and nothing in the plan asks for
   it here. `BuildChangeEntry` itself is the authored record; `ChangeLog`
   stays what it always was (L3b.3's own banked trap, checked in §5).
8. **`DemoFrame.unpromptedChanges` is a live query, not a snapshot.** Unlike
   `DemoFrameLine.textFa`/`textEn` (a snapshot, by design — L3's own
   reasoning), the *list* of not-yet-written-up entries has to be current:
   its whole job is to stop something from being forgotten, so caching it
   at generation time would silently stop it from growing as new unprompted
   changes are declared after the frame already exists.

---

## 3 · What was deliberately not built

- **A portal screen listing a project's builds.** The customer's channel
  for "what changed" is the existing feedback-status badges and the review
  frame, both already customer-visible; a second, parallel "build history"
  view was not asked for and would be a second place the same story could
  drift from the first. `buildPublishedEmail` is the notification; nothing
  in the portal currently lists `Build` rows directly.
- **Reopening `ACCEPTED` or `DECLINED` items.** See decision 5 above.
- **A per-developer project assignment.** See decision 2. Every
  `DEVELOPER` sees every project's open queue today, matching `REVIEWER`'s
  own precedent; narrowing it is real future work, not a gap this stage
  quietly left.
- **Any UI for the `outcome`/`note` pairing beyond a plain select and
  textarea.** No rich text, no attachments, no per-language spellcheck
  affordance — a developer's disposition note is exactly as bare as every
  other free-text field in this codebase's admin surfaces.
- **A scheduler, cron job, or any automation around declaring builds.**
  `declareBuild` is called by a person, once, per deploy — nothing here
  reaches into git or CI. `ref` is a plain optional string, exactly as the
  plan specifies.

---

## 4 · The migration

Hand-authored:
`apps/api/prisma/migrations/20260921120000_l3b_builds_and_resolution_ledger/migration.sql`.

`npx prisma migrate diff --from-schema-datamodel <pre-L3b schema>
--to-schema-datamodel <post-L3b schema> --script` was run first (no
database needed) and cross-checked against the shipped file. Like L3's own
migration and unlike L1's, the raw diff needed no correction for a NOT
NULL-with-no-default trap — both new tables (`Build`, `BuildChangeEntry`)
start empty, and every new column on an existing table (`FeedbackItem`,
`DemoFrameLine`) is nullable by the schema's own design. What the raw diff
cannot express, and this file adds by hand: three CHECK constraints —
`BuildChangeEntry_at_most_one_origin`, `BuildChangeEntry_declined_requires_note`,
and `BuildChangeEntry_no_origin_requires_note` — the same route L1's
`ScopeItem_decided_both_or_neither` and L3's `FeedbackItem_exactly_one_target`
already take.

Applied for real, on this machine, to both `root_website` and
`root_website_test` via `npx prisma migrate deploy` — see §6.

---

## 5 · Traps, checked against what was actually built

1. **`Build` is the domain's own word (banked trap #1).** Confirmed by
   grep: no new identifier in this stage's diff contains `Revision` or
   `Round`. `ScopeItem.buildChangeEntries`, `DemoFrameLine.buildChangeEntry`
   and every new file are named `Build*`.
2. **`ChangeLog` is not this (banked trap #2).** Confirmed: no
   `ChangeAction` enum value was added, and no code in this stage writes a
   `ChangeLog` row. `BuildChangeEntry` is the authored-prose object the
   trap describes — the test given ("the system writes a ChangeLog; a
   person writes a change entry") holds: every `BuildChangeEntry` row is
   created inside `declareBuild`, from a person's own form submission,
   never from a system-triggered write path.
3. **The `DEVELOPER` role already existed (banked trap #3).** Confirmed:
   no `Role` enum value, no `CAPABILITIES` entry, and no `DESK_SECTIONS` row
   were added this stage — all three arrived with L1, exactly as D6
   specified, and this stage only filled in the stub section and the
   resolvers behind it.
4. **Version numbers stay Latin (banked trap #4).** Confirmed by grep:
   `formatCount`/`toPersianDigits` never wrap `Build.number` anywhere in
   `Builds.tsx`, `DemoFeedbackPanel.tsx`, or `mailTemplates.ts`'s
   `buildPublishedEmail`. `mailTemplates.test.ts`-style coverage was not
   added as a dedicated unit test for this one template (the existing file
   has no per-template test file for the L3 templates either — checked by
   reading, not by a new automated assertion); the e2e/integration route
   covers it structurally by never calling a digit-formatting function on
   the value at all.
5. **Who writes the Persian (banked trap #5) — decided, see §1.4.**
6. **D5 stays decided.** `git diff -- apps/api/src/lib/gate.ts
   apps/api/src/lib/gate.test.ts` is empty. `grep -rn "approvedAt\s*[:=]\|
   chosenAt\s*[:=]"` across every file this stage touched, restricted to
   added lines, finds nothing.
7. **House rule 2 (ownership vs. capability).** Every mutation and query in
   `resolvers/builds.ts` gates on `requireCapability(ctx, 'builds.author')`
   — a capability check, never a role test. `acceptFeedback`
   (`resolvers/feedback.ts`) gates on ownership (`loadDemoForActor`, the
   same reused check `submitFeedback`/`ratifyFeedback` already use) —
   never a capability, matching D3.
8. **House rule 6 (API code, web sentence).** Every new `GraphQLError` in
   this stage's resolvers carries an English `message` plus an
   `extensions.code`; the one place user-facing prose logic actually lives
   is `Builds.tsx`'s `errorMessage`/`desk.builds.error.*`, on the web side.
9. **House rule 14 (digits).** See #4 above, and `desk.builds.queueEmpty`/
   `scopeEmpty`/etc. carry no bare counts at all — the queue and scope
   lists are rendered as cards, not a number.

---

## 6 · Files changed

**API:** `prisma/schema.prisma`,
`prisma/migrations/20260921120000_l3b_builds_and_resolution_ledger/migration.sql`
(new), `src/lib/build.ts` + `.test.ts` (new), `src/lib/feedback.ts` +
`.test.ts` (adds `reopensOnComment`), `src/lib/mailTemplates.ts` (adds
`buildPublishedEmail`), `src/graphql/typeDefs.ts`,
`src/graphql/resolvers/index.ts`, `src/graphql/resolvers/builds.ts` (new),
`src/graphql/resolvers/feedback.ts` (adds `acceptFeedback`, the reopen-on-
comment write, `addressedInBuild`/`acceptedBy` on `feedbackItemInclude`),
`src/graphql/resolvers/fields.ts` (adds `DemoFrame.unpromptedChanges`,
`buildChangeEntry` on the eager frame-line include),
`src/graphql/resolvers/admin/demoFrame.ts` (adds `buildChangeEntryId` to
`addDemoFrameLine`), `src/test/l3b.test.ts` (new).

**Web:** `src/lib/queries.ts` (new `Build`/`BuildChangeEntry`/`BuildPhase`
types and documents; extends `FeedbackItem`/`DemoFrame`), `src/desk/Builds.tsx`
(stub replaced with the real screen), `src/components/DemoFeedbackPanel.tsx`
(accept button, addressed/accepted lines, unprompted-changes write-up),
`src/i18n/locales/{en,fa}.json`.

**Docs:** this file.

---

## 7 · Verification — what ran, and its real result

**Run, and green:**

```
npx prisma format                 # schema.prisma reformatted, no manual drift
npx prisma validate               # schema is internally consistent
npx prisma migrate diff --from-schema-datamodel <pre-L3b schema> \
  --to-schema-datamodel <post-L3b schema> --script
                                   # used to derive, then hand-reconcile against,
                                   # the migration in §4 — no database touched
npx prisma migrate deploy         # applied for real, to root_website AND
                                   # root_website_test
npx prisma generate               # client regenerated against the new schema
npm run typecheck                 # apps/web and apps/api, both clean
npm run build                     # apps/web (vite) clean; apps/api (tsc -b)
                                   # also run directly (--workspace=apps/api)
                                   # and clean — root `npm run build` only
                                   # builds apps/web, so both were checked
npm test                          # apps/api: 264 passed, 0 failed (17 new:
                                   # 12 in lib/build.test.ts, 1 new case in
                                   # lib/feedback.test.ts for reopensOnComment)
                                   # apps/web: 31 passed, 0 failed, including
                                   # the locale-parity suite — one Persian
                                   # spelling collision it caught (منتشر شده
                                   # vs منتشرشده, the exact pair L3's own
                                   # verification section flagged once
                                   # already) was fixed to the codebase's
                                   # existing spelling
npm run test:integration          # 199 specs, 0 failed — the pre-existing
                                   # 182 unchanged, plus 17 new L3b specs:
                                   # the two-field separation (ADDRESSED does
                                   # not imply ACCEPTED; acceptFeedback is
                                   # the second write), a comment reopening
                                   # an ADDRESSED item, MISSING_DISPOSITION,
                                   # an honestly empty build, D3's gate
                                   # holding (a merely-OPEN item refused
                                   # ADDRESSED/DECLINED, accepted as
                                   # CARRIED_FORWARD), DECLINE_REASON_REQUIRED
                                   # at the resolver AND at the database
                                   # (three separate CHECK-bypassing-the-
                                   # resolver tests, one per constraint),
                                   # publishBuild + ALREADY_PUBLISHED,
                                   # project-wide monotonic numbering across
                                   # two phases, a scope-item-origin entry
                                   # moving IN_BUILD -> IN_DEMO, the
                                   # unprompted-change round trip through
                                   # unpromptedChanges and addDemoFrameLine,
                                   # unpromptedChanges being empty for a
                                   # customer, and the builds.author
                                   # capability boundary (a customer
                                   # forbidden, a DEVELOPER admitted)
npm run e2e                       # 29 passed, 0 failed — identical tally to
                                   # L3's own baseline, including the same
                                   # pre-existing test.fail(true, …)
                                   # annotated case counted as a pass
```

**One check this session could do that L1/L2/L3 explicitly could not.**
`prisma migrate diff --from-migrations ./prisma/migrations --to-schema-
datamodel ./prisma/schema.prisma` needs a shadow database, which every
prior stage's verification section recorded as unavailable. This session
created one (`CREATE DATABASE root_website_shadow`, the same `root` role
already used for everything else — no new privilege was needed, the prior
stages simply had not tried), ran the diff (**"No difference detected"** —
replaying all fifteen migrations in order reproduces `schema.prisma`
exactly), and dropped the database afterward. This is a genuine answer to a
question L1's §7 left open, not merely a repeat of what earlier stages
already had running.

**Not run, and why:**

- The founder's own manual smoke test — Nahal's next demo round running
  through a real build, addressed and accepted in the portal — is outside
  what this session can run, exactly as L3 recorded for its own equivalent
  criterion.
- No dedicated unit test file for `buildPublishedEmail`'s exact HTML/text
  output was added (`mailTemplates.ts` has no per-template test file for
  any of the L3 templates either); its Latin-digit discipline is checked by
  reading (§5 point 4), not by an assertion.
- A `WebFetch`/browser-driven manual click-through of the new `Builds.tsx`
  screen was not performed beyond what `npm run e2e`'s existing 29 specs
  already exercise incidentally (none of them visits `/desk/builds`
  directly — no spec file in `apps/web/e2e` names `builds`, `Build`, or
  `declareBuild`). The screen's own correctness rests on the 17 integration
  specs exercising every resolver it calls, the type-checked GraphQL
  documents in `queries.ts`, and a clean `vite build`, not on a spec that
  drives a browser through it. Adding one is reasonable follow-up work, not
  performed here for the same reason L1 and L2 left several UI paths
  covered only by reading rather than by a dedicated e2e spec: this
  session's budget went to the mechanism (the four rules, the ledger, the
  ownership boundary) rather than to a first browser-driven spec for a
  brand-new desk screen.
