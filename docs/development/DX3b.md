# DX3b — the new-contract form: a generated reference, and "New customer" (desk UX review, stage 3b)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, items 1 and 2 (prefix `R-`, founder 2026-11-17)
**Branch:** `dx3b-new-contract`, from `main @ 128b4c9`, built beside DX2b in slot B. **No migration** (a `///` comment on `Contract.ref` only). Built by a Sonnet lane, reviewed by Opus.

## Built

- **The reference is generated** (`lib/contractRef.ts`): `R-<Jalali year>-<NNN>`, a running number per year, three digits at least. The year comes from `Intl` with the `persian` calendar in `Asia/Tehran`, so it turns at Nowruz in Tehran; no dependency. `createContract`'s `ref` is optional: without one the server numbers it under `pg_advisory_xact_lock(hashtext('contract-ref'))`, so two creations get two numbers. The form prefills `nextContractRef` and sends a ref only if it was edited.
- **`updateContractRef`** (`contracts.author`): until anything on the contract is signed (`CONTRACT_SIGNED`, the customer-change rule); `REF_INVALID` unless `^[A-Za-z0-9-]{1,40}$`; `REF_TAKEN` on a duplicate. Its own card on the Contract tab (`ContractRefCard`): the title-and-fee card locks at approval, the reference only at signature.
- **"New customer" beside the picker** (`desk/NewCustomerModal.tsx`, for `customers.manage`): `inviteCustomer`'s fields plus a language select; the new customer is selected, the form keeps what was typed, and the modal shows the invite link with Copy. Hidden on the convert-a-request form, whose customer is fixed.
- 180 px fixes in shared CSS: buttons in forms and modals wrap, `.modal-actions` wraps, long links break.

## Decided

1. **An advisory lock, not a retry**, for generated numbers. A typed reference doesn't take the lock; its clash is `REF_TAKEN`, and in review `createContract` maps a `P2002` on `ref` to `REF_TAKEN` too, so a race never surfaces as an uncoded error (house rule 12).
2. **A reference change isn't logged** in Activity: no `ChangeAction` fits, and adding one is a migration.
3. **The modal doesn't claim delivery**: the API reports none; it says whether an email address was given.

## Verification

typecheck clean · unit 1071 API + 354 web (`contractRef` 4, new) · integration: `dx3b` (7, new; re-run after the review fix), `s1`, `cc1` · e2e, Chrome, slot B: `33-new-contract` (5, new; fa and en, 360 and 180 px), `04-workspace`, `13-requests`. Not run: the full suites (milestone).
