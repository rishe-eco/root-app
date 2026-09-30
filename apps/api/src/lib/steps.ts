import { GraphQLError } from 'graphql';
import type { ContractSequence, StepKind } from '@prisma/client';

/**
 * The wizard's one rule file (journeys build plan J3, house rule 3): **which
 * steps a contract has, which is current, and which are locked.** Every screen
 * (the portal's stepper, the desk's), every mutation that edits step content
 * (`assertStepOpen`) and the status area read these answers here and nowhere
 * else, so a step cannot be "done" on one screen and open on another.
 *
 * Pure functions over plain rows: no database, no clock. The loader that turns
 * a contract into a `WizardState` is `resolvers/wizard.ts`; this file is
 * table-tested in `steps.test.ts`.
 *
 * ## How a later stage extends this file
 *
 * - **A step gets its "done" signal** (J4 the brief handed over, J5 the scope
 *   settled, J6 the draft published, J11 delivery): the stage pushes a
 *   `Finished` onto `WizardState.finished` in `resolvers/wizard.ts`'s
 *   `wizardStateFrom`. Nothing here changes — `computeWizard` already reads it.
 * - **A step gets a lock**: the stage writes a `StepApproval` in the same
 *   transaction as the act it seals (J7 AGREEMENT, J8 DESIGN, J9 MOCKUP, J10
 *   DEMO per phase). `computeWizard` reads it; `LOCKS_WITH_AGREEMENT` below is
 *   the only place that says which other steps ride on AGREEMENT's.
 * - **A mutation that edits step content** calls `assertStepOpenOn` (the
 *   database-backed wrapper in `resolvers/wizard.ts`) before it writes.
 *   Since J7 every step 1–3 write does (`j7.test.ts` holds the table); the
 *   design, mockup and demo mutations join it in J8–J10.
 * - **AGREEMENT's "done" is the signature, its lock is the approval** (J7): the
 *   two are different moments on the new road, so `state.finished` carries the
 *   signature for AGREEMENT and `state.approvals` the approval.
 * - **The design path** (J8, PD-13): pass `'CUSTOM'` as `designPath` and
 *   MOCKUP joins the road; today no column exists, so callers pass `null`.
 */

/** PD-13: `THEME_PICK` is the pre-made path; `CLAUDE_ASSISTED` and
 *  `SENIOR_DESIGNER` are the custom one. J8 stores the tier and derives this. */
export type DesignPath = 'PREMADE' | 'CUSTOM';

export type DesignTierName = 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER';

/**
 * **The one place a brief's design tier becomes a path** (PD-13; journeys build
 * plan J8). `THEME_PICK` is the pre-made path, the other two the custom one.
 * The brief's completeness (which allowance step 1 must set), the wizard's road
 * (whether MOCKUP is on it), the allowance a design round counts against and
 * the design step's own completeness all ask here, so a tier cannot be
 * pre-made to one of them and custom to another. (J4 wrote the comparison
 * inline in `briefCompleteness`; that call comes here now.)
 */
export const designPathOf = (tier: DesignTierName): DesignPath => (tier === 'THEME_PICK' ? 'PREMADE' : 'CUSTOM');

/**
 * The sequence `createContract` gives a new contract — **`AGREEMENT_FIRST`, the
 * column's own default and PD-7's rule**, flipped by J7. Until then this stood at
 * `DESIGN_FIRST`: an `AGREEMENT_FIRST` contract could not be taken to signature
 * (J4–J6 built its steps, J7 builds the agreement gate that ends them), and the
 * legacy flow — every integration file and e2e spec that created a contract
 * through the API and drove it on — would have stranded. (J3's note said J4
 * would flip it; J4 built step 1 and left it, as did J5 and J6.)
 *
 * The resolver still *states* its value from here rather than leaving the
 * column's default to decide, so the choice is made in one visible place and a
 * later change of the default cannot silently change what a desk-made contract
 * is. The legacy road is not created through the API any more; a test or a
 * fixture that is *about* it makes one directly (`seedFixture({ sequence:
 * 'DESIGN_FIRST' })`, or an insert).
 */
export const SEQUENCE_FOR_NEW_CONTRACTS: ContractSequence = 'AGREEMENT_FIRST';

/** The three steps that lock when AGREEMENT is approved (plan J3): what the
 *  customer agreed to is the brief, the scope and the draft, so none of them
 *  can change once it is agreed. */
export const LOCKS_WITH_AGREEMENT: ReadonlySet<StepKind> = new Set<StepKind>(['REQUIREMENTS', 'SCOPE', 'DRAFT']);

export type PhaseRef = { id: string; number: number };

/** A place on the road: a step, and for DEMO the phase it is the demo of. */
export type StepSlot = { step: StepKind; phaseId: string | null; phaseNumber: number | null };

const slot = (step: StepKind): StepSlot => ({ step, phaseId: null, phaseNumber: null });

/**
 * The road, in order. `AGREEMENT_FIRST`: REQUIREMENTS, SCOPE, DRAFT,
 * AGREEMENT, DESIGN, MOCKUP (only on the custom design path), DEMO × each
 * phase, SUMMARY. `DESIGN_FIRST`: DESIGN, AGREEMENT, DEMO × each phase —
 * today's page, regrouped, and **nothing else**: it has no summary and no
 * placeholder.
 *
 * A new-road contract with no phases yet still shows *one* DEMO step, with no
 * phase: the customer's road should not skip from the design to the summary,
 * and a step with no phase can never take an approval (the approval row's
 * phase is what J10 keys on), so the placeholder is honestly "coming".
 */
export function stepsFor(
  sequence: ContractSequence,
  designPath: DesignPath | null,
  phases: PhaseRef[],
): StepSlot[] {
  const ordered = [...phases].sort((a, b) => a.number - b.number);
  const demos: StepSlot[] = ordered.map((p) => ({ step: 'DEMO', phaseId: p.id, phaseNumber: p.number }));

  if (sequence === 'DESIGN_FIRST') {
    return [slot('DESIGN'), slot('AGREEMENT'), ...demos];
  }
  return [
    slot('REQUIREMENTS'),
    slot('SCOPE'),
    slot('DRAFT'),
    slot('AGREEMENT'),
    slot('DESIGN'),
    ...(designPath === 'CUSTOM' ? [slot('MOCKUP')] : []),
    ...(demos.length > 0 ? demos : [slot('DEMO')]),
    slot('SUMMARY'),
  ];
}

/**
 * Whether a contract of this sequence has this step *at all*, whatever its
 * phases and design path (journeys build plan S2). `DESIGN_FIRST` is today's
 * page regrouped — design, agreement, demos — and has no requirements, scope,
 * draft, mockup or summary, so the feedback API refuses those for it rather
 * than growing rows nothing will ever show. `AGREEMENT_FIRST` has all eight
 * (MOCKUP joins the road only on the custom design path, which J8 decides).
 */
export function stepOnRoad(sequence: ContractSequence, step: StepKind): boolean {
  if (sequence === 'DESIGN_FIRST') return step === 'DESIGN' || step === 'AGREEMENT' || step === 'DEMO';
  return true;
}

export type Approval = { step: StepKind; phaseId: string | null; approvedAt: Date };

/** "This step's work is complete", supplied by data other than an approval.
 *  `at` is null when the source has no timestamp for it (the legacy design's
 *  completion is a count of approved pages, not an event). */
export type Finished = { step: StepKind; phaseId: string | null; at: Date | null };

/** Rounds used against an allowance (`lib/allowance.ts`), for the steps that
 *  have one. Optional and empty by default: a step nobody counts yet (MOCKUP
 *  before J9, a phase's DEMO before J10) has no entry and reads `null`. */
export type IterationCount = { step: StepKind; phaseId: string | null; used: number; allowance: number | null };

export type WizardState = {
  sequence: ContractSequence;
  /** From the brief's design tier (`designPathOf`, J8); null when there is no
   *  brief yet, and for a `DESIGN_FIRST` contract, which has none. */
  designPath: DesignPath | null;
  /** This contract's phases — the ones whose `Phase.contractId` names it (J4). */
  phases: PhaseRef[];
  /** Ignored for `DESIGN_FIRST`, which is never locked. */
  approvals: Approval[];
  finished: Finished[];
  iterations?: IterationCount[];
};

export type WizardStatus = 'DONE' | 'CURRENT' | 'UPCOMING';

export type WizardStep = StepSlot & {
  status: WizardStatus;
  locked: boolean;
  lockedAt: Date | null;
  /** False only for SUMMARY, which "never takes input" (plan J3) — a step no
   *  mutation edits, so `assertStepOpen` refuses it whatever its lock says. */
  takesInput: boolean;
  /** Rounds published against the allowance — DESIGN since J8; MOCKUP and DEMO
   *  are J9's and J10's. Null for a step nobody counts (yet). */
  iterationsUsed: number | null;
  allowance: number | null;
  /** When the step was completed, where the data knows. */
  finishedAt: Date | null;
};

const sameSlot = (a: { step: StepKind; phaseId: string | null }, b: { step: StepKind; phaseId: string | null }) =>
  a.step === b.step && a.phaseId === b.phaseId;

/**
 * The wizard, derived. **The rule, written once:**
 *
 * - A step is **locked** when the approval that seals it exists — its own, or
 *   for REQUIREMENTS / SCOPE / DRAFT the AGREEMENT's. `DESIGN_FIRST` is never
 *   locked: the legacy flow has no `StepApproval` rows and must behave exactly
 *   as it did, so any that exist on such a contract are ignored.
 * - A step is **done** when it is locked, or when something else says its work
 *   is complete (`state.finished`) — **except AGREEMENT on the new road, which
 *   is done only when signed** (`finished`): approved-and-unsigned is locked
 *   and current, so the status area says "sign it", not "done".
 * - **Current is the first step that is not done.** For a new-road contract
 *   whose steps have no data yet (SCOPE and DRAFT until J5–J6; REQUIREMENTS
 *   is done once `briefCompleteness` is empty, J4) that is simply the first
 *   step without a `StepApproval` or a done signal, and its panel says the
 *   step is not yet available. Later steps stay `UPCOMING` even if a stray row
 *   marks one done — the road is walked in order, and "done" is never
 *   promoted into "current".
 * - If every step is done there is no current step.
 */
export function computeWizard(state: WizardState): WizardStep[] {
  const slots = stepsFor(state.sequence, state.designPath, state.phases);
  const legacy = state.sequence === 'DESIGN_FIRST';
  const agreement = legacy ? undefined : state.approvals.find((a) => a.step === 'AGREEMENT' && a.phaseId === null);

  const steps = slots.map((s) => {
    const own = legacy ? undefined : state.approvals.find((a) => sameSlot(a, s));
    const sealing = LOCKS_WITH_AGREEMENT.has(s.step) ? agreement : own;
    const finished = state.finished.find((f) => sameSlot(f, s));
    const counted = state.iterations?.find((i) => sameSlot(i, s));
    // **AGREEMENT is done when it is signed, not when it is approved** (J7): on the
    // new road the customer approves and then signs on one screen, and between the
    // two the step is locked (nothing about it can change) but still theirs to
    // finish. Every other step is done when it is locked or its own data says so.
    const done =
      s.step === 'AGREEMENT' && !legacy ? finished !== undefined : sealing !== undefined || finished !== undefined;
    return {
      ...s,
      status: (done ? 'DONE' : 'UPCOMING') as WizardStatus,
      locked: sealing !== undefined,
      lockedAt: sealing?.approvedAt ?? null,
      takesInput: s.step !== 'SUMMARY',
      iterationsUsed: counted?.used ?? null,
      allowance: counted?.allowance ?? null,
      finishedAt: done ? (finished?.at ?? sealing?.approvedAt ?? null) : null,
    } satisfies WizardStep;
  });

  const current = steps.find((s) => s.status !== 'DONE');
  if (current) current.status = 'CURRENT';
  return steps;
}

/** The step the road is at, or null once every step is done. */
export function currentStepOf(wizard: WizardStep[]): WizardStep | null {
  return wizard.find((s) => s.status === 'CURRENT') ?? null;
}

/**
 * The enforcement is the API's, never a hidden button (journeys file §7.10):
 * every mutation that edits a step's content asks this first, and a locked step
 * refuses with `STEP_LOCKED`. A step that is not on this contract's road (a
 * MOCKUP on the pre-made path, REQUIREMENTS on a legacy contract) is not
 * locked — there is nothing to lock — and returns quietly; whether the
 * mutation should exist for that contract at all is the mutation's own
 * question.
 */
export function assertStepOpen(state: WizardState, step: StepKind, phaseId: string | null = null): void {
  const entry = computeWizard(state).find((s) => sameSlot(s, { step, phaseId }));
  if (!entry) return;
  if (entry.locked || !entry.takesInput) {
    throw new GraphQLError('That step is locked.', { extensions: { code: 'STEP_LOCKED' } });
  }
}

/**
 * `DESIGN_FIRST`'s completion, read off the rows it already has, as the same
 * `Finished` signals a new-road step would supply. Design is done when the
 * gate says the design is complete (a chosen concept, every page approved);
 * the agreement when the contract is signed; a phase's demo when every scope
 * item bound to it has been accepted (`isPhaseAccepted`, lib/phase.ts).
 *
 * The gate's own answer, not a second reading of the pages — the wizard must
 * never disagree with the button that says "Approve contract".
 */
export function legacyFinished(input: {
  designComplete: boolean;
  signedAt: Date | null;
  signed: boolean;
  acceptedPhaseIds: string[];
}): Finished[] {
  const out: Finished[] = [];
  if (input.designComplete) out.push({ step: 'DESIGN', phaseId: null, at: null });
  if (input.signed) out.push({ step: 'AGREEMENT', phaseId: null, at: input.signedAt });
  for (const phaseId of input.acceptedPhaseIds) out.push({ step: 'DEMO', phaseId, at: null });
  return out;
}

/**
 * **When the agreement was signed** — one rule for "signed" (house rule 3),
 * read by the status area's *started* and by J13's invoice issuing
 * (`NOT_SIGNED`), so a contract cannot be signed to one and unsigned to the
 * other. On **both** roads it is the current contract revision's signature.
 * The AGREEMENT `StepApproval` is *not* a signature: on the new road
 * `approveContract` writes it (J7) and signing follows on the same screen, so
 * an approved-but-unsigned contract must not issue invoices or count as
 * started (J13 review). There is no `Contract.signedAt` column, and adding a
 * second copy of a fact the signature row already carries would be the drift
 * this file exists to prevent.
 */
export function agreementSignedAt(input: { signatureSignedAt: Date | null }): Date | null {
  return input.signatureSignedAt;
}

// --- the design step's own completeness (journeys build plan J8) ---------------

/** What the design step still lacks. `NO_ROUND`: nothing has been published to
 *  the customer. `BRIEF_MISSING`: without a brief there is no path to be
 *  complete on (unreachable on a real contract — the agreement gate refuses
 *  first — and refused rather than guessed). Pre-made: `CONCEPT_NOT_CHOSEN`.
 *  Custom: `NO_PAGES`, `PAGE_NOT_APPROVED`, `PALETTE_EMPTY`. */
export type DesignMissing =
  | 'NO_ROUND'
  | 'BRIEF_MISSING'
  | 'CONCEPT_NOT_CHOSEN'
  | 'NO_PAGES'
  | 'PAGE_NOT_APPROVED'
  | 'PALETTE_EMPTY';

/**
 * **Design completeness on the new road** — a new function beside the legacy
 * gate, not an edit of it (PD-7): `computeGate`'s `designComplete` and every
 * `DESIGN_FIRST` path are untouched, and `gate.test.ts` still holds them.
 *
 * - **Pre-made**: a concept is chosen — one of the published round's themes.
 * - **Custom**: every page of the round is approved, there is at least one page
 *   (an empty design is not a complete one), and the palette is not empty.
 *
 * It reads the **current published revision** — what the customer is looking at
 * and can approve — and never the designer's draft. Empty means complete, and
 * `approveDesign` uses this very list as its precondition (`DESIGN_INCOMPLETE`),
 * so the button and the refusal cannot disagree.
 */
export function designMissing(input: {
  path: DesignPath | null;
  /** A design revision has been published and is current. */
  hasRound: boolean;
  concepts: ReadonlyArray<{ chosenAt: Date | null; pages: ReadonlyArray<{ approvedAt: Date | null }> }>;
  paletteCount: number;
}): DesignMissing[] {
  if (!input.hasRound) return ['NO_ROUND'];
  if (input.path === null) return ['BRIEF_MISSING'];
  if (input.path === 'PREMADE') {
    return input.concepts.some((c) => c.chosenAt !== null) ? [] : ['CONCEPT_NOT_CHOSEN'];
  }
  const pages = input.concepts.flatMap((c) => c.pages);
  const missing: DesignMissing[] = [];
  if (pages.length === 0) missing.push('NO_PAGES');
  else if (pages.some((p) => p.approvedAt === null)) missing.push('PAGE_NOT_APPROVED');
  if (input.paletteCount === 0) missing.push('PALETTE_EMPTY');
  return missing;
}
