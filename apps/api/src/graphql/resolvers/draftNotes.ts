import { viewerOf, type Context } from '../../context.js';
import { prisma } from '../../lib/prisma.js';
import { articleStateSince } from '../../lib/draftNotes.js';
import { readContractSnapshot } from '../../lib/revision.js';
import { visibleItem } from '../../lib/visibility.js';
import type { FullContract } from './contracts.js';
import { feedbackItemInclude } from './feedback.js';
import { withArticleSensitivity } from './articleSensitivity.js';

/**
 * Step 2b's notes (journeys build plan J6): `Contract.draftNotes` — the DRAFT
 * feedback items of one contract, each with **where its article is now**.
 *
 * There is no second notes model (PD-1): a note *is* a `FeedbackItem` of step
 * `DRAFT`, raised with `submitFeedback` against `(contractRevisionId,
 * articleNumber)`, answered with `answerFeedback`, resolved and accepted by the
 * S2 rules. This field adds only what the item cannot say about itself — the
 * version of the revision it was written against, and (`lib/draftNotes.ts`)
 * whether its article changed, moved or is gone since, which is a question
 * about two snapshots and so cannot be a column.
 *
 * **It goes through the same `visibleItem` filter, with the same sensitivity
 * loader, as `Contract.feedbackItems`** (PD-21): a note on a sensitive article
 * (*Fees*, *Payment Schedule*) is about money, so it is hidden from staff
 * without `money.read` — the designer is not told the note exists, let alone
 * what it says — and shown to the customer who wrote it and to whoever reads
 * money. The viewer is `viewerOf(ctx)`, so "view as customer" is the same rules
 * through a different person. A note on the draft as a whole (`general`) is not
 * here: it has no revision and no article, and stays on `feedbackItems(step:
 * DRAFT)` with the other steps' general notes.
 */
export const contractDraftNoteFields = {
  draftNotes: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const items = await prisma.feedbackItem.findMany({
      where: { contractId: c.id, step: 'DRAFT', contractRevisionId: { not: null } },
      include: feedbackItemInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const visible = (await withArticleSensitivity(items)).filter((i) => visibleItem(i, viewer, c));
    if (visible.length === 0) return [];

    const revisions = await prisma.contractRevision.findMany({
      where: { id: { in: [...new Set(visible.map((i) => i.contractRevisionId!))] } },
      select: { id: true, version: true, snapshot: true },
    });
    const byId = new Map(revisions.map((r) => [r.id, r]));
    // "The current revision" is the one the customer is reading — the one
    // `Contract.articles` came from, never a newer unpublished draft.
    const current = readContractSnapshot(c.currentContractRevision?.snapshot ?? null);

    return visible.map((item) => {
      const revision = byId.get(item.contractRevisionId!)!;
      const state =
        item.articleNumber === null
          ? { gone: false, changed: false, currentNumber: null }
          : articleStateSince(readContractSnapshot(revision.snapshot), item.articleNumber, current);
      return {
        item,
        revisionVersion: revision.version,
        onCurrentRevision: item.contractRevisionId === c.currentContractRevisionId,
        articleNumber: item.articleNumber,
        currentArticleNumber: state.currentNumber,
        articleChangedSince: state.changed,
        articleGone: state.gone,
      };
    });
  },
};
