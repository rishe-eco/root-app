import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { MY_REQUESTS, SUBMIT_REQUEST, type Request } from '@/lib/queries';
import { requestErrorMessage } from '@/components/RequestThread';

/**
 * The "New request" form (journeys build plan J2) — two fields and a send.
 * Deliberately not a wizard: a request is the first thing a customer says,
 * and everything Root needs beyond it comes out of the conversation (and,
 * later, out of step 1's requirements form — J4).
 *
 * The request is stored with the language this screen is in (`lang`), so sales
 * reads it in the language it was written in.
 */
export default function NewRequestModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (request: Request) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submit, { loading }] = useMutation<{ submitRequest: Request }>(SUBMIT_REQUEST, {
    refetchQueries: [{ query: MY_REQUESTS }],
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await submit({ variables: { title: title.trim(), body: body.trim(), lang: locale } });
      if (res.data) onSubmitted(res.data.submitRequest);
    } catch (err) {
      setError(requestErrorMessage(err, t));
    }
  }

  return (
    <div className="overlay">
      <div className="overlay-scrim" onClick={onClose} aria-hidden="true" />
      <form className="modal auth-form" role="dialog" aria-modal="true" aria-labelledby="new-request-title" onSubmit={onSubmit}>
        <div>
          <h2 className="t-h3" id="new-request-title">
            {t('requests.formTitle')}
          </h2>
          <p className="t-small muted">{t('requests.formLede')}</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="nr-title">
            {t('requests.titleLabel')}
          </label>
          <input
            id="nr-title"
            className="input"
            required
            maxLength={200}
            dir="auto"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="nr-body">
            {t('requests.bodyLabel')}
          </label>
          <textarea
            id="nr-body"
            className="textarea"
            required
            rows={6}
            maxLength={5000}
            dir="auto"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="modal-actions">
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !title.trim() || !body.trim()}>
            {loading ? t('requests.sending') : t('requests.submit')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            {t('requests.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
