import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { reload } from '../contracts.js';
import { firstContractId } from './shared.js';

/**
 * Phases and the live demo surface (build plan L2; spec §4 stage 6, §6).
 *
 * Every mutation here returns `Contract!`, the same convention L1's registry
 * mutations settled on (T9 in V2.md, and `firstContractId`'s own comment in
 * `shared.ts`) — a phase or demo is reached through `project.phases`, never
 * a dedicated payload type.
 *
 * **What this file does not do.** It never writes `PageDesign.approvedAt` or
 * `DesignConcept.chosenAt` — D5 stays decided, and the design-image toggle
 * below reads `imageUrl`/`key` only. It never builds a deploy lock — the
 * review window on `Demo` is two plain dates the review frame (L3) will read
 * into a sentence, not machinery that refuses a deploy. And it never creates
 * a screenshot: no code path here calls out to a headless browser.
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

export const phaseMutations = {
  createPhase: async (
    _p: unknown,
    args: { contractId: string; number: number; titleFa: string; titleEn: string; milestoneLabel?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (!contract.projectId) {
      throw new GraphQLError('This contract has no project to hold phases.', { extensions: { code: 'NO_PROJECT' } });
    }
    await prisma.phase.create({
      data: {
        projectId: contract.projectId,
        number: args.number,
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        milestoneLabel: args.milestoneLabel ?? null,
      },
    });
    return reload(args.contractId);
  },

  updatePhase: async (
    _p: unknown,
    args: { phaseId: string; titleFa: string; titleEn: string; milestoneLabel?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const phase = await loadPhase(args.phaseId);
    await prisma.phase.update({
      where: { id: phase.id },
      data: { titleFa: args.titleFa, titleEn: args.titleEn, milestoneLabel: args.milestoneLabel ?? null },
    });
    return reload(await firstContractId(phase.projectId));
  },

  /** Scope items on this phase are not deleted — `phaseId` just goes back to
   *  null on them (schema.prisma: onDelete: SetNull). Demos cascade. */
  deletePhase: async (_p: unknown, args: { phaseId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const phase = await loadPhase(args.phaseId);
    await prisma.phase.delete({ where: { id: phase.id } });
    return reload(await firstContractId(phase.projectId));
  },

  assignScopeItemToPhase: async (
    _p: unknown,
    args: { scopeItemId: string; phaseId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
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
    return reload(await firstContractId(item.projectId));
  },

  createDemo: async (
    _p: unknown,
    args: { phaseId: string; stagingUrl: string; buildRef?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    assertHttps(args.stagingUrl);
    const phase = await loadPhase(args.phaseId);
    await prisma.demo.create({
      data: { phaseId: phase.id, stagingUrl: args.stagingUrl, buildRef: args.buildRef ?? null },
    });
    return reload(await firstContractId(phase.projectId));
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
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
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
    return reload(await firstContractId(demo.phase.projectId));
  },

  /** Pages and unmatched-path records cascade (schema.prisma onDelete: Cascade). */
  deleteDemo: async (_p: unknown, args: { demoId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
    await prisma.demo.delete({ where: { id: demo.id } });
    return reload(await firstContractId(demo.phase.projectId));
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
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
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
    return reload(await firstContractId(demo.phase.projectId));
  },

  updateDemoPage: async (
    _p: unknown,
    args: {
      demoPageId: string;
      labelFa: string;
      labelEn: string;
      canonicalPath: string;
      pageDesignId?: string | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const page = await loadDemoPage(args.demoPageId);
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
    return reload(await firstContractId(page.demo.phase.projectId));
  },

  deleteDemoPage: async (_p: unknown, args: { demoPageId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const page = await loadDemoPage(args.demoPageId);
    await prisma.demoPage.delete({ where: { id: page.id } });
    return reload(await firstContractId(page.demo.phase.projectId));
  },
};
