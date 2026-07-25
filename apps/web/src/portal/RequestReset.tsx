import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { REQUEST_RESET } from '@/lib/queries';
import AuthShell from './AuthShell';

export default function RequestReset() {
  const { t } = useTranslation();
  const [request, { loading }] = useMutation(REQUEST_RESET);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await request({ variables: { email } }).catch(() => undefined);
    // Always the same answer: whether that address has an account is not
    // something this form should reveal.
    setSent(true);
  }

  return (
    <AuthShell
      title={t('auth.resetRequestTitle')}
      lede={t('auth.resetRequestLede')}
      notice={sent ? t('auth.resetSent') : null}
    >
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="label" htmlFor="email">
            {t('auth.email')}
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            dir="ltr"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {t('auth.sendResetLink')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
