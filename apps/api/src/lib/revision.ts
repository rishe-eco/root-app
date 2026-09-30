import { createHash } from 'node:crypto';
import { calendarDayString } from './calendarDay.js';

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

/**
 * Bumped only when the snapshot *shape* changes, so old hashes stay readable.
 *
 * **Format 1** is every `DESIGN_FIRST` contract revision, every amendment, and
 * every revision published before J7 — and it is still what `buildContractSnapshot`
 * produces when it is not given an agreement (below). **Format 2**
 * (`AGREEMENT_FORMAT`) is the new road's: the same keys, plus the brief, the
 * payment plan, the phases, the planned dates and the allowances (journeys build
 * plan J7; C1's lesson — a version number that means two things means neither,
 * so the new shape has its own). A format-2 snapshot is *by addition*: every
 * format-1 key keeps its name and meaning, so nothing that reads a format-1
 * snapshot's title, fee, articles or appendix has to know which it holds.
 */
export const SNAPSHOT_FORMAT = 1;

/** The new road's snapshot format — see `SNAPSHOT_FORMAT`. */
export const AGREEMENT_FORMAT = 2;

/** The formats `readContractSnapshot` will hand back. A stored snapshot in any
 *  other format is not something this code knows how to read, and saying so
 *  (`null`, "unsealed") is honest where guessing would be a misreading. */
const READABLE_FORMATS: readonly number[] = [SNAPSHOT_FORMAT, AGREEMENT_FORMAT];

export type ArticleSnapshot = {
  number: number;
  titleFa: string;
  titleEn: string;
  bodyFa: string | null;
  bodyEn: string | null;
  /** Format 2 only (J7): this article's prose is about money (PD-14). Frozen
   *  with the article, so a published article's sensitivity cannot be changed
   *  by editing the live row afterwards. Absent in format 1 — read those from
   *  the live row, as J4 did. */
  sensitive?: boolean;
};

export type ScopeKindName = 'PAGE' | 'FEATURE' | 'DELIVERABLE' | 'EXTRA';

export type ScopeItemSnapshot = {
  key: string;
  labelFa: string;
  labelEn: string;
  /** Format 2 only (J7): Appendix 1 is grouped by kind. */
  kind?: ScopeKindName;
};

/** Step 1 as frozen at publish (format 2). Money is a decimal string (rule 9),
 *  a calendar day is `YYYY-MM-DD` (PD-19). The four allowances are not here —
 *  they are `AgreementSnapshot.allowances`, so there is one copy of each. */
export type BriefSnapshot = {
  kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
  existingSiteUrl: string | null;
  /** Frozen labels, not an id: the type can be renamed or deactivated later
   *  and a signed agreement must keep saying what it said. */
  templateType: { slug: string; labelFa: string; labelEn: string };
  designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER';
  /** The customer's own statement of a ceiling — not the fee (J4's trap). */
  budgetCap: string | null;
  idealDeadline: string | null;
  hardDeadline: string | null;
  domainName: string | null;
  domainProvidedBy: 'CUSTOMER' | 'ROOT' | null;
  hostProvidedBy: 'CUSTOMER' | 'ROOT' | null;
  contentProvidedBy: 'CUSTOMER' | 'ROOT' | null;
  supportMonths: number | null;
};

export type AllowancesSnapshot = {
  premadeRounds: number | null;
  wireframeIterations: number;
  mockupIterations: number | null;
  demoIterationsPerPhase: number | null;
};

/** The payment plan *as approved*. It records the rows and their terms — never
 *  whether an invoice has been issued or paid (J13's business, and a fact that
 *  changes after the signature the snapshot is sealed under). A row's phase is
 *  named by its number, an id being meaningless outside the database. */
export type PaymentPlanSnapshot = {
  split: 'LUMP_SUM' | 'INSTALLMENTS' | 'MONTHLY';
  invoices: Array<{
    ordinal: number;
    labelFa: string;
    labelEn: string;
    amount: string;
    phaseNumber: number | null;
    paymentTermDays: number;
  }>;
};

export type PhaseSnapshot = {
  number: number;
  titleFa: string;
  titleEn: string;
  plannedEndAt: string | null;
  milestoneLabel: string | null;
};

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

/**
 * **Format 2** — what the customer approves and signs on the new road (journeys
 * build plan J7): everything in format 1, plus steps 1 and 2 as they stood when
 * the draft was published. `articles[].sensitive` and `scopeItems[].kind` ride
 * on the format-1 keys; the rest are new keys.
 *
 * The customer signs *all* of it — the budget cap and the payment plan
 * included. What `money.read` withholds is a *view* for other staff
 * (`resolvers/fields.ts`), never a different document: the hash attests to the
 * whole snapshot, and the customer's own screen and the print route render it
 * whole.
 */
export type AgreementSnapshot = ContractSnapshot & {
  format: typeof AGREEMENT_FORMAT;
  brief: BriefSnapshot | null;
  allowances: AllowancesSnapshot | null;
  paymentPlan: PaymentPlanSnapshot | null;
  phases: PhaseSnapshot[];
  plannedStartAt: string | null;
  plannedEndAt: string | null;
};

/** `snapshot` is a format-2 snapshot — the one place that says so. */
export const isAgreementSnapshot = (snapshot: ContractSnapshot | null): snapshot is AgreementSnapshot =>
  snapshot !== null && snapshot.format === AGREEMENT_FORMAT;

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
  /** Read by format 2 only; a format-1 build copies the five keys above and
   *  nothing else, whatever else the row carries. */
  sensitive?: boolean;
};

/**
 * Steps 1 and 2 as rows, for a format-2 build (journeys build plan J7). Plain
 * structural types rather than Prisma's, like the rest of this file — the
 * loader (`resolvers/agreement.ts`) fetches them and this only freezes them.
 */
export type AgreementParts = {
  brief: {
    kind: BriefSnapshot['kind'];
    existingSiteUrl: string | null;
    templateType: BriefSnapshot['templateType'];
    designTier: BriefSnapshot['designTier'];
    budgetCap: bigint | null;
    idealDeadline: Date | null;
    hardDeadline: Date | null;
    domainName: string | null;
    domainProvidedBy: BriefSnapshot['domainProvidedBy'];
    hostProvidedBy: BriefSnapshot['hostProvidedBy'];
    contentProvidedBy: BriefSnapshot['contentProvidedBy'];
    supportMonths: number | null;
    premadeRounds: number | null;
    wireframeIterations: number;
    mockupIterations: number | null;
    demoIterationsPerPhase: number | null;
  } | null;
  plan: {
    split: PaymentPlanSnapshot['split'];
    invoices: Array<{
      ordinal: number;
      labelFa: string;
      labelEn: string;
      amount: bigint;
      phaseId: string | null;
      paymentTermDays: number;
    }>;
  } | null;
  phases: Array<{
    id: string;
    number: number;
    titleFa: string;
    titleEn: string;
    plannedEndAt: Date | null;
    milestoneLabel: string | null;
  }>;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
};

const day = (d: Date | null): string | null => (d === null ? null : calendarDayString(d));

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
 *
 * **`agreement` (J7) is what makes this format 2** — and the *only* thing that
 * does. Given none, the output is byte-for-byte what it was before J7 (a test
 * pins a golden hash), so `DESIGN_FIRST` and every amendment-era caller is
 * untouched. Given one, the result is `buildAgreementSnapshot`'s: the same keys
 * plus steps 1 and 2, every array in a total order (articles by number, scope in
 * the registry's order as passed, phases by number, invoices by ordinal) and
 * every absent value an explicit `null` — `canonicalize` has no `undefined`, and
 * the same state must hash the same twice.
 */
export function buildContractSnapshot(
  contract: ContractDraft,
  articles: ArticleDraft[],
  scopeItems: ScopeItemSnapshot[] = [],
  agreement: AgreementParts | null = null,
): ContractSnapshot {
  if (agreement) return buildAgreementSnapshot(contract, articles, scopeItems, agreement);
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

/** Format 2 — see `AgreementSnapshot`. Exported for its own unit tests; callers
 *  go through `buildContractSnapshot` so there is one entry point. */
export function buildAgreementSnapshot(
  contract: ContractDraft,
  articles: ArticleDraft[],
  scopeItems: ScopeItemSnapshot[],
  parts: AgreementParts,
): AgreementSnapshot {
  const { brief, plan } = parts;
  const phases = [...parts.phases].sort((a, b) => a.number - b.number);
  const phaseNumber = new Map(phases.map((p) => [p.id, p.number]));
  return {
    format: AGREEMENT_FORMAT,
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
        sensitive: a.sensitive === true,
      })),
    scopeItems: scopeItems.map((s) => {
      // A format-2 appendix is grouped by kind; an item with none is a caller
      // that forgot `agreedScopeSnapshotFor`, and guessing one would
      // put a page under "features" in a document somebody signs.
      if (!s.kind) throw new Error(`Scope item "${s.key}" has no kind — a format-2 snapshot needs one.`);
      return { key: s.key, labelFa: s.labelFa, labelEn: s.labelEn, kind: s.kind };
    }),
    brief: brief
      ? {
          kind: brief.kind,
          existingSiteUrl: brief.existingSiteUrl,
          templateType: {
            slug: brief.templateType.slug,
            labelFa: brief.templateType.labelFa,
            labelEn: brief.templateType.labelEn,
          },
          designTier: brief.designTier,
          budgetCap: brief.budgetCap === null ? null : brief.budgetCap.toString(),
          idealDeadline: day(brief.idealDeadline),
          hardDeadline: day(brief.hardDeadline),
          domainName: brief.domainName,
          domainProvidedBy: brief.domainProvidedBy,
          hostProvidedBy: brief.hostProvidedBy,
          contentProvidedBy: brief.contentProvidedBy,
          supportMonths: brief.supportMonths,
        }
      : null,
    allowances: brief
      ? {
          premadeRounds: brief.premadeRounds,
          wireframeIterations: brief.wireframeIterations,
          mockupIterations: brief.mockupIterations,
          demoIterationsPerPhase: brief.demoIterationsPerPhase,
        }
      : null,
    paymentPlan: plan
      ? {
          split: plan.split,
          invoices: [...plan.invoices]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((i) => ({
              ordinal: i.ordinal,
              labelFa: i.labelFa,
              labelEn: i.labelEn,
              amount: i.amount.toString(),
              phaseNumber: i.phaseId === null ? null : (phaseNumber.get(i.phaseId) ?? null),
              paymentTermDays: i.paymentTermDays,
            })),
        }
      : null,
    phases: phases.map((p) => ({
      number: p.number,
      titleFa: p.titleFa,
      titleEn: p.titleEn,
      plannedEndAt: day(p.plannedEndAt),
      milestoneLabel: p.milestoneLabel,
    })),
    plannedStartAt: day(parts.plannedStartAt),
    plannedEndAt: day(parts.plannedEndAt),
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
 *
 * `agreement` (J7) is a fifth, optional argument for the same reason: given
 * one, the draft is a *format-2* draft, so "dirty" also notices a changed
 * brief, plan, phase or planned date — which is what lets the agreement gate
 * refuse to approve a revision the live steps have moved on from
 * (`REVISION_STALE`).
 */
export function draftState(
  contract: ContractDraft,
  articles: ArticleDraft[],
  current: { contentHash: string | null } | null,
  scopeItems: ScopeItemSnapshot[] = [],
  agreement: AgreementParts | null = null,
): DraftState {
  const snapshot = buildContractSnapshot(contract, articles, scopeItems, agreement);
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
  // Formats 1 and 2 (J7). Anything else is a shape this code was not written
  // for — reported as unsealed rather than half-rendered. (A stored snapshot
  // always carries its `format`: `buildContractSnapshot` has written one since
  // the first publish.)
  if (!READABLE_FORMATS.includes((value as { format?: unknown }).format as number)) return null;
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
