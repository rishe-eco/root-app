import type { Role as RoleName } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { can, capabilitiesOf } from '../../lib/capabilities.js';
import { computeGate } from '../../lib/gate.js';
import { diffSnapshots, draftState, readContractSnapshot, type SnapshotDiff } from '../../lib/revision.js';
import { carryForward, diffDesign, type PageChange } from '../../lib/design.js';
import { conceptsInclude, type FullContract } from './contracts.js';

/**
 * Field resolvers for the object types — the layer that decides what a stored
 * row *looks like* over the wire.
 *
 * Two kinds of thing live here and it is worth keeping them apart. Most are
 * plain shape adjustments (a nullable date becomes a boolean, BigInt becomes a
 * string). A few are load-bearing rules — which text is the document, and which
 * amendments a given caller may read — and those carry their own reasoning.
 */

export const Contract = {
  // BigInt does not survive JSON; Toman amounts cross the wire as strings.
  // This is the draft fee — a published revision carries its own frozen copy.
  amount: (c: FullContract) => (c.amount === null ? null : c.amount.toString()),
  gate: (c: FullContract) => computeGate(c),
  changeLog: (c: FullContract) => c.changeLogs,

  concepts: (c: FullContract) => c.currentDesignRevision?.concepts ?? [],
  signature: (c: FullContract) => c.currentContractRevision?.signature ?? null,

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
  revision: (c: FullContract) => {
    const revision = c.currentContractRevision;
    const snapshot = readContractSnapshot(revision?.snapshot ?? null);
    if (!revision || !snapshot) return null;
    return {
      ...revision,
      titleFa: snapshot.titleFa,
      titleEn: snapshot.titleEn,
      amount: snapshot.amount,
    };
  },

  /**
   * Root's working copy. Staff only — null for a customer rather than a
   * refusal, so a query that also asks for `id` and `titleFa` still succeeds.
   * No query of its own: `articles` is already on `c` via `contractInclude`.
   */
  draft: (c: FullContract, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    if (!can(user, 'contracts.manage')) return null;
    const { hash, dirty } = draftState(c, c.articles, c.currentContractRevision);
    return {
      titleFa: c.titleFa,
      titleEn: c.titleEn,
      amount: c.amount === null ? null : c.amount.toString(),
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
    const user = requireUser(ctx);
    if (!can(user, 'contracts.manage')) return null;
    return prisma.designRevision.findFirst({
      where: { contractId: c.id, publishedAt: null },
      include: conceptsInclude,
    });
  },

  /** Newest first. Non-staff see published revisions only. */
  contractRevisions: async (c: FullContract, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    const staff = can(user, 'contracts.manage');
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
    const user = requireUser(ctx);
    const staff = can(user, 'contracts.manage');
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
    const user = requireUser(ctx);
    if (can(user, 'contracts.manage')) return r.amendments;
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

export const User = {
  /**
   * Derived, never stored. The client needs to know what to show, and the one
   * thing it must not be handed for that purpose is a role to compare — so the
   * union happens here, once, against the same table the server guards with.
   */
  capabilities: (u: { roles: RoleName[] }) => [...capabilitiesOf(u)],
};
