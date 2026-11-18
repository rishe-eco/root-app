import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import TitleField from '@/components/TitleField';
import { hasOneTitle } from '@/lib/titleScript';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
import { isIncludedExtra } from '@/lib/brief';
import {
  PROPOSABLE_KINDS,
  groupByKind,
  isInScope,
  isLeftOut,
  newestFirst,
  openTrades,
  ownItems,
  tradeState,
  undecidedProposals,
  waitingProposalFor,
  type ProposableKind,
} from '@/lib/scopeStep';
import {
  ADD_SCOPE_ITEM,
  APPLY_SCOPE_TEMPLATE,
  CONFIRM_SCOPE_TRADE_CUSTOMER,
  CONFIRM_SCOPE_TRADE_ROOT,
  CONTRACT_FEEDBACK,
  DECIDE_SCOPE_PROPOSAL,
  PROPOSE_RESTORE,
  PROPOSE_SCOPE_ADDITION,
  PROPOSE_SCOPE_REMOVAL,
  SET_EXTRA,
  DELETE_SCOPE_ITEM,
  SET_SCOPE_ITEM_STATUS,
  type Contract,
  type FeedbackItem,
  type ScopeItem,
  type ScopeProposal,
  type ScopeTrade,
} from '@/lib/queries';
import FeedbackPanel, { errorCode, type FeedbackTarget } from '@/components/FeedbackPanel';
import { Accordion, refusalText as briefRefusalText } from '@/components/EditorKit';
import InlineAdd from '@/components/InlineAdd';
import { DetailsToggle, ItemChips, ItemDrawer, toggleId, useDeleteItem } from '@/components/ScopeItemDetails';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 2a — pages, features and deliverables (journeys build plan J5), one
 * panel for both sides.
 *
 * **The customer sees the list Root has agreed to build, grouped, and can ask
 * for a change three ways** — add something, remove an agreed item, bring a
 * declined one back — each a *proposal* in their own words that Root answers
 * (`scopeProposals`, the API's model; nothing here decides anything). Every item
 * is also a target of the generic `FeedbackPanel` (S2), anchored by its
 * `scopeItemId`, so "I have a question about this page" is a note with a fate
 * like every other step's. The scope trade — Root's paired swap, the way a scope
 * changes after the agreement — shows here with the customer's confirm button.
 *
 * **Staff see the same list and the queue that empties it**: each undecided
 * proposal with its confirm/decline controls (an ADD is confirmed with both
 * labels — the customer wrote one language, the registry needs two), the
 * "apply the site type's list" button until that list has been applied, and
 * the history of what was decided. **SC1:** sales can also add an item
 * straight to this contract — agreed, with both labels, the site type's own
 * list untouched — and take one out: deleted while nothing refers to it (in
 * practice, before the handover), declined with a reason the customer reads
 * once it is theirs to see.
 *
 * **DX2a (desk UX review 9) made this the one home of the build list.** The
 * *Extras* (SEO, analytics, the checklist's areas) are a group here, moved out of
 * Requirements. **DX6 (the founder's walk) finished the move.** For staff the list
 * is an accordion, "Pages and features", and the block of every item's controls
 * under it (`ScopeRegistry`, the old Scope tab) is gone: each row reads at a
 * glance — the title and chips for its status, its phases and any flag — and a
 * **Details** button opens a drawer under that row alone (`ScopeItemDetails`),
 * one at a time, with the status and decision, phases, flags, trade, and
 * name / order / delete. An unticked extra is only its checkbox row; the
 * customer sees the status and phase chips and never the drawer. Each extra is
 * one checkbox whose words are its label, and "Add extra" makes a one-off for
 * this contract (Templates → Extras is the desk's default list).
 *
 * A locked step (`step.locked`) draws no form: a control that can only fail is
 * worse than one that is not there, and the API refuses with `STEP_LOCKED`
 * regardless. The customer's trade confirmation is the exception, drawn always.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A refusal's sentence: the code's own line when the locale has one, the message otherwise. */
function refusalText(t: T, err: unknown): string {
  const code = errorCode(err);
  return code && t(`scope.error.${code}`, { defaultValue: '' }) ? t(`scope.error.${code}`) : (err as Error).message;
}

// ---------------------------------------------------------------------------
// One item's own controls: remove, bring back, or "waiting for Root"
// ---------------------------------------------------------------------------

function ItemActions({ item, waiting, canPropose }: { item: ScopeItem; waiting: ScopeProposal | null; canPropose: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remove, { loading: removing }] = useMutation(PROPOSE_SCOPE_REMOVAL);
  const [restore, { loading: restoring }] = useMutation(PROPOSE_RESTORE);

  if (waiting) {
    return (
      <span className="badge scope-waiting" data-testid="scope-item-waiting">
        {t('scope.waiting')}
      </span>
    );
  }
  const verb = item.status === 'AGREED' ? 'remove' : item.status === 'DECLINED' ? 'restore' : null;
  if (!canPropose || verb === null) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!text.trim()) return;
    try {
      await (verb === 'remove' ? remove : restore)({ variables: { scopeItemId: item.id, text: text.trim() } });
      setOpen(false);
      setText('');
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} data-testid={`scope-${verb}`}>
        {t(`scope.${verb}.action`)}
      </button>
    );
  }
  return (
    <form className="scope-propose-form" onSubmit={submit} data-testid={`scope-${verb}-form`}>
      <textarea
        className="input"
        rows={2}
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t(`scope.${verb}.placeholder`)}
        aria-label={t(`scope.${verb}.placeholder`)}
      />
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={removing || restoring || !text.trim()}>
          {t(`scope.${verb}.submit`)}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Root's own controls on one item (SC1): take it out
// ---------------------------------------------------------------------------

/**
 * Before the handover the customer has never seen the list, so a mistaken item
 * is simply deleted. After it, the customer may have read or noted on it, so
 * taking it out is a decline with a reason — it stays on their list under
 * "left out", and they can ask for it back. The API refuses a delete of an
 * item anything refers to (`ITEM_IN_USE`), whichever the screen offered.
 */
function StaffItemActions({ item, contract }: { item: ScopeItem; contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [del, { loading: deleting }] = useMutation(DELETE_SCOPE_ITEM);
  const [setStatus, { loading: declining }] = useMutation(SET_SCOPE_ITEM_STATUS);
  if (item.status !== 'AGREED') return null;
  const handedOver = !!contract.publishedAt;

  async function onDelete() {
    if (!window.confirm(t('scope.staffRemove.confirmDelete', { label: pick(item, 'label', locale) }))) return;
    setError(null);
    try {
      await del({ variables: { scopeItemId: item.id, contractId: contract.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  async function onDecline(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    setError(null);
    try {
      await setStatus({ variables: { scopeItemId: item.id, status: 'DECLINED', reason: reason.trim(), contractId: contract.id } });
      setOpen(false);
      setReason('');
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  if (!handedOver) {
    return (
      <>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} disabled={deleting} data-testid="scope-staff-delete">
          {t('scope.staffRemove.action')}
        </button>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </>
    );
  }
  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} data-testid="scope-staff-decline">
        {t('scope.staffRemove.decline')}
      </button>
    );
  }
  return (
    <form className="scope-propose-form" onSubmit={onDecline} data-testid="scope-staff-decline-form">
      <textarea
        className="input"
        rows={2}
        dir="auto"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t('scope.decide.reason')}
        aria-label={t('scope.decide.reason')}
      />
      <p className="t-caption">{t('scope.decide.reasonHelp')}</p>
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={declining || !reason.trim()}>
          {t('scope.staffRemove.declineSend')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Root adds an item straight to this contract (SC1)
// ---------------------------------------------------------------------------

function AddItemForm({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ProposableKind>('PAGE');
  const [key, setKey] = useState('');
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [add, { loading }] = useMutation(ADD_SCOPE_ITEM);
  const reset = () => {
    setKey('');
    setLabelFa('');
    setLabelEn('');
  };

  // DX6: the desk's one way to add (`InlineAdd`): a button, then a small form with Add and Cancel; Enter submits, Escape cancels.
  return (
    <InlineAdd
      label={t('scope.add.title')}
      testId="scope-add"
      ready={hasOneTitle(labelFa, labelEn)}
      busy={loading}
      onCancel={reset}
      errorText={(err) => refusalText(t, err)}
      onSubmit={async () => {
        // The key is optional (the old Scope tab's "add" asked for one): without it the API names the item `custom.<n>`.
        await add({ variables: { contractId: contract.id, key: key.trim() || null, labelFa: labelFa.trim(), labelEn: labelEn.trim(), kind } });
        reset();
      }}
    >
      <p className="sec-help">{t('scope.add.help')}</p>
      <div className="field">
        <label className="label" htmlFor="scope-add-kind">
          {t('scope.decide.kind')}
        </label>
        <select id="scope-add-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as ProposableKind)}>
          {PROPOSABLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`scope.kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="scope-add-key">
          {t('scope.decide.key')}
        </label>
        <input id="scope-add-key" className="input num-latin" dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <TitleField idBase="scope-add" testId="scope-add-label" label={t('scope.decide.label')} fa={labelFa} en={labelEn} onChange={(v) => { setLabelFa(v.fa); setLabelEn(v.en); }} />
    </InlineAdd>
  );
}

/** DX6: "Add extra" in the extras group — a one-off extra for this contract only (the desk's default list is Templates > Extras). */
function AddExtraForm({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [add, { loading }] = useMutation(ADD_SCOPE_ITEM);
  const reset = () => {
    setLabelFa('');
    setLabelEn('');
  };
  return (
    <InlineAdd
      label={t('scope.extras.add')}
      testId="extra-add"
      ready={hasOneTitle(labelFa, labelEn)}
      busy={loading}
      onCancel={reset}
      errorText={(err) => refusalText(t, err)}
      onSubmit={async () => {
        await add({ variables: { contractId: contract.id, key: null, labelFa: labelFa.trim(), labelEn: labelEn.trim(), kind: 'EXTRA' } });
        reset();
      }}
    >
      <p className="sec-help">{t('scope.extras.addHelp')}</p>
      <TitleField idBase="extra-add" testId="extra-add-label" label={t('scope.decide.label')} fa={labelFa} en={labelEn} onChange={(v) => { setLabelFa(v.fa); setLabelEn(v.en); }} />
    </InlineAdd>
  );
}

// ---------------------------------------------------------------------------
// The customer asks for something new
// ---------------------------------------------------------------------------

function AskForm({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [kind, setKind] = useState<ProposableKind>('PAGE');
  const [text, setText] = useState('');
  const [lang, setLang] = useState<'fa' | 'en'>(locale);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [propose, { loading }] = useMutation(PROPOSE_SCOPE_ADDITION);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(false);
    if (!text.trim()) return;
    try {
      await propose({ variables: { contractId: contract.id, kind, text: text.trim(), lang } });
      setText('');
      setSent(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <form className="card editor-card scope-ask" onSubmit={submit} data-testid="scope-ask">
      <h4 className="t-h4">{t('scope.ask.title')}</h4>
      <p className="sec-help">{t('scope.ask.help')}</p>
      <div className="field">
        <label className="label" htmlFor="scope-ask-kind">
          {t('scope.ask.kind')}
        </label>
        <select id="scope-ask-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as ProposableKind)}>
          {PROPOSABLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`scope.kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="scope-ask-text">
          {t('scope.ask.text')}
        </label>
        <textarea
          id="scope-ask-text"
          className="input"
          rows={3}
          dir="auto"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('scope.ask.placeholder')}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="scope-ask-lang">
          {t('scope.ask.lang')}
        </label>
        <select id="scope-ask-lang" className="input" value={lang} onChange={(e) => setLang(e.target.value as 'fa' | 'en')}>
          <option value="fa">{t('scope.lang.fa')}</option>
          <option value="en">{t('scope.lang.en')}</option>
        </select>
      </div>
      {error ? <p className="error" role="alert" data-testid="scope-ask-error">{error}</p> : null}
      {sent ? <p className="t-small" role="status" data-testid="scope-ask-sent">{t('scope.ask.sent')}</p> : null}
      <div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !text.trim()} data-testid="scope-ask-submit">
          {t('scope.ask.submit')}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// A proposal, as a row: what was asked, and its fate
// ---------------------------------------------------------------------------

function ProposalRow({ proposal, children }: { proposal: ScopeProposal; children?: ReactNode }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const target =
    proposal.kind === 'ADD'
      ? t(`scope.kind.${proposal.requestedKind ?? 'FEATURE'}`)
      : proposal.scopeItem
        ? pick(proposal.scopeItem, 'label', locale)
        : '';
  return (
    <li className="scope-request" data-testid="scope-request" data-kind={proposal.kind} data-decision={proposal.decision ?? 'PENDING'}>
      <div className="scope-request-head">
        <span className="badge">{t(`scope.request.kind.${proposal.kind}`)}</span>
        <span className="scope-request-target">{target}</span>
      </div>
      <p className="scope-request-text" dir="auto">
        {proposal.text}
      </p>
      {proposal.decision === null ? (
        <p className="t-caption" data-testid="scope-request-state">{t('scope.waiting')}</p>
      ) : proposal.decision === 'ACCEPTED' ? (
        <p className="t-caption" data-testid="scope-request-state">
          {proposal.kind === 'ADD' && proposal.createdItem
            ? t('scope.request.acceptedAdd', { label: pick(proposal.createdItem, 'label', locale) })
            : t(`scope.request.accepted.${proposal.kind}`)}
        </p>
      ) : (
        <p className="t-caption" data-testid="scope-request-state">
          {t('scope.request.declined', { reason: proposal.declineReason ?? '' })}
        </p>
      )}
      {children}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The desk decides
// ---------------------------------------------------------------------------

function DecideForm({ proposal }: { proposal: ScopeProposal }) {
  const { t } = useTranslation();
  const isAdd = proposal.kind === 'ADD';
  // The customer wrote one language; that label starts as their words and sales writes the other.
  const [labelFa, setLabelFa] = useState(proposal.lang === 'fa' ? proposal.text : '');
  const [labelEn, setLabelEn] = useState(proposal.lang === 'en' ? proposal.text : '');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<ProposableKind>((proposal.requestedKind as ProposableKind | null) ?? 'FEATURE');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [decide, { loading }] = useMutation(DECIDE_SCOPE_PROPOSAL);

  async function send(decision: 'ACCEPTED' | 'DECLINED') {
    setError(null);
    try {
      await decide({
        variables: {
          id: proposal.id,
          decision,
          labelFa: isAdd && decision === 'ACCEPTED' ? labelFa.trim() : null,
          labelEn: isAdd && decision === 'ACCEPTED' ? labelEn.trim() : null,
          key: isAdd && decision === 'ACCEPTED' && key.trim() ? key.trim() : null,
          kind: isAdd && decision === 'ACCEPTED' ? kind : null,
          declineReason: decision === 'DECLINED' ? reason.trim() : null,
        },
      });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="scope-decide" data-testid="scope-decide">
      {isAdd ? (
        <div className="scope-decide-fields">
          <p className="t-caption">{t('scope.decide.langHint', { lang: t(`scope.lang.${proposal.lang}`) })}</p>
          <TitleField
            idBase={`scope-decide-${proposal.id}`}
            testId="scope-label"
            label={t('scope.decide.label')}
            fa={labelFa}
            en={labelEn}
            onChange={(v) => {
              setLabelFa(v.fa);
              setLabelEn(v.en);
            }}
          />
          <div className="field">
            <label className="label">{t('scope.decide.kind')}</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ProposableKind)}>
              {PROPOSABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`scope.kind.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">{t('scope.decide.key')}</label>
            <input className="input num-latin" dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} placeholder="custom.1" data-testid="scope-key" />
            <span className="t-caption">{t('scope.decide.keyHelp')}</span>
          </div>
        </div>
      ) : null}
      {declining ? (
        <div className="field">
          <label className="label">{t('scope.decide.reason')}</label>
          <textarea className="input" rows={2} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="scope-decline-reason" />
          <span className="t-caption">{t('scope.decide.reasonHelp')}</span>
        </div>
      ) : null}
      <div className="workspace-row">
        {declining ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={loading || !reason.trim()}
              onClick={() => send('DECLINED')}
              data-testid="scope-decline-send"
            >
              {t('scope.decide.declineSend')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(false)}>
              {t('feedback.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={loading || (isAdd && !hasOneTitle(labelFa, labelEn))}
              onClick={() => send('ACCEPTED')}
              data-testid="scope-confirm"
            >
              {t('scope.decide.confirm')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDeclining(true)} data-testid="scope-decline">
              {t('scope.decide.decline')}
            </button>
          </>
        )}
      </div>
      {error ? <p className="error" role="alert" data-testid="scope-decide-error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seeding the scope from the site type
// ---------------------------------------------------------------------------

function SeedCard({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [apply, { loading }] = useMutation(APPLY_SCOPE_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const type = contract.brief?.templateType ?? null;

  async function onClick() {
    setError(null);
    try {
      await apply({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="scope-seed">
      <h4 className="t-h4">{t('scope.seed.title')}</h4>
      <p className="sec-help">{type ? t('scope.seed.help', { type: pick(type, 'label', locale) }) : t('scope.seed.noBrief')}</p>
      <div>
        <button className="btn btn-primary btn-sm" type="button" disabled={loading || !type} onClick={onClick} data-testid="scope-seed-button">
          {t('scope.seed.action')}
        </button>
      </div>
      {error ? <p className="error" role="alert" data-testid="scope-seed-error">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A scope trade waiting
// ---------------------------------------------------------------------------

function TradeRow({ trade, contractId, customer, rootCanConfirm = false }: { trade: ScopeTrade; contractId: string; customer: boolean; rootCanConfirm?: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [confirm, { loading }] = useMutation(CONFIRM_SCOPE_TRADE_CUSTOMER);
  const [error, setError] = useState<string | null>(null);
  const state = tradeState(trade);

  async function onClick() {
    setError(null);
    try {
      await confirm({ variables: { tradeId: trade.id, contractId } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <li className="scope-trade" data-testid="scope-trade" data-state={state}>
      <p className="scope-trade-line">
        {t('scope.trade.line', { out: pick(trade.outItem, 'label', locale), in: pick(trade.inItem, 'label', locale) })}
      </p>
      <p className="t-caption">{t(`scope.trade.state.${customer ? 'customer' : 'staff'}.${state}`)}</p>
      {customer && !trade.customerConfirmedAt ? (
        <div>
          <button className="btn btn-primary btn-sm" type="button" disabled={loading} onClick={onClick} data-testid="scope-trade-confirm">
            {t('scope.trade.confirm')}
          </button>
        </div>
      ) : null}
      {rootCanConfirm ? <RootConfirm trade={trade} contractId={contractId} /> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// An extra's row (DX2a: moved here from Requirements; DX6: one checkbox, and its words are its label)
// ---------------------------------------------------------------------------

/**
 * Include or leave out one extra — `setExtra`, the same write Requirements'
 * Extras panel made, now on the step that owns the build list. Switching one off
 * is refused once work has started on it (`EXTRA_IN_PROGRESS`); the sentence is
 * the brief's own (`brief.error.*`).
 *
 * **One checkbox per extra, and the whole text is its `<label>`** (DX6): this used to draw a ☑/☐ glyph beside the
 * label and a real checkbox at the row's end, so each extra showed two and only one worked. The checkbox sits inside the
 * label, so a click on the words ticks it. A reader who cannot switch it (the customer, a locked step) gets the words and
 * a text mark instead of a control.
 */
function ExtraRow({ item, contract, canSwitch }: { item: ScopeItem; contract: Contract; canSwitch: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [setExtra, { loading }] = useMutation(SET_EXTRA);
  const [error, setError] = useState<string | null>(null);
  const included = isIncludedExtra(item.status);

  async function toggle(next: boolean) {
    setError(null);
    try {
      await setExtra({ variables: { scopeItemId: item.id, included: next, contractId: contract.id } });
    } catch (err) {
      setError(briefRefusalText(t, err));
    }
  }

  return (
    <span className="scope-item scope-extra" data-testid="scope-extra" data-key={item.key} data-included={included}>
      {canSwitch ? (
        <label className="req-check">
          <input type="checkbox" disabled={loading} checked={included} onChange={(e) => toggle(e.target.checked)} data-key={item.key} />
          <span className="scope-item-label">{pick(item, 'label', locale)}</span>
        </label>
      ) : (
        <span className="scope-item-label">
          {pick(item, 'label', locale)} <span className="t-caption">({included ? t('brief.extras.included') : t('brief.extras.notIncluded')})</span>
        </span>
      )}
      {error ? <span className="error" role="alert">{error}</span> : null}
    </span>
  );
}

/** A one-off extra can be removed; a seeded one (`checklist.*`) is switched off, never deleted. */
const isOneOff = (item: ScopeItem) => !item.key.startsWith('checklist.');

// A Root-side confirm for a trade, from the old Scope tab (the customer's is `TradeRow`'s own).
function RootConfirm({ trade, contractId }: { trade: ScopeTrade; contractId: string }) {
  const { t } = useTranslation();
  const [confirm, { loading }] = useMutation(CONFIRM_SCOPE_TRADE_ROOT, { variables: { contractId } });
  const [error, setError] = useState<string | null>(null);
  if (trade.rootConfirmedAt) return null;
  return (
    <div>
      <button
        className="btn btn-secondary btn-sm"
        type="button"
        disabled={loading}
        data-testid="scope-trade-confirm-root"
        onClick={async () => {
          setError(null);
          try {
            await confirm({ variables: { tradeId: trade.id } });
          } catch (err) {
            setError(refusalText(t, err));
          }
        }}
      >
        {t('workspace.scopeTradeConfirmRoot')}
      </button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export default function ScopePanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const items = ownItems(contract);
  const proposals = contract.scopeProposals ?? [];
  const trades = openTrades(contract);
  const canPropose = !staff && !step.locked && !!contract.publishedAt;
  const canDecide = staff && can(me, 'contracts.author') && !step.locked;
  // The Details drawer is the old Scope tab's controls: its own capability (`contracts.author`), and live after the
  // agreement too (a status moves as the build does), though not a rename or a delete (the API says `STEP_LOCKED`).
  const canDetail = staff && can(me, 'contracts.author');
  const [drawer, setDrawer] = useState<string | null>(null);
  const closeDrawer = (item: ScopeItem) => {
    setDrawer(null);
    document.getElementById(toggleId(item))?.focus();
  };

  // One model for every step: this step's feedback is this contract's SCOPE
  // feedback. `asCustomer` asks as the customer would be asked.
  const { data, refetch } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'SCOPE', phaseId: null, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const notes = data?.contract.feedbackItems ?? [];
  const noteFor = (itemId: string) => notes.find((i) => i.anchorScopeItem?.id === itemId) ?? null;

  const inScope = items.filter(isInScope);
  const leftOut = items.filter(isLeftOut);
  // The extras (DX2a): the checklist's areas and the like, as a group of their own.
  const extras = contract.scopeItems.filter((s) => s.kind === 'EXTRA').sort((a, b) => a.position - b.position);

  const waiting = undecidedProposals(proposals);
  const decided = newestFirst(proposals.filter((p) => p.decidedAt !== null));

  // DX6 (item 8): for staff the list is an accordion like the panels of the other steps; it opens by itself when it
  // has something to do — an empty list, a request waiting for Root, a site-type list not yet applied.
  const lacking = (items.length === 0 ? 1 : 0) + waiting.length + (canDecide && !contract.scopeTemplateApplied ? 1 : 0);
  const [listOpen, setListOpen] = useState(lacking > 0);

  const detailsFor = (item: ScopeItem, neighbours: ScopeItem[]) => ({
    toggle: canDetail ? <DetailsToggle item={item} open={drawer === item.id} onToggle={() => (drawer === item.id ? closeDrawer(item) : setDrawer(item.id))} /> : null,
    drawer: canDetail && drawer === item.id ? <ItemDrawer item={item} contract={contract} neighbours={neighbours} onClose={() => closeDrawer(item)} /> : undefined,
  });

  const [removeError, setRemoveError] = useState<string | null>(null);
  const del = useDeleteItem(contract, setRemoveError);

  const targetFor = (item: ScopeItem, group: string, neighbours: ScopeItem[]): FeedbackTarget => {
    const d = detailsFor(item, neighbours);
    return {
      key: item.id,
      group,
      label: (
        <span className="scope-item" data-testid="scope-item" data-key={item.key} data-status={item.status}>
          <span className="scope-item-label">{pick(item, 'label', locale)}</span>
          <ItemChips item={item} contract={contract} staff={staff} />
          {item.status === 'DECLINED' && item.declinedReason ? (
            <span className="t-caption">{t('scope.leftOut.reason', { reason: item.declinedReason })}</span>
          ) : item.status === 'TRADED' ? (
            <span className="t-caption">{t('scope.leftOut.traded')}</span>
          ) : null}
        </span>
      ),
      actions: (
        <>
          {canDecide ? <StaffItemActions item={item} contract={contract} /> : <ItemActions item={item} waiting={waitingProposalFor(proposals, item.id)} canPropose={canPropose} />}
          {d.toggle}
        </>
      ),
      drawer: d.drawer,
      input: { scopeItemId: item.id },
      item: noteFor(item.id),
    };
  };

  // An unticked extra is only its checkbox row; a ticked one, like every page, feature and deliverable, has the chips and the drawer.
  const extraTarget = (item: ScopeItem): FeedbackTarget => {
    const included = isIncludedExtra(item.status);
    const d = included ? detailsFor(item, extras.filter((x) => isIncludedExtra(x.status))) : { toggle: null, drawer: undefined };
    return {
      key: item.id,
      group: t('scope.group.EXTRA'),
      label: (
        <span className="scope-item" data-status={item.status}>
          <ExtraRow item={item} contract={contract} canSwitch={canDecide} />
          {included ? <ItemChips item={item} contract={contract} staff={staff} /> : null}
        </span>
      ),
      actions: (
        <>
          {canDecide && isOneOff(item) ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={del.deleting}
              onClick={() => del.run(item, pick(item, 'label', locale))}
              data-testid="extra-remove"
            >
              {t('scope.extras.remove')}
            </button>
          ) : null}
          {d.toggle}
        </>
      ),
      drawer: d.drawer,
      input: { scopeItemId: item.id },
      item: noteFor(item.id),
    };
  };

  const groups = groupByKind(inScope);
  const outList = leftOut;
  const targets: FeedbackTarget[] = [
    ...groups.flatMap((g) => g.items.map((i) => targetFor(i, t(`scope.group.${g.kind}`), g.items))),
    ...extras.map(extraTarget),
    ...outList.map((i) => targetFor(i, t('scope.leftOut.title'), outList)),
  ];

  const body = (
    <>
      {staff && !contract.publishedAt ? (
        <p className="t-small req-notice" data-testid="not-handed-over">
          {t('brief.notHandedOver')}
        </p>
      ) : null}

      {canDecide && !contract.scopeTemplateApplied ? <SeedCard contract={contract} /> : null}

      {staff && waiting.length > 0 ? (
        <section className="scope-queue" data-testid="scope-queue">
          <h4 className="t-h4">{t('scope.queue.title', { count: waiting.length, n: formatCount(waiting.length, locale) })}</h4>
          <ul className="scope-requests">
            {waiting.map((p) => (
              <ProposalRow key={p.id} proposal={p}>
                {canDecide ? <DecideForm proposal={p} /> : null}
              </ProposalRow>
            ))}
          </ul>
        </section>
      ) : null}

      {trades.length > 0 ? (
        <section className="scope-trades" data-testid="scope-trades">
          <h4 className="t-h4">{t('scope.trade.title')}</h4>
          <p className="sec-help">{t('scope.trade.help')}</p>
          <ul className="scope-requests">
            {trades.map((tr) => (
              <TradeRow key={tr.id} trade={tr} contractId={contract.id} customer={!staff} rootCanConfirm={canDetail} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* The empty line speaks of pages, features and deliverables; the extras (always seeded) are their own group below it. */}
      {items.length === 0 ? (
        <p className="t-small desk-muted" data-testid="scope-empty">
          {staff ? t('scope.empty.staff') : t('scope.empty.customer')}
        </p>
      ) : null}
      {items.length + extras.length > 0 ? (
        <FeedbackPanel
          contractId={contract.id}
          step="SCOPE"
          targets={targets}
          groupFooters={canDecide && extras.length > 0 ? { [t('scope.group.EXTRA')]: <AddExtraForm contract={contract} /> } : undefined}
          generalItem={notes.find((i) => i.general) ?? null}
          canRaise={!staff && !step.locked && !!contract.publishedAt}
          canAnswer={staff && can(me, 'feedback.answer')}
          answerDirect={can(me, 'answers.direct.agreement')}
          locked={step.locked}
          onChanged={() => void refetch()}
        />
      ) : null}
      {removeError ? <p className="error" role="alert">{removeError}</p> : null}

      {step.locked ? (
        <p className="t-small locknote" data-testid="scope-locked-note">
          {staff ? t('scope.locked.staff') : t('scope.locked.customer')}
        </p>
      ) : null}

      {canDecide ? <AddItemForm contract={contract} /> : null}
      {canDecide && extras.length === 0 ? <AddExtraForm contract={contract} /> : null}
    </>
  );

  return (
    <div className="scope-step" data-testid="scope-panel">
      <p className="t-small desk-muted">{staff ? t('scope.lede.staff') : t('scope.lede.customer')}</p>

      {staff ? (
        <Accordion id="scope-list" title={t('scope.list.title')} open={listOpen} onToggle={() => setListOpen((v) => !v)} missing={lacking}>
          <div className="scope-step">{body}</div>
        </Accordion>
      ) : (
        body
      )}

      {canPropose ? <AskForm contract={contract} /> : null}

      {!staff && proposals.length > 0 ? (
        <section className="scope-mine" data-testid="scope-mine">
          <h4 className="t-h4">{t('scope.requests.title')}</h4>
          <ul className="scope-requests">
            {newestFirst(proposals).map((p) => (
              <ProposalRow key={p.id} proposal={p} />
            ))}
          </ul>
        </section>
      ) : null}

      {staff && decided.length > 0 ? (
        <section className="scope-history" data-testid="scope-history">
          <h4 className="t-h4">{t('scope.history.title')}</h4>
          <ul className="scope-requests">
            {decided.map((p) => (
              <ProposalRow key={p.id} proposal={p} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
