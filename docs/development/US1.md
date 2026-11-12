# US1 — edit, delete and anonymize accounts; a fresh invite link

**Built:** 2026-11-12 · **Asked by:** the founder, after walking the portal (no change note in root-sot yet). The invite-link button was asked for mid-build: SMS and mail aren't configured, and a link not copied the first time was lost.
**Branch:** `us1-users-edit-delete`, stacked on `sc1-scope-add-item`. **No migration.**

## Built

- **API (`resolvers/people.ts`), four mutations.** Who may is S3's `setUserState` rule, now one function, `loadManagedAccount`: `staff.manage` for any account holding a staff role (a mixed account counts), `customers.manage` for a customer. So sales edits, re-invites and deletes customers, and only an administrator does those things to staff.
  - **`updateUser(userId, name, phone, email, clientName)`:** the identifier checks an invite gets: `PHONE_INVALID`, `EMAIL_INVALID`, `IDENTIFIER_REQUIRED`, `PHONE_REQUIRED_FOR_STAFF`, `IDENTIFIER_CONFLICT`, plus `NAME_REQUIRED`. **Changing the phone or email revokes every outstanding link and code**, since each was sent to the old address.
  - **`reissueInvite(userId)`:** a fresh invite link for an `INVITED` account, revoking every earlier one, sending nothing. The raw link was never stored (only its hash), so "show the link again" can only be "a new link". Refusals: `ALREADY_ACTIVE`, `ACCOUNT_DISABLED`.
  - **`deleteUser(userId)`:** deletes only an account nothing records. `Restrict` edges make the database refuse (`P2003` → `HAS_HISTORY`). The edges it would *not* refuse are checked first: designer, developer or deliverer of a contract, a handed-over item and an archived request are `SetNull`, and a customer's tool grants cascade. Also `CANNOT_DELETE_SELF` and `LAST_SUPERUSER` (S3's row lock).
  - **`anonymizeUser(userId, confirmName)`:** the founder's "dangerous hard delete" for an account with records, done as **erasure in place**. Name, phone, company and password are removed, the email becomes a sentinel, the account is disabled, and every link, code, API token and mockup grant goes. Every record keeps pointing at the row. `confirmName` must equal the name (`CONFIRM_MISMATCH`). An erased account can't be restored, edited or anonymized again (`ACCOUNT_ERASED`).
- **`lib/erasure.ts`:** what "erased" means, in one file. **`User.erased`**, and an erased account's `email` reads as null.
- **Web, `desk/AccountTools.tsx`** (shared by both pages): `AccountEditForm`, `ReissueInvite`, `InviteLinkBox` (link and Copy button, also used now by both invite forms), and `DeleteAccount`. On `HAS_HISTORY` it turns into **Disable instead** plus a bordered danger zone whose button stays off until the name is typed exactly.
  - **Users page:** a **Manage** button per row opens the panel. An erased account shows as "Deleted user · Anonymized" with no controls.
  - **Customer page:** Edit details, New invite link, Delete account.
- **Locales:** `desk.people.account.*` and five new `desk.people.errors.*`, both languages. **CSS:** `.danger-zone`, `.btn-danger`, `.invite-link*`, all tokens.

## Decided

1. **Erasure uses a sentinel email, not a new column.** `User_has_identifier` needs a phone or an email on every row, and erasing removes both. `erased-<id>@erased.invalid` is unique, unroutable (RFC 2606) and recognisable, and it needs no migration. If the codebase ever wants an `erasedAt` timestamp, `isErased` is the one function to change.
2. **The erased name is bilingual in the row** (`کاربر حذف‌شده · Deleted user`). The row has one name, read on pages in both languages. The desk shows its own translated label.
3. **Tool grants count as history** even though they cascade. A grant names who gave it and when.
4. **`reissueInvite` sends nothing.** Its point is the founder copying the link while no provider exists. `inviteCustomer` and `inviteStaff` still notify.
5. **`LAST_SUPERUSER` on delete and anonymize can't be reached one request at a time.** Only an active administrator may act on one, so there are always two. It stays as the guard against two administrators acting on each other at once, the race S3 proved for disabling.

## Verification

typecheck clean · unit 1065 API + 339 web · integration: `us1` (10, new), `s3`, `s1`, `j1` (515 total) · e2e: `29-accounts` (4, new: clipboard read back, Persian labels, the anonymized customer can't sign in), `12-people`, `03-desk`, `10-phone-auth` (22). Chrome, default slot.

**Not verified:** the Persian copy by a native reader; clipboard on the production origin (HTTPS, so it should be allowed; the link stays selectable if not).
