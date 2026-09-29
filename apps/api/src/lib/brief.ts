import type { DependencySide } from '@prisma/client';

/**
 * Step 1's own rules (journeys build plan J4, house rule 3): what the brief
 * implies, what it still lacks, and how its commitments become rows on the
 * dependency board. Pure functions over plain rows — no database, no clock —
 * table-tested in `brief.test.ts`; `resolvers/brief.ts` loads and writes, this
 * decides.
 *
 * Three questions, each answered once:
 *
 * 1. **`briefDependencies`** — which commitments does this brief imply, on
 *    whose side, and who verifies each?
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

/** The three whose side the brief itself records (`*ProvidedBy`). */
const PROVIDED_BY: Partial<Record<CommitmentKey, 'domainProvidedBy' | 'hostProvidedBy' | 'contentProvidedBy'>> = {
  domain: 'domainProvidedBy',
  host: 'hostProvidedBy',
  content: 'contentProvidedBy',
};

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

export type BriefCommitmentSource = {
  domainProvidedBy: DependencySide | null;
  hostProvidedBy: DependencySide | null;
  contentProvidedBy: DependencySide | null;
};

export type ImpliedCommitment = {
  key: CommitmentKey;
  side: DependencySide;
  technical: boolean;
  /** True when the brief's own field decides the side (`domain`, `host`,
   *  `content`), false for an extra's, whose side the caller may choose. */
  sideFromBrief: boolean;
};

/**
 * The commitments this brief implies (plan J4): `domain`, `host`, `content`
 * for each provider the brief names, and — from the extras that are included —
 * `gateway`, `smsLine`, `enamad`. A provider left unset implies nothing yet: a
 * row nobody has agreed whose side it is would be a guess on the board.
 *
 * `includedExtraKeys` are the checklist keys of the extras currently in scope.
 * `sideOverrides` are the sides the caller chose for the extras' commitments.
 * Stable order: `COMMITMENT_KEYS`.
 */
export function briefDependencies(
  brief: BriefCommitmentSource | null,
  includedExtraKeys: readonly string[],
  sideOverrides: Partial<Record<CommitmentKey, DependencySide>> = {},
): ImpliedCommitment[] {
  const out: ImpliedCommitment[] = [];
  const fromExtras = new Set(includedExtraKeys.map((k) => EXTRA_COMMITMENT[k]).filter((k): k is CommitmentKey => !!k));
  for (const key of COMMITMENT_KEYS) {
    const field = PROVIDED_BY[key];
    if (field) {
      const side = brief?.[field];
      if (side) out.push({ key, side, technical: COMMITMENTS[key].technical, sideFromBrief: true });
    } else if (fromExtras.has(key)) {
      out.push({
        key,
        side: sideOverrides[key] ?? EXTRA_DEFAULT_SIDE,
        technical: COMMITMENTS[key].technical,
        sideFromBrief: false,
      });
    }
  }
  return out;
}

// --- syncing them onto the board ---------------------------------------------

export type ExistingBriefRow = {
  id: string;
  briefKey: CommitmentKey;
  side: DependencySide;
  dueAt: Date;
  technical: boolean;
  titleFa: string;
  titleEn: string;
  verifiedAt: Date | null;
};

export type SyncPlan = {
  /** New rows — only for an implied key that has a due date to give it. */
  create: Array<{ key: CommitmentKey; side: DependencySide; dueAt: Date; technical: boolean; titleFa: string; titleEn: string }>;
  /** Rows whose side, date, flag or title differ from what the brief says. */
  update: Array<{ id: string; side: DependencySide; dueAt: Date; technical: boolean; titleFa: string; titleEn: string }>;
  /** Rows no live brief implies any more and nobody verified — deleted. */
  remove: string[];
  /** Rows no brief implies any more that *were* verified: the record of work
   *  done stays, as an ordinary board row, and the key is freed. */
  detach: string[];
};

const sameInstant = (a: Date, b: Date) => a.getTime() === b.getTime();

/**
 * What must change on the board so it matches the brief (plan J4: "create or
 * update by `briefKey`; never duplicate; a provider switched to Root flips the
 * row's side"). **Idempotent by construction**: the plan is a diff, so a brief
 * set twice yields an empty plan the second time — which is what makes "one row
 * per key" a property of the logic and not only of the unique index behind it.
 *
 * - `dueDates` are the dates the caller supplied; an existing row keeps its own
 *   date when none is given, and an implied key with neither a row nor a date
 *   is *not* created (`Dependency.dueAt` is required) — `briefCompleteness`
 *   reports it as `COMMITMENT_UNDATED` instead.
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
      if (given) {
        plan.create.push({ key: imp.key, side: imp.side, dueAt: given, technical: spec.technical, titleFa: spec.titleFa, titleEn: spec.titleEn });
      }
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
  | 'DOMAIN_PROVIDER'
  | 'HOST_PROVIDER'
  | 'CONTENT_PROVIDER'
  | 'SUPPORT_MONTHS'
  | 'PREMADE_ROUNDS'
  | 'MOCKUP_ITERATIONS'
  | 'DEMO_ITERATIONS'
  | 'COMMITMENT_UNDATED'
  | 'PHASES'
  | 'PHASE_END_DATE'
  | 'PAYMENT_PLAN'
  | 'PAYMENT_PLAN_TOTAL';

export type BriefForCompleteness = BriefCommitmentSource & {
  kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
  existingSiteUrl: string | null;
  designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER';
  budgetCap: bigint | null;
  hardDeadline: Date | null;
  supportMonths: number | null;
  premadeRounds: number | null;
  mockupIterations: number | null;
  demoIterationsPerPhase: number | null;
};

/**
 * What step 1 still lacks, in the order the desk form shows it. **Empty means
 * done**, and that is the wizard's signal for REQUIREMENTS (J3's
 * `wizardStateFrom`); J7's agreement gate reads the same list.
 *
 * What counts as required is a choice the plan did not make, made here: the
 * brief's own fields that the later steps read (a budget to design against, a
 * hard deadline to plan to, a provider for each of the three commitments, the
 * support term, the allowance each design path counts against), every implied
 * commitment *dated*, at least one phase and each phase dated, and a payment
 * plan whose total matches the fee once there is a fee to compare with.
 * `idealDeadline` is a wish and is never required; `domainName` is what the
 * provider decides, and the customer may not have one yet.
 */
export function briefCompleteness(input: {
  brief: BriefForCompleteness | null;
  /** The dates of the board's brief-owned rows, by key. */
  commitmentDates: Partial<Record<CommitmentKey, Date | null>>;
  includedExtraKeys: readonly string[];
  phases: ReadonlyArray<{ id: string; plannedEndAt: Date | null }>;
  plan: { invoiceAmounts: readonly bigint[] } | null;
  /** The draft fee, if there is one — the plan is compared with it (never the
   *  other way round; `budgetCap` is a different number, PD-14). */
  fee: bigint | null;
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
    if (!brief.domainProvidedBy) add('DOMAIN_PROVIDER');
    if (!brief.hostProvidedBy) add('HOST_PROVIDER');
    if (!brief.contentProvidedBy) add('CONTENT_PROVIDER');
    if (brief.supportMonths === null) add('SUPPORT_MONTHS');
    if (brief.designTier === 'THEME_PICK') {
      if (brief.premadeRounds === null) add('PREMADE_ROUNDS');
    } else if (brief.mockupIterations === null) {
      add('MOCKUP_ITERATIONS');
    }
    if (brief.demoIterationsPerPhase === null) add('DEMO_ITERATIONS');

    for (const imp of briefDependencies(brief, input.includedExtraKeys)) {
      if (!input.commitmentDates[imp.key]) add('COMMITMENT_UNDATED', imp.key);
    }
  }

  if (input.phases.length === 0) add('PHASES');
  for (const phase of input.phases) {
    if (phase.plannedEndAt === null) add('PHASE_END_DATE', phase.id);
  }

  if (!input.plan || input.plan.invoiceAmounts.length === 0) {
    add('PAYMENT_PLAN');
  } else if (input.fee !== null && input.plan.invoiceAmounts.reduce((a, b) => a + b, 0n) !== input.fee) {
    add('PAYMENT_PLAN_TOTAL');
  }
  return missing;
}

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
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > ALLOWANCE_MAX)) return 'INVALID_ALLOWANCE';
  }
  return null;
}
