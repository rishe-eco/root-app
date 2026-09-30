import type { ScopeKind, ScopeStatus, StepKind } from '@prisma/client';
import { allowanceFor, iterationsUsed, type BriefAllowances, type ExtensionRow, type RoundCounts } from './allowance.js';
import { isAgreedOrBeyond } from './scope.js';
import type { WizardStep } from './steps.js';

/**
 * The summary's rules (journeys build plan J11; journeys Q-S8): **a record, not
 * a review.** What was agreed, what became of each item, the changes nobody
 * asked for, each step's rounds and finish date, planned against actual dates,
 * the money that changed hands, and the support period. Derived on read and
 * never stored — a stored summary is a second copy of facts that each have a
 * home, and the day one of them is corrected the copy would be the one that
 * still says the old thing (house rule 3; PD-17 made the same choice for the
 * history rail).
 *
 * **It carries no feedback, at all.** Not a comment, not a thread, not a
 * resolution. The step takes no input (`WizardStep.takesInput` is false for
 * SUMMARY), so there is nothing to answer and nothing to resolve; and a
 * customer's opinion of step 4, quoted back in a document they print, is a
 * review wearing a record's clothes. The one place feedback's *outcome*
 * appears is an item's own end state (declined, and why), which is the item's
 * fact and not the conversation's.
 *
 * Pure functions over plain rows, table-tested in `summary.test.ts`; the loader
 * that feeds them and decides who is looking is `resolvers/delivery.ts`.
 */

// --- end state per item ---------------------------------------------------

export type SummaryTradePartner = {
  /** `OUT`: this item was traded away, for the partner. `IN`: this item came in
   *  by trade, replacing the partner. */
  direction: 'OUT' | 'IN';
  key: string;
  labelFa: string;
  labelEn: string;
  executedAt: Date;
};

export type SummaryItem = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  kind: ScopeKind;
  status: ScopeStatus;
  phaseNumber: number | null;
  /** The signed agreement listed this item. False for one that came in after the
   *  signature (a trade's incoming half, an amendment) — the difference between
   *  "what was agreed" and "what it became" is most of why this page exists. */
  inAgreement: boolean;
  declinedReason: string | null;
  tradePartner: SummaryTradePartner | null;
  handedOverAt: Date | null;
  handedOverBy: string | null;
  handoverNote: string | null;
};

type RegistryItem = {
  id: string;
  key: string;
  labelFa: string;
  labelEn: string;
  kind: ScopeKind;
  status: ScopeStatus;
  position: number;
  contractId: string | null;
  phaseId: string | null;
  declinedReason: string | null;
  handedOverAt: Date | null;
  handedOverBy: { name: string } | null;
  handoverNote: string | null;
};

type ExecutedTrade = { outItemId: string; inItemId: string; executedAt: Date };

/**
 * The contract's items and where each ended. The contract's own pages, features
 * and deliverables — every one except a proposal nobody agreed to (`PROPOSED`
 * was never part of the deal, and an unreviewed proposal in a record of what was
 * delivered is noise) — plus the standing checklist's extras that ended up in
 * scope (the same set Appendix 1 lists). A declined or traded item stays: that
 * it was left out, and why, is part of what became of the agreement.
 */
export function summaryItems(input: {
  contractId: string;
  items: RegistryItem[];
  /** The keys the signed snapshot's appendix lists. */
  agreedKeys: ReadonlySet<string>;
  trades: ExecutedTrade[];
  phaseNumbers: ReadonlyMap<string, number>;
}): SummaryItem[] {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const tradeFor = (item: RegistryItem): SummaryTradePartner | null => {
    for (const t of input.trades) {
      if (t.outItemId === item.id) {
        const partner = byId.get(t.inItemId);
        if (partner) return { direction: 'OUT', key: partner.key, labelFa: partner.labelFa, labelEn: partner.labelEn, executedAt: t.executedAt };
      }
      if (t.inItemId === item.id) {
        const partner = byId.get(t.outItemId);
        if (partner) return { direction: 'IN', key: partner.key, labelFa: partner.labelFa, labelEn: partner.labelEn, executedAt: t.executedAt };
      }
    }
    return null;
  };

  return input.items
    .filter((i) =>
      i.kind === 'EXTRA' ? isAgreedOrBeyond(i.status) : i.contractId === input.contractId && i.status !== 'PROPOSED',
    )
    .sort((a, b) => a.position - b.position)
    .map((i) => ({
      id: i.id,
      key: i.key,
      labelFa: i.labelFa,
      labelEn: i.labelEn,
      kind: i.kind,
      status: i.status,
      phaseNumber: i.phaseId ? (input.phaseNumbers.get(i.phaseId) ?? null) : null,
      inAgreement: input.agreedKeys.has(i.key),
      declinedReason: i.status === 'DECLINED' ? i.declinedReason : null,
      tradePartner: tradeFor(i),
      handedOverAt: i.handedOverAt,
      handedOverBy: i.handedOverAt ? (i.handedOverBy?.name ?? null) : null,
      handoverNote: i.handedOverAt ? i.handoverNote : null,
    }));
}

// --- amendments ------------------------------------------------------------

/**
 * The amendments that *took effect*: published, and either signed by the
 * customer or the paired amendment of a trade that executed (spec §4 — a trade's
 * amendment is never signed on its own; the two confirmations are the consent).
 * One published and waiting for the customer is not yet part of what was agreed.
 */
export function executedAmendments<
  A extends { publishedAt: Date | null; signature: unknown | null; scopeTrade: { executedAt: Date | null } | null },
>(amendments: A[]): A[] {
  return amendments.filter(
    (a) => a.publishedAt !== null && (a.signature !== null || (a.scopeTrade?.executedAt ?? null) !== null),
  );
}

// --- the unprompted changes -------------------------------------------------

export type UnpromptedChange = {
  id: string;
  step: StepKind;
  buildNumber: number;
  publishedAt: Date;
  /** The genuine bilingual prose a PM wrote from the entry, once it reached a
   *  review frame. Null until then. */
  textFa: string | null;
  textEn: string | null;
  /** The developer's raw note, one language. **Staff only** (see below). */
  note: string | null;
  noteLang: string | null;
  writtenUp: boolean;
};

type UnpromptedRow = {
  id: string;
  note: string | null;
  noteLang: string | null;
  frameLine: { textFa: string; textEn: string } | null;
  build: { kind: 'SITE' | 'MOCKUP'; number: number; publishedAt: Date | null };
};

/**
 * Changes made to a build that nobody asked for (L3b's third source), for the
 * builds the customer was told about. **The raw note is staff's** — L3b §1.3
 * decided a one-language note a developer typed is not something to put in front
 * of a customer until somebody has written it up in both languages, and a
 * printable record is more of a customer's screen, not less. So a customer (and
 * anyone else who is not a contract reader) sees exactly the entries that have a
 * written-up line, in its two languages; staff see every entry, the unwritten
 * ones carrying the note and the language it is in, flagged `writtenUp: false`
 * so the desk can say what is still owed to the customer.
 */
export function unpromptedChanges(rows: UnpromptedRow[], staff: boolean): UnpromptedChange[] {
  return rows
    .filter((r): r is UnpromptedRow & { build: { publishedAt: Date } & UnpromptedRow['build'] } => r.build.publishedAt !== null)
    .filter((r) => staff || r.frameLine !== null)
    .map((r) => ({
      id: r.id,
      step: r.build.kind === 'MOCKUP' ? ('MOCKUP' as const) : ('DEMO' as const),
      buildNumber: r.build.number,
      publishedAt: r.build.publishedAt,
      textFa: r.frameLine?.textFa ?? null,
      textEn: r.frameLine?.textEn ?? null,
      note: staff && r.frameLine === null ? r.note : null,
      noteLang: staff && r.frameLine === null ? r.noteLang : null,
      writtenUp: r.frameLine !== null,
    }))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.buildNumber - b.buildNumber || a.id.localeCompare(b.id));
}

// --- each step ---------------------------------------------------------------

export type SummaryStepRow = {
  step: StepKind;
  phaseId: string | null;
  phaseNumber: number | null;
  /** Null: nobody counts this step's rounds (yet) — *not* zero. */
  iterationsUsed: number | null;
  allowance: number | null;
  /** Rounds sales granted beyond the brief (J8), summed. Zero when none. */
  extensions: number;
  finishedAt: Date | null;
};

/**
 * Every step of the road but the summary itself, with the rounds it took, what
 * it was allowed, what was added to that, and when it finished. The counts come
 * from `lib/allowance.ts` — `iterationsUsed` and `allowanceFor` — and nothing
 * here guesses: a step nobody counts reads `null`, which the page renders as
 * "not counted" and never as a zero that would be a claim. **Until J10 writes a
 * per-phase count and J9b a mockup count into `roundCountsOn`, those rows are
 * exactly that hole**; when they do, this function needs no change.
 */
export function summarySteps(input: {
  wizard: WizardStep[];
  brief: BriefAllowances | null;
  extensions: readonly ExtensionRow[];
  counts: RoundCounts;
}): SummaryStepRow[] {
  return input.wizard
    .filter((s) => s.step !== 'SUMMARY')
    .map((s) => ({
      step: s.step,
      phaseId: s.phaseId,
      phaseNumber: s.phaseNumber,
      iterationsUsed: iterationsUsed(s.step, s.phaseId, input.counts),
      allowance: allowanceFor(s.step, s.phaseId, input.brief, input.extensions),
      extensions: input.extensions
        .filter((e) => e.step === s.step && (s.step !== 'DEMO' || e.phaseId === s.phaseId))
        .reduce((sum, e) => sum + e.extra, 0),
      finishedAt: s.finishedAt,
    }));
}

// --- the money ---------------------------------------------------------------

export type InvoiceTotals = {
  count: number;
  paidCount: number;
  /** Decimal strings (house rule 9). */
  issued: string;
  paid: string;
  outstanding: string;
};

/**
 * What was invoiced and what was paid, over the contract's **issued** invoices —
 * a draft is Root's working row and not part of the record (D-7). Sums in
 * `bigint`; the caller has already decided the viewer may read money
 * (`mayReadMoney`), this only adds.
 */
export function invoiceTotals(entries: Array<{ amount: bigint; issuedAt: Date | null; paidAt: Date | null }>): InvoiceTotals {
  const issued = entries.filter((e) => e.issuedAt !== null);
  const sum = (rows: Array<{ amount: bigint }>) => rows.reduce((total, e) => total + e.amount, 0n);
  const paid = issued.filter((e) => e.paidAt !== null);
  const totalIssued = sum(issued);
  const totalPaid = sum(paid);
  return {
    count: issued.length,
    paidCount: paid.length,
    issued: totalIssued.toString(),
    paid: totalPaid.toString(),
    outstanding: (totalIssued - totalPaid).toString(),
  };
}
