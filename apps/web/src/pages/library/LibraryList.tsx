import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { PUBLIC_LIBRARY_ENTRIES, type EntryType, type PublicEntryRow } from '@/lib/queries';
import { formatCount, translationLangFor } from '@/lib/format';
import AskLab from '@/components/AskLab';
import Text from '@/components/Text';

const ENTRY_TYPES: EntryType[] = ['PAPER', 'BOOK', 'ARTICLE', 'ROOT_RESEARCH'];
const PAGE_SIZE = 24;

/** The Research Lab's list and search — the first unauthenticated resolver
 *  in the app, reached with no `signIn` at all (R2.md §2). */
export default function LibraryList() {
  const { t } = useTranslation();
  const locale = useLocale();
  const [params, setParams] = useSearchParams();
  const conceptSlug = params.get('concept') ?? undefined;

  const [search, setSearch] = useState('');
  const [type, setType] = useState<EntryType | ''>('');
  const [offset, setOffset] = useState(0);

  const { data, loading } = useQuery<{ publicLibraryEntries: { rows: PublicEntryRow[]; total: number } }>(
    PUBLIC_LIBRARY_ENTRIES,
    {
      variables: {
        search: search.trim() || undefined,
        type: type || undefined,
        conceptSlug,
        limit: PAGE_SIZE,
        offset,
      },
    },
  );

  const rows = data?.publicLibraryEntries.rows ?? [];
  const total = data?.publicLibraryEntries.total ?? 0;

  return (
    <div className="root-ui shell">
      <Nav />

      <main className="library-list">
        <section className="library-list-head">
          <p className="t-eyebrow">{t('library.list.eyebrow')}</p>
          <h1 className="t-h1">{t('library.list.title')}</h1>
        </section>

        <AskLab />

        {conceptSlug ? (
          <p className="t-small library-list-filter">
            {t('library.list.filteredBy')}
            <button
              type="button"
              className="link-action"
              onClick={() => {
                setParams({});
                setOffset(0);
              }}
            >
              {t('library.list.clearFilter')}
            </button>
          </p>
        ) : null}

        <div className="library-list-controls">
          <input
            className="input"
            placeholder={t('library.list.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          <select
            className="select"
            value={type}
            onChange={(e) => {
              setType(e.target.value as EntryType | '');
              setOffset(0);
            }}
          >
            <option value="">{t('library.list.typeAll')}</option>
            {ENTRY_TYPES.map((et) => (
              <option key={et} value={et}>
                {t(`library.list.type.${et}`)}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="t-small">{t('portal.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="t-small">{t('library.list.empty')}</p>
        ) : (
          <div className="library-cards">
            {rows.map((r) => (
              <Link
                key={r.id}
                className="card card-link library-entry-card"
                to={lp(locale, `/library/research/${encodeURIComponent(r.slug)}`)}
              >
                <p className="t-caption">{t(`library.list.type.${r.type}`)}</p>
                {/* Entry content is data, not UI chrome (§0.1) — whichever
                    title the entry itself carries, never the viewer's own
                    interface language deciding it. A translated title reads
                    in the translation's language, not the original's
                    (persian-pass.md §1.6.1). */}
                <Text
                  as="h2"
                  className="t-h3"
                  lang={r.titleTranslated ? translationLangFor(r.originalLang) : r.originalLang}
                >
                  {r.titleTranslated ?? r.titleOriginal}
                </Text>
                <div className="library-entry-meta t-caption">
                  {r.year ? <span className="num-latin">{r.year}</span> : null}
                  <span>{t(`library.list.provenance.${r.translationProvenance}`)}</span>
                  {r.fullTextUrl ? <span className="badge">{t('library.list.hasFile')}</span> : null}
                </div>
              </Link>
            ))}
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="library-list-pager">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('library.list.prevPage')}
            </button>
            <span className="t-caption">
              {formatCount(offset + 1, locale)}–{formatCount(Math.min(offset + PAGE_SIZE, total), locale)} /{' '}
              {formatCount(total, locale)}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {t('library.list.nextPage')}
            </button>
          </div>
        ) : null}
      </main>

      <Footer />
    </div>
  );
}
