import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { reload } from '../contracts.js';
import { reloadOnProject } from './shared.js';
import { requireBuildAuthorOnPhase, siteDemo } from '../access.js';
import { assertStepOpenOn } from '../wizard.js';
import { lockContract } from '../../../lib/stepApproval.js';
import { parseCalendarDay } from '../../../lib/calendarDay.js';
import { checkStagingUrl, type StagingRefusal } from '../../../lib/stagingHost.js';
import { env } from '../../../lib/env.js';
import { clearPageMapConfirmation, openDemo } from '../demoStep.js';

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

const STAGING_REFUSALS: Record<StagingRefusal, string> = {
  INVALID_STAGING_URL: 'That is not a valid URL.',
  // L2.2: mixed content is a silently blank iframe, not an error a reviewer can
  // act on — refusing at write time is the only point this can be caught with a
  // message attached to it. Production only, since J10 (see `lib/stagingHost.ts`).
  STAGING_NOT_HTTPS: 'The staging URL must be HTTPS, or a browser will not frame it at all.',
  STAGING_HOST_NOT_ALLOWED: 'A staging site must be exactly one label under the staging domain.',
};

/**
 * **Every path that sets a SITE demo's staging URL asks this** (`createDemo`,
 * `updateDemo`; journeys build plan J10): the host must be exactly one label under
 * `STAGING_BASE_DOMAIN`, and in production the scheme `https` — the rule is
 * `lib/stagingHost.ts`'s. Returns the URL in the form that was checked, which is
 * what gets stored (the origin the viewport listens to is then the origin that
 * passed).
 */
function stagingUrlOrThrow(url: string): string {
  const result = checkStagingUrl(url, { baseDomain: env.STAGING_BASE_DOMAIN, production: env.NODE_ENV === 'production' });
  if (!result.ok) {
    throw new GraphQLError(STAGING_REFUSALS[result.reason], { extensions: { code: result.reason } });
  }
  return result.normalized;
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
  // J9: a MOCKUP demo has no phase and is not this surface's (`siteDemo`).
  return siteDemo(demo);
}

async function loadDemoPage(demoPageId: string) {
  const page = await prisma.demoPage.findUnique({
    where: { id: demoPageId },
    include: { demo: { include: { phase: true } } },
  });
  if (!page) {
    throw new GraphQLError('No such demo page.', { extensions: { code: 'NOT_FOUND' } });
  }
  // J9: as `loadDemo` — a page of a MOCKUP demo is not this surface's either.
  return { ...page, demo: siteDemo(page.demo) };
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
          // Omitted leaves it (the step-1 form edits a phase without knowing its
          // milestone label); null clears it, as the phase board always meant.
          milestoneLabel: args.milestoneLabel === undefined ? undefined : args.milestoneLabel,
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
      // An approved phase cannot be deleted out from under its own lock
      // (`StepApproval.phaseId` restricts; this is the code before Postgres's).
      await assertStepOpenOn(phase.contractId, 'DEMO', phase.id, tx);
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
    const phase = await loadPhase(args.phaseId);
    await requireBuildAuthorOnPhase(ctx, phase.id);
    // The host rule after the guards, so a caller who may not touch this phase is
    // told that and nothing about what a staging URL may look like (J10).
    const stagingUrl = stagingUrlOrThrow(args.stagingUrl);
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, phase.id);
      await tx.demo.create({
        // `kind` is SITE by the column's default; `projectId` is the phase's
        // (J9 — a demo names its project directly, because a MOCKUP demo has no
        // phase to reach it through).
        data: { kind: 'SITE', projectId: phase.projectId, phaseId: phase.id, stagingUrl, buildRef: args.buildRef ?? null },
      });
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
    const stagingUrl = args.stagingUrl ? stagingUrlOrThrow(args.stagingUrl) : undefined;
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, demo.phaseId);
      const current = await tx.demo.findUniqueOrThrow({ where: { id: demo.id }, select: { stagingUrl: true } });
      // **A changed URL clears readiness** (J10, trap 1): the claim "a browser heard
      // the snippet from this origin" was about the old address, and publishing on
      // the strength of it would put an unverified site in front of the customer.
      const moved = stagingUrl !== undefined && stagingUrl !== current.stagingUrl;
      await tx.demo.update({
        where: { id: demo.id },
        data: {
          stagingUrl,
          ...(moved ? { readyAt: null, readyVerifiedById: null } : {}),
          buildRef: args.buildRef === undefined ? undefined : args.buildRef,
          reviewWindowStart: args.reviewWindowStart === undefined ? undefined : args.reviewWindowStart,
          reviewWindowEnd: args.reviewWindowEnd === undefined ? undefined : args.reviewWindowEnd,
        },
      });
    });
    return reloadOnProject(demo.phase.projectId, args.contractId ?? demo.phase.contractId);
  },

  /** Pages and unmatched-path records cascade (schema.prisma onDelete: Cascade). */
  deleteDemo: async (_p: unknown, args: { demoId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const demo = await loadDemo(args.demoId);
    await requireBuildAuthorOnPhase(ctx, demo.phaseId);
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, demo.phaseId);
      await tx.demo.delete({ where: { id: demo.id } });
    });
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
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, demo.phaseId);
      await tx.demoPage.create({
        data: {
          demoId: demo.id,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          canonicalPath: args.canonicalPath,
          pageDesignId: args.pageDesignId ?? null,
        },
      });
      await clearPageMapConfirmation(tx, demo.phaseId);
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
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, page.demo.phaseId);
      await tx.demoPage.update({
        where: { id: page.id },
        data: {
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          canonicalPath: args.canonicalPath,
          pageDesignId: args.pageDesignId ?? null,
        },
      });
      await clearPageMapConfirmation(tx, page.demo.phaseId);
    });
    return reloadOnProject(page.demo.phase.projectId, args.contractId ?? page.demo.phase.contractId);
  },

  deleteDemoPage: async (_p: unknown, args: { demoPageId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const page = await loadDemoPage(args.demoPageId);
    await requireBuildAuthorOnPhase(ctx, page.demo.phaseId);
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, page.demo.phaseId);
      await tx.demoPage.delete({ where: { id: page.id } });
      await clearPageMapConfirmation(tx, page.demo.phaseId);
    });
    return reloadOnProject(page.demo.phase.projectId, args.contractId ?? page.demo.phase.contractId);
  },
};
