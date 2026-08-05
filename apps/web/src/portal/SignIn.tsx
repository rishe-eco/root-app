import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { homeFor } from '@/lib/access';
import { ME, SIGN_IN, type User } from '@/lib/queries';
import AuthShell from './AuthShell';

export default function SignIn() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();

  const { data, loading } = useQuery<{ me: User | null }>(ME);
  const [signIn, { loading: submitting }] = useMutation(SIGN_IN);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Where the visitor was headed before the gate stopped them. */
  const from = (location.state as { from?: string } | null)?.from;

  if (!loading && data?.me) {
    return <Navigate to={from ?? lp(locale, homeFor(data.me))} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await signIn({ variables: { email, password }, refetchQueries: [{ query: ME }] });
      navigate(from ?? lp(locale, homeFor(res.data?.signIn.user)), { replace: true });
    } catch {
      setError(t('auth.errInvalid'));
    }
  }

  return (
    <AuthShell
      title={t('auth.signInTitle')}
      lede={t('auth.signInLede')}
      error={error}
      foot={
        <Link className="t-small link" to={lp(locale, '/portal/reset')}>
          {t('auth.forgot')}
        </Link>
      }
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
        <div className="field">
          <label className="label" htmlFor="password">
            {t('auth.password')}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {t('auth.signIn')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
