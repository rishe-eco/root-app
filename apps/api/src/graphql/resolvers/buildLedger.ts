import { GraphQLError } from 'graphql';
import type { FeedbackStatus, Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  missingDispositions,
  hasAtMostOneOrigin,
  outcomeAllowedForStatus,
  declinedRequiresNote,
  noOriginRequiresNote,
  noteAndLangTogether,
  nextFeedbackStatus,
  nextBuildNumber,
  type BuildChangeInputLike,
  type BuildChangeOutcomeLike,
} from '../../lib/build.js';
import { feedbackItemInclude } from './feedback.js';

/**
 * **Declaring a build, once, for both kinds** (build plan L3b; journeys build plan
 * J9b, "L3b's `declareBuild` generalized by kind"). The developer's `declareBuild`
 * (`builds.ts`) and the designer's `declareMockupBuild` (`mockupStep.ts`) are two
 * doors — two capabilities, two assignment edges, two sets of open items — onto
 * this one function, because what they do once inside is one rule (house rule 3):
 * *a fate must never be silent*, every open item of the step gets exactly one
 * disposition, a disposition is the declarer's direct answer, and a build's
 * number is the next one **of its kind** in the project. Two copies would be two
 * chances for the mockup's ledger to drift from the site's, which is precisely
 * the thing a customer comparing "what happened to my note" across steps would
 * notice first.
 *
 * It lives outside `builds.ts` so the designer's surface does not import the
 * developer's (and neither reaches into the other's capability checks): the
 * callers check who is asking, this writes what they asked for.
 */

export const buildInclude = {
  declaredBy: true,
  changes: {
    include: { feedbackItem: { include: feedbackItemInclude }, scopeItem: true },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.BuildInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

export type BuildChangeInputArg = {
  feedbackItemId?: string | null;
  scopeItemId?: string | null;
  outcome?: BuildChangeOutcomeLike | null;
  note?: string | null;
  noteLang?: string | null;
};

export type DeclareSpec = {
  kind: 'SITE' | 'MOCKUP';
  projectId: string;
  /** Set for a SITE build (its phase), null for a MOCKUP one. */
  phaseId: string | null;
  /** Set for a MOCKUP build (its demo), null for a SITE one. */
  demoId: string | null;
  /** The zip a MOCKUP build serves; null for a SITE build. */
  bundleFileId: string | null;
  /**
   * The items the change list must exhaust: the step's own open ones. **Read by
   * the caller, not here**, so that every read of feedback names its step where
   * the surface that owns it can be seen to (`s2.test.ts` holds that for
   * `builds.ts`): a developer's queue is the demo step's, a designer's the
   * mockup's, and a build that "dispositioned" another step's note would be
   * draining it — silently, in exactly the direction that looks like the queue
   * working.
   */
  openItems: Array<{ id: string; status: FeedbackStatus }>;
  /** The person declaring. Their dispositions are direct answers, so the caller
   *  has already required the step's `answers.direct.*`. */
  declarer: User;
  ref?: string | null;
  changes: BuildChangeInputArg[];
  /**
   * Whether a change entry may name a scope item — a site build ships registry
   * items (`IN_BUILD` → `IN_DEMO`), a mockup does not: a picture of a page is not
   * the page, and moving the item along the registry's lifecycle because a mockup
   * of it exists would be a lie about the site. A mockup's entry that names one is
   * refused (`SCOPE_ITEM_NOT_ON_MOCKUP`) rather than ignored.
   */
  scopeItems: 'SHIP' | 'REFUSE';
  /** Runs **first** in the declaring transaction, before any write — where the
   *  caller takes the contract's row lock and asks whether the step is still
   *  open, so a declaration cannot interleave with the customer's approval
   *  (the approval takes the same lock; taking it late, after the writes, would
   *  make that a deadlock instead of a refusal). */
  guard?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Runs in the declaring transaction once the rows are written — the mockup's
   *  frame is brought up to date here, so a build and its frame commit together. */
  afterWrite?: (tx: Prisma.TransactionClient, build: { id: string }) => Promise<void>;
};

/** Returns the new build's id. Every refusal is thrown before anything is written. */
export async function declareBuildFor(spec: DeclareSpec): Promise<string> {
  const { changes, declarer } = spec;

  const openItems = spec.openItems;
  const openIds = openItems.map((i) => i.id);
  const missing = missingDispositions(openIds, changes as BuildChangeInputLike[]);
  if (missing.length > 0) {
    throw new GraphQLError('Every open feedback item needs a disposition before a build can be declared.', {
      extensions: { code: 'MISSING_DISPOSITION', missingFeedbackItemIds: missing },
    });
  }
  const statusById = new Map(openItems.map((i) => [i.id, i.status] as const));

  const feedbackIdsSeen = new Set<string>();
  for (const change of changes) {
    if (!hasAtMostOneOrigin(change)) {
      throw new GraphQLError('A change entry may name a feedback item or a scope item, never both.', {
        extensions: { code: 'INVALID_CHANGE_ORIGIN' },
      });
    }
    if (!noOriginRequiresNote(change)) {
      throw new GraphQLError('A change with no origin needs a note — the note is the entry.', {
        extensions: { code: 'NOTE_REQUIRED' },
      });
    }
    if (!declinedRequiresNote(change)) {
      throw new GraphQLError('A declined item needs its reason.', {
        extensions: { code: 'DECLINE_REASON_REQUIRED' },
      });
    }
    if (!noteAndLangTogether(change)) {
      throw new GraphQLError('A note needs the language it was authored in, and vice versa.', {
        extensions: { code: 'NOTE_LANG_REQUIRED' },
      });
    }

    if (change.feedbackItemId) {
      if (feedbackIdsSeen.has(change.feedbackItemId)) {
        throw new GraphQLError("A feedback item may only appear once in a build's change list.", {
          extensions: { code: 'DUPLICATE_DISPOSITION' },
        });
      }
      feedbackIdsSeen.add(change.feedbackItemId);

      const status = statusById.get(change.feedbackItemId);
      if (!status) throw notFound('open feedback item on this project');
      if (!change.outcome) {
        throw new GraphQLError('A feedback-item change needs an outcome.', {
          extensions: { code: 'OUTCOME_REQUIRED' },
        });
      }
      if (!outcomeAllowedForStatus(change.outcome, status)) {
        throw new GraphQLError('That item is no longer open.', { extensions: { code: 'NOT_OPEN' } });
      }
    } else if (change.outcome) {
      throw new GraphQLError('Only a feedback-item change may carry an outcome.', {
        extensions: { code: 'INVALID_CHANGE_ORIGIN' },
      });
    }
  }

  const scopeItemIds = changes.map((c) => c.scopeItemId).filter((id): id is string => !!id);
  if (scopeItemIds.length > 0 && spec.scopeItems === 'REFUSE') {
    throw new GraphQLError('A mockup does not ship registry items; note the change instead.', {
      extensions: { code: 'SCOPE_ITEM_NOT_ON_MOCKUP' },
    });
  }
  const scopeItems = scopeItemIds.length
    ? await prisma.scopeItem.findMany({ where: { id: { in: scopeItemIds } } })
    : [];
  const scopeById = new Map(scopeItems.map((s) => [s.id, s]));
  for (const id of scopeItemIds) {
    const item = scopeById.get(id);
    if (!item || item.projectId !== spec.projectId) throw notFound('scope item on this project');
    if (item.status !== 'IN_BUILD') {
      throw new GraphQLError('Only an item currently in build can ship in a build.', {
        extensions: { code: 'SCOPE_ITEM_NOT_IN_BUILD' },
      });
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (spec.guard) await spec.guard(tx);
      // Numbered per (project, kind) since J9: a site's "version 4" must not
      // count the mockup's iterations (the unique index says the same).
      const highest = await tx.build.aggregate({
        where: { projectId: spec.projectId, kind: spec.kind },
        _max: { number: true },
      });
      const number = nextBuildNumber(highest._max.number);

      const created = await tx.build.create({
        data: {
          kind: spec.kind,
          phaseId: spec.phaseId,
          demoId: spec.demoId,
          bundleFileId: spec.bundleFileId,
          projectId: spec.projectId,
          number,
          declaredById: declarer.id,
          ref: spec.ref ?? null,
        },
      });

      for (const change of changes) {
        const note = change.note?.trim() || null;
        await tx.buildChangeEntry.create({
          data: {
            buildId: created.id,
            feedbackItemId: change.feedbackItemId ?? null,
            scopeItemId: change.scopeItemId ?? null,
            outcome: change.outcome ?? null,
            note,
            noteLang: note ? (change.noteLang ?? null) : null,
          },
        });

        if (change.feedbackItemId && change.outcome) {
          const nextStatus = nextFeedbackStatus(change.outcome);
          if (nextStatus) {
            // **A disposition is the declarer's answer** (S2, PD-4): a staff
            // comment carrying the resolution, direct because the caller holds
            // the step's `answers.direct.*`. The note is the answer's text; an
            // ADDRESSED with none is an answer with no words — "addressed in
            // build N" says it. Without the comment, a designer's older pending
            // answer approved later would be judged against a ledger that is not
            // in the thread.
            await tx.feedbackComment.create({
              data: {
                feedbackItemId: change.feedbackItemId,
                authorId: declarer.id,
                body: note ?? '',
                resolution: nextStatus,
                approval: 'NOT_REQUIRED',
              },
            });
            await tx.feedbackItem.update({
              where: { id: change.feedbackItemId },
              data: { status: nextStatus, addressedInBuildId: nextStatus === 'ADDRESSED' ? created.id : null },
            });
          }
        }

        if (change.scopeItemId) {
          await tx.scopeItem.update({ where: { id: change.scopeItemId }, data: { status: 'IN_DEMO' } });
        }
      }

      if (spec.afterWrite) await spec.afterWrite(tx, created);
      return created.id;
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
      throw new GraphQLError('Someone else declared a build at the same moment — try again.', {
        extensions: { code: 'CONCURRENT_BUILD' },
      });
    }
    throw err;
  }
}
