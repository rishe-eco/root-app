# CC1 — a contract's title on its draft step, and moving a contract to another customer

**Built:** 2026-11-12 · **Asked by:** the founder, after walking the portal (no change note in root-sot yet)
**Branch:** `cc1-contract-customer`, stacked on `us1-users-edit-delete`. **One migration:** `20261112100000_cc1_customer_changed` (an enum value).

## Built

- **Title.** It was already editable, but only on the workspace's **Contract** tab (`TitleFeeCard`, `updateContractDraft`). The founder looked for it on the Steps tab. The card is now `components/TitleFeeCard.tsx`, rendered by both the Contract tab and the draft step (`DraftPanel`, staff with `contracts.author`, while the step is open). The fee travels with it, because `updateContractDraft` takes both and a title-only form would clear the amount. The lock is unchanged: once the agreement is approved it's `STEP_LOCKED`, because the approved text is frozen.
- **API, `changeContractCustomer(contractId, customerId)`** (`contracts.author`). It runs under the contract and project row locks, and refuses with these codes, in this order:
  - `CONTRACT_SIGNED`: any revision or amendment signed (the founder's rule).
  - `CONTRACT_APPROVED`: approving is the customer's own act on that text.
  - `PROJECT_SHARED`: the project moves with the contract, so it must hold no other contract.
  - `PROJECT_HAS_REQUEST`: the request thread is the first customer's words.
  - `INVOICED`: an issued invoice on the contract or on a subscription of its project.
  - On the target: `NOT_FOUND` if it isn't a customer account, `CUSTOMER_INACTIVE` if it's disabled or erased.

  What moves: the contract, its project, the project's subscriptions and every unissued billing entry. The old customer's mockup view grants on the project's builds are removed.
- **`ChangeAction.CUSTOMER_CHANGED`**, the five files of house rule 10, plus the migration (`ALTER TYPE … ADD VALUE`). **The log carries no name**: the new customer reads it, and it would outlive an erasure (US1).
- **Web:** `CustomerControl` in the workspace header shows "Customer: company · name", with **Change customer** for those holding both `contracts.author` and `customers.manage` (the picker needs `allCustomers`). Disabled and erased accounts aren't offered. Every refusal has a sentence in `workspace.customerError.*`, in both languages.
- **`j13`'s billing-edge guard** lists `admin/contracts.ts`: it counts issued entries and re-points unissued ones, and never returns one.

## Decided

1. **Approved is refused as well as signed.** The founder asked for "refuse if signed", and the plan they accepted named approval too. Between approval and signature the customer has already agreed to the text, and J7's gate is the approval.
2. **No partial moves.** A project holding two contracts can't be split here. The seeded wizard contract's project is shared (e2e uses a fresh contract for the move), so this refusal is the one people will meet most.
3. **The old customer's notes, proposals and scope items stay.** They're about the contract and move with it. Request threads don't, hence the refusal. Tickets stay the old customer's own.
4. **Nothing is sent to the new customer.** If the contract was already handed over, they find it in their list.

## Found, not fixed here

- **The desk's Activity tab prints raw action names** (`Customer Changed`) for every action, untranslated, which breaks house rule 6. It's older than this change; a separate task is proposed.
- **`02-contract-flow` fails on `main`** since `1b83b59`: the portal list's screen-reader title makes `getByText(title)` match twice. Separate task proposed.

## Verification

typecheck clean · unit 1065 API + 340 web · integration: `cc1` (5, new), `j13`, `j6`, `v2`, `j7`, `resolvers` · `prisma migrate diff` against the migrated test database: no difference · e2e: `30-contract-customer` (3, new: the title on the step; a move and back; the refusal after approval in English and Persian), `04-workspace`, `18-scope-draft`, `20-agreement`, `13-requests` green; `02-contract-flow` red as on `main` (above). Chrome, default slot.
