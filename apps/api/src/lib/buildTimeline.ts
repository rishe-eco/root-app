/**
 * The build timeline (journeys build plan J10; journeys Q22, "build-period
 * visibility"): between the design's (or the mockup's) approval and the first
 * demo the customer's wizard has no step to look at — **that gap is where Nahal's
 * eighteen silent days happened** (F6). The timeline is what fills it: this
 * contract's phases in order, each with the builds Root has *published* and the
 * dates that go with them, so "what is happening to my site" has an answer that
 * is a list of dated facts, never a status someone typed.
 *
 * Derived on read from rows that already exist — `Phase`, published SITE `Build`s,
 * the demo's `publishedAt` and the DEMO `StepApproval` — and stored nowhere (the
 * journeys file's rule for everything the customer reads about progress).
 *
 * Pure: no database, no clock. `Contract.buildTimeline` (`resolvers/demoStep.ts`)
 * loads the rows and hands them here.
 */

export type TimelinePhaseRow = {
  id: string;
  number: number;
  titleFa: string;
  titleEn: string;
  plannedEndAt: Date | null;
  /** SITE demos of the phase that have been published — any number, oldest first
   *  does not matter: the earliest is "when the customer first saw it". */
  demoPublishedAts: Date[];
  /** SITE builds of the phase that have been published. Unpublished ones are
   *  never passed in: a build the customer has not been told about is not a fact
   *  they can read. */
  builds: Array<{ id: string; number: number; publishedAt: Date }>;
};

export type TimelineApprovalRow = { phaseId: string | null; approvedAt: Date };

export type BuildTimelineEntry = {
  phaseId: string;
  number: number;
  titleFa: string;
  titleEn: string;
  plannedEndAt: Date | null;
  /** When the phase's demo first reached the customer; null until then. */
  demoPublishedAt: Date | null;
  /** The customer's acceptance of the phase (`approveDemo`); null until then. */
  acceptedAt: Date | null;
  /** Published builds, oldest first — the order they were shown in. */
  builds: Array<{ id: string; number: number; publishedAt: Date }>;
};

const earliest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : dates.reduce((a, b) => (b.getTime() < a.getTime() ? b : a));

export function buildTimelineOf(phases: readonly TimelinePhaseRow[], approvals: readonly TimelineApprovalRow[]): BuildTimelineEntry[] {
  return [...phases]
    .sort((a, b) => a.number - b.number)
    .map((p) => ({
      phaseId: p.id,
      number: p.number,
      titleFa: p.titleFa,
      titleEn: p.titleEn,
      plannedEndAt: p.plannedEndAt,
      demoPublishedAt: earliest(p.demoPublishedAts),
      acceptedAt: earliest(approvals.filter((a) => a.phaseId === p.id).map((a) => a.approvedAt)),
      builds: [...p.builds].sort(
        (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.number - b.number,
      ),
    }));
}
