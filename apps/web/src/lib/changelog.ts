import type { ChangeAction } from './queries';

/**
 * The change-log sentence builder, shared by the portal and the desk (V4.md
 * T5). One map, one place — `changeAction.test.ts` parses the `const key =
 * {...}[e.action];` block below out of source text to prove every
 * `ChangeAction` renders as a sentence rather than "log.undefined"; a second
 * copy anywhere else would be invisible to that test. If this file moves,
 * update the test's `actionKeyMap()` to match.
 */

/** Structural rather than i18next's TFunction — all this needs is the call shape. */
export type T = (key: string, opts?: Record<string, unknown>) => string;

export type LogEntry = {
  action: ChangeAction;
  arg: string | null;
};

/** action -> the log.* key. Exported on its own so a caller that only needs to know *which* sentence would render (not render it) has that without a `t`. */
export function actionLogKey(e: LogEntry): string {
  const key = {
    CREATED: 'created',
    PUBLISHED: 'published',
    CHOSE_CONCEPT: 'chose',
    APPROVED_PAGE: 'approvedPage',
    UNAPPROVED_PAGE: 'unapprovedPage',
    DESIGN_COMPLETE: 'designComplete',
    APPROVED_CONTRACT: 'approvedContract',
    SIGNED: 'signed',
    COMMENTED: 'comment',
    SCOPE_ON: 'scopeOn',
    SCOPE_OFF: 'scopeOff',
    STATUS_CHANGED: 'statusChanged',
    CONTRACT_REVISED: 'contractRevised',
    DESIGN_REVISED: 'designRevised',
    CONTRACT_AMENDED: 'contractAmended',
    RE_APPROVED: 'reApproved',
    RE_SIGNED: 'reSigned',
    AMENDMENT_SIGNED: 'amendmentSigned',
    AMENDMENT_APPROVED: 'amendmentApproved',
  }[e.action];
  return key;
}

export type LogHelpers = {
  /**
   * A human label for a page-approval arg. Optional because a caller reading
   * many contracts at once (the desk's activity feed, V4 T1) has no single
   * contract's concepts loaded to look one up in — falling back to the
   * global `pages.*` namespace is the honest answer there, not a guess.
   */
  labelForPage?: (key: string) => string | null;
  /** Same reasoning for a scope-item arg; falls back to the raw key, since there is no global scope-item label namespace. */
  labelForScope?: (key: string) => string | null;
};

/** The one variable part of the sentence, localized here rather than stored. */
function argFor(e: LogEntry, t: T, helpers: LogHelpers): string {
  if (e.action === 'STATUS_CHANGED') return e.arg ? t(`status.${e.arg}`) : '';
  if (e.action === 'APPROVED_PAGE' || e.action === 'UNAPPROVED_PAGE') {
    if (!e.arg) return '';
    return helpers.labelForPage?.(e.arg) ?? t(`pages.${e.arg}`, { defaultValue: e.arg });
  }
  if (e.action === 'SCOPE_ON' || e.action === 'SCOPE_OFF') {
    if (!e.arg) return '';
    return helpers.labelForScope?.(e.arg) ?? e.arg;
  }
  return e.arg ?? '';
}

/** A change-log entry, rendered as a sentence in the reader's language. */
export function logText(e: LogEntry, t: T, helpers: LogHelpers = {}): string {
  return t(`log.${actionLogKey(e)}`, { arg: argFor(e, t, helpers) });
}
