import { can, isStaff, type Capability } from '@/lib/access';
import type { User } from '@/lib/queries';

export type DeskSection = {
  key: 'overview' | 'contracts' | 'customers' | 'library' | 'review' | 'reviewAdmin' | 'apiTokens';
  /** null means "any staff capability", which is what Overview needs. */
  capability: Capability | null;
};

/**
 * One declarative list. The nav, the index redirect and each route's own
 * guard all read this — three behaviours that must agree, so they read one
 * source rather than three copies of the same test.
 */
export const DESK_SECTIONS: DeskSection[] = [
  { key: 'overview', capability: null },
  { key: 'contracts', capability: 'contracts.manage' },
  { key: 'customers', capability: 'customers.manage' },
  { key: 'library', capability: 'library.write' },
  { key: 'review', capability: 'review.participate' },
  { key: 'reviewAdmin', capability: 'review.admin' },
  // Last, and it is not an ordering accident: this is the only section that
  // hands out a credential rather than editing content, so it sits at the end
  // of the nav where settings live rather than among the working surfaces.
  { key: 'apiTokens', capability: 'apiTokens.manage' },
];

export const visibleSections = (me: Pick<User, 'capabilities'> | null | undefined) =>
  DESK_SECTIONS.filter((s) => (s.capability === null ? isStaff(me) : can(me, s.capability)));
