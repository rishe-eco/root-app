import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { ALL_CUSTOMERS, DUPLICATE_CONTRACT, type Contract, type User } from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';

/**
 * "Duplicate" from the contract workspace (desk UX review item 30, DX3c): a new
 * contract, on a project of its own, started from this one — its brief, agreed
 * scope, phases, payment plan and handover rows (the dialog says what is left
 * out, since dates and the whole history are the part people wonder about). The
 * same customer is chosen by default; the titles are prefilled "Copy of …" in
 * both languages. On success it opens the new contract's Steps tab.
 *
 * A dialog of the `NewCustomerModal` pattern: a sibling of the page, closed by
 * Escape, the scrim or Cancel. The customer list is only fetched for someone who
 * may read it (`customers.manage`); without that the picker offers the current
 * customer alone, which is still a complete copy.
 */
export default function DuplicateContractModal({
  contract,
  canPickCustomer,
  onClose,
}: {
  contract: Contract;
  canPickCustomer: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const [customerId, setCustomerId] = useState(contract.customer.id);
  const [titleFa, setTitleFa] = useState(`${t('workspace.copyPrefix', { lng: 'fa' })} ${contract.titleFa}`);
  const [titleEn, setTitleEn] = useState(`${t('workspace.copyPrefix', { lng: 'en' })} ${contract.titleEn}`);
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, { skip: !canPickCustomer });
  const [duplicate, { loading }] = useMutation<{ duplicateContract: { id: string } }>(DUPLICATE_CONTRACT);
  const label = (u: Pick<User, 'name' | 'clientName'>) => (u.clientName ? `${u.clientName} · ${u.name}` : u.name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const options = (data?.allCustomers ?? []).filter((u) => u.id === contract.customer.id || (!u.erased && u.state !== 'DISABLED'));
  // Until the list arrives (or when it is not readable) the current customer is the one option.
  const shown = options.length > 0 ? options : [contract.customer as Pick<User, 'id' | 'name' | 'clientName'>];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await duplicate({ variables: { contractId: contract.id, customerId, titleFa: titleFa.trim(), titleEn: titleEn.trim() } });
      // The workspace stays mounted when only :id changes, so its `duplicating` flag would outlive the
      // navigation: close first.
      onClose();
      navigate(lp(locale, `/desk/contracts/${res.data!.duplicateContract.id}/steps`));
    } catch (err) {
      const code = errorCode(err);
      const known = code ? t(`workspace.duplicateError.${code}`, { defaultValue: '' }) : '';
      setError(known || (err as Error).message);
    }
  }

  return (
    <div className="overlay">
      <div className="overlay-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dc-title" data-testid="duplicate-modal">
        <h2 className="t-h3" id="dc-title">
          {t('workspace.duplicateTitle')}
        </h2>
        <p className="t-small desk-muted">{t('workspace.duplicateHelp')}</p>
        <form className="auth-form" onSubmit={onSubmit}>
          <div className="field">
            <label className="label" htmlFor="dc-customer">
              {t('desk.colCustomer')}
            </label>
            <select
              id="dc-customer"
              className="select"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              disabled={!canPickCustomer}
            >
              {shown.map((u) => (
                <option key={u.id} value={u.id}>
                  {label(u)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="dc-fa">
              {t('workspace.titleFa')}
            </label>
            <input id="dc-fa" className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="dc-en">
              {t('workspace.titleEn')}
            </label>
            <input id="dc-en" className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
          {error ? (
            <p className="error" role="alert" data-testid="duplicate-error">
              {error}
            </p>
          ) : null}
          <div className="modal-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading} data-testid="duplicate-submit">
              {t('workspace.duplicateSubmit')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
              {t('requests.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
