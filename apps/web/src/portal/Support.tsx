import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  MY_TICKETS,
  CREATE_TICKET,
  ADD_TICKET_MESSAGE,
  type Ticket,
  type TicketType,
  type TicketUrgency,
  type User,
} from '@/lib/queries';
import { clockTime, initialOf, relativeTime } from '@/lib/format';
import Topbar from './Topbar';

/**
 * The portal's `support` rail item, going live (build plan L4; spec §5 —
 * "support tickets… the retention hook"). Customer-authored types only —
 * ADMIN_REQUEST is staff's own classification, applied via moveTicketChannel
 * once a ticket is recognized as one (lib/ticket.ts's canChooseTicketType).
 */
const CUSTOMER_TYPES: TicketType[] = ['CHANGE_REQUEST', 'BUG', 'QUESTION'];

type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code) return t(`support.error.${code}`, { defaultValue: (err as Error).message });
  return (err as { message?: string })?.message ?? String(err);
}

function TicketCard({ ticket, me }: { ticket: Ticket; me: User }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [addMessage, { loading }] = useMutation(ADD_TICKET_MESSAGE);

  async function onReply(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    await addMessage({ variables: { ticketId: ticket.id, body: body.trim() } });
    setBody('');
  }

  const hasBrief = ticket.briefCurrentState !== null && ticket.briefDesiredState !== null;

  return (
    <div className="card editor-card">
      <button type="button" className="workspace-row" style={{ width: '100%', textAlign: 'start' }} onClick={() => setOpen((v) => !v)}>
        <span className={`badge ticket-status-${ticket.status.toLowerCase()}`}>{t(`support.status.${ticket.status}`)}</span>
        <span className="badge">{t(`support.type.${ticket.type}`)}</span>
        <span className="t-small" style={{ flex: 1 }}>
          {ticket.subject}
        </span>
        <span className="t-caption muted">{relativeTime(ticket.updatedAt, locale)}</span>
      </button>

      {open ? (
        <>
          {hasBrief ? (
            <div className="feedback-thread">
              <p className="t-eyebrow">{t('support.briefTitle')}</p>
              {ticket.briefPageFa || ticket.briefPageEn ? (
                <p className="t-small">
                  <strong>{t('support.briefPage')}:</strong> {locale === 'fa' ? ticket.briefPageFa : ticket.briefPageEn}
                </p>
              ) : null}
              <p className="t-small">
                <strong>{t('support.briefCurrentState')}:</strong> {ticket.briefCurrentState}
              </p>
              <p className="t-small">
                <strong>{t('support.briefDesiredState')}:</strong> {ticket.briefDesiredState}
              </p>
              {ticket.briefAnnotation ? (
                <p className="t-small feedback-comment">
                  <strong>{t('support.briefAnnotation')}:</strong> {ticket.briefAnnotation}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="thread">
            {ticket.messages.map((m) => {
              const mine = m.author.id === me.id;
              return (
                <div className="comment" key={m.id}>
                  <span className={`avatar-sm ${mine ? 'av-you' : 'av-root'}`} aria-hidden="true">
                    {initialOf(m.author.name)}
                  </span>
                  <div className="comment-body">
                    <div className="comment-meta">
                      <span className="comment-who">{mine ? t('detail.you') : m.author.name}</span>
                      <span className="comment-when">
                        {relativeTime(m.createdAt, locale)} · {clockTime(m.createdAt, locale)}
                      </span>
                    </div>
                    <div className="comment-text">{m.body}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <form className="comment-form" onSubmit={onReply}>
            <textarea className="textarea" placeholder={t('support.replyPlaceholder')} value={body} onChange={(e) => setBody(e.target.value)} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !body.trim()}>
              {t('support.reply')}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

export default function Support() {
  const { t } = useTranslation();
  const me = useOutletContext<User>();

  const { data, loading, error, refetch } = useQuery<{ myTickets: Ticket[] }>(MY_TICKETS);
  const [createTicket, { loading: creating }] = useMutation(CREATE_TICKET);

  const [type, setType] = useState<TicketType>('QUESTION');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [urgency, setUrgency] = useState<TicketUrgency>('NOT_URGENT');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!subject.trim() || !body.trim()) return;
    try {
      await createTicket({ variables: { type, subject: subject.trim(), body: body.trim(), urgency } });
      setSubject('');
      setBody('');
      setAdding(false);
    } catch (err) {
      setFormError(errorMessage(err, t));
    }
  }

  const tickets = data?.myTickets ?? [];

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{t('portal.navSupport')}</h1>} />
      <div className="content">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('support.pageTitle')}</h1>
            <p className="t-lead">{t('support.pageLede')}</p>
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setAdding((v) => !v)}>
            {t('support.newTicket')}
          </button>
        </div>

        {adding ? (
          <form className="card editor-card auth-form" onSubmit={onCreate}>
            <div className="editor-grid-2">
              <div className="field">
                <label className="label">{t('support.type.label')}</label>
                <select className="input" value={type} onChange={(e) => setType(e.target.value as TicketType)}>
                  {CUSTOMER_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`support.type.${ty}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label">{t('support.urgency.label')}</label>
                <select className="input" value={urgency} onChange={(e) => setUrgency(e.target.value as TicketUrgency)}>
                  <option value="NOT_URGENT">{t('support.urgency.NOT_URGENT')}</option>
                  <option value="URGENT">{t('support.urgency.URGENT')}</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label className="label">{t('support.subjectLabel')}</label>
              <input className="input" required value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('support.bodyLabel')}</label>
              <textarea className="input" rows={3} required value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            {formError ? <p className="error">{formError}</p> : null}
            <div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
                {t('support.submit')}
              </button>
            </div>
          </form>
        ) : null}

        {error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading && tickets.length === 0 ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : tickets.length === 0 ? (
          <div className="empty">{t('support.empty')}</div>
        ) : (
          <div className="editor-list">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} me={me} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
