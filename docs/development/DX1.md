# DX1 — the desk's inputs and the draft step (desk UX review, stage 1 of 4)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, `ecosystem/working/root-studio-desk-ux-review.md` 0.1, items 3, 5, 6, 13–17, 21–25, 28, 31–33
**Branch:** `dx1-desk-inputs`, from `main @ 60d75c3`. **No migration.** Built by a Sonnet lane, reviewed by Opus.

## Built

- **Item 33, the English draft reading "about money" on every article.** Cause, reproduced: the contract template has no English body for 12 of its 15 articles, and the client drew *any* null body as withheld. The API nulls a body for two reasons, so it now says which: `Article.bodyWithheld: Boolean!` (`resolvers/fields.ts`, both producers, `= !readable`). `DraftPanel`'s `Body` shows withheld only when withheld; an unwritten body reads "No English text yet" (`draft.bodyNotWritten`).
- **Item 16, the readiness box** (`desk/workspace/ReadinessBox`), top of the Contract tab: every publish blocker with a link to its step, last published version and date or *never*, unpublished changes yes/no (`draftStateOn`'s `dirty`). **The scope and brief gates moved out of `publishContractRevision` into `resolvers/publishGate.ts`** (`publishContentRefusals`), which the mutation and the new `Contract.publishBlockers` field both call (house rule 3). The mutation still throws the first refusal, with its codes and extensions unchanged; the field lists them all, plus `CONTRACT_SIGNED` and `STEP_LOCKED`, for holders of `contracts.author` (empty for anyone else).
- **Items 13, 15, 17, 14.** The Draft step: a read-only summary of Requirements and Pages and features (`DraftSummary`), the articles, Publish at the top and the foot. Title, price and planned dates left it for the Contract tab (`PlannedDates` moved to `components/PlannedDates.tsx`; its read-only branch still shows the customer the dates on the step). A top Publish button ("Publish draft") beside *Add article*. Contract-tab articles fold, with *Fold all / Open all*.
- **Items 21, 22, 31, the step pills.** `aria-current="step"` and a heavier start border on the selected pill; a state per pill (done, waiting on the customer, your turn, locked; `pillState` in `lib/wizard.ts`); "· N missing" on Requirements from `briefCompleteness`.
- **Item 24, one date field.** `DayInput` is one text field with a calendar popover, Jalali in Persian and Gregorian in English (`lib/day.ts`, on `jalaali-js`). Props and `onChange` unchanged, so callers didn't move.
- **Item 23** `MoneyReadout` under every desk money input; **item 25** `CountStepper` for revision rounds and iteration counts (0–20); **items 3, 5, 6** Requirements' panels as accordions, support months and who-provides as pills (`PillChoice`); **item 28** `NextUp`, the "what's next" bar, linking to `?step=` (StepsTab now follows that address while already open).

## Decided

1. **No schema change**, so DX2 starts on a clean schema lane. Hence item 6 has no "Not needed" pill: the brief stores `ROOT | CUSTOMER | null`. It comes with DX3's handover-item table.
2. **The typed year picks the calendar** (below 1700 is Jalali) in either panel; bad text emits `''` and sets `aria-invalid`.
3. **Folding is on the Contract tab only**; the Draft step's article list (feedback targets) doesn't fold. A folded form is hidden, not unmounted, so a half-typed edit survives.
4. **`publishBlockers` asks `assertStepOpen(wizardStateOn())`, not `assertStepOpenOn`**: j7's lock table counts guarded writes by that name.
5. **Item 32 was already built** (`/desk/contracts/:id/as-customer`, gated by ownership in the API). Nothing added.

## Found, not fixed here

- **The desk's side nav under 720 px** is a non-wrapping row that scrolls the page sideways. `31-desk-ux` measures the workspace column instead of the page.
- A few new CSS sizes are raw (`1px`, `6px`, `rem` widths), as much of the existing CSS is (house rule 8).

## Fixed in review

- **`03-desk` "sales assigns and then changes the contract designer"** failed on `main`: `{ name: 'Change' }` matched CC1's "Change customer" too. Now `exact: true`.

## Verification

typecheck clean · unit 1065 API + 352 web · integration: `j4` (+2), `j6` (+3), `j7`, `resolvers`, `draft`, `cc1`, `j3` green · e2e, Chrome, slot A: `31-desk-ux` (6, new), `17-requirements`, `18-scope-draft`, `30-contract-customer`, `03-desk`, `04-workspace`, `14-wizard`, `19-invoices`, `20-agreement`, `28-scope-add` green. Not run: the full suites (milestone after DX2); `02-contract-flow`, `21-design`, `23-mockup`, `25-demo`, which reach the changed screens only through API helpers. Not driven by hand in a browser; dark mode not looked at.
