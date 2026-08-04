import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { dirOf } from '@/i18n';
import { CONTRACT, type Contract, type User } from '@/lib/queries';
import { formatAmount, fullDateTime, pick } from '@/lib/format';

/**
 * The printable contract — the page a customer turns into a PDF.
 *
 * Two things make this more than a stylesheet over the detail screen.
 *
 * **It renders the revision, not the contract.** Title, fee and articles all
 * come out of `contract.revision`, which the API fills from the frozen
 * snapshot. The identically named fields on Contract are Root's working draft
 * and can already have moved on; printing those would produce a document whose
 * `contentHash` covers different words than the ones on the paper.
 *
 * **The hash is on every page.** The verification strip rides in a table
 * `tfoot`, which browsers repeat per printed sheet — so a page separated from
 * its stack still says which document and which revision it belongs to. See
 * the table below for why it is not a fixed footer.
 *
 * There is deliberately no server-side render behind this. The browser already
 * shapes Persian correctly, which is the hard part of an RTL PDF; when Root
 * needs a PDF it did not ask a customer to produce — to email, or to archive —
 * a headless browser will render *this same route* rather than a second
 * document that could disagree with it.
 */
export default function ContractPrint() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id = '' } = useParams();

  const { data, loading, error } = useQuery<{ contract: Contract | null }>(CONTRACT, {
    variables: { id },
  });

  if (loading && !data) {
    return <div className="content">{t('portal.loading')}</div>;
  }

  const contract = data?.contract;
  if (error || !contract) {
    return (
      <div className="content">
        <div className="empty">
          <p className="t-small">{t('portal.errorTitle')}</p>
        </div>
      </div>
    );
  }

  const back = (
    <Link className="btn btn-ghost btn-sm" to={lp(locale, `/app/contracts/${contract.id}`)}>
      {t('print.back')}
    </Link>
  );

  const revision = contract.revision;

  // Nothing has been published yet, so there is no document to print. Falling
  // back to the draft would hand someone a page that looks like a contract and
  // is not one.
  if (!revision) {
    return (
      <div className="content">
        <div className="empty">
          <p className="t-small">{t('print.unpublished')}</p>
          {back}
        </div>
      </div>
    );
  }

  const title = pick(revision, 'title', locale);
  const amount = formatAmount(revision.amount, locale);
  const signature = revision.signature;
  const client = contract.customer.clientName ?? contract.customer.name;

  const fact = (label: string, value: string, latin = false) => (
    <div className="doc-fact">
      <dt>{label}</dt>
      <dd className={latin ? 'num-latin' : undefined}>{value}</dd>
    </div>
  );

  /*
   * The two halves of the sheet are lifted out of the markup below so the
   * table that frames them stays readable as what it is: a printing device,
   * not part of the document.
   *
   * The strip repeats on every sheet, via that table's tfoot. `contentHash` is
   * what a signature attests to, so a page carrying it can be checked against
   * the record; a page without it is just paper. An unsealed revision says so,
   * rather than showing a blank and implying a verification it cannot offer.
   */
  const verify = (
    <div className="doc-verify">
      <span className="num-latin">{contract.ref}</span>
      <span className="num-latin">
        {t('print.revision')} {revision.version}
      </span>
      <span className="num-latin doc-verify-hash">
        {revision.contentHash
          ? `sha256 ${revision.contentHash}`
          : t('print.unsealed')}
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
        <div className="doc-kind">{t('print.kind')}</div>
      </header>

      <h1 className="doc-title">{title}</h1>

      <dl className="doc-facts">
        {fact(t('print.ref'), contract.ref, true)}
        {fact(t('print.revision'), String(revision.version), true)}
        {revision.publishedAt
          ? fact(t('print.published'), fullDateTime(revision.publishedAt, locale))
          : null}
        {amount ? fact(t('print.fee'), t('print.toman', { amount }), true) : null}
      </dl>

      <section className="doc-sec doc-parties">
        <h2 className="doc-h">{t('print.parties')}</h2>
        <div className="doc-party">
          <span className="doc-party-role">{t('print.provider')}</span>
          <span className="doc-party-name">{t('brand.main')}</span>
        </div>
        <div className="doc-party">
          <span className="doc-party-role">{t('print.client')}</span>
          <span className="doc-party-name">{client}</span>
        </div>
      </section>

      <section className="doc-sec">
        <h2 className="doc-h">{t('print.articles')}</h2>
        {contract.articles.map((a) => {
          const body = pick(a, 'body', locale);
          return (
            <div className="doc-art" key={a.id}>
              <h3 className="doc-art-h">
                <span className="num-latin">{a.number}.</span> {pick(a, 'title', locale)}
              </h3>
              {body ? (
                <p className="doc-art-body">{body}</p>
              ) : (
                <p className="doc-art-body doc-art-empty">{t('print.articleEmpty')}</p>
              )}
            </div>
          );
        })}
      </section>

      {/* Amendments — changes made after signature, each standing on its own
          hash and its own signature. */}
      {revision.amendments.length > 0 ? (
        <section className="doc-sec">
          <h2 className="doc-h">{t('print.amendments')}</h2>
          {revision.amendments.map((am) => (
            <div className="doc-art" key={am.id}>
              <h3 className="doc-art-h">
                <span className="num-latin">A{am.ordinal}.</span> {pick(am, 'title', locale)}
              </h3>
              <p className="doc-art-body">{pick(am, 'body', locale)}</p>
              <p className="doc-art-meta num-latin">
                {t('print.hash')} {am.contentHash}
              </p>
              {am.signature ? (
                <p className="doc-art-meta">
                  {t('print.signedBy', { name: am.signature.typedName })} ·{' '}
                  {fullDateTime(am.signature.signedAt, locale)}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="doc-sec doc-signature">
        <h2 className="doc-h">{t('print.signature')}</h2>
        {signature ? (
          <>
            <p className="doc-sign-name">{signature.typedName}</p>
            <p className="doc-sign-meta">
              {t('print.signedOn', { date: fullDateTime(signature.signedAt, locale) })}
            </p>
            <p className="doc-sign-meta">{t('print.signedMethod')}</p>
          </>
        ) : (
          <p className="doc-sign-meta doc-art-empty">{t('print.unsigned')}</p>
        )}
      </section>
    </>
  );
  return (
    <div className="printview">
      {/* Screen only — a toolbar has no business on the paper. */}
      <div className="printbar">
        {back}
        <button className="btn btn-primary btn-sm" type="button" onClick={() => window.print()}>
          {t('print.cta')}
        </button>
        <span className="t-caption printbar-hint">{t('print.hint')}</span>
      </div>

      <article className="doc" lang={locale} dir={dirOf(locale)}>
        {/*
          A table, and not for layout in the usual sense: `tfoot` is the only
          construct browsers repeat on every printed sheet *and* reserve space
          for. `position: fixed` also repeats, but it paints over the content
          rather than displacing it — which put the verification strip on top
          of the signature — and pushing it into the page margin gets it
          clipped away entirely. Verified against Chrome 127.

          One row, one cell, both directions of the table left alone; the
          document inside it is ordinary flow.
        */}
        {/*
          A table, and not for layout in the usual sense: `tfoot` is the
          only construct browsers repeat on every printed sheet *and*
          reserve space for. `position: fixed` also repeats, but it paints
          over the content instead of displacing it — which put the
          verification strip on top of the signature — and pushing it into
          the page margin gets it clipped away entirely. Verified against
          Chrome 127.
        */}
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
