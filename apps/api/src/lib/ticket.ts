/**
 * Tickets and the three channels' own small rules (spec §5, §6; build plan
 * L4) — kept beside `lib/feedback.ts` and `lib/build.ts` in spirit (house
 * rule 3: one rule, one file), pure and Prisma-free.
 */

export type TicketTypeLike = 'CHANGE_REQUEST' | 'BUG' | 'QUESTION' | 'ADMIN_REQUEST';

/**
 * Spec §5: admin requests "land in support, get a polite boundary and a
 * pointer to a guide, and get counted." Nobody arrives already knowing their
 * request is one Root does not sell — that is Root's own classification,
 * applied after the fact via `moveTicketChannel` (spec §5's "an item entering
 * the wrong channel is moved, not handled"). So a customer's own
 * `createTicket` may never choose ADMIN_REQUEST directly; staff may, for a
 * ticket logged on a customer's behalf (a phone call, say) where the
 * classification is already obvious.
 */
export function canChooseTicketType(isStaff: boolean, type: TicketTypeLike): boolean {
  return isStaff || type !== 'ADMIN_REQUEST';
}

/**
 * The page a feedback item targets, snapshotted for a ticket's brief (build
 * plan L4) — a demo page's own label, or (for a frame-line target) the
 * line's own text, which already describes what is true about the
 * underlying scope item. Never both; `FeedbackItem_exactly_one_target`
 * already holds that a target is exactly one of the two.
 */
export function briefPageFromTarget(target: {
  demoPage: { labelFa: string; labelEn: string } | null;
  frameLine: { textFa: string; textEn: string } | null;
}): { fa: string; en: string } {
  if (target.demoPage) return { fa: target.demoPage.labelFa, en: target.demoPage.labelEn };
  if (target.frameLine) return { fa: target.frameLine.textFa, en: target.frameLine.textEn };
  // Unreachable given the schema's own CHECK, but a total function is worth
  // more than a thrown error two lines from here.
  return { fa: '', en: '' };
}

/**
 * The annotation — the reviewer's own words, verbatim, oldest first. Not a
 * paraphrase and not a summary: "carrying its page, its annotation, its
 * current state and its desired state" (build plan L4) lists the annotation
 * as a fact already in hand, never something this stage synthesizes.
 */
export function compileAnnotation(comments: readonly { author: { name: string }; body: string }[]): string {
  return comments.map((c) => `${c.author.name}: ${c.body}`).join('\n\n');
}
