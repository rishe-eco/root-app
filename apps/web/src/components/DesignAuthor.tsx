import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorDesign } from '@/lib/access';
import { formatAmount, formatCount, pick } from '@/lib/format';
import { isExhausted, roundCounter, themesFor } from '@/lib/design';
import {
  ADD_PAGE_DESIGN,
  ADD_PALETTE_ITEM,
  DELETE_PAGE_DESIGN,
  DELETE_PALETTE_ITEM,
  DISCARD_DESIGN_DRAFT,
  EXTEND_ALLOWANCE,
  PROPOSE_THEMES,
  PUBLISH_DESIGN_REVISION,
  SET_PAGE_IMAGE,
  SET_PALETTE_ITEM_IMAGE,
  START_DESIGN_DRAFT,
  THEMES,
  UPDATE_PALETTE_ITEM,
  type Contract,
  type DesignConcept,
  type DesignPaletteItem,
  type PaletteKind,
  type Theme,
  type User,
  type WizardStep,
} from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';
import ImageUploader from '@/components/ImageUploader';
import { PaletteItemView } from '@/components/PaletteView';
import { isInScope, ownItems } from '@/lib/scopeStep';

/**
 * The designer's half of step 4 (journeys build plan J8), and sales' "extend the
 * allowance". Rendered inside the design panel for staff; every control is
 * decided by capability and assignment (`canAuthorDesign`) and is *also* refused
 * by the API — a button that can only fail is worse than no button, but the API
 * is the wall.
 *
 * - **Pre-made:** tick themes from the catalogue **filtered as `proposeThemes`
 *   filters it** (active, offered for the brief's template type — `themesFor`),
 *   save them as the draft round, publish. Each theme is snapshotted and its
 *   preview copied into the contract when it is saved; the demo link is a link
 *   that opens in a new tab and is never framed.
 * - **Custom:** start a round (which gives the draft its one "wireframes"
 *   concept), add a page from the contract's own scope with its wireframe image,
 *   edit the palette, publish.
 * - **Sales:** read-only on the design, with **Extend the allowance** — the only
 *   way past `ALLOWANCE_EXHAUSTED` (Q-S5), optionally charged as a draft invoice.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

export function designError(t: T, err: unknown): string {
  const code = errorCode(err);
  return code && t(`design.error.${code}`, { defaultValue: '' }) ? t(`design.error.${code}`) : (err as Error).message;
}

/** Runs one act, keeping its busy flag and its worded refusal in one place. */
function useAct() {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(designError(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { act, busy, error };
}

// --- the round's publish / discard / start -----------------------------------------

function RoundControls({ contract, step }: { contract: Contract; step: WizardStep }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { act, busy, error } = useAct();
  const [publish] = useMutation(PUBLISH_DESIGN_REVISION);
  const [discard] = useMutation(DISCARD_DESIGN_DRAFT);
  const draft = contract.designDraft;
  const counter = roundCounter(step);
  if (!draft) return null;
  return (
    <div className="design-round-controls" data-testid="design-round-controls">
      <p className="t-caption">
        {counter.total === null
          ? t('design.draft.publishHelpOpen')
          : t('design.draft.publishHelp', { used: formatCount(counter.used, locale), total: formatCount(counter.total, locale) })}
      </p>
      <div className="workspace-row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={busy}
          data-testid="publish-round"
          onClick={() => act(() => publish({ variables: { contractId: contract.id } }))}
        >
          {t('design.draft.publish')}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={busy}
          data-testid="discard-draft"
          onClick={() => act(() => discard({ variables: { contractId: contract.id } }))}
        >
          {t('design.draft.discard')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="design-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- pre-made ----------------------------------------------------------------------

function PremadeAuthor({ contract, step }: { contract: Contract; step: WizardStep }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data } = useQuery<{ themes: Theme[] }>(THEMES);
  const [propose] = useMutation(PROPOSE_THEMES);
  const { act, busy, error } = useAct();

  const brief = contract.brief;
  const offered = themesFor(data?.themes ?? [], brief?.templateType.id);
  const inDraft = (contract.designDraft?.concepts ?? []).map((c) => c.themeId).filter((id): id is string => !!id);
  // Re-seeded when the draft's themes change under it (a save, a discard).
  const [picked, setPicked] = useState<string[]>(inDraft);
  const [seenDraft, setSeenDraft] = useState(inDraft.join(','));
  if (seenDraft !== inDraft.join(',')) {
    setSeenDraft(inDraft.join(','));
    setPicked(inDraft);
  }

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="design-author" data-testid="design-author-premade">
      <h4 className="design-subtitle">{t('design.propose.title')}</h4>
      {offered.length === 0 ? (
        <p className="t-small desk-muted" data-testid="no-themes">
          {t('design.propose.none')}
        </p>
      ) : (
        <>
          <p className="t-small desk-muted">{t('design.propose.help', { type: brief ? pick(brief.templateType, 'label', locale) : '' })}</p>
          <ul className="design-theme-pick">
            {offered.map((theme) => (
              <li key={theme.id}>
                <label className="design-theme-option" data-testid="theme-option" data-theme={theme.name}>
                  <input type="checkbox" checked={picked.includes(theme.id)} onChange={() => toggle(theme.id)} />
                  <span className="thumb">
                    {theme.previewUrl ? <img src={theme.previewUrl} alt="" /> : <span className="t-caption">{t('design.propose.noPreview')}</span>}
                  </span>
                  <span className="design-theme-text">
                    <span className="design-theme-name">{theme.name}</span>
                    {theme.vendor ? <span className="t-caption">{t('design.gallery.vendor', { vendor: theme.vendor })}</span> : null}
                    {theme.demoUrl ? (
                      <a className="t-caption" href={theme.demoUrl} target="_blank" rel="noopener noreferrer">
                        {t('design.propose.demo')}
                      </a>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="workspace-row">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={busy || picked.length === 0}
              data-testid="save-themes"
              onClick={() => act(() => propose({ variables: { contractId: contract.id, themeIds: picked } }))}
            >
              {t('design.propose.action')}
            </button>
          </div>
        </>
      )}
      {error ? (
        <p className="error" role="alert" data-testid="design-error">
          {error}
        </p>
      ) : null}
      <RoundControls contract={contract} step={step} />
    </div>
  );
}

// --- custom ------------------------------------------------------------------------

function PaletteRow({ contractId, item }: { contractId: string; item: DesignPaletteItem }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(item.value);
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [update] = useMutation(UPDATE_PALETTE_ITEM);
  const [remove] = useMutation(DELETE_PALETTE_ITEM);
  const [setImage] = useMutation(SET_PALETTE_ITEM_IMAGE);
  const { act, busy, error } = useAct();

  return (
    <li className="design-palette-row card" data-testid="palette-row" data-role={item.role}>
      <div className="design-palette-head">
        <span className="badge">{t(`design.paletteEdit.kind.${item.kind}`)}</span>
        <span className="num-latin" dir="ltr">
          {item.role}
        </span>
      </div>
      <PaletteItemView item={item} />
      <form
        className="design-palette-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act(() => update({ variables: { itemId: item.id, value, labelFa, labelEn } }));
        }}
      >
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('design.paletteEdit.value')} dir="ltr" data-testid="palette-value" />
        <input className="input" value={labelFa} onChange={(e) => setLabelFa(e.target.value)} aria-label={t('design.paletteEdit.labelFa')} />
        <input className="input" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} aria-label={t('design.paletteEdit.labelEn')} dir="ltr" />
        <div className="workspace-row">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={busy}>
            {t('design.paletteEdit.save')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={busy}
            onClick={() => act(() => remove({ variables: { itemId: item.id } }))}
          >
            {t('design.paletteEdit.delete')}
          </button>
        </div>
      </form>
      {item.kind !== 'COLOR' ? (
        <ImageUploader
          contractId={contractId}
          currentUrl={item.imageUrl}
          onAttach={async (fileId) => {
            await setImage({ variables: { itemId: item.id, fileId } });
          }}
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </li>
  );
}

const PLACEHOLDER: Record<PaletteKind, string> = { COLOR: '#1f3a5c', FONT: 'Vazirmatn', LOGO_USAGE: '' };

function AddPaletteItem({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<PaletteKind>('COLOR');
  const [role, setRole] = useState('');
  const [value, setValue] = useState('');
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [add] = useMutation(ADD_PALETTE_ITEM);
  const { act, busy, error } = useAct();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const done = await act(() => add({ variables: { contractId, kind, role: role.trim(), value: value.trim(), labelFa, labelEn } }));
    if (done) {
      setRole('');
      setValue('');
      setLabelFa('');
      setLabelEn('');
    }
  }

  return (
    <form className="design-palette-add card" onSubmit={submit} data-testid="palette-add">
      <div className="field">
        <label className="label" htmlFor="palette-kind">
          {t('design.paletteEdit.title')}
        </label>
        <select id="palette-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as PaletteKind)} data-testid="palette-kind">
          {(['COLOR', 'FONT', 'LOGO_USAGE'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`design.paletteEdit.kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="palette-role">
          {t('design.paletteEdit.role')}
        </label>
        <input id="palette-role" className="input" value={role} onChange={(e) => setRole(e.target.value)} dir="ltr" data-testid="palette-role" />
        <p className="t-caption">{t('design.paletteEdit.roleHelp')}</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="palette-new-value">
          {t('design.paletteEdit.value')}
        </label>
        <input
          id="palette-new-value"
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={PLACEHOLDER[kind]}
          dir="ltr"
          data-testid="palette-new-value"
        />
        <p className="t-caption">{t(`design.paletteEdit.valueHelp.${kind}`)}</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="palette-label-fa">
          {t('design.paletteEdit.labelFa')}
        </label>
        <input id="palette-label-fa" className="input" value={labelFa} onChange={(e) => setLabelFa(e.target.value)} data-testid="palette-label-fa" />
      </div>
      <div className="field">
        <label className="label" htmlFor="palette-label-en">
          {t('design.paletteEdit.labelEn')}
        </label>
        <input id="palette-label-en" className="input" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} dir="ltr" data-testid="palette-label-en" />
      </div>
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy} data-testid="palette-add-submit">
          {t('design.paletteEdit.add')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="design-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function WireframeRow({ contractId, page }: { contractId: string; page: DesignConcept['pages'][number] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [setImage] = useMutation(SET_PAGE_IMAGE);
  const [remove] = useMutation(DELETE_PAGE_DESIGN);
  const { act, busy, error } = useAct();
  return (
    <li className="design-page-row card" data-testid="wireframe-row" data-key={page.key}>
      <div className="design-palette-head">
        <span className="design-theme-name">{pick(page, 'label', locale)}</span>
        <span className="num-latin t-caption" dir="ltr">
          {page.key}
        </span>
      </div>
      <ImageUploader
        contractId={contractId}
        currentUrl={page.imageUrl}
        onAttach={async (fileId) => {
          await setImage({ variables: { pageId: page.id, fileId } });
        }}
      />
      <div className="workspace-row">
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => act(() => remove({ variables: { pageId: page.id } }))}>
          {t('design.custom.remove')}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </li>
  );
}

function CustomAuthor({ contract, step }: { contract: Contract; step: WizardStep }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [start] = useMutation(START_DESIGN_DRAFT);
  const [addPage] = useMutation(ADD_PAGE_DESIGN);
  const { act, busy, error } = useAct();
  const [pageKey, setPageKey] = useState('');

  const draft = contract.designDraft;
  if (!draft) {
    return (
      <div className="design-author" data-testid="design-author-custom">
        <p className="t-small desk-muted">{t('design.draft.none')}</p>
        <div className="workspace-row">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy}
            data-testid="start-round"
            onClick={() => act(() => start({ variables: { contractId: contract.id } }))}
          >
            {t('design.draft.start')}
          </button>
        </div>
        {error ? (
          <p className="error" role="alert" data-testid="design-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const wireframes = draft.concepts.find((c) => c.key === 'wireframes') ?? draft.concepts[0];
  const usedKeys = new Set((wireframes?.pages ?? []).map((p) => p.key));
  // The pages this contract agreed and that have no wireframe yet — the very
  // rule `addPageDesign` applies (a PAGE of this contract's own scope).
  const available = ownItems(contract).filter((s) => s.kind === 'PAGE' && isInScope(s) && !usedKeys.has(s.key));

  return (
    <div className="design-author" data-testid="design-author-custom">
      <h4 className="design-subtitle">{t('design.custom.pagesTitle')}</h4>
      {wireframes && wireframes.pages.length > 0 ? (
        <ul className="design-page-list">
          {wireframes.pages.map((page) => (
            <WireframeRow key={page.id} contractId={contract.id} page={page} />
          ))}
        </ul>
      ) : (
        <p className="t-small desk-muted">{t('design.custom.noPages')}</p>
      )}
      {wireframes ? (
        available.length > 0 ? (
          <form
            className="workspace-row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const item = available.find((s) => s.key === pageKey);
              if (!item) return;
              void act(() =>
                addPage({ variables: { conceptId: wireframes.id, key: item.key, labelFa: item.labelFa, labelEn: item.labelEn } }),
              ).then((done) => done && setPageKey(''));
            }}
          >
            <select className="input" value={pageKey} onChange={(e) => setPageKey(e.target.value)} aria-label={t('design.custom.pageSelect')} data-testid="page-select">
              <option value="">{t('design.custom.pageSelect')}</option>
              {available.map((s) => (
                <option key={s.key} value={s.key}>
                  {pick(s, 'label', locale)}
                </option>
              ))}
            </select>
            <button className="btn btn-secondary btn-sm" type="submit" disabled={busy || !pageKey} data-testid="add-page">
              {t('design.custom.addPage')}
            </button>
          </form>
        ) : (
          <p className="t-caption">{t('design.custom.noPagesLeft')}</p>
        )
      ) : null}

      <h4 className="design-subtitle">{t('design.paletteEdit.title')}</h4>
      {draft.palette.length > 0 ? (
        <ul className="design-palette-list">
          {draft.palette.map((item) => (
            <PaletteRow key={item.id} contractId={contract.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="t-small desk-muted">{t('design.palette.empty')}</p>
      )}
      <AddPaletteItem contractId={contract.id} />

      {error ? (
        <p className="error" role="alert" data-testid="design-error">
          {error}
        </p>
      ) : null}
      <RoundControls contract={contract} step={step} />
    </div>
  );
}

// --- sales: extend the allowance -----------------------------------------------------

/**
 * Which step's rounds this box counts and extends — the design's (J8) or the
 * mockup's (J9b). The wording is the same ("rounds"), the step is the argument.
 */
export function AllowanceBox({
  contract,
  step,
  me,
  kind = 'DESIGN',
}: {
  contract: Contract;
  step: WizardStep;
  me: User;
  kind?: 'DESIGN' | 'MOCKUP';
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const counter = roundCounter(step);
  const canExtend = can(me, 'contracts.author') && counter.total !== null;
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState('1');
  const [reason, setReason] = useState('');
  const [charge, setCharge] = useState('');
  const [extend] = useMutation(EXTEND_ALLOWANCE);
  const { act, busy, error } = useAct();
  const extensions = (contract.allowanceExtensions ?? []).filter((x) => x.step === kind);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const done = await act(() =>
      extend({
        variables: {
          contractId: contract.id,
          step: kind,
          extra: Number(extra),
          reason,
          charge: can(me, 'billing.manage') && charge.trim() ? charge.trim() : null,
        },
      }),
    );
    if (done) {
      setOpen(false);
      setReason('');
      setCharge('');
      setExtra('1');
    }
  }

  return (
    <div className="design-allowance" data-testid="design-allowance">
      <p className="t-small">
        {counter.total === null
          ? t('design.allowance.usedOpen', { used: formatCount(counter.used, locale) })
          : t('design.allowance.used', { used: formatCount(counter.used, locale), total: formatCount(counter.total, locale) })}
      </p>
      {isExhausted(counter) ? (
        <p className="t-caption req-notice" data-testid="allowance-exhausted">
          {t('design.allowance.exhausted')}
        </p>
      ) : null}
      {extensions.length > 0 ? (
        <ul className="design-extension-list" data-testid="extension-list">
          {extensions.map((x) => (
            <li key={x.id} className="t-caption">
              {x.charge
                ? t('design.allowance.extend.lineCharged', {
                    n: formatCount(x.extra, locale),
                    reason: x.reason,
                    who: x.approvedBy.name,
                    amount: formatAmount(x.charge, locale) ?? '',
                  })
                : t('design.allowance.extend.line', { n: formatCount(x.extra, locale), reason: x.reason, who: x.approvedBy.name })}
            </li>
          ))}
        </ul>
      ) : null}
      {canExtend && !open ? (
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setOpen(true)} data-testid="extend-open">
          {t('design.allowance.extend.action')}
        </button>
      ) : null}
      {canExtend && open ? (
        <form className="card editor-card auth-form" onSubmit={submit} data-testid="extend-form">
          <div className="field">
            <label className="label" htmlFor="extend-extra">
              {t('design.allowance.extend.extra')}
            </label>
            <input id="extend-extra" className="input" type="number" min={1} value={extra} onChange={(e) => setExtra(e.target.value)} data-testid="extend-extra" />
          </div>
          <div className="field">
            <label className="label" htmlFor="extend-reason">
              {t('design.allowance.extend.reason')}
            </label>
            <input id="extend-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="extend-reason" />
          </div>
          {can(me, 'billing.manage') ? (
            <div className="field">
              <label className="label" htmlFor="extend-charge">
                {t('design.allowance.extend.charge')}
              </label>
              <input id="extend-charge" className="input" inputMode="numeric" value={charge} onChange={(e) => setCharge(e.target.value)} dir="ltr" data-testid="extend-charge" />
              <p className="t-caption">{t('design.allowance.extend.chargeHelp')}</p>
            </div>
          ) : null}
          <div className="workspace-row">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy} data-testid="extend-submit">
              {t('design.allowance.extend.submit')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
              {t('feedback.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="error" role="alert" data-testid="design-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- the designer's whole half -------------------------------------------------------

export default function DesignAuthor({
  contract,
  step,
  me,
  path,
}: {
  contract: Contract;
  step: WizardStep;
  me: User;
  path: 'PREMADE' | 'CUSTOM';
}) {
  if (step.locked || !canAuthorDesign(me, contract)) return null;
  return path === 'PREMADE' ? <PremadeAuthor contract={contract} step={step} /> : <CustomAuthor contract={contract} step={step} />;
}
