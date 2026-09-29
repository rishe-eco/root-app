import { GraphQLError } from 'graphql';
import type { Prisma, Role, ToolKey, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import {
  SUPERUSER_ROLE,
  can,
  hasCustomerRole,
  hasStaffRole,
  isStaffRole,
  isSuperuser,
  requiresSecondFactor,
} from '../../lib/capabilities.js';
import { contractVisibleTo, mayReadMoney } from '../../lib/visibility.js';
import { computeBillingReport, ensureDueEntriesFor } from '../../lib/billing.js';
import { normalizePhone } from '../../lib/phone.js';
import { resolveLocale } from '../../lib/mailTemplates.js';
import { notify } from '../../lib/notify.js';
import { newLinkToken } from '../../auth/tokens.js';
import { contractInclude } from './contracts.js';
import { ticketInclude } from './tickets.js';

/**
 * People (journeys build plan S3): the customer page, and the Users place's
 * first slice — every account, inviting staff, changing roles, disabling.
 *
 * Two capabilities, never merged: `customers.manage` (sales) looks after
 * customers and the tools they hold; `staff.manage` (ADMIN only) looks after
 * every account that holds a staff role. An account holding **both** kinds of
 * role is a staff account for this purpose — see `setUserState`.
 *
 * Nothing here reads a role name: `capabilities.ts` answers "is this a staff
 * account", "is this the superuser role" and "does this role need a second
 * factor", per house rule 1.
 */

const refuse = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);
const forbidden = () => refuse('FORBIDDEN', 'You do not have access to that.');

type Tx = Prisma.TransactionClient;

/**
 * Locks every active superuser row for the rest of the transaction, so that
 * two administrators each removing the *other's* ADMIN (or disabling each
 * other) at the same moment are serialized: the second waits, re-reads the
 * first's committed change, and finds itself the last one standing. Without
 * the lock both would read "another admin exists", both would pass, and the
 * system would be left with none — the state `LAST_SUPERUSER` exists to make
 * unreachable, and the one only the CLI can then repair.
 */
async function lockActiveSuperusers(tx: Tx): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "User"
    WHERE ${SUPERUSER_ROLE}::"Role" = ANY("roles") AND "state" = 'ACTIVE'
    FOR UPDATE
  `;
}

/** Would `target` be the last active superuser if it stopped being one (or
 *  stopped being active)? Must run after `lockActiveSuperusers`. */
async function isLastActiveSuperuser(tx: Tx, target: Pick<User, 'id' | 'roles' | 'state'>): Promise<boolean> {
  if (!isSuperuser(target) || target.state !== 'ACTIVE') return false;
  const others = await tx.user.count({
    where: { roles: { has: SUPERUSER_ROLE }, state: 'ACTIVE', id: { not: target.id } },
  });
  return others === 0;
}

/** The roles CHECK (`User_roles_non_empty`) as the refusal a person can act
 *  on. Checked structurally, like `asSlugTaken` in templates.ts. */
function asLastRole(err: unknown): unknown {
  const text = err instanceof Error ? err.message : '';
  if (text.includes('User_roles_non_empty')) {
    return refuse('LAST_ROLE', 'An account must keep at least one role.');
  }
  return err;
}

const isUniqueViolation = (err: unknown) =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';

/**
 * One customer, everything sales needs on a single page. Returned as a
 * profile rather than a `User` with more fields hung off it: each part has
 * its own visibility (contracts by `contractVisibleTo`, tickets by
 * `tickets.answer`, invoices by `mayReadMoney`), and they belong to *this
 * page*, not to every place a `User` is shown.
 *
 * Null for an id that is not a customer — the same answer as for an id that
 * does not exist, so this page is not an oracle for which staff ids exist.
 */
export async function loadCustomerProfile(id: string, viewer: User) {
  const customer = await prisma.user.findUnique({ where: { id } });
  if (!customer || !hasCustomerRole(customer)) return null;

  const [grants, contracts, tickets] = await Promise.all([
    prisma.toolGrant.findMany({
      where: { customerId: customer.id, revokedAt: null },
      include: { grantedBy: true },
      orderBy: { grantedAt: 'asc' },
    }),
    prisma.contract.findMany({
      where: { customerId: customer.id },
      include: contractInclude,
      orderBy: { createdAt: 'desc' },
    }),
    can(viewer, 'tickets.answer')
      ? prisma.ticket.findMany({
          where: { customerId: customer.id },
          include: ticketInclude,
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),
  ]);

  // Money, gated by the one rule that decides it (S1's `mayReadMoney`): the
  // page is `customers.manage`, and that alone is not `money.read`.
  let invoices: ReturnType<typeof computeBillingReport> | null = null;
  if (mayReadMoney(viewer, { customerId: customer.id })) {
    await ensureDueEntriesFor(prisma, { customerId: customer.id });
    invoices = computeBillingReport(await prisma.billingEntry.findMany({ where: { customerId: customer.id } }));
  }

  return {
    user: customer,
    grants,
    contracts: contracts.filter((c) => contractVisibleTo(viewer, c)),
    tickets,
    invoices,
  };
}

export const peopleQueries = {
  /**
   * The tools the caller may use, so the portal's rail shows an item only for
   * a tool that exists for them. A customer's list is their active grants;
   * a name that is not on it is not a tool they are refused — it is one they
   * do not have, and the queries behind it answer `NOT_FOUND` to match.
   */
  myTools: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    const grants = await prisma.toolGrant.findMany({
      where: { customerId: user.id, revokedAt: null },
      select: { tool: true },
      orderBy: { grantedAt: 'asc' },
    });
    return grants.map((g) => g.tool);
  },

  customer: async (_p: unknown, args: { id: string }, ctx: Context) => {
    const viewer = requireCapability(ctx, 'customers.manage');
    return loadCustomerProfile(args.id, viewer);
  },

  /** The Users place's list (PD-12): every account, customers included, with
   *  roles and state. `staff.manage`, ADMIN only. */
  allUsers: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'staff.manage');
    return prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  },
};

export const peopleMutations = {
  /**
   * Disable or restore an account.
   *
   * **Who may:** `customers.manage` for a customer, `staff.manage` for anyone
   * holding a staff role — and a mixed account is a staff account. Roles are a
   * set, so an account can be both, and letting sales disable it would let
   * sales switch off an administrator by first giving them the customer role
   * (or by finding one who has it). The stricter rule wins, the way `can`'s
   * union widens: holding more never lowers the bar to act on you.
   *
   * **Disabling revokes every outstanding token**, not only the invite and
   * login-code ones the plan names. A disabled account's cookie is already
   * dead (`buildContext`), but a password-reset link is a way back in that
   * needs no cookie — `resetPassword` re-activates the account — and a
   * pending invite is another. All are revoked in the same transaction as the
   * state change, so there is no moment when the account is disabled and a
   * live link still opens it.
   */
  setUserState: async (_p: unknown, args: { userId: string; state: User['state'] }, ctx: Context) => {
    const actor = requireUser(ctx);
    if (!can(actor, 'customers.manage') && !can(actor, 'staff.manage')) throw forbidden();
    if (args.state !== 'ACTIVE' && args.state !== 'DISABLED') {
      throw refuse('INVALID_STATE', 'An account can only be disabled or restored.');
    }

    const target = await prisma.user.findUnique({ where: { id: args.userId } });
    if (!target) throw notFound('account');
    if (!can(actor, hasStaffRole(target) ? 'staff.manage' : 'customers.manage')) throw forbidden();

    if (args.state === 'DISABLED') {
      if (target.id === actor.id) throw refuse('CANNOT_DISABLE_SELF', 'You cannot disable your own account.');

      return prisma.$transaction(async (tx) => {
        await lockActiveSuperusers(tx);
        // Re-read under the lock: the state that counts is the committed one.
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: target.id } });
        if (await isLastActiveSuperuser(tx, fresh)) {
          throw refuse('LAST_SUPERUSER', 'That is the last active administrator.');
        }
        await tx.authToken.updateMany({
          where: { userId: target.id, usedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return tx.user.update({ where: { id: target.id }, data: { state: 'DISABLED' } });
      });
    }

    // Restoring puts the account back where it was: a person who never
    // accepted their invite has no password to be "active" with, and their
    // (revoked) invite has to be re-issued from the desk.
    return prisma.user.update({
      where: { id: target.id },
      data: { state: target.passwordHash ? 'ACTIVE' : 'INVITED' },
    });
  },

  /**
   * Give a customer a tool. Idempotent: granting what is already granted
   * returns the profile unchanged, and a double click cannot leave two
   * active rows (`ToolGrant_one_active_per_tool` is the backstop).
   */
  grantTool: async (_p: unknown, args: { customerId: string; tool: ToolKey }, ctx: Context) => {
    const actor = requireCapability(ctx, 'customers.manage');
    const customer = await prisma.user.findUnique({ where: { id: args.customerId } });
    if (!customer || !hasCustomerRole(customer)) throw notFound('customer');

    const active = await prisma.toolGrant.findFirst({
      where: { customerId: customer.id, tool: args.tool, revokedAt: null },
    });
    if (!active) {
      try {
        await prisma.toolGrant.create({
          data: { customerId: customer.id, tool: args.tool, grantedById: actor.id },
        });
      } catch (err) {
        // Lost a race with an identical grant: the outcome asked for exists.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return loadCustomerProfile(customer.id, actor);
  },

  /** Take a tool back. Idempotent; the row stays as history. */
  revokeTool: async (_p: unknown, args: { customerId: string; tool: ToolKey }, ctx: Context) => {
    const actor = requireCapability(ctx, 'customers.manage');
    const customer = await prisma.user.findUnique({ where: { id: args.customerId } });
    if (!customer || !hasCustomerRole(customer)) throw notFound('customer');

    await prisma.toolGrant.updateMany({
      where: { customerId: customer.id, tool: args.tool, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actor.id },
    });
    return loadCustomerProfile(customer.id, actor);
  },

  /**
   * Invite a member of staff, without a CLI. `roles` are staff roles only —
   * customers come in through `inviteCustomer`, and mixing the two is a
   * decision for `setUserRoles` on an account that exists.
   *
   * **A phone is required when a role needs the second factor** (PD-20): the
   * factor is sent to it, and an account that cannot receive it cannot sign
   * in. A CONTRIBUTOR or REVIEWER needs no factor, so needs only one
   * identifier of either kind. As with customers, the desk always shows the
   * link (PD-18) — the SMS is a courtesy that may have no provider behind it.
   *
   * An existing account is never repurposed: an ACTIVE one is `ALREADY_ACTIVE`,
   * a DISABLED one must be restored first, and one holding the customer role
   * is a customer whose roles `setUserRoles` should change on purpose. Only a
   * still-pending staff invite is reissued (with the roles asked for now).
   */
  inviteStaff: async (
    _p: unknown,
    args: { name: string; roles: Role[]; phone?: string | null; email?: string | null; locale?: string | null },
    ctx: Context,
  ) => {
    const actor = requireCapability(ctx, 'staff.manage');

    const roles = [...new Set(args.roles)];
    if (roles.length === 0) throw refuse('ROLES_REQUIRED', 'Choose at least one role.');
    if (!roles.every(isStaffRole)) throw refuse('INVALID_ROLE', 'Staff can only be invited to staff roles.');

    const rawPhone = args.phone?.trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) throw refuse('PHONE_INVALID', 'That does not look like a phone number.');
    const email = args.email?.trim().toLowerCase() || null;
    if (!phone && !email) throw refuse('IDENTIFIER_REQUIRED', 'A phone number or an email is required.');
    if (requiresSecondFactor({ roles }) && !phone) {
      throw refuse('PHONE_REQUIRED_FOR_STAFF', 'These roles sign in with a code sent to a phone; a phone number is required.');
    }

    const name = args.name.trim();
    if (!name) throw refuse('NAME_REQUIRED', 'A name is required.');
    const locale = resolveLocale(args.locale ?? actor.locale);

    const matches = await prisma.user.findMany({
      where: { OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])] },
    });
    // A phone belonging to one account and an email to another: inviting would
    // merge two people, or fail on the second unique index. Neither is ours to pick.
    if (matches.length > 1) throw refuse('IDENTIFIER_CONFLICT', 'That phone and email belong to different accounts.');
    const existing = matches[0];
    if (existing) {
      if (existing.state === 'ACTIVE') throw refuse('ALREADY_ACTIVE', 'That account is already active.');
      if (existing.state === 'DISABLED') throw refuse('ACCOUNT_DISABLED', 'That account is disabled; restore it first.');
      if (hasCustomerRole(existing)) {
        throw refuse('ACCOUNT_EXISTS', 'That is a customer account; change its roles instead.');
      }
    }

    let user: User;
    try {
      user = existing
        ? await prisma.user.update({
            where: { id: existing.id },
            data: { name, roles, locale, phone: phone ?? existing.phone, email: email ?? existing.email },
          })
        : await prisma.user.create({ data: { name, roles, locale, phone, email } });
    } catch (err) {
      if (isUniqueViolation(err)) throw refuse('IDENTIFIER_CONFLICT', 'That phone or email is already in use.');
      throw err;
    }

    const { raw, hash } = newLinkToken();
    const expiresAt = new Date(Date.now() + env.INVITE_DAYS * 24 * 60 * 60 * 1000);
    await prisma.authToken.create({
      data: { userId: user.id, purpose: 'INVITE', tokenHash: hash, expiresAt },
    });

    const inviteUrl = `${env.APP_ORIGIN}/${user.locale}/portal/invite/${raw}`;
    await notify(user, { kind: 'INVITE_STAFF', params: { name: user.name, inviteUrl } });
    return { userId: user.id, email: user.email, inviteUrl, expiresAt };
  },

  /**
   * Replace an account's role set. The new set applies from the account's
   * next request — capabilities are read off the row on every request, so
   * there is no session to refresh.
   *
   * Two things this must not do: leave the account with no role (`LAST_ROLE`
   * — the `User_roles_non_empty` CHECK would refuse it anyway, but as an
   * error no one can read), and leave the system with no active ADMIN
   * (`LAST_SUPERUSER`). A third, which the plan does not name: giving a
   * factor role to an account with no phone would lock it out at its next
   * sign-in, so that is refused too (`PHONE_REQUIRED_FOR_STAFF`) — but only
   * when this change is what introduces the requirement.
   */
  setUserRoles: async (_p: unknown, args: { userId: string; roles: Role[] }, ctx: Context) => {
    requireCapability(ctx, 'staff.manage');
    const roles = [...new Set(args.roles)];
    if (roles.length === 0) throw refuse('LAST_ROLE', 'An account must keep at least one role.');

    const target = await prisma.user.findUnique({ where: { id: args.userId } });
    if (!target) throw notFound('account');

    if (requiresSecondFactor({ roles }) && !requiresSecondFactor(target) && !target.phone) {
      throw refuse('PHONE_REQUIRED_FOR_STAFF', 'These roles sign in with a code sent to a phone; this account has none.');
    }

    try {
      return await prisma.$transaction(async (tx) => {
        await lockActiveSuperusers(tx);
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: target.id } });
        if (!roles.includes(SUPERUSER_ROLE) && (await isLastActiveSuperuser(tx, fresh))) {
          throw refuse('LAST_SUPERUSER', 'That is the last active administrator.');
        }
        return tx.user.update({ where: { id: target.id }, data: { roles } });
      });
    } catch (err) {
      throw asLastRole(err);
    }
  },
};
