import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { UPDATE_CONTRACT_REF } from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';

/**
 * The contract's reference on the Contract tab (desk UX review item 1, DX3b):
 * generated at creation (`R-1405-001`), changeable here by staff who can
 * author contracts until anything is signed. The API decides what "signed"
 * means (a signature on any revision or amendment); `signed` here only greys
 * the field out for the common case, and a refusal is shown as a sentence.
 */
export default function ContractRefCard({
  contractId,
  value,
  signed,
}: {
  contractId: string;
  value: string;
  signed: boolean;
}) {
  const { t } = useTranslation();
  const [ref, setRef] = useState(value);
  const [update] = useMutation(UPDATE_CONTRACT_REF);

  // DX4 (review 27): saved when the field is left; the API still decides what "signed" means.
  const autosave = useAutosave({
    value: ref.trim(),
    baseline: value,
    valid: (v) => v !== '',
    save: async (v) => {
      await update({ variables: { contractId, ref: v } });
      setRef(v);
    },
    disabled: signed,
    errorText: (err) => {
      const code = errorCode(err);
      const key = `workspace.refError.${code}`;
      return code && t(key) !== key ? t(key) : t('workspace.refError.UNKNOWN');
    },
  });

  return (
    <section className="card editor-card">
      <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="ct-ref">
              {t('desk.colRef')}
            </label>
            <input
              id="ct-ref"
              className="input"
              dir="ltr"
              required
              maxLength={40}
              disabled={signed}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
            <p className="t-caption desk-muted">{signed ? t('workspace.refSigned') : t('workspace.refHelp')}</p>
          </div>
        </div>
        <AutosaveNote autosave={autosave} testId="ref-autosave" />
      </form>
    </section>
  );
}
