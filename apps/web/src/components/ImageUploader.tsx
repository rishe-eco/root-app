import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadDesignImage, DESIGN_IMAGE_ACCEPT, UploadFailure } from '@/lib/upload';

/**
 * A design image: pick a file, upload it to the contract (`POST /upload`, class
 * `DESIGN_IMAGE`), then hand the new file's id to `onAttach`, which is the
 * mutation that puts it on a concept, a page or a palette item.
 *
 * Extracted from the legacy design tab (journeys build plan J8) so the new
 * road's design panel — wireframe pages and palette images — uses the very same
 * two-step flow and the same retry: **the file is already uploaded when the
 * attach fails** (T3), so a retry attaches it again instead of uploading twice.
 */

export function errorMessage(err: unknown): string {
  if (err instanceof UploadFailure) return err.i18nKey;
  return (err as { message?: string })?.message ?? String(err);
}

export default function ImageUploader({
  contractId,
  currentUrl,
  onAttach,
}: {
  contractId: string;
  currentUrl: string | null;
  onAttach: (fileId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFileId, setPendingFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function attach(fileId: string) {
    setBusy(true);
    setError(null);
    try {
      await onAttach(fileId);
      setPendingFileId(null);
    } catch (err) {
      // T3: the file is already uploaded — keep its id so a retry does not
      // re-upload. Only the attach step is retried.
      setPendingFileId(fileId);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadDesignImage(contractId, file);
      await attach(uploaded.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="editor-card">
      <div className="thumb">
        {currentUrl ? <img src={currentUrl} alt="" /> : <span className="t-caption">{t('workspace.noImage')}</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={DESIGN_IMAGE_ACCEPT}
        style={{ display: 'none' }}
        onChange={onPick}
        data-testid="image-input"
      />
      <div className="editor-card-actions">
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          {t('workspace.uploadImage')}
        </button>
        {pendingFileId ? (
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => attach(pendingFileId)} disabled={busy}>
            {t('workspace.retryAttach')}
          </button>
        ) : null}
      </div>
      {error ? <p className="error">{t(error)}</p> : null}
    </div>
  );
}
