import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Lock from '@/components/Lock';

const GROWTH = ['coaching', 'peace', 'education'] as const;

export default function Landing() {
  const { t } = useTranslation();
  const locale = useLocale();

  /* The Persian headline is much longer than the English one, so it sits a
     rung lower on the scale. Both values are tokens, not magic numbers. */
  const heroCls = locale === 'fa' ? 'hero-title hero-title-fa' : 'hero-title hero-title-en';

  return (
    <div className="root-ui shell">
      <Nav />

      <section className="hero">
        <div className="hero-main">
          <p className="hero-tagline">
            {t('landing.eyebrowPrefix')}
            <span className="beauty">{t('landing.eyebrowHighlight')}</span>
          </p>
          <h1 className={heroCls}>{t('landing.heroTitle')}</h1>
          <p className="t-lead hero-lead">{t('landing.heroDescriptor')}</p>
          {/* The hero CTA is hidden until its destination is decided. The copy
              stays in the locale files (landing.cta) so it is one line back. */}
        </div>

        <div className="hero-gap" />

        <div className="hero-side">
          <div className="card card-panel side-panel">
            <Lock />
            <div>
              {/* Named, blurred, honestly not ready — the same language as the
                  locked nav slots. */}
              <div className="ghost" aria-hidden="true">
                {t('landing.rootCast')}
              </div>
              <span className="sr-only">{t('landing.rootCast')}</span>
              <div className="t-small ghost-note">{t('nav.locked')}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="growth">
        <h2 className="t-eyebrow growth-heading">{t('landing.growthHeading')}</h2>
        <div className="growth-grid">
          {GROWTH.map((key) => (
            <div className="card card-topruled" key={key}>
              <p className="t-h3">{t(`landing.growth.${key}.title`)}</p>
              <p className="t-small">{t(`landing.growth.${key}.desc`)}</p>
            </div>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
