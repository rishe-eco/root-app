import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { UPDATE_CONTRACT_DRAFT, type Contract } from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';
import MoneyReadout from '@/components/MoneyReadout';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';

/**
 * The draft's title and fee (V2). Shared since CC1 by the desk's Contract tab
 * and the Steps tab's draft step; since DX1 (desk UX review 15) it is on the
 * Contract tab alone again — the tab holds the contract's own settings, and the
 * duplication between the two places is gone. `updateContractDraft` takes both,
 * so the fee travels with every title save: a form with the title alone would
 * send no amount and clear it. The fee shows a grouped readout under it (review 23).
 */

function errorMessage(err: unknown, t: (key: string) => string): string {
  const code = errorCode(err);
  if (code && ['STEP_LOCKED', 'SCHEDULE_IS_GENERATED', 'TITLE_REQUIRED'].includes(code)) return t(`workspace.error.${code}`);
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
  const [update] = useMutation(UPDATE_CONTRACT_DRAFT);

  // DX4 (review 27): the card saves when a field is left. `updateContractDraft` takes the title
  // and the fee together, so each save sends both as they stand.
  const autosave = useAutosave({
    value: { titleFa, titleEn, amount: amount || '' },
    baseline: { titleFa: draft?.titleFa ?? '', titleEn: draft?.titleEn ?? '', amount: draft?.amount ?? '' },
    valid: (v) => hasOneTitle(v.titleFa, v.titleEn),
    save: (v) => update({ variables: { contractId, titleFa: v.titleFa, titleEn: v.titleEn, amount: v.amount || null } }),
    disabled: locked,
    errorText: (err) => errorMessage(err, t),
  });

  return (
    <section className="card editor-card">
      <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
        <TitleField
          idBase="ct"
          testId="contract-title"
          fa={titleFa}
          en={titleEn}
          disabled={locked}
          onChange={(v) => {
            setTitleFa(v.fa);
            setTitleEn(v.en);
          }}
        />
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
              readOnly={locked}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <MoneyReadout value={amount} testId="amount-readout" />
          </div>
        </div>
        <AutosaveNote autosave={autosave} testId="title-fee-autosave" />
      </form>
    </section>
  );
}
