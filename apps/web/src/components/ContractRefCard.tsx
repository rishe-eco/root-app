import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { UPDATE_CONTRACT_REF } from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';

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
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [update, { loading }] = useMutation(UPDATE_CONTRACT_REF);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await update({ variables: { contractId, ref: ref.trim() } });
      setRef(ref.trim());
      setSaved(true);
    } catch (err) {
      const code = errorCode(err);
      const key = `workspace.refError.${code}`;
      setError(code && t(key) !== key ? t(key) : t('workspace.refError.UNKNOWN'));
    }
  }

  return (
    <section className="card editor-card">
      <form className="auth-form" onSubmit={onSave}>
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
              onChange={(e) => {
                setRef(e.target.value);
                setSaved(false);
              }}
            />
            <p className="t-caption desk-muted">{signed ? t('workspace.refSigned') : t('workspace.refHelp')}</p>
          </div>
        </div>
        {error ? (
          <p className="error" role="alert" data-testid="ref-error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="t-caption" role="status" data-testid="ref-saved">
            {t('workspace.refSaved')}
          </p>
        ) : null}
        <div>
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={loading || signed || ref.trim() === value}
            data-testid="ref-save"
          >
            {t('workspace.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
