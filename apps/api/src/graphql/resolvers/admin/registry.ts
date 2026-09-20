import { GraphQLError } from 'graphql';
import type { ScopeStatus } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { buildAmendmentSnapshot, contentHash } from '../../../lib/revision.js';
import {
  assertCanConfirmTradeAsRoot,
  assertCanExecuteTrade,
  isAgreedOrBeyond,
  reorderTargetIndex,
} from '../../../lib/scope.js';
import { reload } from '../contracts.js';
import { firstContractId } from './shared.js';

/**
 * The scope registry (build plan L1; spec §3): create/edit/reorder items, set
 * status and flags, and the scope-trade lifecycle. Part of the L1 split of
 * the former `admin.ts`; see `index.ts`.
 *
 * Every mutation here that touches a `ScopeItem` returns `Contract!`, exactly
 * as the pre-L1 `addScopeItem`/`updateScopeItem`/`deleteScopeItem` did — the
 * registry moved from Contract to Project underneath, but the desk's Scope
 * tab still opens on a contract, so `firstContractId` (shared.ts) picks the
 * project's (for now, only ever) contract to reload. A project spanning more
 * than one contract will need a real answer here; neither L1 nor L2 builds
 * the screen that would create one, so this is a deliberate, documented
 * shortcut — see docs/development/L1.md.
 */
async function loadScopeItem(scopeItemId: string) {
  const item = await prisma.scopeItem.findUnique({ where: { id: scopeItemId } });
  if (!item) {
    throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
  }
  return item;
}

export const registryMutations = {
  /**
   * Created AGREED, not PROPOSED — Root typing this into the contract via the
   * desk is itself the agreement act, the same reasoning `applyContractTemplate`
   * uses for the SCOPE template. An item that genuinely starts life only
   * proposed (the scoping-stage flow spec §4 stage 2 describes) has no screen
   * yet — that is L2/L3's to build.
   */
  addScopeItem: async (
    _p: unknown,
    args: { contractId: string; key: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (!contract.projectId) {
      throw new GraphQLError('This contract has no project to hold scope items.', {
        extensions: { code: 'NO_PROJECT' },
      });
    }
    const count = await prisma.scopeItem.count({ where: { projectId: contract.projectId } });
    await prisma.scopeItem.create({
      data: {
        projectId: contract.projectId,
        key: args.key,
        labelFa: args.labelFa,
        labelEn: args.labelEn,
        position: count,
        status: 'AGREED',
      },
    });
    return reload(args.contractId);
  },

  /**
   * `ScopeItem` is the odd one out (V2.md §5): not versioned, not snapshotted,
   * not hashed. A label edited here is visible to the customer the instant
   * it is saved — no draft, no publish, no `requireDraft` guard.
   */
  updateScopeItem: async (
    _p: unknown,
    args: { scopeItemId: string; labelFa: string; labelEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { labelFa: args.labelFa, labelEn: args.labelEn },
    });
    return reload(await firstContractId(item.projectId));
  },

  deleteScopeItem: async (_p: unknown, args: { scopeItemId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.delete({ where: { id: item.id } });
    return reload(await firstContractId(item.projectId));
  },

  /** reason is stored only for DECLINED; switching away from DECLINED clears it. */
  setScopeItemStatus: async (
    _p: unknown,
    args: { scopeItemId: string; status: ScopeStatus; reason?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: {
        status: args.status,
        declinedReason: args.status === 'DECLINED' ? (args.reason ?? null) : null,
      },
    });
    return reload(await firstContractId(item.projectId));
  },

  setScopeItemFlags: async (
    _p: unknown,
    args: { scopeItemId: string; temporary: boolean; outOfScope: boolean; adminWork: boolean },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { temporary: args.temporary, outOfScope: args.outOfScope, adminWork: args.adminWork },
    });
    return reload(await firstContractId(item.projectId));
  },

  /**
   * Both fields together, never one alone — the migration's CHECK constraint
   * holds this at the database, this mutation is just the write path that
   * agrees with it.
   */
  decideScopeItem: async (_p: unknown, args: { scopeItemId: string; note: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    if (item.decidedAt) {
      throw new GraphQLError('This item is already decided — undecide it first.', {
        extensions: { code: 'ALREADY_DECIDED' },
      });
    }
    const note = args.note.trim();
    if (!note) {
      throw new GraphQLError('Say what decided it.', { extensions: { code: 'EMPTY_NOTE' } });
    }
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { decidedAt: new Date(), decidedNote: note },
    });
    return reload(await firstContractId(item.projectId));
  },

  undecideScopeItem: async (_p: unknown, args: { scopeItemId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { decidedAt: null, decidedNote: null },
    });
    return reload(await firstContractId(item.projectId));
  },

  setScopeItemOrigin: async (
    _p: unknown,
    args: { scopeItemId: string; note?: string | null; round?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { originNote: args.note ?? null, originRound: args.round ?? null },
    });
    return reload(await firstContractId(item.projectId));
  },

  /**
   * Swaps `position` with the neighbour in that direction. Unlike Article's
   * `number` (T6 in V2.md), `position` carries no uniqueness constraint, so a
   * plain two-row swap needs no temporary value to avoid a collision.
   */
  reorderScopeItem: async (
    _p: unknown,
    args: { scopeItemId: string; direction: 'UP' | 'DOWN' },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const item = await loadScopeItem(args.scopeItemId);
    const siblings = await prisma.scopeItem.findMany({
      where: { projectId: item.projectId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    const targetIndex = reorderTargetIndex(siblings, item.id, args.direction);
    if (targetIndex !== null) {
      const currentIndex = siblings.findIndex((s) => s.id === item.id);
      const target = siblings[targetIndex];
      const self = siblings[currentIndex];
      await prisma.$transaction([
        prisma.scopeItem.update({ where: { id: self.id }, data: { position: target.position } }),
        prisma.scopeItem.update({ where: { id: target.id }, data: { position: self.position } }),
      ]);
    }
    return reload(await firstContractId(item.projectId));
  },

  /**
   * Proposes a paired movement (spec §4): `outItemId` must already be agreed
   * or further along — a proposed or declined item is not "in scope" to
   * trade away. The new item is created PROPOSED; neither item actually
   * moves until `executeScopeTrade`.
   */
  proposeScopeTrade: async (
    _p: unknown,
    args: { projectId: string; outItemId: string; inKey: string; inLabelFa: string; inLabelEn: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const outItem = await prisma.scopeItem.findUnique({ where: { id: args.outItemId } });
    if (!outItem || outItem.projectId !== args.projectId) {
      throw new GraphQLError('No such scope item on this project.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (!isAgreedOrBeyond(outItem.status)) {
      throw new GraphQLError('Only an agreed (or further along) item can be traded away.', {
        extensions: { code: 'OUT_ITEM_NOT_AGREED' },
      });
    }

    const count = await prisma.scopeItem.count({ where: { projectId: args.projectId } });
    await prisma.$transaction(async (tx) => {
      const inItem = await tx.scopeItem.create({
        data: {
          projectId: args.projectId,
          key: args.inKey,
          labelFa: args.inLabelFa,
          labelEn: args.inLabelEn,
          position: count,
          status: 'PROPOSED',
          originNote: `Proposed in trade for "${outItem.key}"`,
        },
      });
      await tx.scopeTrade.create({
        data: {
          projectId: args.projectId,
          outItemId: outItem.id,
          inItemId: inItem.id,
          proposedById: admin.id,
        },
      });
    });
    return reload(await firstContractId(args.projectId));
  },

  /**
   * Root's own confirmation. **The customer's has no mutation yet** — this is
   * the "clearly-marked TODO" the build plan allows for scope trade rather
   * than blocking L1 on the portal half; see docs/development/L1.md.
   */
  confirmScopeTradeRoot: async (_p: unknown, args: { tradeId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const trade = await prisma.scopeTrade.findUnique({ where: { id: args.tradeId } });
    if (!trade) {
      throw new GraphQLError('No such trade.', { extensions: { code: 'NOT_FOUND' } });
    }
    assertCanConfirmTradeAsRoot(trade);
    await prisma.scopeTrade.update({ where: { id: trade.id }, data: { rootConfirmedAt: new Date() } });
    return reload(await firstContractId(trade.projectId));
  },

  /**
   * Refused until both `rootConfirmedAt` and `customerConfirmedAt` are set —
   * today that means this can never actually succeed, because nothing sets
   * the customer half yet. The gate is real regardless: the day the portal
   * mutation lands, this does not need to change to honour it.
   */
  executeScopeTrade: async (_p: unknown, args: { tradeId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const trade = await prisma.scopeTrade.findUnique({
      where: { id: args.tradeId },
      include: { outItem: true, inItem: true },
    });
    if (!trade) {
      throw new GraphQLError('No such trade.', { extensions: { code: 'NOT_FOUND' } });
    }
    assertCanExecuteTrade(trade);

    // The paired amendment (spec §4: "the contract view updates via a paired
    // amendment") — only when there is a signed contract to amend. A project
    // with no signed contract yet trades registry items with no document to
    // update; amendmentId stays null, exactly as schema.prisma documents.
    const contract = await prisma.contract.findFirst({
      where: { projectId: trade.projectId },
      orderBy: { createdAt: 'asc' },
      include: { currentContractRevision: { include: { signature: true } } },
    });
    const signedRevision = contract?.currentContractRevision?.signature
      ? contract.currentContractRevision
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.scopeItem.update({ where: { id: trade.outItem.id }, data: { status: 'TRADED' } });
      await tx.scopeItem.update({ where: { id: trade.inItem.id }, data: { status: 'AGREED' } });

      let amendmentId: string | null = null;
      if (signedRevision) {
        const latest = await tx.amendment.findFirst({
          where: { contractRevisionId: signedRevision.id },
          orderBy: { ordinal: 'desc' },
        });
        const ordinal = (latest?.ordinal ?? 0) + 1;
        const titleFa = 'اصلاحِ دامنه — جابه‌جاییِ توافقی';
        const titleEn = 'Scope amendment — a confirmed trade';
        const bodyFa = `موردِ «${trade.outItem.labelFa}» با موردِ «${trade.inItem.labelFa}» جابه‌جا شد.`;
        const bodyEn = `"${trade.outItem.labelEn}" was swapped for "${trade.inItem.labelEn}".`;
        const snapshot = buildAmendmentSnapshot({ ordinal, titleFa, titleEn, bodyFa, bodyEn });
        const amendment = await tx.amendment.create({
          data: {
            contractRevisionId: signedRevision.id,
            ordinal,
            titleFa,
            titleEn,
            bodyFa,
            bodyEn,
            contentHash: contentHash(snapshot),
            publishedAt: new Date(),
          },
        });
        amendmentId = amendment.id;
      }

      await tx.scopeTrade.update({
        where: { id: trade.id },
        data: { executedAt: new Date(), amendmentId },
      });
    });

    return reload(await firstContractId(trade.projectId));
  },
};
