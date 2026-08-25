import type { User } from './queries';

export type Role = 'CUSTOMER' | 'ADMIN' | 'CONTRIBUTOR' | 'REVIEWER';

/**
 * Mirrors the server's `lib/capabilities.ts`. The UI branches on these and
 * never on `roles` — a person may hold several, so any `role === '…'` on this
 * side is wrong in the same way it was on the server, only quieter.
 */
export type Capability =
  | 'contracts.manage'
  | 'customers.manage'
  | 'library.write'
  | 'library.publish'
  | 'library.editTree'
  | 'review.participate'
  | 'review.admin'
  | 'apiTokens.manage';

export const can = (user: Pick<User, 'capabilities'> | null | undefined, cap: Capability) =>
  user?.capabilities.includes(cap) ?? false;

/**
 * Staff is "holds any capability at all", and that reads straight off the
 * model rather than being a special case: CUSTOMER maps to the empty
 * capability set (api/src/lib/capabilities.ts), so a customer has none and
 * everyone who is anything else has at least one.
 */
export const isStaff = (u: Pick<User, 'capabilities'> | null | undefined) =>
  (u?.capabilities.length ?? 0) > 0;

/** Where signing in puts you. Someone holding both lands on the desk and has a link to the portal. */
export const homeFor = (u: Pick<User, 'capabilities'> | null | undefined) =>
  isStaff(u) ? '/desk' : '/app/contracts';
