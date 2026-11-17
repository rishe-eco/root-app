# DX2a — the new step order, and the tabs come off (desk UX review, stage 2a)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, items 4, 9, 11 (the sum and the gate), 12, 18, 19 and §1's tab row
**Branch:** `dx2a-steps`, from `main @ 2796abf`. **One migration:** `20261117113012_dx2a_steps` — `StepKind.PHASES` (before `DRAFT`) and `DesignTier.NONE`, two `ADD VALUE`s, no data touched. Built by a Sonnet lane, reviewed by Opus.

## Built

- **A new step, Phases and payment (`PHASES`)**, between Pages and features and the Draft on the new road (`stepsFor`). It holds the phase and payment-plan editors, moved out of Requirements (`PhasesPanel`, `PhasesEditor`); the customer reads it as they read Requirements. It locks with the agreement (`LOCKS_WITH_AGREEMENT`), and `createPhase`/`updatePhase`/`deletePhase`/`setPaymentPlan` now guard `PHASES`.
- **Done signals split.** `briefCompleteness` is the brief alone (Requirements' pill and done signal); a new `planCompleteness` (`Contract.planCompleteness`) names the phase and plan gaps — PHASES, PHASE_END_DATE, PAYMENT_PLAN, PAYMENT_PLAN_TOTAL — through the existing `planMatchesFee` (rule 3). The publish gate (`publishGate.ts`) adds `PLAN_INCOMPLETE` and `PLAN_UNBALANCED`, both `step: PHASES`, so the readiness box shows them. The agreement's approval still refuses on brief and plan gaps together under `BRIEF_INCOMPLETE`: no gate got weaker.
- **"No design" (`DesignTier.NONE`).** Its road has neither DESIGN nor MOCKUP; it needs no design allowance; `designMissing` is empty for it. Requirements offers it as a fourth choice.
- **Pages and features** holds the Extras group (moved out of Requirements; notes per extra on the SCOPE step) and, for staff, the registry controls that were the Scope tab (`ScopeRegistry`: status, flags, order, rename, decide, trades, and a per-item phase select that replaces the phase card's assign list).
- **Each Demo step** holds the demo authoring that was the Phases tab (`DemoSetup`: staging URL, build ref, review window, readiness, frame, versions, declared pages); a phase with no demo offers to create one. `PhasesTab` draws the same `DemoSetup`, so there is one implementation.
- **The new road's tabs are Steps, Contract, Dependencies, Activity, Notes.** `/scope`, `/phases`, `/design` on a new-road contract redirect to the step that holds their work (`LegacyTab`). DESIGN_FIRST contracts keep their tabs unchanged.

## Decided

1. **PHASES takes no feedback of its own**: `FeedbackItem`'s anchor CHECK has no PHASES branch. Customer notes on phases and the plan stay REQUIREMENTS notes anchored `phases`/`paymentPlan`, drawn on the PHASES panel. No data moves.
2. **PHASES locks at the agreement's approval**, not at signing as the spec says: the code has always locked steps 1–3 there (decision log #4).
3. **`PLAN_UNBALANCED` only when a plan and a price both exist**; a missing price is the approval gate's `PLAN_TOTAL_MISMATCH`, as before.
4. **The legacy `ScopeTab` is left in place** for DESIGN_FIRST contracts. Founder 2026-11-17: no conversion; the one older contract is unsigned and will be recreated, after which the legacy tabs can be deleted.

## Found, not fixed here

- **A custom-path designer can't rename a wireframe page's label**: the Design tab could (`UPDATE_PAGE_DESIGN`), `DesignAuthor` can't. → DX2b.
- **Design mutations aren't refused on a NONE contract** (`startDesignDraft` etc.; the lock check passes for a step not on the road). → DX2b.
- **The demo-approval mail links staff to `/phases`**, which now redirects to the PHASES step, not the phase's Demo step (`demoStep.ts`'s `deskUrl`). → DX2b.
- **`j9a`'s streaming-memory test fails on the Linux machine** on `main` too (heap growth over its threshold). Environmental or a real regression in the upload path; not investigated here.
- **Old notes on Requirements' Extras card** no longer render on a card; they stay in the feedback queue and the changelog.

## Verification

typecheck clean · unit 1067 API + 352 web · `prisma migrate diff`: no difference · integration: lane ran `dx2a` (5, new), `j3 j4 j5 j6 j7 j8 j9b j10 j11 j12 j13 s2 sc1 draft cc1 resolvers t1`; review ran the full integration suite: 1275 tests, 1274 pass, 1 fail — `j9a` "a chunked upload past the cap…" (heap grew 42.6 MB while 58 MB streamed), which fails the same way on `main` before DX2a on this machine; not this stage's · e2e, Chrome, slot A: `32-desk-steps` (6, new), `02 03 04 11 14 16 17 18 19 20 21 23 24 25 28 30 31` green. Not driven by hand in a browser.
