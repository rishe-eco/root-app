import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { ME, RESET_PASSWORD } from '@/lib/queries';
import AuthShell from './AuthShell';

const MIN_PASSWORD = 10;

export default function ResetPassword() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const { token = '' } = useParams();

  const [reset, { loading }] = useMutation(RESET_PASSWORD);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) return setError(t('auth.errShort'));
    if (password !== confirm) return setError(t('auth.errMismatch'));

    try {
      await reset({ variables: { token, password }, refetchQueries: [{ query: ME }] });
      navigate(lp(locale, '/app/contracts'), { replace: true });
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })
        .graphQLErrors?.[0]?.extensions?.code;
      setError(code === 'TOKEN_INVALID' ? t('auth.errTokenBad') : t('auth.errGeneric'));
    }
  }

  return (
    <AuthShell title={t('auth.resetTitle')} error={error}>
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="label" htmlFor="pw">
            {t('auth.newPassword')}
          </label>
          <input
            id="pw"
            className="input"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pw2">
            {t('auth.confirmPassword')}
          </label>
          <input
            id="pw2"
            className="input"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {t('auth.resetCta')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
