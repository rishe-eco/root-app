import type { BriefMissing, DependencySide, DesignTier } from './queries';

/**
 * Step 1's client-side vocabulary (journeys build plan J4). The API decides
 * everything that is a *rule* — what the brief implies, what it lacks, what may
 * be written — and this file only names things the screens need to draw a form:
 * the commitment keys, which checklist areas imply which, and how a
 * `briefCompleteness` code becomes a sentence. It is a hand-kept mirror of a
 * few constants in `apps/api/src/lib/brief.ts`, and — like `access.ts`'s
 * `CAPABILITIES` — a test reads the API's file as text and fails when the two
 * drift (`brief.test.ts`), so a stale mirror cannot quietly hide a date row.
 *
 * Kept free of React so it is unit-testable.
 */

export const COMMITMENT_KEYS = ['domain', 'host', 'content', 'gateway', 'smsLine', 'enamad'] as const;
export type CommitmentKey = (typeof COMMITMENT_KEYS)[number];

export const isCommitmentKey = (key: string): key is CommitmentKey => (COMMITMENT_KEYS as readonly string[]).includes(key);

/** The three whose side the brief itself records — the form's provider selects. */
export const PROVIDER_KEYS = ['domain', 'host', 'content'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

/** Which completeness-checklist area implies which commitment (a mirror of the
 *  API's `EXTRA_COMMITMENT`). */
export const EXTRA_COMMITMENT: Readonly<Record<string, CommitmentKey>> = {
  'checklist.payment': 'gateway',
  'checklist.notifications': 'smsLine',
  'checklist.legal': 'enamad',
};

/** A commitment implied by the form as it stands — what the editor asks a date for. */
export type ImpliedRow = { key: CommitmentKey; fromBrief: boolean };

/**
 * The commitments the form implies *as typed* — a provider chosen, an extra in
 * scope — so the editor can offer each its date before the first save, instead
 * of asking sales to save, look, and save again. The server computes the same
 * set on save (`briefDependencies`) and is the authority; this is only what the
 * form draws.
 */
export function impliedRows(
  providers: Record<ProviderKey, DependencySide | ''>,
  includedExtraKeys: readonly string[],
): ImpliedRow[] {
  const out: ImpliedRow[] = [];
  for (const key of PROVIDER_KEYS) if (providers[key]) out.push({ key, fromBrief: true });
  const fromExtras = new Set(includedExtraKeys.map((k) => EXTRA_COMMITMENT[k]).filter((k): k is CommitmentKey => !!k));
  for (const key of COMMITMENT_KEYS) if (fromExtras.has(key)) out.push({ key, fromBrief: false });
  return out;
}

/** PD-13: the tier is stored, the path is what is shown — two words on screen. */
export type DesignPath = 'PREMADE' | 'CUSTOM';
export const designPath = (tier: DesignTier): DesignPath => (tier === 'THEME_PICK' ? 'PREMADE' : 'CUSTOM');

/**
 * The statuses that put an extra in scope — `AGREED` or beyond (a mirror of the
 * API's `isIncludedExtra`). What a checked box means.
 */
export const isIncludedExtra = (status: string): boolean => ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'].includes(status);

/** The names a REQUIREMENTS note may be anchored to (a mirror of the API's
 *  `BRIEF_FIELDS`), so a card can never offer an anchor the server refuses. */
export const BRIEF_FIELDS = [
  'kind',
  'existingSiteUrl',
  'templateType',
  'designTier',
  'budgetCap',
  'idealDeadline',
  'hardDeadline',
  'supportMonths',
  'allowances',
  'extras',
  'phases',
  'paymentPlan',
  ...COMMITMENT_KEYS,
] as const;

/** The fields that are money (PD-14, PD-21) — the two the API hides from staff
 *  without `money.read`. The customer's screen draws them; a designer's never
 *  receives them, so a card for one is simply absent there. */
export const MONEY_FIELDS: readonly string[] = ['budgetCap', 'paymentPlan'];

/**
 * What a person typed into an amount box, as the decimal string the API takes:
 * Persian and Arabic-Indic digits become Latin (a Persian keyboard types
 * «۱۵۰۰۰۰۰۰۰»), and grouping — commas, the Arabic thousands mark, spaces — is
 * dropped. Nothing else is repaired: a letter or a decimal point stays, and the
 * server refuses it (`INVALID_AMOUNT`), rather than this quietly turning
 * "1.5" into a different sum.
 */
export function normalizeAmount(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[,٬،\s_]/g, '');
}

/**
 * A `briefCompleteness` code as the option bag its sentence needs
 * (`brief.missing.<CODE>`): a commitment names itself, a phase its number.
 */
export function missingParams(
  m: BriefMissing,
  phaseNumberOf: (phaseId: string) => number | null,
  commitmentTitle: (key: string) => string,
  n: (value: number) => string,
): Record<string, unknown> {
  if (m.code === 'COMMITMENT_UNDATED' && m.key) return { what: commitmentTitle(m.key) };
  if (m.code === 'PHASE_END_DATE' && m.key) {
    const number = phaseNumberOf(m.key);
    return { n: number === null ? '' : n(number) };
  }
  return {};
}
