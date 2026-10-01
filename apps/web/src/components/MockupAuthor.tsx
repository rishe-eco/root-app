import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, formatCount } from '@/lib/format';
import {
  CREATE_MOCKUP_DEMO,
  DECLARE_MOCKUP_BUILD,
  MAP_MOCKUP_PAGE,
  PUBLISH_BUILD,
  type BuildChangeInput,
  type BuildChangeOutcome,
  type Demo,
  type FeedbackItem,
} from '@/lib/queries';
import { MOCKUP_BUNDLE_ACCEPT, UploadFailure, uploadMockupBundle } from '@/lib/upload';
import { errorCode } from '@/components/FeedbackPanel';

/**
 * The designer's half of step 5 (journeys build plan J9b), rendered inside the
 * mockup panel for the contract's designer. In the order the work goes:
 *
 * 1. **Start the mockup** — the demo, with a page per agreed page of the scope.
 * 2. **Upload the bundle** — a zip, streamed to the server with a progress bar;
 *    a zip the server refuses is worded here (`upload.errBundle*`), because the
 *    designer is the one who can fix it.
 * 3. **Declare the iteration** — every open note of the customer's needs a fate
 *    first (addressed, declined with its reason, or carried forward): a fate must
 *    never be silent (L3b). Declaring costs no round.
 * 4. **Map the pages** — each page of the scope to a path in the bundle, offered
 *    from what the bundle actually has and **pre-filled from the last iteration**
 *    (the mapping belongs to the demo, so it carries over by itself).
 * 5. **Publish** — the customer is told, and the round is spent.
 *
 * Every control is decided by the caller (`canAuthor`); whether it works is the
 * API's, which re-checks the capability and the assignment on every mutation.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

export function mockupError(t: T, err: unknown): string {
  if (err instanceof UploadFailure) return t(err.i18nKey);
  const code = errorCode(err);
  return code && t(`mockup.error.${code}`, { defaultValue: '' }) ? t(`mockup.error.${code}`) : (err as Error).message;
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
      setError(mockupError(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { act, busy, error };
}

type Fate = { outcome: BuildChangeOutcome; note: string };

function itemLabel(item: FeedbackItem, locale: 'fa' | 'en', t: T): string {
  if (item.general) return t('feedback.generalTitle');
  if (item.demoPage) return pick(item.demoPage, 'label', locale);
  if (item.frameLine) return pick(item.frameLine, 'text', locale);
  return '';
}

// --- the page mapping -------------------------------------------------------------------

function PageMapping({ demo, onChanged, locked }: { demo: Demo; onChanged: () => void; locked: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [map] = useMutation(MAP_MOCKUP_PAGE);
  const { act, busy, error } = useAct();
  const pages = demo.pages;
  const [paths, setPaths] = useState<Record<string, string>>(() => Object.fromEntries(pages.map((p) => [p.id, p.canonicalPath])));
  const listId = `mockup-bundle-pages-${demo.id}`;

  return (
    <div className="mockup-mapping" data-testid="mockup-mapping">
      <h4 className="t-h3">{t('mockup.map.title')}</h4>
      <p className="t-caption desk-muted">{t('mockup.map.help')}</p>
      <datalist id={listId}>
        {(demo.bundlePages ?? []).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {pages.map((page) => {
        const current = page.canonicalPath;
        const typed = paths[page.id] ?? '';
        const inBundle = current !== '' && (demo.bundlePages ?? []).includes(current);
        return (
          <form
            key={page.id}
            className="workspace-row mockup-map-row"
            data-testid="mockup-map-row"
            data-key={page.key}
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await act(() => map({ variables: { demoPageId: page.id, path: typed } }))) onChanged();
            }}
          >
            <span className="mockup-map-label">{pick(page, 'label', locale)}</span>
            <input
              className="input num-latin"
              dir="ltr"
              list={listId}
              placeholder="/about"
              aria-label={t('mockup.map.pathFor', { label: pick(page, 'label', locale) })}
              value={typed}
              disabled={locked}
              onChange={(e) => setPaths((p) => ({ ...p, [page.id]: e.target.value }))}
            />
            <button className="btn btn-ghost btn-sm" type="submit" disabled={busy || locked || typed === current}>
              {t('workspace.save')}
            </button>
            {current === '' ? (
              <span className="t-caption desk-muted">{t('mockup.map.unmapped')}</span>
            ) : (
              <span className="t-caption" data-testid="mockup-map-state" data-in-bundle={inBundle ? 'true' : 'false'}>
                {inBundle ? t('mockup.map.inBundle') : t('mockup.map.notInBundle')}
              </span>
            )}
          </form>
        );
      })}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- the author -------------------------------------------------------------------------

export default function MockupAuthor({
  contractId,
  demo,
  openItems,
  locked,
  exhausted,
  onChanged,
}: {
  contractId: string;
  demo: Demo | null;
  /** The mockup step's items still open — each needs a fate before an iteration is declared. */
  openItems: FeedbackItem[];
  locked: boolean;
  /** The allowance is spent: publishing will be refused until sales extends it. */
  exhausted: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [create] = useMutation(CREATE_MOCKUP_DEMO);
  const [declare] = useMutation(DECLARE_MOCKUP_BUILD);
  const [publish] = useMutation(PUBLISH_BUILD);
  const { act, busy, error } = useAct();
  const input = useRef<HTMLInputElement>(null);

  const [progress, setProgress] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState<{ id: string; name: string } | null>(null);
  const [fates, setFates] = useState<Record<string, Fate>>({});
  const [note, setNote] = useState('');

  if (locked) return null;

  if (!demo) {
    return (
      <div className="mockup-author" data-testid="mockup-start">
        <p className="t-small">{t('mockup.start.help')}</p>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={busy}
          data-testid="mockup-start-action"
          onClick={async () => {
            if (await act(() => create({ variables: { contractId } }))) onChanged();
          }}
        >
          {t('mockup.start.action')}
        </button>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const builds = demo.builds ?? [];
  const drafts = builds.filter((b) => b.publishedAt === null);
  const fateOf = (id: string): Fate => fates[id] ?? { outcome: 'CARRIED_FORWARD', note: '' };

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploaded(null);
    setProgress(0);
    const ok = await act(async () => {
      const result = await uploadMockupBundle(contractId, file, setProgress);
      setUploaded({ id: result.id, name: result.originalName });
    });
    if (!ok) setProgress(null);
    if (input.current) input.current.value = '';
  }

  async function onDeclare(e: FormEvent) {
    e.preventDefault();
    if (!uploaded) return;
    const lang = locale;
    const changes: BuildChangeInput[] = openItems.map((item) => {
      const fate = fateOf(item.id);
      const text = fate.note.trim();
      return { feedbackItemId: item.id, outcome: fate.outcome, note: text || null, noteLang: text ? lang : null };
    });
    if (note.trim()) changes.push({ note: note.trim(), noteLang: lang });
    const done = await act(() => declare({ variables: { demoId: demo!.id, fileId: uploaded.id, changes } }));
    if (done) {
      setUploaded(null);
      setProgress(null);
      setFates({});
      setNote('');
      onChanged();
    }
  }

  return (
    <div className="mockup-author" data-testid="mockup-author">
      <h4 className="t-h3">{t('mockup.author.title')}</h4>

      <div className="field">
        <label className="label" htmlFor="mockup-bundle">
          {t('mockup.upload.label')}
        </label>
        <input
          id="mockup-bundle"
          ref={input}
          className="input"
          type="file"
          accept={MOCKUP_BUNDLE_ACCEPT}
          data-testid="mockup-bundle-input"
          disabled={busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <p className="t-caption desk-muted">{t('mockup.upload.help')}</p>
        {progress !== null ? (
          <div className="mockup-progress" data-testid="mockup-progress">
            <progress max={1} value={progress} aria-label={t('mockup.upload.progress')} />
            <span className="t-caption num-latin">{Math.round(progress * 100)}%</span>
          </div>
        ) : null}
      </div>

      {uploaded ? (
        <form className="card editor-card auth-form" onSubmit={onDeclare} data-testid="mockup-declare-form">
          <p className="t-small">{t('mockup.declare.uploaded', { name: uploaded.name })}</p>
          {openItems.length > 0 ? <p className="t-caption">{t('mockup.declare.fates', { count: openItems.length, n: formatCount(openItems.length, locale) })}</p> : null}
          {openItems.map((item) => {
            const fate = fateOf(item.id);
            return (
              <div className="mockup-fate" key={item.id} data-testid="mockup-fate">
                <p className="t-small">
                  <span className="t-eyebrow">{itemLabel(item, locale, t)}</span> — {item.comments.find((c) => c.resolution === null)?.body ?? ''}
                </p>
                <div className="workspace-row">
                  <select
                    className="input"
                    aria-label={t('mockup.declare.outcome')}
                    value={fate.outcome}
                    onChange={(e) => setFates((f) => ({ ...f, [item.id]: { ...fateOf(item.id), outcome: e.target.value as BuildChangeOutcome } }))}
                  >
                    <option value="ADDRESSED">{t('mockup.declare.ADDRESSED')}</option>
                    <option value="DECLINED">{t('mockup.declare.DECLINED')}</option>
                    <option value="CARRIED_FORWARD">{t('mockup.declare.CARRIED_FORWARD')}</option>
                  </select>
                  <input
                    className="input"
                    aria-label={t('mockup.declare.note')}
                    placeholder={fate.outcome === 'DECLINED' ? t('mockup.declare.reason') : t('mockup.declare.note')}
                    value={fate.note}
                    onChange={(e) => setFates((f) => ({ ...f, [item.id]: { ...fateOf(item.id), note: e.target.value } }))}
                  />
                </div>
              </div>
            );
          })}
          <div className="field">
            <label className="label" htmlFor="mockup-unprompted">
              {t('mockup.declare.unprompted')}
            </label>
            <input id="mockup-unprompted" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="workspace-row">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy} data-testid="mockup-declare">
              {t('mockup.declare.action')}
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="error" role="alert" data-testid="mockup-author-error">
          {error}
        </p>
      ) : null}

      {drafts.length > 0 ? (
        <div className="mockup-drafts" data-testid="mockup-drafts">
          <p className="t-eyebrow">{t('mockup.drafts.title')}</p>
          {drafts.map((b) => (
            <div className="workspace-row" key={b.id} data-testid="mockup-draft">
              <span className="t-small">{t('mockup.drafts.line', { number: b.number })}</span>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                disabled={busy}
                data-testid="mockup-publish"
                onClick={async () => {
                  if (await act(() => publish({ variables: { buildId: b.id } }))) onChanged();
                }}
              >
                {t('mockup.drafts.publish')}
              </button>
            </div>
          ))}
          {exhausted ? <p className="t-caption req-notice">{t('mockup.drafts.exhausted')}</p> : null}
        </div>
      ) : null}

      <PageMapping demo={demo} locked={locked} onChanged={onChanged} />

      {builds.some((b) => b.changes.length > 0) ? (
        <div className="mockup-ledger" data-testid="mockup-ledger">
          <p className="t-eyebrow">{t('mockup.ledger.title')}</p>
          {builds
            .filter((b) => b.changes.length > 0)
            .map((b) => (
              <div key={b.id}>
                <p className="t-small">{t('mockup.ledger.build', { number: b.number })}</p>
                <ul>
                  {b.changes.map((c) => (
                    <li key={c.id} className="t-caption">
                      {c.outcome ? t(`mockup.declare.${c.outcome}`) : t('mockup.ledger.unprompted')}
                      {c.feedbackItem ? ` · ${c.feedbackItem.general ? t('feedback.generalTitle') : c.feedbackItem.demoPage ? pick(c.feedbackItem.demoPage, 'label', locale) : ''}` : ''}
                      {c.note ? ` — ${c.note}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
