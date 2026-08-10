# V1b · The draft, made readable

**Branch:** `stage-v1b-draft`
**Needs:** nothing. **Blocks:** V2.
**Shape:** API only. No screen, no new component, no CSS.
**Spec:** in none — this stage exists only in the build plan (§3, §4).

**Acceptance, verbatim from the build plan:**

> A `setArticle` write round-trips in a query, and customer-facing output is
> byte-identical.

---

## 1 · Why this comes before the workspace

The draft is invisible to GraphQL — not merely to the customer, but to Root.

- `Contract.articles` resolves out of the **published snapshot**
  (`resolvers/fields.ts:33`), while `setArticle` writes mutable **`Article` rows**
  (`resolvers/admin.ts:258`).
- `Contract.concepts` reads the **current design revision**
  (`fields.ts:25`), while `addConcept` writes into an **unpublished draft**
  (`admin.ts:149`).

Both are correct for the customer-facing surface. Both mean the same thing for
an editor: **a form whose response never reflects what was just typed.** V2's
first screen would discover this, and would probably discover it by "fixing"
`Contract.articles` to read the draft — which would show every customer Root's
unpublished working copy.

So the draft gets its own name on the wire, and the published surface is not
touched.

---

## 2 · What exists, and what it already gives you for free

`contractInclude` (`resolvers/contracts.ts:29`) already fetches
`articles: { orderBy: { number: 'asc' } }` on every contract read. Those rows
**are** the contract draft. `Contract.draft` therefore needs no query of its own
— it is a pure reshaping of data the resolver already holds. Keep it that way.

The design draft is not in that include, and must not be added to it — see
trap **T3**.

`lib/revision.ts` already has everything needed to hash a draft:
`buildContractSnapshot`, `contentHash`, `SNAPSHOT_FORMAT`. It is a pure module
with no Prisma import. Keep that too.

---

## 3 · The work

### 3.1 · One shared draft-state helper — do this first

`publishContractRevision` already computes the draft's hash and refuses with
`NO_CHANGES` when it matches the current revision (`admin.ts:309-315`). The
`dirty` flag this stage exposes is **the same question**. If they are computed
in two places they will disagree, and the disagreement will look like a
disabled button that refuses to publish or an enabled one that errors.

Add to `apps/api/src/lib/revision.ts` — structural types only, no Prisma:

```ts
export type DraftState = {
  snapshot: ContractSnapshot;
  /** The hash this draft would publish as. */
  hash: string;
  /**
   * True when publishing would produce something different from what is live.
   * An absent current revision counts as dirty, and so does an *unsealed* one —
   * a backfilled v1 has no hash to compare against, and treating "no hash" as
   * "unchanged" would refuse the very publish that seals it.
   */
  dirty: boolean;
};

export function draftState(
  contract: ContractDraft,
  articles: ArticleDraft[],
  current: { contentHash: string | null } | null,
): DraftState;
```

Note the name collision to avoid confusion: `revision.ts` already has a local
`type ContractDraft` (line 73) describing the title/fee/ref shape. The GraphQL
type added below is also called `ContractDraft`. They are the same idea at two
altitudes and the collision is harmless — do not rename either.

Then **rewrite `publishContractRevision` to call it** and refuse when
`!dirty`. That is the whole point of extracting it.

### 3.2 · Schema additions

To `apps/api/src/graphql/typeDefs.ts`. Every one of these is an **addition** —
change no existing field, and the acceptance test's second half is satisfied by
construction.

```graphql
"""
Root's working copy: the mutable Article rows plus the title and fee on
Contract. Nothing here has been handed to the customer — publishing is what
does that.

Staff only. Null for everyone else, rather than an error: the customer's own
client never asks for it, and a refusal would confirm the field means something.
"""
type ContractDraft {
  titleFa: String!
  titleEn: String!
  "Toman, as a decimal string."
  amount: String
  articles: [Article!]!
  "The hash this draft would publish as, from the same canonical form the publish path uses."
  contentHash: String!
  """
  Whether publishing would change anything. This is exactly the condition
  publishContractRevision enforces, so a disabled button and a NO_CHANGES
  refusal cannot disagree.
  """
  dirty: Boolean!
}

"""
The unpublished design revision, if one exists. Staff only.

**Reading this never creates one.** The draft comes into being on the first
edit, not on the first look — see draftDesignRevision.
"""
type DesignDraft {
  id: ID!
  version: Int!
  concepts: [DesignConcept!]!
}

"One entry in the contract lineage. A list of what happened, not a document."
type ContractRevisionSummary {
  id: ID!
  version: Int!
  contentHash: String
  publishedAt: DateTime
  approvedAt: DateTime
  supersededAt: DateTime
  signedAt: DateTime
  amendmentCount: Int!
}

type DesignRevisionSummary {
  id: ID!
  version: Int!
  publishedAt: DateTime
  supersededAt: DateTime
  conceptCount: Int!
  pageCount: Int!
}

type Contract {
  # …existing fields unchanged…
  "Staff only; null otherwise."
  draft: ContractDraft
  "Staff only; null otherwise."
  designDraft: DesignDraft
  "Both lineages, newest first. Non-staff see published revisions only."
  contractRevisions: [ContractRevisionSummary!]!
  designRevisions: [DesignRevisionSummary!]!
}
```

### 3.3 · Resolvers

All four go in `apps/api/src/graphql/resolvers/fields.ts`, on the existing
`Contract` object, alongside `revision` — that file is already where "what a
stored row looks like over the wire" lives, and two of these carry a visibility
rule, which is the kind of thing its header says belongs there.

- **`draft`** — `requireUser(ctx)`, then `can(user, 'contracts.manage')`; return
  `null` if not. Otherwise build from `c` directly: title and fee off the
  contract, `c.articles` as-is (already ordered), and `draftState(c, c.articles,
  c.currentContractRevision)` for `contentHash` and `dirty`. No query.
- **`designDraft`** — same guard, then
  `prisma.designRevision.findFirst({ where: { contractId: c.id, publishedAt: null }, include: conceptsInclude })`.
  **A plain read. Never `draftDesignRevision`.** See trap **T1**.
- **`contractRevisions` / `designRevisions`** — one query each, `orderBy:
  { version: 'desc' }`, and for a non-staff caller add `publishedAt: { not: null }`
  to the `where`. Counts come from `_count`.

`amendmentCount` and `signedAt` want `include: { _count: { select: { amendments: true } }, signature: true }`
— or a `select`. Prefer `select`, since a summary that quietly drags a whole
signature row across is how a "thin" type stops being thin.

### 3.4 · Two defect fixes that belong here

- **D1** — delete `|| gate.contractApproved` from
  `apps/web/src/portal/ContractDetail.tsx:233` and `:304`. Two characters, and
  V3 inherits a screen that can actually reach its own steps. Read
  [`defects-found.md`](defects-found.md#d1) before doing it; it changes visible
  behaviour, deliberately.
- **D3** — add the six missing values to the `ChangeAction` union in
  `apps/web/src/lib/queries.ts:31`.

Do **not** also add the new types to `queries.ts` or to the `ContractFields`
fragment. Nothing on the client reads them yet, and a fragment that selects
staff-only fields would make every customer's query carry four extra nulls.
F2 and V2 add them where they are used.

---

## 4 · Traps

### T1 · Reading `designDraft` must not create one · **the important one**

`draftDesignRevision` (`resolvers/contracts.ts:101`) **creates** a draft when
none exists, by cloning the published revision's concepts and pages. That is
right for the mutation path — an edit needs somewhere to land.

If a *field resolver* calls it, then merely opening a contract in the workspace
clones the published revision into a permanent draft. Then:

- every contract Root has ever looked at has a design draft sitting on it,
- `publishDesignRevision` finds a draft and cheerfully publishes an identical
  v2 (there is no `NO_CHANGES` guard — defect **D6**),
- the customer is told the design changed, and it did not.

`Contract.designDraft` is a **pure read**: `findFirst`, `publishedAt: null`,
return `null` when absent. Creation stays on the mutation path, where an
intention to edit has actually been expressed.

### T2 · `dirty` must treat an unsealed revision as dirty

A revision created by the backfill migration has `snapshot` and `contentHash`
null — legal, and it means "not sealed yet". Comparing `null !== hash` gives
`true`, which happens to be the answer we want, but write it deliberately rather
than relying on the coincidence:

```ts
dirty: current === null || current.contentHash === null || current.contentHash !== hash
```

The reason it is the right answer: publishing is what seals an unsealed
lineage, so the publish path must stay open.

### T3 · Do not put the lineages in `contractInclude`

`allContracts` (`query.ts:40`) returns **every** contract with the full
`contractInclude` shape. Adding two more relations there multiplies a query that
is already the heaviest thing in the API (defect **D10**). The lineage fields do
their own query and only when selected, which is exactly what field resolvers
are for. The workspace fetches one contract; the list screens never ask.

### T4 · Draft article ids and snapshot article ids are different, and that is correct

`Contract.articles` synthesizes ids as `${revisionId}:${number}`
(`fields.ts:37`) because a snapshot article is a position in a frozen document,
not a row. `ContractDraft.articles` returns real `Article` rows with real cuids.

So the same logical article appears twice in one query result, under two ids,
with possibly different text. That is not a bug — it is the entire point of this
stage, and Apollo's cache normalizes them as two distinct `Article` entries,
which is what makes an editor able to show "draft" beside "published". A cuid
never contains `:`, so the two id spaces cannot collide.

**Do not "fix" the synthetic id.** Making snapshot articles carry row ids would
mean an edit to a draft row visibly rewriting the published document in the
customer's cache.

### T5 · `null`, not `FORBIDDEN`, for a customer asking for `draft`

The rest of the ownership layer answers "not yours" with absence —
`loadForActor` returns `NOT_FOUND` for a contract that exists but is not the
caller's. A `FORBIDDEN` on this field would be the only place in the API that
confirms something exists and is being withheld, and it would arrive as a
partial-error response on a query that otherwise succeeded.

The pattern to copy is `ContractRevision.amendments` (`fields.ts:72`): guard in
the field resolver, next to the thing it protects, and shrink the answer rather
than failing the request.

### T6 · `amount` is `BigInt`

`ContractDraft.amount` is `c.amount === null ? null : c.amount.toString()`.
House rule 9. It throws at serialization, not at compile time.

### T7 · Article ordering

`ContractDraft.articles` inherits `orderBy: { number: 'asc' }` from
`contractInclude`. If you ever fetch them separately, carry the ordering — and
note that `buildContractSnapshot` sorts internally on purpose
(`revision.ts:104`), precisely so the snapshot never depends on an `orderBy`
living somewhere else. Do not remove that sort because the caller already sorts.

---

## 5 · Tests

**Unit** — `apps/api/src/lib/revision.test.ts`:

1. `draftState` is dirty against a null current revision.
2. …dirty against an unsealed current revision (`contentHash: null`).
3. …clean when the hash matches.
4. …dirty after one article's body changes, clean again when it changes back.
   (This one is worth writing because it is the behaviour that will look like a
   bug to a user: fix your typo and the publish button goes away.)

**Integration** — `apps/api/src/test/resolvers.test.ts` or a new
`src/test/draft.test.ts`:

5. **The acceptance test.** As admin: `setArticle` on number 2 with new text,
   then query `contract(id) { draft { articles { number bodyEn } } }` and see
   it. In the same query select `articles { number bodyEn }` and see the *old*
   text. One test, both halves.
6. `draft` is `null` for the contract's own customer, and the query still
   succeeds with no `errors` entry.
7. `designDraft` is `null` on the fixture (which has no draft), **and**
   `prisma.designRevision.count()` is unchanged after asking for it. This is
   trap T1, held by a test.
8. After `addConcept` creates a draft, `designDraft` is non-null and carries the
   new concept; `contract.concepts` still shows the published revision's three.
9. `designRevisions` as a customer excludes the unpublished one; as admin,
   includes it.
10. `dirty` is `false` on the freshly seeded fixture, `true` after `setArticle`,
    and `publishContractRevision` refuses with `NO_CHANGES` exactly when `dirty`
    is false. Assert both in one test so they cannot drift.

**Byte-identical, how to actually check it.** The 52 existing integration tests
are the check: they assert the customer-facing surface in detail and none of
them may change. If one needs editing to pass, that is the failure signal, not a
chore. Beyond that, test 6 above is the only new customer-facing assertion
needed, because **this stage adds fields and changes no existing resolver** —
apart from `publishContractRevision`, which is not a read.

**e2e** — none new. But run the suite: D1's fix changes two `disabled`
attributes, and `02-contract-flow.spec.ts` drives those buttons.

---

## 6 · Done when

- [ ] `draftState` lives in `lib/revision.ts` and `publishContractRevision`
      calls it — one computation, not two.
- [ ] The four fields exist, are staff-gated where stated, and `designDraft`
      provably creates nothing.
- [ ] D1 and D3 are fixed.
- [ ] `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run e2e`
      all green.
- [ ] `prisma migrate diff` reports no drift — **this stage adds no migration**,
      so if it reports any, something was changed in `schema.prisma` that should
      not have been.
- [ ] The portal was opened in a browser in both languages and looks exactly as
      it did, except that D1's buttons are now enabled.
- [ ] A short "what the build settled that the plan had not" note is written for
      the build plan's next version.
