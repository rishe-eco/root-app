import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * DX4 (desk UX review 27): a card's fields save when you leave them, instead
 * of through a Save button per card. **One hook, no per-card copies.**
 *
 * The card passes what it would send (`value`), what the server holds now
 * (`baseline`), whether that value may be sent yet (`valid`) and the card's own
 * existing mutation (`save`), which takes the card's current values for every
 * field the mutation takes together (so saving the title never clears the fee).
 * `onBlur` goes on the card's form: React's blur bubbles, so leaving any field
 * of the card runs it. If the value differs from what was last saved and is
 * valid, it saves; otherwise nothing happens, which is what makes a blur
 * between two untouched fields free.
 *
 * A checkbox or a select has no blur worth waiting for: they call
 * `commit(next)` from their change handler with the whole next value, since
 * the state they just set has not rendered yet.
 *
 * `status` drives `AutosaveNote`: `saved` shows the polite "Saved" mark and
 * clears itself as soon as the value moves again; `error` carries the message
 * for the line under the card's fields. A save that is already in flight is
 * never doubled: a later blur waits for it and then compares again.
 *
 * **Locked steps:** `disabled` stops it altogether; the card also renders its
 * fields read-only, as it always did, so there is nothing to edit.
 */

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type Autosave = {
  onBlur: () => void;
  commit: (next?: unknown) => void;
  status: AutosaveStatus;
  error: string | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useAutosave<V>({
  value,
  baseline,
  valid = () => true,
  save,
  disabled = false,
  errorText,
}: {
  value: V;
  baseline: V;
  valid?: (v: V) => boolean;
  save: (v: V) => Promise<unknown>;
  disabled?: boolean;
  errorText: (err: unknown) => string;
}): Autosave {
  const latest = useRef({ value, valid, save, disabled, errorText });
  latest.current = { value, valid, save, disabled, errorText };

  const lastSaved = useRef<V>(baseline);
  const inFlight = useRef(false);
  const again = useRef(false);
  // DX4 review: the value a commit asked for while a save was in flight. Dropping it lost a pill pressed during a
  // save — the re-run read the form after the first save had already reset it.
  const queued = useRef<unknown>(undefined);
  const mounted = useRef(true);
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // The server's copy moved (a refetch, another tab): that is the new "saved".
  const baselineKey = JSON.stringify(baseline);
  useEffect(() => {
    lastSaved.current = baseline;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Typing again after "Saved" takes the mark away: it describes the value that was saved.
  const valueKey = JSON.stringify(value);
  useEffect(() => {
    if (!same(value, lastSaved.current)) setStatus((s) => (s === 'saved' ? 'idle' : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const run = useCallback(async (override?: unknown) => {
    const cur = latest.current;
    if (cur.disabled) return;
    if (inFlight.current) {
      again.current = true;
      if (override !== undefined) queued.current = override;
      return;
    }
    const next = (override === undefined ? cur.value : override) as V;
    if (same(next, lastSaved.current) || !cur.valid(next)) return;
    inFlight.current = true;
    setStatus('saving');
    setError(null);
    try {
      await cur.save(next);
      lastSaved.current = next;
      if (mounted.current) setStatus('saved');
    } catch (err) {
      if (mounted.current) {
        setStatus('error');
        setError(latest.current.errorText(err));
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        const next = queued.current;
        queued.current = undefined;
        void run(next);
      }
    }
  }, []);

  const onBlur = useCallback(() => void run(), [run]);
  const commit = useCallback((next?: unknown) => void run(next), [run]);
  return { onBlur, commit, status, error };
}
