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

export type ScopeItemSnapshot = { key: string; labelFa: string; labelEn: string };

export type ContractSnapshot = {
  format: number;
  ref: string;
  titleFa: string;
  titleEn: string;
  /** Toman, as a decimal string: `amount` is a BigInt and does not survive JSON. */
  amount: string | null;
  articles: ArticleSnapshot[];
  /**
   * Appendix 1, as a view of the registry's agreed set (build plan L1; spec
   * §3) rather than free text typed onto an article.
   *
   * **Why this is safe for already-published revisions (L1's sharpest
   * trap).** A `ContractRevision.snapshot` is written once, at publish time,
   * and never recomputed from live data afterward — every read goes through
   * `readContractSnapshot`, which returns exactly the JSON that was stored.
   * This field did not exist before L1, so no snapshot published before L1
   * has it; `contentHash` for those rows was computed, at the time, over an
   * object with no `scopeItems` key, and stays that way forever. Adding the
   * key here changes only what `buildContractSnapshot` produces for
   * revisions published *from now on* — it is a new input for new output,
   * never a reinterpretation of old output. See docs/development/L1.md.
   */
  scopeItems: ScopeItemSnapshot[];
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

/** Bumped only when a document snapshot's *shape* changes (C1.md §2.1) — its
 *  own tag, never SNAPSHOT_FORMAT: a shared version number that means two
 *  different things means neither. */
export const DOCUMENT_SNAPSHOT_FORMAT = 1;

/** One block of a Review Room document's frozen text, split once at publish
 *  time and stored, never recomputed (C1.md §2) — so a comment can anchor to
 *  (blockId, start, end) and stay meaningful no matter how the block is later
 *  rendered. `text` is the block's markdown source, verbatim. */
export type Block = {
  id: string;
  kind: 'HEADING' | 'PARAGRAPH' | 'CODE' | 'LIST' | 'QUOTE' | 'TABLE';
  depth?: number;
  text: string;
};

export type DocumentSnapshot = {
  format: number;
  /** Hashed over the blocks only (C1.md's ReviewDocument.contentHash comment)
   *  — path and title are presentational, not content, so renaming a document
   *  between rounds must not change what its hash attests to. */
  blocks: Block[];
};

export function buildDocumentSnapshot(blocks: Block[]): DocumentSnapshot {
  return { format: DOCUMENT_SNAPSHOT_FORMAT, blocks };
}

export function contentHash(snapshot: ContractSnapshot | AmendmentSnapshot | DocumentSnapshot): string {
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
 *
 * `scopeItems` defaults to `[]` — the registry's agreed set, already reduced
 * to the frozen shape by `lib/scope.ts`'s `agreedScopeSnapshot` before it
 * reaches here. Every call site that predates L1 (and every already-published
 * revision) never passed a third argument at all; see the field's own doc
 * comment on `ContractSnapshot` for why that keeps old hashes intact.
 */
export function buildContractSnapshot(
  contract: ContractDraft,
  articles: ArticleDraft[],
  scopeItems: ScopeItemSnapshot[] = [],
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
    scopeItems,
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
 *
 * `scopeItems` is appended as a fourth, optional argument rather than
 * inserted before `current` — every call site from before L1 passes three
 * arguments, and this keeps them compiling unchanged. Passing the registry's
 * current agreed set here is what makes "Root just marked one more item
 * agreed, nothing else changed" register as dirty: without it, moving an item
 * to `agreed` would never be publishable on its own, because the comparison
 * this function makes would not have seen it move.
 */
export function draftState(
  contract: ContractDraft,
  articles: ArticleDraft[],
  current: { contentHash: string | null } | null,
  scopeItems: ScopeItemSnapshot[] = [],
): DraftState {
  const snapshot = buildContractSnapshot(contract, articles, scopeItems);
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
