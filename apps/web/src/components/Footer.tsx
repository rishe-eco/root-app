import { useTranslation } from 'react-i18next';

import Tagline from './Tagline';

export default function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="footer">
      <div className="footer-grid">
        <div className="footer-col">
          <p className="footer-brand">
            <span className="footer-dot" />
            {t('brand.main')} · {t('brand.sub')}
          </p>
          {/* The two-tier rule (Brand §7): the tagline is a compass, never a
              map, and never appears without its orienting descriptor. Both
              come from the `tagline` namespace, so the hero and this line are
              the same strings rather than two copies that agree today. */}
          <p className="t-caption footer-descriptor">
            {t('footer.lead')}
            <Tagline /> {t('tagline.descriptor')}
          </p>
        </div>
        {/* The refusal line: what Root will not do to you. */}
        <p className="t-caption footer-refusal">{t('footer.refusal')}</p>
      </div>
      <hr className="rule footer-rule" />
      <p className="t-caption footer-copy">{t('footer.copyright')}</p>
    </footer>
  );
}
