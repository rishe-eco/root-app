import { useState } from 'react';
import { Link, Navigate, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  CUSTOMER_PROFILE,
  GRANT_TOOL,
  REVOKE_TOOL,
  SET_USER_STATE,
  type CustomerProfile,
  type ToolKey,
  type User,
} from '@/lib/queries';
import { formatAmount, fullDateTime, pick } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import { peopleError } from './peopleErrors';

/**
 * One customer, on one page (journeys build plan S3): who they are, whether
 * their account is on, which tools they hold, and their contracts, tickets and
 * billing. `customers.manage`.
 *
 * Three parts answer to rules of their own and are simply absent when the
 * server withholds them — tickets (`tickets.answer`), the billing summary
 * (`money.read`; `invoices` is null, not zero) and contracts (only those the
 * viewer may see). This page shows what came back rather than deciding.
 *
 * Disabling is offered whatever the account holds. An account that also holds
 * a staff role needs `staff.manage`, and the client does not read roles to
 * predict that (house rule 1): the API refuses, and the refusal says why.
 */

/** The tools that exist. A second one is a value here and a panel in the portal. */
const TOOLS: ToolKey[] = ['PRODUCT_IMPORT'];

export default function CustomerDetail() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id } = useParams();
  const allowed = can(me, 'customers.manage');

  const { data, loading } = useQuery<{ customer: CustomerProfile | null }>(CUSTOMER_PROFILE, {
    variables: { id },
    skip: !allowed || !id,
  });
  const [setState, { loading: stateBusy }] = useMutation(SET_USER_STATE);
  const [grant, { loading: grantBusy }] = useMutation(GRANT_TOOL);
  const [revoke, { loading: revokeBusy }] = useMutation(REVOKE_TOOL);
  const [error, setError] = useState<string | null>(null);

  if (!allowed) return <Navigate to={lp(locale, '/desk')} replace />;

  const back = (
    <Link className="t-small" to={lp(locale, '/desk/customers')}>
      {t('desk.people.customer.back')}
    </Link>
  );

  if (loading && !data) return <p className="t-small">{t('portal.loading')}</p>;

  const profile = data?.customer ?? null;
  if (!profile) {
    return (
      <div className="desk-section">
        {back}
        <div className="empty">{t('desk.people.customer.notFound')}</div>
      </div>
    );
  }

  const { user, grants, contracts, tickets, invoices } = profile;
  const disabled = user.state === 'DISABLED';

  async function onToggleState() {
    const message = disabled
      ? t('desk.people.customer.restoreConfirm', { name: user.name })
      : t('desk.people.customer.disableConfirm', { name: user.name });
    if (!confirm(message)) return;
    setError(null);
    try {
      await setState({ variables: { userId: user.id, state: disabled ? 'ACTIVE' : 'DISABLED' } });
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  async function onTool(tool: ToolKey, granted: boolean) {
    if (granted && !confirm(t('desk.people.customer.revokeConfirm', { tool: t(`desk.people.tool.${tool}`), name: user.name }))) {
      return;
    }
    setError(null);
    try {
      await (granted ? revoke : grant)({ variables: { customerId: user.id, tool } });
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  return (
    <div className="desk-section">
      {back}

      <section className="card">
        <div className="workspace-row">
          <div>
            <h2 className="t-h2">{user.name}</h2>
            {user.clientName ? <p className="t-small desk-muted">{user.clientName}</p> : null}
          </div>
          <div className="editor-card-actions">
            <span className={disabled ? 'badge badge-danger' : 'badge badge-neutral'}>
              {t(`desk.people.state.${user.state}`)}
            </span>
            <button className="btn btn-secondary btn-sm" type="button" disabled={stateBusy} onClick={onToggleState}>
              {disabled ? t('desk.people.customer.restore') : t('desk.people.customer.disable')}
            </button>
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}

        <dl className="people-facts">
          <dt>{t('desk.invitePhone')}</dt>
          <dd dir="ltr">{user.phone ?? '—'}</dd>
          <dt>{t('desk.people.customer.email')}</dt>
          <dd dir="ltr">{user.email ?? '—'}</dd>
        </dl>
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.people.customer.toolsTitle')}</h3>
        <p className="t-small desk-muted">{t('desk.people.customer.toolsLede')}</p>
        <div className="editor-list">
          {TOOLS.map((tool) => {
            const held = grants.find((g) => g.tool === tool);
            return (
              <div className="workspace-row" key={tool}>
                <div>
                  <span>{t(`desk.people.tool.${tool}`)}</span>{' '}
                  <span className={held ? 'badge' : 'badge badge-neutral'}>
                    {held ? t('desk.people.customer.toolGranted') : t('desk.people.customer.toolNotGranted')}
                  </span>
                  {held ? (
                    <p className="t-caption desk-muted">
                      {t('desk.people.customer.grantedBy', {
                        name: held.grantedBy.name,
                        date: fullDateTime(held.grantedAt, locale),
                      })}
                    </p>
                  ) : null}
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={grantBusy || revokeBusy}
                  onClick={() => onTool(tool, Boolean(held))}
                >
                  {held ? t('desk.people.customer.revoke') : t('desk.people.customer.grant')}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.people.customer.contractsTitle')}</h3>
        {contracts.length === 0 ? (
          <p className="t-small">{t('desk.people.customer.noContracts')}</p>
        ) : (
          <div className="table-wrap">
            <table className="ctable">
              <thead>
                <tr>
                  <th>{t('desk.colRef')}</th>
                  <th>{t('desk.colTitle')}</th>
                  <th>{t('desk.colStatus')}</th>
                  <th>{t('desk.people.customer.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td dir="ltr">
                      <Link to={lp(locale, `/desk/contracts/${c.id}`)}>{c.ref}</Link>
                    </td>
                    <td>{pick(c, 'title', locale)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{formatAmount(c.amount, locale) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.people.customer.ticketsTitle')}</h3>
        {tickets.length === 0 ? (
          <p className="t-small">{t('desk.people.customer.noTickets')}</p>
        ) : (
          <div className="table-wrap">
            <table className="ctable">
              <tbody>
                {tickets.map((k) => (
                  <tr key={k.id}>
                    <td>{k.subject}</td>
                    <td>{t(`support.status.${k.status}`)}</td>
                    <td className="t-caption desk-muted">{fullDateTime(k.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.people.customer.billingTitle')}</h3>
        {invoices ? (
          <div className="tile-row">
            <div className="tile">
              <span className="tile-count">{formatAmount(invoices.totalIssued, locale)}</span>
              <span className="tile-label">{t('billing.totalIssued')}</span>
            </div>
            <div className="tile">
              <span className="tile-count">{formatAmount(invoices.totalPaid, locale)}</span>
              <span className="tile-label">{t('billing.totalPaid')}</span>
            </div>
            <div className="tile">
              <span className="tile-count">{formatAmount(invoices.totalOutstanding, locale)}</span>
              <span className="tile-label">{t('billing.totalOutstanding')}</span>
            </div>
          </div>
        ) : (
          <p className="t-small desk-muted">{t('desk.people.customer.moneyHidden')}</p>
        )}
      </section>
    </div>
  );
}
