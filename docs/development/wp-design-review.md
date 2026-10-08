# WP-design-review: the HIG review of the public site and the customer portal, fixed

**Written:** 2026-10-08 by Claude Opus (the reviewer), from its design review of root-app's
public pages and customer dashboard (the "apple-design" review in the founder's chat).
**Base:** the branch the worktree starts from (`wp-dashboards` @ `9650aa2` = `main` @ `7303a66`
plus one doc). **Your branch:** `wp-design-review`.
**Lane:** `ROOT_TEST_DB=root_wt_dr_test`, `E2E_API_PORT=5231`, `E2E_WEB_PORT=5235`,
`E2E_BROWSER_CHANNEL=msedge`.

Your **first commit** is this file, copied verbatim to `docs/development/wp-design-review.md`
(the reviewer appends the record to it later; this replaces the "no record file" rule of the
common brief for this one file).

Everything below is web-only: `apps/web`. **Do not touch `apps/api`.** No new dependencies.

---

## 0. Ground rules for this package

- The palette's comments in `src/styles/tokens.css` are the brand's own record. When you change
  a value, keep the comment voice: mark the corrected value with `⚠ corrected:` and the
  contrast figure, as the file already does for `--clay-500` and `--gold-500`.
- **Contrast is computed, never eyeballed.** Phase A adds a unit test that computes WCAG
  ratios from `tokens.css`. Every colour decision in this package must be backed by that test.
  Thresholds: text < 18.66px regular (i.e. everything below `--text-h3` unless bold) ≥ 4.5:1;
  large/bold text ≥ 3:1; control boundaries, focus rings and meaningful icons ≥ 3:1.
- Logical properties only (house rule). Persian is never letter-spaced, uppercased or italic.
- Every new string in **both** `en.json` and `fa.json`. Persian uses the informal تو/کن voice.
  Persian strings are given below; use them verbatim. If you need a string this brief does not
  give, write the English, put your best Persian, and **list it in your report** for a native
  check.
- `wp-dashboards.md` (already on your base) item #10 (portal menu icons) is folded into Phase C
  here. Do not touch the other items on that list.

---

## Phase A — tokens and contrast (review: Critical #2, #3; Craft "gold twice")

### A1. Text tiers that pass on every ground
Grounds: chalk `#EDEFF0` (bg), footer `#E1E5E9` (also the portal sidebar), panel `#DCE2E7`,
raised `#F5F7F8`. Today `--color-text-subtle` (#7A8798) is 3.17:1 on chalk / 2.89:1 on footer at
13px, and `--color-text-muted` (#5A6A82) is 4.34 on footer / 4.21 on panel.

In `tokens.css`:
- `--neutral-700: #505E74;` `/* ⚠ corrected: as-built #5A6A82 was 4.21:1 on panel. 5.03 panel · 5.19 footer · 5.70 chalk */`
- add `--neutral-650: #55647B;` `/* subtle text: 4.60 panel · 4.75 footer · 5.21 chalk */`
- `--color-text-subtle: var(--neutral-650);` (muted stays `var(--neutral-700)`).

At 13px there is no room for a much lighter tier; "subtle" now differs from "muted" by size and
weight more than by colour. Say that in the comment.

### A2. Fields, focus
- Add `--color-border-control: var(--neutral-600);` (#7A8798, 3.17:1 on chalk, ≥3 on raised) —
  the boundary of anything you type into or toggle. `--color-border` stays the hairline for
  cards and rules (decorative, exempt).
- In `kit.css`: `.input, .textarea, .select` border → `--color-border-control`; their `:hover` →
  `--color-text-muted`; `.check` (portal.css) border → `--color-border-control`.
- `--color-focus: var(--cyan-500);` (#4E7D8E, 3.92:1 on chalk; cyan-400 was 2.94). Input
  `:focus` border uses `--color-focus`, not `--color-rule`. `--color-rule` stays cyan-400
  (decorative rules).

### A3. Gold
- Add `--gold-700: #6F5713;` `/* badge text on gold-100: 5.59:1 (gold-600 was 4.02) */`.
- Every `color: var(--gold-600)` sitting on `var(--gold-100)` (`.badge-locked`, `.st-woc`,
  `.ticket-status-in_progress`, `.service-status-previewed`, `.service-action-update`, and any
  other you find) → a semantic token (see Phase F), resolving to `--gold-700` in light.
- **The one gold thing on the page** (`kit.css` says so): the footer repeats the tagline's gold
  word at 13px (2.74:1). In `public.css`: `.footer-descriptor .beauty { color: inherit; }` with
  a comment citing the kit rule. The hero keeps its gold.

### A4. Other pairs found failing
- `.st-discarded`: `neutral-600` on `neutral-300` = 2.80 → `color: var(--color-text-subtle)`.
- `.chip-count { opacity: 0.7 }` and `.library-strand-locked { opacity: 0.75 }` and the
  `.btn:disabled` 0.45 opacity: opacity on text defeats the contrast test. Replace the first two
  with a colour (`--color-text-subtle`); leave disabled buttons alone (WCAG exempts disabled
  controls) but say so in a comment.
- The About CTA eyebrow's raw `#CBB9A6`: delete the override; `.card-inverse .t-eyebrow`
  already sets `--cyan-300` (5.54:1 on indigo).
- Raw `#fff` in `kit.css` / `portal.css` (`.done-pill`, `.check-on`, `.gate-done .gate-ic`,
  `*-failed`, `*-rejected`, `.dependency-overdue-badge`) → new `--color-on-strong` (light value
  `var(--neutral-50)`). `print.css` keeps its `#fff` (paper).

### A5. The test — `src/lib/tokens.test.ts` (runs under `npm test`, i.e. `tsx --test src/lib/*.test.ts`)
Reads `src/styles/*.css` with `fs` (path relative to the test file via `import.meta.url`).
1. **Every `var(--x)` used in any stylesheet is defined** in `tokens.css` (or locally in the same
   file — check with a regex over `--x:` declarations). This catches Phase B's bug forever.
2. **Contrast table, light and dark** (dark after Phase G): a small resolver for `tokens.css`
   (`--a: var(--b)` chains and hex values, per mode block) and a list of named pairs
   `[foreground token, background token, minimum]`, at least:
   text/muted/subtle on bg, footer, panel, raised (4.5); accent and secondary text on bg (4.5);
   on-accent on accent (4.5); text-inverse on inverse (4.5); every badge fg/bg pair (4.5);
   border-control on bg and raised (3); focus on bg, raised, panel (3); beauty on bg (3, large
   text only — say so in the pair's label).
   Failing message prints the pair and the ratio.

---

## Phase B — the two spacing tokens that do not exist (review: High #1)

`--space-10` (public.css:88, :122) and `--space-5` (portal.css:79) are used but never defined,
so the declarations are dropped: the Library home lede runs into the strand cards, the
reader's two language columns touch, and the contract page's pending banner has **no padding
at all**. Add to the spacing scale: `--space-5: 1.25rem;` `--space-10: 2.5rem;`. Then replace
the hand-written `1.25rem` values in `portal.css` (`.topbar`, `.ctable th/td`, `.sec`,
`.rail-card`, `.topbar-right`) with `var(--space-5)` — same value, now a token. A5's test
guards it.

---

## Phase C — the portal on a phone (review: Critical #1; wp-dashboards #10)

Today below 860px `.side` becomes a 76px column and `.side-link span:not(.side-glyph)` gets
`display:none`, which removes the only text — every rail item is an identical 7px square with
**no accessible name**.

### C1. Icons — `src/components/PortalIcon.tsx`
One component, `<PortalIcon name="dashboard|contracts|invoices|tools|support|desk" />`, inline
SVG, `viewBox="0 0 24 24"`, 20×20, `fill="none" stroke="currentColor" stroke-width="1.75"
stroke-linecap="round" stroke-linejoin="round"`, `aria-hidden="true"`, `focusable="false"`.
Draw simple, distinct outlines (house / four-square grid for Dashboard; a page with a folded
corner for Contracts; a receipt with a zigzag foot for Invoices; a wrench for Tools; a speech
bubble for Support; a briefcase for Desk). Same stroke weight as the text beside them. No
icon library — the kit's comment explains the system is markup-only; SVG paths are markup.
They must not mirror in RTL except the speech bubble's tail (mirror via
`[dir=rtl] .portal-icon-mirror { transform: scaleX(-1) }` if you draw the tail on one side).
Replace every `<span className="side-glyph" />` in `PortalLayout.tsx` with the icon; delete
`.side-glyph`. Keep the labels in a `<span className="side-label">`.

### C2. The rail becomes a bottom tab bar at ≤ 860px (CSS only, same DOM)
Same `<aside className="side">` / `<nav className="side-nav">` / NavLinks — the e2e spec
`25-home.spec.ts` locates `.side-nav .side-link` and `.side-link-active`; keep those classes
and the active logic. In `portal.css` replace the 860px block's `.side` rules with:
- `.side`: `position: fixed; inset-inline: 0; inset-block-end: 0; z-index: 40;` row layout,
  `padding: var(--space-1) var(--space-2) calc(var(--space-1) + env(safe-area-inset-bottom));`
  `background: var(--color-footer); border-block-start: 1px solid var(--color-border);`
  `border-inline-end: 0; gap: 0;`
- `.side-brand`, `.side-cap`: `display: none` (branding defers to content; the brand is one
  tap away on the public site).
- `.side-nav`: `flex-direction: row; inline-size: 100%;`
- `.side-link`: `flex: 1 1 0; flex-direction: column; gap: 2px; min-block-size: 52px;
  padding: var(--space-1); justify-content: center; font-size: 0.75rem;` (12px — above the
  11pt mobile minimum), label `text-align: center`, one line, `overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-inline-size: 100%`.
- **Labels are visible.** Delete the rule that hides them.
- `.work`: `padding-block-end: calc(64px + env(safe-area-inset-bottom));` so content clears
  the bar.
- `index.html` viewport meta gains `viewport-fit=cover` so `env()` works on notched phones.
- Active item: `color: var(--color-text); font-weight: semibold` plus the icon — not colour
  alone (the active background pill may stay).

### C3. Topbar on a phone (≤ 640px)
`Topbar.tsx` / `.topbar`: today title + LangSwitch + name + avatar + Sign out sit in one
unwrapping row in ~314px.
- `.topbar`: `flex-wrap: wrap; padding: var(--space-4) var(--space-6);`
- The visible name: give it class `user-name`; at ≤ 640px apply the `.sr-only` treatment (copy
  the declarations, don't `display:none` — the name stays announced).
- The avatar keeps `aria-hidden`.
- e2e (Phase H) asserts no horizontal overflow at 390px.

### C4. One heading per page (review: High #2)
The topbar renders `<h1 className="t-h3 topbar-title">` and Dashboard's content renders a second
`<h1>` with the same word. Audit **every** `<Topbar start=…>` (Dashboard, Contracts, Invoices,
Support, Tools, ContractDetail, Wizard). Rule: the page's single `<h1>` lives in the content;
the topbar `start` is never a heading.
- Where the content already has the same-titled `<h1>` (Dashboard; check the others), pass
  `start={<span className="crumb" />}` (what ContractDetail already does) — the word is not
  shown twice.
- Where the topbar title is the **only** title, move it into the content as the page `<h1>`
  (`content-head`) rather than keeping a heading in the bar.
- Check e2e specs for `getByRole('heading', …)` on these pages and keep them passing.

### C5. Touch targets (review: High #3)
- Dashboard `home-actions`: drop `btn-sm` from all three (the primary action was the smallest
  button on the page).
- In `kit.css`, one block:
  `@media (pointer: coarse) { .btn, .nav-link, .lang-switch button, .side-link, .chip,
  .menu-toggle { min-block-size: 44px; } }` — follows the input device, not the width, which is
  the point. Check that `.btn` keeps `align-items:center` so text stays centred.

---

## Phase D — the public nav on a phone (review: High #4)

At 390px the nav wraps into two rows. In `Nav.tsx` add a disclosure for ≤ 768px:
- Bar shows: brand (start), LangSwitch, and a **Menu** button
  (`className="btn btn-ghost menu-toggle"`, `aria-expanded`, `aria-controls="site-menu"`,
  visible label `nav.menu` / `nav.close`, not icon-only).
- The four slots + Portal render inside `<div id="site-menu" className="nav-menu">`. ≥ 769px:
  the menu is always shown inline exactly as today (CSS: `display: contents` on `.nav-menu`
  above the breakpoint is the cheapest way to keep today's flex layout untouched — verify it
  in Edge; otherwise style it as an inline flex row) and the toggle is hidden.
- ≤ 768px: `.nav-menu` hidden unless open; open = a full-width column under the bar, each item
  ≥ 44px tall, locked slots keep blur + padlock + `.sr-only` text.
- Close on: route change (`useLocation` effect), Escape (return focus to the toggle), and
  selecting a link. No focus trap (it is a disclosure, not a modal).
- The Portal link becomes a `NavLink` so it shows as current on `/portal*`.
- Strings: `nav.menu` en "Menu" / fa "منو"; `nav.close` en "Close" / fa "بستن".

---

## Phase E — content and craft fixes

### E1. Landing growth cards (review: Medium "doors to nowhere")
They wear the clickable card frame but link nowhere, and the hero CTA is hidden by founder
direction (2026-08-09 — **do not add a CTA**). Keep the as-built clay top rule (it is the
landing's signature), drop the frame: new class `.growth-item` in `public.css` —
`border-block-start: 3px solid var(--color-rule-strong); padding-block-start: var(--space-6);`
no side/bottom border, no radius, no padding-inline. `Landing.tsx` uses it instead of
`card card-topruled`. Keep `.card-topruled` in the kit (other users may exist — grep).
**Flag this in your report as a founder-visible change.**

### E2. Library home
- Research strand: when `total === 0`, don't render the count line (the Persian zero "۰"
  reads as a bullet: "• مدخل").
- Root Cast strand: delete its eyebrow (it repeats the title). Keep title, "Coming later",
  lock. `.library-strand-locked` loses its opacity (A4); its text uses `--color-text-subtle`.

### E3. Library list — labels and empty states
- Search `<input>`: `type="search"`, `aria-label={t('library.list.searchLabel')}`.
- Type `<select>`: `aria-label={t('library.list.typeLabel')}`.
- Empty states replace `library.list.empty`:
  - no search text and no type/concept filter → `library.list.emptyNone`.
  - otherwise → `library.list.emptyQuery` + a `btn btn-secondary btn-sm` "Clear search"
    (`library.list.clearSearch`) that clears search, type and offset (and the concept filter if
    one is active — there is already a `clearFilter`; reuse its handler).
- Strings:
  - `searchLabel` en "Search the Library" / fa "جست‌وجو در کتابخانه"
  - `typeLabel` en "Type" / fa "نوع"
  - `emptyNone` en "Nothing has been published here yet." / fa "هنوز چیزی اینجا منتشر نشده."
  - `emptyQuery` en "Nothing matches your search. Try fewer words, or clear the search." /
    fa "چیزی با جست‌وجوی تو جور درنیامد. کلمه‌های کمتری امتحان کن، یا جست‌وجو را پاک کن."
  - `clearSearch` en "Clear search" / fa "پاک‌کردن جست‌وجو"
  Remove `library.list.empty` only if nothing else uses it (grep, including e2e).

### E4. About
- The CTA title outranks the page thesis (en: 64px under a 48px h1). New classes: en thesis
  `t-h1`, CTA `t-h2`; fa thesis `t-h2`, CTA `t-h3`. Update the comment.
- `.clients-cta { border-radius: 24px }` → add `--radius-lg: 24px;` to tokens and use it.

### E5. Persian italic
Vazirmatn has no italic; the browser fakes a slant that leans the wrong way in RTL. In
`base.css`, next to the existing "Persian must never be letter-spaced or uppercased" rule:
`:lang(fa) { font-synthesis-style: none; }` plus `:lang(fa) .footer-refusal { font-style:
normal; }`. Comment why.

### E6. Language switch
`LangSwitch.tsx`: EN button `lang="en" aria-label="English"`, فا button `lang="fa"
aria-label="فارسی"`.

### E7. Capitalization (en)
House style is sentence case (it already is almost everywhere: "Open the portal", "New request",
"Sign out"). Fix the exceptions on the public pages: `nav.about` and `about.eyebrow` "About Us"
→ "About us". Proper names (Root Studio, Root Cast, Research Lab, Library) stay. Grep e2e for
"About Us" and update.

---

## Phase F — semantic tokens for every raw-ramp use (prerequisite for dark mode)

Component CSS references raw ramps directly about 37 times (`grep -n "var(--neutral\|var(--indigo\|var(--clay\|var(--cyan\|var(--gold" src/styles/{kit,portal,desk,wizard,public}.css`).
A dark palette can only redefine semantic tokens, so each of those becomes a semantic token
first, defined in `tokens.css` in the light block with **today's value** (except the A-phase
fixes). Suggested families (use these names unless the code argues otherwise):
- badge pairs: `--badge-gold-bg/fg`, `--badge-cyan-bg/fg`, `--badge-clay-bg/fg`,
  `--badge-indigo-bg/fg`, `--badge-neutral-bg/fg`, `--badge-strong-bg/fg` (`.st-done`).
- `--color-on-accent` (text on clay buttons, the active lang pill), `--color-on-strong` (A4),
  `--color-text-on-inverse-muted` (indigo-200 on inverse), `--color-eyebrow-on-inverse`.
- anything else: name it by role, not by hue.
`print.css` is exempt (paper is always light). This phase changes **no rendered colour** in
light mode except the A-phase ones — say so in the commit message, and prove it with
screenshots (Phase H).

## Phase G — dark appearance (review: Medium "no dark mode")

Follows the system setting. **No in-app toggle** (HIG `dark-mode.md`: "Avoid offering an
app-specific appearance setting").
- `tokens.css`: `color-scheme: light dark;` on `:root`, then
  `@media screen and (prefers-color-scheme: dark) { :root { …semantic tokens only… } }`.
  `screen` so printing always gets the light set.
- **Paper surfaces stay light.** Anything that draws white paper on screen (the print
  previews: `ContractPrint`, `SummaryPrint`, invoice print, `AgreementDocument` /
  `SummaryDocument` if they render as paper, the demo frame's `--color-raised` ground behind a
  customer's own staging site) gets class `force-light`, and `tokens.css` declares the light
  semantic set on `:root, .force-light` so those subtrees resolve light even inside a dark
  root. Grep for `#fff`/`background: white`/print classes to find them.
- Starting palette (all pairs pre-computed; A5's test must confirm them):

  | token | dark value | check |
  |---|---|---|
  | `--color-bg` | `#101925` | |
  | `--color-footer` | `#141E2B` | |
  | `--color-raised` | `#192333` | |
  | `--color-panel` | `#1C2738` | |
  | `--color-inverse` | `#24406A` | text-inverse 9.0 · indigo-200 5.1 · cyan-300 4.7 |
  | `--color-text` | `#E4E8EC` | 12.2 on panel |
  | `--color-text-muted` | `#AEB8C6` | 7.5 on panel |
  | `--color-text-subtle` | `#9AA5B5` | 6.0 on panel |
  | `--color-text-inverse` | `#EDEFF0` (unchanged: it sits on inverse/accent grounds) | |
  | `--color-border` | `#2E3B4F` (hairline) | |
  | `--color-border-strong` | `#3F4F66` | |
  | `--color-border-control` | `#6B7A8F` | 3.44 on panel |
  | `--color-rule` | `#5E93A6` | |
  | `--color-rule-strong` | `#C24B3A` (clay stays the landing's mark) | |
  | `--color-focus` | `#6FA8BC` | 5.7 on panel |
  | `--color-accent` (button fill) | `#A83E2F`, `--color-on-accent` `#EDEFF0` | 5.36 |
  | accent as **text** (`.link-action`, `.label .req`) | `#E08A7C` — needs its own token (`--color-accent-text`); split it in Phase F | 5.8 on panel |
  | `--color-secondary` (as text, crumbs, `.cview`) | `#7FB3C4` | 6.6 on panel |
  | `--color-beauty` | `#D4B366` | 8.8 on bg |
  | `--color-error` | `#EE9A8C` | 6.9 on panel |
  | badge gold | bg `#3A3020` fg `#E5D09B` | 8.5 |
  | badge cyan | bg `#1D3640` fg `#B0CFD8` | 7.7 |
  | badge clay | bg `#4A2420` fg `#F5D8D3` | 10.0 |
  | badge indigo | bg `#2A3B56` fg `#D3DBE7` | 8.1 |
  | badge neutral | bg `#2A3442` fg `#C7CDD3` | 7.9 |
  | shadows | `rgba(0,0,0,.35/.45/.55)` | |

  Anything the table misses (secondary-soft, accent-soft, the scrim, `.overlay-scrim`, the
  concept preview skeletons): choose by role, add the pair to A5's test if it carries text.
- Images and customer content (design concepts, palette swatches in `PaletteView`, mockups)
  are content: don't recolour them.

---

## Phase H — tests and evidence

### H1. Unit: `src/lib/tokens.test.ts` (A5). Must pass in both modes.

### H2. e2e: `e2e/26-design-review.spec.ts`
Use the seeded customer and the existing helpers (read `25-home.spec.ts` and the shared
fixtures first — sign-in helper, seeded names). Cases:
1. **Phone portal, fa and en** (`viewport 390×844`, `hasTouch: true`): on `/xx/app` signed in as
   the customer — `.side-nav` sits at the bottom (its bounding box bottom ≈ viewport height);
   every `.side-nav a` is visible and has a non-empty accessible name
   (`getByRole('navigation').getByRole('link')` names); exactly one `h1` on the page; no
   horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`); the
   "New request" button is ≥ 44px tall.
2. Same overflow + one-`h1` check on `/xx/app/contracts`, `/invoices`, `/support`.
3. **Phone public nav**: on `/fa` and `/en` at 390px the menu is closed, the toggle opens it
   (`aria-expanded="true"`, About link visible), Escape closes it and focus returns to the
   toggle; no horizontal overflow on `/fa`, `/en`, `/fa/about`, `/fa/library`,
   `/en/library/research`.
4. **Desktop public nav** at 1280px: no toggle visible, About/Library/Portal links visible
   (today's layout).
5. **Library**: the search box is reachable by `getByRole('searchbox', { name: 'Search the
   Library' })`; with an unmatched query, the empty-query text and "Clear search" show, and
   clearing restores the list state.
6. **Dark**: `page.emulateMedia({ colorScheme: 'dark' })` on `/en` and the customer's
   `/en/app` — `body`/`.root-ui` computed background is `rgb(16, 25, 37)`; a print preview page
   (`/en/app/contracts/:id/print` for a seeded contract, if one is reachable) still has a light
   paper background.
Update any existing spec your changes break (expected: "About Us", heading queries) — change
the assertion, not the intent, and list each in your report.

### H3. Screenshots (evidence for the reviewer, not committed)
Write a small Playwright script (keep it in the worktree under `apps/web/test-results/` or as
an untracked file; `test-results/` is gitignored) that, against your lane's own servers,
captures full-page PNGs **before** (on your base commit — capture these first) and **after**:
`/fa`, `/en`, `/fa/about`, `/en/about`, `/fa/library`, `/en/library/research`, `/fa/portal`,
and signed in as the seeded customer `/fa/app`, `/en/app`, `/fa/app/contracts`, a contract
detail page, `/fa/app/invoices` — each at 1440×900 and 390×844, light; and the after set again
in dark. Save to `apps/web/test-results/design-review/{before,after,after-dark}/`. Give the
absolute path in your report. Look at them yourself before reporting: overlap, clipping,
wrong-way icons, unreadable dark text.

### H4. Suites to run (report exact counts)
`npm run typecheck`, `npm test` (unit, both workspaces), `npm run e2e` (full). The API is
untouched, so **skip `test:integration`** and say so.

---

## Commits (suggested order — one or more per phase)
0. this file → `docs/development/wp-design-review.md`
1. A + B (tokens, contrast, spacing, tokens.test.ts)
2. C (portal phone nav, icons, topbar, headings, touch targets)
3. D (public nav disclosure)
4. E (content and craft)
5. F (semantic tokens — no visual change)
6. G (dark)
7. H2 e2e spec and spec updates

## Out of scope
The desk's own layout (only shared tokens reach it — check `/en/desk` once in light and dark
and report anything broken, do not redesign it); `wp-dashboards.md` items other than #10; any
API change; adding a hero CTA.

## Report additions (beyond the common brief)
- Before/after screenshot folder path.
- The final light and dark token tables with computed ratios (paste the test's pair list).
- Every Persian string you wrote that this brief did not give.
- Every place you deviated from a value or rule in this brief, and why.

---

## Record: built and reviewed (2026-10-08)

**Built:** Sonnet lane, branch `wp-design-review`, commits `af6bf60`…`6863a23`, on `9650aa2`.
**Reviewed:** Claude Opus, who reran every suite from the lane's worktree. Ports 5241/5245 were used for the rerun.

### Suites (reviewer's run)
- `npm run typecheck`: clean, web and api.
- `npm test`: api 1064/1064, web 334/334. The web count includes the 7 tests in `tokens.test.ts`.
- `npm run e2e` (msedge): **129 passed (15.0m)**. That is the 114 existing tests plus 15 in `26-design-review.spec.ts`.
- `test:integration` was not run, because the API is untouched.

### What the review checked
- **The diff, against each phase.**
- **The before, after and dark screenshots** (`apps/web/.playwright/design-review/`, gitignored). Phone and desktop, in fa and en, for:
  - the landing page, About and the Library;
  - the sign-in page;
  - the customer Dashboard, Contracts, Invoices, Support and a contract detail page.
- **The dark token block, against the brief's table.** All values match.

### Review fix (reviewer's commit)
- `.shell > .footer { margin-block-start: auto; }` keeps the footer at the bottom of short pages. Without it, a band of page ground showed under the footer, in light and dark. This was already there before the package. Checked by measurement: the footer's bottom equals the viewport height at 1440×900 in both appearances.

### Accepted deviations from the brief
- **Phone tab bar padding** is `space-1`, and link `padding-inline` is 0, so the Persian «صورت‌حساب‌ها» fits at 390px.
- **Topbar `start`** is an empty crumb on the five list pages. The desktop topbar's start side is now empty there. It's a founder call whether to put a non-heading label back.
- **`placeholder-ink`** moves to indigo-400, and the focus ring on indigo grounds uses cyan-300. Both are contrast fixes found by the test.
- **The "Clear filter" link** on the Library list now also clears search and type. One reset, one meaning.
- **`tokens.test.ts` is stricter than briefed.** It rejects raw ramps and hex values outside `tokens.css` and `print.css`, and it checks the vars in TSX too. Kept.

### Founder-visible (needs the founder's eye before merge)
- The landing's growth cards lose their frame and keep the clay top rule (E1).
- **Dark appearance** follows the system everywhere, the desk included, with no toggle. The dark palette is new brand colour. Paper documents and the customer-site frame stay light.
- On a phone:
  - the portal has a bottom tab bar with icons;
  - the public nav sits behind a Menu button.
- The topbar title is removed on the portal list pages.

### Owed, not in this package
- **Opacity on text** remains in three places, which the contrast test can't see: `.review-thread-resolved` (0.7), `.feedback-comment-pending`/`-declined` (0.85), and `.concept-dim` (0.5).
- **The inline agreement sheet** on a contract page is cramped at 390px. This is a pre-existing layout problem in the two-column `doc-facts` and the `.doc` padding.
- **A native speaker** should read the new Persian strings: `nav.menu`, `nav.close` and the five `library.list.*` strings.
- **Real-device checks** are still needed: safe-area on a notched phone, VoiceOver and TalkBack.
- **`.side-soon-tag`** is dead CSS.
- **"About Us"** is still the wording of the desk template page name, `pages.about` in `en.json` and the API `templates.ts`.
- **Evidence path, for future briefs:** don't use `test-results/`, because Playwright empties it on every run. Use `.playwright/`.
