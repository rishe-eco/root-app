/**
 * The shape rules for a customer's request and its thread (journeys build
 * plan J2) — pure, so the resolver and its unit test read one copy (house
 * rule 3).
 *
 * Each check answers with the refusal **code** the resolver throws, or null.
 * Codes rather than messages because the API returns codes and the web turns
 * them into the user's language (house rule 6).
 */

export const REQUEST_TITLE_MAX = 200;
/** A request is a paragraph or three, not a brief — J4's requirements step is
 *  where the long form lives. */
export const REQUEST_BODY_MAX = 5000;
export const MESSAGE_MAX = 5000;
export const ARCHIVE_REASON_MAX = 1000;

/** The two languages the product speaks; `Project.requestLang` is one of them. */
export const REQUEST_LANGS = ['fa', 'en'] as const;
export type RequestLang = (typeof REQUEST_LANGS)[number];

export function checkNewRequest(input: {
  title: string;
  body: string;
  lang: string;
}): 'EMPTY_TITLE' | 'EMPTY_BODY' | 'TOO_LONG' | 'INVALID_LANG' | null {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title === '') return 'EMPTY_TITLE';
  if (body === '') return 'EMPTY_BODY';
  if (title.length > REQUEST_TITLE_MAX || body.length > REQUEST_BODY_MAX) return 'TOO_LONG';
  if (!(REQUEST_LANGS as readonly string[]).includes(input.lang)) return 'INVALID_LANG';
  return null;
}

/** `EMPTY_COMMENT` is the code every other thread in the product already uses
 *  for a blank message (tickets, review comments). */
export function checkRequestMessage(body: string): 'EMPTY_COMMENT' | 'TOO_LONG' | null {
  const trimmed = body.trim();
  if (trimmed === '') return 'EMPTY_COMMENT';
  if (trimmed.length > MESSAGE_MAX) return 'TOO_LONG';
  return null;
}

/** An archived request always says why — the customer is shown it. */
export function checkArchiveReason(reason: string): 'REASON_REQUIRED' | 'TOO_LONG' | null {
  const trimmed = reason.trim();
  if (trimmed === '') return 'REASON_REQUIRED';
  if (trimmed.length > ARCHIVE_REASON_MAX) return 'TOO_LONG';
  return null;
}

/**
 * The thread accepts messages only while the request is open. Converting a
 * request turns its project ACTIVE and archiving turns it ARCHIVED, and in
 * both the conversation moves elsewhere (into the contract, or nowhere): what
 * was said stays readable, and nothing more is added to it.
 */
export function acceptsMessages(status: 'REQUESTED' | 'ACTIVE' | 'ARCHIVED'): boolean {
  return status === 'REQUESTED';
}
