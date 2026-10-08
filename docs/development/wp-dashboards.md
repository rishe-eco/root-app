# WP-dashboards — the founder's review of the dashboards

**Written:** 2026-10-08 · Against `root-app` @ `main` (`7303a66`)
**Status:** recorded, nothing applied. Two decisions are taken (§Decisions);
everything else is buildable without further input.

The founder walked the desk and the customer portal after the journeys build
(P0–J12) and noted what they saw. This file is that list, grouped, with what
the code says about each item.

## Decisions

- **D1 — "archive" the staff SMS step = keep it, flagged off.** The code stays,
  behind a flag that is off, so it can be switched back on as 2FA.
- **D2 — the desk tile follows attention.** The Overview's "Waiting on Root"
  tile counts what Root owes (the attention module, as the Needs-Root box
  does), not the stored `ContractStatus`. The two numbers can then never
  disagree.

## The list

### Auth

1. **A password or an SMS code — never both, unless the code is 2FA.** One
   login uses one factor. An SMS code after a password is allowed only as
   2FA. The staff SMS-code step comes out of login and is archived per D1.
   The archived flow keeps its **Resend SMS** button with the standard
   **2-minute** cooldown.

### Desk

2. **The tile and the box contradict each other.** The Overview shows
   "Waiting on Root: 1" in the tile row while the Needs Root box says
   "Nothing is waiting on Root." Not a misreading. The tile counts contracts
   by their stored status (`allContractStatusCounts`); the box is J12's
   attention-backed `needsRootQueue`, which lists only contracts Root owes
   something on ([`Overview.tsx:77-115`](../../apps/web/src/desk/Overview.tsx)).
   A contract marked "Waiting on Root" with nothing owed shows in one and not
   the other. `j12.test.ts:619` pins exactly that case on the queue's side.
   This is the `ContractStatus` question the user-journeys doc left open
   (`root-studio-user-journeys.md` §290). **Fix per D2.**
3. **Desk rows should lead to their pages.** The Needs Root and review-queue
   rows already link to their contract. The status tiles don't link anywhere.
   Make each tile open the contracts list filtered to its status.

### Forms and inputs

4. **The Customers page fields move into a modal.** The page shrinks to one
   **Invite** button. The same modal is reused as an **Add customer** quick
   action inside the New contract form.
5. **Thousand separators in money fields**, both when displayed and while
   typing in inputs. They must hold in Persian digits too.
6. **Datepickers replace the day / month / year dropdowns.** Jalali and
   Gregorian follow the locale, as the dropdowns do now.
7. **Payment plan → Propose rows: the fields have no labels.** The proposed
   rows' inputs have no label or column header, so it isn't clear which field
   is which.
8. **Many forms have no Cancel button.** Fix this across every form, not only
   the ones the founder hit.

Items 4–8 are one piece of work: shared form components (a money input, a
datepicker, a modal, a form footer with Cancel) put in once and used
everywhere.

### Customer portal

9. **Support tickets don't update without a refresh.** A request the customer
   just submitted, and any answer to it, show only after a page reload.
   Refetch after submit, and refetch a conversation when its accordion opens
   or closes. **The one real bug on this list:** a customer will think their
   ticket didn't go through. It goes first.
10. **The menu icons are placeholders.** Every customer menu item shows the
    same 7px outlined square, a CSS box with no icon behind it
    ([`PortalLayout.tsx:72`](../../apps/web/src/portal/PortalLayout.tsx),
    [`portal.css:17`](../../apps/web/src/styles/portal.css)). Narrow widths
    hide the labels (`portal.css:201`), which leaves a column of identical
    squares. Each item needs its own icon.

### Later

11. **A UI/UX review** of the desk and the portal. This is a reminder only
    and not scoped here.

## Suggested order

1. #9 (the bug).
2. #1 and #2 (both decided).
3. #4–#8 together (shared form components).
4. #3, #7 if not already covered, #10.
5. #11.
