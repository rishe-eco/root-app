import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import {
  computeGate,
  assertCanApproveContract,
  assertCanSign,
  assertCanApproveAmendment,
  assertCanSignAmendment,
} from '../../lib/gate.js';
import { approveStepTx, lockContract } from '../../lib/stepApproval.js';
import { draftState } from '../../lib/revision.js';
import { agreedScopeSnapshotFor } from '../../lib/scope.js';
import { scopeStepDone } from '../../lib/scopeProposals.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { contractInclude, loadForActor, log, nudgeStatus, reload, type FullContract } from './contracts.js';
import { loadAgreementParts } from './agreement.js';
import { briefIncompleteOn } from './wizard.js';
import { linkContractId } from './admin/shared.js';

/**
 * What the customer does to their own contract: choose a concept, approve
 * pages, approve the text, tick the scope checklist, sign, comment.
 *
 * Every one of these goes through `loadForActor`, so "your own, and published"
 * is enforced once rather than six times. The gate is asserted here and derived
 * on the server — never taken from the client.
 *
 * These are grouped as *customer* actions by who they belong to, not by who may
 * call them. An admin can act on a contract too, and `addComment` reads the
 * caller's role to decide whose court the ball lands in.
 */
const deskUrl = (locale: string, contractId: string) =>
  `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contractId}/steps`;

/**
 * Tells sales the agreement moved (J7). Best-effort like every notification —
 * `notify` never throws, and the lookup feeding it can, so it is wrapped: the
 * approval or the signature it announces has already been written. Recipients
 * are every active `contracts.author` holder (J5 and J6's choice: no sales
 * assignee exists to prefer).
 */
async function tellSalesOfAgreement(kind: 'AGREEMENT_APPROVED' | 'AGREEMENT_SIGNED', contract: FullContract) {
  try {
    const recipients = await recipientsHolding('contracts.author');
    await Promise.all(
      recipients.map((r) =>
        notify(r, {
          kind,
          params: {
            recipientName: r.name,
            customerName: contract.customer.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            deskUrl: deskUrl(r.locale, contract.id),
          },
        }),
      ),
    );
  } catch (err) {
    console.error(`[customer] ${kind} notification failed`, err);
  }
}

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/**
 * **Approving the agreement on the new road** (journeys build plan J7) — the
 * lifecycle plan's owed L8. One transaction under the contract's row lock, so
 * nothing about steps 1–3 can move between the gate reading them and the lock
 * being written: `assertCanApproveContract`'s agreement branch (the gate),
 * then `approveStepTx(AGREEMENT)` — which refuses on an unresolved note or a
 * pending answer, accepts every resolved one and writes the `StepApproval`
 * that locks REQUIREMENTS, SCOPE, DRAFT and AGREEMENT — and the revision's own
 * `approvedAt`, the fact `assertCanSign` reads. The three are one act.
 *
 * The gate runs *before* `approveStepTx`, so its codes (`SCOPE_UNCONFIRMED`,
 * `PLAN_TOTAL_MISMATCH`, …) come before the feedback ones; the plan does not
 * order them and every one is a refusal.
 */
async function approveAgreement(contractId: string, customerId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockContract(tx, contractId);
      const contract = await tx.contract.findUnique({ where: { id: contractId }, include: contractInclude });
      if (!contract) throw notFound('contract');

      const proposals = await tx.scopeProposal.findMany({ where: { contractId }, select: { decidedAt: true } });
      const parts = await loadAgreementParts(tx, contract);
      const stale = draftState(
        contract,
        contract.articles,
        contract.currentContractRevision,
        agreedScopeSnapshotFor(contract.id, contract.project.scopeItems),
        parts,
      ).dirty;
      const scopeOk = scopeStepDone({ items: contract.project.scopeItems, proposals, contractId });

      assertCanApproveContract(contract, {
        revision: contract.currentContractRevision,
        scopeConfirmed: scopeOk,
        undecidedProposals: proposals.filter((p) => p.decidedAt === null).length,
        fee: contract.amount,
        plan: parts.plan,
        plannedStartAt: contract.plannedStartAt,
        plannedEndAt: contract.plannedEndAt,
        phases: parts.phases,
        briefMissing: (await briefIncompleteOn(contract)).map((m) => m.code),
        revisionStale: stale,
      });

      const { approval } = await approveStepTx(tx, { contractId, step: 'AGREEMENT', phaseId: null, approverId: customerId });
      await tx.contractRevision.update({
        where: { id: contract.currentContractRevision!.id },
        data: { approvedAt: approval.approvedAt },
      });
      await log(contractId, customerId, 'APPROVED_CONTRACT', null, tx);
    },
    // A contract with dozens of notes reads and writes more than Prisma's five
    // seconds allow on a busy database; late is better than failed half-way.
    { timeout: 20_000 },
  );
}

export const customerMutations = {
  chooseConcept: async (
    _p: unknown,
    args: { contractId: string; conceptId: string },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    const revision = contract.currentDesignRevision;
    const concept = revision?.concepts.find((c) => c.id === args.conceptId);
    if (!revision || !concept) {
      throw new GraphQLError('No such concept.', { extensions: { code: 'NOT_FOUND' } });
    }
    // Deliberately *not* gated on the contract being approved or signed. The
    // two lineages advance on separate clocks: Root can publish a new design
    // revision long after the text is signed, and the customer has to be able
    // to work through it. The old guard read the contract's approval because
    // there was only ever one design; keeping it here would reopen the design
    // step and then refuse every action that could close it again.

    // Choosing a different concept resets the page approvals beneath it —
    // approving pages of a design you then abandoned would be meaningless.
    // Scoped to this revision: approvals in a superseded one stay as history.
    await prisma.$transaction([
      prisma.designConcept.updateMany({
        where: { designRevisionId: revision.id },
        data: { chosenAt: null },
      }),
      prisma.pageDesign.updateMany({
        where: { concept: { designRevisionId: revision.id } },
        data: { approvedAt: null },
      }),
      prisma.designConcept.update({
        where: { id: concept.id },
        data: { chosenAt: new Date() },
      }),
    ]);

    await log(contract.id, user.id, 'CHOSE_CONCEPT', concept.key);
    return reload(contract.id);
  },

  setPageApproval: async (
    _p: unknown,
    args: { pageDesignId: string; approved: boolean },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const page = await prisma.pageDesign.findUnique({
      where: { id: args.pageDesignId },
      include: { concept: { include: { designRevision: true } } },
    });
    if (!page) {
      throw new GraphQLError('No such page design.', { extensions: { code: 'NOT_FOUND' } });
    }
    const contract = await loadForActor(page.concept.designRevision.contractId, user);
    // Only the live revision is approvable. A page in a superseded one is
    // history, and a page in an unpublished draft has not been handed over.
    if (contract.currentDesignRevisionId !== page.concept.designRevisionId) {
      throw new GraphQLError('That page belongs to an older design revision.', {
        extensions: { code: 'REVISION_NOT_CURRENT' },
      });
    }
    // Not gated on the contract lineage — see chooseConcept. Being current is
    // the whole requirement: this revision is the one in front of the
    // customer, whatever the text has done in the meantime.
    if (page.concept.chosenAt === null) {
      throw new GraphQLError('Choose this concept before approving its pages.', {
        extensions: { code: 'CONCEPT_NOT_CHOSEN' },
      });
    }

    await prisma.pageDesign.update({
      where: { id: page.id },
      data: { approvedAt: args.approved ? new Date() : null },
    });
    await log(
      contract.id,
      user.id,
      args.approved ? 'APPROVED_PAGE' : 'UNAPPROVED_PAGE',
      page.key,
    );

    const after = await reload(contract.id);
    const gateBefore = computeGate(contract);
    const gateAfter = computeGate(after);
    if (!gateBefore.designComplete && gateAfter.designComplete) {
      await log(contract.id, user.id, 'DESIGN_COMPLETE');
      await nudgeStatus(after, 'WAITING_ON_ROOT');
      return reload(contract.id);
    }
    return after;
  },

  approveContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);

    // **The new road has its own gate, and only the customer walks through it**
    // (J7). Approving is the customer's act — it locks steps 1–3 and, with the
    // signature, is what they are held to — so unlike the legacy road (where any
    // reader `loadForActor` admits could press the button) a staff reader gets
    // the answer a stranger does. Refused after the ownership check, so nobody
    // learns which road a contract is on.
    if (contract.sequence === 'AGREEMENT_FIRST') {
      if (contract.customerId !== user.id) throw notFound('contract');
      await approveAgreement(contract.id, user.id);
      const after = await reload(contract.id);
      await tellSalesOfAgreement('AGREEMENT_APPROVED', after);
      return after;
    }

    assertCanApproveContract(contract);

    // Approval attaches to the revision, never to the contract in the
    // abstract — that is what makes "you approved v1, this is v2" sayable.
    // No revision means no text to approve: the gate reads unapproved either
    // way, so this has to be caught here rather than there.
    const revision = contract.currentContractRevision;
    if (!revision) {
      throw new GraphQLError('This contract has no published text to approve.', {
        extensions: { code: 'NO_CONTRACT_REVISION' },
      });
    }
    await prisma.contractRevision.update({
      where: { id: revision.id },
      data: { approvedAt: new Date() },
    });
    const isFirst = revision.version === 1;
    await log(contract.id, user.id, isFirst ? 'APPROVED_CONTRACT' : 'RE_APPROVED');
    return reload(contract.id);
  },

  setScopeItem: async (
    _p: unknown,
    args: { scopeItemId: string; checked: boolean; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    // ScopeItem belongs to a Project (build plan D1), and since J2 a project
    // can hold more than one contract, so which contract this acts through
    // has to be named: the one the caller has open (`contractId`), else the
    // one that agreed the item (T1's `ScopeItem.contractId`), else the newest
    // published one. Ownership then goes through `loadForActor` on *that*
    // contract, exactly as every other customer mutation does (house rule 2):
    // an unpublished or someone else's contract is NOT_FOUND. The contract
    // must be on the item's own project — a contract of another project would
    // turn this into a way to tick boxes on rows the caller never saw.
    const contract = await loadForActor(
      args.contractId ?? item.contractId ?? (await linkContractId(item.projectId, 'customer')),
      user,
    );
    if (contract.projectId !== item.projectId) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    // **The tick belongs to the legacy road only** (journeys build plan J5,
    // §7 item 9). On a new-road contract "tick this box" would mean two things —
    // an old private mark and a proposal to Root — so it means neither: the
    // customer's scope gestures there are `proposeScopeAddition`,
    // `proposeScopeRemoval` and `proposeRestore`, and `checkedAt` is **never
    // written** for such a contract (nor unwritten: legacy rows keep theirs).
    // Refused after the ownership check, so a stranger still hears "no such
    // item" and never learns which road a contract is on.
    if (contract.sequence === 'AGREEMENT_FIRST') {
      throw new GraphQLError('This contract does not use the scope checklist — propose a change instead.', {
        extensions: { code: 'NOT_APPLICABLE' },
      });
    }

    // Never gated — the checklist stays editable at every stage.
    await prisma.scopeItem.update({
      where: { id: item.id },
      data: { checkedAt: args.checked ? new Date() : null },
    });
    await log(contract.id, user.id, args.checked ? 'SCOPE_ON' : 'SCOPE_OFF', item.key);
    return reload(contract.id);
  },

  signContract: async (
    _p: unknown,
    args: { contractId: string; typedName: string },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    // Signing on the new road is the customer's own, as approving is (J7).
    if (contract.sequence === 'AGREEMENT_FIRST' && contract.customerId !== user.id) throw notFound('contract');
    assertCanSign(contract);

    const typedName = args.typedName.trim();
    if (typedName.length < 2) {
      throw new GraphQLError('Type your full name to sign.', {
        extensions: { code: 'NAME_TOO_SHORT' },
      });
    }

    const revision = contract.currentContractRevision!;
    await prisma.signature.create({
      data: {
        contractRevisionId: revision.id,
        signerId: user.id,
        typedName,
        // The bytes actually attested to, copied here so tampering is
        // detectable from the signature alone. assertCanSign has already
        // refused an unsealed revision, so this is never null.
        signedHash: revision.contentHash,
        ip: ctx.req.ip ?? null,
        userAgent: ctx.req.get('user-agent') ?? null,
      },
    });
    await log(contract.id, user.id, revision.version === 1 ? 'SIGNED' : 'RE_SIGNED');

    // Approved & signed -> the build is live. A default, not a rail.
    await nudgeStatus(contract, 'IN_PROGRESS');
    const after = await reload(contract.id);
    if (contract.sequence === 'AGREEMENT_FIRST') await tellSalesOfAgreement('AGREEMENT_SIGNED', after);
    return after;
  },

  /**
   * The amendment's own mini-gate (V2.md §3.3): approve, then sign, without
   * reopening the base. Ownership goes through the same `loadForActor` the
   * rest of this file uses — an amendment is reached by id, so which
   * contract it belongs to has to be looked up before that check can run.
   */
  approveAmendment: async (_p: unknown, args: { amendmentId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    const contract = await loadForActor(amendment.contractRevision.contractId, user);
    assertCanApproveAmendment(amendment);

    await prisma.amendment.update({
      where: { id: amendment.id },
      data: { approvedAt: new Date() },
    });
    await log(contract.id, user.id, 'AMENDMENT_APPROVED', `A${amendment.ordinal}`);
    return reload(contract.id);
  },

  signAmendment: async (
    _p: unknown,
    args: { amendmentId: string; typedName: string },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } }, signature: true },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    const contract = await loadForActor(amendment.contractRevision.contractId, user);
    assertCanSignAmendment(amendment);

    const typedName = args.typedName.trim();
    if (typedName.length < 2) {
      throw new GraphQLError('Type your full name to sign.', {
        extensions: { code: 'NAME_TOO_SHORT' },
      });
    }

    await prisma.signature.create({
      data: {
        amendmentId: amendment.id,
        signerId: user.id,
        typedName,
        // The amendment's own hash, exactly as signContract copies the
        // revision's. The base contract's signature is untouched — this is a
        // separate instrument, not a re-signing of the original.
        signedHash: amendment.contentHash,
        ip: ctx.req.ip ?? null,
        userAgent: ctx.req.get('user-agent') ?? null,
      },
    });
    await log(contract.id, user.id, 'AMENDMENT_SIGNED', `A${amendment.ordinal}`);
    return reload(contract.id);
  },

  addComment: async (
    _p: unknown,
    args: { contractId: string; body: string; target?: 'DESIGN' | 'CONTRACT' },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    // **A new-road contract has no free thread** (journeys build plan J6, §7
    // item 8) — its notes are feedback: anchored to a field, an item or an
    // article, with a fate (`submitFeedback`, S2). A second place to "say
    // something about the contract" is the drift the plan warns of, and one that
    // locks at approval (§3.1) cannot be the same mutation as one that is "free at
    // every stage". This retires the schema's "Never gated" note for new
    // contracts — the first of §3.1's three reversals, recorded in J6.md. The
    // legacy road keeps `Comment` exactly as it was. Refused after ownership,
    // so a stranger still hears "no such contract".
    if (contract.sequence === 'AGREEMENT_FIRST') {
      throw new GraphQLError('Leave a note on the thing it is about instead.', {
        extensions: { code: 'USE_FEEDBACK' },
      });
    }
    const body = args.body.trim();
    if (!body) {
      throw new GraphQLError('Write something first.', { extensions: { code: 'EMPTY_COMMENT' } });
    }

    // Commenting is free at every stage, whatever the gate says.
    await prisma.comment.create({
      data: {
        contractId: contract.id,
        authorId: user.id,
        body,
        target: args.target ?? 'CONTRACT',
      },
    });
    await log(contract.id, user.id, 'COMMENTED');

    // A customer comment puts the ball in Root's court.
    //
    // Deliberately an ownership test, not a capability one. The question here
    // is not "may this person comment" — they already did — it is "which side
    // of this contract just spoke", and that is an edge between this user and
    // this row. Asking a capability would give the wrong answer for anyone who
    // holds a staff role for unrelated reasons.
    if (user.id === contract.customerId) await nudgeStatus(contract, 'WAITING_ON_ROOT');
    else await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');

    return reload(contract.id);
  },
};
