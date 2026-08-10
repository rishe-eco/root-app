import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { ALL_CUSTOMERS, INVITE_CUSTOMER, type User } from '@/lib/queries';

export default function Customers() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const { data } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, {
    skip: !can(me, 'customers.manage'),
  });
  const [invite] = useMutation(INVITE_CUSTOMER, { refetchQueries: [{ query: ALL_CUSTOMERS }] });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!can(me, 'customers.manage')) return <Navigate to={lp(locale, '/desk')} replace />;

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
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.invitesTitle')}</h2>

      <section className="card">
        <form className="auth-form" onSubmit={onInvite}>
          <div className="field">
            <label className="label" htmlFor="i-email">
              {t('desk.inviteEmail')}
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
              {t('desk.inviteName')}
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
              {t('desk.inviteClient')}
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
              {t('desk.inviteCta')}
            </button>
          </div>
        </form>

        {error ? <p className="error">{error}</p> : null}
        {inviteUrl ? (
          <div className="auth-notice">
            <p className="t-small">{t('desk.inviteOnce')}</p>
            <code className="desk-code" dir="ltr">
              {inviteUrl}
            </code>
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="ctable">
            <thead>
              <tr>
                <th>{t('desk.inviteName')}</th>
                <th>{t('desk.inviteEmail')}</th>
                <th>{t('desk.inviteClient')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.allCustomers ?? []).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td dir="ltr">{c.email}</td>
                  <td>{c.clientName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
