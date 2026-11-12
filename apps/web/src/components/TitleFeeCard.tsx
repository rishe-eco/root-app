import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { UPDATE_CONTRACT_DRAFT, type Contract } from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';

/**
 * The draft's title and fee (V2), shared since CC1 by the desk's Contract tab
 * and the Steps tab's draft step — the founder looked for the title on the
 * step and it was only on the tab. `updateContractDraft` takes both, so the
 * fee travels with every title save: a form with the title alone would send
 * no amount and clear it.
 */

function errorMessage(err: unknown, t: (key: string) => string): string {
  const code = errorCode(err);
  if (code && ['STEP_LOCKED', 'SCHEDULE_IS_GENERATED'].includes(code)) return t(`workspace.error.${code}`);
  return (err as { message?: string })?.message ?? String(err);
}

/** Title and fee. `ref` is shown in the workspace header, not here — it is
 *  frozen at creation (T1) and never editable, so there is no form for it. */
export default function TitleFeeCard({
  contractId,
  draft,
  locked,
}: {
  contractId: string;
  draft: Pick<NonNullable<Contract['draft']>, 'titleFa' | 'titleEn' | 'amount'> | null | undefined;
  /** The agreement is approved (J7): the draft is sealed, the API would refuse. */
  locked: boolean;
}) {
  const { t } = useTranslation();
  const [titleFa, setTitleFa] = useState(draft?.titleFa ?? '');
  const [titleEn, setTitleEn] = useState(draft?.titleEn ?? '');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_CONTRACT_DRAFT);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: { contractId, titleFa, titleEn, amount: amount || null },
      });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  return (
    <section className="card editor-card">
      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="ct-fa">
              {t('workspace.titleFa')}
            </label>
            <input id="ct-fa" className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="ct-en">
              {t('workspace.titleEn')}
            </label>
            <input id="ct-en" className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="ct-amount">
              {t('workspace.amount')}
            </label>
            <input
              id="ct-amount"
              className="input num-latin"
              dir="ltr"
              inputMode="numeric"
              value={amount ?? ''}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading || locked} data-testid="title-fee-save">
            {t('workspace.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
