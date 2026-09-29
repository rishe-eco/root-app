import type { StepKind, User } from '@prisma/client';
import { can, type Capability } from './capabilities.js';

/**
 * The feedback rule, written once (journeys build plan S2, house rule 3;
 * journeys file §3.1). Every step that takes feedback — the brief, the scope,
 * the draft, the design, the mockup, the demo — closes the same way:
 *
 * 1. **Root resolves.** An item is not the customer's to close; it is answered,
 *    and marked addressed, or declined with its reason, by Root.
 * 2. **The customer can reopen** a resolved item — by commenting on it — until
 *    the step is approved (`reopensOnComment`).
 * 3. **Approval requires nothing unresolved** and no answer waiting for sales
 *    (`stepBlockers`).
 * 4. **Approval accepts everything at once and locks the step**
 *    (`acceptanceOnApproval`, written by `lib/stepApproval.ts` and nothing
 *    else).
 *
 * Pure functions over plain rows — no database, no clock — so each clause is
 * table-tested (`feedbackRules.test.ts`) and the four mutations that enforce
 * them (`resolvers/feedback.ts`, `builds.ts`, `tickets.ts`) import them
 * instead of each holding a private copy. `checkInterception` (D4, dumb by
 * design) stays where L3 put it, in `lib/feedback.ts`.
 *
 * This is the one file where "may this staff member's answer reach the
 * customer directly" is decided, and it is decided over **capabilities**
 * (PD-3): a person holding two roles gets the union, as house rule 1 intends.
 */

// --- who answers, and how ------------------------------------------------

export type AnswerRoute = 'DIRECT' | 'NEEDS_APPROVAL';

/** The steps that take feedback at all. AGREEMENT is approved, not discussed,
 *  and SUMMARY "never takes input" (J3) — the CHECK in the database refuses a
 *  row for either. */
export const FEEDBACK_STEPS: readonly StepKind[] = ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'DESIGN', 'MOCKUP', 'DEMO'];

export const takesFeedback = (step: StepKind): boolean => FEEDBACK_STEPS.includes(step);

/**
 * The answer matrix (PD-3, journeys §7.3), as the capability that makes an
 * answer in each step direct. Steps 1–3 share `answers.direct.agreement`
 * because that is one job — sales' — and the plan's matrix has one row for
 * them. A step with no row has no direct route: it fails closed.
 */
const DIRECT_CAPABILITY: Partial<Record<StepKind, Capability>> = {
  REQUIREMENTS: 'answers.direct.agreement',
  SCOPE: 'answers.direct.agreement',
  DRAFT: 'answers.direct.agreement',
  AGREEMENT: 'answers.direct.agreement',
  DESIGN: 'answers.direct.design',
  MOCKUP: 'answers.direct.mockup',
  DEMO: 'answers.direct.demo',
};

/** The capability behind a step's direct route — also how "everyone who
 *  could have answered this directly" is found for a notification. */
export const directCapabilityFor = (step: StepKind): Capability | null => DIRECT_CAPABILITY[step] ?? null;

/**
 * PD-3: `can(user, answers.direct.<step>) ? DIRECT : NEEDS_APPROVAL`. Holding
 * `feedback.answer` is a separate question (may you answer at all); this says
 * whether what you write reaches the customer at once or waits in sales' queue.
 */
export function answerRoute(user: Pick<User, 'roles'>, step: StepKind): AnswerRoute {
  const capability = directCapabilityFor(step);
  return capability !== null && can(user, capability) ? 'DIRECT' : 'NEEDS_APPROVAL';
}

/**
 * "`resolution IS NULL OR author is staff`" — the CHECK the plan says cannot be
 * written in SQL, because "staff" is a function of a role set, not a column.
 * Held here: only someone who may answer can attach a resolution to a
 * comment. The customer's own comments never carry one (the resolver never
 * sets it), and `s2.test.ts` asserts the database never holds one that
 * breaks this.
 */
export function mayCarryResolution(author: Pick<User, 'roles'>): boolean {
  return can(author, 'feedback.answer');
}

// --- statuses ------------------------------------------------------------

export type ItemStatus = 'OPEN' | 'ADDRESSED' | 'DECLINED' | 'MOVED' | 'ACCEPTED';

/** Resolved by Root: anything that is not waiting on Root. */
export const isResolved = (status: ItemStatus): boolean => status !== 'OPEN';

/**
 * §3.1's reversal of L3b §2.5: a new comment on an item Root has resolved
 * reopens it — `ADDRESSED`, `DECLINED` *and* `MOVED` (a change ticket the
 * customer disagrees with is a disagreement like any other). `ACCEPTED` never
 * reopens: it only exists once the step is approved, and an approved step
 * takes no comments at all (`STEP_LOCKED`), so the case cannot arise — and if
 * it ever did, silently un-accepting is the wrong answer.
 */
export function reopensOnComment(status: ItemStatus): boolean {
  return status === 'ADDRESSED' || status === 'DECLINED' || status === 'MOVED';
}

// --- approving a step ----------------------------------------------------

export type StepBlockers = { openItemIds: string[]; pendingAnswerIds: string[] };

/**
 * What stops a step's approval (§3.1 rule 3: "zero unresolved items — no carry
 * forward, no exceptions"). Two things: items still `OPEN` (including one a
 * build carried forward — `CARRIED_FORWARD` writes nothing to the status, so
 * the item simply stays open), and **answers waiting for sales**, because a
 * pending answer is Root's reply not yet given — approving over it would lock
 * the step with a question the customer was never told was answered.
 * A pending answer on an item that is already resolved (superseded by a later
 * direct one) blocks too: sales declines it as moot, which is one click and
 * leaves the record straight.
 */
export function stepBlockers(
  items: ReadonlyArray<{ id: string; status: ItemStatus }>,
  pendingAnswers: ReadonlyArray<{ id: string }>,
): StepBlockers {
  return {
    openItemIds: items.filter((i) => i.status === 'OPEN').map((i) => i.id),
    pendingAnswerIds: pendingAnswers.map((a) => a.id),
  };
}

/** The refusal code for a non-empty blocker set, or null. Open items first:
 *  they are the customer's to know about, the queue is Root's own. */
export function blockerCode(b: StepBlockers): 'STEP_HAS_OPEN_FEEDBACK' | 'STEP_HAS_PENDING_ANSWERS' | null {
  if (b.openItemIds.length > 0) return 'STEP_HAS_OPEN_FEEDBACK';
  if (b.pendingAnswerIds.length > 0) return 'STEP_HAS_PENDING_ANSWERS';
  return null;
}

/**
 * The writes an approval performs on the step's items: `ADDRESSED → ACCEPTED`,
 * and `DECLINED` / `MOVED` keep their status but gain the acceptance (the
 * customer accepted Root's *no*, and the move) — so `acceptedAt` on every
 * resolved item reads "the customer closed the loop", whichever way Root
 * resolved it. Items already accepted are left alone, so an approval is
 * idempotent about what an earlier one wrote; an `OPEN` one is never touched
 * (`stepBlockers` refuses before this is asked, and if it is asked anyway,
 * accepting an unanswered item would be the silent-in-Root's-favour failure
 * L3b's two-fields rule exists to prevent).
 *
 * The caller stamps `acceptedAt` / `acceptedById` — this decides only *which
 * items, and what status*.
 */
export function acceptanceOnApproval(
  items: ReadonlyArray<{ id: string; status: ItemStatus; acceptedAt: Date | null }>,
): Array<{ id: string; status: 'ACCEPTED' | 'DECLINED' | 'MOVED' }> {
  const writes: Array<{ id: string; status: 'ACCEPTED' | 'DECLINED' | 'MOVED' }> = [];
  for (const item of items) {
    if (item.acceptedAt !== null || item.status === 'ACCEPTED') continue;
    if (item.status === 'ADDRESSED') writes.push({ id: item.id, status: 'ACCEPTED' });
    else if (item.status === 'DECLINED' || item.status === 'MOVED') writes.push({ id: item.id, status: item.status });
  }
  return writes;
}

// --- which answer governs -------------------------------------------------

export type ThreadEntry = {
  id: string;
  createdAt: Date;
  /** The customer's own comment (a reopening), or staff. */
  byCustomer: boolean;
  resolution: 'ADDRESSED' | 'DECLINED' | null;
  approval: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DECLINED';
};

/**
 * "The item's state follows the latest *visible* resolving answer" (S2). An
 * item can collect several answers, pending or not, so approving an old one
 * must not overwrite a newer verdict: a pending answer, when sales approves
 * it, sets the item's state **only if nothing visible and later has already
 * spoken** — a later resolving answer (direct or approved), or a later
 * comment by the customer (which reopened the item and is still unanswered).
 * Otherwise approval publishes the answer's words and leaves the state alone;
 * "moot", as the plan calls it, without a special case.
 *
 * Ordering is by creation time — when the answer was *written*, not when it was
 * approved — with the id as the tiebreak so the answer is total.
 */
export function answerGoverns(answerId: string, thread: readonly ThreadEntry[]): boolean {
  const answer = thread.find((e) => e.id === answerId);
  if (!answer) return false;
  const later = (e: ThreadEntry) =>
    e.createdAt.getTime() > answer.createdAt.getTime() ||
    (e.createdAt.getTime() === answer.createdAt.getTime() && e.id > answer.id);
  return !thread.some(
    (e) =>
      e.id !== answer.id &&
      later(e) &&
      (e.byCustomer || (e.resolution !== null && (e.approval === 'NOT_REQUIRED' || e.approval === 'APPROVED'))),
  );
}

// --- anchors ---------------------------------------------------------------

/** Every column a step may anchor to. All nullable; `general` is the one
 *  anchor every step has. The twin of `FeedbackItem_anchor_matches_step`. */
export type FeedbackAnchor = {
  general: boolean;
  briefField: string | null;
  anchorScopeItemId: string | null;
  contractRevisionId: string | null;
  articleNumber: number | null;
  designRevisionId: string | null;
  conceptId: string | null;
  pageDesignId: string | null;
  paletteItemId: string | null;
  demoId: string | null;
  demoPageId: string | null;
  frameLineId: string | null;
};

export const NO_ANCHOR: FeedbackAnchor = {
  general: false,
  briefField: null,
  anchorScopeItemId: null,
  contractRevisionId: null,
  articleNumber: null,
  designRevisionId: null,
  conceptId: null,
  pageDesignId: null,
  paletteItemId: null,
  demoId: null,
  demoPageId: null,
  frameLineId: null,
};

const count = (...v: unknown[]) => v.filter((x) => x !== null && x !== undefined).length;
const set = (v: unknown) => v !== null && v !== undefined;

/**
 * Which anchor a step accepts — the SQL CHECK, restated. Used by
 * `submitFeedback` to refuse a malformed target with `INVALID_TARGET` before
 * the database's constraint would; `s2.test.ts` runs the same table through
 * both, so the two cannot drift.
 *
 * | step | anchor |
 * |---|---|
 * | REQUIREMENTS | `briefField`, or `general` |
 * | SCOPE | `anchorScopeItemId`, or `general` |
 * | DRAFT | `contractRevisionId` (+ optional `articleNumber`), or `general` |
 * | DESIGN | `designRevisionId` (+ at most one of concept / page / palette), or `general` |
 * | MOCKUP, DEMO | `demoId` + exactly one of `demoPageId` / `frameLineId`, or `general` |
 */
export function anchorMatchesStep(step: StepKind, a: FeedbackAnchor): boolean {
  const only = (...allowed: Array<keyof FeedbackAnchor>): boolean =>
    (Object.keys(a) as Array<keyof FeedbackAnchor>)
      .filter((k) => k !== 'general' && !allowed.includes(k))
      .every((k) => !set(a[k]));

  switch (step) {
    case 'REQUIREMENTS':
      return only('briefField') && a.general !== set(a.briefField);
    case 'SCOPE':
      return only('anchorScopeItemId') && a.general !== set(a.anchorScopeItemId);
    case 'DRAFT':
      return (
        only('contractRevisionId', 'articleNumber') &&
        a.general !== set(a.contractRevisionId) &&
        (!set(a.articleNumber) || set(a.contractRevisionId))
      );
    case 'DESIGN': {
      const parts = count(a.conceptId, a.pageDesignId, a.paletteItemId);
      return (
        only('designRevisionId', 'conceptId', 'pageDesignId', 'paletteItemId') &&
        a.general !== set(a.designRevisionId) &&
        parts <= 1 &&
        (parts === 0 || set(a.designRevisionId))
      );
    }
    case 'MOCKUP':
    case 'DEMO': {
      if (!only('demoId', 'demoPageId', 'frameLineId')) return false;
      if (a.general) return count(a.demoId, a.demoPageId, a.frameLineId) === 0;
      return set(a.demoId) && count(a.demoPageId, a.frameLineId) === 1;
    }
    default:
      return false;
  }
}

// --- money (PD-21) ---------------------------------------------------------

/** The brief fields that are about money. The names are J4's; the rule is
 *  here so the queue, the step panel and attention all ask the same place. */
export const MONEY_BRIEF_FIELDS: readonly string[] = ['budgetCap', 'paymentPlan'];

/**
 * PD-21: "feedback about money is visible only to money readers". An item is
 * about money when it is anchored to the budget or the payment plan, or to an
 * article marked `sensitive` (J4 adds `Article.sensitive`; until then no
 * article is, and the loader passes `false`).
 */
export function isMoneyAnchored(item: { briefField: string | null; articleSensitive?: boolean }): boolean {
  return (item.briefField !== null && MONEY_BRIEF_FIELDS.includes(item.briefField)) || item.articleSensitive === true;
}
