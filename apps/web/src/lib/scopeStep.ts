import type { Contract, DraftNote, ScopeItem, ScopeKind, ScopeProposal, ScopeTrade } from './queries';

/**
 * Steps 2a and 2b's client-side vocabulary (journeys build plan J5, J6) — which
 * rows a step panel draws, in which groups, and where a note belongs. The API
 * decides every *rule* (what may be proposed, what is confirmed, where a note's
 * article is now: `lib/scopeProposals.ts`, `lib/draftNotes.ts`); this only
 * arranges what it returned, and is kept free of React so it is unit-testable
 * (`scopeStep.test.ts`). `PROPOSABLE_KINDS` is a hand-kept mirror of the API's
 * `TEMPLATE_KINDS`, and the test reads that file as text so the two cannot drift.
 */

/** What a customer may ask to add — never the checklist's `EXTRA`, which is step 1's. */
export const PROPOSABLE_KINDS = ['PAGE', 'FEATURE', 'DELIVERABLE'] as const;
export type ProposableKind = (typeof PROPOSABLE_KINDS)[number];

const IN_SCOPE = new Set(['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED']);

/** A page, feature or deliverable of *this contract* (`ScopeItem.contractId`, PD-5), in registry order. The project's other contracts' items and the completeness checklist are not step 2a's. */
export function ownItems(contract: Pick<Contract, 'id' | 'scopeItems'>): ScopeItem[] {
  return contract.scopeItems
    .filter((s) => s.kind !== 'EXTRA' && s.contractId === contract.id)
    .sort((a, b) => a.position - b.position);
}

export const isInScope = (item: Pick<ScopeItem, 'status'>) => IN_SCOPE.has(item.status);

/** What is out: declined (with its reason) or swapped out by a trade. A `PROPOSED` item is a trade's incoming half — not yet anything. */
export const isLeftOut = (item: Pick<ScopeItem, 'status'>) => item.status === 'DECLINED' || item.status === 'TRADED';

/** In the plan's order — pages, features, deliverables — omitting a group with nothing in it. */
export function groupByKind(items: readonly ScopeItem[]): Array<{ kind: ProposableKind; items: ScopeItem[] }> {
  return PROPOSABLE_KINDS.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}

/** The proposal still waiting for Root about this item, if any. */
export function waitingProposalFor(proposals: readonly ScopeProposal[], itemId: string): ScopeProposal | null {
  return proposals.find((p) => p.scopeItem?.id === itemId && p.decidedAt === null) ?? null;
}

export const undecidedProposals = (proposals: readonly ScopeProposal[]) => proposals.filter((p) => p.decidedAt === null);

/** Newest first — what the customer's "your requests" list and the desk's history read. */
export const newestFirst = (proposals: readonly ScopeProposal[]) =>
  [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

/** The trades still open on this contract's agreement — the ones whose outgoing item it agreed (T1), which is also the document a trade amends. */
export function openTrades(contract: Pick<Contract, 'id' | 'project'>): ScopeTrade[] {
  return contract.project.scopeTrades.filter((t) => t.executedAt === null && t.outItem.contractId === contract.id);
}

/** A trade's state, from the two confirmations. */
export type TradeState = 'WAITING_ON_CUSTOMER' | 'WAITING_ON_ROOT' | 'READY' | 'WAITING_ON_BOTH';
export function tradeState(t: Pick<ScopeTrade, 'rootConfirmedAt' | 'customerConfirmedAt'>): TradeState {
  if (t.rootConfirmedAt && t.customerConfirmedAt) return 'READY';
  if (t.rootConfirmedAt) return 'WAITING_ON_CUSTOMER';
  if (t.customerConfirmedAt) return 'WAITING_ON_ROOT';
  return 'WAITING_ON_BOTH';
}

// --- step 2b -----------------------------------------------------------------------

export type ArticleLike = { number: number };

/**
 * Where each note belongs on the article list the customer is reading. A note
 * follows its article to the number it has *now* (`currentArticleNumber`); a note
 * whose article can no longer be found (`articleGone`) belongs to none and is
 * listed apart, so it is never re-pointed at whatever took its number. Notes
 * keep the order the API gave them (oldest first).
 */
export function notesByArticle(articles: readonly ArticleLike[], notes: readonly DraftNote[]) {
  const byArticle = new Map<number, DraftNote[]>(articles.map((a) => [a.number, []]));
  const orphans: DraftNote[] = [];
  for (const n of notes) {
    const home = !n.articleGone && n.currentArticleNumber !== null ? byArticle.get(n.currentArticleNumber) : undefined;
    if (home) home.push(n);
    else orphans.push(n);
  }
  return { byArticle, orphans };
}

/** Whether an article already has a note on the revision being read — if not, the panel offers a blank one anchored there. */
export const hasNoteOnCurrent = (notes: readonly DraftNote[] | undefined) => (notes ?? []).some((n) => n.onCurrentRevision);

/** The whole-kind label key, for `t()`. */
export const kindKey = (kind: ScopeKind) => `scope.kind.${kind}`;
