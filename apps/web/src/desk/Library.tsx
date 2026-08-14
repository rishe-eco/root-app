import { useState } from 'react';
import { Navigate, useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { LIBRARY_ENTRIES, type EntryType, type LibraryEntryRow, type User } from '@/lib/queries';
import { formatCount, translationLangFor } from '@/lib/format';
import Text from '@/components/Text';

const ENTRY_TYPES: EntryType[] = ['PAPER', 'BOOK', 'ARTICLE', 'ROOT_RESEARCH'];
const PAGE_SIZE = 20;

export default function Library() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();

  const [search, setSearch] = useState('');
  const [type, setType] = useState<EntryType | ''>('');
  const [offset, setOffset] = useState(0);

  const { data, loading } = useQuery<{ libraryEntries: { rows: LibraryEntryRow[]; total: number } }>(
    LIBRARY_ENTRIES,
    {
      skip: !can(me, 'library.write'),
      variables: {
        search: search.trim() || undefined,
        type: type || undefined,
        limit: PAGE_SIZE,
        offset,
      },
    },
  );

  if (!can(me, 'library.write')) return <Navigate to={lp(locale, '/desk')} replace />;

  const rows = data?.libraryEntries.rows ?? [];
  const total = data?.libraryEntries.total ?? 0;

  return (
    <div className="desk-section">
      <div className="workspace-row">
        <h2 className="t-h2">{t('desk.navLibrary')}</h2>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={() => navigate(lp(locale, '/desk/library/new'))}
        >
          {t('desk.library.newEntry')}
        </button>
      </div>

      <div className="workspace-row">
        <input
          className="input"
          placeholder={t('desk.library.searchPlaceholder')}
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
          <option value="">{t('desk.library.typeAll')}</option>
          {ENTRY_TYPES.map((et) => (
            <option key={et} value={et}>
              {t(`desk.library.type.${et}`)}
            </option>
          ))}
        </select>
        <a className="t-small link" href={lp(locale, '/desk/library/concepts')}>
          {t('desk.library.manageConcepts')}
        </a>
      </div>

      {loading ? (
        <p className="t-small">{t('portal.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="t-small">{t('desk.library.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="ctable">
            <thead>
              <tr>
                <th>{t('desk.library.colTitle')}</th>
                <th>{t('desk.library.colType')}</th>
                <th>{t('desk.library.colYear')}</th>
                <th>{t('desk.library.colProvenance')}</th>
                <th>{t('desk.library.colRights')}</th>
                <th>{t('desk.library.colConcepts')}</th>
                <th>{t('desk.library.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="crow"
                  onClick={() => navigate(lp(locale, `/desk/library/${r.id}`))}
                >
                  {/* Entry content is data, not UI chrome (§0.1) — the title
                      shown is whichever the entry itself carries, never
                      chosen by the viewer's own interface language
                      (persian-pass.md §1.6.1). */}
                  <td>
                    <Text lang={r.titleTranslated ? translationLangFor(r.originalLang) : r.originalLang}>
                      {r.titleTranslated ?? r.titleOriginal}
                    </Text>
                  </td>
                  <td>{t(`desk.library.type.${r.type}`)}</td>
                  {/* T4/§7's num-latin choice for the year: it sits beside a
                      DOI in the editor and in citations, both always ASCII. */}
                  <td className="num-latin">{r.year ?? '—'}</td>
                  <td>{t(`desk.library.provenance.${r.translationProvenance}`)}</td>
                  <td>{t(`desk.library.rights.${r.rightsBasis}`)}</td>
                  {/* A count, not a citation field — so it reads in the
                      viewer's own digits, like the pagination footer below
                      and V4's tiles. `num-latin` is for the year and the DOI,
                      which are Latin wherever they are printed. */}
                  <td>{formatCount(r.conceptCount, locale)}</td>
                  <td>
                    {/* Reuses the contract-status pill shell and its neutral
                        (draft) / solid (done) colour roles — generic tokens,
                        not something specific to a contract. */}
                    <span className={`st-badge ${r.publishedAt ? 'st-done' : 'st-draft'}`}>
                      <span className="sdot" />
                      {t(r.publishedAt ? 'desk.library.published' : 'desk.library.draft')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="workspace-row">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            {t('desk.library.prevPage')}
          </button>
          <span className="t-caption">
            {formatCount(offset + 1, locale)}–{formatCount(Math.min(offset + PAGE_SIZE, total), locale)} / {formatCount(total, locale)}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('desk.library.nextPage')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
