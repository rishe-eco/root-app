import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  ALL_TICKETS,
  ADMIN_REQUEST_COUNT,
  ADD_TICKET_MESSAGE,
  SET_TICKET_STATUS,
  SET_TICKET_URGENCY,
  SET_TICKET_BILLABLE,
  MOVE_TICKET_CHANNEL,
  type Ticket,
  type TicketType,
  type TicketStatus,
  type User,
} from '@/lib/queries';
import { formatCount, initialOf, relativeTime, clockTime, pick } from '@/lib/format';

/**
 * The support desk (build plan L4; spec §5) — every ticket, the channel-move
 * action, and the ADMIN_REQUEST counter (§10.2's demand signal, made real
 * and queryable rather than left as a feeling). Gated on `contracts.manage`
 * (`desk/sections.ts`'s own comment on why).
 */

const ALL_TYPES: TicketType[] = ['CHANGE_REQUEST', 'BUG', 'QUESTION', 'ADMIN_REQUEST'];
const ALL_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

type TypeFilter = TicketType | 'ALL';
type StatusFilter = TicketStatus | 'ALL';

function TicketRow({ ticket, me }: { ticket: Ticket; me: User }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [addMessage, { loading: replying }] = useMutation(ADD_TICKET_MESSAGE);
  const [setStatus] = useMutation(SET_TICKET_STATUS);
  const [setUrgency] = useMutation(SET_TICKET_URGENCY);
  const [setBillable] = useMutation(SET_TICKET_BILLABLE);
  const [moveChannel] = useMutation(MOVE_TICKET_CHANNEL);

  const hasBrief = ticket.briefCurrentState !== null && ticket.briefDesiredState !== null;

  async function onReply() {
    if (!body.trim()) return;
    await addMessage({ variables: { ticketId: ticket.id, body: body.trim() } });
    setBody('');
  }

  return (
    <div className="card editor-card">
      <button
        type="button"
        className="workspace-row"
        style={{ width: '100%', textAlign: 'start' }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`badge ticket-status-${ticket.status.toLowerCase()}`}>{t(`support.status.${ticket.status}`)}</span>
        <span className="badge">{t(`support.type.${ticket.type}`)}</span>
        {ticket.urgency === 'URGENT' ? <span className="badge">{t('support.urgency.URGENT')}</span> : null}
        <span className="t-small" style={{ flex: 1 }}>
          {ticket.subject}
        </span>
        <span className="t-caption">{ticket.customer.clientName ?? ticket.customer.name}</span>
        {ticket.project ? <span className="t-caption">{pick(ticket.project, 'title', locale)}</span> : null}
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

          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('desk.tickets.statusLabel')}</label>
              <select className="input" value={ticket.status} onChange={(e) => setStatus({ variables: { ticketId: ticket.id, status: e.target.value } })}>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`support.status.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">{t('desk.tickets.urgencyLabel')}</label>
              <select className="input" value={ticket.urgency} onChange={(e) => setUrgency({ variables: { ticketId: ticket.id, urgency: e.target.value } })}>
                <option value="NOT_URGENT">{t('support.urgency.NOT_URGENT')}</option>
                <option value="URGENT">{t('support.urgency.URGENT')}</option>
              </select>
            </div>
            <div className="field">
              {/* Build plan L4: moving a ticket between channels is its own
                  action, not a side effect of some other edit — a distinct
                  control, even though it writes the same `type` column. */}
              <label className="label">{t('desk.tickets.moveChannelLabel')}</label>
              <select className="input" value={ticket.type} onChange={(e) => moveChannel({ variables: { ticketId: ticket.id, type: e.target.value } })}>
                {ALL_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`support.type.${ty}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="badge">
                <input
                  type="checkbox"
                  checked={ticket.billable}
                  onChange={(e) => setBillable({ variables: { ticketId: ticket.id, billable: e.target.checked } })}
                />
                {t('desk.tickets.billable')}
              </label>
            </div>
          </div>

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

          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              onReply();
            }}
          >
            <textarea className="textarea" placeholder={t('support.replyPlaceholder')} value={body} onChange={(e) => setBody(e.target.value)} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={replying || !body.trim()}>
              {t('support.reply')}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

export default function Tickets() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  const { data, loading, error, refetch } = useQuery<{ allTickets: Ticket[] }>(ALL_TICKETS, {
    variables: {
      status: statusFilter === 'ALL' ? null : statusFilter,
      type: typeFilter === 'ALL' ? null : typeFilter,
    },
  });
  const { data: countData } = useQuery<{ adminRequestCount: number }>(ADMIN_REQUEST_COUNT);

  const tickets = data?.allTickets ?? [];

  return (
    <div className="desk-section">
      <div className="content-head">
        <div>
          <h2 className="t-h2">{t('desk.tickets.title')}</h2>
          <p className="t-lead">{t('desk.tickets.lede')}</p>
        </div>
        {/* Build plan L4, spec §10.2: the counter is the only input to the
            parked decision on whether site administration becomes a
            product — shown here as a real number, not a feeling. */}
        <div className="tile">
          <span className="tile-count">{formatCount(countData?.adminRequestCount ?? 0, locale)}</span>
          <span className="tile-label">{t('desk.tickets.adminRequestCount')}</span>
        </div>
      </div>

      <div className="chips">
        {(['ALL', ...ALL_STATUSES] as StatusFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`chip${statusFilter === s ? ' chip-active' : ''}`}
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
          >
            {s === 'ALL' ? t('support.status.ALL') : t(`support.status.${s}`)}
          </button>
        ))}
      </div>
      <div className="chips">
        {(['ALL', ...ALL_TYPES] as TypeFilter[]).map((ty) => (
          <button
            key={ty}
            type="button"
            className={`chip${typeFilter === ty ? ' chip-active' : ''}`}
            onClick={() => setTypeFilter(ty)}
            aria-pressed={typeFilter === ty}
          >
            {ty === 'ALL' ? t('support.type.ALL') : t(`support.type.${ty}`)}
          </button>
        ))}
      </div>

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
        <div className="empty">{t('desk.tickets.empty')}</div>
      ) : (
        <div className="editor-list">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} me={me} />
          ))}
        </div>
      )}
    </div>
  );
}
