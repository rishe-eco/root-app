/**
 * Root's private notes on a contract (journeys build plan J3) — the one small
 * rule, kept pure so it is testable without a database. Who may read or write
 * a note is `mayReadInternalNotes` in `lib/visibility.ts`, not here.
 */

/** Long enough for a real hand-over note, short enough that a paste of a
 *  whole document is refused rather than stored. */
export const INTERNAL_NOTE_MAX = 4000;

/** `EMPTY_COMMENT` is the code every thread in the product already uses for a
 *  message with nothing in it (`addComment`, `postRequestMessage`). */
export function checkInternalNote(body: string): 'EMPTY_COMMENT' | 'TOO_LONG' | null {
  const trimmed = body.trim();
  if (trimmed === '') return 'EMPTY_COMMENT';
  if (trimmed.length > INTERNAL_NOTE_MAX) return 'TOO_LONG';
  return null;
}
