import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
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
  APPLY_SCOPE_TEMPLATE,
  CONFIRM_SCOPE_TRADE_CUSTOMER,
  CONTRACT_FEEDBACK,
  DECIDE_SCOPE_PROPOSAL,
  PROPOSE_RESTORE,
  PROPOSE_SCOPE_ADDITION,
  PROPOSE_SCOPE_REMOVAL,
  type Contract,
  type FeedbackItem,
  type ScopeItem,
  type ScopeProposal,
  type ScopeTrade,
} from '@/lib/queries';
import FeedbackPanel, { errorCode, type FeedbackTarget } from '@/components/FeedbackPanel';
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
 * "apply the site type's list" button while the contract has no scope of its
 * own, and the history of what was decided.
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
          <div className="field">
            <label className="label">{t('scope.decide.labelFa')}</label>
            <input className="input" dir="rtl" value={labelFa} onChange={(e) => setLabelFa(e.target.value)} data-testid="scope-label-fa" />
          </div>
          <div className="field">
            <label className="label">{t('scope.decide.labelEn')}</label>
            <input className="input" dir="ltr" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} data-testid="scope-label-en" />
          </div>
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
              disabled={loading || (isAdd && (!labelFa.trim() || !labelEn.trim()))}
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

function TradeRow({ trade, contractId, customer }: { trade: ScopeTrade; contractId: string; customer: boolean }) {
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
      {error ? <p className="error" role="alert">{error}</p> : null}
    </li>
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

  const targetFor = (item: ScopeItem, group: string): FeedbackTarget => ({
    key: item.id,
    group,
    label: (
      <span className="scope-item" data-testid="scope-item" data-key={item.key} data-status={item.status}>
        <span className="scope-item-label">{pick(item, 'label', locale)}</span>
        {item.status === 'DECLINED' && item.declinedReason ? (
          <span className="t-caption">{t('scope.leftOut.reason', { reason: item.declinedReason })}</span>
        ) : item.status === 'TRADED' ? (
          <span className="t-caption">{t('scope.leftOut.traded')}</span>
        ) : null}
      </span>
    ),
    actions: <ItemActions item={item} waiting={waitingProposalFor(proposals, item.id)} canPropose={canPropose} />,
    input: { scopeItemId: item.id },
    item: noteFor(item.id),
  });

  const targets: FeedbackTarget[] = [
    ...groupByKind(inScope).flatMap((g) => g.items.map((i) => targetFor(i, t(`scope.group.${g.kind}`)))),
    ...leftOut.map((i) => targetFor(i, t('scope.leftOut.title'))),
  ];

  const waiting = undecidedProposals(proposals);
  const decided = newestFirst(proposals.filter((p) => p.decidedAt !== null));

  return (
    <div className="scope-step" data-testid="scope-panel">
      <p className="t-small desk-muted">{staff ? t('scope.lede.staff') : t('scope.lede.customer')}</p>
      {staff && !contract.publishedAt ? (
        <p className="t-small req-notice" data-testid="not-handed-over">
          {t('brief.notHandedOver')}
        </p>
      ) : null}

      {canDecide && items.length === 0 ? <SeedCard contract={contract} /> : null}

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
              <TradeRow key={tr.id} trade={tr} contractId={contract.id} customer={!staff} />
            ))}
          </ul>
        </section>
      ) : null}

      {items.length === 0 ? (
        <p className="t-small desk-muted" data-testid="scope-empty">
          {staff ? t('scope.empty.staff') : t('scope.empty.customer')}
        </p>
      ) : (
        <FeedbackPanel
          contractId={contract.id}
          step="SCOPE"
          targets={targets}
          generalItem={notes.find((i) => i.general) ?? null}
          canRaise={!staff && !step.locked && !!contract.publishedAt}
          canAnswer={staff && can(me, 'feedback.answer')}
          answerDirect={can(me, 'answers.direct.agreement')}
          locked={step.locked}
          onChanged={() => void refetch()}
        />
      )}

      {step.locked ? (
        <p className="t-small locknote" data-testid="scope-locked-note">
          {staff ? t('scope.locked.staff') : t('scope.locked.customer')}
        </p>
      ) : null}

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
