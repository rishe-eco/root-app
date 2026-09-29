import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import type { Locale } from '@/i18n';
import { homeFor } from '@/lib/access';
import { ME, SIGN_IN, type User } from '@/lib/queries';
import AuthShell from './AuthShell';
import PasswordField from './PasswordField';

/** Persian/Arabic-Indic digits fold the same as `lib/phone.ts` on the API
 *  side — a customer typing on a Persian keyboard sees the numeric keypad
 *  (`inputmode="tel"`) exactly as they would with Latin digits. Letters (an
 *  email address) or an empty field fall back to the ordinary keyboard. */
function looksNumeric(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^[+0-9۰-۹٠-٩\s-]+$/.test(trimmed);
}

/** Journeys build plan J1: a signed-in user with a forced password change
 *  never lands anywhere but the screen that clears it — checked here so a
 *  fresh sign-in never briefly shows the destination before bouncing. */
function destinationAfterSignIn(locale: Locale, user: User, from?: string): string {
  if (user.passwordChangeRequired) return lp(locale, '/portal/set-password');
  return from ?? lp(locale, homeFor(user));
}

export default function SignIn() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();

  const { data, loading } = useQuery<{ me: User | null }>(ME);
  const [signIn, { loading: submitting }] = useMutation(SIGN_IN);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Where the visitor was headed before the gate stopped them. */
  const from = (location.state as { from?: string } | null)?.from;

  if (!loading && data?.me) {
    return <Navigate to={destinationAfterSignIn(locale, data.me, from)} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await signIn({ variables: { identifier, password }, refetchQueries: [{ query: ME }] });
      const payload = res.data?.signIn;
      if (payload?.factorChallengeId) {
        navigate(lp(locale, '/portal/factor'), {
          replace: true,
          state: { challengeId: payload.factorChallengeId, from },
        });
        return;
      }
      if (payload?.user) {
        navigate(destinationAfterSignIn(locale, payload.user, from), { replace: true });
      }
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })
        .graphQLErrors?.[0]?.extensions?.code;
      if (code === 'PHONE_REQUIRED_FOR_STAFF') setError(t('auth.errPhoneRequiredForStaff'));
      else if (code === 'RATE_LIMITED') setError(t('auth.errRateLimited'));
      else setError(t('auth.errInvalid'));
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
            {t('auth.identifier')}
          </label>
          <input
            id="email"
            className="input"
            type="text"
            autoComplete="username"
            dir="ltr"
            inputMode={looksNumeric(identifier) ? 'tel' : 'text'}
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </div>
        <PasswordField
          id="password"
          label={t('auth.password')}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <div>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {t('auth.signIn')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
