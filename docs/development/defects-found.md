# Defects found while planning — 2026-08-05 · **closed 2026-08-08**

Ten things wrong with the code as it stood at `909399c`. Found by reading, not
by running, so each carries the evidence that convinced me rather than a
reproduction. Two of them a customer could hit.

Each was assigned to the stage that should fix it, so none needed a separate
pass. **Nine were fixed inside their assigned stage, at no schedule cost.** The
tenth was deliberately left as recorded debt.

**Kept as a closed ledger, not deleted.** The reusable part is the pattern: a
reading pass before the first stage found nine real bugs and cost nothing to
act on, and **D1** is the argument for doing it again — a defect that only
becomes *reachable* once a later stage works, which no stage's own testing would
have caught. **Do the same pass before R1.**

| | What | Severity | Fix in | |
|---|---|---|---|---|
| **D1** | The client re-imposes a guard the server deliberately removed, deadlocking a re-opened design step | **live** | V1b (it is two lines) | ✔ `44b2a52` |
| **D2** | `publishContractRevision` creates the revision outside its transaction | latent | V2 | ✔ `ed3aac9` |
| **D3** | The web `ChangeAction` union is missing six values | latent | V1b | ✔ `44b2a52` |
| **D4** | The admin's "Published" column shows `updatedAt` | live, cosmetic | F2 | ✔ `337f952` |
| **D5** | Nothing enforces "at most one unpublished design revision", which the code assumes | latent | V2 | ✔ `ed3aac9` |
| **D6** | `publishDesignRevision` has no `NO_CHANGES` guard, unlike its contract sibling | latent | V2 | ✔ `ed3aac9` |
| **D7** | `nudgeStatus` changes status without a `ChangeLog` entry | latent | V4 | ✔ `337ce1c` |
| **D8** | The portal's staff link is gated on `contracts.manage`, so a reviewer never sees it | latent | F2 | ✔ `337f952` |
| **D9** | `inviteCustomer` cannot set the invitee's locale — every invite link is Persian | live | C0 (or F2) | ✔ `4eb4106` |
| **D10** | `allContracts` fetches the full detail shape for every contract, unbounded | debt | note only | **open** |

**D10 is still open, and R1 is where it stops being harmless.** It was left
because contracts are few and Root-created, so an unbounded fetch has a low
ceiling. The Library is the corpus that is *meant* to grow — `libraryEntries`
written the same way is the same bug with no ceiling at all. [`R1.md`](R1.md)
§4.4 and T1 require that list to be thin and paginated from the first commit;
fixing `allContracts` alongside it is cheap while the shape is fresh in mind.

---

## D1 — the client re-imposes the guard V1 removed · **live**

`apps/web/src/portal/ContractDetail.tsx:233` (concept choice) and
`:304` (page approval):

```tsx
disabled={busy || gate.contractApproved}
```

The server used to refuse those two mutations once the contract was approved.
V1 **removed** that guard deliberately, and `resolvers/customer.ts:32-37`
records why:

> Deliberately *not* gated on the contract being approved or signed. […] The old
> guard read the contract's approval because there was only ever one design;
> keeping it here would reopen the design step and then refuse every action that
> could close it again.

The client's copy of the guard was never removed. So:

1. Customer approves the contract. `gate.contractApproved` is true.
2. Root publishes design v2 with one changed page. Carry-forward resets that
   page's approval; the contract lineage is untouched, so `contractApproved`
   stays true.
3. `gate.designComplete` is now false and the customer must re-approve one page
   — and **both buttons that could do it are disabled**.

This is precisely the deadlock V1 fixed, surviving on the other side of the
wire. It is unreachable today only because no design revision has ever been
published through a UI, which V2 is about to change.

**Fix:** delete `|| gate.contractApproved` from both. The rail's stepper and the
server's assertions are what express the sequence; a disabled button is not the
place for a rule, and this one is not the rule any more. Do it in V1b — it costs
two characters and V3 would otherwise inherit a screen it cannot make work.

---

## D2 — `publishContractRevision` creates outside its transaction · latent

`apps/api/src/graphql/resolvers/admin.ts:323-346`. The `contractRevision.create`
runs on its own, and only the supersede-and-repoint pair is transactional. If
the transaction fails, a revision exists with `publishedAt` set, superseding
nothing, pointed at by nothing. The next publish numbers itself above it, so the
lineage grows a published revision that was never current — invisible to the
customer, and confusing to everyone reading the history panel V1b is about to
expose. `log` and `nudgeStatus` are outside it too.

**Fix in V2**, where this mutation stops being test-only: one interactive
`$transaction(async (tx) => …)` covering create, supersede, repoint and log.

The same file's `publishDesignRevision` computes `carryForward` outside its
transaction from a draft it fetched earlier. Same treatment.

---

## D3 — the web `ChangeAction` union is stale · latent

`apps/web/src/lib/queries.ts:31-43` ends at `STATUS_CHANGED`. Six values are
missing: `CONTRACT_REVISED`, `DESIGN_REVISED`, `CONTRACT_AMENDED`,
`RE_APPROVED`, `RE_SIGNED`, `AMENDMENT_SIGNED`.

It does not break at runtime — `ContractDetail.tsx`'s `logText` map has rows for
all eighteen, so the sentences render. But the type is a lie, and the next
person to write `switch (e.action)` will get a spurious exhaustiveness pass.

`lib/changeAction.test.ts` does not catch it: it checks the Prisma enum, the SDL,
the key map and both locale files — five places — and this union is a sixth it
does not know about.

**Fix in V1b.** Add the six values. Consider whether the drift test should learn
about this file too; if you add it, the regex is the same shape as the one that
reads the SDL.

---

## D4 — the admin's "Published" column shows `updatedAt` · live, cosmetic

`apps/web/src/admin/Admin.tsx:189` heads the column "Published";
`:222` fills it with `fullDateTime(c.updatedAt, …)`. `Contract.publishedAt`
exists on the GraphQL type (`typeDefs.ts:196`) but is not selected by the
`ContractFields` fragment, so the screen cannot show it.

**Fix in F2**, when the table moves into the desk's Contracts section: add
`publishedAt` to the fragment and show the right field, or rename the column to
"Updated". Both are honest; showing one and labelling it the other is not.

---

## D5 — nothing enforces one draft design revision per contract · latent

`resolvers/contracts.ts:96-100` says, in a comment:

> The design revision Root is currently editing: the one with no `publishedAt`.
> **There is at most one.**

That is an assumption held up by nothing. `DesignRevision` is unique on
`(contractId, version)` only. Two concurrent calls to `draftDesignRevision`
both miss the `findFirst`, both create — and the second gets a unique violation
on `version` *only if* they picked the same number, which they will, so the
failure mode is a `DUPLICATE_KEY` error rather than two drafts. But an
interrupted publish, or any future code path that creates a revision, can leave
two, and then `findFirst` picks one arbitrarily and the other becomes an
invisible orphan holding `StoredFile` references alive through
`onDelete: Restrict`.

**Fix in V2:**

```sql
CREATE UNIQUE INDEX "DesignRevision_one_draft_per_contract"
  ON "DesignRevision" ("contractId") WHERE "publishedAt" IS NULL;
```

Prisma can express this — `@@unique([contractId])` cannot be conditional, so it
goes in the migration by hand, like the three CHECK constraints already there.

---

## D6 — `publishDesignRevision` has no `NO_CHANGES` guard · latent

`publishContractRevision` refuses when the draft hashes to the current
revision's `contentHash` (`admin.ts:311`). Its design sibling has no equivalent:
publishing a draft identical to the published revision succeeds, bumps the
version, writes a `DESIGN_REVISED` log line and nudges the contract to
`WAITING_ON_CUSTOMER`. Carry-forward then restores every approval, so nothing
actually changes — the customer is told to look at something that is the same.

This matters more once V2 exists, because `draftDesignRevision` creates a draft
on the *first* edit attempt: an admin who opens the design tab, triggers a
draft, and changes their mind now has an empty draft sitting there.

**Fix in V2:** refuse when `diffDesign(previous.concepts, draft.concepts)`
reports every page `unchanged` and the concept key sets match. Use `design.ts` —
do not write a second comparison (house rule 3). Pair it with a
`discardDesignDraft` mutation, or the refusal becomes a trap of its own.

---

## D7 — `nudgeStatus` changes status without logging it · latent

`resolvers/contracts.ts:87-91` writes `Contract.status` directly. Only the manual
`setContractStatus` writes a `STATUS_CHANGED` entry. So the change log — which
the build plan calls "what the later admin review-flagging queue reads" — cannot
answer *when a contract entered its current status*, and most status changes are
automatic.

V4's "Needs Root queue, oldest first" needs exactly that ordering, and
`updatedAt` is not it: any write bumps it.

**Fix in V4**, and prefer a `Contract.statusChangedAt` column set by both
`nudgeStatus` and `setContractStatus` over logging the nudge. Logging it would
put "Root changed the status to Waiting on Root" into the customer's history
panel immediately after their own comment, which reads as bureaucracy rather
than as information.

---

## D8 — the portal's staff link is gated on the wrong capability · latent

`apps/web/src/portal/PortalLayout.tsx:73` shows the admin link when
`can(me, 'contracts.manage')`. Under F3's role set that is now too narrow: a
`REVIEWER` holds `review.participate` and a `CONTRIBUTOR` holds `library.write`,
and neither would ever see a link to the staff area they were invited for.

**Fix in F2**, where the test becomes "holds any capability at all" — which is
also the sign-in routing rule. Note that this reads naturally off the model
rather than needing a special case: `CUSTOMER` maps to the empty capability set,
so `capabilities.length > 0` *is* "is staff".

---

## D9 — every invite link is Persian · live

`resolvers/admin.ts:75-95`. `inviteCustomer` creates the user without a locale,
so `User.locale` takes its `@default("fa")`, and the returned link is
`${APP_ORIGIN}/fa/portal/invite/${raw}`. There is no argument to say otherwise
and no mutation to change it afterwards.

An English-speaking client's first contact with the product is therefore a
Persian page. The invite screen has a language switch, so it is recoverable —
but the first impression is not.

**Fix in C0** when invite mail is templated in the recipient's locale, which
needs the same field. If F2 gives the desk a customer editor first, fix it
there: add `locale: String` to `inviteCustomer` and default it to the *inviting
user's* locale rather than to `fa`, which is a better guess than the schema's.

---

## D10 — `allContracts` is unbounded and fetches everything · debt

`resolvers/query.ts:40-43` returns every contract with `contractInclude` — which
now reaches the current design revision, its concepts, their pages, the current
contract revision with its signature and every amendment, plus all scope items,
all articles, all comments and the entire change log, per contract.

This is fine at the current scale and stops being fine somewhere around fifty
contracts or one long-running one. Not worth fixing now; worth **not making
worse**, which is why V1b puts the revision lineages on lazily-resolved fields
rather than into `contractInclude`.

The same applies to `changeLogs` inside `contractInclude`: unbounded, ordered
desc, refetched by `reload()` after every single mutation.
