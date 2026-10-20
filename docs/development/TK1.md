# TK1 — the Support page refreshes without a reload

**Built:** 2026-10-20 · **Change note:** `root-sot/ecosystem/modules/01-root-studio-journeys/changes/01-change-ticket-refresh.md` §TK1 (wp-dashboards #9, the founder's words) · **Card:** `briefs/TK1.md` in that module folder
**Branch:** `tk1-ticket-refresh` from `main @ 66c5698`. Built by a Sonnet lane (`99738c2`), reviewed by Opus (`f5b06b5` → `6f921fb`). No migration, no API change, no new string.

The customer's Support page (`/:lang/app/support`) used to show only what it loaded. A new ticket, a staff answer and a status change all needed a reload. It now refetches `MY_TICKETS` after a create, when a card opens or closes, and when the window regains focus. There is no websocket and no polling, as in `RequestDrawer.tsx` (J2).

## Built

- **`apps/web/src/portal/Support.tsx`:**
  - **After a create:** the list is refetched, and the form closes once that refetch settles. If the create fails, the form shows its error. If only the refetch fails, the form closes with no error, because the ticket exists. Showing "Failed to fetch" there would invite a second, duplicate ticket. Submit stays disabled until the refetch settles. *(The lane awaited `refetchQueries`; the review changed the mechanism, see Decided.)*
  - **Card open or close:** `TicketCard` takes an `onToggle` prop, which the page wires to `refetch`. It's called on every click of the card's header.
  - **Window focus:** a `focus` listener calls `refetch`, and is removed on unmount. It's inline, as in `RequestDrawer.tsx`.
  - **A failed refetch keeps the list** *(review)*. The page renders the list whenever it holds tickets: `data`, or `previousData` after an error. The error panel is only for a page that never got its list, the order `RequestDrawer.tsx` uses. Before this fix, one failed focus or click refetch replaced the whole list with "That didn't load", and an open card and a half-typed reply were lost.
- **`apps/web/e2e/27-support.spec.ts`** (new, 8 serial tests, one database). Every test proves "no reload" with a `window` marker:
  - TK-1, TK-2 + TK-3, the lane's close/reopen test, TK-4 and TK-5 (Persian), by the lane;
  - three tests added at the review: the close alone refetches; a failed focus refetch keeps the list and a half-typed reply; a create whose list refetch fails shows no error.
- **`apps/web/e2e/helpers.ts`** *(review, test infrastructure)*: `e2eFetch` now also retries undici's `UND_ERR_SOCKET` ("other side closed"), as it already retried `ECONNRESET`. This is the keep-alive race its comment describes. See Verification, *25-home*.

## Decided

| # | Call | Made by | Verdict | Why |
|---|---|---|---|---|
| 1 | `createTicket` awaits its list refetch before the form closes | lane | **changed (mechanism), intent kept** | With `awaitRefetchQueries`, Apollo rejects the mutate promise when the refetch fails (`QueryManager.markMutationResult`'s `Promise.all`). A created ticket then showed "Failed to fetch", and a second press made a duplicate. Now the create's own error fails the submit, and the refetch is awaited with its failure ignored. |
| 2 | Every header click refetches, open and close alike | lane | accepted | The note asks for both. A closed card is the moment before a reopen. A review test proves the close alone refetches. |
| 3 | No shared hook; `RequestDrawer.tsx` untouched | lane | accepted | The card allowed inline code unless both files moved together. Two six-line effects is not yet a rule worth a file. |
| 4 | The refetch goes through the page's `MY_TICKETS` (cache-and-network); card state survives because the key is `ticket.id` | lane | accepted | TK-2 + TK-3 asserts a half-typed reply survives a focus refetch. A reorder isn't tested: React keeps keyed children across a reorder (by reading). |
| 5 | e2e data from `resetTestDatabase()` in `beforeAll`; staff act through `apiSignIn(ADMIN)` and `gql` on a `request` context | card | accepted | The answer lands after the page has loaded, without a second browser. |
| 6 | The spec is `27-support.spec.ts` | card | accepted | |
| 7 | No dependency, no API change, no locale strings | card | accepted | The diff touches `apps/web` only, and no locale file. |
| 8 | Fix `e2eFetch` on this branch, not in a separate Fix | review | **review's call** | Test infrastructure, a defect-only change on an error path, and the card's acceptance needs 25-home green. Its cause was found and proved (Verification). It ships with TK1. |

**The lane report's part 5, answered:**
1. **`-g` from the repo root.** The root `e2e` script runs `npm run e2e --workspace=apps/web`, and that inner `npm` takes `-g` (as `--global`) and `--workers=1` as its own flags. `--workers=1` is lost silently, which is harmless because `playwright.config.ts` pins `workers: 1`. **`npm run e2e -- -- <spec> -g <name>` works**, checked at this review. Proposed for `config.md`.
2. **`brief-common.md` assumes the Windows machine.** Proposed to the founder, see the stage's return.
3. **The close test can't isolate the close.** Answered by the review's test *the close alone refetches*. It was seen red against a page that refetches on open only.
4. **No reorder tested.** Accepted, see Decided #4.

## Owed

- **The full e2e suite with the changed `e2eFetch`.** All 28 specs import `helpers.ts`. This review ran 4 of them. Needed by: the next full e2e run (the next milestone, or before a deploy, per the README's *tests are targeted per stage* rule). Also in root-sot `team/open-work.md`.
- **The portal at 180 px scrolls sideways** (264 px of content in a 180 px viewport). The cause is the shared topbar's language switch and sign-out, not TK1. It fails the reflow rule (`review-instrument.md` §3) on every portal page. It isn't assigned to a stage. Also in open-work.
- **Real window focus on a real device:** after the deploy, a signed-in customer leaves the tab, staff answer, and the answer shows when the customer returns. Founder's, past the verification ceiling (open-work).

## Flagged for close-out

- **The change note's trap** says a refetch that "reorders or replaces the list" must not remount the card. The list is ordered by `updatedAt` on the server, so an answer does reorder it. The key is stable, so the trap holds. The note's wording can say so.
- **`docs/development/README.md`** gains a Change-track block in the sequence (done here). `close-out` decides whether that belongs in the sequence or in a section of its own.
- **`config.md` (root-sot, the project's):** the `-- --` form for `-g`, and the stale preview server (see Verification). These are proposals in the stage's return, not edits.
- No data model, API or glossary change.

## Verification

**Machine:** the founder's Linux machine, Chrome (`config.md` §2: Edge is the Windows build machine's), slot A (`root_wt_a_test`, API 4201, web 4273). Base `main @ 66c5698`, which hasn't moved since the lane started: nothing to merge.

**A stale server.** The first two runs of this review were served by a `vite preview` left on port 4273 by the lane (started 20:05, before the review). Playwright's `reuseExistingServer` reused it, so a review edit wasn't in the bundle. It was killed, and every count below is from a fresh build with both slot ports free beforehand. A normal run frees its ports. This one survived an interrupted run.

**Seen red first** (against the code each test guards):
- TK-1, TK-2: by the lane, against untouched `Support.tsx` (report part 3).
- TK-3: with the focus listener removed, `Expected substring: "Fixed on the staging site."`, with the card holding only the first answer.
- TK-5: same mutant, `.badge.ticket-status-resolved` with `حل‌شده` not found.
- *The close alone refetches:* with refetch on open only, `page.waitForRequest: Timeout 3000ms exceeded`.
- *A failed focus refetch keeps the list:* on the lane's page, the textarea wasn't found. The screenshot shows "That didn't load" in place of the list.
- *A create whose list refetch fails:* on the lane's page, `form.auth-form` was still there (expected 0, received 1). The screenshot shows "Failed to fetch" under the filled form.
- TK-4 isn't a regression test. It pins behaviour that already worked (`addTicketMessage` returns the whole `Ticket`), as the card says.

**Tests at the review, final branch `6f921fb`:**
- `27-support.spec.ts` + `13-requests.spec.ts` + `26-design-review.spec.ts`: **29 passed** (8 + 6 + 15).
- `25-home.spec.ts`: **6 passed**, three runs.
- `npm run typecheck`: clean.
- Not run: `apps/web` unit tests (`lib/` untouched, so `queriesSchema.test.ts` is unaffected); the full suites (the criteria don't ask for them; owed).

**25-home's "other side closed": a cause, not a flake.** It failed on `main` and on the branch (twice for the lane, at test 5; once at this review, at test 1, in `beforeEach` → `apiSignIn` → `resetRateLimits` → `e2eFetch`). The helper retried only `ECONNRESET`. undici reports the same race (a keep-alive socket the API has just closed) as `SocketError` with code `UND_ERR_SOCKET`. 25-home's `beforeEach` resets the database between helper fetches, long enough for the API to close the idle socket. With the retry, it passed three runs out of three. In a run with a temporary log line, the retry fired once (`UND_ERR_SOCKET`, `/__e2e/rate-limits/reset`) and the run passed. Flakes: none.

**Checklist grades:**
- **§1 What must not break:** not applicable. The diff is one portal page, its spec and one e2e helper (by reading the diff stat).
- **§2 House rules:**
  - 1: no role test is added (reading);
  - 3: the focus refetch repeats `RequestDrawer`'s inline effect, as the card allowed (Decided #3);
  - 6: no new strings (diff);
  - 7–8: no new CSS. The inline `style` on the card header predates TK1;
  - 14: no new numbers or dates on screen;
  - the rest don't apply.
- **§3 Every stage:**
  - scope: inside the note. `helpers.ts` is the review's own addition (Decided #8);
  - defects: the two review findings, each fixed and tested;
  - dependencies: none;
  - migrations: none;
  - fixture dates: no literal date in the spec (grep);
  - lane item 5: answered above;
  - probes: no one-rule file. The page was probed with an aborted list query on focus and after a create;
  - added tests seen red first: yes, all three;
  - flakes: none, with the cause found;
  - shared rules: `helpers.ts` changed, and 4 of its 28 importers were rerun. The rest are owed, with the condition above.
- **§4 Guards, money, hosts:** not applicable.
- **§5 UI:**
  - **Driven in a browser: screenshots, not a window.** Scripted Chrome, **Persian first**: `/fa/app/support` with a ticket and a staff answer open, at 360 px and 180 px, light and dark, measured after `document.fonts.ready`. Results: `dir=rtl`, one h1, nothing outside the content column, and no sideways scroll at 360 px in either scheme. English was driven by TK-1 to TK-4 and the review's tests, and its failure screenshots were looked at.
  - **Reflow at 180 px fails** on the shared topbar, which TK1 didn't touch (Owed).
  - **Contrast:** no new pair.
  - **One heading:** 1 h1 measured.
  - **States:** the error state now appears only when the list never loaded (finding 1). Loading and empty are unchanged.
  - Edge wasn't used: the fallback is Chrome on this machine (`config.md` §2), on the condition that the next Windows-machine run uses Edge.
- **§6 Done means:** TK-1 to TK-5, each by a named test; typecheck green; the affected e2e files green; both languages driven; no CHECKs; this record; the README's sequence and files table updated.
- **§7 Verification ceiling:**
  - Persian copy: not applicable (no new strings);
  - screen readers: not applicable (no new controls);
  - real window focus: **owed (after the deploy), founder**;
  - the rest: not applicable.

**Deploy run:** https://github.com/rishe-eco/root-app/actions/runs/39472536519 (TK1's push to `main`). Added by NR1's review, from the main session's handoff (root-sot `STATE.md`, the 8b land NR1 block); the run itself wasn't read here.

**Environment notes:**
- `psql` by hand needs `PGPASSWORD=root` here: there is no `~/.pgpass`, and `psql -w` gave "no password supplied". The lane's claim checks out. The e2e helpers don't call `psql`.
- No Docker. Native Postgres.
