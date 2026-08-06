import { createHash } from 'node:crypto';

/**
 * Snapshotting and hashing a contract revision.
 *
 * The whole point of a `contentHash` is that a signature attests to specific
 * bytes. That only works if the same contract always produces the same bytes,
 * which plain `JSON.stringify` does not guarantee — its key order follows
 * insertion order, so two equal contracts assembled by different code paths
 * hash differently. A hash that varies with how the object was built attests
 * to nothing, which for a signed legal instrument is worse than having no hash
 * at all. Hence one canonical form, in one file, used by both the publish path
 * and the backfill.
 */

/** Bumped only when the snapshot *shape* changes, so old hashes stay readable. */
export const SNAPSHOT_FORMAT = 1;

export type ArticleSnapshot = {
  number: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string | null;
  bodyEn: string | null;
};

export type ContractSnapshot = {
  format: number;
  ref: string;
  titleFa: string;
  titleEn: string;
  /** Toman, as a decimal string: `amount` is a BigInt and does not survive JSON. */
  amount: string | null;
  articles: ArticleSnapshot[];
};

export type AmendmentSnapshot = {
  format: number;
  ordinal: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string;
  bodyEn: string;
};

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Deterministic JSON: object keys sorted, no whitespace, arrays left in their
 * given order (article order is meaningful — it is the contract's order).
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Cannot canonicalize a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k] as Json)}`)
    .join(',');
  return `{${body}}`;
}

export function contentHash(snapshot: ContractSnapshot | AmendmentSnapshot): string {
  return createHash('sha256').update(canonicalize(snapshot as unknown as Json), 'utf8').digest('hex');
}

type ContractDraft = {
  ref: string;
  titleFa: string;
  titleEn: string;
  amount: bigint | null;
};

type ArticleDraft = {
  number: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string | null;
  bodyEn: string | null;
};

/**
 * Freezes the editable draft — the contract's title and fee plus its `Article`
 * rows — into the snapshot a revision carries. Articles are ordered by number
 * here rather than trusting the caller's query, so the snapshot does not depend
 * on an `orderBy` somewhere else.
 */
export function buildContractSnapshot(
  contract: ContractDraft,
  articles: ArticleDraft[],
): ContractSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    ref: contract.ref,
    titleFa: contract.titleFa,
    titleEn: contract.titleEn,
    amount: contract.amount === null ? null : contract.amount.toString(),
    articles: [...articles]
      .sort((a, b) => a.number - b.number)
      .map((a) => ({
        number: a.number,
        titleFa: a.titleFa,
        titleEn: a.titleEn,
        bodyFa: a.bodyFa,
        bodyEn: a.bodyEn,
      })),
  };
}

export type DraftState = {
  snapshot: ContractSnapshot;
  /** The hash this draft would publish as. */
  hash: string;
  /**
   * True when publishing would produce something different from what is live.
   * An absent current revision counts as dirty, and so does an *unsealed* one —
   * a backfilled v1 has no hash to compare against, and treating "no hash" as
   * "unchanged" would refuse the very publish that seals it.
   */
  dirty: boolean;
};

/**
 * The single computation behind both `ContractDraft.dirty` and
 * `publishContractRevision`'s `NO_CHANGES` refusal. They are the same
 * question — whether publishing this draft would produce something different
 * from what is live — and must not be answered twice.
 */
export function draftState(
  contract: ContractDraft,
  articles: ArticleDraft[],
  current: { contentHash: string | null } | null,
): DraftState {
  const snapshot = buildContractSnapshot(contract, articles);
  const hash = contentHash(snapshot);
  const dirty = current === null || current.contentHash === null || current.contentHash !== hash;
  return { snapshot, hash, dirty };
}

export function buildAmendmentSnapshot(a: {
  ordinal: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string;
  bodyEn: string;
}): AmendmentSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    ordinal: a.ordinal,
    titleFa: a.titleFa,
    titleEn: a.titleEn,
    bodyFa: a.bodyFa,
    bodyEn: a.bodyEn,
  };
}

/**
 * Reads a stored snapshot back. Prisma types `Json` loosely, and a revision
 * created by the backfill migration is unsealed until `npm run backfill` has
 * run — null here means exactly that, and callers must handle it rather than
 * pretend the revision has content.
 */
export function readContractSnapshot(value: unknown): ContractSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ContractSnapshot;
}

export type ArticleChangeKind = 'added' | 'changed' | 'removed' | 'unchanged';

export type SnapshotDiff = {
  titleChanged: boolean;
  amountChanged: boolean;
  articles: Array<{ number: number; titleFa: string; titleEn: string; kind: ArticleChangeKind }>;
};

/**
 * What changed between the revision the customer last approved and the one in
 * front of them now (V3.md §3.1) — pure, beside the canonical form it reads,
 * so it stays unit-testable without a database.
 *
 * A null `before` means the earlier revision is unsealed — a backfilled v1
 * whose snapshot was never built. Everything then reads as `added`, which is
 * honest: there is no recorded text to have changed from.
 */
export function diffSnapshots(before: ContractSnapshot | null, after: ContractSnapshot): SnapshotDiff {
  const titleChanged = before === null || before.titleFa !== after.titleFa || before.titleEn !== after.titleEn;
  const amountChanged = before === null || before.amount !== after.amount;

  const beforeByNumber = new Map((before?.articles ?? []).map((a) => [a.number, a]));
  const articles: SnapshotDiff['articles'] = [];

  for (const article of after.articles) {
    const prior = beforeByNumber.get(article.number);
    const kind: ArticleChangeKind =
      prior === undefined
        ? 'added'
        : prior.titleFa === article.titleFa &&
            prior.titleEn === article.titleEn &&
            prior.bodyFa === article.bodyFa &&
            prior.bodyEn === article.bodyEn
          ? 'unchanged'
          : 'changed';
    articles.push({ number: article.number, titleFa: article.titleFa, titleEn: article.titleEn, kind });
    beforeByNumber.delete(article.number);
  }
  for (const gone of beforeByNumber.values()) {
    articles.push({ number: gone.number, titleFa: gone.titleFa, titleEn: gone.titleEn, kind: 'removed' });
  }

  return { titleChanged, amountChanged, articles };
}
