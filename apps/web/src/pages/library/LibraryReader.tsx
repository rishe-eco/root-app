import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import NotFound from '@/pages/NotFound';
import { PUBLIC_LIBRARY_ENTRY, type PublicEntry } from '@/lib/queries';
import { dirFor, formatCitation } from '@/lib/format';

const DEFAULT_TITLE = document.title;

/**
 * Places the original beside its translation, each in its own script and
 * direction (R2.md §4). `useParams` already gives `slug` percent-decoded, so
 * it matches what R1 stored without any decoding here (§3.1).
 */
export default function LibraryReader() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { slug } = useParams<{ slug: string }>();

  const { data, loading } = useQuery<{ publicLibraryEntry: PublicEntry | null }>(PUBLIC_LIBRARY_ENTRY, {
    variables: { slug },
    skip: !slug,
  });
  const entry = data?.publicLibraryEntry ?? null;

  // T6: worth doing, and not the same as being indexable — the app has no
  // server render, so a per-entry <title> only ever reaches a tab that
  // already ran JavaScript, never a crawler.
  useEffect(() => {
    if (entry) document.title = `${entry.titleTranslated ?? entry.titleOriginal} · ${t('brand.main')}`;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [entry, t]);

  if (loading) {
    return (
      <div className="root-ui shell">
        <Nav />
        <main className="library-reader">
          <p className="t-small">{t('portal.loading')}</p>
        </main>
        <Footer />
      </div>
    );
  }

  // T2: a draft, a private entry and a wrong slug all land here, and this
  // page cannot tell which one it was — the same "not found" a mistyped URL
  // gets anywhere else in the app.
  if (!entry) return <NotFound />;

  // T5: presence of the translated title decides the column, not the
  // provenance flag — an entry with no translation must not render an
  // empty second column.
  const hasTranslation = Boolean(entry.titleTranslated);

  return (
    <div className="root-ui shell">
      <Nav />

      <main className="library-reader">
        <p className="t-small library-reader-provenance">
          {entry.translationProvenance === 'PUBLISHED'
            ? t('library.reader.provenancePublished', { credit: entry.translationCredit ?? '' })
            : entry.translationProvenance === 'ROOT'
              ? t('library.reader.provenanceRoot')
              : t('library.reader.provenanceNone')}
          {entry.translationProvenance === 'PUBLISHED' && entry.sourceUrl ? (
            <>
              {' · '}
              <a className="link" href={entry.sourceUrl} target="_blank" rel="noreferrer">
                {t('library.reader.sourceLink')}
              </a>
            </>
          ) : null}
        </p>

        <div className={`library-columns${hasTranslation ? '' : ' library-columns-single'}`}>
          {/* Each column carries its own lang/dir — the reset in tokens.css
              (:lang(en)) is what keeps a Latin column here from inheriting
              Persian's font and leading through the page's own :lang(fa). */}
          <div className="library-col" lang={entry.originalLang} dir={dirFor(entry.originalLang)}>
            <p className="t-eyebrow">{t('library.reader.original')}</p>
            <h1 className="t-h1">{entry.titleOriginal}</h1>
            {entry.abstractOriginal ? <p className="t-body">{entry.abstractOriginal}</p> : null}
          </div>
          {hasTranslation ? (
            // The translation is always Persian prose — Root's own program
            // brings the corpus into Persian, regardless of which interface
            // language the visitor is reading in (§0.1).
            <div className="library-col" lang="fa" dir="rtl">
              <p className="t-eyebrow">{t('library.reader.translation')}</p>
              <h1 className="t-h1">{entry.titleTranslated}</h1>
              {entry.abstractTranslated ? <p className="t-body">{entry.abstractTranslated}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="library-meta">
          <p className="t-small">{entry.authors}</p>
          <p className="t-caption library-meta-line">
            {entry.venue ? <span>{entry.venue}</span> : null}
            {entry.year ? <span className="num-latin">{entry.year}</span> : null}
            <span>{t(`library.lang.${entry.originalLang}`, { defaultValue: entry.originalLang })}</span>
          </p>
          {/* rightsBasis is public on purpose — it is how a reader tells an
              omission apart from a rights boundary (§2.3). */}
          <p className="t-caption">
            {t(`library.reader.rights.${entry.rightsBasis}`)}
            {entry.rightsNote ? ` — ${entry.rightsNote}` : ''}
          </p>

          {entry.fullTextUrl ? (
            <a className="btn btn-secondary btn-sm" href={entry.fullTextUrl} target="_blank" rel="noreferrer">
              {t('library.reader.viewFile')}
            </a>
          ) : null}

          {entry.concepts.length > 0 ? (
            <div className="library-concepts">
              {entry.concepts.map((c) => (
                <Link
                  key={c.slug}
                  className="badge badge-neutral"
                  to={lp(locale, `/library/research?concept=${encodeURIComponent(c.slug)}`)}
                >
                  {locale === 'fa' ? c.titleFa : c.titleEn}
                </Link>
              ))}
            </div>
          ) : null}

          {/* Generated on read, never stored (§6) — cites exactly what the
              entry holds, in its own script; no invented transliteration. */}
          <details className="library-citation">
            <summary className="t-caption">{t('library.reader.citation')}</summary>
            <pre className="library-citation-block">{formatCitation(entry, 'apa')}</pre>
            <pre className="library-citation-block">{formatCitation(entry, 'bibtex')}</pre>
          </details>
        </div>
      </main>

      <Footer />
    </div>
  );
}
