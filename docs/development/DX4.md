# DX4 — one title field, and fields that save themselves (desk UX review, stage 4)

**Built:** 2026-11-17 · **From:** root-sot `studio/desk-ux-review` @ 495c4bc, items 26 and 27 (founder: a missing language falls back plainly, no mark)
**Branch:** `dx4-titles`, from `main @ e9b5a93`, with DX3c merged in. **One migration:** `20261117190000_dx4_titles` — nine hand-written CHECKs `<Table>_one_title`, at least one language non-blank, on Contract, Article, Amendment, Phase, ScopeItem, PlannedInvoice, Dependency, DemoPage and PageDesign. **`NOT VALID`** (added in review): enforced on every write, existing rows not scanned, so the deploy can't fail on an old row. Built by a Sonnet lane, reviewed by Opus.

## Built

- **Either language is enough** for the titles typed on the contract workspace. The columns stay `NOT NULL`; the other one may be `''`. API: `lib/titles.ts` (`requireOneTitle`, `hasOneTitle`, `inLocale`), used by the contract, amendment, phase, registry, dependency and design resolvers, `plan.ts` and `scopeProposals.ts`; `notify.ts` fills a blank half once, so every mail falls back. `LABEL_REQUIRED` keeps its name and now means both blank. Web: `pick()` falls back; the attention titles go through it. Snapshots keep their shape (format 3; the format-2 hash test green).
- **`TitleField`**: one input that stores what is typed in the language its script says (Persian or Arabic letters → Fa; digits only → the panel's language), with "Add the other language" for the second. Used on the new-contract form, the Contract tab, articles, amendments, phases, plan rows, scope items (add, rename, decide), handover rows, demo pages and page designs.
- **Autosave** (`lib/useAutosave.ts`, `AutosaveNote`): text fields save on blur, selects, pills and steppers at once, through each card's existing mutation; one "Saved" note per card where its Save button was. Add, Publish, Mark delivered, Mark phase done and Delete stay buttons. Locked steps don't save.

## Decided

1. **Titles outside the contract workspace keep both languages required**: library, templates, services, site types, palette items, design concepts.
2. **A half-typed value is not saved**, silently; the field keeps it.
3. **Choosing the brief's kind saves at once**, so the existing-site preset runs on that choice.
4. **The payment-schedule article is still found by its English title** (`isPaymentScheduleArticle`): the template's article has both.

## Fixed at the final milestone

- **The existing-site preset didn't run from the kind select, and the next save would have undone it.** The select commits before its new state renders, so the save read the old kind. It never showed the notice, and it left the form's design tier stale, so the next blur sent it back over the preset's No design. The save now decides from the values it carries (`RequirementsEditor`).
- **A change made during a save could be lost.** `useAutosave` dropped the value a commit asked for while a save was in flight, and `HandoverPanel` cleared every pending edit after each save, including ones made meanwhile. The hook now queues the value, and the panel clears only the edits that save carried. `35-handover` and `17-requirements` then ran green 27 times out of 27 (`--repeat-each=3`).

## Found, not fixed here

- **`useAutosave` has no unit test of its own**; it is covered by `36-titles` and the converted specs.

## Verification

typecheck clean · unit 1098 API + 367 web · integration: `dx4` (13, new: the nine CHECKs by direct insert, one-language mutations, a format-3 agreement signed and read back in both languages, a mail in the language with no title), `j4 j5 j6 j7 j8 t1 sc1 dx2a dx2b dx3a dx3b` · e2e: `36-titles` (4, new). The final milestone (the full suites, everything merged) is recorded in the README's sequence.
