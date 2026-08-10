import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  CREATE_LIBRARY_CONCEPT,
  DELETE_LIBRARY_CONCEPT,
  LIBRARY_CONCEPTS,
  UPDATE_LIBRARY_CONCEPT,
  type LibraryConcept,
  type User,
} from '@/lib/queries';

/**
 * Flat in R1 (§2.3) — R3 turns this into a tree. Renaming and deleting are
 * `library.editTree`, not `library.write`: a contributor tags entries with
 * concepts that already exist, or creates one that does not yet; tending the
 * ontology itself is a separate, stricter verb.
 */
export default function LibraryConcepts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const canEditTree = can(me, 'library.editTree');

  const { data } = useQuery<{ libraryConcepts: LibraryConcept[] }>(LIBRARY_CONCEPTS, {
    skip: !can(me, 'library.write'),
  });
  const [create, { loading: creating }] = useMutation(CREATE_LIBRARY_CONCEPT, {
    refetchQueries: [{ query: LIBRARY_CONCEPTS }],
  });
  const [update] = useMutation(UPDATE_LIBRARY_CONCEPT, {
    refetchQueries: [{ query: LIBRARY_CONCEPTS }],
  });
  const [remove] = useMutation(DELETE_LIBRARY_CONCEPT, {
    refetchQueries: [{ query: LIBRARY_CONCEPTS }],
  });

  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { titleFa: string; titleEn: string }>>({});

  if (!can(me, 'library.write')) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create({ variables: { input: { titleFa, titleEn } } });
      setTitleFa('');
      setTitleEn('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.library.conceptsTitle')}</h2>

      <section className="card">
        <form className="auth-form" onSubmit={onCreate}>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label" htmlFor="lc-fa">{t('desk.library.conceptTitleFa')}</label>
              <input id="lc-fa" className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="lc-en">{t('desk.library.conceptTitleEn')}</label>
              <input id="lc-en" className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
              {t('desk.library.addConcept')}
            </button>
          </div>
        </form>
      </section>

      <div className="table-wrap">
        <table className="ctable">
          <thead>
            <tr>
              <th>{t('desk.library.conceptTitleFa')}</th>
              <th>{t('desk.library.conceptTitleEn')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.libraryConcepts ?? []).map((c) => {
              const draft = editing[c.id];
              return (
                <tr key={c.id}>
                  <td dir="rtl">
                    {draft ? (
                      <input
                        className="input"
                        dir="rtl"
                        value={draft.titleFa}
                        onChange={(e) => setEditing((s) => ({ ...s, [c.id]: { ...draft, titleFa: e.target.value } }))}
                      />
                    ) : (
                      c.titleFa
                    )}
                  </td>
                  <td dir="ltr">
                    {draft ? (
                      <input
                        className="input"
                        dir="ltr"
                        value={draft.titleEn}
                        onChange={(e) => setEditing((s) => ({ ...s, [c.id]: { ...draft, titleEn: e.target.value } }))}
                      />
                    ) : (
                      c.titleEn
                    )}
                  </td>
                  <td>
                    {draft ? (
                      <div className="workspace-row">
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          onClick={async () => {
                            await update({ variables: { id: c.id, input: draft } });
                            setEditing((s) => {
                              const { [c.id]: _drop, ...rest } = s;
                              return rest;
                            });
                          }}
                        >
                          {t('desk.library.saveConcept')}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() =>
                            setEditing((s) => {
                              const { [c.id]: _drop, ...rest } = s;
                              return rest;
                            })
                          }
                        >
                          {t('desk.library.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="workspace-row">
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={!canEditTree}
                          title={canEditTree ? undefined : t('desk.library.editTreeNeedsCapability')}
                          onClick={() => setEditing((s) => ({ ...s, [c.id]: { titleFa: c.titleFa, titleEn: c.titleEn } }))}
                        >
                          {t('desk.library.rename')}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={!canEditTree}
                          title={canEditTree ? undefined : t('desk.library.editTreeNeedsCapability')}
                          onClick={() => remove({ variables: { id: c.id } })}
                        >
                          {t('desk.library.deleteConcept')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
