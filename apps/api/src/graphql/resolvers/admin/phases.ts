import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { reload } from '../contracts.js';
import { reloadOnProject } from './shared.js';
import { requireBuildAuthorOnPhase } from '../access.js';
import { assertStepOpenOn } from '../wizard.js';
import { lockContract } from '../../../lib/stepApproval.js';
import { parseCalendarDay } from '../../../lib/calendarDay.js';

/**
 * Phases and the live demo surface (build plan L2; spec §4 stage 6, §6).
 *
 * Every mutation here returns `Contract!`, the same convention L1's registry
 * mutations settled on (T9 in V2.md) — a phase or demo is reached through
 * `project.phases`, never a dedicated payload type. Each takes an optional
 * `contractId`, the contract the caller has open, and returns that one
 * (`reloadOnProject`, shared.ts — a project can hold two contracts since J2).
 *
 * **What this file does not do.** It never writes `PageDesign.approvedAt` or
 * `DesignConcept.chosenAt` — D5 stays decided, and the design-image toggle
 * below reads `imageUrl`/`key` only. It never builds a deploy lock — the
 * review window on `Demo` is two plain dates the review frame (L3) will read
 * into a sentence, not machinery that refuses a deploy. And it never creates
 * a screenshot: no code path here calls out to a headless browser.
 *
 * **Two guards, since journeys build plan S1.** Phases are part of the
 * agreement — what gets delivered when — so their CRUD is `contracts.author`.
 * Demos and their page declarations are the developer's own surface (defect
 * D-2: before S1 a developer could not even load one), so they are
 * `builds.author` plus `requireBuildAuthorOnPhase`, the assignment edge.
 *
 * **A phase belongs to a contract (journeys build plan J4, PD-5).** So the
 * phase mutations name their contract, return *that* contract, and the demo
 * mutations' assignment edge is the phase's own contract's developer — the
 * project no longer decides whose work a phase is. A phase is part of step 1
 * (what is delivered when, and by which planned day), so creating, editing and
 * deleting one asks `assertStepOpenOn(REQUIREMENTS)` after taking the
 * contract's row lock, exactly as S2's feedback writes do: once the agreement
 * is approved the phases are frozen with it (`STEP_LOCKED`). A legacy
 * (`DESIGN_FIRST`) contract has no REQUIREMENTS step, so nothing locks its
 * phases — they behave as they always did.
 */

function assertHttps(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GraphQLError('That is not a valid URL.', { extensions: { code: 'INVALID_STAGING_URL' } });
  }
  if (parsed.protocol !== 'https:') {
    // L2.2: mixed content is a silently blank iframe, not an error a
    // reviewer can act on — refusing at write time is the only point this
    // can be caught with a message attached to it.
    throw new GraphQLError('The staging URL must be HTTPS, or a browser will not frame it at all.', {
      extensions: { code: 'STAGING_NOT_HTTPS' },
    });
  }
}

async function loadPhase(phaseId: string) {
  const phase = await prisma.phase.findUnique({ where: { id: phaseId } });
  if (!phase) {
    throw new GraphQLError('No such phase.', { extensions: { code: 'NOT_FOUND' } });
  }
  return phase;
}

async function loadDemo(demoId: string) {
  const demo = await prisma.demo.findUnique({ where: { id: demoId }, include: { phase: true } });
  if (!demo) {
    throw new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });
  }
  return demo;
}

async function loadDemoPage(demoPageId: string) {
  const page = await prisma.demoPage.findUnique({
    where: { id: demoPageId },
    include: { demo: { include: { phase: true } } },
  });
  if (!page) {
    throw new GraphQLError('No such demo page.', { extensions: { code: 'NOT_FOUND' } });
  }
  return page;
}

/**
 * A page design may only be attached to a demo belonging to the *same*
 * project — the same reasoning `resolveDesignImage` already holds for
 * attaching an uploaded file to a contract (shared.ts): without this, a
 * demo on project A could show a design image that actually belongs to
 * project B's customer.
 */
async function assertPageDesignInProject(pageDesignId: string, projectId: string): Promise<void> {
  const pageDesign = await prisma.pageDesign.findUnique({
    where: { id: pageDesignId },
    include: { concept: { include: { designRevision: { include: { contract: true } } } } },
  });
  if (!pageDesign || pageDesign.concept.designRevision.contract.projectId !== projectId) {
    throw new GraphQLError('No such page design on this project.', { extensions: { code: 'NOT_FOUND' } });
  }
}

const invalidDay = () =>
  new GraphQLError('That is not a date.', { extensions: { code: 'INVALID_DATE' } });

/**
 * The planned end day off the wire (PD-19): `YYYY-MM-DD`, parsed by the one
 * calendar-day parser. `undefined` (argument omitted) leaves the column alone,
 * `null` clears it, a string sets it — the three-way `updateDemo` already uses
 * for its review window.
 */
function plannedEnd(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const day = parseCalendarDay(value);
  if (!day) throw invalidDay();
  return day;
}

/**
 * A phase, checked to be on the contract the caller names (when they name
 * one). A phase of another contract — even one on the same project — is
 * `NOT_FOUND` here: the desk's phases tab lists *this contract's* phases, and a
 * mutation answering with a sibling contract would refresh a screen that never
 * showed the phase.
 */
async function phaseOnContract(phaseId: string, named?: string | null) {
  const phase = await loadPhase(phaseId);
  if (named && named !== phase.contractId) {
    throw new GraphQLError('No such phase.', { extensions: { code: 'NOT_FOUND' } });
  }
  return phase;
}

const isUniqueViolation = (err: unknown) =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';

export const phaseMutations = {
  createPhase: async (
    _p: unknown,
    args: {
      contractId: string;
      number: number;
      titleFa: string;
      titleEn: string;
      milestoneLabel?: string | null;
      plannedEndAt?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    const end = plannedEnd(args.plannedEndAt);
    try {
      await prisma.$transaction(async (tx) => {
        await lockContract(tx, contract.id);
        await assertStepOpenOn(contract.id, 'REQUIREMENTS', null, tx);
        await tx.phase.create({
          data: {
            projectId: contract.projectId,
            contractId: contract.id,
            number: args.number,
            titleFa: args.titleFa,
            titleEn: args.titleEn,
            milestoneLabel: args.milestoneLabel ?? null,
            plannedEndAt: end ?? null,
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new GraphQLError('This contract already has a phase with that number.', {
          extensions: { code: 'PHASE_NUMBER_TAKEN' },
        });
      }
      throw err;
    }
    return reload(args.contractId);
  },

  updatePhase: async (
    _p: unknown,
    args: {
      phaseId: string;
      titleFa: string;
      titleEn: string;
      milestoneLabel?: string | null;
      plannedEndAt?: string | null;
      contractId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const phase = await phaseOnContract(args.phaseId, args.contractId);
    const end = plannedEnd(args.plannedEndAt);
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, phase.contractId);
      await assertStepOpenOn(phase.contractId, 'REQUIREMENTS', null, tx);
      await tx.phase.update({
        where: { id: phase.id },
        data: {
          titleFa: args.titleFa,
          titleEn: args.titleEn,
          milestoneLabel: args.milestoneLabel ?? null,
          plannedEndAt: end,
        },
      });
    });
    return reload(phase.contractId);
  },

  /** Scope items on this phase are not deleted — `phaseId` just goes back to
   *  null on them (schema.prisma: onDelete: SetNull), and so does a planned
   *  invoice's link to it. Demos cascade. */
  deletePhase: async (_p: unknown, args: { phaseId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const phase = await phaseOnContract(args.phaseId, args.contractId);
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, phase.contractId);
      await assertStepOpenOn(phase.contractId, 'REQUIREMENTS', null, tx);
      await tx.phase.delete({ where: { id: phase.id } });
    });
    return reload(phase.contractId);
  },

  assignScopeItemToPhase: async (
    _p: unknown,
    args: { scopeItemId: string; phaseId?: string | null; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (args.phaseId) {
      const phase = await loadPhase(args.phaseId);
      if (phase.projectId !== item.projectId) {
        throw new GraphQLError('That phase belongs to a different project.', {
          extensions: { code: 'PHASE_WRONG_PROJECT' },
        });
      }
    }
    await prisma.scopeItem.update({ where: { id: item.id }, data: { phaseId: args.phaseId ?? null } });
    return reloadOnProject(item.projectId, args.contractId);
  },

  createDemo: async (
    _p: unknown,
    args: { phaseId: string; stagingUrl: string; buildRef?: string | null; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'builds.author');
    assertHttps(args.stagingUrl);
    const phase = await loadPhase(args.phaseId);
    await requireBuildAuthorOnPhase(ctx, phase.id);
    await prisma.demo.create({
      data: { phaseId: phase.id, stagingUrl: args.stagingUrl, buildRef: args.buildRef ?? null },
    });
    return reloadOnProject(phase.projectId, args.contractId ?? phase.contractId);
  },

  updateDemo: async (
    _p: unknown,
    args: {
      demoId: string;
      stagingUrl?: string | null;
      buildRef?: string | null;
      // The DateTime scalar's parseValue (graphql-scalars) already returns a
      // JS Date, never a string, so these arrive parsed — no conversion
      // needed here, only the omitted/null/set three-way handling below.
      reviewWindowStart?: Date | null;
      reviewWindowEnd?: Date | null;
      contractId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'builds.author');
    const demo = await loadDemo(args.demoId);
    await requireBuildAuthorOnPhase(ctx, demo.phaseId);
    if (args.stagingUrl) assertHttps(args.stagingUrl);
    await prisma.demo.update({
      where: { id: demo.id },
      data: {
        stagingUrl: args.stagingUrl ?? undefined,
        buildRef: args.buildRef === undefined ? undefined : args.buildRef,
        reviewWindowStart: args.reviewWindowStart === undefined ? undefined : args.reviewWindowStart,
        reviewWindowEnd: args.reviewWindowEnd === undefined ? undefined : args.reviewWindowEnd,
      },
    });
    return reloadOnProject(demo.phase.projectId, args.contractId ?? demo.phase.contractId);
  },

  /** Pages and unmatched-path records cascade (schema.prisma onDelete: Cascade). */
  deleteDemo: async (_p: unknown, args: { demoId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const demo = await loadDemo(args.demoId);
    await requireBuildAuthorOnPhase(ctx, demo.phaseId);
    await prisma.demo.delete({ where: { id: demo.id } });
    return reloadOnProject(demo.phase.projectId, args.contractId ?? demo.phase.contractId);
  },

  declareDemoPage: async (
    _p: unknown,
    args: {
      demoId: string;
      key: string;
      labelFa: string;
      labelEn: string;
      canonicalPath: string;
      pageDesignId?: string | null;
      contractId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'builds.author');
    const demo = await loadDemo(args.demoId);
    await requireBuildAuthorOnPhase(ctx, demo.phaseId);
    if (args.pageDesignId) {
      await assertPageDesignInProject(args.pageDesignId, demo.phase.projectId);
    }
    await prisma.demoPage.create({
      data: {
        demoId: demo.id,
        key: args.key,
        labelFa: args.labelFa,
        labelEn: args.labelEn,
        canonicalPath: args.canonicalPath,
        pageDesignId: args.pageDesignId ?? null,
      },
    });
    return reloadOnProject(demo.phase.projectId, args.contractId ?? demo.phase.contractId);
  },

  updateDemoPage: async (
    _p: unknown,
    args: {
      demoPageId: string;
      labelFa: string;
      labelEn: string;
      canonicalPath: string;
      pageDesignId?: string | null;
      contractId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'builds.author');
    const page = await loadDemoPage(args.demoPageId);
    await requireBuildAuthorOnPhase(ctx, page.demo.phaseId);
    if (args.pageDesignId) {
      await assertPageDesignInProject(args.pageDesignId, page.demo.phase.projectId);
    }
    await prisma.demoPage.update({
      where: { id: page.id },
      data: {
        labelFa: args.labelFa,
        labelEn: args.labelEn,
        canonicalPath: args.canonicalPath,
        pageDesignId: args.pageDesignId ?? null,
      },
    });
    return reloadOnProject(page.demo.phase.projectId, args.contractId ?? page.demo.phase.contractId);
  },

  deleteDemoPage: async (_p: unknown, args: { demoPageId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const page = await loadDemoPage(args.demoPageId);
    await requireBuildAuthorOnPhase(ctx, page.demo.phaseId);
    await prisma.demoPage.delete({ where: { id: page.id } });
    return reloadOnProject(page.demo.phase.projectId, args.contractId ?? page.demo.phase.contractId);
  },
};
