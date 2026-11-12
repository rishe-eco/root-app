# VA1 — "View as customer" no longer says Root is behind on step 3

**Built:** 2026-11-12 · **Asked by:** the founder, after walking the portal (no change note in root-sot yet)
**Branch:** `fix-agreement-view-as` from `main @ 1b83b59`. No migration, no API change.

Under "View as customer", step 3 (approve and sign) hides the Approve button and the name field, as it should, since that view is read-only. With them hidden, the panel fell back to `agreement.awaitingApproval.customer`: *"Root has not finished this yet."* That is wrong. The agreement was ready and waiting on the customer. The founder read it as work left for Root.

## Built

- **`components/AgreementPanel.tsx`:** `viewOnly` (customer audience, `asCustomer`, new road). Before approval it shows `agreement.viewOnly.approve`, after approval `agreement.viewOnly.sign`. Both carry `data-testid="agreement-view-only"`. The legacy road and the real customer are unchanged.
- **Locales:** `agreement.viewOnly.{approve,sign}` in `en.json` and `fa.json`.
- **e2e `20-agreement`:** a third test. Sales views as customer before approval (English and Persian), then after the customer approves.

## Verification

typecheck clean · unit 1064 API + 335 web · e2e `20-agreement` 3/3 (Chrome, default slot).
