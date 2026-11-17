import type { Locale } from '@/i18n';
import { calendarDate, formatCount } from './format';
import type { AttentionItem, StepKind, TimelineItem, WaitingOn, WizardStep } from './queries';

/**
 * The wizard's words (journeys build plan J3) — how a step, an attention item
 * and a timeline row become a sentence, in one place so the portal's wizard and
 * the desk's read them identically. The API returns codes and parameters
 * (`AttentionItem.variant`, `params`); every sentence is in the locale files,
 * under `wizard.*`, `attention.*` and `timeline.*`.
 *
 * Kept free of React so it is unit-testable (`wizard.test.ts`).
 */

/** Who is reading. The portal is `customer`, including under view-as-customer;
 *  the desk is `staff`. The sentences are written for the reader, not neutral. */
export type Audience = 'customer' | 'staff';

/** The subset of i18next's `t` these helpers use. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

const ORDER: StepKind[] = ['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO', 'SUMMARY'];
export const STEP_KINDS: readonly StepKind[] = ORDER;

/** «دمو · فاز ۲» for a demo with a phase, the step's own name otherwise. */
export function stepLabel(
  t: Translate,
  locale: Locale,
  s: { step: StepKind; phaseNumber?: number | null },
): string {
  if (s.step === 'DEMO' && s.phaseNumber != null) {
    return t('wizard.demoPhase', { n: formatCount(s.phaseNumber, locale) });
  }
  return t(`wizard.step.${s.step}`);
}

/** Is this the same place on the road? (A demo is one place per phase.) */
export const sameStep = (
  a: Pick<WizardStep, 'step' | 'phaseId'> | null | undefined,
  b: Pick<WizardStep, 'step' | 'phaseId'> | null | undefined,
) => !!a && !!b && a.step === b.step && a.phaseId === b.phaseId;

/** The step the wizard opens on: the current one, else the first. */
export function defaultStep(wizard: WizardStep[]): WizardStep | null {
  return wizard.find((s) => s.status === 'CURRENT') ?? wizard[0] ?? null;
}

/**
 * The step a link names (`?step=DESIGN`, and `&phase=<id>` for a demo) — journeys
 * build plan J12: an attention item on the home screen opens the contract *on the
 * step it is about*, so the route the API chose is a place, not just a page. An
 * unknown step, a step this contract's road does not have, or a phase it does not
 * own is no step at all (the wizard then opens where it always did), and a demo
 * named without its phase is the first of the demos — never a guess at which.
 */
export function stepFromParams(wizard: WizardStep[], params: { get(name: string): string | null }): WizardStep | null {
  const step = params.get('step');
  if (!step) return null;
  const phase = params.get('phase');
  return wizard.find((s) => s.step === step && (phase === null || s.phaseId === phase)) ?? null;
}

const NUMERIC = new Set(['count']);

/**
 * `attention.<kind>.<variant>.<audience>`, with the item's parameters turned
 * into i18next options: `count` stays a number (plural selection) and gains
 * `n`, its localized digits (README rule 14 — i18next's `{{count}}` selects a
 * form but does not localize what it prints); a bilingual title is picked for
 * the reader's language; versions and labels pass through as the Latin
 * identifiers they are.
 */
export function attentionText(t: Translate, locale: Locale, item: Pick<AttentionItem, 'kind' | 'variant' | 'params'>, audience: Audience): string {
  const options: Record<string, unknown> = {};
  for (const { key, value } of item.params) options[key] = NUMERIC.has(key) ? Number(value) : value;
  if (typeof options.count === 'number') options.n = formatCount(options.count, locale);
  // J12: a phase's number in the reader's digits (rule 14: a count, not an identifier), and a
  // due day as the calendar day it is — the API sends ISO text, the reader gets a date.
  if (typeof options.phase === 'string') options.phaseN = formatCount(Number(options.phase), locale);
  if (typeof options.dueAt === 'string' && options.dueAt !== '') options.date = calendarDate(options.dueAt, locale);
  if (typeof options.titleFa === 'string' || typeof options.titleEn === 'string') {
    options.title = locale === 'fa' ? options.titleFa : options.titleEn;
  }
  return t(`attention.${item.kind}.${item.variant}.${audience}`, options);
}

/** A timeline row's sentence; `by` is rendered beside it, not inside it. */
export function timelineText(t: Translate, locale: Locale, item: TimelineItem): string {
  return t(`timeline.${item.kind}`, {
    number: item.number ?? '',
    step: item.step ? stepLabel(t, locale, { step: item.step, phaseNumber: item.phaseNumber }) : '',
  });
}

/** «با توست» / «با ریشه» — whose move, for this reader. */
export function moveLabel(t: Translate, audience: Audience, who: WaitingOn): string {
  return t(`statusArea.move.${audience}.${who}`);
}

/** «مرحله‌ی جاری · منتظر ریشه» — the desk list's one-line caption. */
export function captionFor(
  t: Translate,
  locale: Locale,
  summary: { currentStep: StepKind | null; currentPhaseNumber: number | null; nextMoveOn: WaitingOn | null },
): string | null {
  if (!summary.currentStep || !summary.nextMoveOn) return null;
  return t('wizard.caption', {
    step: stepLabel(t, locale, { step: summary.currentStep, phaseNumber: summary.currentPhaseNumber }),
    who: t(`wizard.who.${summary.nextMoveOn}`),
  });
}

/**
 * Whether the build timeline (journeys build plan J10, Q22) is on the customer's
 * wizard: once every step before the first demo is done — the design, and the mockup
 * where the road has one — and until the summary closes the contract. That is the
 * stretch in which the site is being built and a demo may not be out yet, which is
 * where the wizard had nothing to show (F6). It keeps showing through the demos: it
 * is the one place the phases and their versions read as a whole.
 */
export function showBuildTimeline(
  wizard: ReadonlyArray<Pick<WizardStep, 'step' | 'status'>>,
  entries: ReadonlyArray<unknown>,
): boolean {
  if (entries.length === 0) return false;
  const firstDemo = wizard.findIndex((s) => s.step === 'DEMO');
  if (firstDemo < 0) return false;
  if (!wizard.slice(0, firstDemo).every((s) => s.status === 'DONE')) return false;
  return !wizard.some((s) => s.step === 'SUMMARY' && s.status === 'DONE');
}

/**
 * What a step pill says about its step (DX1, desk UX review 22) — the second
 * signal beside *which step am I on*: where the contract itself is.
 *
 * - `DONE` — finished.
 * - `WAITING_CUSTOMER` / `YOUR_TURN` — the current step, whose move it is
 *   (`StatusSummary.nextMoveOn`, which the API decided: this never works it
 *   out). "Your turn" is the staff reader's, since only the desk asks for it.
 * - `CURRENT` — the current step when nobody is named.
 * - `UPCOMING` — not reached yet.
 *
 * A *locked* step (`WizardStep.locked`) is not a separate state: it is a done
 * step the signature froze, and the pill adds it as a suffix.
 */
export type PillState = 'DONE' | 'WAITING_CUSTOMER' | 'YOUR_TURN' | 'CURRENT' | 'UPCOMING';

export function pillState(step: Pick<WizardStep, 'status'>, nextMoveOn: WaitingOn | null | undefined): PillState {
  if (step.status === 'DONE') return 'DONE';
  if (step.status === 'UPCOMING') return 'UPCOMING';
  if (nextMoveOn === 'CUSTOMER') return 'WAITING_CUSTOMER';
  if (nextMoveOn === 'ROOT') return 'YOUR_TURN';
  return 'CURRENT';
}

/**
 * How many things a step is still missing, for its pill ("Requirements · 2
 * missing"). Only a step whose data already says it counts: REQUIREMENTS, from
 * `briefCompleteness`, and — since DX2a made phases and payment a step of their
 * own — PHASES, from `planCompleteness`. A step with nothing to count gets none
 * — a zero would be a claim the pill has no data for. Null means "show no count".
 */
export function pillMissing(
  step: Pick<WizardStep, 'step' | 'status'>,
  briefMissing: number | undefined,
  planMissing?: number,
): number | null {
  if (step.status === 'DONE') return null;
  const n = step.step === 'REQUIREMENTS' ? briefMissing : step.step === 'PHASES' ? planMissing : undefined;
  return n && n > 0 ? n : null;
}

/**
 * The "what's next" line at the top of a new-road contract on the desk (DX1,
 * desk UX review 28): whose turn it is, what to do, and the step to open.
 * **Nothing here decides anything** — the step and whose move it is are
 * `statusSummary`'s (the API's single derivation), and the thing to do is the
 * first attention item that is that side's, worded by `attentionText`; this
 * only picks among them. With no such item the line names the step itself.
 * Null when the road is finished.
 */
export type NextUp = {
  who: WaitingOn | null;
  step: StepKind;
  phaseId: string | null;
  phaseNumber: number | null;
  /** The attention item that says what to do, if the API has one for this side. */
  attention: AttentionItem | null;
};

export function nextUp(
  summary: { currentStep: StepKind | null; currentPhaseId: string | null; currentPhaseNumber: number | null; nextMoveOn: WaitingOn | null },
  attention: ReadonlyArray<AttentionItem>,
): NextUp | null {
  if (!summary.currentStep) return null;
  return {
    who: summary.nextMoveOn,
    step: summary.currentStep,
    phaseId: summary.currentPhaseId,
    phaseNumber: summary.currentPhaseNumber,
    attention: summary.nextMoveOn ? (attention.find((a) => a.waitingOn === summary.nextMoveOn) ?? null) : null,
  };
}

/** The link that opens a step on the desk's Steps tab (`stepFromParams` reads it back). */
export function stepLink(contractId: string, n: Pick<NextUp, 'step' | 'phaseId'>): string {
  const phase = n.phaseId ? `&phase=${encodeURIComponent(n.phaseId)}` : '';
  return `/desk/contracts/${contractId}/steps?step=${n.step}${phase}`;
}
