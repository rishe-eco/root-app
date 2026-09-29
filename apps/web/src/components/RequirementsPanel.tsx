import type { ReactNode } from 'react';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, calendarDate, formatAmount, formatCount } from '@/lib/format';
import { designPath, isIncludedExtra, missingParams, MONEY_FIELDS } from '@/lib/brief';
import { CONTRACT_FEEDBACK, type Contract, type Dependency, type FeedbackItem } from '@/lib/queries';
import FeedbackPanel, { type FeedbackTarget } from '@/components/FeedbackPanel';
import RequirementsEditor from '@/components/RequirementsEditor';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 1 — requirements (journeys build plan J4), as one panel for both sides.
 *
 * **The customer reads it as cards, and comments on every field.** Each card is
 * a `FeedbackTarget` of the generic `FeedbackPanel` (S2) anchored by a
 * `briefField` — the brief's fields, the extras, each commitment, the phases and
 * the payment plan — so a note on "the hard deadline" is one thread that Root
 * answers and the customer can reopen, exactly as on every other step. Nothing
 * here is a second feedback mechanism.
 *
 * **An unfinished brief is shown, not hidden.** What `briefCompleteness` still
 * names appears as "Root is completing this" for the customer and "still
 * missing" for staff; a card that has no value yet says so instead of vanishing.
 *
 * **Staff see the same cards under the editor** (`RequirementsEditor`, for
 * `contracts.author`, while the step is open), so what sales types is what the
 * customer reads, and answer the customer's notes in place.
 *
 * Money follows PD-14: the budget cap and the payment plan arrive `null` for
 * staff without `money.read`, and their cards are not drawn for them.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Every `date` column arrives as an ISO instant at midnight UTC. */
const dayText = (iso: string | null, locale: 'fa' | 'en', t: T) => (iso ? calendarDate(iso, locale) : t('brief.notSet'));

function Value({ children }: { children: ReactNode }) {
  return <span className="req-value">{children}</span>;
}

function commitmentTitle(dep: Dependency, brief: Contract['brief'], locale: 'fa' | 'en'): string {
  const base = pick(dep, 'title', locale);
  return dep.briefKey === 'domain' && brief?.domainName ? `${base} — ${brief.domainName}` : base;
}

function CommitmentValue({ dep, locale, t }: { dep: Dependency; locale: 'fa' | 'en'; t: T }) {
  return (
    <Value>
      <span data-testid="commitment-due">{t('brief.dueOn', { date: calendarDate(dep.dueAt, locale) })}</span>
      {dep.verifiedAt ? <span className="badge">{t('detail.commitmentVerified')}</span> : null}
      {dep.overdue ? <span className="badge dependency-overdue-badge">{t('detail.commitmentOverdue')}</span> : null}
    </Value>
  );
}

export default function RequirementsPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const brief = contract.brief ?? null;
  const missing = contract.briefCompleteness ?? [];
  const canAuthor = staff && can(me, 'contracts.author') && !step.locked;
  const canSeeMoney = !staff || can(me, 'money.read');

  // One model for every step: this step's feedback is this contract's
  // REQUIREMENTS feedback. `asCustomer` asks as the customer would be asked.
  const { data, refetch } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'REQUIREMENTS', phaseId: null, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const items = data?.contract.feedbackItems ?? [];
  const itemFor = (field: string) => items.find((i) => i.briefField === field) ?? null;

  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const phaseNumber = (id: string) => phases.find((p) => p.id === id)?.number ?? null;
  const extras = contract.scopeItems.filter((s) => s.kind === 'EXTRA').sort((a, b) => a.position - b.position);
  const board = contract.project.dependencies.filter((d) => d.briefKey);
  const customerRows = board.filter((d) => d.side === 'CUSTOMER');
  const rootRows = board.filter((d) => d.side === 'ROOT');

  const targets: FeedbackTarget[] = [];
  const add = (
    key: string,
    group: string,
    label: string,
    value: ReactNode,
    extra: Partial<Pick<FeedbackTarget, 'caption'>> = {},
  ) => {
    if (MONEY_FIELDS.includes(key) && !canSeeMoney) return;
    targets.push({
      key,
      group,
      label: (
        <span className="req-row" data-field={key}>
          <span className="req-label">{label}</span>
          {value}
        </span>
      ),
      input: { briefField: key },
      item: itemFor(key),
      ...extra,
    });
  };

  if (brief) {
    const site = t('brief.group.site');
    add('kind', site, t('brief.label.kind'), <Value>{t(`brief.kind.${brief.kind}`)}</Value>);
    if (brief.kind === 'FEATURE_FOR_EXISTING') {
      add(
        'existingSiteUrl',
        site,
        t('brief.label.existingSiteUrl'),
        <Value>{brief.existingSiteUrl ? <span className="num-latin" dir="ltr">{brief.existingSiteUrl}</span> : t('brief.notSet')}</Value>,
      );
    }
    add('templateType', site, t('brief.label.templateType'), <Value>{pick(brief.templateType, 'label', locale)}</Value>);
    add('designTier', site, t('brief.label.designTier'), <Value>{t(`brief.path.${designPath(brief.designTier)}`)}</Value>);

    const time = t('brief.group.budgetTime');
    add(
      'budgetCap',
      time,
      t('brief.label.budgetCap'),
      <Value>
        {brief.budgetCap ? t('brief.amount', { amount: formatAmount(brief.budgetCap, locale) }) : t('brief.notSet')}
      </Value>,
    );
    add('idealDeadline', time, t('brief.label.idealDeadline'), <Value>{dayText(brief.idealDeadline, locale, t)}</Value>);
    add('hardDeadline', time, t('brief.label.hardDeadline'), <Value>{dayText(brief.hardDeadline, locale, t)}</Value>);
    add(
      'supportMonths',
      time,
      t('brief.label.supportMonths'),
      <Value>
        {brief.supportMonths === null ? t('brief.notSet') : t('brief.months', { count: brief.supportMonths, n: formatCount(brief.supportMonths, locale) })}
      </Value>,
    );

    const allowances = [
      brief.designTier === 'THEME_PICK'
        ? brief.premadeRounds !== null && t('brief.allowance.premadeRounds', { count: brief.premadeRounds, n: formatCount(brief.premadeRounds, locale) })
        : t('brief.allowance.wireframes', { count: brief.wireframeIterations, n: formatCount(brief.wireframeIterations, locale) }),
      brief.designTier !== 'THEME_PICK' &&
        brief.mockupIterations !== null &&
        t('brief.allowance.mockups', { count: brief.mockupIterations, n: formatCount(brief.mockupIterations, locale) }),
      brief.demoIterationsPerPhase !== null &&
        t('brief.allowance.demos', { count: brief.demoIterationsPerPhase, n: formatCount(brief.demoIterationsPerPhase, locale) }),
    ].filter((x): x is string => typeof x === 'string');
    add(
      'allowances',
      t('brief.group.allowances'),
      t('brief.label.allowances'),
      <Value>{allowances.length === 0 ? t('brief.notSet') : allowances.join(' · ')}</Value>,
    );
  }

  if (extras.length > 0) {
    add(
      'extras',
      t('brief.group.extras'),
      t('brief.label.extras'),
      <span className="req-checklist" data-testid="extras-readout">
        {extras.map((s) => (
          <span className="req-check" key={s.id} data-included={isIncludedExtra(s.status)}>
            <span aria-hidden="true">{isIncludedExtra(s.status) ? '☑' : '☐'}</span>
            <span>{pick(s, 'label', locale)}</span>
            <span className="visually-hidden">{isIncludedExtra(s.status) ? t('brief.extras.included') : t('brief.extras.notIncluded')}</span>
          </span>
        ))}
      </span>,
    );
  }

  const provided = (rows: Dependency[], group: string) => {
    for (const dep of rows) {
      add(dep.briefKey!, group, commitmentTitle(dep, brief, locale), <CommitmentValue dep={dep} locale={locale} t={t} />);
    }
  };
  // The customer's own group is titled exactly as the portal's rail card is
  // (`detail.commitmentsCap`) — the same words for the same list.
  provided(customerRows, staff ? t('brief.group.customerProvidesStaff') : t('detail.commitmentsCap'));
  provided(rootRows, t('brief.group.rootProvides'));

  if (brief) {
    add(
      'phases',
      t('brief.group.phases'),
      t('brief.label.phases'),
      phases.length === 0 ? (
        <Value>{t('brief.notSet')}</Value>
      ) : (
        <span className="req-list" data-testid="phases-readout">
          {phases.map((p) => (
            <span className="req-line" key={p.id} data-number={p.number}>
              <span className="badge">{formatCount(p.number, locale)}</span>
              <span>{pick(p, 'title', locale)}</span>
              <span className="t-caption">
                {p.plannedEndAt ? t('brief.phases.endsOn', { date: calendarDate(p.plannedEndAt, locale) }) : t('brief.phases.noEnd')}
              </span>
            </span>
          ))}
        </span>
      ),
    );

    const plan = contract.paymentPlan;
    if (plan && plan.invoices.length > 0) {
      add(
        'paymentPlan',
        t('brief.group.plan'),
        t('brief.label.paymentPlan', { split: t(`brief.plan.splitOption.${plan.split}`) }),
        <span className="req-list" data-testid="plan-readout">
          {plan.invoices.map((i) => {
            const phase = i.phaseId ? phaseNumber(i.phaseId) : null;
            return (
              <span className="req-line" key={i.id} data-ordinal={i.ordinal}>
                <span className="badge">{formatCount(i.ordinal, locale)}</span>
                <span>{pick(i, 'label', locale)}</span>
                <span>{t('brief.amount', { amount: formatAmount(i.amount, locale) })}</span>
                <span className="t-caption">
                  {i.paymentTermDays === 0
                    ? t('brief.plan.termNow')
                    : t('brief.plan.termDays', { count: i.paymentTermDays, n: formatCount(i.paymentTermDays, locale) })}
                  {phase !== null ? ` · ${t('brief.plan.afterPhase', { n: formatCount(phase, locale) })}` : ''}
                </span>
              </span>
            );
          })}
          <span className="req-line req-total">
            <span>{t('brief.plan.total')}</span>
            <span>{t('brief.amount', { amount: formatAmount(plan.total, locale) })}</span>
          </span>
        </span>,
      );
    }
  }

  const missingSentence = (m: { code: string; key: string | null }) =>
    t(
      `brief.missing.${m.code}`,
      missingParams(
        m,
        phaseNumber,
        (key) => t(`brief.commitment.${key}`),
        (n) => formatCount(n, locale),
      ),
    );

  return (
    <div className="requirements" data-testid="requirements-panel">
      <p className="t-small desk-muted">{staff ? t('brief.lede.staff') : t('brief.lede.customer')}</p>
      {staff && !contract.publishedAt ? (
        <p className="t-small req-notice" data-testid="not-handed-over">
          {t('brief.notHandedOver')}
        </p>
      ) : null}

      {canAuthor ? <RequirementsEditor contract={contract} me={me} /> : null}

      {missing.length > 0 ? (
        <div className="req-completing" data-testid="brief-missing">
          <p className="req-completing-title">{staff ? t('brief.missingTitle.staff') : t('brief.missingTitle.customer')}</p>
          <ul>
            {missing.map((m) => (
              <li key={`${m.code}:${m.key ?? ''}`} data-code={m.code}>
                {missingSentence(m)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief ? (
        <FeedbackPanel
          contractId={contract.id}
          step="REQUIREMENTS"
          targets={targets}
          generalItem={items.find((i) => i.general) ?? null}
          canRaise={!staff && !step.locked && !!contract.publishedAt}
          canAnswer={staff && can(me, 'feedback.answer')}
          answerDirect={can(me, 'answers.direct.agreement')}
          locked={step.locked}
          onChanged={() => void refetch()}
        />
      ) : (
        <p className="t-small desk-muted" data-testid="brief-empty">
          {staff ? t('brief.empty.staff') : t('brief.empty.customer')}
        </p>
      )}
    </div>
  );
}
