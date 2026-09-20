import { GraphQLError } from 'graphql';
import type { DemoFrameLineKind } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { deriveFrameLines } from '../../../lib/demoFrame.js';
import { sendMail } from '../../../lib/mail.js';
import { demoPublishedEmail } from '../../../lib/mailTemplates.js';
import { env } from '../../../lib/env.js';
import { reload } from '../contracts.js';
import { firstContractId } from './shared.js';

/**
 * Authoring the review frame, and the publish gate it exists to hold (build
 * plan L3; spec §6). Staff only (`contracts.manage`), the same guard every
 * other authoring mutation in `resolvers/admin/` uses — `submitFeedback` and
 * `ratifyFeedback` live in `resolvers/feedback.ts` instead, because those two
 * are ownership-gated (a customer calls them too), not capability-gated.
 *
 * Named without the bare word "review" throughout — see schema.prisma's
 * section comment on `DemoFrame`.
 */

async function loadDemo(demoId: string) {
  const demo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { phase: { include: { project: { include: { customer: true } } } } },
  });
  if (!demo) {
    throw new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });
  }
  return demo;
}

async function loadLine(lineId: string) {
  const line = await prisma.demoFrameLine.findUnique({
    where: { id: lineId },
    include: { frame: { include: { demo: { include: { phase: true } } } } },
  });
  if (!line) {
    throw new GraphQLError('No such frame line.', { extensions: { code: 'NOT_FOUND' } });
  }
  return line;
}

/** Idempotent — a demo has at most one frame (schema.prisma's unique
 *  `demoId`), and both `generateDemoFrame` and `addDemoFrameLine` need it to
 *  exist before they can act, so this is the one place either creates it. */
async function ensureFrame(demoId: string, authoredById: string) {
  return prisma.demoFrame.upsert({
    where: { demoId },
    update: {},
    create: { demoId, authoredById },
  });
}

export const demoFrameMutations = {
  /**
   * Seeds or refreshes the frame's generated lines from the registry
   * (`lib/demoFrame.ts`) — additive only. A line already generated for a
   * given (scope item, bucket) pair is never touched again by this
   * mutation: regenerating must not silently pull a line (and the feedback
   * anchored to it) out from under a reviewer who already commented.
   */
  generateDemoFrame: async (_p: unknown, args: { demoId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
    const frame = await ensureFrame(demo.id, admin.id);

    const items = await prisma.scopeItem.findMany({ where: { projectId: demo.phase.projectId } });
    const candidates = deriveFrameLines(demo.phaseId, items);

    const existing = await prisma.demoFrameLine.findMany({
      where: { frameId: frame.id, scopeItemId: { not: null } },
      select: { scopeItemId: true, kind: true },
    });
    const already = new Set(existing.map((l) => `${l.scopeItemId}:${l.kind}`));
    const toCreate = candidates.filter((c) => !already.has(`${c.scopeItemId}:${c.kind}`));

    if (toCreate.length > 0) {
      const highest = await prisma.demoFrameLine.aggregate({
        where: { frameId: frame.id },
        _max: { position: true },
      });
      let position = (highest._max.position ?? -1) + 1;
      await prisma.demoFrameLine.createMany({
        data: toCreate.map((c) => ({
          frameId: frame.id,
          kind: c.kind,
          textFa: c.textFa,
          textEn: c.textEn,
          scopeItemId: c.scopeItemId,
          position: position++,
        })),
      });
    }

    return reload(await firstContractId(demo.phase.projectId));
  },

  updateDemoFrameSummary: async (
    _p: unknown,
    args: { demoId: string; summaryFa?: string | null; summaryEn?: string | null },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
    const frame = await ensureFrame(demo.id, admin.id);
    await prisma.demoFrame.update({
      where: { id: frame.id },
      data: {
        summaryFa: args.summaryFa === undefined ? undefined : args.summaryFa,
        summaryEn: args.summaryEn === undefined ? undefined : args.summaryEn,
      },
    });
    return reload(await firstContractId(demo.phase.projectId));
  },

  /** A line Root types by hand — no scope item behind it, so it can never
   *  trigger interception (D4 keys off the target's own scope item). */
  addDemoFrameLine: async (
    _p: unknown,
    args: { demoId: string; kind: DemoFrameLineKind; textFa: string; textEn: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
    const frame = await ensureFrame(demo.id, admin.id);
    const highest = await prisma.demoFrameLine.aggregate({ where: { frameId: frame.id }, _max: { position: true } });
    await prisma.demoFrameLine.create({
      data: {
        frameId: frame.id,
        kind: args.kind,
        textFa: args.textFa,
        textEn: args.textEn,
        position: (highest._max.position ?? -1) + 1,
      },
    });
    return reload(await firstContractId(demo.phase.projectId));
  },

  updateDemoFrameLine: async (
    _p: unknown,
    args: { lineId: string; textFa: string; textEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const line = await loadLine(args.lineId);
    await prisma.demoFrameLine.update({
      where: { id: line.id },
      data: { textFa: args.textFa, textEn: args.textEn },
    });
    return reload(await firstContractId(line.frame.demo.phase.projectId));
  },

  /** Cascades to its feedback item, if any (schema.prisma: onDelete: Cascade). */
  deleteDemoFrameLine: async (_p: unknown, args: { lineId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const line = await loadLine(args.lineId);
    await prisma.demoFrameLine.delete({ where: { id: line.id } });
    return reload(await firstContractId(line.frame.demo.phase.projectId));
  },

  /**
   * "A demo cannot be published naked" (spec §6) — refuses without a frame
   * authored first (NO_FRAME). The one writer of `Demo.publishedAt`.
   */
  publishDemo: async (_p: unknown, args: { demoId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const demo = await loadDemo(args.demoId);
    if (demo.publishedAt) {
      throw new GraphQLError('This demo is already published.', { extensions: { code: 'ALREADY_PUBLISHED' } });
    }
    const frame = await prisma.demoFrame.findUnique({ where: { demoId: demo.id } });
    if (!frame) {
      throw new GraphQLError('Author a review frame before publishing this demo.', {
        extensions: { code: 'NO_FRAME' },
      });
    }

    await prisma.demo.update({ where: { id: demo.id }, data: { publishedAt: new Date() } });

    const project = demo.phase.project;
    const contractId = await firstContractId(project.id);
    const customer = project.customer;
    await sendMail({
      to: customer.email,
      ...demoPublishedEmail(customer.locale, {
        customerName: customer.name,
        projectTitleFa: project.titleFa,
        projectTitleEn: project.titleEn,
        portalUrl: `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`,
      }),
    }).catch((err) => console.error('[mail] demo-published send failed', err));

    return reload(contractId);
  },
};
