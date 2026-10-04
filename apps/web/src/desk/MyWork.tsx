import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { holdsContractWork } from '@/lib/home';
import { MY_ATTENTION, type HomeItem, type User } from '@/lib/queries';
import HomeList from '@/components/HomeList';

/**
 * The desk's home for every staff capability set (journeys build plan J12):
 * what is waiting on **this** person, from one query (`myAttention`) whose
 * filter is the person's *job and assignment* — sales' book, a designer's
 * contracts, a developer's — never a role test here or there. ADMIN's is
 * everyone's, through `assignments.override`.
 *
 * Two groups, and the split is the point: **your move** (what waits on Root and
 * is yours to do) and **following up** (what waits on the customer but is yours
 * to chase — an overdue invoice, a technical commitment). Nothing is stored and
 * nothing dismissed; an item leaves when the act that clears it happens.
 *
 * The empty state tells a person with no contract work (a contributor, a
 * reviewer) that this home has none for them and points at their own sections,
 * and tells everyone else that nothing is waiting — two true things, not one
 * "nothing here". V4's Overview, with its tiles and the Needs-Root queue,
 * remains for `contracts.readAll` as its own section.
 */
export default function MyWork() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { data, loading, error, refetch } = useQuery<{ myAttention: HomeItem[] }>(MY_ATTENTION, { fetchPolicy: 'cache-and-network' });

  const items = data?.myAttention ?? [];
  const yours = items.filter((i) => i.waitingOn === 'ROOT');
  const following = items.filter((i) => i.waitingOn === 'CUSTOMER');
  const working = holdsContractWork(me);

  return (
    <div className="desk-section" data-testid="my-work">
      <div>
        <h2 className="t-h2">{t('desk.navWork')}</h2>
        <p className="t-lead">{t('home.work.lede')}</p>
      </div>

      {error ? (
        <div className="empty">
          <p className="t-small">{t('portal.errorTitle')}</p>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
            {t('portal.retry')}
          </button>
        </div>
      ) : loading && !data ? (
        <p className="t-small">{t('portal.loading')}</p>
      ) : (
        <>
          {yours.length > 0 ? (
            <section className="home-section" aria-labelledby="work-yours">
              <h3 className="t-h3" id="work-yours">
                {t('home.work.yoursTitle')}
              </h3>
              <HomeList items={yours} label={t('home.work.yoursTitle')} />
            </section>
          ) : null}
          {following.length > 0 ? (
            <section className="home-section" aria-labelledby="work-following">
              <h3 className="t-h3" id="work-following">
                {t('home.work.followingTitle')}
              </h3>
              <p className="t-small muted">{t('home.work.followingLede')}</p>
              <HomeList items={following} label={t('home.work.followingTitle')} />
            </section>
          ) : null}
          {items.length === 0 ? (
            <div className="empty" data-testid="work-empty">
              <p className="t-small">{working ? t('home.work.emptyAllClear') : t('home.work.emptyNoWork')}</p>
              {can(me, 'contracts.readActive') ? (
                <Link className="btn btn-secondary btn-sm" to={lp(locale, '/desk/contracts')}>
                  {t('desk.navContracts')}
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
