import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { storage } from '../../lib/storage.js';
import { parseWorkbook, diffImportRows, type PreviousRow } from '../../lib/serviceImport.js';

/**
 * Services — the product-import panel (build plan L7; spec §9). Lives
 * outside `resolvers/admin/` on purpose, the same reasoning
 * `resolvers/tickets.ts` and `resolvers/demo.ts` already give: a customer
 * uploads, previews and applies their *own* project's runs (ownership,
 * house rule 2), while staff read across every project (capability) and
 * author the billing edge. One file, because both halves are the same
 * concept.
 */

export const serviceRunInclude = {
  project: { select: { id: true, customerId: true, titleFa: true, titleEn: true } },
  file: true,
  uploadedBy: true,
  appliedBy: true,
  billingEntry: true,
  rows: { orderBy: { rowNumber: 'asc' as const } },
} satisfies Prisma.ServiceRunInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/** Staff, or the run's own project's customer — "no such thing," never "not
 *  allowed" (house rule 13), matching `loadTicketForActor`'s own shape. */
async function loadServiceRunForActor(runId: string, user: { id: string; roles: unknown[] }) {
  const run = await prisma.serviceRun.findUnique({ where: { id: runId }, include: serviceRunInclude });
  if (!run) throw notFound('service run');
  const staff = can(user as Parameters<typeof can>[0], 'contracts.manage');
  if (!staff && run.project.customerId !== user.id) throw notFound('service run');
  return run;
}

async function loadProjectForActor(projectId: string, user: { id: string; roles: unknown[] }) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('project');
  const staff = can(user as Parameters<typeof can>[0], 'contracts.manage');
  if (!staff && project.customerId !== user.id) throw notFound('project');
  return project;
}

export const serviceQueries = {
  /** Build plan L7: the caller's own projects, so the portal's services
   *  panel can find its project without a contract in hand — a run
   *  attaches to a project directly, and not every screen that needs one
   *  is reached from a contract. */
  myProjects: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.project.findMany({ where: { customerId: user.id }, orderBy: { createdAt: 'asc' } });
  },

  /** Staff, or the project's own customer. */
  projectServiceRuns: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const project = await loadProjectForActor(args.projectId, user);
    return prisma.serviceRun.findMany({
      where: { projectId: project.id },
      include: serviceRunInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Staff (contracts.manage). Every run, optionally narrowed to one project —
   *  spec §11's "service runs" on the desk side. */
  allServiceRuns: async (_p: unknown, args: { projectId?: string | null }, ctx: Context) => {
    const user = requireUser(ctx);
    if (!can(user, 'contracts.manage')) {
      throw new GraphQLError('You do not have access to that.', { extensions: { code: 'FORBIDDEN' } });
    }
    return prisma.serviceRun.findMany({
      where: args.projectId ? { projectId: args.projectId } : {},
      include: serviceRunInclude,
      orderBy: { createdAt: 'desc' },
    });
  },
};

export const serviceMutations = {
  /**
   * Attaches a file already uploaded through `POST /upload?class=SERVICE_IMPORT`
   * as a new run — the same two-step shape (upload, then a mutation that
   * names it) every other file class in this codebase already uses.
   * Refused (ALREADY_ATTACHED) if the file is already the subject of a run
   * — the unique `ServiceRun.fileId` is the backstop.
   */
  createServiceRun: async (_p: unknown, args: { projectId: string; fileId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const project = await loadProjectForActor(args.projectId, user);

    const file = await prisma.storedFile.findUnique({ where: { id: args.fileId }, include: { serviceRun: true } });
    if (!file || file.class !== 'SERVICE_IMPORT' || file.projectId !== project.id) {
      throw notFound('file');
    }
    if (file.serviceRun) {
      throw new GraphQLError('This file has already been attached to a run.', {
        extensions: { code: 'ALREADY_ATTACHED' },
      });
    }

    return prisma.serviceRun.create({
      data: { projectId: project.id, fileId: file.id, uploadedById: user.id },
      include: serviceRunInclude,
    });
  },

  /**
   * "The preview diff IS the feature" (build plan L7's banked trap) — this
   * is the only mutation that ever writes a `ServiceRunRow`, and
   * `applyServiceRun` refuses to run without one having succeeded first.
   * An unreadable file or a missing required column is not a client
   * error: it sets `status: FAILED` with `failureReason`, a legitimate
   * outcome this schema was built to hold (`ServiceRun_failure_reason_required`).
   * May be called again on an UPLOADED, FAILED, or already-PREVIEWED run
   * (re-reads the file and re-diffs — a customer fixing a rejected row and
   * re-uploading is expected to preview again, not construct a second run
   * for the correction); refused (ALREADY_APPLIED) once the run is applied,
   * since an applied run's rows are now the store the *next* run diffs
   * against and must not move under it.
   */
  previewServiceRun: async (_p: unknown, args: { runId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const run = await loadServiceRunForActor(args.runId, user);
    if (run.status === 'APPLIED') {
      throw new GraphQLError('This run has already been applied and cannot be re-previewed.', {
        extensions: { code: 'ALREADY_APPLIED' },
      });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of storage.read(run.file.key) as AsyncIterable<Buffer>) chunks.push(chunk);
    const parsed = await parseWorkbook(Buffer.concat(chunks));

    if (!parsed.ok) {
      await prisma.$transaction([
        prisma.serviceRunRow.deleteMany({ where: { runId: run.id } }),
        prisma.serviceRun.update({
          where: { id: run.id },
          data: { status: 'FAILED', failureReason: parsed.error, previewedAt: null },
        }),
      ]);
      return prisma.serviceRun.findUniqueOrThrow({ where: { id: run.id }, include: serviceRunInclude });
    }

    // "The store" this run diffs against — the last *applied* run's own
    // rows, absent a live target-system integration (lib/serviceImport.ts's
    // own comment). REJECTED rows never entered the store, so they are
    // excluded from what a later run compares against.
    const previousRun = await prisma.serviceRun.findFirst({
      where: { projectId: run.projectId, status: 'APPLIED' },
      orderBy: { appliedAt: 'desc' },
      include: { rows: { where: { action: { not: 'REJECTED' } } } },
    });
    const previousRows: PreviousRow[] = (previousRun?.rows ?? []).map((r) => ({
      sku: r.sku,
      nameFa: r.nameFa,
      nameEn: r.nameEn,
      price: r.price,
      stock: r.stock,
    }));

    const diffRows = diffImportRows(parsed.rows, previousRows);

    await prisma.$transaction([
      prisma.serviceRunRow.deleteMany({ where: { runId: run.id } }),
      prisma.serviceRunRow.createMany({
        data: diffRows.map((r) => ({
          runId: run.id,
          rowNumber: r.rowNumber,
          sku: r.sku,
          nameFa: r.nameFa,
          nameEn: r.nameEn,
          price: r.price,
          stock: r.stock,
          action: r.action,
          rejectReason: r.rejectReason,
          raw: r.raw as Prisma.InputJsonValue,
        })),
      }),
      prisma.serviceRun.update({
        where: { id: run.id },
        data: { status: 'PREVIEWED', previewedAt: new Date(), failureReason: null },
      }),
    ]);

    return prisma.serviceRun.findUniqueOrThrow({ where: { id: run.id }, include: serviceRunInclude });
  },

  /**
   * Build plan L7's banked trap, held here structurally: refused
   * (NOT_PREVIEWED) unless the run is currently PREVIEWED, and refused
   * (ALREADY_APPLIED) if it already is. There is no path from upload to
   * apply that skips a preview — this is the one and only door, and it is
   * shut against both "never previewed" and "previewed once already, a
   * long time ago, apply it again."
   */
  applyServiceRun: async (_p: unknown, args: { runId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const run = await loadServiceRunForActor(args.runId, user);
    if (run.status === 'APPLIED') {
      throw new GraphQLError('This run has already been applied.', { extensions: { code: 'ALREADY_APPLIED' } });
    }
    if (run.status !== 'PREVIEWED') {
      throw new GraphQLError('A run must be previewed before it can be applied.', {
        extensions: { code: 'NOT_PREVIEWED' },
      });
    }

    await prisma.serviceRun.update({
      where: { id: run.id },
      data: { status: 'APPLIED', appliedAt: new Date(), appliedById: user.id },
    });
    return prisma.serviceRun.findUniqueOrThrow({ where: { id: run.id }, include: serviceRunInclude });
  },
};
