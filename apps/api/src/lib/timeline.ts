import type { StepKind } from '@prisma/client';

/**
 * The history rail of a new-road contract (journeys build plan J3, PD-17),
 * **computed from the rows that already carry who and when** — step approvals,
 * published revisions, builds — rather than from a `ChangeLog` of its own.
 * Every L-stage declined to add `ChangeAction` values (house rule 10 makes each
 * cost five files), which leaves `ChangeLog` blind to everything this plan
 * adds; and a second record of the same facts is a second place for them to
 * disagree. `ChangeLog` keeps serving the legacy sequence and the V4 feed
 * exactly as today.
 *
 * Pure (`timeline.test.ts`). Every input row is one that is already visible to
 * the customer — published, approved, signed — so the timeline needs no
 * per-viewer filter beyond the one the resolver applies to the request row
 * (`requestVisibleTo`). If a source is ever added that a customer must not see,
 * it belongs in `lib/visibility.ts` first.
 *
 * ## How a later stage extends this file
 *
 * Add the stage's dated rows to `TimelineInput`, emit an item for each in
 * `timelineFor`, add its kind to `TIMELINE_KINDS` (and the SDL enum), and its
 * sentence to both locale files as `timeline.<KIND>` — `timeline.test.ts` fails
 * on a missing one. Sources still to come: scope proposals decided (J5), the
 * brief handed over (J4), invoices issued and paid (J13), design rounds (J8; the
 * mockup's iterations are in, J9b), demos submitted and approved per phase (J10),
 * delivery (J11).
 */

export const TIMELINE_KINDS = [
  'REQUEST_SUBMITTED',
  'CONTRACT_HANDED_OVER',
  'STEP_APPROVED',
  'REVISION_PUBLISHED',
  'REVISION_APPROVED',
  'CONTRACT_SIGNED',
  'DESIGN_PUBLISHED',
  'BUILD_PUBLISHED',
  'CONTRACT_DELIVERED',
  'MOCKUP_PUBLISHED',
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export type TimelineItem = {
  id: string;
  at: Date;
  kind: TimelineKind;
  /** Which side acted — the customer sees «Root» for any staff member, as the
   *  legacy rail always has, so the row names a side and never a person. */
  by: 'ROOT' | 'CUSTOMER';
  step: StepKind | null;
  phaseNumber: number | null;
  /** A revision version or a build number, where the sentence names one. */
  number: number | null;
};

export type TimelineInput = {
  /** Null when the viewer may not read the request (`requestVisibleTo`). */
  requestedAt: Date | null;
  publishedAt: Date | null;
  customerId: string;
  approvals: Array<{ id: string; step: StepKind; phaseNumber: number | null; approvedAt: Date; approvedById: string }>;
  /** Published revisions only. `approvedAt` and `signedAt` are the customer's acts. */
  contractRevisions: Array<{
    id: string;
    version: number;
    publishedAt: Date;
    approvedAt: Date | null;
    signedAt: Date | null;
  }>;
  designRevisions: Array<{ id: string; version: number; publishedAt: Date }>;
  builds: Array<{ id: string; number: number; publishedAt: Date }>;
  /** J11: when sales closed the contract (`Contract.deliveredAt`). */
  deliveredAt: Date | null;
  /** Published mockup iterations (J9b). `iteration` is the ordinal among the
   *  published ones — "mockup 2" — not the build's number, which skips whenever a
   *  declared draft was never published. Optional so a caller with none passes none. */
  mockupBuilds?: Array<{ id: string; iteration: number; publishedAt: Date }>;
};

/** Newest first — a rail reads from the top. Ties by kind order, then id, so
 *  the order is total and the same on every read. */
export function timelineFor(input: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  const item = (
    id: string,
    at: Date,
    kind: TimelineKind,
    by: TimelineItem['by'],
    extra: Partial<Pick<TimelineItem, 'step' | 'phaseNumber' | 'number'>> = {},
  ) => items.push({ id, at, kind, by, step: null, phaseNumber: null, number: null, ...extra });

  if (input.requestedAt) item('request', input.requestedAt, 'REQUEST_SUBMITTED', 'CUSTOMER');
  if (input.publishedAt) item('handed-over', input.publishedAt, 'CONTRACT_HANDED_OVER', 'ROOT');

  for (const a of input.approvals) {
    item(`approval-${a.id}`, a.approvedAt, 'STEP_APPROVED', a.approvedById === input.customerId ? 'CUSTOMER' : 'ROOT', {
      step: a.step,
      phaseNumber: a.phaseNumber,
    });
  }
  // On the new road one act writes both the AGREEMENT approval and the revision's
  // `approvedAt` (J7: `approveContract`, one transaction, one instant) — a rail that
  // listed "agreement approved" and "contract approved" at the same second would
  // say one thing twice. The approval row is the fuller sentence, so the revision's
  // own line yields to it; a legacy contract has no such row and keeps its line.
  const agreementApprovedAt = new Set(input.approvals.filter((a) => a.step === 'AGREEMENT').map((a) => a.approvedAt.getTime()));
  for (const r of input.contractRevisions) {
    item(`revision-${r.id}`, r.publishedAt, 'REVISION_PUBLISHED', 'ROOT', { number: r.version });
    if (r.approvedAt && !agreementApprovedAt.has(r.approvedAt.getTime())) item(`revision-approved-${r.id}`, r.approvedAt, 'REVISION_APPROVED', 'CUSTOMER', { number: r.version });
    if (r.signedAt) item(`revision-signed-${r.id}`, r.signedAt, 'CONTRACT_SIGNED', 'CUSTOMER', { number: r.version });
  }
  for (const d of input.designRevisions) {
    item(`design-${d.id}`, d.publishedAt, 'DESIGN_PUBLISHED', 'ROOT', { number: d.version });
  }
  for (const b of input.builds) {
    item(`build-${b.id}`, b.publishedAt, 'BUILD_PUBLISHED', 'ROOT', { number: b.number });
  }
  if (input.deliveredAt) {
    item('delivered', input.deliveredAt, 'CONTRACT_DELIVERED', 'ROOT');
  }
  for (const m of input.mockupBuilds ?? []) {
    item(`mockup-${m.id}`, m.publishedAt, 'MOCKUP_PUBLISHED', 'ROOT', { step: 'MOCKUP', number: m.iteration });
  }

  return items.sort(
    (a, b) =>
      b.at.getTime() - a.at.getTime() ||
      TIMELINE_KINDS.indexOf(a.kind) - TIMELINE_KINDS.indexOf(b.kind) ||
      a.id.localeCompare(b.id),
  );
}
