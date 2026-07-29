# Root Website — ریشه

The public front (Landing, About Us) plus the authenticated customer portal
(Contracts list and the interactive contract detail). Persian-first, bilingual,
full RTL.

**Source of truth:** `ecosystem/working/root-website-v3-overview.md` (the
application layer) and `ecosystem/working/root-website-requirements_2.md`
(process, type scale, spacing, i18n rules), both in the
[`rishe-eco/root-sot`](https://github.com/rishe-eco/root-sot) docs repo — locally
at `../root-sot/`. Where the two disagree about **colour**, neither wins —
`apps/web/src/styles/tokens.css` does; see "Design system" below.

---

## Quick start

```bash
npm install

# See the whole thing without a database (in-memory data, port 5174)
npm run dev:demo --workspace=apps/web
```

That is the fastest way to review what exists. For the real stack:

```bash
docker compose up -d db                 # Postgres on :5432

cp apps/api/.env.example apps/api/.env  # then fill in JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

npm run prisma:migrate --workspace=apps/api   # create the schema
npm run seed --workspace=apps/api             # one contract + two accounts

npm run dev:api                         # API   → http://localhost:4000/graphql
npm run dev                             # Web   → http://localhost:5173
```

Seeded accounts are `admin@root.local` and `nahal@example.com`, both with the
password `change-me-please`. **Change them before this touches anything real.**

---

## Layout

```
apps/web        Vite + React + TypeScript
  src/styles    tokens.css and kit.css (carried over verbatim from the
                design handoff) + the page-specific layout on top
  src/i18n      fa.json / en.json — every string in the product
  src/pages     Landing, About, reserved sections, 404
  src/portal    auth screens, app shell, contracts, contract detail
  src/admin     the thin operational admin
apps/api        Express + Apollo Server + Prisma
  prisma        schema.prisma, seed.ts
  src/graphql   SDL + resolvers
  src/auth      password hashing, session and link tokens
  src/lib       gate.ts — the approval rule, in one place
```

## Design system

`tokens.css` and `kit.css` came from the handoff and are the portable layer —
edit them, not the components. Every colour, size, space and radius in this
repo is a token reference; there are no raw values in component CSS.

Two rules the token layer enforces for Persian, because breaking them is
silent: **never letter-space** Persian (it breaks the connected script) and
**never uppercase** it (Persian has no case). `base.css` undoes both for the
kit classes that apply them to Latin.

## Bilingual & RTL

The locale lives in the URL prefix (`/fa/...`, `/en/...`) and everything else
follows from it — the i18next language, `<html lang>`, `<html dir>`, the font
family, the line height. `/` redirects to the visitor's best guess.

All layout uses logical properties (`padding-inline`, `margin-inline-start`,
`inset-inline-start`), so RTL mirrors without a second stylesheet. No UI text
is typed into a component; adding a third language means adding one JSON file.

## The gate

The core rule of the contract detail page:

> design approved & complete → unlock *approve contract* → unlock *e-sign*

Design complete means a concept is chosen **and** every page under it is
approved. Choosing a different concept resets those approvals. Commenting and
the scope checklist are **never** gated.

This is computed and enforced in `apps/api/src/lib/gate.ts` and re-derived on
every read. The client's copy of the rule is a convenience for rendering — a
request that skips a step is refused by the server.

## Change tracking

Every meaningful action is logged with actor and timestamp: comment, concept
choice, page approval and un-approval, design completion, contract approval,
scope toggle, signature, status change. This is what the later admin
review-flagging queue reads, so it is captured from the start.

Log entries store the *action* plus one variable argument; the sentence is
built in the reader's language on the client, so history reads correctly in
both languages.

## Contract status

Permissive by design. A contract does not march through the statuses in order —
Waiting on Customer and Waiting on Root are a "whose court is the ball in"
toggle, not stages. Any status can move to any other, and Root always has a
manual override in the admin. The automatic transitions are defaults, not
rails: a customer comment moves it to Waiting on Root, signing moves it to In
Progress.

---

## State of play

**Built and working**

- Landing and About, both languages, matching the handoff designs.
- Locked nav slots (blurred label + padlock), with `.sr-only` text for screen
  readers.
- Auth: sign in, invite acceptance, password reset request and completion.
  Sessions are httpOnly cookies; link tokens are stored only as hashes.
- Portal shell, contracts list with status filter chips and counts.
- Contract detail: all five sections, the gate, the rail's status stepper and
  the history log.
- Role-aware GraphQL API with the full Phase-1 mutation set.
- Thin operational admin: issue invites, publish contracts, move status.

**Verified how:** the public pages and the whole portal flow were driven in a
browser in both languages — concept choice, four page approvals, contract
approval and the e-signature unlocking in order. Both workspaces typecheck and
the web app builds clean.

**Not built** — reserved, not started

- Services (the WooCommerce import), Billing and Support are modelled in the
  database and reserved in the nav, but the screens are honest stubs.
- Design concept and page-design **image upload**. The schema has `imageUrl` on
  both and the UI renders an image when one is present; the admin has no upload
  form yet, so previews fall back to the placeholder block.
- Creating a contract and entering article text from the admin UI — the
  mutations exist (`createContract`, `addConcept`, `addPageDesign`,
  `addScopeItem`, `setArticle`) but only the seed script calls them.

**Never run here.** This machine has no Postgres and no Docker, so the API has
never been started against a real database and the migration has never been
generated. The schema, resolvers and seed are written and typecheck, but
`prisma migrate dev` is the first thing to run — and the first thing likely to
need a fix.

## Open questions

1. **Email.** Nothing sends mail. Invite links are returned once by the
   `inviteCustomer` mutation and reset links are written to the API log, for an
   operator to pass on by hand. Both spots are marked `TODO(email)`.
2. **The contract text.** Articles 1–3 carry the real text from the handoff;
   4–15 have titles only and render a placeholder line. Paste the real
   articles in and they appear.
3. **Copy that is mine, not yours.** Landing, About, Contracts and the contract
   detail use your copy verbatim from the prototypes. The auth screens, the
   admin, the stub sections and the empty states are my drafts in both
   languages — read them.
4. **The landing CTA** is hidden — the hero ends at the lead paragraph. Its
   copy is still in the locale files under `landing.cta`, so bringing it back
   is one line in `pages/Landing.tsx` once its destination is decided.
5. **Locked slot behaviour.** The routes exist and say "coming later"; the nav
   does not link to them. Confirm that is the intent, or make them inert.

## Repo

`rishe-eco/root-app` — code only; the canon and specs live in the sibling
[`rishe-eco/root-sot`](https://github.com/rishe-eco/root-sot) docs repo, so the
two stay separate.

*Renamed 2026-07-29.* This was `root-website`, developed standalone and then
nested inside the docs folder. It moved out to `E:\_root\root-app` alongside its
siblings, adopting the planned `root-app` name; the branch was renamed `master`
→ `main` to match them. The three commits of history are unchanged.
