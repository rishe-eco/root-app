import { prisma } from '../../lib/prisma.js';

/**
 * Which feedback items are about a sensitive article (journeys build plan J4,
 * PD-14, PD-21). A DRAFT note is anchored to `(contractRevisionId,
 * articleNumber)`, and whether *that* article is money-sensitive is a fact
 * about the contract's own `Article` row — so it cannot be read off the item,
 * and `isMoneyAnchored` (lib/feedbackRules.ts, S2) takes it as a flag its
 * loader supplies. S2's loaders passed nothing (every article was
 * non-sensitive because none could be); this is the one loader that supplies
 * the real value, so the queue, the step panel, the attention module and the
 * notification recipients all filter on the same answer.
 *
 * **Sensitivity is read from the live `Article` row with the same number**,
 * not from the published snapshot: the snapshot's bytes are immutable and carry
 * no such flag (a new key would change nothing for old revisions and every
 * hash for new ones, for a fact that is a property of the article's slot, not
 * of a frozen revision's text).
 */

/** `contractId:number` for every sensitive article of these contracts. */
export async function sensitiveArticleKeys(contractIds: readonly string[]): Promise<Set<string>> {
  if (contractIds.length === 0) return new Set();
  const rows = await prisma.article.findMany({
    where: { contractId: { in: [...new Set(contractIds)] }, sensitive: true },
    select: { contractId: true, number: true },
  });
  return new Set(rows.map((r) => `${r.contractId}:${r.number}`));
}

/** Each item with `articleSensitive` set — one query for the whole list. */
export async function withArticleSensitivity<T extends { contractId: string; articleNumber: number | null }>(
  items: readonly T[],
): Promise<Array<T & { articleSensitive: boolean }>> {
  const keys = await sensitiveArticleKeys(items.filter((i) => i.articleNumber !== null).map((i) => i.contractId));
  return items.map((i) => ({
    ...i,
    articleSensitive: i.articleNumber !== null && keys.has(`${i.contractId}:${i.articleNumber}`),
  }));
}
