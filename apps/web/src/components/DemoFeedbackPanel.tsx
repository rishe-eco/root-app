import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, fullDateTime, formatCount } from '@/lib/format';
import {
  GENERATE_DEMO_FRAME,
  UPDATE_DEMO_FRAME_SUMMARY,
  ADD_DEMO_FRAME_LINE,
  UPDATE_DEMO_FRAME_LINE,
  DELETE_DEMO_FRAME_LINE,
  PUBLISH_DEMO,
  SUBMIT_FEEDBACK,
  RATIFY_FEEDBACK,
  ACCEPT_FEEDBACK,
  CREATE_TICKET_FROM_FEEDBACK,
  type Demo,
  type DemoFrameLine,
  type DemoFrameLineKind,
  type FeedbackItem,
} from '@/lib/queries';

/**
 * The review frame and feedback intake surface (build plan L3; spec §6),
 * shared by the desk phase board and the portal contract detail — the same
 * component `DemoViewport` already is for the live site itself. Named
 * without the bare word "review" — see schema.prisma's `DemoFrame` comment.
 *
 * Two modes over one shape: `canAuthor` (staff, `contracts.manage`) reveals
 * generation, hand-authored lines and the publish gate; everyone who can see
 * a published demo at all may comment and, per D3, ratify (the decider is
 * the project's own customer or staff — an ownership edge, never a role,
 * checked server-side; this component does not attempt to guess who "the
 * decider" is beyond offering the control to whoever is looking).
 */

const KIND_ORDER: DemoFrameLineKind[] = ['NEW', 'KNOWN_MISSING', 'TEMPORARY', 'DECIDED'];

type T = (key: string, opts?: Record<string, unknown>) => string;

/** House rule 6: the API returns a code and parameters; this is the one
 *  place that turns them into a sentence. */
function interceptionSentence(
  t: T,
  locale: 'fa' | 'en',
  reason: 'DECIDED' | 'TEMPORARY',
  scopeItem: { labelFa: string; labelEn: string; decidedAt: string | null; decidedNote: string | null },
): string {
  const label = pick(scopeItem, 'label', locale);
  if (reason === 'DECIDED') {
    const date = scopeItem.decidedAt ? fullDateTime(scopeItem.decidedAt, locale) : '';
    return t('feedback.intercept.decided', { label, date, note: scopeItem.decidedNote ?? '' });
  }
  return t('feedback.intercept.temporary', { label });
}

/**
 * The customer's own half of L3b.2's first rule: an ADDRESSED item shows a
 * button, never an automatic transition — acceptFeedback is a distinct
 * mutation call, at a distinct moment, from whoever is looking. Available
 * to staff too (the same ownership-or-staff shape every mutation in this
 * panel already uses).
 */
function AcceptButton({ itemId, t }: { itemId: string; t: T }) {
  const [accept, { loading }] = useMutation(ACCEPT_FEEDBACK);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={loading}
      onClick={() => accept({ variables: { itemId } })}
    >
      {t('feedback.accept')}
    </button>
  );
}

/**
 * Build plan L4: "a ratified item becomes a change ticket — it is the
 * brief." Staff-only, and only while the item is RATIFIED and has not
 * already been converted (`item.ticket`) — the unique `sourceFeedbackItemId`
 * on the server is the real backstop; this is only what keeps the form from
 * being offered a second time. currentState/desiredState are written here,
 * by hand — see docs/development/L4.md for why this stage does not
 * auto-generate them from the comment thread.
 */
function ConvertToTicketForm({ itemId, t }: { itemId: string; t: T }) {
  const [open, setOpen] = useState(false);
  const [currentState, setCurrentState] = useState('');
  const [desiredState, setDesiredState] = useState('');
  const [lang, setLang] = useState<'fa' | 'en'>('en');
  const [error, setError] = useState<string | null>(null);
  const [convert, { loading, data }] = useMutation(CREATE_TICKET_FROM_FEEDBACK);

  if (data) {
    return <span className="badge">{t('feedback.convertedToTicket')}</span>;
  }

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

function FeedbackThread({
  item,
  t,
  locale,
  canAuthor,
}: {
  item: FeedbackItem;
  t: T;
  locale: 'fa' | 'en';
  canAuthor: boolean;
}) {
  return (
    <div className="feedback-thread">
      <div className="feedback-thread-head">
        <span className={`badge feedback-status-${item.status.toLowerCase()}`}>
          {t(`feedback.status.${item.status}`)}
        </span>
        {item.reopenedScopeItem ? <span className="t-caption">{t('feedback.reopened')}</span> : null}
      </div>
      {item.comments.map((c) => (
        <p className="feedback-comment" key={c.id}>
          <span className="t-eyebrow">{c.author.name}</span> — {c.body}
        </p>
      ))}
      {item.ratifiedAt ? (
        <p className="t-caption">
          {t('feedback.ratifiedLine', { name: item.ratifiedBy?.name ?? '', date: fullDateTime(item.ratifiedAt, locale) })}
        </p>
      ) : null}
      {/* Build plan L3b.2's first rule, shown as two separate facts — the
          developer's claim, never presented as the customer's acceptance. */}
      {item.addressedInBuild ? (
        <p className="t-caption">
          {t('feedback.addressedInBuild', { number: item.addressedInBuild.number })}
        </p>
      ) : null}
      {item.status === 'ADDRESSED' ? <AcceptButton itemId={item.id} t={t} /> : null}
      {item.acceptedAt ? (
        <p className="t-caption">
          {t('feedback.acceptedLine', { name: item.acceptedBy?.name ?? '', date: fullDateTime(item.acceptedAt, locale) })}
        </p>
      ) : null}
      {/* Build plan L4: a ratified item may become a change ticket — the
          brief. Never offered for an item already converted. */}
      {canAuthor && item.status === 'RATIFIED' && !item.ticket ? (
        <ConvertToTicketForm itemId={item.id} t={t} />
      ) : item.ticket ? (
        <span className="badge">{t('feedback.convertedToTicket')}</span>
      ) : null}
    </div>
  );
}

/**
 * Editing a line in place — an inline form, the same convention every other
 * edit in this codebase uses (`ScopeTab`, `DesignTab`, `PhasesTab`'s own
 * `DemoPageRow`). Never `window.prompt()`: a single-line native dialog has
 * no `dir="rtl"` and cannot hold two languages at once.
 */
function FrameLineEditor({
  line,
  t,
  onSave,
  onCancel,
}: {
  line: DemoFrameLine;
  t: T;
  onSave: (textFa: string, textEn: string) => void;
  onCancel: () => void;
}) {
  const [textFa, setTextFa] = useState(line.textFa);
  const [textEn, setTextEn] = useState(line.textEn);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(textFa, textEn);
  }

  return (
    <form className="editor-grid-2" onSubmit={submit}>
      <div className="field">
        <label className="label">{t('workspace.titleFa')}</label>
        <input className="input" dir="rtl" required value={textFa} onChange={(e) => setTextFa(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">{t('workspace.titleEn')}</label>
        <input className="input" dir="ltr" required value={textEn} onChange={(e) => setTextEn(e.target.value)} />
      </div>
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit">
          {t('workspace.save')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onCancel}>
          {t('feedback.cancel')}
        </button>
      </div>
    </form>
  );
}

function CommentForm({
  t,
  onSubmit,
  loading,
}: {
  t: T;
  onSubmit: (body: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t('feedback.addComment')}
      </button>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    onSubmit(body.trim());
    setBody('');
    setOpen(false);
  }

  return (
    <form className="feedback-comment-form" onSubmit={submit}>
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

export default function DemoFeedbackPanel({
  demo,
  canAuthor,
  onChanged,
}: {
  demo: Demo;
  canAuthor: boolean;
  /** Called after a comment is written for the first time against a target
   *  (submitFeedback does not return Contract! — see queries.ts's own note
   *  — so the caller's query needs an explicit nudge to see the new item). */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  const [generate, { loading: generating }] = useMutation(GENERATE_DEMO_FRAME);
  const [updateSummary] = useMutation(UPDATE_DEMO_FRAME_SUMMARY);
  const [addLine, { loading: addingLine }] = useMutation(ADD_DEMO_FRAME_LINE);
  const [updateLine] = useMutation(UPDATE_DEMO_FRAME_LINE);
  const [deleteLine] = useMutation(DELETE_DEMO_FRAME_LINE);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_DEMO);
  const [submitFeedback, { loading: submitting }] = useMutation(SUBMIT_FEEDBACK);
  const [ratify, { loading: ratifying }] = useMutation(RATIFY_FEEDBACK);

  const [publishError, setPublishError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<
    Record<string, { reason: 'DECIDED' | 'TEMPORARY'; item: { labelFa: string; labelEn: string; decidedAt: string | null; decidedNote: string | null }; body: string }>
  >({});

  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [addingLineOpen, setAddingLineOpen] = useState(false);
  const [newLineKind, setNewLineKind] = useState<DemoFrameLineKind>('NEW');
  const [newLineFa, setNewLineFa] = useState('');
  const [newLineEn, setNewLineEn] = useState('');
  const [summaryFa, setSummaryFa] = useState(demo.frame?.summaryFa ?? '');
  const [summaryEn, setSummaryEn] = useState(demo.frame?.summaryEn ?? '');

  // Build plan L3b's third source: an unprompted build change, written up
  // into a genuine bilingual line by hand — never auto-translated (L3b.3's
  // Persian-authorship decision). writeUpFa/writeUpEn start from the raw
  // note only on the side matching its authored language, so the other
  // language is never silently seeded with text the customer cannot read.
  const [writeUpId, setWriteUpId] = useState<string | null>(null);
  const [writeUpFa, setWriteUpFa] = useState('');
  const [writeUpEn, setWriteUpEn] = useState('');

  function startWriteUp(entry: { id: string; note: string | null; noteLang: string | null }) {
    setWriteUpId(entry.id);
    setWriteUpFa(entry.noteLang === 'fa' ? (entry.note ?? '') : '');
    setWriteUpEn(entry.noteLang === 'en' ? (entry.note ?? '') : '');
  }

  async function onSubmitTarget(
    target: { targetDemoPageId?: string; targetFrameLineId?: string },
    body: string,
    confirmReopen = false,
  ) {
    const key = target.targetDemoPageId ?? target.targetFrameLineId!;
    const res = await submitFeedback({
      variables: { demoId: demo.id, body, confirmReopen, ...target },
    });
    const result = res.data?.submitFeedback as
      | { item: unknown; intercepted: boolean; interceptionReason: 'DECIDED' | 'TEMPORARY' | null; interceptionScopeItem: { labelFa: string; labelEn: string; decidedAt: string | null; decidedNote: string | null } | null }
      | undefined;
    if (!result) return;
    if (result.intercepted && !confirmReopen && result.interceptionReason && result.interceptionScopeItem) {
      setPending((p) => ({ ...p, [key]: { reason: result.interceptionReason!, item: result.interceptionScopeItem!, body } }));
      return;
    }
    setPending((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    onChanged();
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onRatify() {
    if (selected.size === 0) return;
    await ratify({ variables: { demoId: demo.id, itemIds: [...selected] } });
    setSelected(new Set());
  }

  async function onPublish() {
    setPublishError(null);
    try {
      await publish({ variables: { demoId: demo.id } });
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions?.code;
      setPublishError(code === 'NO_FRAME' ? t('feedback.publishNoFrame') : (err as Error).message);
    }
  }

  const lines = [...(demo.frame?.lines ?? [])].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.position - b.position,
  );
  const linesByKind = new Map<DemoFrameLineKind, DemoFrameLine[]>();
  for (const line of lines) {
    const bucket = linesByKind.get(line.kind) ?? [];
    bucket.push(line);
    linesByKind.set(line.kind, bucket);
  }

  const allItems: FeedbackItem[] = [
    ...demo.feedbackItems,
    ...lines.map((l) => l.feedbackItem).filter((i): i is FeedbackItem => i !== null),
  ];
  const openCount = allItems.filter((i) => i.status === 'OPEN').length;

  return (
    <div className="demo-frame-panel">
      {canAuthor ? (
        <div className="demo-frame-authoring">
          <div className="workspace-row">
            <h4 className="t-h3">{t('feedback.frameTitle')}</h4>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => generate({ variables: { demoId: demo.id } })} disabled={generating}>
              {demo.frame ? t('feedback.refreshFrame') : t('feedback.generateFrame')}
            </button>
          </div>

          {demo.frame ? (
            <>
              <div className="editor-grid-2">
                <div className="field">
                  <label className="label">{t('feedback.summaryFa')}</label>
                  <textarea
                    className="input"
                    dir="rtl"
                    rows={2}
                    value={summaryFa}
                    onChange={(e) => setSummaryFa(e.target.value)}
                    onBlur={() => updateSummary({ variables: { demoId: demo.id, summaryFa, summaryEn } })}
                  />
                </div>
                <div className="field">
                  <label className="label">{t('feedback.summaryEn')}</label>
                  <textarea
                    className="input"
                    dir="ltr"
                    rows={2}
                    value={summaryEn}
                    onChange={(e) => setSummaryEn(e.target.value)}
                    onBlur={() => updateSummary({ variables: { demoId: demo.id, summaryFa, summaryEn } })}
                  />
                </div>
              </div>

              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingLineOpen((v) => !v)}>
                {t('feedback.addLine')}
              </button>
              {addingLineOpen ? (
                <form
                  className="card editor-card auth-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await addLine({ variables: { demoId: demo.id, kind: newLineKind, textFa: newLineFa, textEn: newLineEn } });
                    setNewLineFa('');
                    setNewLineEn('');
                    setAddingLineOpen(false);
                  }}
                >
                  <div className="field">
                    <label className="label">{t('feedback.lineKind')}</label>
                    <select className="input" value={newLineKind} onChange={(e) => setNewLineKind(e.target.value as DemoFrameLineKind)}>
                      {KIND_ORDER.map((k) => (
                        <option key={k} value={k}>
                          {t(`feedback.kind.${k}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="editor-grid-2">
                    <div className="field">
                      <label className="label">{t('workspace.titleFa')}</label>
                      <input className="input" dir="rtl" required value={newLineFa} onChange={(e) => setNewLineFa(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">{t('workspace.titleEn')}</label>
                      <input className="input" dir="ltr" required value={newLineEn} onChange={(e) => setNewLineEn(e.target.value)} />
                    </div>
                  </div>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={addingLine}>
                    {t('workspace.save')}
                  </button>
                </form>
              ) : null}

              {/* Build plan L3b's third source, surfaced so nobody has to
                  remember it exists (fields.ts's own comment on
                  unpromptedChanges) — a change nobody asked for, not yet
                  written up as a real bilingual line. */}
              {demo.frame.unpromptedChanges.length > 0 ? (
                <div className="demo-frame-bucket">
                  <p className="t-eyebrow">{t('feedback.unpromptedTitle')}</p>
                  {demo.frame.unpromptedChanges.map((entry) =>
                    writeUpId === entry.id ? (
                      <form
                        key={entry.id}
                        className="card editor-card auth-form"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          await addLine({
                            variables: { demoId: demo.id, kind: 'NEW', textFa: writeUpFa, textEn: writeUpEn, buildChangeEntryId: entry.id },
                          });
                          setWriteUpId(null);
                        }}
                      >
                        <div className="editor-grid-2">
                          <div className="field">
                            <label className="label">{t('workspace.titleFa')}</label>
                            <input className="input" dir="rtl" required value={writeUpFa} onChange={(e) => setWriteUpFa(e.target.value)} />
                          </div>
                          <div className="field">
                            <label className="label">{t('workspace.titleEn')}</label>
                            <input className="input" dir="ltr" required value={writeUpEn} onChange={(e) => setWriteUpEn(e.target.value)} />
                          </div>
                        </div>
                        <div className="workspace-row">
                          <button className="btn btn-primary btn-sm" type="submit">
                            {t('workspace.save')}
                          </button>
                          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setWriteUpId(null)}>
                            {t('feedback.cancel')}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="demo-frame-line" key={entry.id}>
                        <div className="demo-frame-line-head">
                          <span className="t-small">{entry.note}</span>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => startWriteUp(entry)}>
                            {t('feedback.writeUp')}
                          </button>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              ) : null}
            </>
          ) : null}

          <div className="workspace-row">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onPublish} disabled={publishing || !!demo.publishedAt}>
              {demo.publishedAt ? t('feedback.published') : t('feedback.publish')}
            </button>
            {publishError ? <span className="error">{publishError}</span> : null}
          </div>
        </div>
      ) : null}

      {demo.frame ? (
        <div className="demo-frame-lines">
          {(demo.frame.summaryFa || demo.frame.summaryEn) ? (
            <p className="t-small">{pick({ textFa: demo.frame.summaryFa ?? '', textEn: demo.frame.summaryEn ?? '' }, 'text', locale)}</p>
          ) : null}
          {KIND_ORDER.filter((k) => (linesByKind.get(k) ?? []).length > 0).map((kind) => (
            <div key={kind} className="demo-frame-bucket">
              <p className="t-eyebrow">{t(`feedback.kind.${kind}`)}</p>
              {(linesByKind.get(kind) ?? []).map((line) => (
                <div className="demo-frame-line" key={line.id}>
                  {editingLineId === line.id ? (
                    <FrameLineEditor
                      line={line}
                      t={t}
                      onCancel={() => setEditingLineId(null)}
                      onSave={(textFa, textEn) => {
                        updateLine({ variables: { lineId: line.id, textFa, textEn } });
                        setEditingLineId(null);
                      }}
                    />
                  ) : (
                    <div className="demo-frame-line-head">
                      <span>{pick(line, 'text', locale)}</span>
                      {line.scopeItem?.decidedAt ? (
                        <span className="t-caption">
                          {t('feedback.decidedOn', { date: fullDateTime(line.scopeItem.decidedAt, locale) })}
                        </span>
                      ) : null}
                      {canAuthor ? (
                        <span className="workspace-row" style={{ gap: '0.25rem' }}>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingLineId(line.id)}>
                            {t('workspace.edit')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => deleteLine({ variables: { lineId: line.id } })}
                          >
                            {t('workspace.delete')}
                          </button>
                        </span>
                      ) : null}
                    </div>
                  )}

                  {line.feedbackItem ? (
                    <>
                      <FeedbackThread item={line.feedbackItem} t={t} locale={locale} canAuthor={canAuthor} />
                      {line.feedbackItem.status === 'OPEN' ? (
                        <label className="feedback-ratify-check">
                          <input type="checkbox" checked={selected.has(line.feedbackItem.id)} onChange={() => toggle(line.feedbackItem!.id)} />
                          {t('feedback.selectForRatify')}
                        </label>
                      ) : null}
                    </>
                  ) : pending[line.id] ? (
                    <div className="feedback-intercept">
                      <p className="t-small">{interceptionSentence(t, locale, pending[line.id].reason, pending[line.id].item)}</p>
                      <div className="workspace-row">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={submitting}
                          onClick={() => onSubmitTarget({ targetFrameLineId: line.id }, pending[line.id].body, true)}
                        >
                          {t('feedback.confirmReopen')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setPending((p) => { const n = { ...p }; delete n[line.id]; return n; })}
                        >
                          {t('feedback.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : demo.publishedAt ? (
                    <CommentForm t={t} loading={submitting} onSubmit={(body) => onSubmitTarget({ targetFrameLineId: line.id }, body)} />
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {demo.publishedAt && demo.pages.length > 0 ? (
        <div className="demo-frame-pages">
          <p className="t-eyebrow">{t('feedback.pagesTitle')}</p>
          {demo.pages.map((page) => {
            const item = demo.feedbackItems.find((i) => i.demoPage?.id === page.id) ?? null;
            return (
              <div className="demo-frame-line" key={page.id}>
                <div className="demo-frame-line-head">
                  <span>{pick(page, 'label', locale)}</span>
                </div>
                {item ? (
                  <>
                    <FeedbackThread item={item} t={t} locale={locale} canAuthor={canAuthor} />
                    {item.status === 'OPEN' ? (
                      <label className="feedback-ratify-check">
                        <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                        {t('feedback.selectForRatify')}
                      </label>
                    ) : null}
                  </>
                ) : (
                  <CommentForm t={t} loading={submitting} onSubmit={(body) => onSubmitTarget({ targetDemoPageId: page.id }, body)} />
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {openCount > 0 ? (
        <div className="workspace-row">
          <button className="btn btn-primary btn-sm" type="button" onClick={onRatify} disabled={ratifying || selected.size === 0}>
            {t('feedback.ratifySelected', { n: formatCount(selected.size, locale) })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
