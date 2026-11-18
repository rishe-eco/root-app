import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * **The desk's one way to add a thing** (DX6, the founder's walk: "either we have buttons that open a quick form … or the
 * field is already there … in some places we're doing one thing, in some other places the other").
 *
 * The rule: an "Add …" button; pressed, it opens a small inline form with labelled fields and "Add" and "Cancel"
 * buttons. **Enter** in the form submits it (the browser does that for a form with a submit button, so a TitleField's
 * last input needs nothing extra); **Escape** cancels. The form closes and empties itself once the add has succeeded, and
 * stays open with the sentence under its buttons when the add is refused. Every add on the contract workspace and its steps
 * goes through this, so a new one cannot invent a third way.
 *
 * The caller owns the field state (it already did) and passes the fields as children; `onSubmit` throws to refuse, and
 * `onCancel` is where it empties them. `ready` is false while a required field is empty, which disables Add.
 */
export default function InlineAdd({
  label,
  submitLabel,
  testId,
  ready = true,
  busy = false,
  onSubmit,
  onCancel,
  children,
  errorText,
  buttonClassName = 'btn btn-secondary btn-sm',
  openOnMount = false,
}: {
  /** The button that opens the form ("Add an item"). */
  label: string;
  /** The form's own submit button; defaults to "Add". */
  submitLabel?: string;
  testId: string;
  ready?: boolean;
  busy?: boolean;
  /** Rejects with the refusal; resolving closes the form. */
  onSubmit: () => Promise<unknown>;
  /** Empties the caller's fields. */
  onCancel?: () => void;
  children: ReactNode;
  errorText?: (err: unknown) => string;
  buttonClassName?: string;
  openOnMount?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(openOnMount);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus goes into the form when it opens, and back to the button when it closes.
  useEffect(() => {
    if (open && !wasOpen.current) form.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
    if (!open && wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function close() {
    setOpen(false);
    setError(null);
    onCancel?.();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || working) return;
    setError(null);
    setWorking(true);
    try {
      await onSubmit();
      setOpen(false);
    } catch (err) {
      setError(errorText ? errorText(err) : ((err as Error).message ?? String(err)));
    } finally {
      setWorking(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  if (!open) {
    return (
      <div>
        <button ref={opener} type="button" className={buttonClassName} onClick={() => setOpen(true)} data-testid={`${testId}-open`}>
          {label}
        </button>
      </div>
    );
  }
  return (
    <form ref={form} className="card editor-card auth-form inline-add" onSubmit={submit} onKeyDown={onKeyDown} data-testid={testId} aria-label={label}>
      {children}
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={!ready || busy || working} data-testid={`${testId}-submit`}>
          {submitLabel ?? t('inlineAdd.add')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={close} data-testid={`${testId}-cancel`}>
          {t('inlineAdd.cancel')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
