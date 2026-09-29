import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, fullDateTime } from '@/lib/format';
import {
  GENERATE_DEMO_FRAME,
  UPDATE_DEMO_FRAME_SUMMARY,
  ADD_DEMO_FRAME_LINE,
  UPDATE_DEMO_FRAME_LINE,
  DELETE_DEMO_FRAME_LINE,
  PUBLISH_DEMO,
  CONTRACT_FEEDBACK,
  type Demo,
  type DemoFrameLine,
  type DemoFrameLineKind,
  type FeedbackItem,
} from '@/lib/queries';
import FeedbackPanel, { errorCode, type FeedbackTarget } from '@/components/FeedbackPanel';

/**
 * The review frame and the demo step's feedback (build plan L3; spec §6),
 * shared by the desk phase board, the portal contract detail and the wizard's
 * demo step — the same component `DemoViewport` already is for the live site
 * itself. Named without the bare word "review" — see schema.prisma's
 * `DemoFrame` comment.
 *
 * **Since S2 this is a thin wrapper.** Everything about *feedback* — the
 * threads, commenting and reopening, Root's answers, the interception prompt,
 * the step's approval — is the generic `FeedbackPanel`; what stays here is what
 * is particular to a demo: generating and authoring the frame (`canAuthor`,
 * `builds.author` and the project's own developer, journeys build plan S1),
 * publishing it, and turning the demo's pages and frame lines into the
 * panel's `targets`.
 *
 * The items come from the contract's own `feedbackItems` (one model for every
 * step) rather than from the demo tree, because a demo's `general` comments
 * belong to the step, not to any page — and asking for them the same way the
 * other steps will keeps this panel from knowing two ways to read feedback.
 */

const KIND_ORDER: DemoFrameLineKind[] = ['NEW', 'KNOWN_MISSING', 'TEMPORARY', 'DECIDED'];

type T = (key: string, opts?: Record<string, unknown>) => string;

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

export default function DemoFeedbackPanel({
  demo,
  contractId,
  phaseId,
  audience,
  canAuthor,
  canAnswer = false,
  answerDirect = false,
  canConvertToTicket = false,
  locked = false,
  canApprove = false,
  asCustomer = false,
  onChanged,
}: {
  demo: Demo;
  /** The contract this panel is shown on. The frame and publish mutations
   *  return `Contract!`, and a project can hold two contracts (J2), so each is
   *  told which one to hand back — the one on screen. */
  contractId: string;
  /** The phase this demo belongs to — a demo is approved once per phase, and
   *  its feedback is keyed on it. */
  phaseId: string;
  /** Who is looking. The customer raises feedback; staff answer it. */
  audience: 'customer' | 'staff';
  canAuthor: boolean;
  /** `feedback.answer`, and whether that answer is direct in the demo step
   *  (`answers.direct.demo`) — the answer box says which. */
  canAnswer?: boolean;
  answerDirect?: boolean;
  /** tickets.answer — an open item may become a change request. Optional
   *  (default false): the portal's call sites never offer it. */
  canConvertToTicket?: boolean;
  /** This phase's demo is approved (a `StepApproval` exists): no comment, no
   *  answer. Legacy contracts never lock. */
  locked?: boolean;
  /** The customer may approve the demo step from here (the wizard's panel). */
  canApprove?: boolean;
  /** Reading through view-as-customer: ask the API as the customer would be
   *  asked, so a pending answer is as invisible here as on the customer's own
   *  screen. */
  asCustomer?: boolean;
  /** Called after something changed that the nudged query cannot see on its
   *  own (the parent's contract query). */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  const named = { variables: { contractId } };
  const [generate, { loading: generating }] = useMutation(GENERATE_DEMO_FRAME, named);
  const [updateSummary] = useMutation(UPDATE_DEMO_FRAME_SUMMARY, named);
  const [addLine, { loading: addingLine }] = useMutation(ADD_DEMO_FRAME_LINE, named);
  const [updateLine] = useMutation(UPDATE_DEMO_FRAME_LINE, named);
  const [deleteLine] = useMutation(DELETE_DEMO_FRAME_LINE, named);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_DEMO, named);

  // One model for every step: the demo's feedback is this contract's DEMO
  // feedback for this phase. `cache-and-network` because a first comment on a
  // target creates an item the cache has never seen.
  const { data, refetch } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contractId, step: 'DEMO', phaseId, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const items = data?.contract.feedbackItems ?? [];
  const changed = () => {
    void refetch();
    onChanged();
  };

  const [publishError, setPublishError] = useState<string | null>(null);
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

  async function onPublish() {
    setPublishError(null);
    try {
      await publish({ variables: { demoId: demo.id } });
    } catch (err) {
      setPublishError(errorCode(err) === 'NO_FRAME' ? t('feedback.publishNoFrame') : (err as Error).message);
    }
  }

  const lines = [...(demo.frame?.lines ?? [])].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.position - b.position,
  );

  // The panel's targets: the frame's lines (by bucket), then the declared
  // pages — both only once the demo is published, the same gate the API holds.
  const targets: FeedbackTarget[] = [];
  for (const line of lines) {
    targets.push({
      key: `line:${line.id}`,
      group: t(`feedback.kind.${line.kind}`),
      label: pick(line, 'text', locale),
      caption: line.scopeItem?.decidedAt
        ? t('feedback.decidedOn', { date: fullDateTime(line.scopeItem.decidedAt, locale) })
        : undefined,
      actions: canAuthor ? (
        <span className="workspace-row" style={{ gap: '0.25rem' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingLineId(line.id)}>
            {t('workspace.edit')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => deleteLine({ variables: { lineId: line.id } })}>
            {t('workspace.delete')}
          </button>
        </span>
      ) : undefined,
      editor:
        editingLineId === line.id ? (
          <FrameLineEditor
            line={line}
            t={t}
            onCancel={() => setEditingLineId(null)}
            onSave={(textFa, textEn) => {
              updateLine({ variables: { lineId: line.id, textFa, textEn } });
              setEditingLineId(null);
            }}
          />
        ) : undefined,
      input: { demoId: demo.id, frameLineId: line.id },
      item: items.find((i) => i.frameLine?.id === line.id) ?? null,
    });
  }
  if (demo.publishedAt) {
    demo.pages.forEach((page, index) => {
      targets.push({
        key: `page:${page.id}`,
        group: index === 0 ? t('feedback.pagesTitle') : undefined,
        label: pick(page, 'label', locale),
        input: { demoId: demo.id, demoPageId: page.id },
        item: items.find((i) => i.demoPage?.id === page.id) ?? null,
      });
    });
  }

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

      {demo.frame && (demo.frame.summaryFa || demo.frame.summaryEn) ? (
        <p className="t-small">{pick({ textFa: demo.frame.summaryFa ?? '', textEn: demo.frame.summaryEn ?? '' }, 'text', locale)}</p>
      ) : null}

      <FeedbackPanel
        contractId={contractId}
        step="DEMO"
        phaseId={phaseId}
        targets={targets}
        generalItem={items.find((i) => i.general) ?? null}
        showGeneral={!!demo.publishedAt || audience === 'staff'}
        canRaise={audience === 'customer' && !!demo.publishedAt}
        canAnswer={canAnswer}
        answerDirect={answerDirect}
        canConvertToTicket={canConvertToTicket}
        locked={locked}
        canApprove={canApprove}
        onChanged={changed}
      />
    </div>
  );
}
