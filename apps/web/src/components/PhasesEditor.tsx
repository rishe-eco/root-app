import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, formatAmount, formatCount } from '@/lib/format';
import DayInput from '@/components/DayInput';
import MoneyReadout from '@/components/MoneyReadout';
import { SectionHead, day, refusalText } from '@/components/EditorKit';
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
  const [update, { loading }] = useMutation(UPDATE_PHASE);
  const [remove] = useMutation(DELETE_PHASE);
  const [titleFa, setTitleFa] = useState(phase.titleFa);
  const [titleEn, setTitleEn] = useState(phase.titleEn);
  const [end, setEnd] = useState(day(phase.plannedEndAt));
  // The milestone label the invoices and the agreement print beside the phase (the old Phases tab edited it; DX2a keeps it here).
  const [milestone, setMilestone] = useState(phase.milestoneLabel ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: { phaseId: phase.id, titleFa, titleEn, milestoneLabel: milestone.trim() || null, plannedEndAt: end || null, contractId: contract.id },
      });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

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
    <form className="req-phase" onSubmit={save} data-testid="brief-phase" data-number={phase.number}>
      <span className="badge num-latin">{formatCount(phase.number, locale)}</span>
      <input className="input" dir="rtl" required aria-label={t('workspace.titleFa')} value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
      <input className="input" dir="ltr" required aria-label={t('workspace.titleEn')} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
      <DayInput value={end} onChange={setEnd} label={t('brief.phases.plannedEnd', { n: formatCount(phase.number, locale) })} testId={`phase-end-${phase.number}`} />
      <input className="input" aria-label={t('workspace.phaseMilestone')} placeholder={t('workspace.phaseMilestone')} value={milestone} onChange={(e) => setMilestone(e.target.value)} data-testid={`phase-milestone-${phase.number}`} />
      <span className="workspace-row">
        <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
          {t('workspace.save')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
          {t('workspace.delete')}
        </button>
      </span>
      {error ? <p className="error">{error}</p> : null}
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
  const [error, setError] = useState<string | null>(null);
  const next = phases.length === 0 ? 1 : Math.max(...phases.map((p) => p.number)) + 1;

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create({
        variables: { contractId: contract.id, number: next, titleFa: titleFa.trim(), titleEn: titleEn.trim(), plannedEndAt: end || null },
      });
      setTitleFa('');
      setTitleEn('');
      setEnd('');
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="phases-editor">
      <SectionHead title={t('brief.phases.title')} help={t('brief.phases.help')} />
      {phases.map((p) => (
        <PhaseRow key={`${p.id}:${p.plannedEndAt ?? ''}:${p.titleFa}:${p.titleEn}:${p.milestoneLabel ?? ''}`} contract={contract} phase={p} />
      ))}
      <form className="req-phase req-phase-new" onSubmit={add} data-testid="brief-phase-new">
        <span className="badge num-latin">+</span>
        <input className="input" dir="rtl" required aria-label={t('workspace.titleFa')} placeholder={t('workspace.titleFa')} value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
        <input className="input" dir="ltr" required aria-label={t('workspace.titleEn')} placeholder={t('workspace.titleEn')} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
        <DayInput value={end} onChange={setEnd} label={t('brief.phases.newPlannedEnd')} testId="phase-end-new" />
        <span className="workspace-row">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={loading || !titleFa.trim() || !titleEn.trim()}>
            {t('brief.phases.add')}
          </button>
        </span>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The payment plan
// ---------------------------------------------------------------------------

type PlanRow = { labelFa: string; labelEn: string; amount: string; phaseId: string; paymentTermDays: string };

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

export function PlanEditor({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [save, { loading }] = useMutation(SET_PAYMENT_PLAN);
  const plan = contract.paymentPlan ?? null;
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const fee = contract.amount ? BigInt(contract.amount) : null;

  const [split, setSplit] = useState<Split>(plan?.split ?? 'INSTALLMENTS');
  const [count, setCount] = useState('3');
  const [rows, setRows] = useState<PlanRow[]>(() =>
    (plan?.invoices ?? []).map((i) => ({
      labelFa: i.labelFa,
      labelEn: i.labelEn,
      amount: i.amount,
      phaseId: i.phaseId ?? '',
      paymentTermDays: String(i.paymentTermDays),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    setRows(proposed.map((p) => ({ ...p, phaseId: p.phaseId ?? '', paymentTermDays: String(p.paymentTermDays) })));
    setSaved(false);
  }

  const edit = (i: number, patch: Partial<PlanRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const total = rows.reduce((sum, r) => {
    const a = normalizeAmount(r.amount);
    return /^\d+$/.test(a) ? sum + BigInt(a) : sum;
  }, 0n);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const invoices: PlannedInvoiceInput[] = rows.map((r) => ({
      labelFa: r.labelFa,
      labelEn: r.labelEn,
      amount: normalizeAmount(r.amount),
      phaseId: r.phaseId || null,
      paymentTermDays: Number(r.paymentTermDays),
    }));
    try {
      await save({ variables: { contractId: contract.id, split, invoices } });
      setSaved(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <form className="card editor-card auth-form" onSubmit={onSave} data-testid="plan-editor">
      <SectionHead title={t('brief.plan.title')} help={t('brief.plan.help')} />
      <div className="workspace-row">
        <select className="input" aria-label={t('brief.plan.splitLabel')} value={split} onChange={(e) => setSplit(e.target.value as Split)}>
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
              <input className="input" dir="rtl" required aria-label={t('brief.plan.labelFa')} value={r.labelFa} onChange={(e) => edit(i, { labelFa: e.target.value })} />
              <input className="input" dir="ltr" required aria-label={t('brief.plan.labelEn')} value={r.labelEn} onChange={(e) => edit(i, { labelEn: e.target.value })} />
              <div className="money-field">
                <input className="input num-latin" dir="ltr" inputMode="numeric" required aria-label={t('brief.plan.amount')} value={r.amount} onChange={(e) => edit(i, { amount: e.target.value })} />
                <MoneyReadout value={normalizeAmount(r.amount)} testId="plan-amount-readout" />
              </div>
              <select className="input" aria-label={t('brief.plan.phase')} value={r.phaseId} onChange={(e) => edit(i, { phaseId: e.target.value })}>
                <option value="">{t('brief.plan.noPhase')}</option>
                {phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t('brief.plan.phaseOption', { n: formatCount(p.number, locale), title: pick(p, 'title', locale) })}
                  </option>
                ))}
              </select>
              <input className="input num-latin" dir="ltr" inputMode="numeric" required aria-label={t('brief.plan.term')} value={r.paymentTermDays} onChange={(e) => edit(i, { paymentTermDays: e.target.value })} />
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                {t('workspace.delete')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => setRows([...rows, { labelFa: '', labelEn: '', amount: '', phaseId: '', paymentTermDays: '7' }])}
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
      {error ? (
        <p className="error" role="alert" data-testid="plan-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="t-small" role="status" data-testid="plan-saved">
          {t('brief.form.saved')}
        </p>
      ) : null}
      <div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading || rows.length === 0} data-testid="plan-save">
          {t('workspace.save')}
        </button>
      </div>
    </form>
  );
}

