import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import {
  ALL_CONTRACTS,
  ALL_CUSTOMERS,
  INVITE_CUSTOMER,
  ME,
  PUBLISH_CONTRACT,
  SET_CONTRACT_STATUS,
  type Contract,
  type ContractStatus,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, fullDateTime, pick } from '@/lib/format';
import LangSwitch from '@/components/LangSwitch';

/**
 * The thin operational admin from v3 §4 — deliberately unstyled. It exists so
 * nobody has to hand-edit the database for a live client. The real admin
 * dashboard (review-flagging queue, overviews, analytics) comes later.
 *
 * Covered here: invites, and the contract actions that drive Phase 1. Billing
 * entry and ticket replies land with Phase 2, when those surfaces exist.
 */
export default function Admin() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data: meData, loading: meLoading } = useQuery<{ me: User | null }>(ME);

  const isAdmin = meData?.me?.role === 'ADMIN';
  const { data: customers } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, { skip: !isAdmin });
  const { data: contracts } = useQuery<{ allContracts: Contract[] }>(ALL_CONTRACTS, {
    skip: !isAdmin,
  });

  const [invite] = useMutation(INVITE_CUSTOMER, { refetchQueries: [{ query: ALL_CUSTOMERS }] });
  const [publish] = useMutation(PUBLISH_CONTRACT);
  const [setStatus] = useMutation(SET_CONTRACT_STATUS);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (meLoading) return <div className="content">{t('portal.loading')}</div>;
  if (!isAdmin) return <Navigate to={lp(locale, '/portal')} replace />;

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInviteUrl(null);
    try {
      const res = await invite({ variables: { email, name, clientName: clientName || null } });
      setInviteUrl(res.data.inviteCustomer.inviteUrl);
      setEmail('');
      setName('');
      setClientName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="root-ui" style={{ padding: 'var(--space-8)', minBlockSize: '100vh' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-6)',
          marginBlockEnd: 'var(--space-8)',
        }}
      >
        <h1 className="t-h2" style={{ margin: 0 }}>
          {t('portal.navAdmin')}
        </h1>
        <LangSwitch />
      </header>

      {/* ---- Invites ---- */}
      <section className="card" style={{ marginBlockEnd: 'var(--space-8)' }}>
        <h2 className="t-h3" style={{ margin: 0 }}>
          Invites
        </h2>
        <form className="auth-form" onSubmit={onInvite}>
          <div className="field">
            <label className="label" htmlFor="i-email">
              Email
            </label>
            <input
              id="i-email"
              className="input"
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="i-name">
              Name
            </label>
            <input
              id="i-name"
              className="input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="i-client">
              Client / company
            </label>
            <input
              id="i-client"
              className="input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
            />
          </div>
          <div>
            <button className="btn btn-primary btn-sm" type="submit">
              Generate invite link
            </button>
          </div>
        </form>

        {error ? <p className="auth-error">{error}</p> : null}
        {inviteUrl ? (
          <div className="auth-notice">
            {/* Shown once. There is no way to read it again — issue a new
                invite if it gets lost. */}
            <p style={{ margin: '0 0 var(--space-2)' }}>
              Copy this now — it is shown once:
            </p>
            <code style={{ wordBreak: 'break-all' }} dir="ltr">
              {inviteUrl}
            </code>
          </div>
        ) : null}

        <table className="ctable" style={{ marginBlockStart: 'var(--space-4)' }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {(customers?.allCustomers ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td dir="ltr">{c.email}</td>
                <td>{c.clientName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---- Contracts ---- */}
      <section className="card">
        <h2 className="t-h3" style={{ margin: 0 }}>
          Contracts
        </h2>
        <table className="ctable">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Title</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Published</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(contracts?.allContracts ?? []).map((c) => (
              <tr key={c.id}>
                <td dir="ltr">{c.ref}</td>
                <td>{pick(c, 'title', locale)}</td>
                <td>{c.customer.clientName ?? c.customer.name}</td>
                <td>
                  {/* Permissive by design: any status to any status, with a
                      manual override always available. */}
                  <select
                    className="select"
                    value={c.status}
                    onChange={(e) =>
                      setStatus({
                        variables: {
                          contractId: c.id,
                          status: e.target.value as ContractStatus,
                        },
                      })
                    }
                  >
                    {ALL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`status.${s}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{c.updatedAt ? fullDateTime(c.updatedAt, locale) : '—'}</td>
                <td>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => publish({ variables: { contractId: c.id } })}
                  >
                    Publish
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="help">
          Creating a contract, uploading concepts and page designs, and entering the article text
          run through the GraphQL mutations directly for now — see the README.
        </p>
      </section>
    </div>
  );
}
