import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { dirOf } from '@/i18n';
import { CONTRACT_SUMMARY, type SummaryContract, type User } from '@/lib/queries';
import { pick } from '@/lib/format';
import SummaryDocument from '@/components/SummaryDocument';

/**
 * The printable summary (journeys build plan J11) — the same route-and-sheet
 * pattern as `ContractPrint` and the invoice, through the same `print.css`, and
 * **the same component as the wizard's step 7** (`SummaryDocument`): a paper
 * copy that is drawn by different code from the screen is a paper copy that can
 * disagree with it. What this adds is the letterhead and the strip that rides on
 * every printed sheet — the contract's reference, the signed revision's version
 * and hash (so a loose page says which signed document it summarises), and who
 * it was printed for. The table-footer device is explained in `ContractPrint`.
 *
 * The route is the customer's (`/app/contracts/:id/summary/print`); the API
 * decides what the viewer reads, so a signed-in stranger gets the same
 * "no such contract" as anywhere else.
 */
export default function SummaryPrint() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ contract: SummaryContract | null }>(CONTRACT_SUMMARY, { variables: { id } });

  if (loading && !data) return <div className="content">{t('portal.loading')}</div>;

  const contract = data?.contract;
  const back = (
    <Link className="btn btn-ghost btn-sm" to={lp(locale, `/app/contracts/${id}`)}>
      {t('print.back')}
    </Link>
  );
  if (error || !contract) {
    return (
      <div className="content">
        <div className="empty">
          <p className="t-small">{t('portal.errorTitle')}</p>
        </div>
      </div>
    );
  }
  const summary = contract.summary;
  if (!summary) {
    return (
      <div className="content">
        <div className="empty">
          <p className="t-small">{t('summary.print.unsigned')}</p>
          {back}
        </div>
      </div>
    );
  }

  const verify = (
    <div className="doc-verify">
      <span className="num-latin">{contract.ref}</span>
      <span className="num-latin">
        {t('print.revision')} {summary.agreed.version}
      </span>
      <span className="num-latin doc-verify-hash">
        {summary.agreed.contentHash ? `sha256 ${summary.agreed.contentHash}` : t('print.unsealed')}
      </span>
      <span>{t('print.printedFor', { name: me.name })}</span>
    </div>
  );

  const body = (
    <>
      <header className="doc-head">
        <div className="doc-brand">
          <span className="dot" />
          {t('brand.main')} <span className="doc-brand-sub">{t('brand.sub')}</span>
        </div>
        <div className="doc-kind">{t('summary.print.kind')}</div>
      </header>
      <h1 className="doc-title">{pick(contract, 'title', locale)}</h1>
      <dl className="doc-facts">
        <div className="doc-fact">
          <dt>{t('print.ref')}</dt>
          <dd className="num-latin">{contract.ref}</dd>
        </div>
        <div className="doc-fact">
          <dt>{t('summary.print.customer')}</dt>
          <dd>{contract.customer.clientName ?? contract.customer.name}</dd>
        </div>
      </dl>
      <SummaryDocument summary={summary} />
    </>
  );

  return (
    <div className="printview" data-testid="summary-print">
      <div className="printbar">
        {back}
        <button className="btn btn-primary btn-sm" type="button" onClick={() => window.print()}>
          {t('print.cta')}
        </button>
        <span className="t-caption printbar-hint">{t('print.hint')}</span>
      </div>

      <article className="doc" lang={locale} dir={dirOf(locale)}>
        <table className="doc-sheet">
          <tfoot>
            <tr>
              <td>{verify}</td>
            </tr>
          </tfoot>
          <tbody>
            <tr>
              <td>{body}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  );
}
