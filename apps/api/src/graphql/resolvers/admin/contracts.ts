import { GraphQLError } from 'graphql';
import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { can, type Capability } from '../../../lib/capabilities.js';
import { draftState } from '../../../lib/revision.js';
import { agreedScopeSnapshot } from '../../../lib/scope.js';
import { SEQUENCE_FOR_NEW_CONTRACTS, stepOnRoad } from '../../../lib/steps.js';
import { lockContract } from '../../../lib/stepApproval.js';
import { parseCalendarDay } from '../../../lib/calendarDay.js';
import { scopeSeeded, scopeStepDone, seedRows } from '../../../lib/scopeProposals.js';
import {
  ARTICLES,
  SCOPE,
  CHECKLIST,
  isTemplateSensitiveArticle,
  partiesFor,
  renderArticleBody,
} from '../../../lib/templates.js';
import { contractInclude, log, nudgeStatus, reload, type FullContract } from '../contracts.js';
import { assertStepOpenOn, briefIncompleteOn } from '../wizard.js';
import { asConcurrentPublish } from './shared.js';
import { notify } from '../../../lib/notify.js';
import { env } from '../../../lib/env.js';

/**
 * The contract draft (title, fee, articles) and its publish path, plus
 * project/contract creation. Part of the L1 split of the former `admin.ts`;
 * see `index.ts`. Every mutation is `contracts.author` (journeys build plan
 * S1; before it, `contracts.manage`).
 */

/**
 * An assignee must be able to do the job they are assigned to, and be able
 * to sign in to do it — checked when sales assigns, never after: a designer
 * disabled later stays on the row as history, and J3 surfaces that to sales
 * as an attention item instead of silently routing work to nobody (plan S1).
 *
 * `undefined` means "leave as is", `null` means "unassign". The capability
 * is the one the assignment edge guards (`canAuthorDesign`,
 * `canAuthorBuild`), not a role — house rule 1.
 */
async function assertAssignable(userId: string | null | undefined, capability: Capability): Promise<void> {
  if (userId == null) return;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new GraphQLError('No such user.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (!can(user, capability)) {
    throw new GraphQLError('That person cannot do this job.', {
      extensions: { code: 'ASSIGNEE_LACKS_CAPABILITY' },
    });
  }
  if (user.state !== 'ACTIVE') {
    throw new GraphQLError('That account is not active.', { extensions: { code: 'ASSIGNEE_INACTIVE' } });
  }
}
export const contractAdminMutations = {
  /**
   * Creates a contract — and, unless it is handed a project, the project
   * alongside it (build plan D1 / L1).
   *
   * **`projectId` (journeys build plan J2)** names the project the contract
   * attaches to, and the project's state decides what that means:
   *
   * - `REQUESTED` — **conversion.** The customer's request becomes a project
   *   in the same transaction that creates its contract: status → `ACTIVE`,
   *   the project takes the titles sales typed (the request's own were
   *   placeholders), and the completeness checklist is seeded, as for any new
   *   project. The request thread stays on the project, read-only.
   * - `ACTIVE` — **a second contract** on an existing project (the founder's
   *   Q5, lifecycle plan §0.3.5: "a feature for an existing website"). The
   *   registry and its checklist already exist and are not touched.
   * - `ARCHIVED` — refused, `PROJECT_ARCHIVED`.
   *
   * And it must be the same customer (`PROJECT_CUSTOMER_MISMATCH`): sales
   * picks the customer in the form, and a contract on customer A naming
   * customer B's project would put B's registry, demos and thread in front of
   * A. The project row is locked `FOR UPDATE` for the transaction, so two
   * sales users converting the same request cannot both see it `REQUESTED`.
   *
   * Without a `projectId` the behaviour is exactly what it was: a project of
   * the contract's own, its completeness checklist (spec §3) seeded all
   * DECLINED so a hole like Nahal's missing dashboard coverage is visible
   * from day one rather than discovered in review.
   */
  createContract: async (
    _p: unknown,
    args: {
      input: {
        customerId: string;
        ref: string;
        titleFa: string;
        titleEn: string;
        amount?: string;
        /** Journeys build plan S1 — sales picks both at creation (Q-S4). */
        designerId?: string | null;
        developerId?: string | null;
        /** Journeys build plan J2 — attach to this project (convert a request, or add a second contract). */
        projectId?: string | null;
      };
    },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.author');
    const { input } = args;
    // Before anything is written: a refused assignee must not leave a
    // project behind with no contract on it.
    await assertAssignable(input.designerId, 'design.author');
    await assertAssignable(input.developerId, 'builds.author');

    const contractId = await prisma.$transaction(async (tx) => {
      let projectId: string;
      // Whether this contract is the one that seeds the completeness
      // checklist: it is, for a project made here and for a converted
      // request; it is not for a second contract, whose project already has
      // its registry (seeding again would double every key).
      let seedsChecklist = true;

      if (input.projectId) {
        // Locked for the transaction — see the header. Raw, because Prisma
        // has no `FOR UPDATE`; the same idiom T1's `setTemplateScope` uses.
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({ where: { id: input.projectId } });
        if (!project) {
          throw new GraphQLError('No such project.', { extensions: { code: 'NOT_FOUND' } });
        }
        if (project.customerId !== input.customerId) {
          throw new GraphQLError('That project belongs to a different customer.', {
            extensions: { code: 'PROJECT_CUSTOMER_MISMATCH' },
          });
        }
        if (project.status === 'ARCHIVED') {
          throw new GraphQLError('That project is archived.', { extensions: { code: 'PROJECT_ARCHIVED' } });
        }
        projectId = project.id;
        if (project.status === 'REQUESTED') {
          await tx.project.update({
            where: { id: project.id },
            data: { status: 'ACTIVE', titleFa: input.titleFa, titleEn: input.titleEn },
          });
        } else {
          seedsChecklist = false;
        }
      } else {
        const project = await tx.project.create({
          data: { customerId: input.customerId, titleFa: input.titleFa, titleEn: input.titleEn },
        });
        projectId = project.id;
      }

      const contract = await tx.contract.create({
        data: {
          customerId: input.customerId,
          projectId,
          ref: input.ref,
          titleFa: input.titleFa,
          titleEn: input.titleEn,
          amount: input.amount ? BigInt(input.amount) : null,
          designerId: input.designerId ?? null,
          developerId: input.developerId ?? null,
          // Stated here, not left to the column's default — see the constant.
          sequence: SEQUENCE_FOR_NEW_CONTRACTS,
        },
      });
      if (seedsChecklist) {
        // Written after the contract, not with the project, so each row names
        // its agreement from birth (T1's `ScopeItem.contractId`) — rather than
        // a follow-up `updateMany where contractId is null`, which on a
        // project that already held a proposed item would claim that too.
        await tx.scopeItem.createMany({
          data: CHECKLIST.map(([key, labelFa, labelEn], position) => ({
            projectId,
            key,
            labelFa,
            labelEn,
            position,
            // Always EXTRA: the checklist is the one thing this creates.
            kind: 'EXTRA' as const,
            status: 'DECLINED' as const,
            contractId: contract.id,
          })),
        });
      }
      await log(contract.id, admin.id, 'CREATED', null, tx);
      return contract.id;
    },
    // Up from Prisma's five seconds: this waits on the project's row lock when
    // two people convert one request at once, and the checklist is a dozen
    // inserts — neither is slow, but a busy database should make it late, not
    // make it fail half-way.
    { timeout: 20_000 },
    );
    return reload(contractId);
  },

  /**
   * Fills an empty contract with the standard fifteen article titles and six
   * scope items, so a contract created through the workspace does not force
   * Root through fifteen blank forms before there is anything to publish.
   *
   * Refuses rather than merging if either already has rows: a merge would
   * have to decide what to do about a number that already exists, and every
   * answer to that is a small surprise (V2.md §3.9).
   *
   * Only the SCOPE template's own items count against the "already has scope
   * items" guard — the completeness checklist seeded at project creation
   * (`checklist.*` keys, kind `EXTRA`) is a different mechanism and would
   * otherwise make this refuse on every contract, always (L1).
   *
   * **Journeys build plan J5.** Three things changed here, all in this one
   * function because they are one rewrite:
   *
   * - **The articles' placeholders are rendered** (D-5): `{{client}}` and
   *   `{{provider}}` become the customer's name and Root's, per language, so a
   *   contract stops starting by naming somebody else's client. What is stored
   *   — and frozen into every snapshot — is the finished text
   *   (`lib/templates.ts`, `renderArticleBody`).
   * - **The scope guard is per contract** (J2's owed item, which this function
   *   was in the way of): it counts *this contract's* pages and features, not the
   *   project's, so a second contract on a project can be started from the
   *   template; a key the project already has takes the next free suffix
   *   (`seedRows`), and the first contract's rows are untouched.
   * - **On the new road it writes the articles only.** That road's scope comes
   *   from the brief's template type (`applyScopeTemplate`, step 2a), and this
   *   fixed six-item list would seed a second, unrelated scope beside it.
   *
   * Under the contract's lock and `assertStepOpenOn(DRAFT)`: it writes the draft.
   */
  applyContractTemplate: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId }, include: { customer: true } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    const seedsScope = contract.sequence === 'DESIGN_FIRST';
    const partiesFa = partiesFor(contract.customer, 'fa');
    const partiesEn = partiesFor(contract.customer, 'en');

    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      // The registry is the project's, and its keys unique per project — the
      // project is locked while this contract's scope is chosen a suffix.
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${contract.projectId} FOR UPDATE`;
      await assertStepOpenOn(contract.id, 'DRAFT', null, tx);

      const registry = await tx.scopeItem.findMany({
        where: { projectId: contract.projectId },
        select: { key: true, kind: true, contractId: true },
      });
      const articleCount = await tx.article.count({ where: { contractId: args.contractId } });
      if (articleCount > 0 || (seedsScope && scopeSeeded(registry, contract.id))) {
        throw new GraphQLError('This contract already has articles or scope items.', {
          extensions: { code: 'TEMPLATE_NOT_EMPTY' },
        });
      }

      await tx.article.createMany({
        data: ARTICLES.map(([number, titleFa, titleEn, bodyFa, bodyEn]) => ({
          contractId: args.contractId,
          number,
          titleFa,
          titleEn,
          bodyFa: renderArticleBody(bodyFa, partiesFa),
          bodyEn: renderArticleBody(bodyEn, partiesEn),
          // The template's money articles (PD-14, J4): Fees, Payment Schedule.
          sensitive: isTemplateSensitiveArticle(number, titleEn),
        })),
      });
      if (seedsScope) {
        const rows = seedRows(
          SCOPE.map(([key, labelFa, labelEn]) => ({ key, labelFa, labelEn })),
          registry.map((r) => r.key),
          registry.length,
        );
        await tx.scopeItem.createMany({
          data: rows.map((r) => ({
            projectId: contract.projectId,
            key: r.key,
            labelFa: r.labelFa,
            labelEn: r.labelEn,
            position: r.position,
            kind: r.kind,
            contractId: args.contractId,
            // Root typing this into the contract via the template is the
            // agreement act — see addScopeItem's own comment.
            status: 'AGREED' as const,
          })),
        });
      }
    });

    return reload(args.contractId);
  },

  setArticle: async (
    _p: unknown,
    args: {
      contractId: string;
      number: number;
      titleFa: string;
      titleEn: string;
      bodyFa?: string;
      bodyEn?: string;
      /** Journeys build plan J4, PD-14: this article's prose is about money.
       *  Omitted, a *new* article takes the template's rule (Fees, Payment
       *  Schedule) and an existing one keeps its flag. */
      sensitive?: boolean | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const { contractId, number, sensitive, ...rest } = args;
    await prisma.article.upsert({
      where: { contractId_number: { contractId, number } },
      create: { contractId, number, ...rest, sensitive: sensitive ?? isTemplateSensitiveArticle(number, args.titleEn) },
      update: { ...rest, ...(sensitive == null ? {} : { sensitive }) },
    });
    return reload(contractId);
  },

  /**
   * The title and fee half of the draft. `ref` is deliberately not among the
   * arguments — it is frozen into every snapshot once published, and editing
   * it afterward would make the printed page disagree with the live contract
   * while the hash still verified (T1).
   */
  updateContractDraft: async (
    _p: unknown,
    args: { contractId: string; titleFa: string; titleEn: string; amount?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    await prisma.contract.update({
      where: { id: args.contractId },
      data: {
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        amount: args.amount ? BigInt(args.amount) : null,
      },
    });
    return reload(args.contractId);
  },

  /**
   * Legal even when this article number is inside the current published
   * snapshot (T5): the snapshot is frozen JSON and does not move. The
   * customer keeps reading the published text; the *next* publish is what
   * produces a contract without this article.
   */
  deleteArticle: async (
    _p: unknown,
    args: { contractId: string; number: number },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    await prisma.article.deleteMany({
      where: { contractId: args.contractId, number: args.number },
    });
    return reload(args.contractId);
  },

  /**
   * Freezes the current draft — title, fee, articles and the registry's
   * agreed scope set (build plan L1) — as the next contract revision and
   * makes it the live one.
   *
   * Pre-signature this simply replaces: the prior revision is superseded and
   * the customer re-approves. Once a revision is *signed* it is terminal, and
   * the way forward is an amendment, not a v2 — re-signing a replacement
   * would quietly retire the original instrument and muddy which text is in
   * force from when.
   *
   * ## The new road (journeys build plan J6)
   *
   * On an `AGREEMENT_FIRST` contract this is step 2b's hand-over — the moment
   * the customer first reads the draft, or reads a new version of it — and it
   * has two more gates, checked in this order after `CONTRACT_SIGNED` and
   * `STEP_LOCKED`:
   *
   * 1. **`SCOPE_UNCONFIRMED`** — the scope step is not done: the contract has no
   *   scope of its own yet, or a customer's proposal is still waiting for Root
   *   (`scopeStepDone`, the same function that marks the step done in the
   *   wizard, so the two cannot disagree). It comes first because it names what
   *   is on *this* step's own panel: the queue sales is looking at when they
   *   press the button.
   * 2. **`BRIEF_INCOMPLETE`** — step 1 lacks something (`briefCompleteness`,
   *   J4). The refusal carries the missing codes in `extensions.missing`, so
   *   sales sees the whole list at once rather than one refusal per press. This
   *   is the plan's own order; it is also why a brief with no row at all, which
   *   `publishContract` already refuses (`BRIEF_MISSING`), never gets here.
   *
   * **Everything is read and checked under the contract's row lock**, the
   * same one the customer's proposals, sales' decisions and step 1's writes
   * take: a proposal made a moment before this press is either in the answer or
   * refused by it, and the snapshot published is of the registry as it was
   * when the gates passed. The legacy road has neither gate, and its behaviour
   * is unchanged.
   *
   * The customer is told (`DRAFT_PUBLISHED`) — on the new road, and only once
   * the contract has been handed over: before that they cannot open it, and a
   * link that answers "no such contract" is worse than no message.
   */
  publishContractRevision: async (
    _p: unknown,
    args: { contractId: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.author');

    // One transaction (defect D2): create/supersede/repoint/log/nudge either
    // all happen or none do. Before this, the revision was created outside
    // the transaction — a failure downstream could leave a published revision
    // superseding nothing and pointed at by nothing. Since J6 the reads that
    // decide *whether* to publish are inside it too, behind the contract's lock.
    let published: { version: number; contract: FullContract };
    try {
      published = await prisma.$transaction(async (tx) => {
        await lockContract(tx, args.contractId);
        const contract = await tx.contract.findUnique({ where: { id: args.contractId }, include: contractInclude });
        if (!contract) {
          throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
        }

        const current = contract.currentContractRevision;
        if (current?.signature) {
          throw new GraphQLError(
            'This contract is signed. Issue an amendment rather than a new revision.',
            { extensions: { code: 'CONTRACT_SIGNED' } },
          );
        }
        // Nothing can lock DRAFT until J7's agreement approval exists, but the
        // call lands now so J7 changes nothing here (the legacy road is never
        // locked: `assertStepOpen` ignores approvals on it).
        await assertStepOpenOn(contract.id, 'DRAFT', null, tx);

        if (contract.sequence === 'AGREEMENT_FIRST') {
          const proposals = await tx.scopeProposal.findMany({
            where: { contractId: contract.id },
            select: { decidedAt: true },
          });
          if (!scopeStepDone({ items: contract.project.scopeItems, proposals, contractId: contract.id })) {
            throw new GraphQLError(
              'The scope is not confirmed: it has nothing in it yet, or a proposal is still waiting for a decision.',
              {
                extensions: {
                  code: 'SCOPE_UNCONFIRMED',
                  undecided: proposals.filter((p) => p.decidedAt === null).length,
                  seeded: scopeSeeded(contract.project.scopeItems, contract.id),
                },
              },
            );
          }
          const missing = await briefIncompleteOn(contract);
          if (missing.length > 0) {
            throw new GraphQLError('Step 1 is not complete yet.', {
              extensions: { code: 'BRIEF_INCOMPLETE', missing: missing.map((m) => m.code) },
            });
          }
        }

        // Appendix 1 as a view of the registry (L1) — the agreed-or-beyond set,
        // in registry order, exactly as agreedScopeSnapshot defines "agreed".
        const scopeItems = agreedScopeSnapshot(contract.project.scopeItems);
        const { snapshot, hash, dirty } = draftState(contract, contract.articles, current, scopeItems);
        if (!dirty) {
          throw new GraphQLError('Nothing has changed since the last revision.', {
            extensions: { code: 'NO_CHANGES' },
          });
        }

        const latest = await tx.contractRevision.findFirst({
          where: { contractId: contract.id },
          orderBy: { version: 'desc' },
        });
        const now = new Date();
        const revision = await tx.contractRevision.create({
          data: {
            contractId: contract.id,
            version: (latest?.version ?? 0) + 1,
            snapshot,
            contentHash: hash,
            publishedAt: now,
          },
        });
        if (current) {
          await tx.contractRevision.update({
            where: { id: current.id },
            data: { supersededAt: now },
          });
        }
        await tx.contract.update({
          where: { id: contract.id },
          data: { currentContractRevisionId: revision.id },
        });
        await log(contract.id, admin.id, 'CONTRACT_REVISED', `v${revision.version}`, tx);
        await nudgeStatus(contract, 'WAITING_ON_CUSTOMER', tx);
        return { version: revision.version, contract };
      });
    } catch (err) {
      throw asConcurrentPublish(err);
    }

    const { contract, version } = published;
    if (contract.sequence === 'AGREEMENT_FIRST' && contract.publishedAt) {
      const { customer, project } = contract;
      // Best-effort, like every notification: `notify` never throws, and the
      // revision is already published.
      await notify(customer, {
        kind: 'DRAFT_PUBLISHED',
        params: {
          customerName: customer.name,
          projectTitleFa: project.titleFa,
          projectTitleEn: project.titleEn,
          version,
          portalUrl: `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contract.id}`,
        },
      });
    }

    return reload(args.contractId);
  },

  /**
   * The contract's planned start and end (journeys build plan J6, Q12) —
   * calendar days (PD-19), proposed in the draft and shown to the customer with
   * it; J7 freezes them at approval and refuses an approval without them
   * (`DATES_INCOMPLETE`). Nothing wrote these columns before this: J3 added
   * them and the status area reads them, but no stage said who sets them, so
   * the draft step's "planned dates" would have been a label over nothing.
   * A replace, not a patch — an omitted day is cleared, as `setBrief`'s fields
   * are. `contracts.author`, under the contract's lock and `assertStepOpenOn(
   * DRAFT)`. Refusals: `INVALID_DATE`, `DATES_OUT_OF_ORDER`, `STEP_NOT_ON_ROAD`
   * (the legacy road has no such dates), `STEP_LOCKED`.
   */
  setPlannedDates: async (
    _p: unknown,
    args: { contractId: string; plannedStartAt?: string | null; plannedEndAt?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    if (!stepOnRoad(contract.sequence, 'DRAFT')) {
      throw new GraphQLError('This contract has no draft step.', { extensions: { code: 'STEP_NOT_ON_ROAD' } });
    }
    const start = args.plannedStartAt ? parseCalendarDay(args.plannedStartAt) : null;
    const end = args.plannedEndAt ? parseCalendarDay(args.plannedEndAt) : null;
    if ((args.plannedStartAt && !start) || (args.plannedEndAt && !end)) {
      throw new GraphQLError('That is not a date.', { extensions: { code: 'INVALID_DATE' } });
    }
    if (start && end && start.getTime() > end.getTime()) {
      throw new GraphQLError('The end cannot be before the start.', { extensions: { code: 'DATES_OUT_OF_ORDER' } });
    }
    await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      await assertStepOpenOn(contract.id, 'DRAFT', null, tx);
      await tx.contract.update({ where: { id: contract.id }, data: { plannedStartAt: start, plannedEndAt: end } });
    });
    return reload(contract.id);
  },

  /**
   * Hands the contract to the customer — the first time they can see it.
   *
   * **On the new road this is handing over step 1** (journeys build plan J4): it
   * requires a brief row (`BRIEF_MISSING`) — the kind of site and its template
   * type are what the customer's first screen is about — and it tells the
   * customer (`BRIEF_SHARED`, email and SMS). The rest of the brief may still be
   * incomplete: the portal says so ("Root is completing this") instead of
   * hiding the step, so a half-finished brief is a reason to be honest, not a
   * reason to wait. A legacy (`DESIGN_FIRST`) contract publishes exactly as it
   * always did, silently.
   *
   * Idempotent: publishing what is already published changes nothing and tells
   * no one, so a double click cannot send the customer two messages.
   */
  publishContract: async (_p: unknown, args: { contractId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({
      where: { id: args.contractId },
      include: { customer: true, project: true, brief: { select: { id: true } } },
    });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (contract.publishedAt) return reload(contract.id);

    const newRoad = contract.sequence === 'AGREEMENT_FIRST';
    if (newRoad && !contract.brief) {
      throw new GraphQLError('Fill in the requirements — at least the kind of site and its type — before handing this over.', {
        extensions: { code: 'BRIEF_MISSING' },
      });
    }

    await prisma.contract.update({
      where: { id: contract.id },
      data: { publishedAt: new Date(), status: 'WAITING_ON_CUSTOMER' },
    });
    await log(contract.id, admin.id, 'PUBLISHED');

    if (newRoad) {
      // Best-effort, like every notification: `notify` never throws, and the
      // hand-over has already happened.
      const { customer, project } = contract;
      await notify(customer, {
        kind: 'BRIEF_SHARED',
        params: {
          customerName: customer.name,
          projectTitleFa: project.titleFa,
          projectTitleEn: project.titleEn,
          portalUrl: `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contract.id}`,
        },
      });
    }
    return reload(contract.id);
  },

  setContractStatus: async (
    _p: unknown,
    args: { contractId: string; status: ContractStatus },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    // Setting a contract to the status it already has must be a no-op — not
    // an equality check nudgeStatus already gets for free, but one this
    // resolver has to make itself, or the Needs-Root queue could be cleared
    // by touching a dropdown (V4 defect D7).
    if (contract.status === args.status) return reload(args.contractId);

    // Permissive on purpose: from almost any status to almost any other,
    // with a manual override always available.
    await prisma.contract.update({
      where: { id: args.contractId },
      data: { status: args.status, statusChangedAt: new Date() },
    });
    await log(args.contractId, admin.id, 'STATUS_CHANGED', args.status);
    return reload(args.contractId);
  },

  /**
   * Journeys build plan S1: sales changes who designs and who develops a
   * contract (Q-S4). Either argument may be omitted (left as is) or null
   * (unassigned). Not logged: a `ChangeAction` costs five files (house rule
   * 10) and the journeys plan derives history from dated rows instead
   * (PD-17) — J3's timeline is where a reassignment will show, if it needs to.
   */
  assignContract: async (
    _p: unknown,
    args: { contractId: string; designerId?: string | null; developerId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.author');
    const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    await assertAssignable(args.designerId, 'design.author');
    await assertAssignable(args.developerId, 'builds.author');
    await prisma.contract.update({
      where: { id: contract.id },
      data: { designerId: args.designerId, developerId: args.developerId },
    });
    return reload(contract.id);
  },
};
