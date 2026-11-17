import { useTranslation } from 'react-i18next';
import type { Autosave } from '@/lib/useAutosave';

/**
 * The "Saved" mark and the inline error of a card that saves on blur (DX4,
 * review 27). The status element is always in the page, empty until there is
 * something to say, because a live region only announces text that changes
 * inside one that already exists.
 */
export default function AutosaveNote({ autosave, testId = 'autosave' }: { autosave: Autosave; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="autosave-note" data-testid={testId}>
      <span className="autosave-mark t-caption" role="status" aria-live="polite" data-testid={`${testId}-status`}>
        {autosave.status === 'saved' ? t('workspace.autosaved') : autosave.status === 'saving' ? t('workspace.autosaving') : ''}
      </span>
      {autosave.error ? (
        <p className="error" role="alert" data-testid={`${testId}-error`}>
          {autosave.error}
        </p>
      ) : null}
    </div>
  );
}
