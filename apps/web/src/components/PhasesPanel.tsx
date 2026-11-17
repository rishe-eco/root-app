import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, calendarDate, formatAmount, formatCount } from '@/lib/format';
import { MONEY_FIELDS, missingParams } from '@/lib/brief';
import { CONTRACT_FEEDBACK, MARK_PHASE_DONE, type Contract, type FeedbackItem } from '@/lib/queries';
import FeedbackPanel, { type FeedbackTarget } from '@/components/FeedbackPanel';
import { Accordion, refusalText } from '@/components/EditorKit';
import { PhasesEditor, PlanEditor } from '@/components/PhasesEditor';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 3 — phases and payment (DX2a; desk UX review 10, 11, 12), one panel for
 * both sides. It is what Requirements' Phases and Payment-plan panels were,
 * moved to a step of their own so that Requirements is facts about the job only.
 *
 * - **Staff** (`contracts.author`, while the step is open) get the two editors
 *   in accordions — the phases, then the payment plan for whoever holds
 *   `money.read` — above the readouts, plus the derived progress line the
 *   Phases tab used to carry.
 * - **Everyone** sees "X of Y allocated": what the saved plan adds up to against
 *   the contract's price (set on the Contract tab, read-only here). A mismatch is
 *   a warning here and a publish blocker (`PLAN_UNBALANCED`, from
 *   `planCompleteness` — the one sum rule, `planMatchesFee`); nothing in this
 *   file works the arithmetic out for the API, it only draws the two numbers.
 * - **The readouts keep their notes.** The step takes no feedback of its own
 *   (the database's anchor CHECK has no PHASES branch), so the phases card and
 *   the plan card are still `FeedbackTarget`s of the REQUIREMENTS thread
 *   anchored by `briefField` (`phases`, `paymentPlan`) — the very threads that
 *   existed before the step did, so no note is orphaned and no data moved.
 *
 * Money follows PD-14 as it always did: the plan arrives `null` for staff
 * without `money.read`, and its card and editor are not drawn for them.
 */

/**
 * **Mark phase done** (DX2b; desk UX review 10, 12): for a phase with no demo, the staff act that finishes it.
 * Drawn whether or not the step is locked — it is meant for after signing — and only once the agreement is
 * approved (before that the API refuses `NOT_SIGNED`). The customer is told by the server.
 */
function PhaseDoneControls({ contract, phases }: { contract: Contract; phases: NonNullable<Contract['phases']> }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [mark, { loading }] = useMutation(MARK_PHASE_DONE);
  const [error, setError] = useState<string | null>(null);
  const open = phases.filter((p) => p.hasDemo === false);
  if (open.length === 0) return null;
  return (
    <div className="req-editor" data-testid="phase-done-controls">
      {open.map((p) => (
        <p className="workspace-row" key={p.id} data-testid="phase-done-row" data-number={p.number} data-done={p.doneAt ? 'true' : 'false'}>
          <span className="badge">{formatCount(p.number, locale)}</span>
          <span>{pick(p, 'title', locale)}</span>
          {p.doneAt ? (
            <span className="t-caption">{t('brief.phases.doneOn', { date: calendarDate(p.doneAt, locale) })}</span>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={loading}
              data-testid={`phase-done-${p.number}`}
              onClick={async () => {
                if (!confirm(t('brief.phases.confirmDone'))) return;
                setError(null);
                try {
                  await mark({ variables: { phaseId: p.id, contractId: contract.id } });
                } catch (err) {
                  setError(refusalText(t, err));
                }
              }}
            >
              {t('brief.phases.markDone')}
            </button>
          )}
        </p>
      ))}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

const phaseNumberIn = (phases: ReadonlyArray<{ id: string; number: number }>, id: string) => phases.find((p) => p.id === id)?.number ?? null;

export default function PhasesPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const missing = contract.planCompleteness ?? [];
  const canAuthor = staff && can(me, 'contracts.author') && !step.locked;
  const canSeeMoney = !staff || can(me, 'money.read');
  const plan = contract.paymentPlan ?? null;
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(['phases']));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const lacks = (codes: string[]) => missing.filter((m) => codes.includes(m.code)).length;

  // This step's notes are the REQUIREMENTS thread's `phases` and `paymentPlan` cards (see the header).
  const { data, refetch } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'REQUIREMENTS', phaseId: null, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const items = data?.contract.feedbackItems ?? [];
  const itemFor = (field: string) => items.find((i) => i.briefField === field) ?? null;

  const targets: FeedbackTarget[] = [];
  const add = (key: string, label: string, value: ReactNode) => {
    if (MONEY_FIELDS.includes(key) && !canSeeMoney) return;
    targets.push({
      key,
      group: t(key === 'phases' ? 'brief.group.phases' : 'brief.group.plan'),
      label: (
        <span className="req-row" data-field={key}>
          <span className="req-label">{label}</span>
          {value}
        </span>
      ),
      input: { briefField: key },
      item: itemFor(key),
    });
  };

  add(
    'phases',
    t('brief.label.phases'),
    phases.length === 0 ? (
      <span className="req-value">{t('brief.notSet')}</span>
    ) : (
      <span className="req-list" data-testid="phases-readout">
        {phases.map((p) => (
          <span className="req-line" key={p.id} data-number={p.number}>
            <span className="badge">{formatCount(p.number, locale)}</span>
            <span>{pick(p, 'title', locale)}</span>
            {p.hasDemo === false ? <span className="badge badge-neutral" data-testid="no-demo-badge">{t('brief.phases.noDemoBadge')}</span> : null}
            <span className="t-caption">
              {p.plannedEndAt ? t('brief.phases.endsOn', { date: calendarDate(p.plannedEndAt, locale) }) : t('brief.phases.noEnd')}
            </span>
          </span>
        ))}
      </span>
    ),
  );

  if (plan && plan.invoices.length > 0) {
    add(
      'paymentPlan',
      t('brief.label.paymentPlan', { split: t(`brief.plan.splitOption.${plan.split}`) }),
      <span className="req-list" data-testid="plan-readout">
        {plan.invoices.map((i) => {
          const phase = i.phaseId ? phaseNumberIn(phases, i.phaseId) : null;
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
                {i.dueOn ? ` · ${t('brief.plan.dueOn')} ${calendarDate(i.dueOn, locale)}` : ''}
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

  const missingSentence = (m: { code: string; key: string | null }) =>
    t(`brief.missing.${m.code}`, missingParams(m, (id) => phaseNumberIn(phases, id), () => '', (n) => formatCount(n, locale)));

  // "X of Y allocated" — only for a reader who may see money, and only once a plan or a price exists to talk about.
  const priceText = contract.amount ? formatAmount(contract.amount, locale) : null;
  const allocatedText = formatAmount(plan?.total ?? '0', locale);
  const balanced = contract.amount !== null && contract.amount !== undefined && plan !== null && plan.total === contract.amount;
  const showAllocation = canSeeMoney && (plan !== null || contract.amount);

  const progress = contract.project?.progress;

  return (
    <div className="requirements phases-step" data-testid="phases-panel">
      <p className="t-small desk-muted">{staff ? t('phasesStep.lede.staff') : t('phasesStep.lede.customer')}</p>
      {staff && !contract.publishedAt ? (
        <p className="t-small req-notice" data-testid="not-handed-over">
          {t('brief.notHandedOver')}
        </p>
      ) : null}

      {showAllocation ? (
        <p
          className={`t-small plan-allocated${balanced ? '' : ' req-notice'}`}
          data-testid="plan-allocated"
          data-balanced={balanced ? 'true' : 'false'}
          role="status"
        >
          {priceText === null
            ? t('phasesStep.allocatedNoPrice', { allocated: allocatedText })
            : t('phasesStep.allocated', { allocated: allocatedText, total: priceText })}
          {priceText !== null && !balanced ? ` — ${t(plan === null ? 'phasesStep.noPlanYet' : 'phasesStep.unbalanced')}` : ''}
        </p>
      ) : null}

      {staff && progress ? (
        <div className="phase-progress-line" data-testid="phase-progress">
          <span className="t-eyebrow">{t('workspace.phaseProgressLabel')}</span>
          <span className="t-small">
            {progress.totalPhases === 0
              ? t('demo.progress.none')
              : t('demo.progress.line', {
                  current: progress.currentPhaseNumber,
                  total: progress.totalPhases,
                  n: formatCount(progress.currentPhaseNumber ?? 0, locale),
                  nTotal: formatCount(progress.totalPhases, locale),
                })}
          </span>
        </div>
      ) : null}

      {canAuthor ? (
        <div className="req-editor" data-testid="phases-editors">
          <Accordion id="phases" title={t('brief.phases.title')} open={open.has('phases')} onToggle={() => toggle('phases')} missing={lacks(['PHASES', 'PHASE_END_DATE'])}>
            <PhasesEditor contract={contract} />
          </Accordion>
          {can(me, 'money.read') ? (
            <Accordion id="plan" title={t('brief.plan.title')} open={open.has('plan')} onToggle={() => toggle('plan')} missing={lacks(['PAYMENT_PLAN', 'PAYMENT_PLAN_TOTAL'])}>
              <PlanEditor contract={contract} />
            </Accordion>
          ) : null}
          <p className="t-caption desk-muted">{t('brief.form.savedSeparately')}</p>
        </div>
      ) : null}

      {staff && step.locked && (can(me, 'contracts.author') || can(me, 'builds.author')) ? (
        <PhaseDoneControls contract={contract} phases={phases} />
      ) : null}

      {missing.length > 0 ? (
        <div className="req-completing" data-testid="plan-missing">
          <p className="req-completing-title">{staff ? t('phasesStep.missingTitle.staff') : t('phasesStep.missingTitle.customer')}</p>
          <ul>
            {missing.map((m) => (
              <li key={`${m.code}:${m.key ?? ''}`} data-code={m.code}>
                {missingSentence(m)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <FeedbackPanel
        contractId={contract.id}
        step="REQUIREMENTS"
        targets={targets}
        generalItem={null}
        showGeneral={false}
        canRaise={!staff && !step.locked && !!contract.publishedAt}
        canAnswer={staff && can(me, 'feedback.answer')}
        answerDirect={can(me, 'answers.direct.agreement')}
        locked={step.locked}
        onChanged={() => void refetch()}
      />
    </div>
  );
}
