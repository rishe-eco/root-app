import { useTranslation } from 'react-i18next';

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
          <p className="t-caption footer-descriptor">{t('footer.descriptor')}</p>
        </div>
        {/* The refusal line: what Root will not do to you. */}
        <p className="t-caption footer-refusal">{t('footer.refusal')}</p>
      </div>
      <hr className="rule footer-rule" />
      <p className="t-caption footer-copy">{t('footer.copyright')}</p>
    </footer>
  );
}
