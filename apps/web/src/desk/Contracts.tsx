import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ALL_CONTRACTS,
  ALL_CUSTOMERS,
  ASSIGNABLE_USERS,
  CREATE_CONTRACT,
  PUBLISH_CONTRACT,
  SET_CONTRACT_STATUS,
  type Contract,
  type ContractStatus,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, fullDateTime, pick } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';

/**
 * Journeys build plan S1: the list itself answers both `contracts.readAll`
 * (sales, the whole book) and `contracts.readActive` (design, development —
 * only the contracts still being worked, filtered server-side). Authoring —
 * the new-contract form, the status control, publishing — stays
 * `contracts.author`, which today only SALES and ADMIN hold.
 */
export default function DeskContracts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();
  const canRead = can(me, 'contracts.readAll') || can(me, 'contracts.readActive');
  const canAuthor = can(me, 'contracts.author');

  const { data } = useQuery<{ allContracts: Contract[] }>(ALL_CONTRACTS, {
    skip: !canRead,
  });
  const { data: customers } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, {
    skip: !can(me, 'customers.manage'),
  });
  const { data: designers } = useQuery<{ assignableUsers: User[] }>(ASSIGNABLE_USERS, {
    variables: { job: 'DESIGN' },
    skip: !canAuthor,
  });
  const { data: developers } = useQuery<{ assignableUsers: User[] }>(ASSIGNABLE_USERS, {
    variables: { job: 'BUILD' },
    skip: !canAuthor,
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
  const [designerId, setDesignerId] = useState('');
  const [developerId, setDeveloperId] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canRead) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await createContract({
        variables: {
          input: {
            customerId,
            ref,
            titleFa,
            titleEn,
            designerId: designerId || null,
            developerId: developerId || null,
          },
        },
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
        {canAuthor ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setShowNew((v) => !v)}>
            {t('desk.newContract')}
          </button>
        ) : null}
      </div>

      {showNew && canAuthor ? (
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
            {/* Journeys build plan S1 (Q-S4): sales may pick a designer and a
                developer at creation — both optional, both fed by
                assignableUsers so this list and assignContract's own refusal
                can never disagree. */}
            <div className="editor-grid-2">
              <div className="field">
                <label className="label" htmlFor="nc-designer">
                  {t('desk.newContractDesigner')}
                </label>
                <select
                  id="nc-designer"
                  className="select"
                  value={designerId}
                  onChange={(e) => setDesignerId(e.target.value)}
                >
                  <option value="">{t('desk.newContractUnassigned')}</option>
                  {(designers?.assignableUsers ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="nc-developer">
                  {t('desk.newContractDeveloper')}
                </label>
                <select
                  id="nc-developer"
                  className="select"
                  value={developerId}
                  onChange={(e) => setDeveloperId(e.target.value)}
                >
                  <option value="">{t('desk.newContractUnassigned')}</option>
                  {(developers?.assignableUsers ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
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
                {/* The two control cells stop the row's click only when they
                    hold a control: for a reader (design, development) they
                    hold a badge or nothing, and swallowing the click there
                    made half the row dead — found by the S1 e2e. */}
                <td onClick={canAuthor ? (e) => e.stopPropagation() : undefined}>
                  {canAuthor ? (
                    // Permissive by design: any status to any status, with a
                    // manual override always available.
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
                  ) : (
                    // Design and development read the status; changing it is
                    // sales's job (setContractStatus needs contracts.author).
                    <StatusBadge status={c.status} />
                  )}
                </td>
                <td>{fullDateTime(c.updatedAt, locale)}</td>
                <td>{c.publishedAt ? fullDateTime(c.publishedAt, locale) : '—'}</td>
                <td onClick={canAuthor ? (e) => e.stopPropagation() : undefined}>
                  {canAuthor ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => publish({ variables: { contractId: c.id } })}
                    >
                      {t('desk.publish')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
