import type { Locale } from '@/i18n';
import { formatCount } from './format';
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

const ORDER: StepKind[] = ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO', 'SUMMARY'];
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

const NUMERIC = new Set(['count']);

/**
 * `attention.<kind>.<variant>.<audience>`, with the item's parameters turned
 * into i18next options: `count` stays a number (plural selection) and gains
 * `n`, its localized digits (README rule 14 — i18next's `{{count}}` selects a
 * form but does not localize what it prints); a bilingual title is picked for
 * the reader's language; versions and labels pass through as the Latin
 * identifiers they are.
 */
export function attentionText(t: Translate, locale: Locale, item: AttentionItem, audience: Audience): string {
  const options: Record<string, unknown> = {};
  for (const { key, value } of item.params) options[key] = NUMERIC.has(key) ? Number(value) : value;
  if (typeof options.count === 'number') options.n = formatCount(options.count, locale);
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
