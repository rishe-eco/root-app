import type { Role as RoleName, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { viewerOf, type Context } from '../../context.js';
import { can, capabilitiesOf } from '../../lib/capabilities.js';
import {
  isContractReader,
  mayReadContactOf,
  mayReadMoney,
  requestVisibleTo,
  visibleComment,
  visibleItem,
} from '../../lib/visibility.js';
import { computeGate } from '../../lib/gate.js';
import { diffSnapshots, draftState, readContractSnapshot, type SnapshotDiff } from '../../lib/revision.js';
import { agreedScopeSnapshot } from '../../lib/scope.js';
import { carryForward, diffDesign, type PageChange } from '../../lib/design.js';
import { computeProjectProgress } from '../../lib/phase.js';
import { isOverdue } from '../../lib/dependency.js';
import { summarizeRows } from '../../lib/serviceImport.js';
import { conceptsInclude, type FullContract } from './contracts.js';
import { feedbackItemInclude } from './feedback.js';

/**
 * Field resolvers for the object types — the layer that decides what a stored
 * row *looks like* over the wire.
 *
 * Two kinds of thing live here and it is worth keeping them apart. Most are
 * plain shape adjustments (a nullable date becomes a boolean, BigInt becomes a
 * string). A few are load-bearing rules — which text is the document, and which
 * amendments a given caller may read — and those carry their own reasoning.
 *
 * **Every "who is looking" question in this file is `viewerOf(ctx)`, not
 * `requireUser(ctx)`** (journeys build plan J3). Under "view as customer" the
 * viewer is the contract's customer and everything below — money, drafts,
 * unpublished revisions, requests — answers as it would for them, through the
 * same `lib/visibility.ts` rules, with no `asCustomer` branch anywhere. A new
 * field resolver that decides what to show by *who is asking* must do the
 * same; `j3.test.ts`'s field-by-field parity test fails on one that does not.
 */

export const Contract = {
  // BigInt does not survive JSON; Toman amounts cross the wire as strings.
  // This is the draft fee — a published revision carries its own frozen copy.
  // Null, not an error, for staff without `money.read` (journeys build plan
  // S1, PD-14): a designer's query for the contract still succeeds.
  amount: (c: FullContract, _a: unknown, ctx: Context) =>
    c.amount === null || !mayReadMoney(viewerOf(ctx), c) ? null : c.amount.toString(),
  gate: (c: FullContract) => computeGate(c),
  changeLog: (c: FullContract) => c.changeLogs,

  concepts: (c: FullContract) => c.currentDesignRevision?.concepts ?? [],
  signature: (c: FullContract) => c.currentContractRevision?.signature ?? null,

  /**
   * ScopeItem re-parented to Project at L1 (build plan D1) — this proxies
   * `project.scopeItems` so every existing caller of `Contract.scopeItems`
   * keeps working unchanged. Every contract has a project since J2.
   */
  scopeItems: (c: FullContract) => c.project.scopeItems,
  project: (c: FullContract) => c.project,

  /**
   * Journeys build plan S2: one list for every step. Filtered by who is
   * looking — `viewerOf`, so sales viewing as the customer sees what the
   * customer sees — through `visibleItem` (PD-21: feedback about money is for
   * money readers). What each item's *comments* show is `FeedbackItem.comments`
   * below, for the same viewer.
   */
  feedbackItems: async (c: FullContract, a: { step?: StepKind | null; phaseId?: string | null }, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const items = await prisma.feedbackItem.findMany({
      where: { contractId: c.id, ...(a.step ? { step: a.step } : {}), ...(a.phaseId ? { phaseId: a.phaseId } : {}) },
      include: feedbackItemInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return items.filter((i) => visibleItem(i, viewer, c));
  },

  /**
   * The request this contract's project began as (journeys build plan J2),
   * with its thread — read-only from here on, and the `origin` of what sales
   * types into step 1. Null for a project that never was a request, and for a
   * viewer who may not read it: the customer whose request it was and
   * `contracts.readAll` only (`requestVisibleTo`) — a designer or developer
   * assigned to the contract reads the contract, not the sales conversation
   * that preceded it.
   */
  request: (c: FullContract, _a: unknown, ctx: Context) =>
    requestVisibleTo(viewerOf(ctx), c.project) ? c.project : null,

  /**
   * Appendix 1 as a *view of the registry's agreed set*, frozen at the
   * current revision's publish time (build plan L1; spec §3) — never the
   * live registry, which is `Contract.scopeItems` above. Same pattern as
   * `articles`: read from the stored snapshot, never recomputed from live
   * rows, so a printed contract and its hash cannot drift apart.
   *
   * `?? []` guards a revision published before L1, whose stored snapshot has
   * no `scopeItems` key at all — see revision.ts's note on ContractSnapshot.
   */
  agreedScopeItems: (c: FullContract) => {
    const snapshot = readContractSnapshot(c.currentContractRevision?.snapshot ?? null);
    return snapshot?.scopeItems ?? [];
  },

  /**
   * The customer reads the *published* text, not Root's working copy. Ids are
   * synthesized per revision because a snapshot article is not a row — it is
   * a position in a frozen document.
   */
  articles: (c: FullContract) => {
    const snapshot = readContractSnapshot(c.currentContractRevision?.snapshot ?? null);
    if (!snapshot) return [];
    return snapshot.articles.map((a) => ({
      id: `${c.currentContractRevisionId}:${a.number}`,
      ...a,
    }));
  },

  /**
   * The revision `articles` came from, exposed so that a view claiming to be
   * the document can render entirely from the snapshot and print the hash it
   * rendered. Title and fee come from the snapshot for the same reason: the
   * columns on Contract are the working draft and may already have moved on.
   *
   * Null before the first publish, and null when the revision is unsealed —
   * a backfilled v1 has no snapshot to read a title out of, and inventing one
   * from the draft would be exactly the drift this field exists to prevent.
   */
  revision: (c: FullContract, _a: unknown, ctx: Context) => {
    const revision = c.currentContractRevision;
    const snapshot = readContractSnapshot(revision?.snapshot ?? null);
    if (!revision || !snapshot) return null;
    return {
      ...revision,
      titleFa: snapshot.titleFa,
      titleEn: snapshot.titleEn,
      // The frozen fee, withheld the same way as the draft's (PD-14). The
      // customer — who signs this — always reads it; `contentHash` still
      // attests to the full snapshot, so redacting one field of the *view*
      // changes nothing about what the hash covers.
      amount: mayReadMoney(viewerOf(ctx), c) ? snapshot.amount : null,
    };
  },

  /**
   * Root's working copy. Staff only — null for a customer rather than a
   * refusal, so a query that also asks for `id` and `titleFa` still succeeds.
   * No query of its own: `articles` is already on `c` via `contractInclude`.
   */
  draft: (c: FullContract, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    // The author's working copy — the fee included, which is why readers
    // without `contracts.author` (design, development) get null here.
    if (!can(user, 'contracts.author')) return null;
    // The registry's agreed set is part of what publishing would produce
    // (L1) — without it here, marking one more item agreed would never
    // register as "dirty" until some unrelated field also changed.
    const scopeItems = agreedScopeSnapshot(c.project.scopeItems);
    const { hash, dirty } = draftState(c, c.articles, c.currentContractRevision, scopeItems);
    return {
      titleFa: c.titleFa,
      titleEn: c.titleEn,
      amount: c.amount === null || !mayReadMoney(user, c) ? null : c.amount.toString(),
      articles: c.articles,
      contentHash: hash,
      dirty,
    };
  },

  /**
   * A pure read of the unpublished design revision, if one exists. Staff
   * only. **Must never call `draftDesignRevision`** — that creates one, and a
   * field resolver runs on every look, not just an intention to edit.
   */
  designDraft: async (c: FullContract, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    if (!isContractReader(user)) return null;
    return prisma.designRevision.findFirst({
      where: { contractId: c.id, publishedAt: null },
      include: conceptsInclude,
    });
  },

  /** Newest first. Non-staff see published revisions only. */
  contractRevisions: async (c: FullContract, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    const staff = isContractReader(user);
    const revisions = await prisma.contractRevision.findMany({
      where: { contractId: c.id, ...(staff ? {} : { publishedAt: { not: null } }) },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        contentHash: true,
        publishedAt: true,
        approvedAt: true,
        supersededAt: true,
        signature: { select: { signedAt: true } },
        _count: { select: { amendments: true } },
      },
    });
    return revisions.map((r) => ({
      id: r.id,
      version: r.version,
      contentHash: r.contentHash,
      publishedAt: r.publishedAt,
      approvedAt: r.approvedAt,
      supersededAt: r.supersededAt,
      signedAt: r.signature?.signedAt ?? null,
      amendmentCount: r._count.amendments,
    }));
  },

  /** Newest first. Non-staff see published revisions only. */
  designRevisions: async (c: FullContract, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    const staff = isContractReader(user);
    const revisions = await prisma.designRevision.findMany({
      where: { contractId: c.id, ...(staff ? {} : { publishedAt: { not: null } }) },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        publishedAt: true,
        supersededAt: true,
        concepts: { select: { _count: { select: { pages: true } } } },
        _count: { select: { concepts: true } },
      },
    });
    return revisions.map((r) => ({
      id: r.id,
      version: r.version,
      publishedAt: r.publishedAt,
      supersededAt: r.supersededAt,
      conceptCount: r._count.concepts,
      pageCount: r.concepts.reduce((sum, cpt) => sum + cpt._count.pages, 0),
    }));
  },

  /**
   * What has moved since the customer last acted (V3.md §3), computed fresh
   * on every read — same discipline as `gate`. Three independent things, each
   * null/empty when there is nothing to show for it; `pending` itself is null
   * only when all three are, which is the banner's entire "show or don't"
   * decision, made once here rather than reconstructed three separate ways
   * on the client.
   */
  pending: async (c: FullContract) => {
    const current = c.currentContractRevision;

    // A · the text was revised and wants approving again. "Before" is
    // whichever earlier revision the customer last approved (V3.md §2) — not
    // necessarily the immediately preceding version.
    let contractDiff:
      | (Omit<SnapshotDiff, 'articles'> & {
          fromVersion: number;
          toVersion: number;
          articles: Array<{ number: number; titleFa: string; titleEn: string; kind: string }>;
        })
      | null = null;
    if (current && !current.approvedAt) {
      const previouslyApproved = await prisma.contractRevision.findFirst({
        where: { contractId: c.id, approvedAt: { not: null } },
        orderBy: { version: 'desc' },
      });
      const after = readContractSnapshot(current.snapshot);
      if (previouslyApproved && after) {
        const before = readContractSnapshot(previouslyApproved.snapshot);
        const diff = diffSnapshots(before, after);
        contractDiff = {
          fromVersion: previouslyApproved.version,
          toVersion: current.version,
          ...diff,
          articles: diff.articles.map((a) => ({ ...a, kind: CHANGE_KIND[a.kind] })),
        };
      }
    }

    // B · pages of the current design revision still waiting on the
    // customer — exactly the unapproved pages under the chosen concept
    // (V3.md §2A). A page under a concept nobody chose is not something the
    // customer owes attention, and this mode only exists once a revision has
    // actually happened, so a fresh v1 design reports nothing here.
    const revision = c.currentDesignRevision;
    const chosen = revision?.concepts.find((cc) => cc.chosenAt !== null) ?? null;
    const unapprovedKeys =
      revision && revision.version > 1 && chosen
        ? new Set(chosen.pages.filter((p) => p.approvedAt === null).map((p) => p.key))
        : new Set<string>();
    let designChanges: Array<{ conceptKey: string; pageKey: string; kind: PageChange['kind'] }> = [];
    if (chosen && unapprovedKeys.size > 0) {
      const previous = await prisma.designRevision.findFirst({
        where: { contractId: c.id, version: revision!.version - 1 },
        include: conceptsInclude,
      });
      designChanges = diffDesign(previous?.concepts ?? [], revision!.concepts).filter(
        (ch) => ch.conceptKey === chosen.key && unapprovedKeys.has(ch.pageKey),
      );
    }

    // C · a published amendment still waiting on approval or signature.
    // Same publishedAt filter as ContractRevision.amendments (T7) — a
    // different field on a different type does not inherit it.
    const amendment =
      current?.amendments.find((a) => a.publishedAt !== null && (!a.approvedAt || !a.signature)) ?? null;

    if (!contractDiff && designChanges.length === 0 && !amendment) return null;
    return {
      contractDiff,
      designChanges: designChanges.map((ch) => ({ ...ch, kind: CHANGE_KIND[ch.kind] })),
      amendment,
    };
  },
};

/**
 * design.ts's and revision.ts's kind literals are lower case; the shared
 * GraphQL `ChangeKind` enum is upper case. One map for both — they are the
 * same four literals (V3.md §3.2) — rather than `.toUpperCase()`, so a fifth
 * literal fails loudly at the type checker instead of producing a
 * coincidentally-right string.
 */
const CHANGE_KIND: Record<PageChange['kind'], 'ADDED' | 'CHANGED' | 'REMOVED' | 'UNCHANGED'> = {
  added: 'ADDED',
  changed: 'CHANGED',
  removed: 'REMOVED',
  unchanged: 'UNCHANGED',
};

type DesignDraftRow = {
  contractId: string;
  concepts: Array<{
    key: string;
    chosenAt: Date | null;
    pages: Array<{ key: string; imageUrl: string | null; approvedAt: Date | null }>;
  }>;
};

export const DesignDraft = {
  /**
   * What publishing this draft would do, computed the same way the publish
   * path does (V2.md §3.1) — a draft always shows zero approvals, because
   * carry-forward restores them at publish time, not before. Showing the
   * answer here is what keeps that from looking like a guess.
   */
  carryForward: async (draft: DesignDraftRow) => {
    const contract = await prisma.contract.findUnique({
      where: { id: draft.contractId },
      select: { currentDesignRevisionId: true },
    });
    const previous = contract?.currentDesignRevisionId
      ? await prisma.designRevision.findUnique({
          where: { id: contract.currentDesignRevisionId },
          include: conceptsInclude,
        })
      : null;

    const { approvals, chosenConceptKey } = carryForward(previous?.concepts ?? [], draft.concepts);
    const changes = diffDesign(previous?.concepts ?? [], draft.concepts);
    const totalPages = draft.concepts.reduce((sum, c) => sum + c.pages.length, 0);

    return {
      chosenConceptKey,
      carriedPageCount: approvals.length,
      resetPageCount: totalPages - approvals.length,
      changes: changes.map((c) => ({ ...c, kind: CHANGE_KIND[c.kind] })),
    };
  },
};

export const ContractRevision = {
  /**
   * A customer reads published amendments only. Root's unpublished draft is
   * the same kind of secret as an unpublished revision, and the amendment
   * rows arrive on the same object either way — so the filter belongs here,
   * next to what it protects, rather than in the query that fetched them.
   */
  amendments: (
    r: { amendments: Array<{ publishedAt: Date | null }> },
    _a: unknown,
    ctx: Context,
  ) => {
    const user = viewerOf(ctx);
    if (isContractReader(user)) return r.amendments;
    return r.amendments.filter((a) => a.publishedAt !== null);
  },
};

export const DesignConcept = {
  chosen: (c: { chosenAt: Date | null }) => c.chosenAt !== null,
};

export const PageDesign = {
  approved: (p: { approvedAt: Date | null }) => p.approvedAt !== null,
};

export const ScopeItem = {
  checked: (s: { checkedAt: Date | null }) => s.checkedAt !== null,
};

/**
 * Build plan L3b's third source, surfaced for the PM to turn into genuine
 * bilingual prose (DemoFrameLine.buildChangeEntryId's own comment) —
 * "appears in the next review frame without anyone remembering to mention
 * it" (L3b's acceptance criterion) means *listed here automatically*, not
 * auto-written as a line: a raw note authored in one language is not
 * something this stage may silently promote into both textFa and textEn
 * (build plan L3b.3's Persian-authorship decision). Staff contract readers
 * only (`isContractReader`, journeys build plan S1 — which now includes the
 * developer who wrote these entries), and an empty list for a customer is
 * not a signal that nothing changed.
 */
export const DemoFrame = {
  unpromptedChanges: async (f: { demoId: string }, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    if (!isContractReader(user)) return [];
    const demo = await prisma.demo.findUniqueOrThrow({ where: { id: f.demoId }, select: { phaseId: true } });
    return prisma.buildChangeEntry.findMany({
      where: {
        build: { phaseId: demo.phaseId },
        feedbackItemId: null,
        scopeItemId: null,
        frameLine: { is: null },
      },
      orderBy: { createdAt: 'asc' },
    });
  },
};

/**
 * Journeys build plan S2, PD-4: **the customer projection of a thread.** A
 * pending or declined staff answer is not in the customer's list — nor in
 * the list sales sees under "view as customer", because `viewerOf` swaps the
 * viewer and `visibleComment` (lib/visibility.ts) is asked about *them*. Every
 * path that returns a `FeedbackItem` reaches its comments through here, so no
 * query can hand one out unfiltered.
 */
export const FeedbackItem = {
  comments: async (item: { id: string; comments?: Array<{ approval: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'DECLINED' }> }, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const comments =
      item.comments ??
      (await prisma.feedbackComment.findMany({
        where: { feedbackItemId: item.id },
        orderBy: { createdAt: 'asc' },
        include: { author: true, approvedBy: true },
      }));
    return comments.filter((c) => visibleComment(c, viewer));
  },
};

/**
 * The approval trail is Root's: who decided, when, why, and what the author
 * first wrote. A customer sees the answer, not the machinery behind it (and a
 * designer's declined draft, with its reason, is between them and sales).
 */
export const FeedbackComment = {
  approvedBy: (c: { approvedBy?: unknown }, _a: unknown, ctx: Context) =>
    isContractReader(viewerOf(ctx)) ? (c.approvedBy ?? null) : null,
  approvedAt: (c: { approvedAt: Date | null }, _a: unknown, ctx: Context) =>
    isContractReader(viewerOf(ctx)) ? c.approvedAt : null,
  approvalNote: (c: { approvalNote: string | null }, _a: unknown, ctx: Context) =>
    isContractReader(viewerOf(ctx)) ? c.approvalNote : null,
  originalBody: (c: { originalBody: string | null }, _a: unknown, ctx: Context) =>
    isContractReader(viewerOf(ctx)) ? c.originalBody : null,
};

/**
 * `FeedbackItem.addressedInBuild` loads a bare `Build` (J3 review's owed item:
 * selecting `declaredBy` or `changes` through it failed, because nothing had
 * included them). They resolve here instead — from the row when the caller
 * did include them (`builds.ts`), from the database when not — so no path to
 * a `Build` can return a half-loaded one.
 *
 * **The customer may see who declared a build — the name — but neither their
 * contacts nor the change list.** The name is what a customer already knows
 * of the person (the contract names its designer and developer); contacts go
 * through `mayReadContactOf` on the `User` fields, as everywhere. The list is
 * staff's: a no-origin entry is a developer's raw note, which L3b §1.3 keeps
 * off the customer's screen until the PM has written it up in both languages
 * (`DemoFrame.unpromptedChanges` is staff-only for the same reason).
 */
export const Build = {
  declaredBy: (b: { declaredBy?: unknown; declaredById: string }) =>
    b.declaredBy ?? prisma.user.findUniqueOrThrow({ where: { id: b.declaredById } }),
  changes: async (b: { id: string; changes?: unknown[] }, _a: unknown, ctx: Context) => {
    if (!isContractReader(viewerOf(ctx))) return [];
    return (
      b.changes ??
      prisma.buildChangeEntry.findMany({
        where: { buildId: b.id },
        include: { feedbackItem: { include: feedbackItemInclude }, scopeItem: true },
        orderBy: { createdAt: 'asc' },
      })
    );
  },
};

export const Project = {
  /**
   * Build plan L5: whose board this is, for the desk's cross-project
   * dependency dashboard (`Query.overdueDependencies`, which spans many
   * customers at once and so cannot rely on the caller already knowing).
   * `customerId` is a plain scalar column, present on every `Project` row
   * regardless of which query reached it — no include needed for this one.
   */
  customer: (p: { customerId: string }) => prisma.user.findUniqueOrThrow({ where: { id: p.customerId } }),

  /**
   * A live query regardless of how the parent `Project` object was reached —
   * `Contract.project` (via `contractInclude`) never fetches trades, and
   * `Query.project` need not either, so this is the one place that always
   * answers it rather than requiring every caller to remember to include it.
   */
  scopeTrades: (p: { id: string }) =>
    prisma.scopeTrade.findMany({
      where: { projectId: p.id },
      include: { outItem: true, inItem: true, proposedBy: true },
      orderBy: { createdAt: 'desc' },
    }),

  /**
   * Phases and their demos (build plan L2), same reasoning as `scopeTrades`
   * above — neither `contractInclude` nor `Query.project`'s include fetches
   * these, so this is the one place that always answers it. Demo pages carry
   * their `pageDesign` (the design-image toggle, L2.1) and unmatched paths
   * come newest-first, which is what makes "a page we did not expect" read
   * as a live bucket rather than a static dump (L2.2).
   *
   * Build plan L3: a draft demo (`publishedAt: null`) is filtered out for
   * everyone but staff — "a demo cannot be published naked" (spec §6) is
   * also a promise about what the customer's own query can ever return, not
   * only about what `publishDemo` refuses. The frame and its lines, and
   * every feedback item, come along eagerly for the same reason the pages
   * do: one round trip, matching this resolver's own existing shape.
   */
  phases: (p: { id: string }, _a: unknown, ctx: Context) => {
    const user = viewerOf(ctx);
    const staff = isContractReader(user);
    return prisma.phase.findMany({
      where: { projectId: p.id },
      orderBy: { number: 'asc' },
      include: {
        scopeItems: { orderBy: { position: 'asc' } },
        demos: {
          where: staff ? {} : { publishedAt: { not: null } },
          orderBy: { createdAt: 'desc' },
          include: {
            pages: { include: { pageDesign: true } },
            unmatchedPaths: { orderBy: { lastSeenAt: 'desc' } },
            frame: {
              include: {
                authoredBy: true,
                lines: {
                  orderBy: [{ kind: 'asc' }, { position: 'asc' }],
                  include: {
                    scopeItem: true,
                    feedbackItem: { include: feedbackItemInclude },
                    // Build plan L3b's third source, provenance only — see
                    // DemoFrameLine.buildChangeEntryId's own comment.
                    buildChangeEntry: true,
                  },
                },
              },
            },
            feedbackItems: {
              orderBy: { createdAt: 'desc' },
              include: feedbackItemInclude,
            },
          },
        },
      },
    });
  },

  /**
   * Coarse progress (lib/phase.ts), derived fresh on every read — never a
   * stored percentage (F5's own slippage; L2.2's banked trap). A separate
   * query from `phases` above rather than reusing its result: GraphQL field
   * resolvers do not share work across sibling fields in this codebase (see
   * `scopeTrades`'s own comment), and the shape this needs — id, number,
   * titles, and only each scope item's `status` — is lighter than what the
   * phase board asks of `phases`.
   */
  progress: async (p: { id: string }) => {
    const phases = await prisma.phase.findMany({
      where: { projectId: p.id },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        titleFa: true,
        titleEn: true,
        scopeItems: { select: { status: true } },
      },
    });
    return computeProjectProgress(phases);
  },

  /**
   * The dependency board (build plan L5; spec §7) — every commitment on this
   * project, both sides, soonest-due first. Not filtered to CUSTOMER here:
   * the desk's own workspace tab reads this same field for the full board,
   * and a customer seeing Root's own commitments alongside their own is the
   * symmetry the stage is built on, not a leak to plug. `Dependency.overdue`
   * is derived per row (`lib/dependency.ts`), never a stored flag.
   */
  dependencies: (p: { id: string }) =>
    prisma.dependency.findMany({
      where: { projectId: p.id },
      include: { project: true, createdBy: true, verifiedBy: true },
      orderBy: { dueAt: 'asc' },
    }),

  /** Build plan L7 — the product-import panel's run history, newest first.
   *  Neither `contractInclude` nor `Query.project`'s own include fetches
   *  this, matching `scopeTrades`/`dependencies`'s own precedent above. */
  serviceRuns: (p: { id: string }) =>
    prisma.serviceRun.findMany({
      where: { projectId: p.id },
      include: {
        project: { select: { id: true, customerId: true, titleFa: true, titleEn: true } },
        file: true,
        uploadedBy: true,
        appliedBy: true,
        billingEntry: true,
        rows: { orderBy: { rowNumber: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    }),
};

/**
 * Build plan L5: `overdue` is computed fresh on every read from `dueAt` and
 * `verifiedAt` — the same F5 discipline `ProjectProgress` already holds to
 * for phase progress. A verified dependency is never overdue no matter how
 * late the verification came; an unverified one is overdue the instant its
 * due date passes, with nothing for anyone to remember to flip.
 */
export const Dependency = {
  overdue: (d: { dueAt: Date; verifiedAt: Date | null }) => isOverdue(d),
};

/**
 * Build plan L6: BigInt does not survive JSON (the predecessor plan's §6.3
 * trap, and Contract.amount's own precedent above) — every Toman figure
 * this stage adds crosses the wire as a string, converted here and nowhere
 * else.
 */
export const BillingEntry = {
  amount: (e: { amount: bigint }) => e.amount.toString(),
};

export const Subscription = {
  amount: (s: { amount: bigint }) => s.amount.toString(),
};

export const BillingSourceTotal = {
  totalIssued: (r: { totalIssued: bigint }) => r.totalIssued.toString(),
  totalPaid: (r: { totalPaid: bigint }) => r.totalPaid.toString(),
  totalOutstanding: (r: { totalOutstanding: bigint }) => r.totalOutstanding.toString(),
};

export const BillingReport = {
  totalIssued: (r: { totalIssued: bigint }) => r.totalIssued.toString(),
  totalPaid: (r: { totalPaid: bigint }) => r.totalPaid.toString(),
  totalOutstanding: (r: { totalOutstanding: bigint }) => r.totalOutstanding.toString(),
};

/** Build plan L7. `fileUrl` is `/files/<id>` — the same PRIVATE-file route
 *  every other class already downloads through (routes/files.ts), which
 *  re-checks ownership on every request rather than trusting this field to
 *  have been reached legitimately. `summary` is derived from `rows`, never
 *  stored (the same F5 discipline every other computed total in this
 *  codebase holds to). */
export const ServiceRun = {
  fileUrl: (r: { file: { id: string } }) => `/files/${r.file.id}`,
  fileName: (r: { file: { originalName: string } }) => r.file.originalName,
  fileBytes: (r: { file: { bytes: number } }) => r.file.bytes,
  summary: (r: { rows: Array<{ action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'REJECTED' }> }) => summarizeRows(r.rows),
};

export const ServiceRunRow = {
  // BigInt does not survive JSON (Contract.amount's own precedent above).
  // Null on a REJECTED row whose price could not be parsed at all.
  price: (r: { price: bigint | null }) => (r.price === null ? null : r.price.toString()),
};

export const User = {
  /**
   * Derived, never stored. The client needs to know what to show, and the one
   * thing it must not be handed for that purpose is a role to compare — so the
   * union happens here, once, against the same table the server guards with.
   */
  capabilities: (u: { roles: RoleName[] }) => [...capabilitiesOf(u)],

  /**
   * J3 review: contact details only for the account itself and for staff
   * who work with accounts — `mayReadContactOf`. The viewer is read straight
   * off the context rather than through `requireUser`: the auth mutations
   * return the user they just authenticated with no session yet on the
   * context (and that user is, by construction, the caller), and an account
   * in a forced password change must still read its own `me`. No anonymous
   * query returns a `User` (the Library's public shapes have no author
   * field — see r2.test.ts), so "no viewer" only ever means an auth payload.
   * Under view-as, `viewAs` is the customer, so the customer's projection
   * hides staff contacts exactly as the customer's own read does.
   */
  email: (u: { id: string; email: string | null }, _a: unknown, ctx: Context) => {
    const viewer = ctx.viewAs ?? ctx.user;
    return !viewer || mayReadContactOf(viewer, u) ? u.email : null;
  },
  phone: (u: { id: string; phone: string | null }, _a: unknown, ctx: Context) => {
    const viewer = ctx.viewAs ?? ctx.user;
    return !viewer || mayReadContactOf(viewer, u) ? u.phone : null;
  },
};
