import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Tagline from '@/components/Tagline';

const GROWTH = ['coaching', 'peace', 'education'] as const;

export default function Landing() {
  const { t } = useTranslation();
  const locale = useLocale();

  /* Persian sits a rung lower on the scale — the script carries more ink per
     word at the same size, and the display rung is set for Latin. Both values
     are tokens, not magic numbers. */
  const heroCls = locale === 'fa' ? 'hero-line hero-line-fa' : 'hero-line hero-line-en';

  return (
    <div className="root-ui shell">
      <Nav />

      {/* One centred line and its descriptor, and deliberately nothing else
          (founder direction, 2026-08-09). The hero previously carried a
          tagline, a headline, a lead and a blurred Root Cast panel — four
          things competing in one eyeful. `landing.rootCast` stays in the
          locale files: Root Cast is a real forthcoming strand and R2 needs
          the label for /library/cast. */}
      <section className="hero">
        <h1 className={heroCls}>
          <Tagline />
        </h1>
        <p className="t-lead hero-lead">{t('tagline.descriptor')}</p>
        {/* The hero CTA is hidden until its destination is decided. The copy
            stays in the locale files (landing.cta) so it is one line back. */}
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
