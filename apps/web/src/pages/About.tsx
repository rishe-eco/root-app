import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export default function About() {
  const { t } = useTranslation();
  const locale = useLocale();

  const thesisCls = locale === 'fa' ? 't-h2' : 't-h1';
  const clientsTitleCls = locale === 'fa' ? 't-h1' : 't-display';

  return (
    <div className="root-ui shell">
      <Nav />

      <main className="about">
        <section className="gist">
          <p className="t-eyebrow gist-eyebrow">{t('about.eyebrow')}</p>
          <h1 className={`${thesisCls} gist-title`}>
            {t('about.thesisA')}
            <span className="beauty">{t('about.thesisBeauty')}</span>
            {t('about.thesisB')}
          </h1>
          <p className="t-lead gist-body">{t('about.gistBody')}</p>
        </section>

        {/* The quiet path to the portal for people already working with Root. */}
        <section className="card card-inverse clients-cta">
          <p className="t-eyebrow clients-eyebrow">{t('about.clientsEyebrow')}</p>
          <h2 className={`${clientsTitleCls} clients-title`}>{t('about.clientsTitle')}</h2>
          <p className="clients-body">{t('about.clientsBody')}</p>
          <div>
            <Link className="btn btn-primary btn-lg clients-btn" to={lp(locale, '/portal')}>
              {t('about.clientsCta')}
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
