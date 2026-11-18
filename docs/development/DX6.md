# DX6 — the founder's walk through steps 1–3 (2026-11-18)

**Built:** 2026-11-18 · **From:** the founder's live walk of the desk on local `main` (no spec change yet; root-sot's review file 0.2 §6 to gain these at close-out)
**Branch:** `dx6-walk`, from `main @ 665f614`. **One migration:** `20261118124529_dx6_extras`. It adds the `ExtraType` table, seeded from `CHECKLIST`, and replaces `ContractBrief_allowances_positive` with `_not_negative`. Built by a Sonnet lane, reviewed by Opus. Before it, two small rounds of walk fixes went straight onto `main` (`4e6e9ca`, `665f614`):
- the selected step pill keeps only its start bar;
- the "N missing" line sits under each pill;
- the calendar opens from the date field;
- counts are a track of chips;
- a new handover item takes who and when, with labels;
- "New site type" from Requirements;
- articles start folded;
- cards in the tabs use the status box's background;
- the Requirements panel is called Dependencies.

## Built

- **Zero is a count.** Rounds and iterations may be 0, meaning one presentation with no rounds of change (`isExhausted` uses `max(allowance, 1)`). Support months has a 0 pill.
- **The budget is the fee.** Saving either one sets the other, each in one transaction behind its own lock. Clearing one never clears the other.
- **Dependencies are decided before the contract goes out.** `COMMITMENT_UNDECIDED` keeps Requirements open and refuses publishing until every in-brief row has a side or "Not needed", and a date unless it isn't needed. This reverses decision 17.
- **Extras are managed.** A Templates → Extras tab edits the default list (`ExtraType`), which new contracts are seeded from. A contract can add and remove its own one-off extras. Each extra is one checkbox, labelled by its words.
- **No separate registry.** `ScopeRegistry` is deleted. Each page, feature, deliverable and ticked extra shows chips for its status, phases and set flags. Its own Details drawer holds status and decision, phases, flags, trade, rename, order and delete.
- **Labels on every phase and plan field**, and proposed and added plan rows share one editor.
- **One way to add things** (`InlineAdd`): a button opens a small labelled form; Enter adds, Escape cancels. It's used for articles, amendments, phases, scope items, extras, handover rows, the Dependencies tab, demo pages, palette items and notes.
- **Templates → "Default dependencies"** (it was "Handover items"), with a line saying what it seeds.

## Not reproduced

- **The site type not saving** (the founder's report): both flows persist across a reload in e2e. The just-made type is now kept as an option until the list refetches, and `38-walk` guards both flows. The "New site type" button needs `templates.types`, which sales doesn't hold.

## Verification

typecheck clean · unit 1099 API + 372 web · integration: the full suite, 1345/1345 (review) · e2e, Chrome, slot A: `38-walk` (13, new), and a sweep of 79 tests over the adapted specs. `17-requirements` failed once in a large run and passed 5/5 alone (the DX4 autosave timing).
