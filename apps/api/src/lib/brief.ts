import type { DependencySide } from '@prisma/client';
import { designPathOf } from './steps.js';
import { planMatchesFee } from './plan.js';

/**
 * Step 1's own rules (journeys build plan J4, house rule 3): what the brief
 * implies, what it still lacks, and how its commitments become rows on the
 * dependency board. Pure functions over plain rows — no database, no clock —
 * table-tested in `brief.test.ts`; `resolvers/brief.ts` loads and writes, this
 * decides.
 *
 * Three questions, each answered once:
 *
 * 1. **`briefDependencies`** — which commitments do the included extras imply,
 *    on whose side, and who verifies each? (DX3a: the domain, the host and the
 *    content are no longer implied by a brief field — they are the desk's
 *    default list of handover items, `HandoverItemType`, seeded as rows when a
 *    brief is created and edited as rows from then on.)
 * 2. **`planDependencySync`** — given what the board holds, what must change so
 *    it says exactly that (create, update, remove, detach) — *idempotently*:
 *    running it twice writes nothing the second time.
 * 3. **`briefCompleteness`** — what is still missing, as codes. The wizard's
 *    step 1 is "done" when the list is empty, J7's gate reads the same list,
 *    and the portal shows the codes as "Root is completing this" — it never
 *    hides the step because it is unfinished.
 */

// --- the commitments ---------------------------------------------------------

export type CommitmentKey = 'domain' | 'host' | 'content' | 'gateway' | 'smsLine' | 'enamad';

type CommitmentSpec = {
  /** The developer verifies it (`dependencies.verifyTechnical`); otherwise
   *  sales does (`dependencies.verifyGeneral`). */
  technical: boolean;
  titleFa: string;
  titleEn: string;
};

/**
 * Every commitment a brief can name. `domain` and `host` are what a developer
 * can check with a test file and a DNS lookup, so they are technical
 * (L5's banked trap: "they said we have a host" is what failed); the content,
 * a payment-gateway account, an SMS line and the Enamad registration are things
 * sales can confirm from a conversation and a document.
 *
 * The titles are the dependency board's own two-language columns. They live
 * here rather than in the locale files because a row's title is *data* — it is
 * stored, shown to the customer in whichever language they read, and matched by
 * nothing — the same reasoning `lib/templates.ts` gives its article titles.
 */
export const COMMITMENTS: Record<CommitmentKey, CommitmentSpec> = {
  domain: { technical: true, titleFa: 'دامنه‌ی وب‌سایت', titleEn: 'Website domain' },
  host: { technical: true, titleFa: 'میزبانی وب‌سایت', titleEn: 'Website hosting' },
  content: { technical: false, titleFa: 'محتوای وب‌سایت (متن و تصویر)', titleEn: 'Website content (text and images)' },
  gateway: { technical: false, titleFa: 'حساب درگاه پرداخت', titleEn: 'Payment gateway account' },
  smsLine: { technical: false, titleFa: 'خط پیامک', titleEn: 'SMS line' },
  enamad: { technical: false, titleFa: 'ثبت نماد اعتماد الکترونیکی', titleEn: 'Enamad registration' },
};

export const COMMITMENT_KEYS = Object.keys(COMMITMENTS) as CommitmentKey[];

export const isCommitmentKey = (key: string): key is CommitmentKey => key in COMMITMENTS;

/**
 * The completeness checklist's areas (`CHECKLIST` in `lib/templates.ts`) that
 * mean the customer must obtain something once they are in scope — the
 * "extras" step 1 toggles. Included means `AGREED` or beyond; the mapping is
 * the only place that says which area implies which commitment.
 */
export const EXTRA_COMMITMENT: Readonly<Record<string, CommitmentKey>> = {
  'checklist.payment': 'gateway',
  'checklist.notifications': 'smsLine',
  'checklist.legal': 'enamad',
};

/** An extra is *in scope* when its registry row is `AGREED` or beyond; the
 *  checklist seeds every area `DECLINED` and `setExtra` moves it between the
 *  two. `PROPOSED` and `TRADED` are not "in": nobody has agreed, or it is gone. */
const INCLUDED_EXTRA_STATUSES: ReadonlySet<string> = new Set(['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED']);
export const isIncludedExtra = (status: string): boolean => INCLUDED_EXTRA_STATUSES.has(status);

/** The default side of a commitment an extra implies — the brief has no field
 *  for it, and a merchant account, an SMS line and an Enamad registration are
 *  the customer's to obtain. `setBrief`'s `commitments` may say otherwise. */
export const EXTRA_DEFAULT_SIDE: DependencySide = 'CUSTOMER';

export type ImpliedCommitment = {
  key: CommitmentKey;
  /** Null once someone cleared it in Requirements: undecided is a state. */
  side: DependencySide | null;
  technical: boolean;
};

/**
 * The commitments the included extras imply (plan J4, narrowed by DX3a):
 * `gateway`, `smsLine` and `enamad`. `includedExtraKeys` are the checklist keys
 * of the extras currently in scope. `sideOverrides` are the sides the caller
 * chose — **a key present with `null` means "undecided", not "use the
 * default"**, so clearing a side in Requirements is not undone by the next sync.
 * Stable order: `COMMITMENT_KEYS`.
 */
export function briefDependencies(
  includedExtraKeys: readonly string[],
  sideOverrides: Partial<Record<CommitmentKey, DependencySide | null>> = {},
): ImpliedCommitment[] {
  const out: ImpliedCommitment[] = [];
  const fromExtras = new Set(includedExtraKeys.map((k) => EXTRA_COMMITMENT[k]).filter((k): k is CommitmentKey => !!k));
  for (const key of COMMITMENT_KEYS) {
    if (!fromExtras.has(key)) continue;
    out.push({
      key,
      side: key in sideOverrides ? (sideOverrides[key] ?? null) : EXTRA_DEFAULT_SIDE,
      technical: COMMITMENTS[key].technical,
    });
  }
  return out;
}

/** The keys the extras own (`EXTRA_COMMITMENT`'s values). A default-list item may not take one:
 *  the sync would claim its row. */
export const EXTRA_COMMITMENT_KEYS: ReadonlySet<string> = new Set(Object.values(EXTRA_COMMITMENT));

// --- syncing them onto the board ---------------------------------------------

export type ExistingBriefRow = {
  id: string;
  briefKey: CommitmentKey;
  side: DependencySide | null;
  dueAt: Date | null;
  technical: boolean;
  titleFa: string;
  titleEn: string;
  verifiedAt: Date | null;
};

export type SyncPlan = {
  /** New rows, for every implied key that has none — dated if the caller gave a date, undated if not (DX3a). */
  create: Array<{ key: CommitmentKey; side: DependencySide | null; dueAt: Date | null; technical: boolean; titleFa: string; titleEn: string }>;
  /** Rows whose side, date, flag or title differ from what the extras say. */
  update: Array<{ id: string; side: DependencySide | null; dueAt: Date | null; technical: boolean; titleFa: string; titleEn: string }>;
  /** Rows no live brief implies any more and nobody verified — deleted. */
  remove: string[];
  /** Rows no brief implies any more that *were* verified: the record of work
   *  done stays, as an ordinary board row, and the key is freed. */
  detach: string[];
};

const sameInstant = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * What must change on the board so it matches the brief (plan J4: "create or
 * update by `briefKey`; never duplicate; a provider switched to Root flips the
 * row's side"). **Idempotent by construction**: the plan is a diff, so a brief
 * set twice yields an empty plan the second time — which is what makes "one row
 * per key" a property of the logic and not only of the unique index behind it.
 *
 * - `dueDates` are the dates the caller supplied; an existing row keeps its own
 *   date when none is given. An implied key with neither a row nor a date is
 *   created undated (DX3a: an `inBrief` row may be) — `briefCompleteness`
 *   reports it as `COMMITMENT_UNDATED`.
 * - `stillImpliedElsewhere` are keys another live contract's brief on the same
 *   project implies. The board's rows are the *project's* (one row per key per
 *   project), so a key this brief no longer implies is only removed when no
 *   sibling's does either.
 * - A row is never removed once verified: someone did the work.
 */
export function planDependencySync(input: {
  implied: readonly ImpliedCommitment[];
  existing: readonly ExistingBriefRow[];
  dueDates: Partial<Record<CommitmentKey, Date>>;
  stillImpliedElsewhere: ReadonlySet<CommitmentKey>;
}): SyncPlan {
  const plan: SyncPlan = { create: [], update: [], remove: [], detach: [] };
  const byKey = new Map(input.existing.map((row) => [row.briefKey, row] as const));
  const impliedKeys = new Set(input.implied.map((i) => i.key));

  for (const imp of input.implied) {
    const spec = COMMITMENTS[imp.key];
    const row = byKey.get(imp.key);
    const given = input.dueDates[imp.key];
    if (!row) {
      plan.create.push({ key: imp.key, side: imp.side, dueAt: given ?? null, technical: spec.technical, titleFa: spec.titleFa, titleEn: spec.titleEn });
      continue;
    }
    const dueAt = given ?? row.dueAt;
    const differs =
      row.side !== imp.side ||
      !sameInstant(row.dueAt, dueAt) ||
      row.technical !== spec.technical ||
      row.titleFa !== spec.titleFa ||
      row.titleEn !== spec.titleEn;
    if (differs) {
      plan.update.push({ id: row.id, side: imp.side, dueAt, technical: spec.technical, titleFa: spec.titleFa, titleEn: spec.titleEn });
    }
  }

  for (const row of input.existing) {
    if (impliedKeys.has(row.briefKey) || input.stillImpliedElsewhere.has(row.briefKey)) continue;
    if (row.verifiedAt) plan.detach.push(row.id);
    else plan.remove.push(row.id);
  }
  return plan;
}

// --- completeness -------------------------------------------------------------

/** One thing step 1 still lacks. `key` names which commitment or phase, where
 *  the code is about one. */
export type BriefMissing = { code: BriefMissingCode; key: string | null };

export type BriefMissingCode =
  | 'BRIEF'
  | 'EXISTING_SITE_URL'
  | 'BUDGET_CAP'
  | 'HARD_DEADLINE'
  | 'SUPPORT_MONTHS'
  | 'PREMADE_ROUNDS'
  | 'MOCKUP_ITERATIONS'
  | 'DEMO_ITERATIONS'
  | 'COMMITMENT_UNDECIDED'
  | 'COMMITMENT_UNDATED';

/** One thing the PHASES step still lacks (DX2a). Same shape as `BriefMissing`,
 *  so the wire type (`BriefMissing { code key }`) serves both lists. */
export type PlanMissing = { code: PlanMissingCode; key: string | null };

export type PlanMissingCode = 'PHASES' | 'PHASE_END_DATE' | 'PAYMENT_PLAN' | 'PAYMENT_PLAN_TOTAL';

export type BriefForCompleteness = {
  kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
  existingSiteUrl: string | null;
  designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER' | 'NONE';
  budgetCap: bigint | null;
  hardDeadline: Date | null;
  supportMonths: number | null;
  premadeRounds: number | null;
  mockupIterations: number | null;
  demoIterationsPerPhase: number | null;
};

/** A handover item as completeness reads it. */
export type HandoverFacts = { key: string; inBrief: boolean; side: DependencySide | null; dueAt: Date | null; notNeeded: boolean };

/** DX6: a row in the brief that nobody has decided: no side, and not marked not needed. Before the contract can go out
 *  every dependency says who provides it (or that it is not needed). */
export const handoverUndecided = (item: HandoverFacts): boolean => item.inBrief && item.side === null && !item.notNeeded;

/** Someone provides it, and nobody has said by when. */
export const handoverUndated = (item: HandoverFacts): boolean =>
  item.inBrief && item.side !== null && !item.notNeeded && item.dueAt === null;

/**
 * What step 1 still lacks, in the order the desk form shows it. **Empty means
 * done**, and that is the wizard's signal for REQUIREMENTS (J3's
 * `wizardStateFrom`); J7's agreement gate reads the same list.
 *
 * What counts as required is a choice the plan did not make, made here: the
 * brief's own fields that the later steps read (a budget to design against, a
 * hard deadline to plan to, the support term, the allowance each design path
 * counts against) and every handover item that someone provides *dated*.
 * **DX3a:** nobody has to say who provides the domain, the host or the content
 * (founder: each one is optional), so those three codes are gone; an item with
 * no side, or marked not needed, owes no date either. `idealDeadline` is a wish and is never required;
 * `domainName` is what the provider decides, and the customer may not have one
 * yet.
 *
 * **DX2a moved the phases and the payment plan out** to `planCompleteness`
 * below: they are their own step now, with their own done signal and their own
 * publish refusal. Until then this list named them too.
 */
export function briefCompleteness(input: {
  brief: BriefForCompleteness | null;
  /** The `inBrief` rows of the project's board (DX3a); `key` is the row's `briefKey`, or its id for a one-off. */
  handover: ReadonlyArray<HandoverFacts>;
}): BriefMissing[] {
  const missing: BriefMissing[] = [];
  const add = (code: BriefMissingCode, key: string | null = null) => missing.push({ code, key });
  const { brief } = input;

  if (!brief) {
    add('BRIEF');
  } else {
    if (brief.kind === 'FEATURE_FOR_EXISTING' && !brief.existingSiteUrl) add('EXISTING_SITE_URL');
    if (brief.budgetCap === null) add('BUDGET_CAP');
    if (brief.hardDeadline === null) add('HARD_DEADLINE');
    if (brief.supportMonths === null) add('SUPPORT_MONTHS');
    // DX2a: the no-design path has no design allowance to set.
    const path = designPathOf(brief.designTier);
    if (path === 'PREMADE') {
      if (brief.premadeRounds === null) add('PREMADE_ROUNDS');
    } else if (path === 'CUSTOM' && brief.mockupIterations === null) {
      add('MOCKUP_ITERATIONS');
    }
    if (brief.demoIterationsPerPhase === null) add('DEMO_ITERATIONS');

    for (const item of input.handover) {
      if (handoverUndecided(item)) add('COMMITMENT_UNDECIDED', item.key);
      else if (handoverUndated(item)) add('COMMITMENT_UNDATED', item.key);
    }
  }
  return missing;
}

/**
 * What the PHASES step still lacks (DX2a, desk UX review 10–11). **Empty means
 * done**, the step's signal in `stateOf`. At least one phase and each phase
 * dated, and a payment plan whose total matches the fee once there is a fee to
 * compare with (`planMatchesFee`, the one sum rule — the agreement gate asks the
 * same function; never the other way round, `budgetCap` is a different number,
 * PD-14). A plan against a contract with no fee yet is not a mismatch here: the
 * fee is set on the Contract tab, and `PLAN_TOTAL_MISMATCH` at approval
 * ("no fee is not a match") is what holds the agreement to it.
 *
 * `PAYMENT_PLAN_TOTAL` is the *unbalanced* code (the publish gate names it
 * `PLAN_UNBALANCED`); the other three are gaps (`PLAN_INCOMPLETE`).
 */
export function planCompleteness(input: {
  phases: ReadonlyArray<{ id: string; plannedEndAt: Date | null }>;
  plan: { invoiceAmounts: readonly bigint[] } | null;
  fee: bigint | null;
}): PlanMissing[] {
  const missing: PlanMissing[] = [];
  const add = (code: PlanMissingCode, key: string | null = null) => missing.push({ code, key });

  if (input.phases.length === 0) add('PHASES');
  for (const phase of input.phases) {
    if (phase.plannedEndAt === null) add('PHASE_END_DATE', phase.id);
  }

  if (!input.plan || input.plan.invoiceAmounts.length === 0) {
    add('PAYMENT_PLAN');
  } else if (input.fee !== null && !planMatchesFee({ invoices: input.plan.invoiceAmounts.map((amount) => ({ amount })) }, input.fee)) {
    add('PAYMENT_PLAN_TOTAL');
  }
  return missing;
}

// --- the "feature for an existing site" preset (DX3a) ---------------------------

/**
 * Choosing that kind is the founder's most common case, and it fills in what it
 * implies: no design, every extra out of scope, and the domain and the host not
 * needed (the site already has both). **It runs on the change *to* that kind**,
 * once — a brief already of the kind is saved as typed, so the person's edits
 * to the preset stick, and switching back to a new site changes nothing.
 */
export const EXISTING_SITE_PRESET = {
  designTier: 'NONE' as const,
  notNeededKeys: ['domain', 'host'] as const,
};

export const presetApplies = (previousKind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING' | null, kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING'): boolean =>
  kind === 'FEATURE_FOR_EXISTING' && previousKind !== 'FEATURE_FOR_EXISTING';

// --- feedback anchors ---------------------------------------------------------

/**
 * The names a REQUIREMENTS note may be anchored to (`FeedbackItem.briefField`):
 * every brief field, the extras and the commitments as wholes, the phases, and
 * the two money ones (`MONEY_BRIEF_FIELDS` in `lib/feedbackRules.ts` says which
 * of these hide from staff without `money.read`). A name outside the list is
 * `INVALID_TARGET` — an anchor that no card renders is a note nobody can find.
 * The commitment keys are their own anchors, so a customer can say "this date
 * does not work" about one row.
 */
export const BRIEF_FIELDS: readonly string[] = [
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
];

export const isBriefField = (field: string): boolean => BRIEF_FIELDS.includes(field);

// --- input --------------------------------------------------------------------

export type BriefInputProblem =
  | 'INVALID_BUDGET'
  | 'INVALID_DEADLINE'
  | 'DEADLINES_OUT_OF_ORDER'
  | 'INVALID_SITE_URL'
  | 'INVALID_SUPPORT_MONTHS'
  | 'INVALID_ALLOWANCE';

const ALLOWANCE_MAX = 100;

/** A positive whole number of Toman as a decimal string; 15 digits is far past
 *  any fee and well inside `BigInt` and Postgres `bigint` alike. */
export const isMoneyString = (text: string): boolean => /^[1-9]\d{0,14}$/.test(text);

/** An `http(s)` URL, which is all a site address can be — the same test
 *  `assertHttps` makes of a staging URL, minus the HTTPS-only rule (an existing
 *  site may still be on plain HTTP; nobody frames it). */
export function isSiteUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The refusals that need no database. The order is the order a person fills
 * the form in, so the first problem reported is the first one on screen.
 * Dates arrive already parsed (`null` = unset); the parser is the resolver's
 * (`parseCalendarDay`), and a string it rejected is passed as `'invalid'`.
 */
export function checkBriefInput(input: {
  budgetCap: string | null;
  idealDeadline: Date | 'invalid' | null;
  hardDeadline: Date | 'invalid' | null;
  existingSiteUrl: string | null;
  supportMonths: number | null;
  allowances: Array<number | null>;
}): BriefInputProblem | null {
  if (input.existingSiteUrl !== null && !isSiteUrl(input.existingSiteUrl)) return 'INVALID_SITE_URL';
  if (input.budgetCap !== null && !isMoneyString(input.budgetCap)) return 'INVALID_BUDGET';
  if (input.idealDeadline === 'invalid' || input.hardDeadline === 'invalid') return 'INVALID_DEADLINE';
  if (input.idealDeadline && input.hardDeadline && input.idealDeadline.getTime() > input.hardDeadline.getTime()) {
    return 'DEADLINES_OUT_OF_ORDER';
  }
  if (input.supportMonths !== null && (!Number.isInteger(input.supportMonths) || input.supportMonths < 0 || input.supportMonths > 120)) {
    return 'INVALID_SUPPORT_MONTHS';
  }
  for (const n of input.allowances) {
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > ALLOWANCE_MAX)) return 'INVALID_ALLOWANCE';
  }
  return null;
}
