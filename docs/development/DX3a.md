# DX3a — handover items: one list, edited from Requirements and the Dependencies tab (desk UX review, stage 3a)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, items 6, 7, 8, 20, 29
**Branch:** `dx3a-handover`, from `main @ 9ef8d15`. **One migration:** `20261117150000_dx3a_handover`. It creates `HandoverItemType` (seeded with domain, host and content). It makes `Dependency.side` and `dueAt` nullable, and adds `inBrief` and `notNeeded`. It backfills, then drops `ContractBrief.domainProvidedBy`, `hostProvidedBy` and `contentProvidedBy`, and adds the CHECK `Dependency_board_row_complete`. Built by a Sonnet lane, reviewed by Opus.

## Built

- **The `Dependency` row is the handover item.** Requirements' panel (`HandoverPanel`: item · Root / Customer / Not needed · due date) and the Dependencies tab edit the same rows. A new brief seeds a row for every active default item. One-off items can be added from either place.
- **The default list** is a "Handover items" tab under Templates (`resolvers/handoverTypes.ts`). Extras still imply the gateway, SMS line and Enamad rows.
- **Completeness:** the three provider codes are gone (founder: each is optional). A row in the brief with a side but no date is still `COMMITMENT_UNDATED`.
- **Lock:** once the agreement is approved, a brief row's side, date, not-needed flag and title are `STEP_LOCKED`. Marking it delivered still works. A row added after the lock is board-only and needs a side and a date (the CHECK).
- **The customer's board and overdue lists** skip rows marked not needed and rows with no side. A null date is never overdue.
- **Format 3** carries `handover` instead of the brief's three provider keys. Format 2 is untouched; the agreement document prints whichever its snapshot has.
- **The "feature for an existing site" preset:** choosing that kind sets No design, declines the extras, and marks domain and host as not needed, in one transaction.

## The migration's backfill, read in review

Rows that already had a `briefKey` become `inBrief` and keep their side and date. For each project with a brief (DISCARDED contracts skipped), each of the three keys with no row gets one, with the brief's side (or none) and no date. The creator is the earliest admin. Signed agreements keep the old values in their frozen format-2 snapshots. `gen_random_uuid()` is built into Postgres 13 and later; production runs 16. The backfill was run in a rolled-back transaction, not by a test: once applied, the old columns don't exist.

## Decided

1. **The default list is gated by `contracts.author`** (sales writes the board), not `templates.types`.
2. **`createDependency` and `updateDependency` take optional fields** (omitted means unchanged, `null` clears) and return the workspace fragment.
3. **The preset declines extras that were already agreed.** It runs only on the change to that kind.
4. **The handover panel keeps a Save button**; DX4 brings autosave.

## Found, not fixed here

- **A project's rows are shared by its contracts**, so a second contract on one project shows rows that the first contract's agreement locked. Rare (a second contract on a project), and left as is.
- **The registry's status setter can still remove an extra's row after approval**, as before DX3a.

## Verification

typecheck clean · unit 1093 API + 361 web · `prisma migrate diff`: empty · integration: `dx3a` (15, new; CHECK by direct insert, format-3 `handover`), `j2 j3 j4 j5 j6 j7 j8 j9b j10 j11 j12 j13 l5 s1 s2 v3 dx2a dx2b resolvers` green · e2e, Chrome, slot A: `35-handover` (4, new; fa and en, 360 and 180 px), `04 11 14 17 20 31 32` green.
