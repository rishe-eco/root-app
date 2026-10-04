import { GraphQLError } from 'graphql';
import type { StepKind } from '@prisma/client';
import { designPathOf, type DesignTierName } from './steps.js';

/**
 * How many rounds a step may take, and how many it has taken (journeys build
 * plan J8; journeys §7.4 and Q-S5). One rule file (house rule 3): the desk's
 * "round 2 of 3", the portal's counter, the publish guard and the extension
 * form all ask here, so a counter cannot say two of three while the guard
 * refuses.
 *
 * Pure functions over plain rows — no database, no clock — table-tested in
 * `allowance.test.ts`. The loader that turns a contract into these inputs is
 * `resolvers/allowance.ts`.
 *
 * ## What is an iteration
 *
 * **One version published to the customer for review in that sub-step**, counted
 * on publish (journeys §7.4). A draft costs nothing; discarding one costs
 * nothing; the customer's own acts (choosing, approving a page, asking for other
 * options) never cost anything either. The allowance itself is set in step 1 and
 * frozen with it at the agreement's approval, so this file reads the brief and
 * never a copy.
 *
 * ## Which allowance a step counts against
 *
 * - **DESIGN** — the pre-made path's `premadeRounds`, the custom path's
 *   `wireframeIterations` (default 2). The path is `designPathOf` — the one
 *   place a tier becomes a path.
 * - **MOCKUP** — `mockupIterations` (the custom path only).
 * - **DEMO** — `demoIterationsPerPhase`, per phase (Q-S6).
 *
 * ## What is built and what is not
 *
 * **All three are counted** — DESIGN (J8), MOCKUP (J9b) and a phase's DEMO (J10).
 * MOCKUP's used-count is the published mockup builds of the contract; a phase's
 * DEMO's is the published **SITE** builds of that phase (`roundCountsOn`). This
 * file does not count anything itself: `RoundCounts` has a slot for each, and a
 * count that is absent reads `null` — "not counted", which
 * `assertWithinAllowance` never refuses on (a phase nothing was loaded for, or a
 * caller that does not have the counts to hand).
 *
 * ## An unset allowance
 *
 * A brief that never set the allowance a step counts against has none:
 * `allowanceFor` returns `null` and nothing is refused. That is unreachable on
 * a real new-road contract — the brief is not complete without it
 * (`briefCompleteness`), and the agreement gate refuses an incomplete brief —
 * and refusing every publish on a brief that lacks the number would leave the
 * designer with no way forward and no one to ask. An extension on top of "no
 * limit" is meaningless, so it is refused (`NO_ALLOWANCE_SET`).
 */

/** The steps that have an allowance. */
export const ALLOWANCE_STEPS: readonly StepKind[] = ['DESIGN', 'MOCKUP', 'DEMO'];

export const hasAllowance = (step: StepKind): boolean => ALLOWANCE_STEPS.includes(step);

/** The brief's allowance columns, as far as this file reads them. */
export type BriefAllowances = {
  designTier: DesignTierName;
  premadeRounds: number | null;
  wireframeIterations: number;
  mockupIterations: number | null;
  demoIterationsPerPhase: number | null;
};

export type ExtensionRow = { step: StepKind; phaseId: string | null; extra: number };

/** How many rounds each step has taken: DESIGN (J8), MOCKUP (J9b) and, by phase
 *  id, a phase's DEMO (J10). */
export type RoundCounts = {
  design: number;
  mockup?: number;
  demoByPhase?: Record<string, number>;
};

/** The allowance in the brief, before any extension. `null`: not set (or the
 *  step has none — MOCKUP on the pre-made path). */
export function baseAllowance(step: StepKind, brief: BriefAllowances | null): number | null {
  if (!brief) return null;
  switch (step) {
    case 'DESIGN':
      return designPathOf(brief.designTier) === 'PREMADE' ? brief.premadeRounds : brief.wireframeIterations;
    case 'MOCKUP':
      return designPathOf(brief.designTier) === 'CUSTOM' ? brief.mockupIterations : null;
    case 'DEMO':
      return brief.demoIterationsPerPhase;
    default:
      return null;
  }
}

/**
 * The allowance in force: the brief's plus every extension for this step (and,
 * for a DEMO, this phase — allowances are per phase, Q-S6). `null` when the
 * brief sets none.
 */
export function allowanceFor(
  step: StepKind,
  phaseId: string | null,
  brief: BriefAllowances | null,
  extensions: readonly ExtensionRow[],
): number | null {
  const base = baseAllowance(step, brief);
  if (base === null) return null;
  const extra = extensions
    .filter((e) => e.step === step && (step !== 'DEMO' || e.phaseId === phaseId))
    .reduce((sum, e) => sum + e.extra, 0);
  return base + extra;
}

/**
 * Rounds taken so far, or `null` where nothing counts them yet (MOCKUP before
 * J9, DEMO before J10) or the step has no allowance.
 */
export function iterationsUsed(step: StepKind, phaseId: string | null, counts: RoundCounts): number | null {
  switch (step) {
    case 'DESIGN':
      return counts.design;
    case 'MOCKUP':
      return counts.mockup ?? null;
    case 'DEMO':
      return phaseId === null ? null : (counts.demoByPhase?.[phaseId] ?? null);
    default:
      return null;
  }
}

export type AllowanceState = { used: number | null; allowance: number | null };

export function allowanceState(
  step: StepKind,
  phaseId: string | null,
  brief: BriefAllowances | null,
  extensions: readonly ExtensionRow[],
  counts: RoundCounts,
): AllowanceState {
  return { used: iterationsUsed(step, phaseId, counts), allowance: allowanceFor(step, phaseId, brief, extensions) };
}

/** Whether one more round may be published. Unknown on either side is "yes":
 *  see the file header on why a missing number never blocks. */
export function isExhausted(state: AllowanceState): boolean {
  return state.used !== null && state.allowance !== null && state.used >= state.allowance;
}

/**
 * The publish guard: **the round about to be published must fit.** With an
 * allowance of three and three published, the fourth is refused
 * `ALLOWANCE_EXHAUSTED` — and stays refused until sales extends
 * (`extendAllowance`), which is the only thing that raises it.
 */
export function assertWithinAllowance(state: AllowanceState): void {
  if (!isExhausted(state)) return;
  throw new GraphQLError('This step has used all its rounds. Ask sales to extend the allowance.', {
    extensions: { code: 'ALLOWANCE_EXHAUSTED', used: state.used, allowance: state.allowance },
  });
}

/** Why an extension request is malformed, or null. `extra` is a whole number
 *  of rounds above zero (the table's CHECK says the same). */
export type ExtensionProblem = 'INVALID_EXTRA' | 'REASON_REQUIRED' | 'STEP_HAS_NO_ALLOWANCE' | 'PHASE_REQUIRED' | 'PHASE_NOT_ALLOWED';

/** Upper bound on one extension — a typo guard, not a business rule. */
export const MAX_EXTENSION = 20;

export function checkExtension(input: { step: StepKind; phaseId: string | null; extra: number; reason: string }): ExtensionProblem | null {
  if (!hasAllowance(input.step)) return 'STEP_HAS_NO_ALLOWANCE';
  if (!Number.isInteger(input.extra) || input.extra < 1 || input.extra > MAX_EXTENSION) return 'INVALID_EXTRA';
  if (!input.reason.trim()) return 'REASON_REQUIRED';
  // Allowances are per phase for a demo and per contract otherwise.
  if (input.step === 'DEMO' && input.phaseId === null) return 'PHASE_REQUIRED';
  if (input.step !== 'DEMO' && input.phaseId !== null) return 'PHASE_NOT_ALLOWED';
  return null;
}
