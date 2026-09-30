import type { ScopeStatusLike } from './scope.js';
import { scopeKindForKey, TEMPLATE_KINDS } from './templates.js';

/**
 * Step 2a's rules (journeys build plan J5) — pure, so `scopeProposals.test.ts`
 * can table-test them and the resolvers (`resolvers/scope.ts`,
 * `resolvers/wizard.ts`, `resolvers/admin/contracts.ts`) read one copy of each.
 *
 * ## What a proposal is
 *
 * A customer can ask for three things on their contract's scope: **add** a page,
 * a feature or a deliverable (`ADD`), **take one away** (`REMOVE`), or **bring a
 * declined one back** (`RESTORE`). They write one sentence in one language;
 * a registry item needs both labels. So the proposal keeps their words and sales
 * decides it — accepting an ADD is when the bilingual item is written — and
 * "the scope is confirmed" is *derived*: no proposal is left undecided
 * (`scopeConfirmed`). There is no `confirmedAt` to keep in step with anything.
 *
 * ## Which items proposals are about
 *
 * Pages, features and deliverables — never `EXTRA`. The completeness
 * checklist's rows are step 1's toggles (`setExtra`, sales' side, with the
 * customer's say through a note on the `extras` brief field); a customer
 * "unticking" one is not a scope negotiation, it is a comment on the brief.
 */

export type ProposalKind = 'ADD' | 'REMOVE' | 'RESTORE';
export type ProposalDecision = 'ACCEPTED' | 'DECLINED';

/** What the customer may ask to add — the kinds a template's own list holds
 *  (`EXTRA` is step 1's, never a proposal's). */
export const PROPOSABLE_KINDS = TEMPLATE_KINDS;
export type ProposableKind = (typeof PROPOSABLE_KINDS)[number];

export const isProposableKind = (kind: string): kind is ProposableKind =>
  (PROPOSABLE_KINDS as readonly string[]).includes(kind);

/** Long enough for a paragraph of what someone wants, short enough that the
 *  desk queue and the notification stay readable. */
export const MAX_PROPOSAL_TEXT = 1000;
export const MAX_DECLINE_REASON = 1000;

export type ProposalTextProblem = 'EMPTY_PROPOSAL' | 'PROPOSAL_TOO_LONG';

export function checkProposalText(text: string): ProposalTextProblem | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'EMPTY_PROPOSAL';
  return trimmed.length > MAX_PROPOSAL_TEXT ? 'PROPOSAL_TOO_LONG' : null;
}

/** The two languages the product has. A proposal in a third is not one sales
 *  could label, so it is refused at the door. */
export const isProposalLang = (lang: string): lang is 'fa' | 'en' => lang === 'fa' || lang === 'en';

// --- what is confirmed ------------------------------------------------------

/**
 * **The plan's `scopeConfirmed`: no proposal is left undecided.** That is all
 * "confirmed" means for step 2a — the customer's asks have all been answered —
 * and it is true of a contract that has never had a proposal, which is why it
 * cannot be the step's done signal on its own (`scopeStepDone`).
 */
export function scopeConfirmed(proposals: ReadonlyArray<{ decidedAt: Date | null }>): boolean {
  return proposals.every((p) => p.decidedAt !== null);
}

/**
 * Whether a contract's scope has been *seeded*: it has at least one page,
 * feature or deliverable of its own. Whichever way it got there — the
 * template (`applyScopeTemplate`), the desk (`addScopeItem`), an accepted ADD —
 * a contract with a scope is one whose scope can be confirmed, and one with
 * none is one nobody has scoped yet.
 *
 * **Per contract, not per project** (PD-5, J2): the project's registry is shared
 * by its contracts, and each item remembers the contract that agreed it
 * (`ScopeItem.contractId`). A second contract on the same project starts with
 * no scope of its own even though the project's registry is full — its
 * "already seeded" is the question about *its* rows. The completeness
 * checklist (`EXTRA`, one set per project, created with the first contract) is
 * a different mechanism and never counts.
 */
export function scopeSeeded(items: ReadonlyArray<{ kind: string; contractId: string | null }>, contractId: string): boolean {
  return items.some((i) => i.kind !== 'EXTRA' && i.contractId === contractId);
}

/**
 * Step 2a's "done" signal (`resolvers/wizard.ts`) and the gate on publishing
 * the draft (`publishContractRevision`): the scope exists **and** nothing
 * awaits Root's decision. One function, so the wizard cannot call the step done
 * while the button that hands the draft over refuses, or the reverse.
 */
export function scopeStepDone(input: {
  items: ReadonlyArray<{ kind: string; contractId: string | null }>;
  proposals: ReadonlyArray<{ decidedAt: Date | null }>;
  contractId: string;
}): boolean {
  return scopeSeeded(input.items, input.contractId) && scopeConfirmed(input.proposals);
}

// --- proposing --------------------------------------------------------------

/**
 * Whether an item can be proposed for removal: a page, feature or deliverable
 * the contract has agreed and nobody has started. A declined or traded-away
 * item is already out; a `PROPOSED` one has not been agreed to yet (a scope
 * trade's incoming half) and is not the customer's to remove; and one that is
 * `IN_BUILD` or further is past step 2a — taking it out then is a scope trade
 * or an amendment (§3.1 point 5), never a proposal on the draft.
 */
export function removable(item: { kind: string; status: ScopeStatusLike }): boolean {
  return item.kind !== 'EXTRA' && item.status === 'AGREED';
}

/** The mirror: only a declined item can be brought back. */
export function restorable(item: { kind: string; status: ScopeStatusLike }): boolean {
  return item.kind !== 'EXTRA' && item.status === 'DECLINED';
}

/**
 * An item that already has an undecided proposal against it is not proposed
 * against again: a second "remove this" while the first waits is noise for
 * sales, and a "restore" beside a "remove" is a contradiction nobody decided.
 */
export function hasUndecidedProposalFor(
  proposals: ReadonlyArray<{ scopeItemId: string | null; decidedAt: Date | null }>,
  scopeItemId: string,
): boolean {
  return proposals.some((p) => p.scopeItemId === scopeItemId && p.decidedAt === null);
}

// --- deciding ---------------------------------------------------------------

/** `custom.1`, `custom.2` … — Latin, whatever the customer's own words were. */
const CUSTOM_KEY = /^custom\.(\d+)$/;

/**
 * The next `custom.<n>` key not taken on the project. **Never derived from the
 * customer's label**: their words are Persian as often as not, and a key is an
 * identifier (house rule 14) other stages address and e2e reads. The count is
 * the highest existing `custom.<n>` plus one — not the number of keys — so a
 * deleted `custom.2` never lets a later item take a number a person may
 * remember for a different one.
 */
export function nextCustomKey(takenKeys: Iterable<string>): string {
  let highest = 0;
  for (const key of takenKeys) {
    const n = CUSTOM_KEY.exec(key)?.[1];
    if (n !== undefined) highest = Math.max(highest, Number(n));
  }
  return `custom.${highest + 1}`;
}

/** A key sales types when accepting an ADD: Latin words joined by hyphens or
 *  dots — `custom.7`, `wishlist`, `blog-archive`. */
export const SCOPE_KEY_PATTERN = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
const MAX_KEY_LENGTH = 60;

/** `checklist.*` is the completeness checklist's namespace (`applyContractTemplate`
 *  guards on it): an item keyed inside it would be invisible to that guard. */
export function checkScopeKey(key: string): 'INVALID_KEY' | null {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return 'INVALID_KEY';
  if (key.startsWith('checklist.')) return 'INVALID_KEY';
  return SCOPE_KEY_PATTERN.test(key) ? null : 'INVALID_KEY';
}

export type DecisionInput = {
  decision: ProposalDecision;
  labelFa?: string | null;
  labelEn?: string | null;
  key?: string | null;
  kind?: string | null;
  declineReason?: string | null;
};

export type DecisionProblem =
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'LABEL_REQUIRED'
  | 'INVALID_KEY'
  | 'INVALID_KIND';

/**
 * The first refusal a decision earns, or null. A decline needs its reason (the
 * customer reads it — the database's CHECK is the backstop); accepting an ADD
 * needs both labels (the registry requires both), a well-formed key if one was
 * typed, and a kind that is a page, feature or deliverable. Accepting a REMOVE
 * or a RESTORE needs nothing more: the item already exists and already has its
 * labels.
 */
export function checkDecision(kind: ProposalKind, input: DecisionInput): DecisionProblem | null {
  if (input.decision === 'DECLINED') {
    const reason = input.declineReason?.trim() ?? '';
    if (reason === '') return 'REASON_REQUIRED';
    return reason.length > MAX_DECLINE_REASON ? 'REASON_TOO_LONG' : null;
  }
  if (kind !== 'ADD') return null;
  if (!input.labelFa?.trim() || !input.labelEn?.trim()) return 'LABEL_REQUIRED';
  if (input.key != null && input.key !== '' && checkScopeKey(input.key) !== null) return 'INVALID_KEY';
  if (input.kind != null && !isProposableKind(input.kind)) return 'INVALID_KIND';
  return null;
}

export type DecisionWrites = {
  /** What happens to the registry. `none` for a decline. */
  item:
    | { action: 'none' }
    | { action: 'create'; key: string; kind: ProposableKind; labelFa: string; labelEn: string; originNote: string }
    | { action: 'decline'; itemId: string; declinedReason: string }
    | { action: 'agree'; itemId: string };
};

/**
 * What accepting or declining a proposal writes to the registry (the proposal's
 * own row is the resolver's: decision, who, when, reason, the created item):
 *
 * - **ADD → a new item**, bilingual (sales' labels), keyed `custom.<n>` unless
 *   sales typed a key, of the kind the customer asked for unless sales
 *   corrected it, and **with the customer's words as its origin note** — the
 *   registry's "who asked, in what context" (`ScopeItem.originNote`).
 * - **REMOVE → the item declined**, with the proposal's text as the item's
 *   `declinedReason` — the customer's own reason for taking it out.
 * - **RESTORE → the item agreed again**; its old declined reason is cleared by
 *   the resolver (a reason on an agreed item would be a stale sentence).
 * - **A decline of any of them → no registry change at all.**
 */
export function applyDecision(
  proposal: { kind: ProposalKind; text: string; scopeItemId: string | null; requestedKind: string | null },
  input: DecisionInput,
  takenKeys: Iterable<string>,
): DecisionWrites {
  if (input.decision === 'DECLINED') return { item: { action: 'none' } };
  if (proposal.kind === 'ADD') {
    const typed = input.key?.trim();
    const kind = (input.kind ?? proposal.requestedKind ?? 'FEATURE') as ProposableKind;
    return {
      item: {
        action: 'create',
        key: typed ? typed : nextCustomKey(takenKeys),
        kind,
        labelFa: input.labelFa!.trim(),
        labelEn: input.labelEn!.trim(),
        originNote: proposal.text.trim(),
      },
    };
  }
  // The CHECK (`ScopeProposal_target_required`) guarantees a REMOVE or RESTORE
  // has an item; the assertion is for the type, and for a row that predates it.
  if (proposal.scopeItemId === null) throw new Error('A REMOVE or RESTORE proposal names no item.');
  return proposal.kind === 'REMOVE'
    ? { item: { action: 'decline', itemId: proposal.scopeItemId, declinedReason: proposal.text.trim() } }
    : { item: { action: 'agree', itemId: proposal.scopeItemId } };
}

// --- seeding ----------------------------------------------------------------

export type SeedRow = { key: string; kind: ProposableKind; labelFa: string; labelEn: string; position: number };

/**
 * The rows `applyScopeTemplate` (and the older `applyContractTemplate`) write
 * for a contract, given the keys already taken on the *project*.
 *
 * **Why keys can collide, and what is done about it.** A registry key is unique
 * per project (`@@unique([projectId, key])`), but a project can hold several
 * contracts (J2) and a second contract of the same site type starts from the
 * same template — the same keys. Refusing would make the second contract
 * unseedable (J2's owed `TEMPLATE_NOT_EMPTY`); overwriting would edit the
 * first contract's agreed scope. So a key that is taken takes the next free
 * suffix — `home`, `home.2`, `home.3` — and each contract gets a scope of its
 * own. The **kind is decided from the template's own key**, before any suffix
 * (`scopeKindForKey`'s page list is keyed on the plain word).
 */
export function seedRows(
  template: ReadonlyArray<{ key: string; kind?: string; labelFa: string; labelEn: string }>,
  takenKeys: Iterable<string>,
  firstPosition: number,
): SeedRow[] {
  const taken = new Set(takenKeys);
  return template.map((t, i) => {
    let key = t.key;
    for (let n = 2; taken.has(key); n += 1) key = `${t.key}.${n}`;
    taken.add(key);
    const kind = (t.kind ?? scopeKindForKey(t.key)) as ProposableKind;
    return { key, kind, labelFa: t.labelFa, labelEn: t.labelEn, position: firstPosition + i };
  });
}
