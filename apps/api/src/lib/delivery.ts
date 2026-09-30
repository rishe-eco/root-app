import { GraphQLError } from 'graphql';
import type { ContractSequence, ScopeKind, ScopeStatus, StepKind } from '@prisma/client';
import { calendarDayString } from './calendarDay.js';
import { isPhaseAccepted } from './phase.js';
import { isAgreedOrBeyond } from './scope.js';

/**
 * Delivery: what has to be true before a contract closes, who hands a
 * deliverable over, and how long support runs afterwards (journeys build plan
 * J11, PD-6). One rule file (house rule 3) — `closeContract` refuses from it,
 * `Contract.delivery` (the desk's "why can't I close this") reads it, and the
 * summary's support period comes from it, so the button and the refusal cannot
 * disagree about what is still outstanding.
 *
 * Pure functions over plain rows — no database, no clock — table-tested in
 * `delivery.test.ts`. The loaders that turn a contract into these inputs are in
 * `resolvers/delivery.ts`.
 *
 * ## What "delivered" means, and what it does not
 *
 * **Delivery belongs to the contract** (PD-6): `Contract.deliveredAt`, not a
 * project status. It is set by one act — `closeContract`, sales' — and only when
 * two things are true of *this contract* (a project can hold several):
 *
 * 1. **Every phase is accepted.** On the new road that is the customer's DEMO
 *    approval for the phase (`approveStepTx(DEMO, phaseId)`, J10) — a
 *    `StepApproval` row, not a count of scope items, because the approval is the
 *    act and the items move as a consequence of it. A legacy (`DESIGN_FIRST`)
 *    contract has no such rows and never had: its phases are accepted the way its
 *    wizard already says they are, every counted scope item `ACCEPTED`
 *    (`isPhaseAccepted`, `legacyFinished`). PD-6 is about delivery, not the road,
 *    so `closeContract` applies to both, and each is asked in its own terms.
 *    **A contract with no phases is not deliverable**: nothing accepted is
 *    nothing delivered, and "every phase of none" is true of a contract that
 *    never built anything.
 * 2. **Every agreed deliverable is handed over.** A deliverable is a scope item
 *    of kind `DELIVERABLE` that *this* contract agreed (`ScopeItem.contractId`)
 *    and that is agreed or beyond (`isAgreedOrBeyond`). One that was declined, or
 *    traded away, was taken out of the deal and does not count — the same set
 *    Appendix 1 freezes (`agreedScopeSnapshotFor`), so "what the customer signed
 *    for" and "what must be handed over" are read off one definition of agreed.
 */

// --- the handover ---------------------------------------------------------

/** A handover note is prose a customer reads and a printer prints; a novel in
 *  it is a document that belongs somewhere else. The CHECK in the database only
 *  says "not blank"; this is the upper bound, refused with a code. */
export const HANDOVER_NOTE_MAX = 2000;

export type HandoverProblem = 'HANDOVER_NOTE_REQUIRED' | 'HANDOVER_NOTE_TOO_LONG';

/** Why a handover note is unusable, or null. The same "more than whitespace"
 *  the CHECK `ScopeItem_handover_is_a_deliverable` holds — asked here first so
 *  the refusal carries a code instead of a constraint name. */
export function checkHandoverNote(note: string): HandoverProblem | null {
  const trimmed = note.trim();
  if (trimmed === '') return 'HANDOVER_NOTE_REQUIRED';
  if (trimmed.length > HANDOVER_NOTE_MAX) return 'HANDOVER_NOTE_TOO_LONG';
  return null;
}

export const HANDOVER_MESSAGES: Record<HandoverProblem, string> = {
  HANDOVER_NOTE_REQUIRED: 'Say what was handed over, and how.',
  HANDOVER_NOTE_TOO_LONG: 'That note is too long.',
};

type ItemForDelivery = { kind: ScopeKind; status: ScopeStatus; contractId: string | null };

/** An agreed deliverable of this contract — the set a handover can name, and
 *  the set a close waits for. */
export function isAgreedDeliverable(item: ItemForDelivery, contractId: string): boolean {
  return item.kind === 'DELIVERABLE' && item.contractId === contractId && isAgreedOrBeyond(item.status);
}

// --- what a close waits for -----------------------------------------------

export type PhaseForClose = {
  id: string;
  number: number;
  /** Read only on the legacy road. */
  scopeItems: Array<{ status: ScopeStatus }>;
};

export type CloseBlockers = {
  /** The contract has no phase at all — nothing was built, so nothing can have
   *  been accepted. Its own flag because no phase number can name it. */
  noPhases: boolean;
  /** Phase numbers whose demo has not been accepted, in order. */
  phasesNotAccepted: number[];
  /** Ids of agreed deliverables not yet handed over, in the registry's order. */
  deliverablesPending: string[];
};

/**
 * What stands between this contract and being closed. `items` is the project's
 * whole registry — this narrows it to the contract's own deliverables, so a
 * sibling contract's pending handover never holds this one open.
 */
export function closeBlockers(input: {
  contractId: string;
  sequence: ContractSequence;
  phases: PhaseForClose[];
  /** The contract's `StepApproval` rows — only the DEMO ones are read. */
  approvals: Array<{ step: StepKind; phaseId: string | null }>;
  items: Array<ItemForDelivery & { id: string; position: number; handedOverAt: Date | null }>;
}): CloseBlockers {
  const phases = [...input.phases].sort((a, b) => a.number - b.number);
  const accepted = (p: PhaseForClose) =>
    input.sequence === 'DESIGN_FIRST'
      ? isPhaseAccepted(p)
      : input.approvals.some((a) => a.step === 'DEMO' && a.phaseId === p.id);

  const notAccepted = phases.filter((p) => !accepted(p)).map((p) => p.number);
  return {
    // No phase at all is not "all accepted": there is nothing to deliver.
    noPhases: phases.length === 0,
    phasesNotAccepted: notAccepted,
    deliverablesPending: input.items
      .filter((i) => isAgreedDeliverable(i, input.contractId) && i.handedOverAt === null)
      .sort((a, b) => a.position - b.position)
      .map((i) => i.id),
  };
}

/** The refusal, in the brief's order: phases first, then deliverables. */
export function assertCanClose(blockers: CloseBlockers): void {
  if (blockers.noPhases || blockers.phasesNotAccepted.length > 0) {
    throw new GraphQLError('Every phase must be accepted before the contract can be closed.', {
      extensions: { code: 'PHASES_NOT_ACCEPTED', phaseNumbers: blockers.phasesNotAccepted },
    });
  }
  if (blockers.deliverablesPending.length > 0) {
    throw new GraphQLError('Every agreed deliverable must be handed over before the contract can be closed.', {
      extensions: { code: 'DELIVERABLES_PENDING', count: blockers.deliverablesPending.length },
    });
  }
}

// --- support --------------------------------------------------------------

/**
 * The support period (journeys build plan J11; `brief.supportMonths`, J4): how
 * many months from the day of delivery, as **calendar days** (PD-19) — the day
 * is `deliveredAt`'s day in UTC, and the end is the same day-of-month that many
 * months on. A month that is too short clamps to its last day (31 January + 1
 * month is 28 February, not 3 March), which is what "a month of support" means
 * to the person who reads it.
 *
 * `null` when the brief promised none: no `supportMonths`, or zero. Before
 * delivery there is no `from` to count from, so the period is `months` alone.
 */
export type SupportPeriod = { months: number; from: string | null; until: string | null };

export function supportPeriod(deliveredAt: Date | null, months: number | null): SupportPeriod | null {
  if (months === null || !Number.isInteger(months) || months <= 0) return null;
  if (deliveredAt === null) return { months, from: null, until: null };
  const from = calendarDayString(deliveredAt);
  return { months, from, until: addMonths(from, months) };
}

/** `YYYY-MM-DD` + n months, clamped to the last day of a shorter month. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return calendarDayString(new Date(Date.UTC(year, month, Math.min(d, lastDay))));
}
