import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import { APPROVE_CONTRACT, SIGN_CONTRACT } from '@/lib/queries';
import { fullDateTime, instantDate } from '@/lib/format';
import { errorCode } from '@/components/FeedbackPanel';
import AgreementDocument from '@/components/AgreementDocument';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 3 — approve and sign (journeys build plan J7), one panel for both sides.
 *
 * **The customer reads the snapshot, approves, and signs, on one screen** (Q10):
 * the document is `AgreementDocument` — the same component the print route
 * draws — over `contract.revision`, the frozen bytes the signature stands
 * against. **Approve** is `approveContract`, which on this road is the agreement
 * gate and locks steps 1–3 in the same act; once it lands the **Sign** form
 * appears, and `signContract` writes the signature. Between the two the step is
 * locked and still the customer's, which is what the status area says.
 *
 * The buttons are offered only to the contract's own customer and never under
 * view-as-customer (`asCustomer` — that view is read-only by construction, and
 * a control that can only be refused is worse than none). **Every refusal the
 * API can give is a code and is worded here** (`agreement.error.<code>`): the
 * customer is told *what* is not ready — the scope, the plan, the dates, step 1,
 * a note still waiting for Root, or a draft Root has changed since — rather than
 * that something failed.
 *
 * Staff see the same document read-only, with where the agreement stands.
 */

const MIN_SIGN_NAME = 2;

export default function AgreementPanel({ contract, audience, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const revision = contract.revision;
  const [signName, setSignName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approve, { loading: approving }] = useMutation(APPROVE_CONTRACT);
  const [sign, { loading: signing }] = useMutation(SIGN_CONTRACT);
  const busy = approving || signing;

  // Nothing is published, so there is no document to approve — the honest state,
  // not an empty page. (Publishing the draft is step 2b's.)
  if (!revision) {
    return (
      <p className="t-small desk-muted" data-testid="agreement-unpublished">
        {audience === 'customer' ? t('agreement.unpublished.customer') : t('agreement.unpublished.staff')}
      </p>
    );
  }

  const signature = revision.signature;
  const approved = revision.approvedAt !== null;
  // The legacy road's approve and sign are ContractDetail's own sections; this
  // panel only ever *acts* on the new road (it can still be drawn read-only in
  // the desk's Steps tab for a legacy contract).
  const mayAct = audience === 'customer' && !asCustomer && contract.sequence === 'AGREEMENT_FIRST';

  function refusal(err: unknown): string {
    const code = errorCode(err);
    return code && t(`agreement.error.${code}`, { defaultValue: '' }) ? t(`agreement.error.${code}`) : (err as Error).message;
  }

  async function onApprove() {
    setError(null);
    try {
      await approve({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(refusal(err));
    }
  }

  async function onSign(e: FormEvent) {
    e.preventDefault();
    if (signName.trim().length < MIN_SIGN_NAME) return;
    setError(null);
    try {
      await sign({ variables: { contractId: contract.id, typedName: signName } });
    } catch (err) {
      setError(refusal(err));
    }
  }

  return (
    <div className="agreement" data-testid="agreement-panel" data-state={signature ? 'signed' : approved ? 'approved' : 'open'}>
      <p className="sec-help">{t(`agreement.lede.${audience}`)}</p>

      <article className="doc doc-inline" lang={locale} dir={locale === 'fa' ? 'rtl' : 'ltr'}>
        <AgreementDocument contract={contract} revision={revision} />
      </article>

      <div className="agreement-actions">
        {signature ? (
          <div className="sign-done" data-testid="agreement-signed">
            <span className="sign-name">{signature.typedName}</span>
            <span className="t-caption">{t('agreement.signedOn', { date: fullDateTime(signature.signedAt, locale) })}</span>
          </div>
        ) : approved ? (
          <>
            <span className="done-pill" data-testid="agreement-approved">
              {t('agreement.approvedOn', { date: instantDate(revision.approvedAt!, locale) })}
            </span>
            {mayAct ? (
              <form className="sign-row" onSubmit={onSign}>
                <div className="field sign-field">
                  <label className="label" htmlFor="agreement-signname">
                    {t('agreement.signLabel')}
                  </label>
                  <input
                    id="agreement-signname"
                    className="input"
                    placeholder={t('agreement.signPlaceholder')}
                    value={signName}
                    onChange={(e) => setSignName(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  data-testid="agreement-sign"
                  disabled={busy || signName.trim().length < MIN_SIGN_NAME}
                >
                  {t('agreement.signCta')}
                </button>
              </form>
            ) : (
              <p className="t-small desk-muted">{t(`agreement.awaitingSignature.${audience}`)}</p>
            )}
          </>
        ) : mayAct ? (
          <div>
            <p className="t-small desk-muted">{t('agreement.approveHelp')}</p>
            <button type="button" className="btn btn-primary" data-testid="agreement-approve" disabled={busy} onClick={onApprove}>
              {t('agreement.approveCta')}
            </button>
          </div>
        ) : (
          <p className="t-small desk-muted">{t(`agreement.awaitingApproval.${audience}`)}</p>
        )}
        {error ? (
          <p className="error" role="alert" data-testid="agreement-error">
            {error}
          </p>
        ) : null}
      </div>

      {audience === 'customer' ? (
        <p className="t-small">
          <Link to={lp(locale, `/app/contracts/${contract.id}/print`)}>{t('agreement.printLink')}</Link>
        </p>
      ) : null}
    </div>
  );
}
