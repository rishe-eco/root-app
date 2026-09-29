import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { REQUEST_RESET, REQUEST_LOGIN_CODE, VERIFY_LOGIN_CODE, ME } from '@/lib/queries';
import AuthShell from './AuthShell';

/** Same fold as SignIn.tsx's own — an identifier that is all digits (Persian
 *  or Latin) gets the numeric keypad. Kept local rather than shared: this is
 *  the only other place in the portal that asks for the same kind of field. */
function looksNumeric(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^[+0-9۰-۹٠-٩\s-]+$/.test(trimmed);
}

type Step = 'identifier' | 'sent' | 'code';

/**
 * Journeys build plan J1: one identifier field, exactly like `SignIn` — an
 * `@` decides which recovery path runs. An email keeps today's behaviour
 * (a link, mailed, landing on `ResetPassword` at its own route); a phone
 * gets a code on this same screen, `requestLoginCode` → `verifyLoginCode`,
 * ending in the forced `SetNewPassword` route rather than a reset form here
 * — the account is not choosing a password yet, it is proving it controls
 * the phone (PD-10).
 */
export default function ForgotPassword() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();

  const [requestReset] = useMutation(REQUEST_RESET);
  const [requestLoginCode] = useMutation(REQUEST_LOGIN_CODE);
  const [verifyLoginCode, { loading: verifying }] = useMutation(VERIFY_LOGIN_CODE);

  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('identifier');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEmail = identifier.includes('@');

  async function onSubmitIdentifier(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isEmail) {
        await requestReset({ variables: { email: identifier } }).catch(() => undefined);
        // Always the same answer: whether that address has an account is
        // not something this form should reveal.
        setStep('sent');
      } else {
        await requestLoginCode({ variables: { phone: identifier } });
        // requestLoginCode is also always true for a real phone; unlike the
        // email branch, this one goes on to ask for the code itself, since
        // the code (not a link) is what phone recovery actually is.
        setStep('code');
      }
    } catch (err) {
      const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })
        .graphQLErrors?.[0]?.extensions?.code;
      setError(code === 'RATE_LIMITED' ? t('auth.errRateLimited') : t('auth.errSmsUnavailable'));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await verifyLoginCode({ variables: { phone: identifier, code }, refetchQueries: [{ query: ME }] });
      navigate(lp(locale, '/portal/set-password'), { replace: true });
    } catch {
      setError(t('auth.errCodeInvalid'));
    }
  }

  if (step === 'code') {
    return (
      <AuthShell title={t('auth.codeTitle')} lede={t('auth.codeLede')} error={error}>
        <form className="auth-form" onSubmit={onSubmitCode}>
          <div className="field">
            <label className="label" htmlFor="reset-code">
              {t('auth.code')}
            </label>
            <input
              id="reset-code"
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
            <button className="btn btn-primary" type="submit" disabled={verifying}>
              {t('auth.verifyCode')}
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.resetRequestTitle')}
      lede={t('auth.resetRequestLede')}
      error={error}
      notice={step === 'sent' ? t('auth.resetSent') : null}
    >
      <form className="auth-form" onSubmit={onSubmitIdentifier}>
        <div className="field">
          <label className="label" htmlFor="identifier">
            {t('auth.identifier')}
          </label>
          <input
            id="identifier"
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
        <div>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {t('auth.sendResetLink')}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
