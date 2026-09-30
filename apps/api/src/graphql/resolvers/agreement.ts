import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { draftState, type AgreementParts, type AgreementSnapshot, type DraftState } from '../../lib/revision.js';
import { parseCalendarDay } from '../../lib/calendarDay.js';
import { agreedScopeSnapshot, agreedScopeSnapshotFor } from '../../lib/scope.js';
import type { FullContract } from './contracts.js';

/**
 * What a contract's *draft* would publish as (journeys build plan J7) — the one
 * loader behind `publishContractRevision`, `Contract.draft` and the agreement
 * gate's `REVISION_STALE`, so the three cannot disagree about whether the
 * published revision is the live steps (house rule 3: one computation, and
 * `draftState` already is the pure half of it).
 *
 * The two roads differ only here. A **`DESIGN_FIRST`** contract's draft is
 * exactly what it was before J7 — format 1, the project's whole agreed scope, no
 * extra reads. An **`AGREEMENT_FIRST`** contract's is format 2: the brief, the
 * payment plan, the phases and the planned dates joined in (`loadAgreementParts`),
 * and the appendix narrowed to the items *this* contract agreed
 * (`agreedScopeSnapshotFor`). Passing the contract, not a flag, means a caller
 * cannot ask for the wrong format for a road.
 */

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * A format-2 snapshot as the API returns it (`ContractRevision.agreement`) —
 * what the customer approves and signs, and what the print route renders.
 *
 * **Money is the one thing that varies by viewer, and only for other staff**
 * (PD-14; J7's first trap): the customer — and anyone else `mayReadMoney` admits —
 * gets the budget cap and the payment plan; a designer gets `null` for both. The
 * hash still covers the whole snapshot, so redacting a *view* changes nothing
 * about what was signed. Calendar days come out as `Date`s at midnight UTC so
 * they go through the same `DateTime` scalar and the same UTC formatter as
 * every other day in the API (PD-19).
 */
export function agreementView(s: AgreementSnapshot, mayReadMoney: boolean) {
  const day = (v: string | null) => (v === null ? null : parseCalendarDay(v));
  return {
    brief: s.brief && {
      ...s.brief,
      budgetCap: mayReadMoney ? s.brief.budgetCap : null,
      idealDeadline: day(s.brief.idealDeadline),
      hardDeadline: day(s.brief.hardDeadline),
    },
    allowances: s.allowances,
    paymentPlan:
      mayReadMoney && s.paymentPlan
        ? {
            ...s.paymentPlan,
            total: s.paymentPlan.invoices.reduce((sum, i) => sum + BigInt(i.amount), 0n).toString(),
          }
        : null,
    phases: s.phases.map((p) => ({ ...p, plannedEndAt: day(p.plannedEndAt) })),
    plannedStartAt: day(s.plannedStartAt),
    plannedEndAt: day(s.plannedEndAt),
  };
}

/** Steps 1 and 2 as rows — what format 2 freezes beside the articles. */
export async function loadAgreementParts(
  db: Db,
  contract: Pick<FullContract, 'id' | 'plannedStartAt' | 'plannedEndAt'>,
): Promise<AgreementParts> {
  const [brief, plan, phases] = await Promise.all([
    db.contractBrief.findUnique({
      where: { contractId: contract.id },
      include: { templateType: { select: { slug: true, labelFa: true, labelEn: true } } },
    }),
    db.paymentPlan.findUnique({
      where: { contractId: contract.id },
      include: { invoices: { orderBy: { ordinal: 'asc' } } },
    }),
    db.phase.findMany({ where: { contractId: contract.id }, orderBy: { number: 'asc' } }),
  ]);
  return {
    brief,
    plan,
    phases,
    plannedStartAt: contract.plannedStartAt,
    plannedEndAt: contract.plannedEndAt,
  };
}

/** The draft's snapshot, hash and whether publishing it would change anything —
 *  in the road's own format. `contract` must carry `articles`, `project.
 *  scopeItems` and `currentContractRevision` (`contractInclude` does). */
export async function draftStateOn(db: Db, contract: FullContract): Promise<DraftState> {
  if (contract.sequence === 'AGREEMENT_FIRST') {
    return draftState(
      contract,
      contract.articles,
      contract.currentContractRevision,
      agreedScopeSnapshotFor(contract.id, contract.project.scopeItems),
      await loadAgreementParts(db, contract),
    );
  }
  return draftState(
    contract,
    contract.articles,
    contract.currentContractRevision,
    agreedScopeSnapshot(contract.project.scopeItems),
  );
}
