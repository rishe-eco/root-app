import { GraphQLError } from 'graphql';
import type { Prisma, StepKind, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { contractVisibleTo, visibleItem } from '../../lib/visibility.js';
import { checkInterception } from '../../lib/feedback.js';
import {
  NO_ANCHOR,
  answerGoverns,
  answerRoute,
  anchorMatchesStep,
  directCapabilityFor,
  isMoneyAnchored,
  mayCarryResolution,
  reopensOnComment,
  takesFeedback,
  type FeedbackAnchor,
} from '../../lib/feedbackRules.js';
import { approveStepTx, lockContract } from '../../lib/stepApproval.js';
import { computeWizard, stepOnRoad } from '../../lib/steps.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload } from './contracts.js';
import { assertStepOpenOn, wizardStateOn } from './wizard.js';
import { isBriefField } from '../../lib/brief.js';
import { sensitiveArticleKeys, withArticleSensitivity } from './articleSensitivity.js';

/**
 * Feedback on every step (journeys build plan S2; spec §6 for the demo it
 * began as). Lives outside `resolvers/admin/` on purpose, same reasoning as
 * `resolvers/demo.ts`: the customer raises and approves (an ownership edge,
 * house rule 2), staff answer (a capability, then the ownership edge of the
 * contract they may see), and sales decides what reaches the customer. The
 * rule they all serve is `lib/feedbackRules.ts`; the one approval is
 * `lib/stepApproval.ts`.
 *
 * **Who may do what, in four lines.**
 * - `submitFeedback` — the contract's own customer, and nobody else. Root
 *   answers; it does not raise (a staff member commenting "as" the customer
 *   would forge the one signal the whole loop is built on).
 * - `answerFeedback` — `feedback.answer`, on a contract the caller can see;
 *   the answer is direct or pending by `answerRoute` (the `answers.direct.*`
 *   capabilities).
 * - `approveAnswer` / `declineAnswer` — `feedback.approveAnswers`.
 * - `approveStep` — the contract's own customer, through `approveStepTx`.
 *
 * `L3`'s `ratifyFeedback` and `L3b`'s `acceptFeedback` are gone: a submission
 * is its own ratification (PD-2), and the customer accepts a step, not items.
 */

/** Shared shape for the FeedbackItem GraphQL type, reused by fields.ts's
 *  `Project.phases` eager include and by this file's own reloads, so the two
 *  never drift into fetching a different shape of the same object. */
export const feedbackItemInclude = {
  demoPage: true,
  frameLine: true,
  anchorScopeItem: true,
  reopenedScopeItem: true,
  // Build plan L3b: the developer's claim (addressedInBuild) and the
  // customer's separate acceptance (acceptedBy) — see FeedbackItem's own
  // schema comment on why these are never the same write. `addressedInBuild`
  // is a bare `Build`: its `declaredBy` and `changes` resolve lazily
  // (`Build` in fields.ts), which is how J3's owed item — selecting them
  // through here failed — is closed.
  addressedInBuild: true,
  acceptedBy: true,
  comments: { orderBy: { createdAt: 'asc' as const }, include: { author: true, approvedBy: true } },
  // Build plan L4: shallow on purpose — every caller of this include that
  // also asks for `ticket` selects only its scalar fields (id, type, …),
  // never a nested field that would need this row's own deeper includes.
  ticket: true,
} satisfies Prisma.FeedbackItemInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });
const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });

/** What the notifications and visibility checks need of an item's contract. */
const contractForItem = {
  select: {
    id: true,
    ref: true,
    titleFa: true,
    titleEn: true,
    customerId: true,
    publishedAt: true,
    status: true,
    designerId: true,
    developerId: true,
    sequence: true,
    project: { select: { status: true, titleFa: true, titleEn: true } },
    customer: true,
  },
} satisfies Prisma.ContractDefaultArgs;

type ContractForItem = Prisma.ContractGetPayload<typeof contractForItem>;

const deskUrl = (locale: string, contractId: string, step: StepKind) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contractId}/${step === 'DEMO' ? 'phases' : 'steps'}`;
const approvalsUrl = (locale: string) => `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/approvals`;
const portalUrl = (locale: string, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`;

/**
 * An item as a staff member may act on it: the contract visible to them
 * (`contractVisibleTo`) and the item not hidden from them (PD-21's
 * `visibleItem` — a designer cannot answer, or learn the id of, feedback
 * about the fee). `NOT_FOUND` for both, house rule 13.
 */
async function loadItemForStaff(itemId: string, user: User) {
  const item = await prisma.feedbackItem.findUnique({
    where: { id: itemId },
    include: { contract: contractForItem },
  });
  if (!item || !contractVisibleTo(user, item.contract)) throw notFound('feedback item');
  // The real sensitivity of the article a DRAFT note is about (J4): S2's
  // version of this check passed none, because no article could be sensitive.
  const [annotated] = await withArticleSensitivity([item]);
  if (!visibleItem(annotated, user, item.contract)) throw notFound('feedback item');
  return annotated;
}

const reloadItem = (id: string) => prisma.feedbackItem.findUniqueOrThrow({ where: { id }, include: feedbackItemInclude });

// --- who is told ------------------------------------------------------------

/**
 * Whoever a step's feedback is for (plan S2, notifications): DESIGN and MOCKUP
 * the assigned designer, DEMO the assigned developer, REQUIREMENTS, SCOPE and
 * DRAFT everyone who authors contracts. Nobody assigned — or the assignee
 * disabled — falls to everyone holding the step's `answers.direct.*`, because
 * feedback nobody is told about is the dead end the loop exists to close.
 * Feedback about money goes only to those who may read it (PD-21).
 */
async function stepOwners(contract: Pick<ContractForItem, 'designerId' | 'developerId'>, step: StepKind, money: boolean) {
  let recipients: User[] = [];
  if (step === 'REQUIREMENTS' || step === 'SCOPE' || step === 'DRAFT') {
    recipients = await recipientsHolding('contracts.author');
  } else {
    const assigneeId = step === 'DEMO' ? contract.developerId : contract.designerId;
    if (assigneeId) {
      const assignee = await prisma.user.findFirst({ where: { id: assigneeId, state: 'ACTIVE' } });
      if (assignee) recipients = [assignee];
    }
    if (recipients.length === 0) {
      const capability = directCapabilityFor(step);
      recipients = capability ? await recipientsHolding(capability) : [];
    }
  }
  return money ? recipients.filter((u) => can(u, 'money.read')) : recipients;
}

/** A notification is best-effort: it must never fail the act that caused it
 *  (`notify` itself never throws; the lookups feeding it can). */
async function tell(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error('[feedback] notification failed', err);
  }
}

async function tellCustomerOfAnswer(contract: ContractForItem, step: StepKind) {
  await tell(() =>
    notify(contract.customer, {
      kind: 'ANSWER_PUBLISHED',
      params: {
        customerName: contract.customer.name,
        projectTitleFa: contract.project.titleFa,
        projectTitleEn: contract.project.titleEn,
        step,
        portalUrl: portalUrl(contract.customer.locale, contract.id),
      },
    }),
  );
}

async function tellApprovers(contract: ContractForItem, step: StepKind, author: User) {
  await tell(async () => {
    const approvers = (await recipientsHolding('feedback.approveAnswers')).filter((u) => u.id !== author.id);
    await Promise.all(
      approvers.map((r) =>
        notify(r, {
          kind: 'ANSWER_PENDING',
          params: {
            recipientName: r.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            step,
            deskUrl: approvalsUrl(r.locale),
          },
        }),
      ),
    );
  });
}

// --- resolving a target -----------------------------------------------------

type FeedbackTargetArg = {
  general?: boolean | null;
  briefField?: string | null;
  scopeItemId?: string | null;
  contractRevisionId?: string | null;
  articleNumber?: number | null;
  designRevisionId?: string | null;
  conceptId?: string | null;
  pageDesignId?: string | null;
  paletteItemId?: string | null;
  demoId?: string | null;
  demoPageId?: string | null;
  frameLineId?: string | null;
};

type ResolvedTarget = {
  anchor: FeedbackAnchor;
  phaseId: string | null;
  /** The scope item interception (D4) asks about — a SCOPE anchor's own, or a
   *  frame line's — or null for an anchor with none. */
  scopeItem: { id: string; decidedAt: Date | null; temporary: boolean; labelFa: string; labelEn: string; decidedNote: string | null } | null;
};

const invalidTarget = () =>
  refuse('INVALID_TARGET', 'That is not something this step takes feedback about.');

/**
 * The input → the anchor columns, each named object checked to be *this
 * contract's* (a scope item of the project, a revision of the contract, a demo
 * of the project — `NOT_FOUND` otherwise, so an id from another customer's
 * contract is indistinguishable from one that does not exist), and the shape
 * checked against the step by `anchorMatchesStep` — the twin of the database's
 * CHECK, so a malformed target is `INVALID_TARGET` here rather than a
 * constraint violation.
 */
async function resolveTarget(
  contract: Pick<ContractForItem, 'id' | 'sequence'> & { projectId: string },
  step: StepKind,
  phaseIdArg: string | null,
  t: FeedbackTargetArg,
): Promise<ResolvedTarget> {
  const briefField = t.briefField?.trim() || null;
  const anchor: FeedbackAnchor = {
    ...NO_ANCHOR,
    general: t.general === true,
    briefField,
    anchorScopeItemId: t.scopeItemId ?? null,
    contractRevisionId: t.contractRevisionId ?? null,
    articleNumber: t.articleNumber ?? null,
    designRevisionId: t.designRevisionId ?? null,
    conceptId: t.conceptId ?? null,
    pageDesignId: t.pageDesignId ?? null,
    paletteItemId: t.paletteItemId ?? null,
    demoId: t.demoId ?? null,
    demoPageId: t.demoPageId ?? null,
    frameLineId: t.frameLineId ?? null,
  };
  if (anchor.articleNumber !== null && (!Number.isInteger(anchor.articleNumber) || anchor.articleNumber < 1)) {
    throw invalidTarget();
  }
  if (!anchorMatchesStep(step, anchor)) throw invalidTarget();
  // A REQUIREMENTS note is about a field some card renders (J4) — a name the
  // brief does not have is a note nobody could find again.
  if (step === 'REQUIREMENTS' && briefField !== null && !isBriefField(briefField)) throw invalidTarget();

  let scopeItem: ResolvedTarget['scopeItem'] = null;
  let phaseId: string | null = null;

  if (anchor.anchorScopeItemId) {
    scopeItem = await prisma.scopeItem.findFirst({ where: { id: anchor.anchorScopeItemId, projectId: contract.projectId } });
    if (!scopeItem) throw notFound('scope item');
  }
  if (anchor.contractRevisionId) {
    const revision = await prisma.contractRevision.findFirst({
      where: { id: anchor.contractRevisionId, contractId: contract.id, publishedAt: { not: null } },
      select: { id: true },
    });
    if (!revision) throw notFound('contract revision');
  }
  if (anchor.designRevisionId) {
    const revision = await prisma.designRevision.findFirst({
      where: { id: anchor.designRevisionId, contractId: contract.id, publishedAt: { not: null } },
      select: { id: true },
    });
    if (!revision) throw notFound('design revision');
    if (anchor.conceptId) {
      const concept = await prisma.designConcept.findFirst({
        where: { id: anchor.conceptId, designRevisionId: revision.id },
        select: { id: true },
      });
      if (!concept) throw notFound('concept');
    }
    if (anchor.pageDesignId) {
      const page = await prisma.pageDesign.findFirst({
        where: { id: anchor.pageDesignId, concept: { designRevisionId: revision.id } },
        select: { id: true },
      });
      if (!page) throw notFound('page design');
    }
  }
  if (anchor.demoId) {
    const demo = await prisma.demo.findFirst({
      where: { id: anchor.demoId, phase: { contractId: contract.id } },
      select: { id: true, phaseId: true, publishedAt: true },
    });
    if (!demo) throw notFound('demo');
    if (!demo.publishedAt) throw refuse('DEMO_NOT_PUBLISHED', 'This demo has not been published yet.');
    if (anchor.demoPageId) {
      const page = await prisma.demoPage.findFirst({ where: { id: anchor.demoPageId, demoId: demo.id }, select: { id: true } });
      if (!page) throw notFound('demo page');
    }
    if (anchor.frameLineId) {
      const line = await prisma.demoFrameLine.findFirst({
        where: { id: anchor.frameLineId, frame: { demoId: demo.id } },
        include: { scopeItem: true },
      });
      if (!line) throw notFound('frame line');
      scopeItem = line.scopeItem;
    }
    // A demo is approved once per phase, so its feedback belongs to its phase.
    if (step === 'DEMO') {
      if (phaseIdArg && phaseIdArg !== demo.phaseId) throw invalidTarget();
      phaseId = demo.phaseId;
    }
  }

  // The phase of a `general` DEMO comment has no demo to come from: it is
  // named, and must be one of this project's.
  if (step === 'DEMO' && phaseId === null) {
    if (!phaseIdArg) throw invalidTarget();
    const phase = await prisma.phase.findFirst({ where: { id: phaseIdArg, contractId: contract.id }, select: { id: true } });
    if (!phase) throw notFound('phase');
    phaseId = phase.id;
  }
  if (step !== 'DEMO' && phaseIdArg) throw invalidTarget();

  return { anchor, phaseId, scopeItem };
}

/** The columns that identify an item's target — the `where` of "is there one
 *  already", and half of a new row's `data`. */
function anchorColumns(anchor: FeedbackAnchor) {
  return {
    general: anchor.general,
    briefField: anchor.briefField,
    anchorScopeItemId: anchor.anchorScopeItemId,
    contractRevisionId: anchor.contractRevisionId,
    articleNumber: anchor.articleNumber,
    designRevisionId: anchor.designRevisionId,
    conceptId: anchor.conceptId,
    pageDesignId: anchor.pageDesignId,
    paletteItemId: anchor.paletteItemId,
    demoId: anchor.demoId,
    demoPageId: anchor.demoPageId,
    frameLineId: anchor.frameLineId,
  };
}

const isUniqueViolation = (err: unknown) =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';

export const feedbackMutations = {
  /**
   * The contract's own customer raises feedback on one step. A second
   * submission against a target that already has an item appends a comment to
   * it instead of creating a second one (D4's duplicate collapse — the indexes
   * are the backstop), and **commenting on an item Root has resolved reopens
   * it** (§3.1, `reopensOnComment`): `ADDRESSED`, `DECLINED` and `MOVED` all
   * go back to `OPEN`, and a stale build pointer is dropped rather than left
   * claiming a fix the customer has just contradicted.
   *
   * Intercepted (D4) when the target resolves to a decided/temporary scope
   * item and `confirmReopen` is not yet true: nothing is written; the caller
   * resubmits identically with `confirmReopen: true`. Generalized from L3's
   * frame lines to every anchor that names a scope item.
   *
   * The submission **is** the ratification (PD-2): `ratifiedAt`/`ratifiedById`
   * are written at creation, and there is no status between "raised" and
   * "actionable".
   */
  submitFeedback: async (
    _p: unknown,
    args: {
      contractId: string;
      step: StepKind;
      phaseId?: string | null;
      target: FeedbackTargetArg;
      body: string;
      confirmReopen?: boolean | null;
    },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    // Not a role test and not a capability: the contract's own customer
    // (house rule 2). Staff who can see the contract get the same answer as
    // a stranger — Root answers, it does not raise.
    if (contract.customerId !== user.id) throw notFound('contract');

    if (!takesFeedback(args.step)) throw invalidTarget();
    if (!stepOnRoad(contract.sequence, args.step)) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no such step.');
    }
    // (Until J4 a demo or mockup could only be commented on through the
    // project's first contract, because phases belonged to the project. A phase
    // names its contract now: `resolveTarget` looks the demo and the phase up
    // *on this contract*, so a demo of a sibling contract is `NOT_FOUND` and an
    // item cannot collapse onto another contract's page under the wrong lock.)

    const body = args.body.trim();
    if (!body) throw refuse('EMPTY_COMMENT', 'A comment needs a body.');

    const target = await resolveTarget(contract, args.step, args.phaseId ?? null, args.target);
    // MOCKUP has no phase (J9 makes a mockup's demo phase-less); everything
    // else is keyed as the caller named it.
    const phaseId = args.step === 'MOCKUP' ? null : target.phaseId;

    const interception = checkInterception(target.scopeItem);
    if (interception.intercepted && !args.confirmReopen) {
      // Nothing written yet — the customer has not confirmed past the prompt
      // this result lets the web build (house rule 6: a code and parameters,
      // never a sentence, from this side of the wire).
      return {
        item: null,
        intercepted: true,
        interceptionReason: interception.reason,
        interceptionScopeItem: target.scopeItem,
      };
    }

    const money = isMoneyAnchored({
      ...target.anchor,
      articleSensitive: (await sensitiveArticleKeys([contract.id])).has(`${contract.id}:${target.anchor.articleNumber}`),
    });
    const columns = anchorColumns(target.anchor);
    // A demo page or frame line is one row for the whole project (the indexes
    // are on the target alone), so that is what "already there" means for them.
    const existingWhere: Prisma.FeedbackItemWhereInput = target.anchor.demoPageId
      ? { demoPageId: target.anchor.demoPageId }
      : target.anchor.frameLineId
        ? { frameLineId: target.anchor.frameLineId }
        : { contractId: contract.id, step: args.step, phaseId, ...columns };

    const write = () =>
      prisma.$transaction(async (tx) => {
        await lockContract(tx, contract.id);
        await assertStepOpenOn(contract.id, args.step, phaseId, tx);

        const existing = await tx.feedbackItem.findFirst({ where: existingWhere });
        const item =
          existing ??
          (await tx.feedbackItem.create({
            data: {
              projectId: contract.projectId,
              contractId: contract.id,
              step: args.step,
              phaseId,
              ...columns,
              reopenedScopeItemId: interception.intercepted ? interception.scopeItemId : null,
              ratifiedAt: new Date(),
              ratifiedById: user.id,
            },
          }));

        // A target already on record can still be re-intercepted later (the
        // scope item is decided *after* the first, un-intercepted comment) —
        // record that the moment it is confirmed, rather than only at creation.
        if (existing && interception.intercepted && !existing.reopenedScopeItemId) {
          await tx.feedbackItem.update({ where: { id: item.id }, data: { reopenedScopeItemId: interception.scopeItemId } });
        }

        if (existing && reopensOnComment(existing.status)) {
          await tx.feedbackItem.update({ where: { id: item.id }, data: { status: 'OPEN', addressedInBuildId: null } });
        }

        await tx.feedbackComment.create({ data: { feedbackItemId: item.id, authorId: user.id, body } });
        return item.id;
      });

    let itemId: string;
    try {
      itemId = await write();
    } catch (err) {
      // Two first comments on one target at the same moment: the second's
      // create loses to the unique index. Retried once, it finds the row.
      if (!isUniqueViolation(err)) throw err;
      itemId = await write();
    }

    // "The team has been notified" (spec §6) — the mechanism, not polish.
    await tell(async () => {
      const recipients = (await stepOwners(contract, args.step, money)).filter((r) => r.id !== user.id);
      await Promise.all(
        recipients.map((r) =>
          notify(r, {
            kind: 'FEEDBACK_SUBMITTED',
            params: {
              recipientName: r.name,
              projectTitleFa: contract.project.titleFa,
              projectTitleEn: contract.project.titleEn,
              step: args.step,
              deskUrl: deskUrl(r.locale, contract.id, args.step),
            },
          }),
        ),
      );
    });

    return {
      item: await reloadItem(itemId),
      intercepted: interception.intercepted,
      interceptionReason: interception.intercepted ? interception.reason : null,
      interceptionScopeItem: target.scopeItem,
    };
  },

  /**
   * Root answers. The comment is direct or pending by `answerRoute(caller,
   * step)` (PD-3) — a direct one reaches the customer at once and applies its
   * resolution; a pending one waits in sales' queue, invisible to the
   * customer, and leaves the item `OPEN` (so it still blocks the step). An
   * item may collect several answers: the item's state follows the latest
   * *visible* resolving one, so a later direct "addressed" supersedes an
   * earlier pending one.
   *
   * `assertStepOpen` applies to staff too (§3.1): once the customer approves a
   * step, nobody answers on it.
   */
  answerFeedback: async (
    _p: unknown,
    args: { itemId: string; body: string; resolution?: 'ADDRESSED' | 'DECLINED' | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'feedback.answer');
    const item = await loadItemForStaff(args.itemId, user);

    const body = args.body.trim();
    if (!body) throw refuse('EMPTY_COMMENT', 'An answer needs a body.');
    const resolution = args.resolution ?? null;
    if (resolution !== null && !mayCarryResolution(user)) {
      throw refuse('FORBIDDEN', 'You do not have access to that.');
    }

    const route = answerRoute(user, item.step);
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, item.contractId);
      await assertStepOpenOn(item.contractId, item.step, item.phaseId, tx);

      await tx.feedbackComment.create({
        data: {
          feedbackItemId: item.id,
          authorId: user.id,
          body,
          resolution,
          approval: route === 'DIRECT' ? 'NOT_REQUIRED' : 'PENDING',
        },
      });
      if (route === 'DIRECT' && resolution !== null) {
        await tx.feedbackItem.update({ where: { id: item.id }, data: { status: resolution, addressedInBuildId: null } });
      }
    });

    if (route === 'DIRECT') await tellCustomerOfAnswer(item.contract, item.step);
    else await tellApprovers(item.contract, item.step, user);

    return reloadItem(item.id);
  },

  /**
   * Sales publishes a pending answer — as written, or edited first (the
   * author's words are kept in `originalBody`, Q-S9) — and its resolution
   * applies **unless something later has already spoken** (`answerGoverns`: a
   * newer visible resolving answer, or a customer comment that reopened the
   * item). Either way the customer is told once.
   */
  approveAnswer: async (_p: unknown, args: { commentId: string; body?: string | null }, ctx: Context) => {
    const user = requireCapability(ctx, 'feedback.approveAnswers');
    const comment = await prisma.feedbackComment.findUnique({ where: { id: args.commentId }, select: { feedbackItemId: true } });
    if (!comment) throw notFound('answer');
    const item = await loadItemForStaff(comment.feedbackItemId, user);

    const edited = args.body === undefined || args.body === null ? null : args.body.trim();
    if (edited === '') throw refuse('EMPTY_COMMENT', 'An answer needs a body.');

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, item.contractId);
      await assertStepOpenOn(item.contractId, item.step, item.phaseId, tx);

      const thread = await tx.feedbackComment.findMany({ where: { feedbackItemId: item.id } });
      const pending = thread.find((c) => c.id === args.commentId);
      if (!pending || pending.approval !== 'PENDING') {
        throw refuse('ANSWER_NOT_PENDING', 'That answer is not waiting for approval.');
      }

      const now = new Date();
      await tx.feedbackComment.update({
        where: { id: pending.id },
        data: {
          approval: 'APPROVED',
          approvedById: user.id,
          approvedAt: now,
          ...(edited !== null && edited !== pending.body ? { body: edited, originalBody: pending.body } : {}),
        },
      });

      const governs = answerGoverns(
        pending.id,
        thread.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          byCustomer: c.authorId === item.contract.customerId,
          resolution: c.resolution,
          approval: c.approval,
        })),
      );
      if (pending.resolution !== null && governs) {
        await tx.feedbackItem.update({
          where: { id: item.id },
          data: { status: pending.resolution, addressedInBuildId: null },
        });
      }
    });

    await tellCustomerOfAnswer(item.contract, item.step);
    return reloadItem(item.id);
  },

  /**
   * Sales sends a pending answer back, with the reason — which its author
   * sees, and the customer never does. The answer stays in the record
   * (`DECLINED`, with `approvalNote`); the item is unchanged.
   */
  declineAnswer: async (_p: unknown, args: { commentId: string; reason: string }, ctx: Context) => {
    const user = requireCapability(ctx, 'feedback.approveAnswers');
    const comment = await prisma.feedbackComment.findUnique({
      where: { id: args.commentId },
      include: { author: true },
    });
    if (!comment) throw notFound('answer');
    const item = await loadItemForStaff(comment.feedbackItemId, user);

    const reason = args.reason.trim();
    if (!reason) throw refuse('REASON_REQUIRED', 'Declining an answer needs a reason.');

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, item.contractId);
      await assertStepOpenOn(item.contractId, item.step, item.phaseId, tx);
      const fresh = await tx.feedbackComment.findUnique({ where: { id: comment.id }, select: { approval: true } });
      if (fresh?.approval !== 'PENDING') {
        throw refuse('ANSWER_NOT_PENDING', 'That answer is not waiting for approval.');
      }
      await tx.feedbackComment.update({
        where: { id: comment.id },
        data: { approval: 'DECLINED', approvalNote: reason, approvedById: user.id, approvedAt: new Date() },
      });
    });

    if (comment.author.state === 'ACTIVE') {
      await tell(() =>
        notify(comment.author, {
          kind: 'ANSWER_DECLINED',
          params: {
            recipientName: comment.author.name,
            projectTitleFa: item.contract.project.titleFa,
            projectTitleEn: item.contract.project.titleEn,
            step: item.step,
            reason,
            deskUrl: deskUrl(comment.author.locale, item.contract.id, item.step),
          },
        }),
      );
    }

    return reloadItem(item.id);
  },

  /**
   * The customer approves a step: refused while anything on it is open or
   * waiting (`approveStepTx`), otherwise every resolved item is accepted at
   * once and the step locks. **This is the only door to `acceptedAt`** — the
   * customer accepts a step, not items one by one, and nothing Root does can
   * close the loop for them.
   *
   * Which steps: DESIGN, MOCKUP and DEMO. The agreement is J7's gate and has
   * its own door — `approveContract` on an `AGREEMENT_FIRST` contract, which
   * checks the scope, the payment plan, the phases' dates and the brief before
   * calling `approveStepTx(AGREEMENT)` — and a bare approval here would let a
   * customer lock steps 1–3 without any of it, so this **keeps refusing
   * AGREEMENT** (J7 left it so on purpose); REQUIREMENTS, SCOPE and DRAFT are
   * sealed by that approval, never approved alone. J8–J10
   * replace this door for their step with their own, passing their own
   * preconditions to the same `approveStepTx`. A `DESIGN_FIRST` contract
   * approves through its own gate and never through here.
   */
  approveStep: async (_p: unknown, args: { contractId: string; step: StepKind; phaseId?: string | null }, ctx: Context) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    if (contract.customerId !== user.id) throw notFound('contract');

    if (contract.sequence !== 'AGREEMENT_FIRST' || !['DESIGN', 'MOCKUP', 'DEMO'].includes(args.step)) {
      throw refuse('STEP_NOT_APPROVABLE', 'That step cannot be approved this way.');
    }

    const phaseId = args.step === 'DEMO' ? (args.phaseId ?? null) : null;
    if (args.step !== 'DEMO' && args.phaseId) throw invalidTarget();
    const road = computeWizard(await wizardStateOn(contract.id));
    // A step with no phase — the placeholder demo — "can never take an
    // approval" (lib/steps.ts): there is no phase for the approval to key on.
    if (!road.some((s) => s.step === args.step && s.phaseId === phaseId) || (args.step === 'DEMO' && phaseId === null)) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no such step.');
    }

    try {
      await prisma.$transaction((tx) => approveStepTx(tx, { contractId: contract.id, step: args.step, phaseId, approverId: user.id }));
    } catch (err) {
      // Two approvals at once: the partial unique index on `StepApproval`
      // refuses the second — which is the answer the caller should get.
      if (isUniqueViolation(err)) throw refuse('STEP_LOCKED', 'That step is locked.');
      throw err;
    }
    return reload(contract.id);
  },
};

export const feedbackQueries = {
  /**
   * Sales' queue (`feedback.approveAnswers`): every answer waiting, oldest
   * first, on contracts and items the caller may see. Thin on purpose — the
   * comment, its item and where it is — and never a `Contract`, which carries
   * the fee.
   */
  pendingAnswers: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireCapability(ctx, 'feedback.approveAnswers');
    const comments = await prisma.feedbackComment.findMany({
      where: { approval: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        author: true,
        approvedBy: true,
        feedbackItem: { include: { ...feedbackItemInclude, contract: contractForItem, phase: { select: { number: true } } } },
      },
    });
    const sensitive = await sensitiveArticleKeys(comments.map((c) => c.feedbackItem.contractId));
    const aboutSensitive = (i: { contractId: string; articleNumber: number | null }) =>
      i.articleNumber !== null && sensitive.has(`${i.contractId}:${i.articleNumber}`);
    return comments
      .filter(
        (c) =>
          contractVisibleTo(user, c.feedbackItem.contract) &&
          visibleItem({ ...c.feedbackItem, articleSensitive: aboutSensitive(c.feedbackItem) }, user, c.feedbackItem.contract),
      )
      .map((c) => {
        const { feedbackItem } = c;
        return {
          id: c.id,
          comment: c,
          item: feedbackItem,
          contractId: feedbackItem.contract.id,
          contractRef: feedbackItem.contract.ref,
          contractTitleFa: feedbackItem.contract.titleFa,
          contractTitleEn: feedbackItem.contract.titleEn,
          step: feedbackItem.step,
          phaseNumber: feedbackItem.phase?.number ?? null,
        };
      });
  },

  /**
   * The staff member's own list (`feedback.answer`): open items on contracts
   * they can see, each marked with the route their answer would take and
   * whether it is theirs by assignment — those first, then the rest (the ones
   * outside their direct steps are answerable through approval). Feedback
   * about money is filtered out for anyone without `money.read` (PD-21).
   */
  myFeedbackQueue: async (_p: unknown, args: { limit?: number | null }, ctx: Context) => {
    const user = requireCapability(ctx, 'feedback.answer');
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const items = await prisma.feedbackItem.findMany({
      where: { status: 'OPEN', contract: { status: { not: 'DISCARDED' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { ...feedbackItemInclude, contract: contractForItem },
      take: 1000,
    });
    const sensitive = await sensitiveArticleKeys(items.map((i) => i.contractId));
    const entries = items
      .filter(
        (i) =>
          contractVisibleTo(user, i.contract) &&
          visibleItem(
            { ...i, articleSensitive: i.articleNumber !== null && sensitive.has(`${i.contractId}:${i.articleNumber}`) },
            user,
            i.contract,
          ),
      )
      .map((item) => {
        const route = answerRoute(user, item.step);
        // Only design, mockup and demo have a person assigned; the agreement's
        // steps are sales' as a job, so "unassigned" is the whole answer there.
        const assignee =
          item.step === 'DESIGN' || item.step === 'MOCKUP'
            ? item.contract.designerId
            : item.step === 'DEMO'
              ? item.contract.developerId
              : null;
        return {
          item,
          contractId: item.contract.id,
          contractRef: item.contract.ref,
          contractTitleFa: item.contract.titleFa,
          contractTitleEn: item.contract.titleEn,
          route,
          mine: route === 'DIRECT' && (assignee === null || assignee === user.id),
        };
      });
    // Stable: `mine` first, the rest keep their oldest-first order.
    return [...entries.filter((e) => e.mine), ...entries.filter((e) => !e.mine)].slice(0, limit);
  },
};
