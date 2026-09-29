import { useState, type FormEvent } from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
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

  const [phone, setPhone] = useState('');
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
      const res = await invite({
        variables: { phone, name, clientName: clientName || null, email: email || null },
      });
      setInviteUrl(res.data.inviteCustomer.inviteUrl);
      setPhone('');
      setEmail('');
      setName('');
      setClientName('');
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })
        .graphQLErrors?.[0]?.extensions?.code;
      setError(code === 'PHONE_INVALID' ? t('desk.invitePhoneInvalid') : (err as Error).message);
    }
  }

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.invitesTitle')}</h2>

      <section className="card">
        <form className="auth-form" onSubmit={onInvite}>
          <div className="field">
            <label className="label" htmlFor="i-phone">
              {t('desk.invitePhone')}
            </label>
            <input
              id="i-phone"
              className="input"
              type="tel"
              dir="ltr"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="i-email">
              {t('desk.inviteEmail')}
            </label>
            <input
              id="i-email"
              className="input"
              type="email"
              dir="ltr"
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
                <th>{t('desk.invitePhone')}</th>
                <th>{t('desk.inviteEmail')}</th>
                <th>{t('desk.inviteClient')}</th>
                <th>{t('desk.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.allCustomers ?? []).map((c) => (
                <tr key={c.id}>
                  {/* Journeys build plan S3: the name opens the customer's page. */}
                  <td>
                    <Link to={lp(locale, `/desk/customers/${c.id}`)}>{c.name}</Link>
                  </td>
                  <td dir="ltr">{c.phone ?? '—'}</td>
                  <td dir="ltr">{c.email ?? '—'}</td>
                  <td>{c.clientName ?? '—'}</td>
                  <td>
                    <span className={c.state === 'DISABLED' ? 'badge badge-danger' : 'badge badge-neutral'}>
                      {t(`desk.people.state.${c.state}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
