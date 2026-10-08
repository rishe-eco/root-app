import { useLocale, useSwitchLocale } from '@/lib/locale';

/** Switching flips the locale, the direction, the font and the URL together. */
export default function LangSwitch() {
  const locale = useLocale();
  const switchTo = useSwitchLocale();

  return (
    <div className="lang-switch">
      <button
        type="button"
        onClick={() => switchTo('en')}
        aria-pressed={locale === 'en'}
        lang="en"
        aria-label="English"
        style={{ fontFamily: 'var(--font-latin)' }}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => switchTo('fa')}
        aria-pressed={locale === 'fa'}
        lang="fa"
        aria-label="فارسی"
        style={{ fontFamily: 'var(--font-persian)' }}
      >
        فا
      </button>
    </div>
  );
}
