/**
 * The fixtures' calendar, written on 2026-09-30 and moved forward by however many days
 * have passed since, so a commitment due "in five days" is never overdue because the
 * suite ran later (M4 found the first one going overdue on its due day). Wrap a day the
 * fixture means as still ahead; leave a deliberately past or invalid one as written.
 */
export function onDay(iso: string): string {
  const written = Date.UTC(2026, 8, 30);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(Date.parse(`${iso}T00:00:00Z`) + Math.max(0, today - written)).toISOString().slice(0, 10);
}
