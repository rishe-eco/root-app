import { GraphQLError } from 'graphql';
import type { Prisma, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, viewerOf, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { approveStepTx, lockContract } from '../../lib/stepApproval.js';
import { assertWithinAllowance } from '../../lib/allowance.js';
import { computeWizard, designPathOf } from '../../lib/steps.js';
import { AGREED_STATUSES } from '../../lib/scope.js';
import { deriveMockupFrame, MOCKUP_FIXED_LINES } from '../../lib/demoFrame.js';
import { UNMAPPED_PATH, bundlePagePaths, isMapped, mockupMappingPath, normalizePath } from '../../lib/demoPages.js';
import { bundleFor } from '../../lib/mockupServe.js';
import { storage } from '../../lib/storage.js';
import { isContractReader } from '../../lib/visibility.js';
import { notify } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { assertStepOpenOn, wizardStateOn } from './wizard.js';
import { requireDesignAuthorOn } from './access.js';
import { allowanceStateOn, tellSalesAllowanceExhausted } from './allowance.js';
import { feedbackItemInclude, stepOwners } from './feedback.js';
import { buildInclude, declareBuildFor, type BuildChangeInputArg } from './buildLedger.js';

/**
 * Step 5 — the mockup (journeys build plan J9b): the designer's demo, its page
 * mapping, its iterations, and the customer's approval. The host that serves a
 * mockup and the grant that opens it are J9a's (`routes/mockups.ts`,
 * `resolvers/mockups.ts`); this is everything that decides *what* is served and
 * *when it counts*.
 *
 * ## Who may do what — every mutation and its guard
 *
 * The designer's surface is **design authorship, not build authorship** (J9a
 * answered `NOT_FOUND` on the developer's surface and left this to be decided):
 * `design.author`, and being this contract's designer (`requireDesignAuthorOn` —
 * the capability and the assignment edge, two mechanisms checked separately,
 * house rule 2).
 *
 * | mutation | capability | edge | step |
 * |---|---|---|---|
 * | `createMockupDemo` | `design.author` | the contract's designer | open (`openMockup`) |
 * | `mapMockupPage` | `design.author` | the contract's designer | open |
 * | `declareMockupBuild` | `design.author` + `answers.direct.mockup` | the contract's designer | open |
 * | `publishBuild` (a MOCKUP build) | `design.author` | the contract's designer | open, and the allowance |
 * | `approveMockup` | — | the contract's own customer | `approveStepTx` |
 * | the upload (`routes/files.ts`) | `design.author` | the contract's designer | — |
 *
 * `assignments.override` (ADMIN) stands in for the edge, as everywhere. A
 * developer, another contract's designer and the customer are each refused by a
 * row of `j9b.test.ts`'s guard table; sales holds neither `design.author` nor the
 * edge, and cannot author a mockup — it extends the allowance (`extendAllowance`)
 * and answers through the approval queue like any step's.
 *
 * ## The lock
 *
 * **Every mutation above but the customer's goes through `openMockup`**, which
 * takes the contract's row lock and refuses `STEP_LOCKED` once the customer has
 * approved. `j9b.test.ts` holds a table of them against `STEP_LOCKED` and a
 * source scan that fails when a call site is added without a row, the way
 * `j7.test.ts` and `j8.test.ts` do for their steps.
 */

type Tx = Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

/**
 * **Every mockup write starts here.** Under the contract's row lock (so a write
 * cannot interleave with the customer's approval or an answer), the step must not
 * be locked (`STEP_LOCKED`), and the contract must be one that has a mockup at
 * all: on the new road (`STEP_NOT_ON_ROAD`), on the custom design path
 * (`BRIEF_MISSING`, `NOT_CUSTOM` — a pre-made contract's step 5 does not exist),
 * with its design approved (`DESIGN_NOT_APPROVED` — the wireframes and palette
 * are what a mockup is made *from*, and a mockup shown before they are settled
 * would put step 5 in front of step 4).
 *
 * The lock comes first and the road after, the order `openDesign` uses: a
 * refusal that depends on state must read that state under the lock.
 */
export async function openMockup(tx: Tx, contractId: string) {
  await lockContract(tx, contractId);
  await assertStepOpenOn(contractId, 'MOCKUP', null, tx);
  const contract = await tx.contract.findUnique({
    where: { id: contractId },
    select: {
      id: true,
      projectId: true,
      sequence: true,
      brief: { select: { designTier: true } },
      stepApprovals: { where: { step: 'DESIGN', phaseId: null }, select: { id: true } },
    },
  });
  if (!contract) throw notFound('contract');
  if (contract.sequence !== 'AGREEMENT_FIRST') {
    throw refuse('STEP_NOT_ON_ROAD', 'This contract has no mockup step.');
  }
  if (!contract.brief) throw refuse('BRIEF_MISSING', 'There is no brief, so there is no design path.');
  if (designPathOf(contract.brief.designTier) !== 'CUSTOM') {
    throw refuse('NOT_CUSTOM', 'A mockup belongs to a custom design.');
  }
  if (contract.stepApprovals.length === 0) {
    throw refuse('DESIGN_NOT_APPROVED', 'The mockup starts once the design is approved.');
  }
  return contract;
}

/** The mockup step's open items — the one definition the declaration reads and the
 *  desk's queue (`Contract.feedbackItems(step: MOCKUP)`, filtered to `OPEN`) agrees
 *  with. `contractId`, not `demoId`: a `general` comment has no demo. */
const openMockupItems = (contractId: string): Prisma.FeedbackItemWhereInput => ({
  step: 'MOCKUP',
  status: 'OPEN',
  contractId,
});

// --- the frame -----------------------------------------------------------------------

/** The pages a bundle has, from its zip's central directory (cached by key —
 *  `bundleFor`). Read **before** a transaction opens: it is file I/O. */
export async function pagePathsOfBundle(file: { key: string }): Promise<Set<string>> {
  const bundle = await bundleFor(file.key, storage.path(file.key));
  return bundlePagePaths(bundle.entries.keys());
}

/**
 * The registry's agreed `PAGE` items of a contract that the mockup demo does not
 * have a page for yet — declared now, unmapped. `createMockupDemo` declares the
 * pages the scope has when the mockup starts; an item a scope trade adds later
 * (J5) would otherwise never be a page of the mockup, and the customer could not
 * comment on it or see it listed as missing.
 */
async function declareMissingPages(tx: Tx, demo: { id: string; projectId: string; contractId: string }): Promise<void> {
  const [items, pages] = await Promise.all([
    tx.scopeItem.findMany({
      where: { projectId: demo.projectId, contractId: demo.contractId, kind: 'PAGE', status: { in: [...AGREED_STATUSES] } },
      orderBy: { position: 'asc' },
    }),
    tx.demoPage.findMany({ where: { demoId: demo.id }, select: { key: true } }),
  ]);
  const have = new Set(pages.map((p) => p.key));
  const missing = items.filter((i) => !have.has(i.key));
  if (missing.length === 0) return;
  await tx.demoPage.createMany({
    data: missing.map((i) => ({
      demoId: demo.id,
      key: i.key,
      labelFa: i.labelFa,
      labelEn: i.labelEn,
      canonicalPath: UNMAPPED_PATH,
    })),
  });
}

/**
 * **Brings the mockup's frame up to date with its pages and a bundle**
 * (`deriveMockupFrame`): one line per registry page, `NEW` when the bundle shows
 * it and `KNOWN_MISSING` when it does not. The frame is not authored — there is
 * nothing for the designer to write that the design does not already say — so it
 * is synced at every write that can change it (declaring an iteration, mapping a
 * page, publishing) and a mockup can never be published "naked" (`NO_FRAME`
 * belongs to `publishDemo`, which a mockup does not use).
 *
 * **A page changing bucket between iterations is its line changing kind, not a
 * new line**: the row — and the customer's thread anchored to it — is kept, and
 * "contact page is missing" becomes "contact page" under NEW the moment the
 * bundle has it. Lines are never deleted here (a thread may hang on one); a page
 * that has left the agreed scope simply stops being updated. The fixed
 * `TEMPORARY` line is not a row at all (`Demo.fixedFrameLines`).
 */
async function syncMockupFrame(
  tx: Tx,
  demo: { id: string; projectId: string; contractId: string },
  authorId: string,
  bundlePaths: ReadonlySet<string>,
): Promise<void> {
  const pages = await tx.demoPage.findMany({ where: { demoId: demo.id } });
  const items = await tx.scopeItem.findMany({
    where: { projectId: demo.projectId, contractId: demo.contractId, kind: 'PAGE', key: { in: pages.map((p) => p.key) } },
    select: { id: true, key: true, position: true },
  });
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const ordered = pages
    .filter((p) => itemByKey.has(p.key))
    .sort((a, b) => itemByKey.get(a.key)!.position - itemByKey.get(b.key)!.position);

  const frame = await tx.demoFrame.upsert({
    where: { demoId: demo.id },
    update: {},
    create: { demoId: demo.id, authoredById: authorId },
  });
  const { lines } = deriveMockupFrame(
    ordered.map((p) => ({
      scopeItemId: itemByKey.get(p.key)!.id,
      labelFa: p.labelFa,
      labelEn: p.labelEn,
      inBundle: isMapped(p) && bundlePaths.has(normalizePath(p.canonicalPath, undefined, { stripHtml: true })),
    })),
  );

  const existing = await tx.demoFrameLine.findMany({
    where: { frameId: frame.id, scopeItemId: { in: lines.map((l) => l.scopeItemId) }, kind: { in: ['NEW', 'KNOWN_MISSING'] } },
    select: { id: true, scopeItemId: true, kind: true },
  });
  const byItem = new Map(existing.map((l) => [l.scopeItemId, l]));
  const highest = await tx.demoFrameLine.aggregate({ where: { frameId: frame.id }, _max: { position: true } });
  let position = (highest._max.position ?? -1) + 1;
  for (const line of lines) {
    const had = byItem.get(line.scopeItemId);
    if (!had) {
      await tx.demoFrameLine.create({
        data: { frameId: frame.id, kind: line.kind, textFa: line.textFa, textEn: line.textEn, scopeItemId: line.scopeItemId, position: position++ },
      });
    } else if (had.kind !== line.kind) {
      await tx.demoFrameLine.update({ where: { id: had.id }, data: { kind: line.kind } });
    }
  }
}

/** The mockup demo a designer's call names, as a `MOCKUP` demo of a contract they
 *  may author — `NOT_FOUND` for anything else, SITE demos included. */
async function mockupDemoOf(demoId: string) {
  const demo = await prisma.demo.findUnique({ where: { id: demoId } });
  if (!demo || demo.kind !== 'MOCKUP' || !demo.contractId) throw notFound('demo');
  return { ...demo, contractId: demo.contractId };
}

// --- the designer's mutations ----------------------------------------------------------

export const mockupMutations = {
  /**
   * **Starts step 5**: the contract's `MOCKUP` demo, with its pages declared from
   * the registry's agreed `PAGE` items of this contract (unmapped — the bundle
   * does not exist yet). One per contract (`MOCKUP_DEMO_EXISTS`).
   *
   * Refusals, in order: `FORBIDDEN`, `NOT_FOUND`, `NOT_ASSIGNED` (the guard),
   * `STEP_LOCKED`, `STEP_NOT_ON_ROAD` (a legacy contract), `BRIEF_MISSING`,
   * `NOT_CUSTOM` (the pre-made path has no mockup), `DESIGN_NOT_APPROVED`,
   * `MOCKUP_DEMO_EXISTS`, `NO_PAGES` (nothing agreed to show).
   */
  createMockupDemo: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    await requireDesignAuthorOn(ctx, args.contractId);
    await prisma.$transaction(async (tx) => {
      const contract = await openMockup(tx, args.contractId);
      if (await tx.demo.findFirst({ where: { kind: 'MOCKUP', contractId: contract.id }, select: { id: true } })) {
        throw refuse('MOCKUP_DEMO_EXISTS', 'This contract already has a mockup.');
      }
      const pages = await tx.scopeItem.findMany({
        where: { projectId: contract.projectId, contractId: contract.id, kind: 'PAGE', status: { in: [...AGREED_STATUSES] } },
        orderBy: { position: 'asc' },
      });
      if (pages.length === 0) throw refuse('NO_PAGES', 'This contract has no agreed pages to show.');
      await tx.demo.create({
        data: {
          kind: 'MOCKUP',
          projectId: contract.projectId,
          contractId: contract.id,
          pages: {
            create: pages.map((p) => ({ key: p.key, labelFa: p.labelFa, labelEn: p.labelEn, canonicalPath: UNMAPPED_PATH })),
          },
        },
      });
    });
    return reload(args.contractId);
  },

  /**
   * Points a mockup page at a path in the bundle — through `normalizePath(…,
   * { stripHtml: true })`, so `about.html`, `/about.html` and `/about/` are one
   * page (`mockupMappingPath`). A blank path unmaps it. Two pages cannot share a
   * path (`PATH_ALREADY_MAPPED`: a reported path would match one of them at
   * random); a path no bundle could hold is `INVALID_PATH`. **The bundle is not
   * consulted to accept a mapping** — the page list is usually filled in just
   * before the iteration is published, and a mapping to a path the bundle lacks
   * is exactly what the frame then says ("missing"), rather than a refusal the
   * designer has to work around.
   *
   * Brings the frame up to date against the demo's newest bundle, when it has one.
   */
  mapMockupPage: async (_p: unknown, args: { demoPageId: string; path: string }, ctx: Context) => {
    requireCapability(ctx, 'design.author');
    const page = await prisma.demoPage.findUnique({ where: { id: args.demoPageId }, include: { demo: true } });
    if (!page || page.demo.kind !== 'MOCKUP' || !page.demo.contractId) throw notFound('demo page');
    const contractId = page.demo.contractId;
    const designer = await requireDesignAuthorOn(ctx, contractId);

    const mapped = mockupMappingPath(args.path);
    if (mapped === null) throw refuse('INVALID_PATH', 'That is not a path a bundle can hold.');

    const newest = await prisma.build.findFirst({
      where: { demoId: page.demoId, kind: 'MOCKUP' },
      orderBy: { number: 'desc' },
      include: { bundleFile: true },
    });
    const bundlePaths = newest?.bundleFile ? await pagePathsOfBundle(newest.bundleFile) : null;

    await prisma.$transaction(async (tx) => {
      await openMockup(tx, contractId);
      if (mapped !== UNMAPPED_PATH) {
        const clash = await tx.demoPage.findFirst({
          where: { demoId: page.demoId, canonicalPath: mapped, id: { not: page.id } },
          select: { key: true },
        });
        if (clash) throw refuse('PATH_ALREADY_MAPPED', 'Another page is already mapped to that path.', { key: clash.key });
      }
      await tx.demoPage.update({ where: { id: page.id }, data: { canonicalPath: mapped } });
      if (bundlePaths) {
        await syncMockupFrame(tx, { id: page.demoId, projectId: page.demo.projectId, contractId }, designer.id, bundlePaths);
      }
    });
    return reload(contractId);
  },

  /**
   * **Declares an iteration** — L3b's `declareBuild` for step 5 (`declareBuildFor`
   * is the shared rule): the uploaded bundle becomes build "mockup N" (numbered
   * per kind — a site's "version 4" is unrelated), and every open MOCKUP
   * feedback item needs a disposition, each one the designer's **direct** answer
   * (`answers.direct.mockup` — the designer holds it, `answerRoute` agrees).
   * Fates are written now, as a site build's are; the customer is told at publish.
   *
   * The file must be a `MOCKUP_BUNDLE` uploaded to *this* contract (`NOT_FOUND`
   * otherwise — another contract's file is indistinguishable from none), and a
   * bundle serves one iteration (`FILE_ALREADY_USED`). A change entry may not name
   * a scope item (`SCOPE_ITEM_NOT_ON_MOCKUP`): a picture of a page does not ship it.
   *
   * Also declares any agreed page the demo lacks and brings the frame up to date,
   * in the same transaction. **Declaring costs nothing**; publishing is what
   * spends the allowance.
   */
  declareMockupBuild: async (
    _p: unknown,
    args: { demoId: string; fileId: string; ref?: string | null; changes: BuildChangeInputArg[] },
    ctx: Context,
  ) => {
    const designer = requireCapability(ctx, 'design.author');
    // A disposition is the designer's direct answer; asked separately from the
    // capability above for the reason `declareBuild` asks `answers.direct.demo`.
    requireCapability(ctx, 'answers.direct.mockup');
    const demo = await mockupDemoOf(args.demoId);
    await requireDesignAuthorOn(ctx, demo.contractId);
    // Early, so a locked step is `STEP_LOCKED` whatever else is wrong; the guard
    // below asks again under the lock.
    await assertStepOpenOn(demo.contractId, 'MOCKUP');

    const file = await prisma.storedFile.findUnique({ where: { id: args.fileId } });
    if (!file || file.class !== 'MOCKUP_BUNDLE' || file.contractId !== demo.contractId) throw notFound('file');
    if (await prisma.build.findFirst({ where: { bundleFileId: file.id }, select: { id: true } })) {
      throw refuse('FILE_ALREADY_USED', 'That bundle is already an iteration.');
    }

    // The step's own open items, named by step (S2's discipline).
    const openItems = await prisma.feedbackItem.findMany({
      where: openMockupItems(demo.contractId),
      select: { id: true, status: true },
    });
    const bundlePaths = await pagePathsOfBundle(file);

    const buildId = await declareBuildFor({
      kind: 'MOCKUP',
      projectId: demo.projectId,
      phaseId: null,
      demoId: demo.id,
      bundleFileId: file.id,
      openItems,
      declarer: designer,
      ref: args.ref,
      changes: args.changes,
      scopeItems: 'REFUSE',
      guard: async (tx) => {
        await openMockup(tx, demo.contractId);
      },
      afterWrite: async (tx) => {
        await declareMissingPages(tx, demo);
        await syncMockupFrame(tx, demo, designer.id, bundlePaths);
      },
    });
    return prisma.build.findUniqueOrThrow({ where: { id: buildId }, include: buildInclude });
  },
};

/**
 * **The mockup branch of `publishBuild`** (called by `builds.ts` once it has read
 * the build's kind). The designer's: `design.author` (a developer, who holds the
 * other surface's capability, hears `NOT_FOUND` — this is not their build) and
 * the contract's designer (`requireDesignAuthorOn`).
 *
 * Inside the contract's lock, in this order: the step is open, nothing newer is
 * already out (`BUILD_SUPERSEDED` — publishing an older draft after a newer
 * iteration would put the customer back a version), **the allowance**
 * (`assertWithinAllowance` over `allowanceStateOn(MOCKUP)`: the iteration about
 * to be published must fit, `ALLOWANCE_EXHAUSTED` — and sales is told, as for a
 * design round — until `extendAllowance` admits one more), the frame is brought
 * up to date against *this* bundle, and the build is published. The demo itself
 * is published with its first iteration: a mockup has no separate publish step
 * (`publishDemo` is the site's), and a customer cannot see or comment on a
 * mockup before an iteration of it is out.
 *
 * The customer is told once — "mockup 2 of 3" is the published count, not the
 * build's number (which skips whenever a draft is abandoned).
 */
export async function publishMockupBuild(ctx: Context, buildId: string) {
  const user = requireUser(ctx);
  if (!can(user, 'design.author')) throw notFound('build');
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    include: { demo: true, bundleFile: true },
  });
  if (!build || build.kind !== 'MOCKUP' || !build.demo?.contractId || !build.bundleFile) throw notFound('build');
  const demo = { ...build.demo, contractId: build.demo.contractId };
  const designer = await requireDesignAuthorOn(ctx, demo.contractId);
  if (build.publishedAt) {
    throw refuse('ALREADY_PUBLISHED', 'This build is already published.');
  }
  const bundlePaths = await pagePathsOfBundle(build.bundleFile);

  let published: { iteration: number; allowance: number | null };
  try {
    published = await prisma.$transaction(async (tx) => {
      await openMockup(tx, demo.contractId);
      const fresh = await tx.build.findUniqueOrThrow({ where: { id: build.id }, select: { publishedAt: true } });
      if (fresh.publishedAt) throw refuse('ALREADY_PUBLISHED', 'This build is already published.');
      const newer = await tx.build.findFirst({
        where: { demoId: demo.id, kind: 'MOCKUP', number: { gt: build.number }, publishedAt: { not: null } },
        select: { id: true },
      });
      if (newer) throw refuse('BUILD_SUPERSEDED', 'A newer iteration is already published.');

      const before = await allowanceStateOn(tx, demo.contractId, 'MOCKUP');
      assertWithinAllowance(before);

      await declareMissingPages(tx, demo);
      await syncMockupFrame(tx, demo, designer.id, bundlePaths);

      const now = new Date();
      await tx.build.update({ where: { id: build.id }, data: { publishedAt: now } });
      if (!demo.publishedAt) await tx.demo.update({ where: { id: demo.id }, data: { publishedAt: now } });
      return { iteration: (before.used ?? 0) + 1, allowance: before.allowance };
    });
  } catch (err) {
    const e = (err as { extensions?: { code?: string; used?: number; allowance?: number } }).extensions;
    if (e?.code === 'ALLOWANCE_EXHAUSTED' && typeof e.used === 'number' && typeof e.allowance === 'number') {
      await tellSalesAllowanceExhausted(demo.contractId, { used: e.used, allowance: e.allowance }, 'MOCKUP');
    }
    throw err;
  }

  await tellCustomerOfIteration(demo.contractId, published.iteration, published.allowance);
  return prisma.build.findUniqueOrThrow({ where: { id: build.id }, include: buildInclude });
}

// --- who is told -----------------------------------------------------------------------

/** A notification is best-effort: it must never fail the act that caused it. */
async function tell(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error('[mockup] notification failed', err);
  }
}

const localePath = (locale: string | null) => (locale === 'en' ? 'en' : 'fa');

async function tellCustomerOfIteration(contractId: string, iteration: number, allowance: number | null) {
  await tell(async () => {
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: contractId },
      include: { customer: true, project: true },
    });
    await notify(contract.customer, {
      kind: 'MOCKUP_ITERATION_PUBLISHED',
      params: {
        customerName: contract.customer.name,
        projectTitleFa: contract.project.titleFa,
        projectTitleEn: contract.project.titleEn,
        iteration,
        allowance,
        portalUrl: `${env.APP_ORIGIN}/${localePath(contract.customer.locale)}/app/contracts/${contract.id}`,
      },
    });
  });
}

/** The designer told the mockup was approved — `stepOwners`' rule (S2): the
 *  assigned designer, and only when there is none (or they are disabled) those who
 *  hold the step's direct answers. */
async function tellDesignerOfApproval(contract: FullContract) {
  await tell(async () => {
    const recipients = await stepOwners(contract, 'MOCKUP', false);
    await Promise.all(
      recipients.map((r) =>
        notify(r, {
          kind: 'MOCKUP_APPROVED',
          params: {
            recipientName: r.name,
            customerName: contract.customer.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            deskUrl: `${env.APP_ORIGIN}/${localePath(r.locale)}/desk/contracts/${contract.id}/steps`,
          },
        }),
      ),
    );
  });
}

// --- the customer's mutation -------------------------------------------------------------

export const mockupCustomerMutations = {
  /**
   * **Approving the mockup** — `approveStepTx(MOCKUP)` in one transaction under the
   * contract's lock (**one approval writer**: S2's `approveStep` stopped approving
   * MOCKUP so that there is one way to approve it, as J8 did for DESIGN). Refused
   * while any note is unresolved or an answer waits for sales
   * (`STEP_HAS_OPEN_FEEDBACK`, `STEP_HAS_PENDING_ANSWERS`), and — the step's own
   * precondition — until an iteration has been published (`NO_PUBLISHED_MOCKUP`: a
   * customer cannot approve what they have not been shown). After it, every
   * mockup mutation is `STEP_LOCKED`.
   *
   * The contract's own customer and nobody else (`NOT_FOUND` for staff, house
   * rules 2 and 13); the new road's custom path only (`STEP_NOT_APPROVABLE`,
   * `STEP_NOT_ON_ROAD`). Tells the designer.
   */
  approveMockup: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    if (contract.customerId !== user.id) throw notFound('contract');
    if (contract.sequence !== 'AGREEMENT_FIRST') {
      throw refuse('STEP_NOT_APPROVABLE', 'That step cannot be approved this way.');
    }
    const road = computeWizard(await wizardStateOn(contract.id));
    if (!road.some((s) => s.step === ('MOCKUP' satisfies StepKind))) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no mockup step.');
    }

    try {
      await prisma.$transaction((tx) =>
        approveStepTx(tx, { contractId: contract.id, step: 'MOCKUP', phaseId: null, approverId: user.id }, [
          async (inner) => {
            const iterations = await inner.build.count({
              where: { kind: 'MOCKUP', publishedAt: { not: null }, demo: { contractId: contract.id } },
            });
            if (iterations === 0) throw refuse('NO_PUBLISHED_MOCKUP', 'There is no mockup to approve yet.');
          },
        ]),
      );
    } catch (err) {
      // Two approvals at once: the partial unique index on `StepApproval` refuses
      // the second — and the answer the caller should get is the lock.
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw refuse('STEP_LOCKED', 'That step is locked.');
      }
      throw err;
    }
    await tellDesignerOfApproval(contract);
    return reload(contract.id);
  },
};

// --- fields ----------------------------------------------------------------------------

/**
 * The demo as the customer or staff reads it: pages, frame and lines, every
 * feedback item — the shape `phasesWhere` gives a site demo, so one fragment
 * serves both. **A draft (unpublished) mockup is staff's** (`isContractReader`),
 * as a site demo's draft is: the customer's query returns it only once its first
 * iteration is out.
 */
const mockupDemoInclude = {
  pages: { include: { pageDesign: true }, orderBy: { id: 'asc' as const } },
  unmatchedPaths: { orderBy: { lastSeenAt: 'desc' as const } },
  frame: {
    include: {
      authoredBy: true,
      lines: {
        orderBy: [{ kind: 'asc' as const }, { position: 'asc' as const }],
        include: { scopeItem: true, feedbackItem: { include: feedbackItemInclude }, buildChangeEntry: true },
      },
    },
  },
  feedbackItems: { orderBy: { createdAt: 'desc' as const }, include: feedbackItemInclude },
} satisfies Prisma.DemoInclude;

export const contractMockupFields = {
  /** The contract's mockup demo — null on the pre-made path, before the designer
   *  starts step 5, and (for the customer) before the first iteration is out. */
  mockup: async (c: FullContract, _a: unknown, ctx: Context) => {
    const staff = isContractReader(viewerOf(ctx));
    const demo = await prisma.demo.findFirst({
      where: { kind: 'MOCKUP', contractId: c.id, ...(staff ? {} : { publishedAt: { not: null } }) },
      include: mockupDemoInclude,
    });
    if (!demo) return null;
    // Pages in the registry's order, which is the order the customer is told about them.
    const positions = new Map(
      (await prisma.scopeItem.findMany({ where: { projectId: c.projectId, kind: 'PAGE' }, select: { key: true, position: true } })).map(
        (i) => [i.key, i.position] as const,
      ),
    );
    demo.pages.sort((a, b) => (positions.get(a.key) ?? 0) - (positions.get(b.key) ?? 0));
    return demo;
  },
};

export const Demo = {
  /** A MOCKUP demo's iterations, oldest first. The customer sees the published
   *  ones only; a site demo has none (its builds hang off its phase). */
  builds: async (d: { id: string; kind: string }, _a: unknown, ctx: Context) => {
    if (d.kind !== 'MOCKUP') return [];
    const staff = isContractReader(viewerOf(ctx));
    return prisma.build.findMany({
      where: { demoId: d.id, kind: 'MOCKUP', ...(staff ? {} : { publishedAt: { not: null } }) },
      include: { declaredBy: true },
      orderBy: { number: 'asc' },
    });
  },

  /** The frame lines every mockup has and that are words of the interface, not
   *  rows (`MOCKUP_FIXED_LINES`) — codes the web renders from its locale keys. */
  fixedFrameLines: (d: { kind: string }) => (d.kind === 'MOCKUP' ? [...MOCKUP_FIXED_LINES] : []),

  /** Staff: the pages the demo's newest bundle has, folded the way a mapping is —
   *  what the desk offers when the designer maps a page. Empty for anyone else
   *  and before a first iteration is declared. */
  bundlePages: async (d: { id: string; kind: string }, _a: unknown, ctx: Context) => {
    if (d.kind !== 'MOCKUP' || !isContractReader(viewerOf(ctx))) return [];
    const newest = await prisma.build.findFirst({
      where: { demoId: d.id, kind: 'MOCKUP' },
      orderBy: { number: 'desc' },
      include: { bundleFile: true },
    });
    if (!newest?.bundleFile) return [];
    return [...(await pagePathsOfBundle(newest.bundleFile))].sort();
  },
};
