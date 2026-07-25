import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Lock from '@/components/Lock';

/**
 * A reserved section. The route exists so later work is a drop-in, not a
 * renovation — but the nav does not link here, and the page says so plainly.
 */
export default function Reserved({ section }: { section: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const name = t(`nav.${section}`, { defaultValue: section });

  return (
    <div className="root-ui shell">
      <Nav />
      <main className="notfound">
        <Lock />
        <h1 className="t-h2">{name}</h1>
        <p className="t-lead">{t('nav.locked')}</p>
        <Link className="btn btn-secondary" to={lp(locale, '/')}>
          {t('notFound.cta')}
        </Link>
      </main>
      <Footer />
    </div>
  );
}
