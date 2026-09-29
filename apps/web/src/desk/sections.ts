import { can, isStaff, type Capability } from '@/lib/access';
import type { User } from '@/lib/queries';

export type DeskSection = {
  key:
    | 'overview'
    | 'contracts'
    | 'customers'
    | 'library'
    | 'review'
    | 'reviewAdmin'
    | 'builds'
    | 'tickets'
    | 'billing'
    | 'services'
    | 'templates'
    | 'users'
    | 'apiTokens';
  /**
   * null means "any staff capability", which is what Overview needs. A list
   * means *any one of these* — the section has more than one half, each behind
   * its own capability, and holding either is a reason to see the room (T1's
   * Templates: a designer keeps the types, sales the scope).
   */
  capability: Capability | readonly Capability[] | null;
};

/**
 * One declarative list. The nav, the index redirect and each route's own
 * guard all read this — three behaviours that must agree, so they read one
 * source rather than three copies of the same test.
 */
export const DESK_SECTIONS: DeskSection[] = [
  { key: 'overview', capability: null },
  // Journeys build plan S1: the contracts list answers both `contracts.readAll`
  // (sales, the whole book) and `contracts.readActive` (design, development —
  // the contracts still being worked). Gating the nav row on the narrower of
  // the two is enough: everyone who holds `readAll` holds `readActive` too
  // (S1's grant table), and the list itself narrows further per viewer
  // (`allContracts`), so this row only ever decides whether the row exists.
  { key: 'contracts', capability: 'contracts.readActive' },
  { key: 'customers', capability: 'customers.manage' },
  { key: 'library', capability: 'library.write' },
  { key: 'review', capability: 'review.participate' },
  { key: 'reviewAdmin', capability: 'review.admin' },
  // Build plan D6, widened by S1: a DEVELOPER holds `builds.author` and reads
  // active contracts, but authors only the demos and builds they are assigned
  // to — this is their one working surface beyond the contracts list.
  { key: 'builds', capability: 'builds.author' },
  // Journeys build plan S1: the support desk moves off `contracts.manage`
  // onto its own verb — the one SALES holds for exactly this surface (the
  // plan's guard-mapping table).
  { key: 'tickets', capability: 'tickets.answer' },
  // Journeys build plan S1: billing is money, and `billing.manage` is the
  // capability the API's billing resolvers actually check now — a designer or
  // developer holding neither `billing.manage` nor `money.read` must not even
  // see this row exists.
  { key: 'billing', capability: 'billing.manage' },
  // Journeys build plan S1: the service panels are account administration
  // (importing a customer's product list), which is `customers.manage` on the
  // API side (`allServiceRuns`) — not `contracts.author`, since authoring a
  // contract is not the same act as running a customer's import.
  { key: 'services', capability: 'customers.manage' },
  // Journeys build plan T1: two halves, two capabilities, one room. The
  // designer keeps the types and sales keeps what each contains; each sees the
  // other's tab read-only, so the row shows for either. Each tab then decides
  // for itself what it lets its viewer edit (desk/Templates.tsx).
  { key: 'templates', capability: ['templates.types', 'templates.scope'] },
  // Journeys build plan S3 (PD-12): the Users place's first slice — every
  // account, inviting staff, changing roles, disabling. `staff.manage` is
  // ADMIN's alone, so this is the one row that only ADMIN's nav gains. Kept
  // beside the tokens row for the same reason: it hands out access rather
  // than editing content.
  { key: 'users', capability: 'staff.manage' },
  // Last, and it is not an ordering accident: this is the only section that
  // hands out a credential rather than editing content, so it sits at the end
  // of the nav where settings live rather than among the working surfaces.
  { key: 'apiTokens', capability: 'apiTokens.manage' },
];

/**
 * One test for "may this person see this section", read by the nav
 * (`visibleSections`) and by a section's own route guard — a row with a list of
 * capabilities must mean the same thing in both, or the nav offers a link the
 * screen bounces.
 */
export function canSeeSection(me: Pick<User, 'capabilities'> | null | undefined, section: DeskSection): boolean {
  const { capability } = section;
  if (capability === null) return isStaff(me);
  return (typeof capability === 'string' ? [capability] : capability).some((c) => can(me, c));
}

export const visibleSections = (me: Pick<User, 'capabilities'> | null | undefined) =>
  DESK_SECTIONS.filter((s) => canSeeSection(me, s));
