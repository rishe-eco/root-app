/**
 * The dependency board's own small rules (spec §7; build plan L5) — kept
 * beside `lib/build.ts` and `lib/feedback.ts` in spirit (house rule 3: one
 * rule, one file), pure and Prisma-free.
 */

export type DependencyLike = { dueAt: Date | null; verifiedAt: Date | null; notNeeded?: boolean; side?: string | null };

/**
 * "Overdue" is derived, never stored (the same F5 discipline
 * `computeProjectProgress` already holds to for phase progress) — a verified
 * dependency is never overdue regardless of how late the verification came,
 * and an unverified one is overdue the instant its due date passes, with no
 * grace and no separate flag someone has to remember to flip.
 *
 * **DX3a:** a row with no date is never overdue (nobody promised a day), and
 * neither is one marked not needed or with no side yet (nobody owes it). Everything that asks
 * "is it late" — the attention list, the overdue dashboards, the `overdue`
 * field — goes through this one function.
 */
export function isOverdue(dep: DependencyLike, now: Date = new Date()): boolean {
  if (dep.notNeeded || dep.dueAt === null || dep.side === null) return false;
  return dep.verifiedAt === null && dep.dueAt.getTime() < now.getTime();
}

/**
 * Whether the *customer's* board shows this row (DX3a): not the ones nobody
 * needs to provide, and not the ones nobody has yet said whose they are. The
 * customer still reads both in Requirements, which lists every handover item.
 */
export const onCustomerBoard = (dep: { notNeeded: boolean; side: string | null }): boolean =>
  !dep.notNeeded && dep.side !== null;

/**
 * The board's order: soonest due first, the undated last (DX3a), ties by title
 * and then id so the order is total. Mirrors the database ordering
 * (`dueAt ASC NULLS LAST`) for callers that sort rows they already hold.
 */
export function compareBoardRows(
  a: { dueAt: Date | null; titleEn: string; id: string },
  b: { dueAt: Date | null; titleEn: string; id: string },
): number {
  if (a.dueAt === null && b.dueAt !== null) return 1;
  if (a.dueAt !== null && b.dueAt === null) return -1;
  if (a.dueAt !== null && b.dueAt !== null && a.dueAt.getTime() !== b.dueAt.getTime()) {
    return a.dueAt.getTime() - b.dueAt.getTime();
  }
  return a.titleEn.localeCompare(b.titleEn) || a.id.localeCompare(b.id);
}

// --- handover items (DX3a) -----------------------------------------------------

/** The default list's rows a brief's project does not hold yet — what a new brief seeds. */
export function missingHandoverTypes<T extends { key: string; active: boolean }>(
  types: readonly T[],
  existingKeys: ReadonlySet<string>,
): T[] {
  return types.filter((t) => t.active && !existingKeys.has(t.key));
}

/**
 * The order the requirements list reads in, and the snapshot freezes: by the
 * default list's position, then by title. A row with no type (an extra's, a
 * one-off) follows the typed ones, by title. Total over everything the
 * snapshot keeps: two rows that tie on position, both titles and key are
 * identical in the bytes, so which comes first cannot show.
 */
export function orderHandover<T extends { briefKey: string | null; titleEn: string; titleFa: string }>(
  rows: readonly T[],
  position: ReadonlyMap<string, number>,
): T[] {
  const rank = (r: T) => (r.briefKey !== null && position.has(r.briefKey) ? position.get(r.briefKey)! : Number.MAX_SAFE_INTEGER);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.titleEn.localeCompare(b.titleEn) ||
      a.titleFa.localeCompare(b.titleFa) ||
      (a.briefKey ?? '').localeCompare(b.briefKey ?? ''),
  );
}

/**
 * Once the agreement is approved an `inBrief` row is what the customer agreed
 * to: its side, date, not-needed flag and title are frozen and it cannot be
 * deleted. Marking it delivered (verification) is not an edit and is never
 * asked here. Returns whether an update that sets the given fields to the given
 * values would change anything the lock covers — a save that repeats what the
 * row already says is not a change, so a form that resends every field is not
 * refused.
 */
export function changesLockedFields(
  row: { side: string | null; dueAt: Date | null; notNeeded: boolean; titleFa: string; titleEn: string },
  edit: { side?: string | null; dueAt?: Date | null; notNeeded?: boolean; titleFa?: string; titleEn?: string },
): boolean {
  if (edit.side !== undefined && edit.side !== row.side) return true;
  if (edit.dueAt !== undefined && (edit.dueAt?.getTime() ?? null) !== (row.dueAt?.getTime() ?? null)) return true;
  if (edit.notNeeded !== undefined && edit.notNeeded !== row.notNeeded) return true;
  if (edit.titleFa !== undefined && edit.titleFa !== row.titleFa) return true;
  if (edit.titleEn !== undefined && edit.titleEn !== row.titleEn) return true;
  return false;
}

/** A row added only to the board needs both a side and a date (the CHECK
 *  `Dependency_board_row_complete`, said here first so the caller gets a code). */
export const boardRowIsComplete = (row: { side: unknown; dueAt: unknown }): boolean => row.side != null && row.dueAt != null;

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
