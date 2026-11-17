import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { ALL_CUSTOMERS, INVITE_CUSTOMER } from '@/lib/queries';
import { InviteLinkBox } from './AccountTools';
import { peopleError } from './peopleErrors';

/**
 * "New customer" from inside the new-contract form (desk UX review item 2,
 * DX3b): the customer is made — an invite, exactly what `/desk/customers`
 * does — without leaving the form, so what was typed there is kept. The form
 * lives in its parent; this is a sibling dialog, never nested in its `<form>`.
 *
 * Two steps in one dialog. The form; then, once the API has answered, the
 * invite link with a Copy button, and one line on what else went out. The
 * API reports the address it holds for the customer (`email`, null for a
 * phone-only one) and nothing about delivery — a send that bounces is not
 * known here — so the line says what was attempted, not what arrived, and
 * the link above it is the dependable way (it is returned either way).
 * The customer is handed to the parent as soon as they exist, so the picker
 * has them selected behind the dialog while the link is still on screen.
 */
export default function NewCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Called with the new customer's id once the picker's list has refreshed. */
  onCreated: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientName, setClientName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteLocale, setInviteLocale] = useState<'fa' | 'en'>(locale === 'en' ? 'en' : 'fa');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inviteUrl: string; email: string | null } | null>(null);
  const [invite, { loading }] = useMutation(INVITE_CUSTOMER, {
    refetchQueries: [{ query: ALL_CUSTOMERS }],
    awaitRefetchQueries: true,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await invite({
        variables: {
          phone,
          name: name.trim(),
          clientName: clientName.trim() || null,
          email: email.trim() || null,
          locale: inviteLocale,
        },
      });
      const r = res.data.inviteCustomer as { userId: string; inviteUrl: string; email: string | null };
      setResult({ inviteUrl: r.inviteUrl, email: r.email });
      onCreated(r.userId);
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  return (
    <div className="overlay">
      <div className="overlay-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="nu-title" data-testid="new-customer-modal">
        <h2 className="t-h3" id="nu-title">
          {t('desk.newCustomerTitle')}
        </h2>
        {result ? (
          <>
            <p className="t-small" data-testid="new-customer-done">
              {t('desk.newCustomerDone')}
            </p>
            <InviteLinkBox url={result.inviteUrl} note={t('desk.inviteOnce')} />
            <p className="t-caption desk-muted" data-testid="new-customer-sent">
              {result.email ? t('desk.newCustomerEmailed', { email: result.email }) : t('desk.newCustomerNoEmail')}
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary btn-sm" type="button" onClick={onClose} data-testid="new-customer-close">
                {t('desk.newCustomerBack')}
              </button>
            </div>
          </>
        ) : (
          <form className="auth-form" onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="nu-name">
                {t('desk.inviteName')}
              </label>
              <input id="nu-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="nu-phone">
                {t('desk.invitePhone')}
              </label>
              <input
                id="nu-phone"
                className="input"
                type="tel"
                dir="ltr"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="nu-client">
                {t('desk.inviteClient')}
              </label>
              <input id="nu-client" className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="nu-email">
                {t('desk.inviteEmail')}
              </label>
              <input
                id="nu-email"
                className="input"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="nu-locale">
                {t('desk.newCustomerLocale')}
              </label>
              <select
                id="nu-locale"
                className="select"
                value={inviteLocale}
                onChange={(e) => setInviteLocale(e.target.value === 'en' ? 'en' : 'fa')}
              >
                <option value="fa">{t('desk.newCustomerLocaleFa')}</option>
                <option value="en">{t('desk.newCustomerLocaleEn')}</option>
              </select>
            </div>
            {error ? (
              <p className="error" role="alert" data-testid="new-customer-error">
                {error}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={loading} data-testid="new-customer-submit">
                {t('desk.inviteCta')}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
                {t('requests.cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
