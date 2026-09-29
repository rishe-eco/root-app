import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { POST_REQUEST_MESSAGE, type Request } from '@/lib/queries';
import { clockTime, initialOf, relativeTime } from '@/lib/format';

/**
 * A request's conversation (journeys build plan J2) — the customer's opening
 * words first, then every message, oldest first, then (only while the request
 * is pending) a composer.
 *
 * One component for the three places a thread appears: the portal's drawer,
 * the desk's request page, and the read-only copy on a converted contract.
 * They differ only in `canPost`; a thread that is not pending never shows a
 * composer whatever `canPost` says, because the API would refuse it
 * (`REQUEST_CLOSED`) and a control that can only fail is a worse answer than
 * a sentence saying why.
 *
 * The message list comes from the mutation's own payload (`postRequestMessage`
 * returns the whole `Request`), so Apollo's cache updates it without a
 * refetch. Reading what the *other* side wrote is the caller's job — the
 * drawer refetches on open and on window focus.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A refusal's code, turned into the user's language (house rule 6). */
export function requestErrorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code) return t(`requests.error.${code}`, { defaultValue: (err as Error).message });
  return (err as { message?: string })?.message ?? String(err);
}

export default function RequestThread({
  request,
  meId,
  canPost,
}: {
  request: Request;
  meId: string;
  canPost: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [post, { loading }] = useMutation(POST_REQUEST_MESSAGE);

  async function onPost(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setError(null);
    try {
      await post({ variables: { projectId: request.id, body: body.trim() } });
      setBody('');
    } catch (err) {
      setError(requestErrorMessage(err, t));
    }
  }

  // The request itself opens the conversation: written by the customer, in
  // the language they wrote it in, whatever language this screen is in.
  const entries = [
    {
      id: `${request.id}:request`,
      author: request.customer,
      body: request.body,
      createdAt: request.requestedAt,
    },
    ...request.messages,
  ];

  return (
    <div className="request-thread">
      <div className="thread" data-testid="request-thread">
        {entries.map((m) => {
          const mine = m.author.id === meId;
          return (
            <div className="comment" key={m.id}>
              <span className={`avatar-sm ${mine ? 'av-you' : 'av-root'}`} aria-hidden="true">
                {initialOf(m.author.name)}
              </span>
              <div className="comment-body">
                <div className="comment-meta">
                  <span className="comment-who">{mine ? t('requests.you') : (m.author.clientName ?? m.author.name)}</span>
                  <span className="comment-when">
                    {relativeTime(m.createdAt, locale)} · {clockTime(m.createdAt, locale)}
                  </span>
                </div>
                {/* `dir="auto"`: the request may be in the other language
                    from this screen, and a message is free text. */}
                <div className="comment-text request-text" dir="auto">
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {request.status === 'REQUESTED' ? (
        canPost ? (
          <form className="comment-form" onSubmit={onPost}>
            <textarea
              className="textarea"
              aria-label={t('requests.replyPlaceholder')}
              placeholder={t('requests.replyPlaceholder')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {error ? <p className="error">{error}</p> : null}
            <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !body.trim()}>
              {t('requests.send')}
            </button>
          </form>
        ) : null
      ) : (
        <p className="t-small muted request-closed">
          {request.status === 'ARCHIVED' ? t('requests.closedArchived') : t('requests.closedConverted')}
        </p>
      )}
    </div>
  );
}
