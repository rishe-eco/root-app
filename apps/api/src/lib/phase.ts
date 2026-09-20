/**
 * Coarse progress, derived (build plan L2; spec §4 stage 6). F5 was the
 * founder's own slippage — "Root-side tasks slip without external
 * pressure" — and a hand-typed percentage is the first thing to go stale.
 * So there is no percentage column anywhere: "phase 3 of 5" and whatever
 * follows it is computed fresh, here, from the registry's own `status`
 * field, every time it is asked for — the same discipline `lib/gate.ts`
 * already holds for the design/contract gate.
 *
 * **Deliberately does not compute an "on track" / "at risk" judgement.**
 * The plan's own example copy ("phase 3 of 5, on track") reads like a
 * status word, but nothing built so far carries a due date or a verified
 * commitment to compare against — that is L5's dependency board, not this
 * stage. Inventing a traffic-light signal with no real input behind it
 * would be exactly the kind of "defaulted value is omission with a
 * friendly face" R1's rule warns against, aimed at a word instead of a
 * field. What this returns instead — a phase count and an item count — is
 * everything that can honestly be said yet.
 */

export type ScopeStatusLike =
  | 'PROPOSED'
  | 'AGREED'
  | 'IN_BUILD'
  | 'IN_DEMO'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'TRADED';

export type PhaseLike = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  scopeItems: Array<{ status: ScopeStatusLike }>;
};

export type ProjectProgress = {
  totalPhases: number;
  /** Null only when the project has no phases at all yet. */
  currentPhaseNumber: number | null;
  currentPhaseTitleFa: string | null;
  currentPhaseTitleEn: string | null;
  /** Accepted scope items within the current phase, out of its total —
   *  `0 / 0` for a phase carrying no items yet, which is not the same claim
   *  as "0 of 4 accepted." */
  itemsAcceptedInPhase: number;
  itemsTotalInPhase: number;
};

/**
 * A phase counts as "done" for the purpose of finding the current one when
 * every scope item bound to it is ACCEPTED — DECLINED and TRADED items are
 * excluded from the count entirely (spec §3: a declined item is not part of
 * the deal, and a traded-away one is a different row's story now), so a
 * phase whose items are all accepted-or-declined-or-traded also counts as
 * done. A phase with zero items counts as done too — there is nothing left
 * for it to finish, and treating an empty phase as perpetually "current"
 * would stall the whole read the moment someone creates phase 4 before
 * assigning anything to it.
 */
function isPhaseDone(phase: PhaseLike): boolean {
  const counted = phase.scopeItems.filter((i) => i.status !== 'DECLINED' && i.status !== 'TRADED');
  return counted.every((i) => i.status === 'ACCEPTED');
}

/**
 * The single computation behind `Project.progress` (GraphQL) — read fresh on
 * every request, never cached in a column. `phases` should be given in
 * project order; this function does not sort them, so an out-of-order
 * caller gets an out-of-order (wrong) "current phase."
 */
export function computeProjectProgress(phases: PhaseLike[]): ProjectProgress {
  if (phases.length === 0) {
    return {
      totalPhases: 0,
      currentPhaseNumber: null,
      currentPhaseTitleFa: null,
      currentPhaseTitleEn: null,
      itemsAcceptedInPhase: 0,
      itemsTotalInPhase: 0,
    };
  }

  const current = phases.find((p) => !isPhaseDone(p)) ?? phases[phases.length - 1];
  const counted = current.scopeItems.filter((i) => i.status !== 'DECLINED' && i.status !== 'TRADED');

  return {
    totalPhases: phases.length,
    currentPhaseNumber: current.number,
    currentPhaseTitleFa: current.titleFa,
    currentPhaseTitleEn: current.titleEn,
    itemsAcceptedInPhase: counted.filter((i) => i.status === 'ACCEPTED').length,
    itemsTotalInPhase: counted.length,
  };
}
