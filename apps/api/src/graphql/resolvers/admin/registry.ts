import { GraphQLError } from 'graphql';
import type { Prisma, ScopeKind, ScopeStatus } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { buildAmendmentSnapshot, contentHash } from '../../../lib/revision.js';
import {
  assertCanConfirmTradeAsRoot,
  assertCanExecuteTrade,
  isAgreedOrBeyond,
  reorderTargetIndex,
} from '../../../lib/scope.js';
import { scopeKindForKey } from '../../../lib/templates.js';
import { reload } from '../contracts.js';
import { assertProjectActive, contractOnProject, primaryContractId, reloadOnProject } from './shared.js';
import { syncBriefDependencies } from '../brief.js';
import { assertStepOpenOn } from '../wizard.js';
import { lockContract } from '../../../lib/stepApproval.js';

/**
 * The scope registry (build plan L1; spec §3): create/edit/reorder items, set
 * status and flags, and the scope-trade lifecycle. Part of the L1 split of
 * the former `admin.ts`; see `index.ts`.
 *
 * Every mutation here that touches a `ScopeItem` returns `Contract!`, exactly
 * as the pre-L1 `addScopeItem`/`updateScopeItem`/`deleteScopeItem` did — the
 * registry moved from Contract to Project underneath, but the desk's Scope
 * tab still opens on a contract. Since J2 a project can hold more than one
 * contract, so each mutation takes an optional `contractId` — the contract
 * the caller has open — and returns that one (`reloadOnProject`, shared.ts,
 * which says why the old "the project's first contract" was retired).
 */
async function loadScopeItem(scopeItemId: string) {
  const item = await prisma.scopeItem.findUnique({ where: { id: scopeItemId } });
  if (!item) {
    throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
  }
  return item;
}

/**
 * **The agreement locks what the scope *is*** (journeys build plan J7): adding,
 * relabelling and deleting a registry item change what the customer agreed to,
 * so once the contract that agreed the item has its AGREEMENT approved they are
 * `STEP_LOCKED` — post-lock change is a scope trade or an amendment. Under the
 * contract's row lock, like every other step-1–2 write.
 *
 * **What is deliberately not locked here**: the status, flags, decision, origin
 * and order of an item. Those are how a project *lives* after the agreement —
 * `IN_BUILD`, `IN_DEMO`, `ACCEPTED` are the build lifecycle's, and a decided
 * note or a reorder does not change what was agreed. (`setScopeItemStatus` can
 * still move an item to `DECLINED`; that is a hole the plan does not close and
 * this stage records rather than papers over — J5+J6's owed desk Scope tab is
 * where the whole registry gets sorted out for the new road.) The item's own
 * `contractId` names the agreement that locks it; an item with none falls back to
 * the contract the caller has open, and with neither there is nothing to lock.
 */
async function inOpenScope<T>(
  item: { contractId: string | null },
  openContractId: string | null | undefined,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const contractId = item.contractId ?? openContractId ?? null;
  return prisma.$transaction(async (tx) => {
    if (contractId) {
      await lockContract(tx, contractId);
      await assertStepOpenOn(contractId, 'SCOPE', null, tx);
    }
    return write(tx);
  });
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
    args: { contractId: string; key: string; labelFa: string; labelEn: string; kind?: ScopeKind | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'SCOPE', null, tx);
      const count = await tx.scopeItem.count({ where: { projectId: contract.projectId } });
      await tx.scopeItem.create({
        data: {
          projectId: contract.projectId,
          key: args.key,
          labelFa: args.labelFa,
          labelEn: args.labelEn,
          position: count,
          status: 'AGREED',
          // T1: an explicit kind wins; without one the key decides, by the same
          // rule the migration classified existing rows with.
          kind: args.kind ?? scopeKindForKey(args.key),
          // Agreed by this contract — it is the one the desk typed it into.
          contractId: contract.id,
        },
      });
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
    args: { scopeItemId: string; labelFa: string; labelEn: string; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    await inOpenScope(item, args.contractId, (tx) =>
      tx.scopeItem.update({
        where: { id: item.id },
        data: { labelFa: args.labelFa, labelEn: args.labelEn },
      }),
    );
    return reloadOnProject(item.projectId, args.contractId);
  },

  deleteScopeItem: async (_p: unknown, args: { scopeItemId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    await inOpenScope(item, args.contractId, (tx) => tx.scopeItem.delete({ where: { id: item.id } }));
    return reloadOnProject(item.projectId, args.contractId);
  },

  /** reason is stored only for DECLINED; switching away from DECLINED clears it. */
  setScopeItemStatus: async (
    _p: unknown,
    args: { scopeItemId: string; status: ScopeStatus; reason?: string | null; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    const data = {
      status: args.status,
      declinedReason: args.status === 'DECLINED' ? (args.reason ?? null) : null,
    };
    if (item.kind !== 'EXTRA') {
      await prisma.scopeItem.update({ where: { id: item.id }, data });
      return reloadOnProject(item.projectId, args.contractId);
    }
    // An extra (J4) implies commitments on the dependency board, so changing its
    // status here — the generic door, which `setExtra` deliberately is not —
    // must leave the board saying what the registry says. Removals and side
    // flips only: a row needs a date, and the brief's form is where one is set.
    const contractId = await contractOnProject(item.projectId, args.contractId);
    await prisma.$transaction(async (tx) => {
      await tx.scopeItem.update({ where: { id: item.id }, data });
      await syncBriefDependencies(tx, contractId, user.id);
    });
    return reloadOnProject(item.projectId, contractId);
  },

  setScopeItemFlags: async (
    _p: unknown,
    args: { scopeItemId: string; temporary: boolean; outOfScope: boolean; adminWork: boolean; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { temporary: args.temporary, outOfScope: args.outOfScope, adminWork: args.adminWork },
    });
    return reloadOnProject(item.projectId, args.contractId);
  },

  /**
   * Both fields together, never one alone — the migration's CHECK constraint
   * holds this at the database, this mutation is just the write path that
   * agrees with it.
   */
  decideScopeItem: async (_p: unknown, args: { scopeItemId: string; note: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
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
    return reloadOnProject(item.projectId, args.contractId);
  },

  undecideScopeItem: async (_p: unknown, args: { scopeItemId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { decidedAt: null, decidedNote: null },
    });
    return reloadOnProject(item.projectId, args.contractId);
  },

  setScopeItemOrigin: async (
    _p: unknown,
    args: { scopeItemId: string; note?: string | null; round?: string | null; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const item = await loadScopeItem(args.scopeItemId);
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { originNote: args.note ?? null, originRound: args.round ?? null },
    });
    return reloadOnProject(item.projectId, args.contractId);
  },

  /**
   * Swaps `position` with the neighbour in that direction. Unlike Article's
   * `number` (T6 in V2.md), `position` carries no uniqueness constraint, so a
   * plain two-row swap needs no temporary value to avoid a collision.
   */
  reorderScopeItem: async (
    _p: unknown,
    args: { scopeItemId: string; direction: 'UP' | 'DOWN'; contractId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
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
    return reloadOnProject(item.projectId, args.contractId);
  },

  /**
   * Proposes a paired movement (spec §4): `outItemId` must already be agreed
   * or further along — a proposed or declined item is not "in scope" to
   * trade away. The new item is created PROPOSED; neither item actually
   * moves until `executeScopeTrade`.
   */
  proposeScopeTrade: async (
    _p: unknown,
    args: { projectId: string; outItemId: string; inKey: string; inLabelFa: string; inLabelEn: string; contractId?: string | null },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.author');
    await assertProjectActive(args.projectId);
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
          kind: scopeKindForKey(args.inKey),
          // No contractId yet: nothing has agreed this item. `executeScopeTrade`
          // sets it when the trade is confirmed and the item becomes AGREED.
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
    return reloadOnProject(args.projectId, args.contractId);
  },

  /**
   * Root's own confirmation. The customer's is `confirmScopeTradeCustomer`
   * (resolvers/scope.ts, journeys build plan J5) — L1 left it as a marked TODO
   * rather than block on the portal half; see docs/development/L1.md.
   */
  confirmScopeTradeRoot: async (_p: unknown, args: { tradeId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const trade = await prisma.scopeTrade.findUnique({ where: { id: args.tradeId } });
    if (!trade) {
      throw new GraphQLError('No such trade.', { extensions: { code: 'NOT_FOUND' } });
    }
    assertCanConfirmTradeAsRoot(trade);
    await prisma.scopeTrade.update({ where: { id: trade.id }, data: { rootConfirmedAt: new Date() } });
    return reloadOnProject(trade.projectId, args.contractId);
  },

  /**
   * Refused until both `rootConfirmedAt` and `customerConfirmedAt` are set.
   * Until J5 that meant this could never succeed, because nothing set the
   * customer half; `confirmScopeTradeCustomer` now does, and **this gate did not
   * change** — it had required both since L1, exactly so the day that mutation
   * landed nothing here would have to. Not under `assertStepOpenOn`: a trade is
   * how a scope changes after SCOPE has locked (journeys §3.1 point 5).
   */
  executeScopeTrade: async (_p: unknown, args: { tradeId: string; contractId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const trade = await prisma.scopeTrade.findUnique({
      where: { id: args.tradeId },
      include: { outItem: true, inItem: true },
    });
    if (!trade) {
      throw new GraphQLError('No such trade.', { extensions: { code: 'NOT_FOUND' } });
    }
    assertCanExecuteTrade(trade);

    // The paired amendment (spec §4: "the contract view updates via a paired
    // amendment") — only when there is a signed contract to amend. A contract
    // not yet signed trades registry items with no document to update;
    // amendmentId stays null, exactly as schema.prisma documents.
    //
    // **Which contract's agreement is being amended** is the one that agreed
    // the item going out (T1's `ScopeItem.contractId`): with a second contract
    // on the project (J2) "the project's first contract" is the wrong
    // document as often as the right one. A pre-T1 row that names none falls
    // back to the project's first, which is what every trade did before.
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: trade.outItem.contractId ?? (await primaryContractId(trade.projectId)) },
      include: { currentContractRevision: { include: { signature: true } } },
    });
    const signedRevision = contract.currentContractRevision?.signature
      ? contract.currentContractRevision
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.scopeItem.update({ where: { id: trade.outItem.id }, data: { status: 'TRADED' } });
      // The trade is what agrees the incoming item, so the contract it
      // amends is the one that agreed it (T1).
      await tx.scopeItem.update({
        where: { id: trade.inItem.id },
        data: { status: 'AGREED', contractId: contract.id },
      });

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

    return reloadOnProject(trade.projectId, args.contractId);
  },
};
