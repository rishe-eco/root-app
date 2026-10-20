# NR1 — the "Waiting on Root" tile counts what Root owes

**Built:** 2026-10-20 · **Change note:** `root-sot/ecosystem/modules/01-root-studio-journeys/changes/02-change-needs-root-tile.md` §NR1 (wp-dashboards #2) · **Card:** `briefs/NR1.md` in that module folder
**Branch:** `nr1-needs-root-tile` from `main @ 1ddf5d0`. Built by a Sonnet lane (`8182e38` tests, `5dac6fc` code), reviewed by Opus (`a38c8c9` → this record). No migration, no new environment variable, no new string.

The Overview's six status tiles counted `Contract.status`, what sales *set*. The Needs-Root box beside them has been read from the attention module since J12: a contract is in it because Root owes something on it. So the "Waiting on Root" tile and the box could disagree, and on the e2e data they did (0 against 2). The tile now reads `needsRootCount`, which is the box's rule, uncapped. The other tiles still count status.

## Built

- **`apps/api/src/graphql/resolvers/home.ts`:** an unexported `loadNeedsRoot(user)`, the one load-and-filter (`loadHomeContracts({ status: { not: 'DISCARDED' }, deliveredAt: null }, now)`, then `needsRoot(user, …)`). `needsRootQueue` calls it and still slices with `clampLimit(limit, 20, 100)`. The new `needsRootCount` calls it and returns the length, unsliced. Both are `contracts.readAll`.
- **`apps/api/src/graphql/typeDefs.ts`:** `needsRootCount: Int!` on `Query`, documented beside the queue. `resolvers/index.ts` only gains a comment: `homeQueries` is already spread into `Query`.
- **`apps/web/src/lib/queries.ts`:** `NEEDS_ROOT_COUNT`.
- **`apps/web/src/desk/Overview.tsx`:** inside the existing `ALL_STATUSES` map, the `WAITING_ON_ROOT` tile reads `needsRootCount` (`skip: !allowed`, 0 until it lands, through `formatCount`). Each `.tile` gains `data-status`. The doc comment says which tile reads what.
- **Tests:** three in `apps/api/src/test/j12.test.ts` (NR-1 + NR-2, NR-4, NR-5), and NR-3 + NR-6 added to `25-home.spec.ts`'s sales Overview test.
- **`apps/api/prisma/test-integration.ts`, `test-unit.ts`** *(review, test tooling; lane report 5.1)*: `npm run test:integration -- <files>` and `npm test --workspace=apps/api -- <files>` now run only the files named (paths relative to `apps/api`). Before, both ignored their arguments and ran every file, though `CLAUDE.md` and `config.md` §3 say they filter. With no arguments, both run the whole suite, as CI calls them. Each argument must be a plain path (`[\w./-]+`), because the command goes through a shell: `'x;echo PWNED'` is refused with exit 2.

## Decided

| # | Call | Made by | Verdict | Why |
|---|---|---|---|---|
| 1 | `loadNeedsRoot` returns `{ contracts, owed }` | lane | accepted | The queue looks each owed contract up by id to build its row; the count ignores `contracts`. One load, one filter, as the trap asks. |
| 2 | The e2e reads the row count first, then expects the tile to equal it (auto-retrying), and the Persian tile the same number in Persian digits | lane | accepted, with a limit | The row count is read after the wizard row is visible, so the queue has landed. The equality holds while the e2e data owes on 20 contracts or fewer (the queue's default limit). It owes on 2. |
| 3 | NR-5's test also asserts that sales gets a number | lane | accepted | It pins that the refusal is the capability's, not a broken field. |
| 4 | NR-5's test sits in `j12.test.ts`; `v4.test.ts` unchanged | card | accepted | |
| 5 | The e2e uses the existing `beforeEach` reset and `submitFeedback`, with no new seed rows | card | accepted | |
| 6 | NR-6 compares the Persian tile with the English number, mapped to `۰`–`۹` | card | accepted | `formatCount` is the source; the check pins that the new value still goes through it. |
| 7 | Fix the API test runners' file filter on this branch | review | **review's call** | Test tooling, a defect-only change (the documented behaviour), and no change when called with no arguments. It made this review's targeted runs possible without the lane's untracked copy of the runner. |
| 8 | `02-contract-flow`'s V4 test resets before it reads the tiles (`085aa1a`) | review | **review's call** | NR1 meant the tile to follow attention, so the test's premise is what broke, not the code. On the fresh seed the sum is carried by `RC-2026-014` (`WAITING_ON_CUSTOMER`). It adds one reset, about 10 s. |
| 9 | `expireMockupGrants` (e2e helper) writes `(now() AT TIME ZONE 'UTC') - 1 min` (`d425139`) | review | **review's call** | Found by the full e2e: `22-mockup-host`'s expired-grant test got 200, every time with the file alone. Prisma stores `timestamp(3)` in UTC, but a bare `now()` is the server's local time, and this machine's native Postgres is `Asia/Tehran`, so the "expired" grant ran 3.5 h ahead. Not NR1's; environmental, so fixed in the test setup. The helper's other `now()`s only stamp `createdAt`, where the skew is harmless. |

**The lane report's part 5, answered:**
1. **The runners ignored file arguments.** True (`test-integration.ts` hard-coded `src/test/*.test.ts`; `test-unit.ts` `src/lib/*.test.ts`). Fixed at this review (Decided #7). `apps/web`'s `npm test` still appends the file to its glob (`tsx --test src/lib/*.test.ts <file>`), so it runs everything: harmless, and left alone.
2. **NR-3 is seen failing on `main`, and why.** The seed's `RC-2026-021` is `WAITING_ON_ROOT` by status, but it is the wizard contract, and `25-home`'s sales test signs it first (`approveAndSignViaApi`), which moves it to `IN_PROGRESS`. Checked in the slot's database after the run: `RC-2026-014 WAITING_ON_CUSTOMER`, `RC-2026-021 IN_PROGRESS`. So the old tile counted 0, while both contracts owe Root something (2 rows). The card's question, whether the seed's `WAITING_ON_ROOT` contract owes anything, is answered: on a fresh seed it owes nothing (see *02-contract-flow* below).
3. **A first j12 run had every test failing** while a killed duplicate run was still on the database. Not a code issue; the runner fix above removes the reason it happened.

**The card's open check: what keeps `02-contract-flow`'s "non-zero count" above zero.** Printed at this review, run alone (the file's `beforeAll` resets, so it sees the fresh seed): `DRAFT 0 · WAITING_ON_CUSTOMER 1 · WAITING_ON_ROOT 0 · IN_PROGRESS 0 · FINAL_REVIEW 0 · DONE 0 · DISCARDED 0`. The sum is carried by `RC-2026-014` (`WAITING_ON_CUSTOMER`). Before NR1 the "Waiting on Root" tile added 1 for `RC-2026-021` by status alone; now it adds 0, because on the fresh seed that contract owes nothing. The test keeps its meaning (the tiles render real counts). **But not after the file's flow**, which the full e2e run showed: the run of the whole file left `RC-2026-014` and `RC-2026-021` both `WAITING_ON_ROOT` by status, with neither owing Root anything, so every tile read 0 (`Expected: > 0, Received: 0`; on `main` the tile counted the 2 by status). Reproduced with the file alone, then fixed at this review: the test now resets first (Decided #8), and the file is green.

## Owed

- **The desk scrolls sideways at 360 px, on every desk page.** Below 720 px `desk.css` turns `.desk-side` and `.desk-nav` into a row, and the nav's ten links don't wrap: `.desk-nav` is 879 px wide in Persian and 1027 px in English, so the page is 1135 px / 1276 px wide in a 360 px viewport. The content column itself fits (`.desk-section` 32–328 px). In Persian the viewport screenshot at 360 px shows only the background. Measured on `/fa/desk/overview`, `/fa/desk/work` and `/en/desk/work`. NR1 changed no CSS; it fails the checklist's §5 360 px rule for the whole desk. Not assigned to a stage. Also in open-work.
- **The live check after the deploy**, founder's: on the live desk as sales, the "Waiting on Root" tile equals the number of rows in the Needs Root box (both 0 when the box is empty, and the tile larger only if the box is at its 20-row limit). Past the verification ceiling (open-work).

## Flagged for close-out

- **wp-dashboards #3** (the tiles linking to the contracts list): the "Waiting on Root" tile now counts something the list's status filter doesn't. The e2e data shows how far apart they can be: two contracts `WAITING_ON_ROOT` by status, with their activity rows badged "Waiting on Root", while the tile and the box say 0. The note already defers it to #3; the spec's tile wording should say the tile follows attention.
- **The API (`typeDefs`)** gains `needsRootCount`. The module's spec or API notes, where they list the J12 staff queries, should name it beside `needsRootQueue`.
- **`CLAUDE.md` and `config.md` §3** say the test runners filter by file. They now do; nothing to change there, but `brief-common.md` or the next card no longer needs a workaround.
- **Two loads per Overview.** The queue and the count each run `loadHomeContracts` over every live contract. That is fine at today's volume; if the desk gets slow, one query returning both is the change. Not a defect.
- No data model or glossary change.

## Verification

**Machine:** the founder's Linux machine, Chrome (`config.md` §2), slot A (`root_wt_a_test`, API 4201, web 4273), ports checked free before each e2e run. Native Postgres, no Docker. Base `main @ 1ddf5d0`, which hasn't moved since the lane started (`origin/main` fetched): nothing to merge.

**Seen red first:**
- NR-1, NR-2, NR-4, NR-5: by the lane, on `8182e38` ("Cannot query field needsRootCount"), 16 pass / 3 fail.
- NR-3: by the lane, the sales test against the old `Overview.tsx` with only `data-status` added: `Expected: "2" Received: "0"`. The cause is now known (part 5.2 above).
- No test was added at this review.

**Tests at the review** (branch `a38c8c9` plus this record; app code as the lane left it at `5dac6fc`):
- `npm run typecheck`: clean.
- `apps/api` unit (`npm test --workspace=apps/api`): **1064 pass, 0 fail**. With the new filter, `-- src/lib/home.test.ts` alone: 20 pass.
- `apps/web` unit, including `queriesSchema.test.ts` (which validates `NEEDS_ROOT_COUNT` against `typeDefs`): **335 pass, 0 fail**.
- Integration, `j12.test.ts` alone: **19 pass**; `j12` + `v4` + `s1` (every file naming the queue or the count): **458 pass, 0 fail**.
- e2e `25-home.spec.ts`: **6 passed**. `02-contract-flow.spec.ts -g "non-zero count"`: **1 passed**, with the tiles printed (above).
- e2e `02-contract-flow.spec.ts` whole, after Decided #8: **9 passed** (the keyboard test is `test.fail`, as on `main`). Before it: 8 passed, V4 failed.
- **Full e2e** (`npm run e2e`, 137 tests, at `085aa1a`): **136 passed, 1 failed**: `22-mockup-host` › "an expired grant is a plain 404" (200, not 404). Environmental, not NR1's: fixed at `d425139` (Decided #9), then `22-mockup-host.spec.ts` whole: **7 passed**. The suite was not rerun in full after that one-helper fix. (`02-contract-flow`'s V4 failure, Decided #8, came from an earlier full run that was killed from outside at about test 30.)
- **Full integration** (`npm run test:integration`, at `d425139`): **1244 pass, 1 fail** of 1245. The failure is `j9a`'s "a chunked upload past the cap…": `heap + array buffers grew by 40.0 MB while 59 MB streamed through` (bound 32 MB). `j9a.test.ts` alone, three times: **51 pass, 0 fail** each.
- **Flakes:** `j9a`'s heap bound, under the full suite only (above). First seen here. J9a's record already notes the bound is process-wide and shared with the test client, so other files' garbage counts against it. NR1 touches no upload code. Not fixed on this branch; in open-work.

**Checklist grades:**
- **§1 What must not break:** not applicable. No public resolver, Library, Ask, Review Room, token, gate, header or cookie code is touched (diff stat).
- **§2 House rules:**
  - 1: the count is `requireCapability(ctx, 'contracts.readAll')`; the client branches on `can()` (reading);
  - 3: one rule, one function: `loadNeedsRoot` is the only place the load and `needsRoot` are called for the desk (reading; NR-1 asserts count = queue length);
  - 6: no new strings (diff);
  - 7–8: no CSS (diff);
  - 12–13: `FORBIDDEN` for a designer and a customer, asserted (NR-5). A customer gets `FORBIDDEN`, not `NOT_FOUND`, as for the queue: the field is staff-only and names no row;
  - 14: the count goes through `formatCount`; NR-6 asserts Persian digits;
  - the rest don't apply.
- **§3 Every stage:**
  - scope: inside the note's NR1 and its *Not here*; the runner fix is the review's (Decided #7);
  - defects: none assigned;
  - dependencies: none;
  - migrations: none;
  - fixture dates: the new fixtures use `new Date()` for `publishedAt` and `deliveredAt`, no future dates (reading);
  - lane item 5: answered above;
  - probes: `loadNeedsRoot` is probed by NR-1's sequence beyond the card's two cases: a third contract owing, a delivered one, a discarded one (by test). The runner's argument check was probed with a shell metacharacter (refused);
  - added tests seen red first: none added;
  - shared rules: the queue's internals changed; every test file naming it (`j12`, `v4`, `25-home`, `02-contract-flow`) was rerun green. `02-contract-flow`'s V4 test was first rerun alone (`-g`), which hid that it fails after the file's flow. The full e2e run caught it, it was reproduced red with the whole file, and it is fixed (Decided #8); the whole file is now green.
- **§4 Guards:** the new resolver checks `contracts.readAll`; it reads no one's rows by ownership (the whole book is the capability's). By test (NR-5). Money and hosts: not applicable.
- **§5 UI:**
  - **Driven in a browser: screenshots, not a window.** Scripted Chrome, **Persian first** (`/fa/desk/overview`), then English, light and dark, at 360 px and 1280 px, measured after `document.fonts.ready`, with the e2e's data (2 contracts owed). Persian: `dir=rtl`, tiles `۰ ۱ ۲ ۱ ۰ ۰ ۰`, "Waiting on Root" `۲` beside 2 rows. English: the same in Latin digits. Screenshots looked at: Persian light at 1280 px, English dark at 1280 px (the tile row unchanged in shape, the number in its place), and Persian light and dark and English light at 360 px (see the 360 px item).
  - **360 px fails on the whole desk** (the nav row, Owed). NR1 didn't cause it. 180 px wasn't run, for the same reason.
  - **Contrast:** no new pair. **One heading:** unchanged. **States:** loading shows 0 until the count lands, as the other tiles do (`02-contract-flow` polls for it). A failed count also shows 0, as a failed status-count query does: the tiles have no error state, before or after NR1.
  - Edge wasn't used: Chrome is this machine's (`config.md` §2), on the condition that the next Windows-machine run uses Edge.
- **§6 Done means:** NR-1 to NR-6, each by a named test; typecheck green; the affected files green; both languages driven; no CHECKs; this record; the README's sequence and files table updated.
- **§7 Verification ceiling:**
  - Persian copy: not applicable (no new strings);
  - screen readers: not applicable (no new control);
  - the live desk check: **owed (after the deploy), founder**;
  - the rest: not applicable.
