import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { lastPhaseOf } from './phase.js';

/**
 * **The one writer of `ScopeItem.phaseId`** (DX2b; desk UX review item 10,
 * decisions 6 and 7). An item may sit in several phases — shown in one, fixed in
 * the next — and that set is the `ScopeItemPhase` rows. `ScopeItem.phaseId` stays
 * because ~90 readers mean "the phase whose acceptance accepts this item", and
 * that is exactly the highest-numbered phase of the set (spec: an item counts as
 * accepted once the last phase it is in is accepted). So the two are written
 * together, here, and nothing else assigns `phaseId`: every mutation that puts an
 * item in a phase calls this.
 *
 * Takes the transaction, so a caller that is already under the contract's lock
 * stays under it. Every phase must belong to the item's project
 * (`PHASE_WRONG_PROJECT`, the code `assignScopeItemToPhase` always used). Returns
 * the phase ids as stored (deduplicated).
 */
export async function setItemPhases(tx: Prisma.TransactionClient, scopeItemId: string, phaseIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(phaseIds)];
  const item = await tx.scopeItem.findUnique({ where: { id: scopeItemId }, select: { projectId: true } });
  if (!item) throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
  const phases = await tx.phase.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, projectId: true } });
  if (phases.length !== ids.length) throw new GraphQLError('No such phase.', { extensions: { code: 'NOT_FOUND' } });
  if (phases.some((p) => p.projectId !== item.projectId)) {
    throw new GraphQLError('That phase belongs to a different project.', { extensions: { code: 'PHASE_WRONG_PROJECT' } });
  }
  await tx.scopeItemPhase.deleteMany({ where: { scopeItemId, phaseId: { notIn: ids } } });
  if (ids.length > 0) {
    await tx.scopeItemPhase.createMany({ data: ids.map((phaseId) => ({ scopeItemId, phaseId })), skipDuplicates: true });
  }
  await tx.scopeItem.update({ where: { id: scopeItemId }, data: { phaseId: lastPhaseOf(phases) } });
  return ids;
}

/**
 * Re-derives `phaseId` from the links that are left — for the one event that
 * changes a set without a caller choosing it: **a phase is deleted**. The links
 * cascade away and `ScopeItem.phaseId` goes null by the column's own `SetNull`,
 * which is wrong for an item that is still in an earlier phase. Called for the
 * items that were in the deleted phase.
 */
export async function resyncItemPhase(tx: Prisma.TransactionClient, scopeItemId: string): Promise<void> {
  const links = await tx.scopeItemPhase.findMany({ where: { scopeItemId }, select: { phase: { select: { id: true, number: true } } } });
  await tx.scopeItem.update({ where: { id: scopeItemId }, data: { phaseId: lastPhaseOf(links.map((l) => l.phase)) } });
}
