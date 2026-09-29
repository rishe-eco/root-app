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
    | 'apiTokens';
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
  // Last, and it is not an ordering accident: this is the only section that
  // hands out a credential rather than editing content, so it sits at the end
  // of the nav where settings live rather than among the working surfaces.
  { key: 'apiTokens', capability: 'apiTokens.manage' },
];

export const visibleSections = (me: Pick<User, 'capabilities'> | null | undefined) =>
  DESK_SECTIONS.filter((s) => (s.capability === null ? isStaff(me) : can(me, s.capability)));
