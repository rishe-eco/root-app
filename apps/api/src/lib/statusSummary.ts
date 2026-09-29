import type { ContractSequence, StepKind } from '@prisma/client';
import { currentStepOf, type WizardStep } from './steps.js';
import type { AttentionItem, WaitingOn } from './attention.js';

/**
 * The status area's fields (journeys build plan J3), **derived** and never
 * stored — and, per the plan's trap, **never read from `ContractStatus`**. The
 * status enum is stored and hand-overridable (`setContractStatus`); this
 * summary can say both sides are waiting, which the enum cannot. The desk's V4
 * Overview keeps reading the enum until J12 re-points its queue.
 *
 * Pure (`statusSummary.test.ts`): the loader hands it the wizard, the
 * viewer's attention items and the dates it needs, and the clock.
 *
 * ## How a later stage extends this file
 *
 * - **Whose move a step is** — add a case to `nextMoveOn`. Until a stage does,
 *   a new-road step's move is Root's: nothing the customer can act on exists
 *   yet, which is also what its panel says.
 * - **"Started"** — J13 adds "and the first invoice is paid" to `started`
 *   (Q11; until then, signed).
 * - **Progress** — a stage that gives Root a new way to show work adds its
 *   dates to `progressAt` in `resolvers/wizard.ts`. Read today: builds
 *   published (`Build.publishedAt`), contract revisions published
 *   (`ContractRevision.publishedAt`), design revisions published
 *   (`DesignRevision.publishedAt`). Named for later: a staff answer
 *   published (S2), a scope proposal published (J5), the draft published (J6,
 *   which is a `ContractRevision` and so already counted), a design round
 *   (J8) and a mockup iteration (J9).
 * - **Overdue** — J13 adds invoices past their due date, and a phase past its
 *   `plannedEndAt`, to `overdueCount`.
 */

export type StatusSummaryInput = {
  now: Date;
  sequence: ContractSequence;
  wizard: WizardStep[];
  /** Already filtered to what the viewer may see. */
  attention: AttentionItem[];
  /** The agreement's approval, or the legacy signature. */
  signedAt: Date | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  /** When Root last showed the customer something: every date of every source
   *  named above, unsorted, published rows only. */
  progressAt: Date[];
  /** What the legacy road needs to say whose move it is. */
  facts: MoveFacts;
};

export type MoveFacts = {
  designPublished: boolean;
  contractPublished: boolean;
  /** Phases with a demo the customer can open. */
  publishedDemoPhaseIds: string[];
};

export type StatusSummary = {
  started: boolean;
  startedAt: Date | null;
  currentStep: StepKind | null;
  currentPhaseId: string | null;
  currentPhaseNumber: number | null;
  /** Null once every step is done. */
  nextMoveOn: WaitingOn | null;
  waitingOnRoot: number;
  waitingOnCustomer: number;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  overdueCount: number;
  lastProgressAt: Date | null;
  /** Whole days; null when Root has never shown progress. */
  daysSinceProgress: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whose move the current step is. The legacy road is read off what has been
 * published: the design is the customer's to choose and approve once a design
 * revision exists, and Root's before; the agreement likewise on the contract
 * text; a demo is the customer's to review once it is published. **Every
 * new-road step is Root's** until its stage adds a case (J4 REQUIREMENTS … J11
 * SUMMARY): with no data behind the step there is nothing for the customer to
 * do, and saying so is the honest reading.
 */
export function nextMoveOn(sequence: ContractSequence, step: WizardStep, facts: MoveFacts): WaitingOn {
  if (sequence === 'DESIGN_FIRST') {
    if (step.step === 'DESIGN') return facts.designPublished ? 'CUSTOMER' : 'ROOT';
    if (step.step === 'AGREEMENT') return facts.contractPublished ? 'CUSTOMER' : 'ROOT';
    if (step.step === 'DEMO') {
      return step.phaseId !== null && facts.publishedDemoPhaseIds.includes(step.phaseId) ? 'CUSTOMER' : 'ROOT';
    }
  }
  return 'ROOT';
}

export function computeStatusSummary(input: StatusSummaryInput): StatusSummary {
  const current = currentStepOf(input.wizard);
  const lastProgressAt = input.progressAt.reduce<Date | null>(
    (latest, d) => (latest === null || d.getTime() > latest.getTime() ? d : latest),
    null,
  );

  return {
    // Signed. J13 adds "and the first invoice is paid" (Q11); until then the
    // two are the same moment.
    started: input.signedAt !== null,
    startedAt: input.signedAt,
    currentStep: current?.step ?? null,
    currentPhaseId: current?.phaseId ?? null,
    currentPhaseNumber: current?.phaseNumber ?? null,
    nextMoveOn: current ? nextMoveOn(input.sequence, current, input.facts) : null,
    waitingOnRoot: input.attention.filter((a) => a.waitingOn === 'ROOT').length,
    waitingOnCustomer: input.attention.filter((a) => a.waitingOn === 'CUSTOMER').length,
    plannedStartAt: input.plannedStartAt,
    plannedEndAt: input.plannedEndAt,
    overdueCount: input.attention.filter((a) => a.kind === 'COMMITMENT_OVERDUE').length,
    lastProgressAt,
    daysSinceProgress:
      lastProgressAt === null ? null : Math.max(0, Math.floor((input.now.getTime() - lastProgressAt.getTime()) / DAY_MS)),
  };
}
