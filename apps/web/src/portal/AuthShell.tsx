import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

/**
 * Login gates a whole app area and needs redirect-after-login, invite
 * acceptance and reset flows — so it is a standalone page, not a modal.
 */
export default function AuthShell({
  title,
  lede,
  error,
  notice,
  children,
  foot,
}: {
  title: string;
  lede?: string;
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <div className="root-ui shell">
      <Nav />
      <main className="auth">
        <div className="auth-card">
          <div className="auth-head">
            <h1 className="t-h2">{title}</h1>
            {lede ? <p className="t-small">{lede}</p> : null}
          </div>

          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="auth-notice" role="status">
              {notice}
            </p>
          ) : null}

          {children}

          <div className="auth-foot">
            {foot}
            <Link className="t-small link" to={lp(locale, '/')}>
              {t('auth.backToSite')}
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
