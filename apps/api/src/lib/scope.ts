import { GraphQLError } from 'graphql';

/**
 * The registry's own small rules (build plan L1) — kept beside `gate.ts` in
 * spirit, not inside it (house rule 3: one rule, one file; the gate answers a
 * different question about a different object). Everything here is
 * structural rather than Prisma types, and pure, so it is unit-testable
 * without a database — the one kind of test this stage can actually run.
 */

export type ScopeStatusLike =
  | 'PROPOSED'
  | 'AGREED'
  | 'IN_BUILD'
  | 'IN_DEMO'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'TRADED';

/**
 * What Appendix 1 is a *view of* (spec §3; build plan L1's sharpest trap):
 * agreed or further along in the build lifecycle. A proposed item has not
 * been agreed to yet; a declined or traded-away item is not part of the
 * document a signature attests to.
 */
export const AGREED_STATUSES: readonly ScopeStatusLike[] = ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'];

export function isAgreedOrBeyond(status: ScopeStatusLike): boolean {
  return AGREED_STATUSES.includes(status);
}

export type ScopeKindLike = 'PAGE' | 'FEATURE' | 'DELIVERABLE' | 'EXTRA';

export type ScopeItemLike = {
  key: string;
  labelFa: string;
  labelEn: string;
  status: ScopeStatusLike;
  position: number;
  /** Read only by `agreedScopeSnapshotFor` (format 2). */
  kind?: ScopeKindLike;
  /** Read only by `agreedScopeSnapshotFor` (format 2). */
  contractId?: string | null;
};

export type ScopeItemSnapshot = { key: string; labelFa: string; labelEn: string; kind?: ScopeKindLike };

/**
 * What Appendix 1 freezes into a contract snapshot, generated from the
 * registry rather than typed by hand. Only the agreed-or-beyond set, in
 * registry order — never proposed, declined, or traded away.
 *
 * This function is an *addition* to what `buildContractSnapshot` already
 * computed, never a replacement: called with `[]` (every existing call site
 * before L1, and every already-published revision's frozen snapshot), it
 * contributes nothing, which is what keeps a published revision's hash from
 * this stage onward byte-identical to one published before it — see
 * docs/development/L1.md for why that is provable rather than assumed.
 */
export function agreedScopeSnapshot(items: ScopeItemLike[]): ScopeItemSnapshot[] {
  return [...items]
    .filter((i) => isAgreedOrBeyond(i.status))
    .sort((a, b) => a.position - b.position)
    .map((i) => ({ key: i.key, labelFa: i.labelFa, labelEn: i.labelEn }));
}

/**
 * **Format 2's appendix** (journeys build plan J7): the same agreed-or-beyond
 * set in the same order, each item carrying its `kind` so the appendix can be
 * grouped, and **narrowed to this contract**. A project can hold several
 * contracts (PD-5) and the registry is the project's, so the format-1 rule —
 * "every agreed item on the project" — would put a sibling contract's pages
 * into an agreement this one's customer signs. A page, feature or deliverable
 * belongs to the contract that agreed it (`ScopeItem.contractId`, T1); the
 * completeness checklist's `EXTRA` rows are the project's own standing
 * questions, seeded once, and stay in every contract's appendix as their
 * agreed state. A separate function rather than a flag on the one above,
 * because the two produce different documents and a flag would make the
 * format-1 caller's output depend on an argument it never passes.
 */
export function agreedScopeSnapshotFor(contractId: string, items: ScopeItemLike[]): ScopeItemSnapshot[] {
  return [...items]
    .filter((i) => isAgreedOrBeyond(i.status) && (i.kind === 'EXTRA' || i.contractId === contractId))
    .sort((a, b) => a.position - b.position)
    .map((i) => ({ key: i.key, labelFa: i.labelFa, labelEn: i.labelEn, kind: i.kind }));
}

/** Which neighbour a reorder move targets, or null when the item is already
 *  at that end of the list. Pure so the swap itself can be a plain
 *  transaction in the resolver, with no arithmetic to get wrong there. */
export function reorderTargetIndex(
  items: Array<{ id: string }>,
  id: string,
  direction: 'UP' | 'DOWN',
): number | null {
  const index = items.findIndex((i) => i.id === id);
  if (index === -1) return null;
  const target = direction === 'UP' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return null;
  return target;
}

/**
 * The trade's own mini-gate (spec §4; build plan L1) — both parties confirm
 * before a paired movement executes. Kept beside `gate.ts`'s pattern rather
 * than inside it: a different object, a different rule.
 */
export function assertCanConfirmTradeAsRoot(t: { rootConfirmedAt: Date | null }): void {
  if (t.rootConfirmedAt) {
    throw new GraphQLError('Root has already confirmed this trade.', {
      extensions: { code: 'ALREADY_CONFIRMED' },
    });
  }
}

/**
 * The customer's half (journeys build plan J5, the lifecycle plan's owed
 * §0.3.1). Refused once the trade has executed (nothing is left to confirm),
 * and once they have already confirmed it (a second click is not a second
 * confirmation). **Who may confirm is not decided here** — it is the
 * contract's own customer, an ownership edge `confirmScopeTradeCustomer`
 * checks through `loadForActor` (house rule 2); this is only the trade's own
 * state.
 */
export function assertCanConfirmTradeAsCustomer(t: {
  customerConfirmedAt: Date | null;
  executedAt: Date | null;
}): void {
  if (t.executedAt) {
    throw new GraphQLError('This trade has already executed.', {
      extensions: { code: 'ALREADY_EXECUTED' },
    });
  }
  if (t.customerConfirmedAt) {
    throw new GraphQLError('You have already confirmed this trade.', {
      extensions: { code: 'ALREADY_CONFIRMED' },
    });
  }
}

export function assertCanExecuteTrade(t: {
  rootConfirmedAt: Date | null;
  customerConfirmedAt: Date | null;
  executedAt: Date | null;
}): void {
  if (t.executedAt) {
    throw new GraphQLError('This trade has already executed.', {
      extensions: { code: 'ALREADY_EXECUTED' },
    });
  }
  if (!t.rootConfirmedAt || !t.customerConfirmedAt) {
    throw new GraphQLError('Both parties must confirm before a trade executes.', {
      extensions: { code: 'TRADE_NOT_CONFIRMED' },
    });
  }
}
