import { can } from './access';
import type { ContractLink, User } from './queries';

/**
 * Small, React-free rules of the home screens (journeys build plan J12), so they
 * are unit-tested (`home.test.ts`) rather than read off a component.
 */

/**
 * The contract the dashboard's standing "open the current contract" opens: the
 * most recently touched one that is still being worked — not delivered (J11),
 * not done, not discarded. Null when there is none (a new customer, or one whose
 * every contract is closed), and the action is then simply absent.
 */
export function currentContract(contracts: readonly ContractLink[]): ContractLink | null {
  const live = contracts.filter((c) => c.deliveredAt === null && c.status !== 'DONE' && c.status !== 'DISCARDED');
  return live.reduce<ContractLink | null>((a, c) => (a === null || c.updatedAt > a.updatedAt ? c : a), null);
}

/**
 * Whether this staff member holds any job a *My work* list is made of — the
 * capabilities the API's `homeFor` reads (`lib/home.ts`, `mayWork`): sales'
 * (`contracts.author`, billing, tickets, approvals), design's and development's.
 * A contributor or a reviewer holds none, and their home says so instead of
 * claiming that nothing is waiting. UI-only, like `canAuthorDesign`: the list
 * itself is the API's.
 */
export function holdsContractWork(me: Pick<User, 'capabilities'> | null | undefined): boolean {
  return (
    can(me, 'contracts.author') ||
    can(me, 'design.author') ||
    can(me, 'builds.author') ||
    can(me, 'tickets.answer') ||
    can(me, 'billing.manage') ||
    can(me, 'feedback.approveAnswers')
  );
}
