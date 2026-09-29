import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { homeFor } from '@/lib/access';
import { ME, SET_NEW_PASSWORD, type User } from '@/lib/queries';
import AuthShell from './AuthShell';
import PasswordField from './PasswordField';

const MIN_PASSWORD = 10;

/**
 * PD-10 — the one screen an account with `passwordChangeRequired` set may
 * still reach (`setNewPassword` is the one mutation `requireUser` still
 * allows it to call). Reached two ways: forced, when `PortalLayout` or
 * `DeskLayout` notice the flag on `me` and redirect here before rendering
 * anything else; and directly, at the end of `ForgotPassword`'s phone-code
 * flow, which sets the same flag by design (PD-10 again) the moment a code
 * verifies. Signing in is still required to reach it at all — `setNewPassword`
 * needs a session, and the phone flow's `verifyLoginCode` is what supplies one.
 */
export default function SetNewPassword() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();

  const { data, loading } = useQuery<{ me: User | null }>(ME);
  const [setNewPassword, { loading: submitting }] = useMutation(SET_NEW_PASSWORD);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (loading) return null;
  if (!data?.me) {
    return <Navigate to={lp(locale, '/portal')} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) return setError(t('auth.errShort'));
    if (password !== confirm) return setError(t('auth.errMismatch'));

    try {
      const res = await setNewPassword({ variables: { password }, refetchQueries: [{ query: ME }] });
      const user = res.data?.setNewPassword.user as User;
      navigate(lp(locale, homeFor(user)), { replace: true });
    } catch {
      setError(t('auth.errGeneric'));
    }
  }

  return (
    <AuthShell title={t('auth.setPasswordTitle')} lede={t('auth.setPasswordLede')} error={error}>
      <form className="auth-form" onSubmit={onSubmit}>
        <PasswordField
          id="pw"
          label={t('auth.newPassword')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          help={<span className="help">{t('auth.errShort')}</span>}
        />
        <PasswordField
          id="pw2"
          label={t('auth.confirmPassword')}
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <div>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {t('auth.resetCta')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
