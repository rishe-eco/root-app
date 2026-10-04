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
 * - **"Started"** — signed *and*, for a contract with a payment plan, the
 *   plan's first invoice is paid (Q11, J13). **A contract with no payment plan
 *   has no first invoice to wait for, so `started` stays `signed` for it** —
 *   which is every legacy contract (a payment plan exists only on the new road,
 *   J4), and the one thing that could not be true of them is being "not started"
 *   for want of an invoice nobody can ever issue. `invoicePlan` is `null` for
 *   that case and `{ firstPaidAt }` otherwise.
 * - **Progress** — a stage that gives Root a new way to show work adds its
 *   dates to `progressAt` in `resolvers/wizard.ts`. Read today: builds
 *   published (`Build.publishedAt`), contract revisions published
 *   (`ContractRevision.publishedAt`), design revisions published
 *   (`DesignRevision.publishedAt`). Named for later: a staff answer
 *   published (S2), a scope proposal published (J5), the draft published (J6,
 *   which is a `ContractRevision` and so already counted), a design round
 *   (J8) and a mockup iteration (J9).
 * - **Overdue** — `overdueCount` counts overdue commitments and (J13) overdue
 *   invoices — the second from the `INVOICE_OVERDUE` line's own `count`. A phase
 *   past its `plannedEndAt` is still to add.
 */

export type StatusSummaryInput = {
  now: Date;
  sequence: ContractSequence;
  wizard: WizardStep[];
  /** Already filtered to what the viewer may see. */
  attention: AttentionItem[];
  /** The current revision's signature, on both roads (`agreementSignedAt`). */
  signedAt: Date | null;
  /** The AGREEMENT approval (J7) — the customer approved, whether or not they
   *  have signed yet. Null on the legacy road, which never writes one. */
  agreementApprovedAt: Date | null;
  /** Null when the contract has no payment plan (every legacy contract);
   *  otherwise when its first planned invoice was paid, or null if it has not
   *  been (issued and paid — `firstInvoicePaidAt`, lib/invoice.ts). */
  invoicePlan: { firstPaidAt: Date | null } | null;
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
  /** J8: a design note (or "show me other options") is waiting for Root's
   *  answer — the new road's design step is then Root's move even though a
   *  round is out. Optional so the legacy road, which never reads it, need not
   *  supply it. */
  designOpenFeedback?: boolean;
  contractPublished: boolean;
  /** Phases with a demo the customer can open. */
  publishedDemoPhaseIds: string[];
  /** J10: phases with a demo note waiting for Root's answer — a phase whose demo is
   *  out is then Root's move, not the customer's, as the design is (J8). Optional
   *  for the same reason `designOpenFeedback` is. */
  demoOpenFeedbackPhaseIds?: string[];
};

export type StatusSummary = {
  started: boolean;
  startedAt: Date | null;
  /** J7: the agreement's two moments, which the status area names separately —
   *  "approved on …" (steps 1–3 locked) and "signed on …". */
  agreementApprovedAt: Date | null;
  signedAt: Date | null;
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
 * text (and, since J7, the new road's too); a demo is the customer's to review once it is published. **Every
 * other new-road step is Root's** until its stage adds a case (J4 REQUIREMENTS … J11
 * SUMMARY; J8 added the design's): with no data behind the step there is nothing
 * for the customer to do, and saying so is the honest reading.
 */
export function nextMoveOn(sequence: ContractSequence, step: WizardStep, facts: MoveFacts): WaitingOn {
  // The agreement (J7), on both roads: once Root has published the text it is
  // the customer's to approve and sign — and the step is current until they
  // have signed (approved-and-unsigned is still theirs).
  if (step.step === 'AGREEMENT') return facts.contractPublished ? 'CUSTOMER' : 'ROOT';
  if (sequence === 'DESIGN_FIRST') {
    if (step.step === 'DESIGN') return facts.designPublished ? 'CUSTOMER' : 'ROOT';
    if (step.step === 'DEMO') {
      return step.phaseId !== null && facts.publishedDemoPhaseIds.includes(step.phaseId) ? 'CUSTOMER' : 'ROOT';
    }
  }
  // The new road's design (J8): the customer's to choose or approve once a round
  // is out — unless they have asked for something and Root owes an answer.
  if (step.step === 'DESIGN') return facts.designPublished && facts.designOpenFeedback !== true ? 'CUSTOMER' : 'ROOT';
  // The new road's demo (J10), per phase: the customer's to review and approve once
  // the phase's demo is out — unless they have commented and Root owes an answer.
  if (step.step === 'DEMO') {
    const out = step.phaseId !== null && facts.publishedDemoPhaseIds.includes(step.phaseId);
    const owed = step.phaseId !== null && (facts.demoOpenFeedbackPhaseIds ?? []).includes(step.phaseId);
    return out && !owed ? 'CUSTOMER' : 'ROOT';
  }
  return 'ROOT';
}

export function computeStatusSummary(input: StatusSummaryInput): StatusSummary {
  const current = currentStepOf(input.wizard);
  const lastProgressAt = input.progressAt.reduce<Date | null>(
    (latest, d) => (latest === null || d.getTime() > latest.getTime() ? d : latest),
    null,
  );

  // Started (Q11): signed, and — when there is a plan to wait on — its first
  // invoice paid. The moment is the later of the two, since the second is what
  // set work going.
  const firstPaidAt = input.invoicePlan?.firstPaidAt ?? null;
  const started = input.signedAt !== null && (input.invoicePlan === null || firstPaidAt !== null);
  const startedAt =
    !started || input.signedAt === null
      ? null
      : firstPaidAt !== null && firstPaidAt.getTime() > input.signedAt.getTime()
        ? firstPaidAt
        : input.signedAt;

  return {
    started,
    startedAt,
    agreementApprovedAt: input.agreementApprovedAt,
    signedAt: input.signedAt,
    currentStep: current?.step ?? null,
    currentPhaseId: current?.phaseId ?? null,
    currentPhaseNumber: current?.phaseNumber ?? null,
    nextMoveOn: current ? nextMoveOn(input.sequence, current, input.facts) : null,
    waitingOnRoot: input.attention.filter((a) => a.waitingOn === 'ROOT').length,
    waitingOnCustomer: input.attention.filter((a) => a.waitingOn === 'CUSTOMER').length,
    plannedStartAt: input.plannedStartAt,
    plannedEndAt: input.plannedEndAt,
    overdueCount:
      input.attention.filter((a) => a.kind === 'COMMITMENT_OVERDUE').length +
      input.attention.filter((a) => a.kind === 'INVOICE_OVERDUE').reduce((n, a) => n + Number(a.params.count ?? 0), 0),
    lastProgressAt,
    daysSinceProgress:
      lastProgressAt === null ? null : Math.max(0, Math.floor((input.now.getTime() - lastProgressAt.getTime()) / DAY_MS)),
  };
}
