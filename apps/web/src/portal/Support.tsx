import { useEffect, useState, type FormEvent } from 'react';
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

function TicketCard({ ticket, me, onToggle }: { ticket: Ticket; me: User; onToggle: () => void }) {
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
      <button type="button" className="workspace-row" style={{ width: '100%', textAlign: 'start' }} onClick={() => {
          setOpen((v) => !v);
          // Opening or closing is a moment the customer is looking at the
          // conversation: fetch the list again so an answer that arrived since
          // the page loaded is there. The card's own state (`open`, a half-typed
          // reply) lives here, keyed by ticket id, so the refetch can't reset it.
          onToggle();
        }}>
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

  const { data, previousData, loading, error, refetch } = useQuery<{ myTickets: Ticket[] }>(MY_TICKETS);
  const [createTicket, { loading: creating }] = useMutation(CREATE_TICKET);
  // True while the list is refetched after a create (see onCreate).
  const [listing, setListing] = useState(false);

  // No websocket (as RequestDrawer.tsx, J2): the list is fresh on mount, on a
  // card opening or closing, and whenever the window regains focus, which is
  // when a customer comes back from the email or SMS that said Root had answered.
  useEffect(() => {
    const refresh = () => void refetch();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetch]);

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
    } catch (err) {
      setFormError(errorMessage(err, t));
      return;
    }
    // The ticket exists now. The form closes only once it is in the list, so
    // the customer never sees a gap where they expect it. A failed refetch is
    // not a failed create: showing it as one would invite a second, duplicate
    // ticket. The next focus or card click brings the list up to date.
    setListing(true);
    await refetch().catch(() => undefined);
    setListing(false);
    setSubject('');
    setBody('');
    setAdding(false);
  }

  // The list outlives a failed refetch: a focus or a card click while the
  // network is down keeps what the customer was reading (and a half-typed
  // reply). The error panel is for a page that never got its list.
  const tickets = (data ?? previousData)?.myTickets ?? [];

  return (
    <>
      <Topbar user={me} start={<span className="crumb" />} />
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
              <button className="btn btn-primary btn-sm" type="submit" disabled={creating || listing}>
                {t('support.submit')}
              </button>
            </div>
          </form>
        ) : null}

        {tickets.length > 0 ? (
          <div className="editor-list">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} me={me} onToggle={() => void refetch()} />
            ))}
          </div>
        ) : error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : (
          <div className="empty">{t('support.empty')}</div>
        )}
      </div>
    </>
  );
}
