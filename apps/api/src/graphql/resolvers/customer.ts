import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { computeGate, assertCanApproveContract, assertCanSign } from '../../lib/gate.js';
import { loadForActor, log, nudgeStatus, reload } from './contracts.js';

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
    args: { scopeItemId: string; checked: boolean },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const item = await prisma.scopeItem.findUnique({ where: { id: args.scopeItemId } });
    if (!item) {
      throw new GraphQLError('No such scope item.', { extensions: { code: 'NOT_FOUND' } });
    }
    const contract = await loadForActor(item.contractId, user);

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
    return reload(contract.id);
  },

  addComment: async (
    _p: unknown,
    args: { contractId: string; body: string; target?: 'DESIGN' | 'CONTRACT' },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
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
