import { Link } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Lock from '@/components/Lock';
import { PUBLIC_LIBRARY_ENTRIES, type PublicEntryRow } from '@/lib/queries';
import { formatCount, translationLangFor } from '@/lib/format';
import Text from '@/components/Text';

const RECENT = 3;

/**
 * The umbrella (R2.md §10): one strand live, one still locked. Built as a
 * real page rather than an immediate redirect to /library/research — Root
 * Cast is a genuine second strand already named on the landing page and in
 * the nav, and a visitor should be able to see both exist even while only
 * one is open.
 */
export default function LibraryHome() {
  const { t } = useTranslation();
  const locale = useLocale();

  const { data } = useQuery<{ publicLibraryEntries: { rows: PublicEntryRow[]; total: number } }>(
    PUBLIC_LIBRARY_ENTRIES,
    { variables: { limit: RECENT, offset: 0 } },
  );
  const rows = data?.publicLibraryEntries.rows ?? [];
  const total = data?.publicLibraryEntries.total ?? 0;

  return (
    <div className="root-ui shell">
      <Nav />

      <main className="library-home">
        <section className="library-home-head">
          <p className="t-eyebrow">{t('library.home.eyebrow')}</p>
          <h1 className="t-h1">{t('library.home.title')}</h1>
          <p className="t-lead library-home-body">{t('library.home.body')}</p>
        </section>

        <div className="library-strands">
          <Link className="card card-link library-strand" to={lp(locale, '/library/research')}>
            <p className="t-eyebrow">{t('library.home.researchEyebrow')}</p>
            <h2 className="t-h2">{t('library.home.researchTitle')}</h2>
            <p className="t-small">{t('library.home.researchBody')}</p>
            {/* Not num-latin (persian-pass.md §1.2): a count reads in the
                viewer's own digits, and num-latin would force the Latin
                figure font onto them — same reasoning as desk/Overview.tsx. */}
            <p className="t-caption library-strand-count">
              {formatCount(total, locale)} {t('library.home.entries')}
            </p>
          </Link>

          <Link className="card card-link library-strand library-strand-locked" to={lp(locale, '/library/cast')}>
            <p className="t-eyebrow">{t('landing.rootCast')}</p>
            <h2 className="t-h2">{t('nav.cast')}</h2>
            <p className="t-small">{t('nav.locked')}</p>
            <Lock />
          </Link>
        </div>

        {rows.length > 0 ? (
          <section className="library-recent">
            <p className="t-eyebrow">{t('library.home.recentHeading')}</p>
            <ul className="library-recent-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link className="link" to={lp(locale, `/library/research/${encodeURIComponent(r.slug)}`)}>
                    <Text lang={r.titleTranslated ? translationLangFor(r.originalLang) : r.originalLang}>
                      {r.titleTranslated ?? r.titleOriginal}
                    </Text>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <Footer />
    </div>
  );
}
