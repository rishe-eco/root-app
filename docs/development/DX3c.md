# DX3c — duplicate a contract (desk UX review, stage 3c)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, item 30
**Branch:** `dx3c-duplicate`, from `main @ e9b5a93`, built beside DX4 in slot B. **No migration.** Built by a Sonnet lane, reviewed by Opus.

## Built

- **`duplicateContract(contractId, customerId, titleFa, titleEn)`** (`contracts.author`, source through `loadForActor`): one transaction makes a new project and an unsigned new-road contract with a generated reference (under the reference lock). It copies the price, the brief, the agreed scope (reset to `AGREED`, the checklist reseeded), the phases (no dates, not done) with each item's phase set mapped through `setItemPhases`, the payment plan (phase triggers mapped; a date trigger becomes "on signing") and the in-brief handover rows (no dates, no verification). Not copied: articles, revisions, signatures, approvals, feedback, demos, builds, designs, invoices, notes, assignments. One `CREATED` log row.
- **The desk:** a Duplicate button in the workspace header opens `DuplicateContractModal` (customer, default the same; titles prefilled "Copy of …" / «رونوشتِ …») and lands on the new contract's Steps tab. Refusals: `NOT_FOUND`, `CUSTOMER_INACTIVE`, `TITLE_REQUIRED`.
- `.workspace-head` wraps at 180 px; "View as customer" overflowed there before this stage too.

## Decided

1. **Flags kept** (temporary, out of scope, admin work); decisions, notes and ticks dropped.
2. **Without `customers.manage`** the dialog can't list customers, so it offers the current customer only.

## Verification

typecheck clean · unit 1093 API + 362 web · integration: `dx3c` (5, new) · e2e, Chrome, slot B: `37-duplicate` (5, new; fa and en, 360 and 180 px), `30-contract-customer`. The full suites run at the final milestone.
