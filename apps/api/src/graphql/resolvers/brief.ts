import { GraphQLError } from 'graphql';
import type { DependencySide, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, viewerOf, type Context } from '../../context.js';
import { lockContract } from '../../lib/stepApproval.js';
import { stepOnRoad } from '../../lib/steps.js';
import { parseCalendarDay } from '../../lib/calendarDay.js';
import {
  briefDependencies,
  checkBriefInput,
  EXISTING_SITE_PRESET,
  EXTRA_COMMITMENT_KEYS,
  isCommitmentKey,
  isIncludedExtra,
  planDependencySync,
  presetApplies,
  type BriefInputProblem,
  type CommitmentKey,
  type ExistingBriefRow,
} from '../../lib/brief.js';
import { missingHandoverTypes, orderHandover } from '../../lib/dependency.js';
import { checkPlanRows, planTotal, type PlanProblem } from '../../lib/plan.js';
import { mayReadMoney } from '../../lib/visibility.js';
import { reload, type FullContract } from './contracts.js';
import { phasesWhere } from './fields.js';
import { assertStepOpenOn, isStepOpenOn } from './wizard.js';
import { contractOnProject } from './admin/shared.js';

/**
 * Step 1 — requirements (journeys build plan J4): the brief, the extras'
 * toggles, the payment plan, and the fields that read them back. The rules are
 * `lib/brief.ts` and `lib/plan.ts`; this file loads rows, takes the contract's
 * lock, writes, and answers `Contract!` (T9 in V2.md).
 *
 * **Every write here does the same three things in the same order**, and none
 * may skip one: `contracts.author` (`FORBIDDEN` first, so no id leaks); the
 * contract's row lock (`lockContract`, so a write cannot interleave with an
 * approval or an answer on the same contract); then `assertStepOpenOn(
 * REQUIREMENTS)` inside that lock. Nothing can lock REQUIREMENTS until J7's
 * agreement approval exists, but the call lands now so J7 changes nothing here.
 *
 * **Money** (PD-14): `budgetCap` and the whole payment plan resolve to `null`
 * for staff without `money.read` who are not the customer — the field, not the
 * caller, decides, so a later edge that reaches a brief cannot reopen it.
 * **Dates** are calendar days (PD-19): they arrive as `YYYY-MM-DD`, are parsed
 * by the one parser (`parseCalendarDay`), stored in `date` columns and rendered
 * in UTC.
 */

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });

const BRIEF_MESSAGES: Record<BriefInputProblem, string> = {
  INVALID_BUDGET: 'The budget must be a whole number of Toman above zero.',
  INVALID_DEADLINE: 'That is not a date.',
  DEADLINES_OUT_OF_ORDER: 'The ideal deadline cannot be after the hard deadline.',
  INVALID_SITE_URL: 'The existing site must be an http or https address.',
  INVALID_SUPPORT_MONTHS: 'Support months must be a whole number from 0 to 120.',
  INVALID_ALLOWANCE: 'An allowance must be a whole number, zero or more.',
};

const PLAN_MESSAGES: Record<PlanProblem, string> = {
  PLAN_ROWS_REQUIRED: 'A payment plan needs at least one row.',
  TOO_MANY_ROWS: 'That is more rows than a payment plan can have.',
  LABEL_REQUIRED: 'Every row needs a label, in either language.',
  INVALID_AMOUNT: 'Every amount must be a whole number of Toman above zero.',
  INVALID_TERM: 'A payment term is a whole number of days from 0 to 365.',
  INVALID_DATE: 'That is not a date.',
  PHASE_AND_DATE: 'A payment is due on a phase or on a date, not both.',
};

/** A day off the wire: omitted or null is unset, a real day is a `Date`, and
 *  anything else is the sentinel `checkBriefInput` turns into `INVALID_DEADLINE`. */
function dayOrUnset(value: string | null | undefined): Date | 'invalid' | null {
  if (value === undefined || value === null || value === '') return null;
  return parseCalendarDay(value) ?? 'invalid';
}

// --- the dependency board ----------------------------------------------------

export type CommitmentArg = { key: string; side?: DependencySide | null; dueAt?: string | null };

/**
 * Makes the board say what the included extras say (`planDependencySync`,
 * lib/brief.ts) — inside the caller's transaction, so a brief and its
 * commitments are one write. Called by `setBrief` with the dates the form
 * carried, and — without dates — by `setExtra` and the registry's generic
 * status setter when an extra changes: those can flip a side or remove a
 * commitment that is no longer implied, and create one undated (DX3a: an
 * `inBrief` row may be, `briefCompleteness` reports it as `COMMITMENT_UNDATED`).
 *
 * **Only the extras' rows are synced** (gateway, SMS line, Enamad). The domain,
 * the host, the content and every other default-list item are rows that
 * Requirements and the Dependencies tab edit directly (`seedHandoverRows` makes
 * them; nothing here touches them), and a one-off is no brief key at all.
 */
export async function syncBriefDependencies(
  tx: Prisma.TransactionClient,
  contractId: string,
  actorId: string,
  commitments: readonly CommitmentArg[] = [],
): Promise<void> {
  const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, select: { projectId: true } });
  const [extras, rows] = await Promise.all([
    tx.scopeItem.findMany({ where: { projectId: contract.projectId, kind: 'EXTRA' }, select: { key: true, status: true } }),
    tx.dependency.findMany({ where: { projectId: contract.projectId, briefKey: { in: [...EXTRA_COMMITMENT_KEYS] } } }),
  ]);
  const includedKeys = extras.filter((e) => isIncludedExtra(e.status)).map((e) => e.key);

  const dueDates: Partial<Record<CommitmentKey, Date>> = {};
  const sides: Partial<Record<CommitmentKey, DependencySide | null>> = {};
  for (const c of commitments) {
    if (!isCommitmentKey(c.key) || !EXTRA_COMMITMENT_KEYS.has(c.key)) continue; // not an extra's — ignored, not refused
    if (c.dueAt) {
      const day = parseCalendarDay(c.dueAt);
      if (!day) throw refuse('INVALID_DATE', 'That is not a date.');
      dueDates[c.key] = day;
    }
    if (c.side) sides[c.key] = c.side;
  }

  // An extra's side is the caller's to choose; when this call does not say (a
  // `setExtra`), the row keeps the side it already has — including none —
  // rather than snapping back to the default.
  const existing: ExistingBriefRow[] = rows.flatMap((r) =>
    r.briefKey && isCommitmentKey(r.briefKey) ? [{ ...r, briefKey: r.briefKey }] : [],
  );
  for (const row of existing) {
    if (!(row.briefKey in sides)) sides[row.briefKey] = row.side;
  }

  const implied = briefDependencies(includedKeys, sides);
  // The extras are the project's, not a contract's, so no sibling brief can imply one this does not.
  const plan = planDependencySync({ implied, existing, dueDates, stillImpliedElsewhere: new Set() });

  for (const c of plan.create) {
    await tx.dependency.create({
      data: {
        projectId: contract.projectId,
        side: c.side,
        titleFa: c.titleFa,
        titleEn: c.titleEn,
        dueAt: c.dueAt,
        technical: c.technical,
        briefKey: c.key,
        inBrief: true,
        createdById: actorId,
      },
    });
  }
  for (const u of plan.update) {
    await tx.dependency.update({
      where: { id: u.id },
      data: { side: u.side, dueAt: u.dueAt, technical: u.technical, titleFa: u.titleFa, titleEn: u.titleEn },
    });
  }
  if (plan.remove.length > 0) await tx.dependency.deleteMany({ where: { id: { in: plan.remove } } });
  if (plan.detach.length > 0) {
    await tx.dependency.updateMany({ where: { id: { in: plan.detach } }, data: { briefKey: null } });
  }
}

/**
 * A new brief gets an `inBrief` row for every active item on the desk's default
 * list that its project does not hold yet (DX3a; `HandoverItemType`). The rows
 * start undecided and undated — nobody has said whose they are — which is a
 * complete state: no provider is required. Called inside `setBrief`'s
 * transaction, only when that call creates the brief.
 *
 * The board is the project's, so a second contract on the same project finds
 * the first one's rows already there and adds only what is new on the list.
 */
async function seedHandoverRows(tx: Prisma.TransactionClient, projectId: string, actorId: string): Promise<void> {
  const [types, held] = await Promise.all([
    tx.handoverItemType.findMany({ where: { active: true }, orderBy: [{ position: 'asc' }, { key: 'asc' }] }),
    tx.dependency.findMany({ where: { projectId, briefKey: { not: null } }, select: { briefKey: true } }),
  ]);
  const heldKeys = new Set(held.flatMap((r) => (r.briefKey ? [r.briefKey] : [])));
  for (const t of missingHandoverTypes(types, heldKeys)) {
    await tx.dependency.create({
      data: {
        projectId,
        side: null,
        dueAt: null,
        titleFa: t.titleFa,
        titleEn: t.titleEn,
        technical: t.technical,
        briefKey: t.key,
        inBrief: true,
        createdById: actorId,
      },
    });
  }
}

// --- the mutations ------------------------------------------------------------

type BriefInputArg = {
  kind: 'NEW_SITE' | 'FEATURE_FOR_EXISTING';
  existingSiteUrl?: string | null;
  templateTypeId: string;
  designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER' | 'NONE';
  budgetCap?: string | null;
  idealDeadline?: string | null;
  hardDeadline?: string | null;
  domainName?: string | null;
  supportMonths?: number | null;
  premadeRounds?: number | null;
  wireframeIterations?: number | null;
  mockupIterations?: number | null;
  demoIterationsPerPhase?: number | null;
  commitments?: CommitmentArg[] | null;
};

type PlanRowArg = {
  labelFa: string;
  labelEn: string;
  amount: string;
  phaseId?: string | null;
  /** DX2b: `YYYY-MM-DD`; at most one of this and `phaseId`. */
  dueOn?: string | null;
  paymentTermDays: number;
};

/** The contract, checked to be on the new road — step 1 does not exist on the
 *  legacy one, and a brief written onto a `DESIGN_FIRST` contract is a row no
 *  screen would ever show. */
async function newRoadContract(contractId: string) {
  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) throw refuse('NOT_FOUND', 'No such contract.');
  if (!stepOnRoad(contract.sequence, 'REQUIREMENTS')) {
    throw refuse('STEP_NOT_ON_ROAD', 'This contract has no requirements step.');
  }
  return contract;
}

const trimmedOrNull = (value: string | null | undefined): string | null => value?.trim() || null;

export const briefMutations = {
  /**
   * Writes the brief and **syncs its dependencies in the same transaction**.
   * A replace, not a patch: the form on screen is the brief, so an omitted
   * optional field is cleared (and `wireframeIterations` returns to its default
   * of two). Idempotent — set twice, one row per commitment key (the diff in
   * `planDependencySync`, and the partial unique index behind it).
   *
   * Refusals, in order: `FORBIDDEN`, `NOT_FOUND`, `STEP_NOT_ON_ROAD` (legacy
   * contract), the input's own (`INVALID_BUDGET`, `INVALID_DEADLINE`,
   * `DEADLINES_OUT_OF_ORDER`, `INVALID_SITE_URL`, `INVALID_SUPPORT_MONTHS`,
   * `INVALID_ALLOWANCE`, `INVALID_DATE` for a commitment), `NOT_FOUND` for a
   * template type that does not exist, `TEMPLATE_TYPE_INACTIVE` for one that
   * was deactivated (a brief that already chose it keeps it), and
   * `STEP_LOCKED`.
   */
  setBrief: async (_p: unknown, args: { contractId: string; input: BriefInputArg }, ctx: Context) => {
    const user = requireCapability(ctx, 'contracts.author');
    const contract = await newRoadContract(args.contractId);
    const { input } = args;

    const idealDeadline = dayOrUnset(input.idealDeadline);
    const hardDeadline = dayOrUnset(input.hardDeadline);
    const wireframeIterations = input.wireframeIterations ?? 2;
    const problem = checkBriefInput({
      budgetCap: trimmedOrNull(input.budgetCap),
      idealDeadline,
      hardDeadline,
      existingSiteUrl: trimmedOrNull(input.existingSiteUrl),
      supportMonths: input.supportMonths ?? null,
      allowances: [input.premadeRounds ?? null, wireframeIterations, input.mockupIterations ?? null, input.demoIterationsPerPhase ?? null],
    });
    if (problem) throw refuse(problem, BRIEF_MESSAGES[problem]);
    // checkBriefInput has refused every 'invalid' by now; narrow for the types.
    if (idealDeadline === 'invalid' || hardDeadline === 'invalid') throw refuse('INVALID_DEADLINE', BRIEF_MESSAGES.INVALID_DEADLINE);

    const type = await prisma.templateType.findUnique({ where: { id: input.templateTypeId } });
    if (!type) throw refuse('NOT_FOUND', 'No such template type.');

    const baseData = {
      kind: input.kind,
      existingSiteUrl: trimmedOrNull(input.existingSiteUrl),
      templateTypeId: type.id,
      designTier: input.designTier,
      budgetCap: input.budgetCap ? BigInt(input.budgetCap.trim()) : null,
      idealDeadline,
      hardDeadline,
      domainName: trimmedOrNull(input.domainName),
      supportMonths: input.supportMonths ?? null,
      premadeRounds: input.premadeRounds ?? null,
      wireframeIterations,
      mockupIterations: input.mockupIterations ?? null,
      demoIterationsPerPhase: input.demoIterationsPerPhase ?? null,
    };

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'REQUIREMENTS', null, tx);

      // Read inside the lock: "already chose it" must be the row that the
      // upsert below is about to replace, not a stale one.
      const current = await tx.contractBrief.findUnique({ where: { contractId: contract.id }, select: { templateTypeId: true, kind: true } });
      if (!type.active && current?.templateTypeId !== type.id) {
        throw refuse('TEMPLATE_TYPE_INACTIVE', 'That template type is no longer offered.');
      }

      // The "feature for an existing site" preset (DX3a, review item 29): on the
      // change *to* that kind, in this same transaction, no design, every extra
      // out of scope, and the domain and the host not needed. Everything stays
      // editable afterwards; saving again as that kind changes none of it back.
      const preset = presetApplies(current?.kind ?? null, input.kind);
      const data = preset ? { ...baseData, designTier: EXISTING_SITE_PRESET.designTier } : baseData;

      // DX6: the brief's budget and the contract's fee are one number (founder: "these two fields seem to be the same").
      // Saving a budget sets the fee, unless the draft step is locked, in which case only the brief is written. A brief
      // made before it has a budget starts from the fee instead, and clearing the budget leaves the fee alone: the
      // form sends nothing for staff who cannot see money, and that must not erase a price.
      const feeOpen = await isStepOpenOn(contract.id, 'DRAFT', tx);
      const fee = feeOpen ? (await tx.contract.findUniqueOrThrow({ where: { id: contract.id }, select: { amount: true } })).amount : null;
      const briefData = !current && data.budgetCap === null && fee !== null ? { ...data, budgetCap: fee } : data;
      await tx.contractBrief.upsert({
        where: { contractId: contract.id },
        create: { contractId: contract.id, ...briefData },
        update: briefData,
      });
      if (feeOpen && data.budgetCap !== null) {
        await tx.contract.update({ where: { id: contract.id }, data: { amount: data.budgetCap } });
      }
      if (!current) await seedHandoverRows(tx, contract.projectId, user.id);
      if (preset) {
        await tx.scopeItem.updateMany({
          where: { projectId: contract.projectId, kind: 'EXTRA', status: 'AGREED' },
          data: { status: 'DECLINED' },
        });
        await tx.dependency.updateMany({
          where: { projectId: contract.projectId, inBrief: true, briefKey: { in: [...EXISTING_SITE_PRESET.notNeededKeys] } },
          data: { notNeeded: true },
        });
      }
      await syncBriefDependencies(tx, contract.id, user.id, input.commitments ?? []);
    });
    return reload(contract.id);
  },

  /**
   * An extra — one of the completeness checklist's standard areas — in or out
   * of scope (`kind: EXTRA`; declined ↔ agreed). Sales toggling these is how
   * the customer's "we need a payment gateway" becomes a commitment on the
   * board. Returns the contract the caller names (the registry is the
   * project's, `contractOnProject`), and that contract's step must be open.
   *
   * Only an `EXTRA` row: a page or a feature is J5's to negotiate, and this must
   * not become a second door to `setScopeItemStatus`. Switching an extra *off*
   * is refused once work has started on it (`EXTRA_IN_PROGRESS`).
   */
  setExtra: async (
    _p: unknown,
    args: { scopeItemId: string; included: boolean; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) throw refuse('NOT_FOUND', 'No such scope item.');
    if (item.kind !== 'EXTRA') throw refuse('NOT_AN_EXTRA', 'Only an extra can be switched here.');
    const contractId = await contractOnProject(item.projectId, args.contractId);
    const contract = await newRoadContract(contractId);

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'SCOPE', null, tx);
      // Read inside the lock, so "in progress" is the row's state now.
      const fresh = await tx.scopeItem.findUniqueOrThrow({ where: { id: item.id } });
      if (args.included) {
        if (!isIncludedExtra(fresh.status)) {
          await tx.scopeItem.update({
            where: { id: item.id },
            data: { status: 'AGREED', declinedReason: null, contractId: contract.id },
          });
        }
      } else if (isIncludedExtra(fresh.status)) {
        if (fresh.status !== 'AGREED') {
          throw refuse('EXTRA_IN_PROGRESS', 'Work has started on that, so it cannot be switched off here.');
        }
        await tx.scopeItem.update({ where: { id: item.id }, data: { status: 'DECLINED' } });
      }
      await syncBriefDependencies(tx, contract.id, user.id);
    });
    return reload(contract.id);
  },

  /**
   * The payment plan, replace-all in one transaction (journeys build plan J4).
   * **The split is descriptive, the rows are the plan**: the desk form proposes
   * rows from the split and sales edits them before saving, and this stores
   * exactly the rows it is given, in the order given (`ordinal` 1..n) — it never
   * regenerates them from the split. Whether the total matches the fee is a
   * question for the desk's hint and J7's gate (`planMatchesFee`), not a
   * refusal here: a plan is written before the fee is settled as often as after.
   *
   * A row's `phaseId` must be one of *this contract's* phases
   * (`PHASE_WRONG_CONTRACT`). Refusals: `FORBIDDEN`, `NOT_FOUND`,
   * `STEP_NOT_ON_ROAD`, the rows' own (`PLAN_ROWS_REQUIRED`, `TOO_MANY_ROWS`,
   * `LABEL_REQUIRED`, `INVALID_AMOUNT`, `INVALID_TERM`), `STEP_LOCKED`, and
   * (J13) `PLAN_HAS_ISSUED_INVOICES` once any row has been issued.
   */
  setPaymentPlan: async (
    _p: unknown,
    args: { contractId: string; split: 'LUMP_SUM' | 'INSTALLMENTS' | 'MONTHLY'; invoices: PlanRowArg[] },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await newRoadContract(args.contractId);
    const problem = checkPlanRows(args.invoices);
    if (problem) throw refuse(problem, PLAN_MESSAGES[problem]);

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'PHASES', null, tx);

      // J13 (J4's owed item): a replace deletes every planned invoice, and one
      // that has been issued is a customer's invoice with a number. Refused
      // rather than preserved — a partial replace would have to decide which
      // rows "are the same" as the old ones, and the desk form does not say.
      // Taken under the contract's lock, which `issuePlannedInvoice` also
      // holds, so an issue cannot slip in between this count and the delete;
      // the entry's Restrict foreign key is what stops anything else.
      const existingPlan = await tx.paymentPlan.findUnique({ where: { contractId: contract.id }, select: { id: true } });
      if (existingPlan && (await tx.billingEntry.count({ where: { plannedInvoice: { planId: existingPlan.id } } })) > 0) {
        throw refuse('PLAN_HAS_ISSUED_INVOICES', 'Part of this payment plan has already been issued as invoices, so the plan cannot be replaced.');
      }

      const named = [...new Set(args.invoices.map((r) => r.phaseId).filter((id): id is string => !!id))];
      if (named.length > 0) {
        const own = await tx.phase.count({ where: { id: { in: named }, contractId: contract.id } });
        if (own !== named.length) throw refuse('PHASE_WRONG_CONTRACT', 'A payment row names a phase this contract does not have.');
      }

      const plan = await tx.paymentPlan.upsert({
        where: { contractId: contract.id },
        create: { contractId: contract.id, split: args.split },
        update: { split: args.split },
      });
      await tx.plannedInvoice.deleteMany({ where: { planId: plan.id } });
      await tx.plannedInvoice.createMany({
        data: args.invoices.map((row, i) => ({
          planId: plan.id,
          ordinal: i + 1,
          labelFa: row.labelFa.trim(),
          labelEn: row.labelEn.trim(),
          amount: BigInt(row.amount),
          phaseId: row.phaseId ?? null,
          dueOn: row.dueOn ? parseCalendarDay(row.dueOn) : null,
          paymentTermDays: row.paymentTermDays,
        })),
      });
    });
    return reload(contract.id);
  },
};

// --- the fields ----------------------------------------------------------------

/**
 * `Contract.brief`, `.paymentPlan` and `.phases`. Spread into `Contract` in
 * `resolvers/index.ts`.
 *
 * **Every "who is looking" question is `viewerOf(ctx)`**, so view-as-customer
 * is the same rules through a different viewer (J3): the customer's budget cap
 * and plan are theirs to read, and a designer's are null.
 */
export const contractBriefFields = {
  brief: async (c: FullContract, _a: unknown, ctx: Context) => {
    const brief = await prisma.contractBrief.findUnique({ where: { contractId: c.id }, include: { templateType: true } });
    if (!brief) return null;
    return {
      ...brief,
      budgetCap: brief.budgetCap !== null && mayReadMoney(viewerOf(ctx), c) ? brief.budgetCap.toString() : null,
    };
  },

  paymentPlan: async (c: FullContract, _a: unknown, ctx: Context) => {
    if (!mayReadMoney(viewerOf(ctx), c)) return null;
    const plan = await prisma.paymentPlan.findUnique({
      where: { contractId: c.id },
      include: { invoices: { orderBy: { ordinal: 'asc' } } },
    });
    if (!plan) return null;
    return {
      id: plan.id,
      split: plan.split,
      total: planTotal(plan).toString(),
      invoices: plan.invoices.map((i) => ({ ...i, amount: i.amount.toString() })),
    };
  },

  /**
   * The handover items (DX3a): the project's `inBrief` board rows, in the order
   * the agreement freezes them (the default list's position, then title). All
   * of them — the ones marked not needed and the undecided ones too: the
   * customer reads the whole list in Requirements, though their board hides
   * those. The same records as `Project.dependencies`, not a copy.
   */
  handover: async (c: FullContract) => {
    const [rows, types] = await Promise.all([
      prisma.dependency.findMany({
        where: { projectId: c.projectId, inBrief: true },
        include: { project: true, createdBy: true, verifiedBy: true },
      }),
      prisma.handoverItemType.findMany({ select: { key: true, position: true } }),
    ]);
    return orderHandover(rows, new Map(types.map((t) => [t.key, t.position])));
  },

  /** This contract's own phases (PD-5) — `Project.phases` is every phase of the project. */
  phases: (c: FullContract, _a: unknown, ctx: Context) => phasesWhere({ contractId: c.id }, ctx),
};
