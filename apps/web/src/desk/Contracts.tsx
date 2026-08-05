import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ALL_CONTRACTS,
  ALL_CUSTOMERS,
  CREATE_CONTRACT,
  PUBLISH_CONTRACT,
  SET_CONTRACT_STATUS,
  type Contract,
  type ContractStatus,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, fullDateTime, pick } from '@/lib/format';

export default function DeskContracts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();

  const { data } = useQuery<{ allContracts: Contract[] }>(ALL_CONTRACTS, {
    skip: !can(me, 'contracts.manage'),
  });
  const { data: customers } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, {
    skip: !can(me, 'customers.manage'),
  });
  const [publish] = useMutation(PUBLISH_CONTRACT);
  const [setStatus] = useMutation(SET_CONTRACT_STATUS);
  const [createContract, { loading: creating }] = useMutation(CREATE_CONTRACT, {
    refetchQueries: [{ query: ALL_CONTRACTS }],
  });

  const [showNew, setShowNew] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [ref, setRef] = useState('');
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!can(me, 'contracts.manage')) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await createContract({
        variables: { input: { customerId, ref, titleFa, titleEn } },
      });
      const id = res.data?.createContract.id;
      if (id) navigate(lp(locale, `/desk/contracts/${id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="desk-section">
      <div className="workspace-row">
        <h2 className="t-h2">{t('desk.navContracts')}</h2>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setShowNew((v) => !v)}>
          {t('desk.newContract')}
        </button>
      </div>

      {showNew ? (
        <section className="card">
          <form className="auth-form" onSubmit={onCreate}>
            <div className="editor-grid-2">
              <div className="field">
                <label className="label" htmlFor="nc-customer">
                  {t('desk.colCustomer')}
                </label>
                <select
                  id="nc-customer"
                  className="select"
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="" disabled>
                    {t('desk.newContractPickCustomer')}
                  </option>
                  {(customers?.allCustomers ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.clientName ?? c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="nc-ref">
                  {t('desk.colRef')}
                </label>
                <input
                  id="nc-ref"
                  className="input"
                  dir="ltr"
                  required
                  placeholder="RC-2026-015"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </div>
            </div>
            <div className="editor-grid-2">
              <div className="field">
                <label className="label" htmlFor="nc-fa">
                  {t('desk.newContractTitleFa')}
                </label>
                <input
                  id="nc-fa"
                  className="input"
                  dir="rtl"
                  required
                  value={titleFa}
                  onChange={(e) => setTitleFa(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="nc-en">
                  {t('desk.newContractTitleEn')}
                </label>
                <input
                  id="nc-en"
                  className="input"
                  dir="ltr"
                  required
                  value={titleEn}
                  onChange={(e) => setTitleEn(e.target.value)}
                />
              </div>
            </div>
            {error ? <p className="error">{error}</p> : null}
            <div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
                {t('desk.newContractCta')}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <div className="table-wrap">
        <table className="ctable">
          <thead>
            <tr>
              <th>{t('desk.colRef')}</th>
              <th>{t('desk.colTitle')}</th>
              <th>{t('desk.colCustomer')}</th>
              <th>{t('desk.colStatus')}</th>
              <th>{t('desk.colUpdated')}</th>
              {/* D4: this used to show updatedAt under a "Published" heading.
                  Now it is the real publishedAt, and "—" is an honest answer
                  for a contract that has not been handed over yet. */}
              <th>{t('desk.colPublished')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.allContracts ?? []).map((c) => (
              <tr
                key={c.id}
                className="crow"
                onClick={() => navigate(lp(locale, `/desk/contracts/${c.id}`))}
              >
                <td dir="ltr">{c.ref}</td>
                <td>{pick(c, 'title', locale)}</td>
                <td>{c.customer.clientName ?? c.customer.name}</td>
                <td onClick={(e) => e.stopPropagation()}>
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
                <td>{fullDateTime(c.updatedAt, locale)}</td>
                <td>{c.publishedAt ? fullDateTime(c.publishedAt, locale) : '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => publish({ variables: { contractId: c.id } })}
                  >
                    {t('desk.publish')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
