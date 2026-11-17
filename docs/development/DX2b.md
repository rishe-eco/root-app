# DX2b — what a phase is (desk UX review, stage 2b)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, items 10, 11 (the date trigger), 12; design in the decision log rows 6–10 (root-app `.tmp/desk-ux-decisions.md`, kept out of the repo)
**Branch:** `dx2b-phases`, from `main @ 128b4c9`. **One migration:** `20261117124611_dx2b_phases` — the `ScopeItemPhase` join table with its backfill (one row per item that had a phase), `Phase.hasDemo` (default true), `doneAt`, `doneById`, `PlannedInvoice.dueOn`, and the hand-written CHECK `PlannedInvoice_phase_xor_date`. Built by a Sonnet lane (cut off once by a usage limit and resumed), reviewed by Opus.

## Built

- **A scope item can be in more than one phase.** `ScopeItemPhase` holds the set; `ScopeItem.phaseId` stays and always equals the last phase of the set: the phase whose acceptance accepts the item. `lib/itemPhases.ts` (`setItemPhases`, `resyncItemPhase`) is the only writer of `phaseId`. Approving a phase, or marking it done, accepts the items whose last phase it is; items it showed early go from `IN_DEMO` back to `IN_BUILD` (`settleItemsOfFinishedPhase`, shared by `approveDemo` and `markPhaseDone`). The demo frame's NEW/KNOWN_MISSING and the `Phase.scopeItems` field read the set; acceptance reads `phaseId`.
- **"Has a demo" and "Mark phase done".** A phase without a demo has no Demo step. `phaseFinished` in `lib/phase.ts` is the one rule for "this phase is finished" (its demo approved, or no demo and marked done); invoices, delivery and the wizard read it. `markPhaseDone` (`builds.author` on the phase, or `contracts.author` on a contract they can see) refuses `PHASE_HAS_DEMO`, `NOT_SIGNED`, `PHASE_DONE`, in that order. It is not behind the PHASES lock, so it works after signing, and it emails the customer (`PHASE_DONE`, email only).
- **An invoice due on a date.** `PlannedInvoice.dueOn`; at most one of a phase and a date (the CHECK, proven by a direct insert). Before that day `canIssuePlanned` says `DATE_NOT_REACHED`; staff issue it (founder: no scheduler). The plan editor offers on signing, when phase X is done, or on a date.
- **Snapshot format 3** (`FORMAT_3`), written by every new-road publish from now on: format 2 plus `phases[].hasDemo`, the phases of each scope item (as numbers) and `plan.invoices[].dueOn`. A stored format-2 snapshot reads back with its bytes and hash unchanged; a test pins that hash.
- **Review fixes from DX2a:** a designer can rename a wireframe page again (`DesignAuthor`); design writes refuse `STEP_NOT_ON_ROAD` on a No-design contract; the demo-approval email links to the phase's Demo step.

## Decided

1. **Assigning items to phases stays outside the PHASES lock**, as `assignScopeItemToPhase` always was (j10 assigns after signing). The spec locks "the phases, their items" at signing; the lock covers the phases, `hasDemo` and the plan, but not the item sets.
2. **`Phase.scopeItems` on the wire now means the items shown in the phase**, not only the ones it accepts.
3. **A published but unsigned format-2 revision reads as having unpublished changes** against a format-3 draft, and needs one republish. On the deploy, any contract in that state will show "unpublished changes: yes" on its readiness box.

## Fixed at the milestone

- **The portal's contracts table scrolled sideways on a phone** (`26-design-review`): the new step order puts the seeded contract on the customer's turn, and "Waiting on Customer" in a no-wrap `.st-badge` was wider than the column. At 480 px and below the table's cells are tighter and the badge wraps (`portal.css`).

## Found, not fixed here

- **`j9a`'s streaming-memory test fails on the Linux machine**, on `main` too (DX2a.md).

## Verification

typecheck clean · unit: targeted API files 135, web 354 · `prisma migrate diff`: no difference · integration: `dx2b` (17, new), `j7`, `j10`, and `j13 l3 l3b dx2a j11 j12 j2 j3 j4 j8 j9b s2 t1 sc1 draft cc1 dx2b` (365/365) · e2e, Chrome, slot A: `34-phases` (2, new), `32-desk-steps`, `17-requirements`, `28-wizard-status`. The DX2 milestone (the full suites, with DX3b merged in) is recorded in the README's sequence.
