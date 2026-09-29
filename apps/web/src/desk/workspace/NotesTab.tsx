import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { ADD_INTERNAL_NOTE } from '@/lib/queries';
import { clockTime, initialOf, relativeTime } from '@/lib/format';
import type { WorkspaceContext } from './ContractWorkspace';

/**
 * Root's private notes on a contract (journeys build plan J3): staff talk to
 * staff here, oldest first, with a composer under the thread.
 *
 * **No customer ever reads these** — not the owner, and not staff looking as
 * one: the API returns `internalNotes: []` to anyone but a contract reader, so
 * this tab is the only place they render, and the text on it says so. The
 * mutation returns the whole workspace contract, so the list updates from the
 * cache without a refetch, like every other tab. Any staff reader who can see
 * the contract may add a note — a designer's hand-over to the developer is the
 * case — so there is no capability gate here beyond the workspace's own.
 */
export default function NotesTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract, me } = useOutletContext<WorkspaceContext>();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [add, { loading }] = useMutation(ADD_INTERNAL_NOTE);
  const notes = contract.internalNotes ?? [];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setError(null);
    try {
      await add({ variables: { contractId: contract.id, body } });
      setBody('');
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]
        ?.extensions?.code;
      setError(code ? t(`notes.errors.${code}`, { defaultValue: (err as Error).message }) : (err as Error).message);
    }
  }

  return (
    <section className="card notes" data-testid="internal-notes">
      <h3 className="t-h3">{t('notes.title')}</h3>
      <p className="t-small desk-muted">{t('notes.help')}</p>

      {notes.length === 0 ? (
        <p className="t-small desk-muted">{t('notes.empty')}</p>
      ) : (
        <div className="workspace-comments">
          {notes.map((n) => (
            <div className="comment" key={n.id} data-testid="internal-note">
              <span className={`avatar-sm ${n.author.id === me.id ? 'av-you' : 'av-root'}`} aria-hidden="true">
                {initialOf(n.author.name)}
              </span>
              <div className="comment-body">
                <div className="comment-meta">
                  <span className="comment-who">{n.author.name}</span>
                  <span className="comment-when">
                    {relativeTime(n.createdAt, locale)} · {clockTime(n.createdAt, locale)}
                  </span>
                </div>
                <div className="comment-text">{n.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <form className="comment-form" onSubmit={onSubmit}>
        <textarea
          className="textarea"
          aria-label={t('notes.title')}
          placeholder={t('notes.placeholder')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !body.trim()}>
          {t('notes.cta')}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
