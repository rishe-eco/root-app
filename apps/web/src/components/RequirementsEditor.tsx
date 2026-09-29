import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, formatAmount, formatCount } from '@/lib/format';
import { errorCode } from '@/components/FeedbackPanel';
import DayInput from '@/components/DayInput';
import i18n from '@/i18n';
import {
  COMMITMENT_KEYS,
  PROVIDER_KEYS,
  impliedRows,
  isIncludedExtra,
  normalizeAmount,
  type ProviderKey,
} from '@/lib/brief';
import { proposeRows, type Labeller, type Split } from '@/lib/planProposal';
import {
  CREATE_PHASE,
  DELETE_PHASE,
  PUBLISH_CONTRACT,
  SET_BRIEF,
  SET_EXTRA,
  SET_PAYMENT_PLAN,
  TEMPLATE_TYPES,
  UPDATE_PHASE,
  type BriefInput,
  type BriefKind,
  type Contract,
  type DependencySide,
  type DesignTier,
  type PlannedInvoiceInput,
  type TemplateType,
  type User,
} from '@/lib/queries';

/**
 * The desk's step 1 (journeys build plan J4): the form sales fills in from the
 * request chat. It sits above the read-only cards the customer sees
 * (`RequirementsPanel`), so what sales types is what the customer will read,
 * field by field.
 *
 * Five small forms, each saved on its own — the brief (with the dated
 * commitments it implies), the extras, the phases, the payment plan — and the
 * hand-over. Each is a `contracts.author` write and refuses with `STEP_LOCKED`
 * once the agreement is approved, so the panel does not render this at all for
 * a locked step (a control that can only fail is worse than one that is not
 * there). **Every date is a `DayInput`** — three selects over the Jalali
 * calendar, speaking `YYYY-MM-DD` and never a `Date` (PD-19).
 *
 * **Money** (`budgetCap`, the plan) is written by whoever holds
 * `money.read` and shown to nobody else — the API resolves both to null for
 * them, and the fields are not drawn.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

/** A refusal's sentence: the code's own line when the locale has one, the message otherwise. */
function refusalText(t: T, err: unknown): string {
  const code = errorCode(err);
  return code && t(`brief.error.${code}`, { defaultValue: '' }) ? t(`brief.error.${code}`) : (err as Error).message;
}

function SectionHead({ title, help }: { title: string; help?: string }) {
  return (
    <>
      <h4 className="t-h4">{title}</h4>
      {help ? <p className="sec-help">{help}</p> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

function BriefForm({ contract, me }: { contract: Contract; me: User }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const brief = contract.brief ?? null;
  const canMoney = can(me, 'money.read');
  const { data: typesData } = useQuery<{ templateTypes: TemplateType[] }>(TEMPLATE_TYPES);
  const types = (typesData?.templateTypes ?? []).filter((x) => x.active || x.id === brief?.templateType.id);
  const [setBrief, { loading }] = useMutation(SET_BRIEF);

  const board = contract.project.dependencies.filter((d) => d.briefKey);
  const boardBy = (key: string) => board.find((d) => d.briefKey === key);

  const [kind, setKind] = useState<BriefKind>(brief?.kind ?? 'NEW_SITE');
  const [existingSiteUrl, setExistingSiteUrl] = useState(brief?.existingSiteUrl ?? '');
  const [templateTypeId, setTemplateTypeId] = useState(brief?.templateType.id ?? '');
  const [designTier, setDesignTier] = useState<DesignTier>(brief?.designTier ?? 'THEME_PICK');
  const [budgetCap, setBudgetCap] = useState(brief?.budgetCap ?? '');
  const [idealDeadline, setIdealDeadline] = useState(day(brief?.idealDeadline));
  const [hardDeadline, setHardDeadline] = useState(day(brief?.hardDeadline));
  const [domainName, setDomainName] = useState(brief?.domainName ?? '');
  const [providers, setProviders] = useState<Record<ProviderKey, DependencySide | ''>>({
    domain: brief?.domainProvidedBy ?? '',
    host: brief?.hostProvidedBy ?? '',
    content: brief?.contentProvidedBy ?? '',
  });
  const [supportMonths, setSupportMonths] = useState(str(brief?.supportMonths));
  const [premadeRounds, setPremadeRounds] = useState(str(brief?.premadeRounds));
  const [wireframeIterations, setWireframeIterations] = useState(str(brief?.wireframeIterations ?? 2));
  const [mockupIterations, setMockupIterations] = useState(str(brief?.mockupIterations));
  const [demoIterations, setDemoIterations] = useState(str(brief?.demoIterationsPerPhase));

  // The commitments the form implies as it stands — dates from the board, sides
  // for the extras' (the three provider keys take theirs from the providers).
  const includedExtraKeys = contract.scopeItems.filter((s) => s.kind === 'EXTRA' && isIncludedExtra(s.status)).map((s) => s.key);
  const rows = impliedRows(providers, includedExtraKeys);
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(COMMITMENT_KEYS.map((k) => [k, day(boardBy(k)?.dueAt)])),
  );
  const [sides, setSides] = useState<Record<string, DependencySide>>(() =>
    Object.fromEntries(COMMITMENT_KEYS.map((k) => [k, boardBy(k)?.side ?? 'CUSTOMER'])),
  );

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const input: BriefInput = {
      kind,
      existingSiteUrl: kind === 'FEATURE_FOR_EXISTING' ? existingSiteUrl.trim() || null : null,
      templateTypeId,
      designTier,
      budgetCap: canMoney ? normalizeAmount(budgetCap) || null : null,
      idealDeadline: idealDeadline || null,
      hardDeadline: hardDeadline || null,
      domainName: domainName.trim() || null,
      domainProvidedBy: providers.domain || null,
      hostProvidedBy: providers.host || null,
      contentProvidedBy: providers.content || null,
      supportMonths: numberOrNull(supportMonths),
      premadeRounds: numberOrNull(premadeRounds),
      wireframeIterations: numberOrNull(wireframeIterations),
      mockupIterations: numberOrNull(mockupIterations),
      demoIterationsPerPhase: numberOrNull(demoIterations),
      commitments: rows.map((r) => ({ key: r.key, side: sides[r.key], dueAt: dates[r.key] || null })),
    };
    try {
      await setBrief({ variables: { contractId: contract.id, input } });
      setSaved(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  const providerSelect = (key: ProviderKey) => (
    <div className="field" key={key}>
      <label className="label" htmlFor={`brief-provider-${key}`}>
        {t(`brief.form.provider.${key}`)}
      </label>
      <select
        id={`brief-provider-${key}`}
        className="input"
        value={providers[key]}
        onChange={(e) => setProviders({ ...providers, [key]: e.target.value as DependencySide | '' })}
      >
        <option value="">{t('brief.form.providerUnset')}</option>
        <option value="CUSTOMER">{t('brief.side.CUSTOMER')}</option>
        <option value="ROOT">{t('brief.side.ROOT')}</option>
      </select>
    </div>
  );

  return (
    <form className="card editor-card auth-form" onSubmit={onSubmit} data-testid="brief-form">
      <SectionHead title={t('brief.form.title')} help={t('brief.form.help')} />

      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor="brief-kind">
            {t('brief.form.kind')}
          </label>
          <select id="brief-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as BriefKind)}>
            <option value="NEW_SITE">{t('brief.kind.NEW_SITE')}</option>
            <option value="FEATURE_FOR_EXISTING">{t('brief.kind.FEATURE_FOR_EXISTING')}</option>
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="brief-type">
            {t('brief.form.templateType')}
          </label>
          <select
            id="brief-type"
            className="input"
            required
            value={templateTypeId}
            onChange={(e) => setTemplateTypeId(e.target.value)}
          >
            <option value="">{t('brief.form.templateTypePick')}</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {pick(type, 'label', locale)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {kind === 'FEATURE_FOR_EXISTING' ? (
        <div className="field">
          <label className="label" htmlFor="brief-site">
            {t('brief.form.existingSiteUrl')}
          </label>
          <input
            id="brief-site"
            className="input num-latin"
            dir="ltr"
            inputMode="url"
            placeholder="https://"
            value={existingSiteUrl}
            onChange={(e) => setExistingSiteUrl(e.target.value)}
          />
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="brief-tier">
          {t('brief.form.designTier')}
        </label>
        <select id="brief-tier" className="input" value={designTier} onChange={(e) => setDesignTier(e.target.value as DesignTier)}>
          <option value="THEME_PICK">{t('brief.tier.THEME_PICK')}</option>
          <option value="CLAUDE_ASSISTED">{t('brief.tier.CLAUDE_ASSISTED')}</option>
          <option value="SENIOR_DESIGNER">{t('brief.tier.SENIOR_DESIGNER')}</option>
        </select>
        <p className="t-caption">{t('brief.form.designTierHelp')}</p>
      </div>

      {canMoney ? (
        <div className="field">
          <label className="label" htmlFor="brief-budget">
            {t('brief.form.budgetCap')}
          </label>
          <input
            id="brief-budget"
            className="input num-latin"
            dir="ltr"
            inputMode="numeric"
            value={budgetCap}
            onChange={(e) => setBudgetCap(e.target.value)}
          />
          <p className="t-caption">{t('brief.form.budgetCapHelp')}</p>
        </div>
      ) : null}

      <div className="editor-grid-2">
        <div className="field">
          <span className="label">{t('brief.form.idealDeadline')}</span>
          <DayInput value={idealDeadline} onChange={setIdealDeadline} label={t('brief.form.idealDeadline')} testId="brief-ideal" />
        </div>
        <div className="field">
          <span className="label">{t('brief.form.hardDeadline')}</span>
          <DayInput value={hardDeadline} onChange={setHardDeadline} label={t('brief.form.hardDeadline')} testId="brief-hard" />
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="brief-support">
          {t('brief.form.supportMonths')}
        </label>
        <input
          id="brief-support"
          className="input num-latin"
          dir="ltr"
          inputMode="numeric"
          value={supportMonths}
          onChange={(e) => setSupportMonths(e.target.value)}
        />
      </div>

      <p className="t-eyebrow">{t('brief.form.providersTitle')}</p>
      <div className="editor-grid-2">
        {PROVIDER_KEYS.map(providerSelect)}
        <div className="field">
          <label className="label" htmlFor="brief-domain-name">
            {t('brief.form.domainName')}
          </label>
          <input
            id="brief-domain-name"
            className="input num-latin"
            dir="ltr"
            value={domainName}
            onChange={(e) => setDomainName(e.target.value)}
          />
        </div>
      </div>

      {rows.length > 0 ? (
        <>
          <p className="t-eyebrow">{t('brief.form.commitmentsTitle')}</p>
          <p className="sec-help">{t('brief.form.commitmentsHelp')}</p>
          {rows.map((r) => (
            <div className="editor-grid-2" key={r.key} data-testid="brief-commitment" data-key={r.key}>
              <div className="field">
                <span className="label">{t('brief.form.commitmentDue', { what: t(`brief.commitment.${r.key}`) })}</span>
                <DayInput
                  value={dates[r.key] ?? ''}
                  onChange={(v) => setDates({ ...dates, [r.key]: v })}
                  label={t('brief.form.commitmentDue', { what: t(`brief.commitment.${r.key}`) })}
                  testId={`brief-due-${r.key}`}
                />
              </div>
              {r.fromBrief ? null : (
                <div className="field">
                  <label className="label" htmlFor={`brief-side-${r.key}`}>
                    {t('brief.form.commitmentSide')}
                  </label>
                  <select
                    id={`brief-side-${r.key}`}
                    className="input"
                    value={sides[r.key]}
                    onChange={(e) => setSides({ ...sides, [r.key]: e.target.value as DependencySide })}
                  >
                    <option value="CUSTOMER">{t('brief.side.CUSTOMER')}</option>
                    <option value="ROOT">{t('brief.side.ROOT')}</option>
                  </select>
                </div>
              )}
            </div>
          ))}
        </>
      ) : null}

      <p className="t-eyebrow">{t('brief.form.allowancesTitle')}</p>
      <div className="editor-grid-2">
        {designTier === 'THEME_PICK' ? (
          <div className="field">
            <label className="label" htmlFor="brief-premade">
              {t('brief.form.premadeRounds')}
            </label>
            <input id="brief-premade" className="input num-latin" dir="ltr" inputMode="numeric" value={premadeRounds} onChange={(e) => setPremadeRounds(e.target.value)} />
          </div>
        ) : (
          <>
            <div className="field">
              <label className="label" htmlFor="brief-wireframes">
                {t('brief.form.wireframeIterations')}
              </label>
              <input id="brief-wireframes" className="input num-latin" dir="ltr" inputMode="numeric" value={wireframeIterations} onChange={(e) => setWireframeIterations(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="brief-mockups">
                {t('brief.form.mockupIterations')}
              </label>
              <input id="brief-mockups" className="input num-latin" dir="ltr" inputMode="numeric" value={mockupIterations} onChange={(e) => setMockupIterations(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label className="label" htmlFor="brief-demos">
            {t('brief.form.demoIterations')}
          </label>
          <input id="brief-demos" className="input num-latin" dir="ltr" inputMode="numeric" value={demoIterations} onChange={(e) => setDemoIterations(e.target.value)} />
        </div>
      </div>

      {error ? (
        <p className="error" role="alert" data-testid="brief-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="t-small" role="status" data-testid="brief-saved">
          {t('brief.form.saved')}
        </p>
      ) : null}
      <div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !templateTypeId} data-testid="brief-save">
          {t('workspace.save')}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The extras
// ---------------------------------------------------------------------------

function ExtrasEditor({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [setExtra, { loading }] = useMutation(SET_EXTRA);
  const [error, setError] = useState<string | null>(null);
  const extras = contract.scopeItems.filter((s) => s.kind === 'EXTRA').sort((a, b) => a.position - b.position);
  if (extras.length === 0) return null;

  async function toggle(id: string, included: boolean) {
    setError(null);
    try {
      await setExtra({ variables: { scopeItemId: id, included, contractId: contract.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="extras-editor">
      <SectionHead title={t('brief.extras.title')} help={t('brief.extras.help')} />
      <div className="req-checklist">
        {extras.map((s) => (
          <label className="req-check" key={s.id}>
            <input
              type="checkbox"
              disabled={loading}
              checked={isIncludedExtra(s.status)}
              onChange={(e) => toggle(s.id, e.target.checked)}
              data-key={s.key}
            />
            <span>{pick(s, 'label', locale)}</span>
          </label>
        ))}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

function PhaseRow({ contract, phase }: { contract: Contract; phase: NonNullable<Contract['phases']>[number] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [update, { loading }] = useMutation(UPDATE_PHASE);
  const [remove] = useMutation(DELETE_PHASE);
  const [titleFa, setTitleFa] = useState(phase.titleFa);
  const [titleEn, setTitleEn] = useState(phase.titleEn);
  const [end, setEnd] = useState(day(phase.plannedEndAt));
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: { phaseId: phase.id, titleFa, titleEn, plannedEndAt: end || null, contractId: contract.id },
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

function PhasesEditor({ contract }: { contract: Contract }) {
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
        <PhaseRow key={`${p.id}:${p.plannedEndAt ?? ''}:${p.titleFa}:${p.titleEn}`} contract={contract} phase={p} />
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

function PlanEditor({ contract }: { contract: Contract }) {
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
              <input className="input num-latin" dir="ltr" inputMode="numeric" required aria-label={t('brief.plan.amount')} value={r.amount} onChange={(e) => edit(i, { amount: e.target.value })} />
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

// ---------------------------------------------------------------------------
// Handing it over
// ---------------------------------------------------------------------------

function HandOver({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const [publish, { loading }] = useMutation(PUBLISH_CONTRACT);
  const [error, setError] = useState<string | null>(null);
  if (contract.publishedAt) return null;

  async function onClick() {
    setError(null);
    try {
      await publish({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="hand-over">
      <SectionHead title={t('brief.handOver.title')} help={t('brief.handOver.help')} />
      <div>
        <button className="btn btn-primary btn-sm" type="button" disabled={loading} onClick={onClick} data-testid="hand-over-button">
          {t('brief.handOver.action')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="hand-over-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function RequirementsEditor({ contract, me }: { contract: Contract; me: User }) {
  const { t } = useTranslation();
  return (
    <div className="req-editor" data-testid="requirements-editor">
      {/* No `key` on the forms: after a save the form already holds what the server
          now holds, and remounting would drop the "saved" line the person is
          reading. (A change made elsewhere — a due date edited on the dependency
          board — shows on the next visit, not live.) */}
      <BriefForm contract={contract} me={me} />
      <ExtrasEditor contract={contract} />
      <PhasesEditor contract={contract} />
      {can(me, 'money.read') ? <PlanEditor contract={contract} /> : null}
      <HandOver contract={contract} />
      <p className="t-caption desk-muted">{t('brief.form.savedSeparately')}</p>
    </div>
  );
}
