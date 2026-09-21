/**
 * The dependency board's own small rules (spec §7; build plan L5) — kept
 * beside `lib/build.ts` and `lib/feedback.ts` in spirit (house rule 3: one
 * rule, one file), pure and Prisma-free.
 */

export type DependencyLike = { dueAt: Date; verifiedAt: Date | null };

/**
 * "Overdue" is derived, never stored (the same F5 discipline
 * `computeProjectProgress` already holds to for phase progress) — a verified
 * dependency is never overdue regardless of how late the verification came,
 * and an unverified one is overdue the instant its due date passes, with no
 * grace and no separate flag someone has to remember to flip.
 */
export function isOverdue(dep: DependencyLike, now: Date = new Date()): boolean {
  return dep.verifiedAt === null && dep.dueAt.getTime() < now.getTime();
}

export type VerifyInputLike = { note?: string | null };

/**
 * Build plan L5's banked trap, mirrored here for a resolver-level error
 * before the database's own CHECK (`Dependency_verified_both_or_neither`)
 * would refuse it with a less specific code. "They said we have a host" is
 * what failed at the engagement this is drawn from; a verification with no
 * recorded *how* would rebuild exactly that promise.
 */
export function verificationRequiresNote(input: VerifyInputLike): boolean {
  return !!input.note?.trim();
}
