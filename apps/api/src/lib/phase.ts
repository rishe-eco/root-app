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
 * The wizard's reading of "this phase's demo is finished" (journeys build
 * plan J3, `legacyFinished` in lib/steps.ts): at least one item is bound to
 * the phase and every counted one is ACCEPTED. **Not `isPhaseDone`**, which
 * deliberately treats an empty phase as done so a freshly created phase 4
 * cannot stall "the current phase" — that is the right answer for finding
 * where the project is, and the wrong one for saying a step has been
 * completed, where a phase with nothing in it has completed nothing.
 */
export function isPhaseAccepted(phase: Pick<PhaseLike, 'scopeItems'>): boolean {
  const counted = phase.scopeItems.filter((i) => i.status !== 'DECLINED' && i.status !== 'TRADED');
  return counted.length > 0 && counted.every((i) => i.status === 'ACCEPTED');
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

// --- DX2b: a phase without a demo, and an item in several phases ------------

/** The rows `phaseFinished` reads of a phase. */
export type PhaseFinishFacts = { id: string; hasDemo: boolean; doneAt: Date | null };

/**
 * **"This phase is finished" — the one rule** (desk UX review item 10, decision
 * 8; house rule 3). A phase is finished when the customer approved its demo (a
 * DEMO `StepApproval` for it), or — a phase with no demo — when staff marked it
 * done (`doneAt`). `canIssuePlanned` (`PHASE_NOT_ACCEPTED`), `closeBlockers`
 * (`PHASES_NOT_ACCEPTED`) and the wizard's invoice signals all ask here, so a
 * kick-off phase cannot be "done" for the invoice and open for the close.
 *
 * **A phase that has a demo is never finished by `doneAt`**: `markPhaseDone`
 * refuses `PHASE_HAS_DEMO`, but a switch turned off after the fact must not
 * leave a stale `doneAt` standing in for an approval, nor turn a phase whose
 * demo exists back into one with a flag to tick.
 */
export function phaseFinished(
  phase: PhaseFinishFacts,
  approvals: ReadonlyArray<{ step: string; phaseId: string | null }>,
): boolean {
  if (approvals.some((a) => a.step === 'DEMO' && a.phaseId === phase.id)) return true;
  return !phase.hasDemo && phase.doneAt !== null;
}

/** *When* a finished phase finished (`phaseFinished`'s other face): the approval's
 *  moment, or a no-demo phase's done mark. Null while it is not finished. */
export function phaseFinishedAt(
  phase: PhaseFinishFacts,
  approvals: ReadonlyArray<{ phaseId: string | null; approvedAt: Date; step?: string }>,
): Date | null {
  const approved = approvals.find((a) => (a.step === undefined || a.step === 'DEMO') && a.phaseId === phase.id);
  if (approved) return approved.approvedAt;
  return !phase.hasDemo ? phase.doneAt : null;
}

/**
 * **The phase an item is accepted by**: the highest-numbered of its phases
 * (desk UX review item 10; decisions 6 and 7). `ScopeItem.phaseId` is always
 * this, and `setItemPhases` (`lib/itemPhases.ts`) is the only writer — this
 * pure half is what it and the unit tests ask. Null for an empty set.
 */
export function lastPhaseOf(phases: ReadonlyArray<{ id: string; number: number }>): string | null {
  let last: { id: string; number: number } | null = null;
  for (const p of phases) if (last === null || p.number > last.number) last = p;
  return last?.id ?? null;
}

/**
 * **Every phase an item is in**, from its join rows and its `phaseId`. The
 * invariant says `phaseId` is always among the rows (or both are empty), so the
 * union changes nothing on a row written through `setItemPhases` — and it is
 * what keeps a row inserted with only a `phaseId` (a fixture, an old script)
 * counted as being in that phase rather than in none.
 */
export function itemPhaseIds(item: { phaseId?: string | null; phaseLinks?: ReadonlyArray<{ phaseId: string }> }): string[] {
  const ids = new Set((item.phaseLinks ?? []).map((l) => l.phaseId));
  if (item.phaseId) ids.add(item.phaseId);
  return [...ids];
}
