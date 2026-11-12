import type { User } from '@prisma/client';

/**
 * US1 — what "anonymized" means, in one file (house rule 3).
 *
 * An account with history cannot be deleted: signatures, the change log,
 * answers, approvals and a customer's contracts all point at it, and most of
 * those edges are `Restrict` on purpose. So the dangerous half of "delete" is
 * **erasure in place**: the row stays, everything that points at it keeps
 * pointing, and nothing on it identifies the person any more.
 *
 * **Why a sentinel email, not a column.** `User_has_identifier` (J1) requires
 * a phone or an email on every row, and erasure is exactly the act of removing
 * both. The email becomes `erased-<id>@erased.invalid`: unique (it carries the
 * id), unroutable (`.invalid` is reserved by RFC 2606 and resolves nowhere),
 * and recognisable — so "is this account erased" is a fact read off the row
 * with no migration, and no code outside this file spells the domain.
 */

export const ERASED_DOMAIN = 'erased.invalid';

/** Bilingual on purpose: the row has one name, read on Persian and English
 *  pages alike, and the desk shows its own translated label instead. */
export const ERASED_NAME = 'کاربر حذف‌شده · Deleted user';

export const erasedEmailFor = (userId: string) => `erased-${userId}@${ERASED_DOMAIN}`;

export function isErased(user: Pick<User, 'email'>): boolean {
  return !!user.email && user.email.endsWith(`@${ERASED_DOMAIN}`);
}
