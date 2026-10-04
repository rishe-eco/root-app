import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, fullDateTime, formatCount } from '@/lib/format';
import {
  ANSWER_FEEDBACK,
  APPROVE_DEMO,
  CREATE_TICKET_FROM_FEEDBACK,
  SUBMIT_FEEDBACK,
  type FeedbackComment,
  type FeedbackItem,
  type FeedbackResolution,
  type FeedbackTargetInput,
  type StepKind,
} from '@/lib/queries';

/**
 * The feedback surface for **any** step (journeys build plan S2, PD-1): a list
 * of targets — a page, a frame line, a brief field, the step as a whole — each
 * with its thread, and the four things one can do to a thread:
 *
 * - **the customer comments**, and commenting on an item Root has resolved
 *   *reopens* it — said beside the box, in words, because a state change that
 *   happens without being said is the surprise §3.1 exists to avoid;
 * - **Root answers** (`feedback.answer`): directly, or into sales' queue, and
 *   the box says which, so nobody types an answer believing the customer will
 *   read it when they will not;
 * - **Root converts** an open item to a change request;
 * - **the customer approves the step** — refused with a sentence while anything
 *   is open, and the approval button is the same act on every step.
 *
 * It knows nothing about demos: `DemoFeedbackPanel` is the thin wrapper that
 * turns a demo's pages and frame lines into `targets`, and the other steps'
 * panels (J4–J10) will do the same with their own anchors. Everything here is
 * keyed off the *item* the API returns, so what the customer may not see (a
 * pending answer, who approved it) is simply absent from it.
 *
 * ## Why "general" says what it does
 *
 * Every step also takes a comment about the step as a whole, and all of them
 * land in **one shared thread** — the API collapses them (a `general` item is
 * one per step, or per step and phase). The heading says so, because a
 * customer who adds a second general comment and sees it under the first
 * should have been told that is how it works.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

export type FeedbackTarget = {
  key: string;
  /** Sections the list under a heading (the demo's four buckets); the heading
   *  shows when it changes from the previous target's. */
  group?: string;
  label: ReactNode;
  caption?: ReactNode;
  /** Staff-authoring controls that belong beside this target (edit, delete). */
  actions?: ReactNode;
  /** Replaces the label row while a target is being edited in place. */
  editor?: ReactNode;
  input: FeedbackTargetInput;
  item: FeedbackItem | null;
};

export type FeedbackPanelProps = {
  contractId: string;
  step: StepKind;
  phaseId?: string | null;
  targets: FeedbackTarget[];
  /** The step's shared thread, if anyone has started it. */
  generalItem: FeedbackItem | null;
  /** Offer the step-as-a-whole thread. Default true. */
  showGeneral?: boolean;
  /** The contract's own customer may raise feedback (and only while the step
   *  is open). */
  canRaise: boolean;
  /** `feedback.answer`, and whether the caller's answer in this step reaches
   *  the customer at once (`answers.direct.<step>`). */
  canAnswer: boolean;
  answerDirect: boolean;
  /** `tickets.answer` — an open item may become a change request. */
  canConvertToTicket?: boolean;
  /** The step is approved: no comment, no answer — a change request instead. */
  locked: boolean;
  /** The customer may approve the step from here. */
  canApprove?: boolean;
  /** Called after something changed that the panel's own mutations cannot
   *  merge into the cache — a first comment on a target creates an item the
   *  list has never seen. */
  onChanged: () => void;
  /** Called after Root's answer is saved. Optional, and unused by the steps whose
   *  state does not move with an answer; the draft (J6) needs it because that
   *  step is *done* while no note waits for Root, so an answer changes the road
   *  the step list draws — and `answerFeedback` returns an item, not a Contract. */
  onAnswered?: () => void;
};

/** The first GraphQL error's `extensions.code`, or null. */
export function errorCode(err: unknown): string | null {
  return (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions?.code ?? null;
}

type Intercepted = {
  reason: 'DECIDED' | 'TEMPORARY';
  scopeItem: { labelFa: string; labelEn: string; decidedAt: string | null; decidedNote: string | null };
  body: string;
};

/** House rule 6: the API returns a code and parameters; this is the one place
 *  that turns them into a sentence. */
function interceptionSentence(t: T, locale: 'fa' | 'en', p: Intercepted): string {
  const label = pick(p.scopeItem, 'label', locale);
  if (p.reason === 'DECIDED') {
    const date = p.scopeItem.decidedAt ? fullDateTime(p.scopeItem.decidedAt, locale) : '';
    return t('feedback.intercept.decided', { label, date, note: p.scopeItem.decidedNote ?? '' });
  }
  return t('feedback.intercept.temporary', { label });
}

/**
 * Root converts an open item to a change request (build plan L4): the item
 * becomes MOVED — a resolution the customer sees — and the ticket carries the
 * brief. Staff-only, and only while the item is open and has no ticket yet; the
 * unique `sourceFeedbackItemId` on the server is the real backstop.
 */
function ConvertToTicketForm({ itemId, t }: { itemId: string; t: T }) {
  const [open, setOpen] = useState(false);
  const [currentState, setCurrentState] = useState('');
  const [desiredState, setDesiredState] = useState('');
  const [lang, setLang] = useState<'fa' | 'en'>('en');
  const [error, setError] = useState<string | null>(null);
  const [convert, { loading, data }] = useMutation(CREATE_TICKET_FROM_FEEDBACK);

  if (data) return <span className="badge">{t('feedback.convertedToTicket')}</span>;

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t('feedback.convertToTicket')}
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!currentState.trim() || !desiredState.trim()) return;
    try {
      await convert({ variables: { itemId, currentState: currentState.trim(), desiredState: desiredState.trim(), lang } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card editor-card auth-form" onSubmit={submit}>
      <div className="field">
        <label className="label">{t('feedback.briefCurrentState')}</label>
        <textarea className="input" rows={2} value={currentState} onChange={(e) => setCurrentState(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">{t('feedback.briefDesiredState')}</label>
        <textarea className="input" rows={2} value={desiredState} onChange={(e) => setDesiredState(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">{t('desk.builds.noteLangLabel')}</label>
        <select className="input" value={lang} onChange={(e) => setLang(e.target.value as 'fa' | 'en')}>
          <option value="en">{t('desk.builds.lang.en')}</option>
          <option value="fa">{t('desk.builds.lang.fa')}</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
          {t('feedback.convertToTicket')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
    </form>
  );
}

/** One comment: who, what, and — where the viewer may see it — what state the
 *  answer is in. A customer's copy of these fields is empty by construction
 *  (the API withholds them), so nothing here checks who is looking. */
function CommentRow({ c, t, locale }: { c: FeedbackComment; t: T; locale: 'fa' | 'en' }) {
  return (
    <div className={`feedback-comment-row feedback-comment-${c.approval.toLowerCase()}`} data-approval={c.approval}>
      <p className="feedback-comment">
        <span className="t-eyebrow">{c.author.name}</span>
        {c.body ? <> — {c.body}</> : null}
        {c.resolution ? <span className="badge feedback-resolution">{t(`feedback.resolution.${c.resolution}`)}</span> : null}
      </p>
      {c.approval === 'PENDING' ? <p className="t-caption">{t('feedback.approval.PENDING')}</p> : null}
      {c.approval === 'DECLINED' ? (
        <p className="t-caption">{t('feedback.approval.DECLINED', { reason: c.approvalNote ?? '' })}</p>
      ) : null}
      {c.approval === 'APPROVED' && c.approvedBy ? (
        <p className="t-caption">
          {t('feedback.approval.APPROVED', { name: c.approvedBy.name, date: c.approvedAt ? fullDateTime(c.approvedAt, locale) : '' })}
        </p>
      ) : null}
      {c.originalBody ? <p className="t-caption">{t('feedback.approval.editedFrom', { text: c.originalBody })}</p> : null}
    </div>
  );
}

function CommentForm({
  t,
  hint,
  labelKey,
  loading,
  onSubmit,
}: {
  t: T;
  hint: string | null;
  labelKey: string;
  loading: boolean;
  onSubmit: (body: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t(labelKey)}
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    await onSubmit(body.trim());
    setBody('');
    setOpen(false);
  }

  return (
    <form className="feedback-comment-form" onSubmit={submit}>
      {hint ? <p className="t-caption feedback-reopen-hint">{hint}</p> : null}
      <textarea
        className="input"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('feedback.commentPlaceholder')}
      />
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
          {t('feedback.submit')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * Root's answer: text, optionally a resolution, and a line saying whether the
 * customer will read it now or after sales has. A declined resolution needs
 * its reason, which is the text itself — the form refuses an empty one.
 */
function AnswerForm({
  t,
  direct,
  loading,
  error,
  onSubmit,
}: {
  t: T;
  direct: boolean;
  loading: boolean;
  error: string | null;
  onSubmit: (body: string, resolution: FeedbackResolution | null) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [resolution, setResolution] = useState<FeedbackResolution | ''>('');

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        {t('feedback.answer.action')}
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    await onSubmit(body.trim(), resolution || null);
    setBody('');
    setResolution('');
    setOpen(false);
  }

  return (
    <form className="feedback-comment-form" onSubmit={submit} data-testid="answer-form">
      <p className="t-caption">{direct ? t('feedback.answer.directHint') : t('feedback.answer.pendingHint')}</p>
      <textarea
        className="input"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('feedback.answer.placeholder')}
        aria-label={t('feedback.answer.placeholder')}
      />
      <div className="field">
        <label className="label" htmlFor="answer-resolution">
          {t('feedback.answer.resolutionLabel')}
        </label>
        <select
          id="answer-resolution"
          className="input"
          value={resolution}
          onChange={(e) => setResolution(e.target.value as FeedbackResolution | '')}
        >
          <option value="">{t('feedback.answer.resolutionNone')}</option>
          <option value="ADDRESSED">{t('feedback.resolution.ADDRESSED')}</option>
          <option value="DECLINED">{t('feedback.answer.resolutionDeclined')}</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
          {t('feedback.answer.submit')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
    </form>
  );
}

function Thread({
  item,
  t,
  locale,
  canRaise,
  canAnswer,
  answerDirect,
  canConvertToTicket,
  locked,
  submitting,
  onComment,
  onAnswer,
  answerError,
  answering,
}: {
  item: FeedbackItem;
  t: T;
  locale: 'fa' | 'en';
  canRaise: boolean;
  canAnswer: boolean;
  answerDirect: boolean;
  canConvertToTicket: boolean;
  locked: boolean;
  submitting: boolean;
  onComment: (body: string) => void | Promise<void>;
  onAnswer: (body: string, resolution: FeedbackResolution | null) => void | Promise<void>;
  answerError: string | null;
  answering: boolean;
}) {
  // §3.1: commenting on a resolved item reopens it. Said beside the box.
  const reopens = item.status === 'ADDRESSED' || item.status === 'DECLINED' || item.status === 'MOVED';
  return (
    <div className="feedback-thread" data-testid="feedback-thread" data-status={item.status}>
      <div className="feedback-thread-head">
        <span className={`badge feedback-status-${item.status.toLowerCase()}`} data-testid="feedback-status">
          {t(`feedback.status.${item.status}`)}
        </span>
        {item.reopenedScopeItem ? <span className="t-caption">{t('feedback.reopened')}</span> : null}
      </div>
      {item.comments.map((c) => (
        <CommentRow key={c.id} c={c} t={t} locale={locale} />
      ))}
      {/* Build plan L3b.2's first rule, shown as two separate facts — the
          developer's claim, never presented as the customer's acceptance. */}
      {item.addressedInBuild ? (
        <p className="t-caption">
          {t('feedback.addressedInBuild', { number: item.addressedInBuild.number, name: item.addressedInBuild.declaredBy.name })}
        </p>
      ) : null}
      {item.status === 'MOVED' ? <p className="t-caption">{t('feedback.movedNote')}</p> : null}
      {item.acceptedAt ? (
        <p className="t-caption">
          {t('feedback.acceptedLine', { name: item.acceptedBy?.name ?? '', date: fullDateTime(item.acceptedAt, locale) })}
        </p>
      ) : null}

      {!locked && canRaise ? (
        <CommentForm
          t={t}
          loading={submitting}
          labelKey={reopens ? 'feedback.reopenAction' : 'feedback.replyAction'}
          hint={reopens ? t(`feedback.reopenHint.${item.status}`) : null}
          onSubmit={onComment}
        />
      ) : null}
      {!locked && canAnswer ? (
        <AnswerForm t={t} direct={answerDirect} loading={answering} error={answerError} onSubmit={onAnswer} />
      ) : null}
      {/* Build plan L4: an open item may become a change request — the brief.
          `tickets.answer` (sales), not the frame's own builds.author. */}
      {canConvertToTicket && item.status === 'OPEN' && !item.ticket && !locked ? (
        <ConvertToTicketForm itemId={item.id} t={t} />
      ) : item.ticket ? (
        <span className="badge">{t('feedback.convertedToTicket')}</span>
      ) : null}
    </div>
  );
}

export default function FeedbackPanel({
  contractId,
  step,
  phaseId = null,
  targets,
  generalItem,
  showGeneral = true,
  canRaise,
  canAnswer,
  answerDirect,
  canConvertToTicket = false,
  locked,
  canApprove = false,
  onChanged,
  onAnswered,
}: FeedbackPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();

  const [submitFeedback, { loading: submitting }] = useMutation(SUBMIT_FEEDBACK);
  const [answerFeedback, { loading: answering }] = useMutation(ANSWER_FEEDBACK);
  const [approveDemo, { loading: approving }] = useMutation(APPROVE_DEMO);

  const [pending, setPending] = useState<Record<string, Intercepted>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [approveError, setApproveError] = useState<string | null>(null);

  const all: FeedbackTarget[] = [
    ...targets,
    ...(showGeneral
      ? [
          {
            key: 'general',
            group: t('feedback.generalTitle'),
            label: <span className="t-small">{t('feedback.generalHelp')}</span>,
            input: { general: true },
            item: generalItem,
          } satisfies FeedbackTarget,
        ]
      : []),
  ];
  const openCount = all.filter((x) => x.item?.status === 'OPEN').length;

  const errorText = (err: unknown): string => {
    const code = errorCode(err);
    return code && t(`feedback.error.${code}`, { defaultValue: '' }) ? t(`feedback.error.${code}`) : (err as Error).message;
  };

  async function comment(target: FeedbackTarget, body: string, confirmReopen = false) {
    setErrors((e) => ({ ...e, [target.key]: '' }));
    try {
      const res = await submitFeedback({
        variables: { contractId, step, phaseId, target: target.input, body, confirmReopen },
      });
      const result = res.data?.submitFeedback as
        | {
            intercepted: boolean;
            interceptionReason: 'DECIDED' | 'TEMPORARY' | null;
            interceptionScopeItem: Intercepted['scopeItem'] | null;
          }
        | undefined;
      if (!result) return;
      if (result.intercepted && !confirmReopen && result.interceptionReason && result.interceptionScopeItem) {
        setPending((p) => ({
          ...p,
          [target.key]: { reason: result.interceptionReason!, scopeItem: result.interceptionScopeItem!, body },
        }));
        return;
      }
      setPending((p) => {
        const next = { ...p };
        delete next[target.key];
        return next;
      });
      onChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [target.key]: errorText(err) }));
    }
  }

  async function answer(target: FeedbackTarget, body: string, resolution: FeedbackResolution | null) {
    if (!target.item) return;
    setErrors((e) => ({ ...e, [target.key]: '' }));
    try {
      await answerFeedback({ variables: { itemId: target.item.id, body, resolution } });
      onAnswered?.();
    } catch (err) {
      setErrors((e) => ({ ...e, [target.key]: errorText(err) }));
    }
  }

  async function approve() {
    setApproveError(null);
    // J10: the one step approved from here is a phase's demo (the agreement, the design
    // and the mockup each have their own door), so there is always a phase.
    if (!phaseId) return;
    try {
      await approveDemo({ variables: { contractId, phaseId } });
      onChanged();
    } catch (err) {
      setApproveError(errorText(err));
    }
  }

  let lastGroup: string | undefined;
  return (
    <div className="feedback-panel" data-testid="feedback-panel" data-step={step}>
      {all.map((target) => {
        const showGroup = target.group !== undefined && target.group !== lastGroup;
        lastGroup = target.group ?? lastGroup;
        const p = pending[target.key];
        return (
          <div key={target.key} className="feedback-target-group">
            {showGroup ? <p className="t-eyebrow">{target.group}</p> : null}
            <div className="demo-frame-line" data-testid="feedback-target" data-key={target.key}>
              {target.editor ?? (
                <div className="demo-frame-line-head">
                  {target.key === 'general' ? target.label : <span>{target.label}</span>}
                  {target.caption ? <span className="t-caption">{target.caption}</span> : null}
                  {target.actions ?? null}
                </div>
              )}

              {target.item ? (
                <Thread
                  item={target.item}
                  t={t}
                  locale={locale}
                  canRaise={canRaise && !p}
                  canAnswer={canAnswer}
                  answerDirect={answerDirect}
                  canConvertToTicket={canConvertToTicket}
                  locked={locked}
                  submitting={submitting}
                  onComment={(body) => comment(target, body)}
                  onAnswer={(body, resolution) => answer(target, body, resolution)}
                  answerError={errors[target.key] || null}
                  answering={answering}
                />
              ) : null}

              {p ? (
                <div className="feedback-intercept">
                  <p className="t-small">{interceptionSentence(t, locale, p)}</p>
                  <div className="workspace-row">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={submitting}
                      onClick={() => comment(target, p.body, true)}
                    >
                      {t('feedback.confirmReopen')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setPending((prev) => { const n = { ...prev }; delete n[target.key]; return n; })}
                    >
                      {t('feedback.cancel')}
                    </button>
                  </div>
                </div>
              ) : !target.item && !locked && canRaise ? (
                <CommentForm
                  t={t}
                  loading={submitting}
                  labelKey="feedback.addComment"
                  hint={target.key === 'general' ? t('feedback.generalCollapse') : null}
                  onSubmit={(body) => comment(target, body)}
                />
              ) : null}
              {target.key === 'general' && target.item && !locked && canRaise ? (
                <p className="t-caption">{t('feedback.generalCollapse')}</p>
              ) : null}
              {errors[target.key] && !target.item ? <p className="error">{errors[target.key]}</p> : null}
              {errors[target.key] && target.item && !canAnswer ? <p className="error">{errors[target.key]}</p> : null}
            </div>
          </div>
        );
      })}

      {/* §3.1 rule 4: approval accepts everything at once and locks the step.
          After the lock, anything the customer wants is a change request. */}
      {canApprove ? (
        <div className="feedback-approve" data-testid="feedback-approve">
          {locked ? (
            <p className="t-small locknote">{t('feedback.lockedNote')}</p>
          ) : (
            <>
              <p className="t-small">{t('feedback.approveHelp')}</p>
              {openCount > 0 ? (
                <p className="t-caption" data-testid="feedback-open-count">
                  {t('feedback.openCount', { count: openCount, n: formatCount(openCount, locale) })}
                </p>
              ) : null}
              <div className="workspace-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={approving} onClick={approve} data-testid="approve-step">
                  {t('feedback.approveStep')}
                </button>
              </div>
              {approveError ? (
                <p className="error" role="alert" data-testid="approve-error">
                  {approveError}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
