import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, formatCount } from '@/lib/format';
import { Accordion, SectionHead, day, refusalText } from '@/components/EditorKit';
import DayInput from '@/components/DayInput';
import CountStepper from '@/components/CountStepper';
import MoneyReadout from '@/components/MoneyReadout';
import PillChoice from '@/components/PillChoice';
import { normalizeAmount } from '@/lib/brief';
import HandoverPanel from '@/components/HandoverPanel';
import {
  PUBLISH_CONTRACT,
  SET_BRIEF,
  TEMPLATE_TYPES,
  type BriefInput,
  type BriefKind,
  type Contract,
  type DesignTier,
  type TemplateType,
  type User,
} from '@/lib/queries';

/**
 * The desk's step 1 (journeys build plan J4): the form sales fills in from the
 * request chat. It sits above the read-only cards the customer sees
 * (`RequirementsPanel`), so what sales types is what the customer will read,
 * field by field.
 *
 * Small forms, each saved on its own — the brief (with the dated commitments
 * it implies) and the hand-over. (**DX2a moved the extras to Pages and
 * features and the phases and payment plan to their own step**, desk UX review
 * 9–11: Requirements is facts about the job only.) Each is a
 * `contracts.author` write and refuses with `STEP_LOCKED`
 * once the agreement is approved, so the panel does not render this at all for
 * a locked step (a control that can only fail is worse than one that is not
 * there). **Every date is a `DayInput`** — one text field and a calendar
 * popover, speaking `YYYY-MM-DD` and never a `Date` (PD-19).
 *
 * **DX1 (desk UX review 3, 5, 6, 23, 25).** The sub-panels are accordions, and
 * the one that opens first is the first that still lacks something
 * (`briefCompleteness`, through `panelOf`). Support months are pills — 1 · 3 · 6
 * · 12 · Other, the last revealing the number field — and who provides each of
 * the domain, host and content is a pair of pills, each optional (a press on the
 * chosen one clears it). The stored values are today's: a number, and
 * `ROOT` / `CUSTOMER` / null. *Not needed* is **not** a pill yet: the brief
 * stores a side or nothing, and a third value needs the handover-item table that
 * is DX2's (review 7, 8). The allowance counts are steppers; money inputs show a
 * grouped readout.
 *
 * **Money** (`budgetCap`, the plan) is written by whoever holds
 * `money.read` and shown to nobody else — the API resolves both to null for
 * them, and the fields are not drawn.
 */

/** The support terms offered as pills (DX1, review 5); anything else is "Other". */
const SUPPORT_PILLS = ['1', '3', '6', '12'];

const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

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

  const [kind, setKind] = useState<BriefKind>(brief?.kind ?? 'NEW_SITE');
  const [existingSiteUrl, setExistingSiteUrl] = useState(brief?.existingSiteUrl ?? '');
  const [templateTypeId, setTemplateTypeId] = useState(brief?.templateType.id ?? '');
  const [designTier, setDesignTier] = useState<DesignTier>(brief?.designTier ?? 'THEME_PICK');
  const [budgetCap, setBudgetCap] = useState(brief?.budgetCap ?? '');
  const [idealDeadline, setIdealDeadline] = useState(day(brief?.idealDeadline));
  const [hardDeadline, setHardDeadline] = useState(day(brief?.hardDeadline));
  const [domainName, setDomainName] = useState(brief?.domainName ?? '');
  const [supportMonths, setSupportMonths] = useState(str(brief?.supportMonths));
  // "Other" is chosen when asked for, or when the stored number is not one of the pills.
  const [supportOther, setSupportOther] = useState(() => brief?.supportMonths != null && !SUPPORT_PILLS.includes(String(brief.supportMonths)));
  const [premadeRounds, setPremadeRounds] = useState(str(brief?.premadeRounds));
  const [wireframeIterations, setWireframeIterations] = useState(str(brief?.wireframeIterations ?? 2));
  const [mockupIterations, setMockupIterations] = useState(str(brief?.mockupIterations));
  const [demoIterations, setDemoIterations] = useState(str(brief?.demoIterationsPerPhase));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The "feature for an existing site" preset (DX3a, review 29) runs on the save that changes the kind to it; this is
  // the sentence that says so, until the next edit.
  const [presetNotice, setPresetNotice] = useState(false);
  const presetPending = kind === 'FEATURE_FOR_EXISTING' && brief?.kind !== 'FEATURE_FOR_EXISTING';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPresetNotice(false);
    const input: BriefInput = {
      kind,
      existingSiteUrl: kind === 'FEATURE_FOR_EXISTING' ? existingSiteUrl.trim() || null : null,
      templateTypeId,
      designTier,
      budgetCap: canMoney ? normalizeAmount(budgetCap) || null : null,
      idealDeadline: idealDeadline || null,
      hardDeadline: hardDeadline || null,
      domainName: domainName.trim() || null,
      supportMonths: numberOrNull(supportMonths),
      premadeRounds: numberOrNull(premadeRounds),
      wireframeIterations: numberOrNull(wireframeIterations),
      mockupIterations: numberOrNull(mockupIterations),
      demoIterationsPerPhase: numberOrNull(demoIterations),
    };
    try {
      await setBrief({ variables: { contractId: contract.id, input } });
      if (presetPending) {
        // The server set No design (the form still holds what was on screen); its rows follow through the cache.
        setDesignTier('NONE');
        setPresetNotice(true);
      }
      setSaved(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

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
          {presetPending ? (
            <p className="t-caption" data-testid="brief-preset-hint">
              {t('brief.form.presetHint')}
            </p>
          ) : null}
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
          {/* DX2a (desk UX review 4): chiefly a feature on an existing site — the contract's road has no design and no mockup. */}
          <option value="NONE">{t('brief.tier.NONE')}</option>
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
          <MoneyReadout value={budgetCap} testId="budget-readout" />
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
        <span className="label" id="brief-support-label">
          {t('brief.form.supportMonths')}
        </span>
        <PillChoice
          label={t('brief.form.supportMonths')}
          value={supportOther ? 'other' : SUPPORT_PILLS.includes(supportMonths) ? supportMonths : null}
          onChange={(v) => {
            if (v === 'other') {
              setSupportOther(true);
            } else if (v) {
              setSupportOther(false);
              setSupportMonths(v);
            }
          }}
          options={[
            ...SUPPORT_PILLS.map((m) => ({ value: m, label: t('brief.months', { count: Number(m), n: formatCount(Number(m), locale) }) })),
            { value: 'other', label: t('brief.form.supportOther') },
          ]}
          testId="brief-support-pills"
        />
        {supportOther ? (
          <input
            id="brief-support"
            className="input num-latin"
            dir="ltr"
            inputMode="numeric"
            aria-label={t('brief.form.supportMonths')}
            value={supportMonths}
            onChange={(e) => setSupportMonths(e.target.value)}
          />
        ) : null}
      </div>

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

      <p className="t-eyebrow">{t('brief.form.allowancesTitle')}</p>
      <div className="editor-grid-2">
        {designTier === 'NONE' ? null : designTier === 'THEME_PICK' ? (
          <div className="field">
            <span className="label">{t('brief.form.premadeRounds')}</span>
            <CountStepper label={t('brief.form.premadeRounds')} value={premadeRounds} onChange={setPremadeRounds} max={20} testId="brief-premade" />
          </div>
        ) : (
          <>
            <div className="field">
              <span className="label">{t('brief.form.wireframeIterations')}</span>
              <CountStepper label={t('brief.form.wireframeIterations')} value={wireframeIterations} onChange={setWireframeIterations} max={20} testId="brief-wireframes" />
            </div>
            <div className="field">
              <span className="label">{t('brief.form.mockupIterations')}</span>
              <CountStepper label={t('brief.form.mockupIterations')} value={mockupIterations} onChange={setMockupIterations} max={20} testId="brief-mockups" />
            </div>
          </>
        )}
        <div className="field">
          <span className="label">{t('brief.form.demoIterations')}</span>
          <CountStepper label={t('brief.form.demoIterations')} value={demoIterations} onChange={setDemoIterations} max={20} testId="brief-demos" />
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
      {presetNotice ? (
        <p className="t-small" role="status" data-testid="brief-preset-applied">
          {t('brief.form.presetApplied')}
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

type PanelId = 'brief' | 'handover' | 'handOver';

export default function RequirementsEditor({ contract, me }: { contract: Contract; me: User }) {
  const { t } = useTranslation();
  // DX2a: this list is the brief's alone now — the phases and the plan are the Phases and payment step's own.
  // DX3a: a handover item someone provides and nobody has dated belongs to the handover panel's count, not the brief's.
  const lacks = contract.briefCompleteness ?? [];
  const handoverLacks = lacks.filter((m) => m.code === 'COMMITMENT_UNDATED').length;
  const briefLacks = lacks.length - handoverLacks;

  // Opened once, on arrival, and never refolded under the person typing in it. The brief is the only panel that can lack
  // something; the hand-over is the other, and a finished step's edits are in the brief.
  const [open, setOpen] = useState<ReadonlySet<PanelId>>(() => new Set<PanelId>([briefLacks === 0 && handoverLacks > 0 ? 'handover' : 'brief']));
  const toggle = (id: PanelId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const acc = (id: PanelId, title: string, missing: number | null, children: ReactNode) => (
    <Accordion id={id} title={title} open={open.has(id)} onToggle={() => toggle(id)} missing={missing}>
      {children}
    </Accordion>
  );

  return (
    <div className="req-editor" data-testid="requirements-editor">
      {/* No `key` on the forms: after a save the form already holds what the server
          now holds, and remounting would drop the "saved" line the person is
          reading. (A change made elsewhere — a due date edited on the dependency
          board — shows on the next visit, not live.) */}
      {acc('brief', t('brief.form.title'), briefLacks, <BriefForm contract={contract} me={me} />)}
      {acc('handover', t('brief.handover.title'), handoverLacks, <HandoverPanel contract={contract} />)}
      {contract.publishedAt ? null : acc('handOver', t('brief.handOver.title'), null, <HandOver contract={contract} />)}
      <p className="t-caption desk-muted">{t('brief.form.savedSeparately')}</p>
    </div>
  );
}
