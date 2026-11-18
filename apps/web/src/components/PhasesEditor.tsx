import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, formatAmount, formatCount } from '@/lib/format';
import DayInput from '@/components/DayInput';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import MoneyReadout from '@/components/MoneyReadout';
import { SectionHead, day, refusalText } from '@/components/EditorKit';
import InlineAdd from '@/components/InlineAdd';
import i18n from '@/i18n';
import { normalizeAmount } from '@/lib/brief';
import { proposeRows, type Labeller, type Split } from '@/lib/planProposal';
import { CREATE_PHASE, DELETE_PHASE, SET_PAYMENT_PLAN, UPDATE_PHASE, type Contract, type PlannedInvoiceInput } from '@/lib/queries';

/**
 * The desk's phases and payment plan editors (journeys build plan J4), which
 * lived inside Requirements until **DX2a gave them a step of their own**
 * (Phases and payment, between Pages and features and the draft; desk UX review
 * 10, 11). The forms are unchanged — each saved on its own, each a
 * `contracts.author` write that refuses `STEP_LOCKED` once the agreement is
 * approved (the API now asks PHASES, not REQUIREMENTS) — and `PhasesPanel`
 * mounts them for staff while the step is open.
 */

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

export function PhaseRow({ contract, phase }: { contract: Contract; phase: NonNullable<Contract['phases']>[number] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [update] = useMutation(UPDATE_PHASE);
  const [remove] = useMutation(DELETE_PHASE);
  const [titleFa, setTitleFa] = useState(phase.titleFa);
  const [titleEn, setTitleEn] = useState(phase.titleEn);
  const [end, setEnd] = useState(day(phase.plannedEndAt));
  // The milestone label the invoices and the agreement print beside the phase (the old Phases tab edited it; DX2a keeps it here).
  const [milestone, setMilestone] = useState(phase.milestoneLabel ?? '');
  // DX2b: "Has a demo". Off for a phase the customer has nothing to review in (a kick-off): no Demo step, staff mark it done.
  const [hasDemo, setHasDemo] = useState(phase.hasDemo !== false);
  const [error, setError] = useState<string | null>(null);

  // DX4 (review 27): a phase row saves when a field in it is left; `updatePhase` takes the title,
  // the end, the milestone and the switch together, so each save sends the row as it stands.
  const autosave = useAutosave({
    value: { titleFa, titleEn, end, milestone: milestone.trim(), hasDemo },
    baseline: {
      titleFa: phase.titleFa,
      titleEn: phase.titleEn,
      end: day(phase.plannedEndAt),
      milestone: (phase.milestoneLabel ?? '').trim(),
      hasDemo: phase.hasDemo !== false,
    },
    valid: (v) => hasOneTitle(v.titleFa, v.titleEn),
    save: (v) =>
      update({
        variables: {
          phaseId: phase.id,
          titleFa: v.titleFa,
          titleEn: v.titleEn,
          milestoneLabel: v.milestone || null,
          plannedEndAt: v.end || null,
          hasDemo: v.hasDemo,
          contractId: contract.id,
        },
      }),
    errorText: (err) => refusalText(t, err),
  });

  async function onDelete() {
    if (!confirm(t('brief.phases.confirmDelete'))) return;
    setError(null);
    try {
      await remove({ variables: { phaseId: phase.id, contractId: contract.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <form className="req-phase" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur} data-testid="brief-phase" data-number={phase.number}>
      <span className="badge num-latin">{formatCount(phase.number, locale)}</span>
      <TitleField
        idBase={`phase-${phase.number}`}
        testId={`phase-title-${phase.number}`}
        fa={titleFa}
        en={titleEn}
        onChange={(v) => {
          setTitleFa(v.fa);
          setTitleEn(v.en);
        }}
      />
      <div className="field">
        <span className="label">{t('brief.phases.plannedEnd', { n: formatCount(phase.number, locale) })}</span>
        <DayInput value={end} onChange={setEnd} label={t('brief.phases.plannedEnd', { n: formatCount(phase.number, locale) })} testId={`phase-end-${phase.number}`} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`phase-milestone-${phase.number}`}>
          {t('workspace.phaseMilestone')}
        </label>
        <input id={`phase-milestone-${phase.number}`} className="input" value={milestone} onChange={(e) => setMilestone(e.target.value)} data-testid={`phase-milestone-${phase.number}`} />
      </div>
      <label className="t-small req-check" title={t('brief.phases.hasDemoHelp')}>
        <input type="checkbox" checked={hasDemo} onChange={(e) => {
          setHasDemo(e.target.checked);
          autosave.commit({ titleFa, titleEn, end, milestone: milestone.trim(), hasDemo: e.target.checked });
        }} data-testid={`phase-hasdemo-${phase.number}`} /> {t('brief.phases.hasDemo')}
      </label>
      <span className="workspace-row">
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
          {t('workspace.delete')}
        </button>
      </span>
      {error ? <p className="error">{error}</p> : null}
      <AutosaveNote autosave={autosave} testId={`phase-autosave-${phase.number}`} />
    </form>
  );
}

export function PhasesEditor({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const [create, { loading }] = useMutation(CREATE_PHASE);
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [end, setEnd] = useState('');
  const next = phases.length === 0 ? 1 : Math.max(...phases.map((p) => p.number)) + 1;
  const reset = () => {
    setTitleFa('');
    setTitleEn('');
    setEnd('');
  };

  return (
    <div className="card editor-card" data-testid="phases-editor">
      <SectionHead title={t('brief.phases.title')} help={t('brief.phases.help')} />
      {phases.map((p) => (
        <PhaseRow key={p.id} contract={contract} phase={p} />
      ))}
      {/* DX6: the desk's one way to add — a button, then a small form with Add and Cancel (InlineAdd). */}
      <InlineAdd
        label={t('brief.phases.add')}
        testId="brief-phase-new"
        ready={hasOneTitle(titleFa, titleEn)}
        busy={loading}
        onCancel={reset}
        errorText={(err) => refusalText(t, err)}
        onSubmit={async () => {
          await create({ variables: { contractId: contract.id, number: next, titleFa: titleFa.trim(), titleEn: titleEn.trim(), plannedEndAt: end || null } });
          reset();
        }}
      >
        <TitleField idBase="phase-new" testId="phase-title-new" fa={titleFa} en={titleEn} onChange={(v) => { setTitleFa(v.fa); setTitleEn(v.en); }} />
        <div className="field">
          <span className="label">{t('brief.phases.newPlannedEnd')}</span>
          <DayInput value={end} onChange={setEnd} label={t('brief.phases.newPlannedEnd')} testId="phase-end-new" />
        </div>
      </InlineAdd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The payment plan
// ---------------------------------------------------------------------------

type PlanRow = { labelFa: string; labelEn: string; amount: string; phaseId: string; dueOn: string; paymentTermDays: string };
/** DX2b: how a row falls due — on signing, when a phase is done, or on a date. The row stores at most one of a phase and a date. */
type Trigger = 'SIGNING' | 'PHASE' | 'DATE';
const triggerOf = (r: Pick<PlanRow, 'phaseId' | 'dueOn'>): Trigger => (r.dueOn ? 'DATE' : r.phaseId ? 'PHASE' : 'SIGNING');

/** A row's label in each language, whichever the desk is read in — a stored label is bilingual. */
function labellerFor(lang: 'fa' | 'en'): Labeller {
  const t = i18n.getFixedT(lang);
  return {
    lump: () => t('brief.plan.proposal.lump'),
    installment: (n, of) => {
      const nf = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { useGrouping: false });
      return t('brief.plan.proposal.installment', { n: nf.format(n), of: nf.format(of) });
    },
    month: (m, y) => {
      const nf = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { useGrouping: false });
      return t('brief.plan.proposal.month', { month: t(`jalali.months.${m}`), year: nf.format(y) });
    },
  };
}

/** The rows the editor starts from, off the stored plan. */
function rowsFrom(plan: Contract['paymentPlan'] | null | undefined): PlanRow[] {
  return (plan?.invoices ?? []).map((i) => ({
    labelFa: i.labelFa,
    labelEn: i.labelEn,
    amount: i.amount,
    phaseId: i.phaseId ?? '',
    dueOn: day(i.dueOn),
    paymentTermDays: String(i.paymentTermDays),
  }));
}

/** What `setPaymentPlan` is sent for these rows. */
function payloadOf(rows: PlanRow[]): PlannedInvoiceInput[] {
  return rows.map((r) => ({
    labelFa: r.labelFa,
    labelEn: r.labelEn,
    amount: normalizeAmount(r.amount),
    phaseId: triggerOf(r) === 'PHASE' ? r.phaseId || null : null,
    dueOn: triggerOf(r) === 'DATE' ? r.dueOn : null,
    paymentTermDays: Number(r.paymentTermDays),
  }));
}

/** Whether every row could be saved: a label in one language, whole Toman above zero, a term of 0-365 days, and a day when it is due on one. */
function checkRows(rows: PlannedInvoiceInput[]): boolean {
  return rows.every(
    (r) =>
      hasOneTitle(r.labelFa, r.labelEn) &&
      /^\d+$/.test(r.amount) &&
      BigInt(r.amount) > 0n &&
      Number.isInteger(r.paymentTermDays) &&
      r.paymentTermDays >= 0 &&
      r.paymentTermDays <= 365 &&
      r.dueOn !== '',
  );
}

export function PlanEditor({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [save] = useMutation(SET_PAYMENT_PLAN);
  const plan = contract.paymentPlan ?? null;
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const fee = contract.amount ? BigInt(contract.amount) : null;

  const [split, setSplit] = useState<Split>(plan?.split ?? 'INSTALLMENTS');
  const [count, setCount] = useState('3');
  const [rows, setRows] = useState<PlanRow[]>(() => rowsFrom(plan));


  function propose() {
    const proposed = proposeRows({
      split,
      total: fee,
      count: Number(count) || 1,
      phases,
      start: null,
      today: new Date().toISOString().slice(0, 10),
      fa: labellerFor('fa'),
      en: labellerFor('en'),
    });
    const next = proposed.map((p) => ({ ...p, phaseId: p.phaseId ?? '', dueOn: '', paymentTermDays: String(p.paymentTermDays) }));
    setRows(next);
    // A proposal is an act on the whole plan, so it saves at once (DX4); the rows are the plan.
    autosave.commit({ split, invoices: payloadOf(next) });
  }

  // DX4 (review 27): the plan saves when a field in it is left. `setPaymentPlan` replaces the whole
  // plan, so a save sends the split and every row as they stand; what is compared is exactly what
  // would be sent, so a typed Persian digit and its normalized form are the same plan.
  const autosave = useAutosave({
    value: { split, invoices: payloadOf(rows) },
    baseline: { split: plan?.split ?? 'INSTALLMENTS', invoices: payloadOf(rowsFrom(plan)) },
    valid: (v) => v.invoices.length > 0 && checkRows(v.invoices),
    save: (v) => save({ variables: { contractId: contract.id, split: v.split, invoices: v.invoices } }),
    errorText: (err) => refusalText(t, err),
  });

  const edit = (i: number, patch: Partial<PlanRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const total = rows.reduce((sum, r) => {
    const a = normalizeAmount(r.amount);
    return /^\d+$/.test(a) ? sum + BigInt(a) : sum;
  }, 0n);

  return (
    <form className="card editor-card auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur} data-testid="plan-editor">
      <SectionHead title={t('brief.plan.title')} help={t('brief.plan.help')} />
      <div className="workspace-row">
        <select
          className="input"
          aria-label={t('brief.plan.splitLabel')}
          value={split}
          onChange={(e) => {
            setSplit(e.target.value as Split);
            autosave.commit({ split: e.target.value, invoices: payloadOf(rows) });
          }}
        >
          <option value="LUMP_SUM">{t('brief.plan.splitOption.LUMP_SUM')}</option>
          <option value="INSTALLMENTS">{t('brief.plan.splitOption.INSTALLMENTS')}</option>
          <option value="MONTHLY">{t('brief.plan.splitOption.MONTHLY')}</option>
        </select>
        {split === 'LUMP_SUM' ? null : (
          <input
            className="input num-latin"
            dir="ltr"
            inputMode="numeric"
            aria-label={t('brief.plan.count')}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        )}
        <button className="btn btn-ghost btn-sm" type="button" onClick={propose} data-testid="plan-propose">
          {t('brief.plan.propose')}
        </button>
      </div>
      <p className="t-caption">{t('brief.plan.proposeHelp')}</p>

      {rows.length > 0 ? (
        <div className="plan-table" role="table">
          {rows.map((r, i) => (
            <div className="plan-row" role="row" key={i} data-testid="plan-row">
              <TitleField idBase={`plan-${i}`} testId={`plan-label-${i}`} label={t('brief.plan.label')} fa={r.labelFa} en={r.labelEn} onChange={(v) => edit(i, { labelFa: v.fa, labelEn: v.en })} />
              <div className="field money-field">
                <label className="label" htmlFor={`plan-amount-${i}`}>
                  {t('brief.plan.amount')}
                </label>
                <input id={`plan-amount-${i}`} className="input num-latin" dir="ltr" inputMode="numeric" required value={r.amount} onChange={(e) => edit(i, { amount: e.target.value })} />
                <MoneyReadout value={normalizeAmount(r.amount)} testId="plan-amount-readout" />
              </div>
              <div className="field">
                <label className="label" htmlFor={`plan-trigger-${i}`}>
                  {t('brief.plan.trigger')}
                </label>
                <select
                  id={`plan-trigger-${i}`}
                  className="input"
                  value={triggerOf(r)}
                  data-testid="plan-trigger"
                  onChange={(e) => {
                    const next = e.target.value as Trigger;
                    // One trigger at a time: choosing one clears the other's value (the database holds the same rule).
                    const patch = { phaseId: next === 'PHASE' ? (r.phaseId || phases[0]?.id || '') : '', dueOn: next === 'DATE' ? r.dueOn || new Date().toISOString().slice(0, 10) : '' };
                    edit(i, patch);
                    autosave.commit({ split, invoices: payloadOf(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))) });
                  }}
                >
                  <option value="SIGNING">{t('brief.plan.triggerOption.SIGNING')}</option>
                  <option value="PHASE" disabled={phases.length === 0}>{t('brief.plan.triggerOption.PHASE')}</option>
                  <option value="DATE">{t('brief.plan.triggerOption.DATE')}</option>
                </select>
              </div>
              {triggerOf(r) === 'PHASE' ? (
                <div className="field">
                  <label className="label" htmlFor={`plan-phase-${i}`}>
                    {t('brief.plan.phase')}
                  </label>
                  <select
                    id={`plan-phase-${i}`}
                    className="input"
                    value={r.phaseId}
                    onChange={(e) => {
                      edit(i, { phaseId: e.target.value });
                      autosave.commit({ split, invoices: payloadOf(rows.map((x, j) => (j === i ? { ...x, phaseId: e.target.value } : x))) });
                    }}
                  >
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {t('brief.plan.phaseOption', { n: formatCount(p.number, locale), title: pick(p, 'title', locale) })}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {triggerOf(r) === 'DATE' ? (
                <div className="field">
                  <span className="label">{t('brief.plan.dueOn')}</span>
                  <DayInput value={r.dueOn} onChange={(v) => edit(i, { dueOn: v })} label={t('brief.plan.dueOn')} testId={`plan-due-${i}`} />
                </div>
              ) : null}
              <div className="field">
                <label className="label" htmlFor={`plan-term-${i}`}>
                  {t('brief.plan.term')}
                </label>
                <input id={`plan-term-${i}`} className="input num-latin" dir="ltr" inputMode="numeric" required value={r.paymentTermDays} onChange={(e) => edit(i, { paymentTermDays: e.target.value })} />
                <span className="t-caption">{t('brief.plan.termHelp')}</span>
              </div>
              <div className="plan-row-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => {
                    const next = rows.filter((_, j) => j !== i);
                    setRows(next);
                    // Deleting a row is an act, saved at once; the last row cannot be deleted into an empty plan the API would refuse.
                    autosave.commit({ split, invoices: payloadOf(next) });
                  }}
                >
                  {t('workspace.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => setRows([...rows, { labelFa: '', labelEn: '', amount: '', phaseId: '', dueOn: '', paymentTermDays: '7' }])}
      >
        {t('brief.plan.addRow')}
      </button>

      <p className="t-small" data-testid="plan-total">
        {fee === null
          ? t('brief.plan.totalNoFee', { total: formatAmount(total.toString(), locale) })
          : total === fee
            ? t('brief.plan.totalMatches', { total: formatAmount(total.toString(), locale) })
            : t('brief.plan.totalDiffers', {
                total: formatAmount(total.toString(), locale),
                fee: formatAmount(fee.toString(), locale),
              })}
      </p>
      <AutosaveNote autosave={autosave} testId="plan-autosave" />
    </form>
  );
}

