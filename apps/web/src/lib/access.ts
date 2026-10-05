import type { User } from './queries';

export type Role = 'CUSTOMER' | 'ADMIN' | 'SALES' | 'DESIGNER' | 'DEVELOPER' | 'CONTRIBUTOR' | 'REVIEWER';

/**
 * Mirrors the API's `CAPABILITIES` (apps/api/src/lib/capabilities.ts) exactly
 * — same names, same order, `contracts.manage` gone rather than aliased
 * (journeys build plan S1). The UI branches on these and never on `roles` —
 * a person may hold several, so any `role === '…'` on this side is wrong in
 * the same way it was on the server, only quieter.
 *
 * A hand-kept mirror can drift silently (S1's own trap: "a stale mirror
 * hides a nav row"), so `access.test.ts` reads the API's file as text and
 * asserts this array is exactly its `CAPABILITIES` list. The union type
 * cannot be read at runtime, so it is derived from this array instead of
 * declared beside it, the same way the API derives `Capability` from its own
 * `CAPABILITIES` — one list, one type, nothing to fall out of step.
 */
export const CAPABILITIES = [
  'contracts.readAll',
  'contracts.readActive',
  'contracts.author',
  'money.read',
  'customers.manage',
  'tickets.answer',
  'billing.manage',
  'feedback.answer',
  'feedback.approveAnswers',
  'answers.direct.agreement',
  'answers.direct.design',
  'answers.direct.mockup',
  'answers.direct.demo',
  'design.author',
  'templates.types',
  'templates.scope',
  'builds.author',
  'dependencies.verifyGeneral',
  'dependencies.verifyTechnical',
  'assignments.override',
  'staff.manage',
  'library.write',
  'library.publish',
  'library.editTree',
  'review.participate',
  'review.admin',
  'apiTokens.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const can = (user: Pick<User, 'capabilities'> | null | undefined, cap: Capability) =>
  user?.capabilities.includes(cap) ?? false;

/**
 * Staff is "holds any capability at all", and that reads straight off the
 * model rather than being a special case: CUSTOMER maps to the empty
 * capability set (api/src/lib/capabilities.ts), so a customer has none and
 * everyone who is anything else has at least one.
 */
export const isStaff = (u: Pick<User, 'capabilities'> | null | undefined) =>
  (u?.capabilities.length ?? 0) > 0;

/** Where signing in puts you. Someone holding both lands on the desk and has a link to the portal. */
export const homeFor = (u: Pick<User, 'capabilities'> | null | undefined) =>
  isStaff(u) ? '/desk' : '/app';

/**
 * The two authoring edges (journeys build plan S1) — a capability *and* an
 * assignment, checked together, mirroring `canAuthorDesign`/`canAuthorBuild`
 * in the API's `lib/visibility.ts`. UI-only: this decides whether to render
 * authoring controls or a read-only tab, never a security boundary of its
 * own — the resolver re-checks the same two things on every mutation, so the
 * worst a wrong answer here costs is a button that gets refused.
 */
export function canAuthorDesign(
  me: Pick<User, 'id' | 'capabilities'> | null | undefined,
  contract: { designer?: { id: string } | null },
): boolean {
  if (!can(me, 'design.author')) return false;
  return contract.designer?.id === me?.id || can(me, 'assignments.override');
}

export function canAuthorBuild(
  me: Pick<User, 'id' | 'capabilities'> | null | undefined,
  contract: { developer?: { id: string } | null },
): boolean {
  if (!can(me, 'builds.author')) return false;
  return contract.developer?.id === me?.id || can(me, 'assignments.override');
}
