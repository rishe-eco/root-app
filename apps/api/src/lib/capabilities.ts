import type { Role, User } from '@prisma/client';

/**
 * Capabilities — the only thing the app is allowed to check before letting
 * someone use a surface (build plan F3).
 *
 * **Why this file exists at all.** Roles used to be one column and every guard
 * was `user.role === 'ADMIN'`. The moment a person can hold two roles that
 * check inverts silently: it does not become permissive, it becomes *wrong* in
 * whichever direction the equality happens to fall. So roles stop being tested
 * anywhere outside this file, and become an input to the table below.
 *
 * **Why a table rather than a ranking.** The Research Lab spec asks for "the
 * same editor minus publish and tree-editing". That is a per-action
 * distinction, and no ordering of roles — no level, no seniority integer, no
 * `>=` — can express it. A contributor is not a junior admin. It has to be a
 * set of verbs.
 *
 * **The mechanism this file is not.** A capability answers *may you use this
 * surface at all*. It never answers *which rows do you see* — that is an
 * ownership edge, and it lives in `loadForActor` and its like. The two are
 * kept apart deliberately: merging them is how a customer ends up needing a
 * capability to read their own contract, and how a reviewer ends up able to
 * read everyone's.
 */
export const CAPABILITIES = [
  /** The staff contract workspace: create, edit, publish, set status, and the
   *  design images that hang off a contract. Tracks V2–V4. */
  'contracts.manage',
  /** Invite, revoke, and list customers. Separate from the above so that an
   *  outside reviewer working a corpus is never also an account administrator. */
  'customers.manage',
  /** Write Library entries. The contributor's whole remit (track R1). */
  'library.write',
  /** Publish a Library entry to the public reader. Withheld from CONTRIBUTOR —
   *  this is one of the two verbs that sentence in the Lab spec removes. */
  'library.publish',
  /** Edit the concept tree (track R3). The other one. */
  'library.editTree',
  /** Read and comment inside the Review Room (track C1). */
  'review.participate',
  /** Administer the corpus itself — the allowlist, the snapshots (track C2). */
  'review.admin',
  /**
   * Issue and revoke personal access tokens for the API.
   *
   * Its own verb rather than a fold into `customers.manage`, because it is not
   * an account-administration act: a token is a *credential that acts as its
   * holder*, so granting this to a role hands that role every other capability
   * it holds, in a form that outlives a browser session. That makes it the one
   * capability whose blast radius is the rest of the table — which is exactly
   * why it should be visible as a separate row rather than arriving as a
   * side effect of some other grant.
   */
  'apiTokens.manage',
  /**
   * Build plan D6, 2026-09-20: declare a build, disposition open feedback
   * items, write change entries, move scope items to `in-demo` (L3b fills in
   * the surface this guards; L1 only adds the role and the section it needs
   * to not be blank).
   *
   * Its own row rather than a widening of `contracts.manage`, on purpose: the
   * person who authors a build is not thereby an account administrator or a
   * contract author. They never need the contract text, the fee, the
   * customer list, or `apiTokens.manage` — the one capability whose blast
   * radius is everything else a role holds — to do this job, so none of those
   * are reachable from here. Same reasoning `REVIEWER` was narrowed to
   * `review.participate` and nothing else.
   */
  'builds.author',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * What each role grants on its own. A user's capabilities are the **union**
 * across their set, so this table only ever has to describe one role at a time
 * — which is the point of holding roles as a set rather than enumerating the
 * combinations.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  /**
   * Empty, and that is not a demotion. A customer's rights are entirely
   * object-scoped — their own contract, once published — and that edge already
   * exists in `loadForActor`. There is no staff surface a customer should be
   * admitted to, so there is no capability to grant.
   */
  CUSTOMER: [],

  /** Root itself. Everything, by construction: a capability added later is one
   *  Root can already use, which is the behaviour we want from this row. */
  ADMIN: CAPABILITIES,

  CONTRIBUTOR: ['library.write'],

  /**
   * The Review Room and nothing else. This is the one role handed to someone
   * outside Root, so it stays least-privilege on purpose: a specialist invited
   * to read a corpus is not thereby a Library author. If Root also wants that
   * person writing into the Library, CONTRIBUTOR is added alongside — visibly,
   * as a second role, rather than by implication.
   */
  REVIEWER: ['review.participate'],

  /**
   * Build plan D6. One verb, and pointedly not `contracts.manage`,
   * `customers.manage`, or `apiTokens.manage` — a developer pulls tickets
   * from their own section (`DESK_SECTIONS`'s `builds` row) and never needs
   * to see the contract, the fee, the customer list, or the token screen to
   * do that. If Root wants one person holding both remits, `ADMIN` is added
   * alongside — visibly, as a second role, exactly as `CONTRIBUTOR` is added
   * beside `REVIEWER` rather than implied by it.
   */
  DEVELOPER: ['builds.author'],
};

/** Every capability held across a user's role set. */
export function capabilitiesOf(user: Pick<User, 'roles'>): Set<Capability> {
  const held = new Set<Capability>();
  for (const role of user.roles) {
    for (const cap of GRANTS[role] ?? []) held.add(cap);
  }
  return held;
}

/**
 * The union test. `can` is true if *any* held role grants the capability —
 * roles never subtract from one another, so holding an extra one can only ever
 * widen what a person may do, never narrow it.
 */
export function can(user: Pick<User, 'roles'>, capability: Capability): boolean {
  return user.roles.some((role) => GRANTS[role]?.includes(capability) ?? false);
}
