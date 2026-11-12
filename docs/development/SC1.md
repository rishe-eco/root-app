# SC1 — Root adds pages, features and deliverables straight into step 2a

**Built:** 2026-11-12 · **Asked by:** the founder, after walking the portal (no change note in root-sot yet)
**Branch:** `sc1-scope-add-item`, stacked on `fix-agreement-view-as` (VA1). No migration.

On a new-road contract, the "Pages and features" step gave staff two ways to fill the list: apply the site type's template, or confirm a customer's proposal. Anything else meant editing the site type's template, which changes every future contract of that type. A type whose template was empty made the step impossible (`TEMPLATE_SCOPE_EMPTY`). The API already had `addScopeItem`, but no screen on this step.

## Built

- **API, `addScopeItem`:** `key` is optional. Without one the item takes the next `custom.<n>` on the project (`nextCustomKey`, the rule a confirmed proposal uses), under the contract and project row locks. Refusals: `LABEL_REQUIRED` (blank, after trim), `INVALID_KEY` (`checkScopeKey`, so `checklist.*` too), and `KEY_TAKEN` instead of a raw unique violation.
- **API, `applyScopeTemplate`:** `SCOPE_ALREADY_SEEDED` now means *the template is applied* (`templateApplied`, `lib/scopeProposals.ts`): an item of this contract carries a template key, plain or with `seedRows`' suffix. Hand-added `custom.<n>` items don't count. Before this, adding an item first would have made the template unreachable for good. `scopeSeeded` (the step's done signal) is unchanged: a contract with only hand-added items has a scope, and the step is done.
- **API, `Contract.scopeTemplateApplied`:** the same answer, so the desk offers the seed card exactly while it would work.
- **API, `deleteScopeItem`:** `ITEM_IN_USE` when a note (`FeedbackItem.anchorScopeItemId`), a proposal or a trade points at the item. Notes and proposals *cascade* on delete, so before this a delete silently erased the customer's words.
- **Web, `ScopePanel`:** `AddItemForm` (kind, both labels) for `contracts.author` while the step is open. Per item, `StaffItemActions`: **Remove** (delete, with a confirm) before the handover; **Take out…** (decline with a reason, which the customer reads under "left out" and can ask to bring back) after it. The seed card follows `scopeTemplateApplied`, not "no items".
- **Locales:** `scope.add.*`, `scope.staffRemove.*`, `scope.error.ITEM_IN_USE`. `lede.staff`, `empty.staff`, `error.LABEL_REQUIRED` and `error.SCOPE_ALREADY_SEEDED` reworded. Both languages.

## Decided

1. **Hand-added items never touch `TemplateScopeItem`.** The founder's ask exactly: this contract, not the type.
2. **Remove depends on the handover, not on who added the item.** No column records who added a row, and adding one isn't worth a migration. Before the handover the customer can't have noted or proposed on anything (`canRaise`/`canPropose` need `publishedAt`), so a delete loses nothing. After it, a decline is what the customer can see and answer.
3. **`ITEM_IN_USE` applies to the legacy Scope tab's delete too.** A cascade that deletes a customer's note is wrong on either road.
4. **The add form offers PAGE, FEATURE and DELIVERABLE only.** Extras belong to step 1 (`NOT_PROPOSABLE`'s reasoning). The API still takes `EXTRA` for the legacy tab.

## Verification

typecheck clean · unit 1065 API + 335 web · integration: `sc1` (5, new), `j5`, `t1`, `j7`, `v2`, `j3` (126) · e2e: `28-scope-add` (3, new: English and Persian, staff and customer), `18-scope-draft`, `14-wizard`, `04-workspace` (14). Chrome, default slot.

**Not verified:** the Persian copy by a native reader. The delete path in a browser: e2e's contract is handed over at step 1, and integration covers the delete.
