import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import {
  MY_ATTENTION,
  MY_CONTRACT_LINKS,
  MY_REQUESTS,
  MY_TOOLS,
  type ContractLink,
  type HomeItem,
  type Request,
  type User,
} from '@/lib/queries';
import { pick } from '@/lib/format';
import { currentContract } from '@/lib/home';
import HomeList from '@/components/HomeList';
import Topbar from './Topbar';
import NewRequestModal from './NewRequestModal';

/**
 * The customer's home (journeys build plan J12): `/app`. What is waiting on
 * *them* first, then what waits on Root — each item a link to the place that
 * clears it — and the three things a customer starts from: a new request, the
 * contract in progress, a tool.
 *
 * **Everything on the list is the API's derived answer** (`myAttention`); the
 * page decides nothing about what is owed and stores nothing — no "mark as
 * read", no dismiss. An item leaves when the act that clears it happens.
 *
 * **The empty state says what is true.** There are three honest empties and
 * they are different sentences: no contract and no request at all (so: start
 * with a request); contracts in progress and nothing owed either way; and
 * something waiting on Root only (so: nothing for you to do). "Nothing here"
 * is none of them.
 */

export default function Dashboard() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();
  const [composing, setComposing] = useState(false);

  // Re-read when the tab regains focus is the portal's rule elsewhere (the request drawer); here the
  // list is simply fetched fresh on every visit, which is when a customer comes to look.
  const { data, loading, error, refetch } = useQuery<{ myAttention: HomeItem[] }>(MY_ATTENTION, { fetchPolicy: 'cache-and-network' });
  const { data: contractData } = useQuery<{ myContracts: ContractLink[] }>(MY_CONTRACT_LINKS);
  const { data: requestData } = useQuery<{ myRequests: Request[] }>(MY_REQUESTS);
  const { data: toolsData } = useQuery<{ myTools: string[] }>(MY_TOOLS);

  // Staff who open the portal get their desk's lines from the same query; those are My work's.
  const items = (data?.myAttention ?? []).filter((i) => i.audience === 'CUSTOMER');
  const yours = items.filter((i) => i.waitingOn === 'CUSTOMER');
  const rootsToo = items.filter((i) => i.waitingOn === 'ROOT');
  const contracts = contractData?.myContracts ?? [];
  const current = currentContract(contracts);
  const hasTools = (toolsData?.myTools.length ?? 0) > 0;
  const started = contracts.length > 0 || (requestData?.myRequests.length ?? 0) > 0;

  return (
    <>
      <Topbar user={me} start={<span className="crumb" />} />

      <div className="content" data-testid="dashboard">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('home.title')}</h1>
            <p className="t-lead">{t('home.lede')}</p>
          </div>
        </div>

        {/* The three standing actions. A customer with no contract still has the first. */}
        <div className="home-actions" data-testid="home-actions">
          <button className="btn btn-primary" type="button" onClick={() => setComposing(true)}>
            {t('requests.newRequest')}
          </button>
          {current ? (
            <Link className="btn btn-secondary" to={lp(locale, `/app/contracts/${current.id}`)}>
              {t('home.openCurrent', { title: pick(current, 'title', locale) })}
            </Link>
          ) : null}
          {hasTools ? (
            <Link className="btn btn-secondary" to={lp(locale, '/app/tools')}>
              {t('home.openTool')}
            </Link>
          ) : null}
        </div>

        {error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading && !data ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : (
          <>
            {yours.length > 0 ? (
              <section className="home-section" aria-labelledby="home-yours">
                <h2 className="t-h3" id="home-yours">
                  {t('home.yoursTitle')}
                </h2>
                <HomeList items={yours} label={t('home.yoursTitle')} />
              </section>
            ) : null}
            {rootsToo.length > 0 ? (
              <section className="home-section" aria-labelledby="home-roots">
                <h2 className="t-h3" id="home-roots">
                  {t('home.rootsTitle')}
                </h2>
                <p className="t-small muted">{t('home.rootsLede')}</p>
                <HomeList items={rootsToo} label={t('home.rootsTitle')} />
              </section>
            ) : null}
            {items.length === 0 ? (
              <div className="empty" data-testid="home-empty">
                <p className="t-small">{started ? t('home.emptyAllClear') : t('home.emptyNothingYet')}</p>
              </div>
            ) : yours.length === 0 ? (
              <p className="t-small muted" data-testid="home-nothing-yours">
                {t('home.nothingForYou')}
              </p>
            ) : null}
          </>
        )}
      </div>

      {composing ? (
        <NewRequestModal
          onClose={() => setComposing(false)}
          onSubmitted={(request) => {
            setComposing(false);
            navigate(lp(locale, `/app/contracts?request=${request.id}`));
          }}
        />
      ) : null}
    </>
  );
}
