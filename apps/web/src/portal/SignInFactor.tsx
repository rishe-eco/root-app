import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { homeFor } from '@/lib/access';
import { ME, VERIFY_SIGN_IN_FACTOR, type User } from '@/lib/queries';
import AuthShell from './AuthShell';

/**
 * PD-20 — the staff second factor. Reached only from `SignIn`, which passes
 * the challenge id it got back from `signIn` through router state; landing
 * here directly (a refresh, a bookmark) has nothing to verify against, so
 * it bounces to plain sign-in rather than show a form that can only ever
 * refuse.
 */
export default function SignInFactor() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();

  const state = location.state as { challengeId?: string; from?: string } | null;
  const challengeId = state?.challengeId;
  const from = state?.from;

  const [verify, { loading }] = useMutation(VERIFY_SIGN_IN_FACTOR);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!challengeId) {
    return <Navigate to={lp(locale, '/portal')} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await verify({ variables: { challengeId, code }, refetchQueries: [{ query: ME }] });
      const user = res.data?.verifySignInFactor.user as User;
      navigate(from ?? lp(locale, homeFor(user)), { replace: true });
    } catch {
      setError(t('auth.errCodeInvalid'));
    }
  }

  return (
    <AuthShell title={t('auth.factorTitle')} lede={t('auth.factorLede')} error={error}>
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="label" htmlFor="factor-code">
            {t('auth.code')}
          </label>
          <input
            id="factor-code"
            className="input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {t('auth.verifyCode')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
