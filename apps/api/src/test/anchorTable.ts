import type { StepKind } from '@prisma/client';
import { NO_ANCHOR, type FeedbackAnchor } from '../lib/feedbackRules.js';

/**
 * Which anchor each step takes, as a table — **one table, two readers**. The
 * unit test (`lib/feedbackRules.test.ts`) runs each row through
 * `anchorMatchesStep`; the integration test (`s2.test.ts`) inserts each row
 * straight into Postgres, where `FeedbackItem_anchor_matches_step` must give
 * the same answer. A row that only one of them agrees with is exactly the
 * drift between the resolver's refusal and the database's constraint that two
 * copies of a rule invite (house rule 3).
 *
 * Not a `.test.ts` file on purpose: a test file imported by another test file
 * runs its tests twice.
 */

const anchor = (over: Partial<FeedbackAnchor>): FeedbackAnchor => ({ ...NO_ANCHOR, ...over });

/** [step, anchor, is it legal, why]. */
export const ANCHOR_TABLE: Array<[StepKind, FeedbackAnchor, boolean, string]> = [
  ['REQUIREMENTS', anchor({ briefField: 'budgetCap' }), true, 'a brief field'],
  ['REQUIREMENTS', anchor({ general: true }), true, 'general'],
  ['REQUIREMENTS', anchor({}), false, 'no anchor at all'],
  ['REQUIREMENTS', anchor({ briefField: 'x', general: true }), false, 'field and general'],
  ['REQUIREMENTS', anchor({ anchorScopeItemId: 's' }), false, 'a scope item is not a brief anchor'],
  ['SCOPE', anchor({ anchorScopeItemId: 's' }), true, 'a scope item'],
  ['SCOPE', anchor({ general: true }), true, 'general'],
  ['SCOPE', anchor({ briefField: 'x' }), false, 'a brief field is not a scope anchor'],
  ['DRAFT', anchor({ contractRevisionId: 'r' }), true, 'a revision'],
  ['DRAFT', anchor({ contractRevisionId: 'r', articleNumber: 3 }), true, 'an article'],
  ['DRAFT', anchor({ general: true }), true, 'general'],
  ['DRAFT', anchor({ articleNumber: 3 }), false, 'an article number without a revision'],
  ['DRAFT', anchor({ general: true, articleNumber: 3 }), false, 'general with an article'],
  ['DRAFT', anchor({ designRevisionId: 'd' }), false, 'a design anchor on the draft'],
  ['DESIGN', anchor({ designRevisionId: 'd' }), true, 'a revision'],
  ['DESIGN', anchor({ designRevisionId: 'd', conceptId: 'c' }), true, 'a concept'],
  ['DESIGN', anchor({ designRevisionId: 'd', pageDesignId: 'p' }), true, 'a page'],
  ['DESIGN', anchor({ designRevisionId: 'd', paletteItemId: 'x' }), true, 'a palette item'],
  ['DESIGN', anchor({ general: true }), true, 'general'],
  ['DESIGN', anchor({ designRevisionId: 'd', conceptId: 'c', pageDesignId: 'p' }), false, 'two of concept / page / palette'],
  ['DESIGN', anchor({ conceptId: 'c' }), false, 'a concept without its revision'],
  ['DESIGN', anchor({ general: true, designRevisionId: 'd' }), false, 'general with a revision'],
  ['MOCKUP', anchor({ demoId: 'd', demoPageId: 'p' }), true, 'a page'],
  ['MOCKUP', anchor({ demoId: 'd', frameLineId: 'l' }), true, 'a line'],
  ['MOCKUP', anchor({ general: true }), true, 'general'],
  ['DEMO', anchor({ demoId: 'd', demoPageId: 'p' }), true, 'a page'],
  ['DEMO', anchor({ demoId: 'd', frameLineId: 'l' }), true, 'a line'],
  ['DEMO', anchor({ general: true }), true, 'general'],
  ['DEMO', anchor({ demoId: 'd' }), false, 'a demo with neither page nor line'],
  ['DEMO', anchor({ demoId: 'd', demoPageId: 'p', frameLineId: 'l' }), false, 'both page and line'],
  ['DEMO', anchor({ demoPageId: 'p' }), false, 'a page without its demo'],
  ['DEMO', anchor({ general: true, demoId: 'd' }), false, 'general with a demo'],
  ['DEMO', anchor({ demoId: 'd', demoPageId: 'p', briefField: 'budgetCap' }), false, 'a demo item with a brief field'],
  ['AGREEMENT', anchor({ general: true }), false, 'the agreement takes no feedback'],
  ['SUMMARY', anchor({ general: true }), false, 'the summary takes no feedback'],
];
