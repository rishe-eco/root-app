import { GraphQLError } from 'graphql';
import type { ScopeKind, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { lockContract } from '../../lib/stepApproval.js';
import { stepOnRoad } from '../../lib/steps.js';
import { assertCanConfirmTradeAsCustomer } from '../../lib/scope.js';
import {
  applyDecision,
  checkDecision,
  checkProposalText,
  hasUndecidedProposalFor,
  isProposableKind,
  isProposalLang,
  removable,
  restorable,
  scopeSeeded,
  seedRows,
  type DecisionInput,
  type DecisionProblem,
  type ProposalKind,
} from '../../lib/scopeProposals.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { assertStepOpenOn } from './wizard.js';
import { primaryContractId, reloadOnProject } from './admin/shared.js';

/**
 * Step 2a — pages, features and deliverables (journeys build plan J5): the
 * customer's proposals, Root's decisions on them, seeding a contract's scope
 * from its template, and the customer's half of a scope trade. The rules are
 * `lib/scopeProposals.ts` and `lib/scope.ts`; this file loads rows, takes the
 * contract's lock, writes, and answers `Contract!` (T9 in V2.md).
 *
 * **Every write here does the same things in the same order**, as J4's do
 * (`resolvers/brief.ts`): the caller's edge first (the customer's own contract,
 * or `contracts.author` — `FORBIDDEN`/`NOT_FOUND` before anything about the
 * contract's state is said), the step being on this contract's road
 * (`STEP_NOT_ON_ROAD` — a legacy contract has no scope step, and its tick is
 * `setScopeItem`), then the contract's row lock and `assertStepOpenOn(SCOPE)`
 * inside it. Nothing can lock SCOPE until J7's agreement approval exists, but
 * the call lands now so J7 changes nothing here. **The scope trade is the one
 * exception, on purpose**: it is the post-lock path for a scope change
 * (journeys §3.1 point 5), so it must work when SCOPE is locked.
 *
 * **Who is told** (`lib/notify.ts`): a proposal made goes to everyone holding
 * `contracts.author` — the contract has no seller assigned to route to (S1
 * assigns a designer and a developer), so "sales" is the capability's holders,
 * as every other step-1–3 notification already is (`feedback.ts`'s
 * `stepOwners`); a proposal decided goes to the customer, with the reason when
 * it was declined. Best-effort, after the write, like every notification.
 */

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

const TEXT_MESSAGES = {
  EMPTY_PROPOSAL: 'Say what you would like.',
  PROPOSAL_TOO_LONG: 'That is too long — keep it to a few sentences.',
} as const;

const DECISION_MESSAGES: Record<DecisionProblem, string> = {
  REASON_REQUIRED: 'Declining a proposal needs a reason — the customer reads it.',
  REASON_TOO_LONG: 'That reason is too long.',
  LABEL_REQUIRED: 'Confirming an addition needs its label in both languages.',
  INVALID_KEY: 'A key is Latin letters and digits joined by dots or hyphens.',
  INVALID_KIND: 'An item is a page, a feature or a deliverable.',
};

const deskUrl = (locale: string, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contractId}/steps`;
const portalUrl = (locale: string, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`;

/** A notification must never fail the act that caused it (`notify` itself never
 *  throws; the lookups feeding it can). */
async function tell(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error('[scope] notification failed', err);
  }
}

/**
 * The contract a customer is proposing on: theirs and published
 * (`loadForActor`), theirs *as the customer* — a staff reader who can see the
 * contract gets the answer a stranger does (Root decides proposals, it does not
 * raise them; house rules 2 and 13) — and on the new road.
 */
async function customerContract(contractId: string, user: User): Promise<FullContract> {
  const contract = await loadForActor(contractId, user);
  if (contract.customerId !== user.id) throw notFound('contract');
  if (!stepOnRoad(contract.sequence, 'SCOPE')) {
    throw refuse('STEP_NOT_ON_ROAD', 'This contract has no scope step.');
  }
  return contract;
}

const checkText = (text: string) => {
  const problem = checkProposalText(text);
  if (problem) throw refuse(problem, TEXT_MESSAGES[problem]);
};

async function tellStaffOfProposal(contract: FullContract, proposalKind: ProposalKind, text: string) {
  await tell(async () => {
    const recipients = await recipientsHolding('contracts.author');
    await Promise.all(
      recipients.map((r) =>
        notify(r, {
          kind: 'SCOPE_PROPOSED',
          params: {
            recipientName: r.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            proposalKind,
            text: text.trim(),
            deskUrl: deskUrl(r.locale, contract.id),
          },
        }),
      ),
    );
  });
}

/** A proposal about an existing item — remove or restore, one shape. */
async function proposeAboutItem(
  kind: 'REMOVE' | 'RESTORE',
  args: { scopeItemId: string; text: string },
  ctx: Context,
) {
  const user = requireUser(ctx);
  const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
  // The contract is the one that agreed the item (T1's `ScopeItem.contractId`):
  // with several contracts on a project (J2) that is the only answer that names
  // *the* agreement being negotiated. An item no contract has agreed is one no
  // customer has been shown.
  if (!item || !item.contractId) throw notFound('scope item');
  const contract = await customerContract(item.contractId, user);
  checkText(args.text);

  await prisma.$transaction(async (tx) => {
    await lockContract(tx, contract.id);
    await assertStepOpenOn(contract.id, 'SCOPE', null, tx);

    // Read inside the lock: what the item *is* now, and whether a decision is
    // already owed on it.
    const fresh = await tx.scopeItem.findUniqueOrThrow({ where: { id: item.id } });
    if (fresh.kind === 'EXTRA') {
      throw refuse('NOT_PROPOSABLE', 'The extras are switched in step 1 — leave a note there.');
    }
    if (kind === 'REMOVE' ? !removable(fresh) : !restorable(fresh)) {
      throw refuse(
        kind === 'REMOVE' ? 'ITEM_NOT_REMOVABLE' : 'ITEM_NOT_RESTORABLE',
        kind === 'REMOVE' ? 'Only an agreed item can be proposed for removal.' : 'Only a declined item can be brought back.',
      );
    }
    const open = await tx.scopeProposal.findMany({
      where: { contractId: contract.id, decidedAt: null },
      select: { scopeItemId: true, decidedAt: true },
    });
    if (hasUndecidedProposalFor(open, item.id)) {
      throw refuse('PROPOSAL_PENDING', 'There is already a proposal about this item waiting for Root.');
    }

    await tx.scopeProposal.create({
      data: {
        contractId: contract.id,
        kind,
        scopeItemId: item.id,
        text: args.text.trim(),
        // Only an ADD needs to say which label sales still has to write; a
        // remove or restore is about an item that has both. The column is
        // required, so it carries the language the customer works in.
        lang: user.locale === 'en' ? 'en' : 'fa',
        proposedById: user.id,
      },
    });
  });

  await tellStaffOfProposal(contract, kind, args.text);
  return reload(contract.id);
}

export const scopeMutations = {
  /**
   * The customer proposes adding a page, feature or deliverable, in their own
   * words and language. Nothing enters the registry: the proposal waits for
   * sales, who writes the bilingual item when confirming it
   * (`decideScopeProposal`).
   *
   * Refusals, in order: `NOT_FOUND` (not theirs, or not published),
   * `STEP_NOT_ON_ROAD` (legacy contract), `INVALID_KIND` (an `EXTRA` is step
   * 1's), `INVALID_LANG`, the text's own (`EMPTY_PROPOSAL`,
   * `PROPOSAL_TOO_LONG`), `STEP_LOCKED`.
   */
  proposeScopeAddition: async (
    _p: unknown,
    args: { contractId: string; kind: ScopeKind; text: string; lang: string },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await customerContract(args.contractId, user);
    if (!isProposableKind(args.kind)) {
      throw refuse('INVALID_KIND', 'You can ask for a page, a feature or a deliverable.');
    }
    if (!isProposalLang(args.lang)) throw refuse('INVALID_LANG', 'Write in Persian or English.');
    checkText(args.text);

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'SCOPE', null, tx);
      await tx.scopeProposal.create({
        data: {
          contractId: contract.id,
          kind: 'ADD',
          requestedKind: args.kind,
          text: args.text.trim(),
          lang: args.lang,
          proposedById: user.id,
        },
      });
    });

    await tellStaffOfProposal(contract, 'ADD', args.text);
    return reload(contract.id);
  },

  /** Take an agreed item out. `ITEM_NOT_REMOVABLE`, `PROPOSAL_PENDING`, and the rest as above. */
  proposeScopeRemoval: (_p: unknown, args: { scopeItemId: string; text: string }, ctx: Context) =>
    proposeAboutItem('REMOVE', args, ctx),

  /** Bring a declined item back. `ITEM_NOT_RESTORABLE`, `PROPOSAL_PENDING`, and the rest as above. */
  proposeRestore: (_p: unknown, args: { scopeItemId: string; text: string }, ctx: Context) =>
    proposeAboutItem('RESTORE', args, ctx),

  /**
   * Sales decides a proposal (`contracts.author`). **Accepting** an ADD writes
   * the registry item — bilingual (sales' labels), keyed `custom.<n>` unless a
   * key is typed, agreed, with the customer's words as its origin note;
   * accepting a REMOVE declines the item with the proposal's text as its reason;
   * accepting a RESTORE agrees it again. **Declining** needs a reason the
   * customer reads and changes nothing in the registry. The customer is told
   * either way.
   *
   * Refusals: `FORBIDDEN`, `NOT_FOUND`, `STEP_NOT_ON_ROAD`, the decision's own
   * (`REASON_REQUIRED`, `LABEL_REQUIRED`, `INVALID_KEY`, `INVALID_KIND`),
   * `STEP_LOCKED`, `ALREADY_DECIDED`, `KEY_TAKEN` (a typed key the project has),
   * `ITEM_STATE_CHANGED` (the item is no longer in the state the proposal
   * assumed — something else moved it first).
   */
  decideScopeProposal: async (
    _p: unknown,
    args: {
      id: string;
      decision: 'ACCEPTED' | 'DECLINED';
      labelFa?: string | null;
      labelEn?: string | null;
      key?: string | null;
      kind?: string | null;
      declineReason?: string | null;
    },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'contracts.author');
    const found = await prisma.scopeProposal.findUnique({
      where: { id: args.id },
      include: { contract: { include: { customer: true, project: true } } },
    });
    if (!found) throw notFound('proposal');
    const { contract } = found;
    if (!stepOnRoad(contract.sequence, 'SCOPE')) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no scope step.');
    }
    const input: DecisionInput = {
      decision: args.decision,
      labelFa: args.labelFa,
      labelEn: args.labelEn,
      key: args.key,
      kind: args.kind,
      declineReason: args.declineReason,
    };
    const problem = checkDecision(found.kind, input);
    if (problem) throw refuse(problem, DECISION_MESSAGES[problem]);

    const declineReason = args.decision === 'DECLINED' ? args.declineReason!.trim() : null;

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'SCOPE', null, tx);

      // Read inside the lock: two sales users deciding one proposal at once
      // must not both apply it.
      const proposal = await tx.scopeProposal.findUniqueOrThrow({ where: { id: found.id } });
      if (proposal.decidedAt) throw refuse('ALREADY_DECIDED', 'That proposal has already been decided.');

      const registry = await tx.scopeItem.findMany({ where: { projectId: contract.projectId }, select: { key: true } });
      const takenKeys = registry.map((r) => r.key);
      if (args.decision === 'ACCEPTED' && proposal.kind === 'ADD' && args.key?.trim() && takenKeys.includes(args.key.trim())) {
        throw refuse('KEY_TAKEN', 'That key is already used on this project.');
      }
      const { item: write } = applyDecision(
        { kind: proposal.kind, text: proposal.text, scopeItemId: proposal.scopeItemId, requestedKind: proposal.requestedKind },
        input,
        takenKeys,
      );

      let createdItemId: string | null = null;
      if (write.action === 'create') {
        const created = await tx.scopeItem.create({
          data: {
            projectId: contract.projectId,
            key: write.key,
            labelFa: write.labelFa,
            labelEn: write.labelEn,
            position: registry.length,
            kind: write.kind,
            // Root confirming it *is* the agreement act, as `addScopeItem` and the
            // template say of their own rows.
            status: 'AGREED',
            contractId: contract.id,
            originNote: write.originNote,
          },
        });
        createdItemId = created.id;
      } else if (write.action !== 'none') {
        const item = await tx.scopeItem.findUniqueOrThrow({ where: { id: write.itemId } });
        if (write.action === 'decline' ? !removable(item) : !restorable(item)) {
          throw refuse('ITEM_STATE_CHANGED', 'That item is no longer in the state the customer asked about.');
        }
        await tx.scopeItem.update({
          where: { id: item.id },
          data:
            write.action === 'decline'
              ? { status: 'DECLINED', declinedReason: write.declinedReason }
              : { status: 'AGREED', declinedReason: null },
        });
      }

      await tx.scopeProposal.update({
        where: { id: proposal.id },
        data: {
          decision: args.decision,
          decidedAt: new Date(),
          decidedById: user.id,
          declineReason,
          createdItemId,
        },
      });
    });

    const { customer, project } = contract;
    await tell(() =>
      notify(customer, {
        kind: 'SCOPE_PROPOSAL_DECIDED',
        params: {
          customerName: customer.name,
          projectTitleFa: project.titleFa,
          projectTitleEn: project.titleEn,
          decision: args.decision,
          reason: declineReason,
          portalUrl: portalUrl(customer.locale, contract.id),
        },
      }),
    );
    return reload(contract.id);
  },

  /**
   * Seeds this contract's scope from the template type its brief chose
   * (`contracts.author`): every page, feature and deliverable the type lists,
   * agreed, of this contract's own. **`SCOPE_ALREADY_SEEDED`** when the
   * contract already has any (`scopeSeeded` — L1's own guard, made per
   * contract).
   *
   * **A second contract on the same project** (J2) has none of its own even
   * though the project's registry is full, so it can be seeded: a key the
   * project already has takes the next free suffix (`home`, `home.2` —
   * `seedRows`), and the first contract's rows are left exactly as they were.
   * That is what J2's owed item ("`applyContractTemplate` on a second contract
   * refuses `TEMPLATE_NOT_EMPTY`") needed, done for the scope half here and for
   * the old template's in `admin/contracts.ts`.
   *
   * Refusals: `FORBIDDEN`, `NOT_FOUND`, `STEP_NOT_ON_ROAD`, `BRIEF_MISSING`
   * (the type is the brief's), `TEMPLATE_SCOPE_EMPTY` (a type with nothing to
   * seed — a designer's or sales' list to write, not something to seed as
   * nothing), `SCOPE_ALREADY_SEEDED`, `STEP_LOCKED`.
   */
  applyScopeTemplate: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({
      where: { id: args.contractId },
      include: { brief: { select: { templateTypeId: true } } },
    });
    if (!contract) throw notFound('contract');
    if (!stepOnRoad(contract.sequence, 'SCOPE')) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no scope step.');
    }
    if (!contract.brief) throw refuse('BRIEF_MISSING', 'Choose the site type in step 1 first.');

    const template = await prisma.templateScopeItem.findMany({
      where: { typeId: contract.brief.templateTypeId },
      orderBy: [{ position: 'asc' }, { key: 'asc' }],
    });
    if (template.length === 0) {
      throw refuse('TEMPLATE_SCOPE_EMPTY', 'That site type has no pages, features or deliverables to start from yet.');
    }

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      // The registry is the project's and its keys are unique per project, so
      // the project is locked too: two contracts of one project seeded at once
      // must not choose the same suffix.
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${contract.projectId} FOR UPDATE`;
      await assertStepOpenOn(contract.id, 'SCOPE', null, tx);

      const registry = await tx.scopeItem.findMany({
        where: { projectId: contract.projectId },
        select: { key: true, kind: true, contractId: true },
      });
      if (scopeSeeded(registry, contract.id)) {
        throw refuse('SCOPE_ALREADY_SEEDED', 'This contract already has pages, features or deliverables.');
      }

      const rows = seedRows(template, registry.map((r) => r.key), registry.length);
      await tx.scopeItem.createMany({
        data: rows.map((r) => ({
          projectId: contract.projectId,
          key: r.key,
          labelFa: r.labelFa,
          labelEn: r.labelEn,
          position: r.position,
          kind: r.kind,
          contractId: contract.id,
          // Root applying the template is the agreement act — the same reasoning
          // `applyContractTemplate` gives for its own rows. The customer
          // negotiates from here through proposals.
          status: 'AGREED' as const,
        })),
      });
    });
    return reload(contract.id);
  },

  /**
   * The customer's half of a scope trade — the lifecycle plan's owed §0.3.1.
   * **The contract's own customer only**: not any viewer of the project, and not
   * staff who can see the contract (`NOT_FOUND` for both, house rule 13). The
   * contract is the one the caller names, else the one that agreed the trade's
   * outgoing item, else the project's first — the same rule `executeScopeTrade`
   * uses for the document it amends.
   *
   * **Deliberately not under `assertStepOpenOn`**: a trade is the post-lock way
   * to change a scope (journeys §3.1 point 5), so it must work exactly when
   * SCOPE is locked. Once both halves are confirmed, `executeScopeTrade`
   * (`contracts.author`) succeeds — its own gate (`assertCanExecuteTrade`) has
   * required both since L1 and did not change; this is the mutation that makes
   * the second half reachable.
   */
  confirmScopeTradeCustomer: async (
    _p: unknown,
    args: { tradeId: string; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const trade = await prisma.scopeTrade.findUnique({ where: { id: args.tradeId }, include: { outItem: true } });
    if (!trade) throw notFound('trade');
    const contractId = args.contractId ?? trade.outItem.contractId ?? (await primaryContractId(trade.projectId));
    const contract = await loadForActor(contractId, user);
    if (contract.projectId !== trade.projectId || contract.customerId !== user.id) throw notFound('trade');
    assertCanConfirmTradeAsCustomer(trade);

    // A conditional write: two clicks at once cannot both confirm.
    const { count } = await prisma.scopeTrade.updateMany({
      where: { id: trade.id, customerConfirmedAt: null, executedAt: null },
      data: { customerConfirmedAt: new Date() },
    });
    if (count === 0) throw refuse('ALREADY_CONFIRMED', 'You have already confirmed this trade.');
    return reloadOnProject(trade.projectId, contract.id);
  },
};

/**
 * `Contract.scopeProposals` — this contract's proposals, oldest first, for
 * whoever can read the contract (the customer, and staff readers): proposals
 * carry the customer's words and Root's decisions, both things each side is
 * meant to see, and no money. Spread into `Contract` in `resolvers/index.ts`.
 */
export const contractScopeFields = {
  scopeProposals: (c: FullContract) =>
    prisma.scopeProposal.findMany({
      where: { contractId: c.id },
      include: { scopeItem: true, proposedBy: true, createdItem: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
};
