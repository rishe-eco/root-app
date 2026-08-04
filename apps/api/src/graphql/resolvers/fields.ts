import { requireUser, type Context } from '../../context.js';
import { computeGate } from '../../lib/gate.js';
import { readContractSnapshot } from '../../lib/revision.js';
import type { FullContract } from './contracts.js';

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
    if (user.role === 'ADMIN') return r.amendments;
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
