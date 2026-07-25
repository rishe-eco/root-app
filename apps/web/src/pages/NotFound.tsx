import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export default function NotFound() {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <div className="root-ui shell">
      <Nav />
      <main className="notfound">
        <h1 className="t-h2">{t('notFound.title')}</h1>
        <p className="t-lead">{t('notFound.body')}</p>
        <Link className="btn btn-secondary" to={lp(locale, '/')}>
          {t('notFound.cta')}
        </Link>
      </main>
      <Footer />
    </div>
  );
}
