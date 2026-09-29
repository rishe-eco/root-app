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
  // ---- The project lifecycle (journeys build plan S1) -------------------
  //
  // These replace `contracts.manage`, the one verb that used to guard the
  // whole lifecycle desk. One verb meant every staff role got the whole desk
  // or none of it (defect D-3), so a developer could not even open a demo
  // (D-2). It is removed, not aliased: an alias no role is meant to hold is a
  // guard that silently admits ADMIN only, and reads as if it meant more.
  //
  // Reading is split from authoring, and reading is split in two. A
  // capability here still only says *may you use the surface*; which
  // contracts a reader sees is `lib/visibility.ts`, and whether a designer may
  // author *this* contract's design is the assignment edge there too.

  /** Every contract, whatever its state — the sales view of the book. */
  'contracts.readAll',
  /** Contracts that are still being worked: not discarded, not delivered,
   *  on an active project (`isActiveContract`). What design and development
   *  need to do their jobs, and no more. */
  'contracts.readActive',
  /** Create a contract, write its draft, articles and registry, publish it,
   *  set its status, hand it over, assign its designer and developer. */
  'contracts.author',
  /**
   * The budget, the fee, the payment plan, invoices (PD-14). One verb rather
   * than every field resolver asking "author or billing?", so the answer to
   * "who can see what this costs" is one row of this table. Design and
   * development never hold it (journeys Q-S3).
   */
  'money.read',
  /** Invite, revoke, and list customers. Separate from the above so that an
   *  outside reviewer working a corpus is never also an account administrator. */
  'customers.manage',
  /** The staff side of change tickets (L4): list, answer, convert, close. */
  'tickets.answer',
  /** Billing entries and subscriptions (L6) — writing them, and the desk's
   *  ledger and report. */
  'billing.manage',
  /** Answer a customer's feedback in any step (S2). Held by every lifecycle
   *  role, because design and development are asked things from step 1 on
   *  (journeys Q-S1) — whether the answer reaches the customer directly is
   *  the `answers.direct.*` rows below, not this one. */
  'feedback.answer',
  /** Approve or decline, with a reason, an answer that needs approval (S2). */
  'feedback.approveAnswers',
  /**
   * The answer matrix (PD-3), one row per step: holding it means your answer
   * in that step reaches the customer without waiting for a sales approval.
   * Capabilities rather than a role lookup because house rule 1 forbids the
   * lookup — and a person holding two roles then gets the union for free.
   */
  'answers.direct.agreement',
  'answers.direct.design',
  'answers.direct.mockup',
  'answers.direct.demo',
  /** Author a design — concepts, pages, images, palette, mockups — on the
   *  contracts one is assigned to (`canAuthorDesign`). Also the upload
   *  policy for design images (`lib/files.ts`). */
  'design.author',
  /** Template types and the theme catalogue (T1, T2). */
  'templates.types',
  /** Scope templates (T1). */
  'templates.scope',
  /**
   * Build plan D6, 2026-09-20: declare a build, disposition open feedback
   * items, write change entries, move scope items to `in-demo` — and, since
   * S1, author the demos and review frames of the contracts one is assigned
   * to develop (`canAuthorBuild`).
   *
   * Its own row rather than a widening of a contract verb, on purpose: the
   * person who authors a build is not thereby a contract author. They never
   * need the fee, the customer list, or `apiTokens.manage` — the one
   * capability whose blast radius is everything else a role holds — to do
   * this job, so none of those are reachable from here. Same reasoning
   * `REVIEWER` was narrowed to `review.participate` and nothing else.
   */
  'builds.author',
  /** Mark a non-technical dependency met (L5; the split arrives with J4's
   *  `technical` flag — until then every dependency is general). */
  'dependencies.verifyGeneral',
  /** Mark a technical dependency met — hosting, DNS, credentials (J4). */
  'dependencies.verifyTechnical',
  /** Author a contract's design or build without being its assignee — the
   *  escape hatch for cover and emergencies. No staff role holds it; ADMIN
   *  does, by construction. */
  'assignments.override',
  /** Staff accounts and their roles (S3's Users slice). ADMIN only. */
  'staff.manage',

  // ---- Everything else, unchanged by S1 ---------------------------------

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
   * Build plan D6, widened by S1 to the rest of a developer's job: reading
   * the active contracts (to see what they are building against), answering
   * feedback, answering directly in the demo step, and verifying technical
   * dependencies. Still pointedly not `contracts.author`, `money.read`,
   * `customers.manage` or `apiTokens.manage` — a developer never needs the
   * fee, the customer list or the token screen to do this job. If Root wants
   * one person holding both remits, `SALES` or `ADMIN` is added alongside —
   * visibly, as a second role, exactly as `CONTRIBUTOR` is added beside
   * `REVIEWER` rather than implied by it.
   */
  DEVELOPER: [
    'contracts.readActive',
    'feedback.answer',
    'answers.direct.demo',
    'builds.author',
    'dependencies.verifyTechnical',
  ],

  /**
   * Journeys build plan S1 (journeys §7.3). Everything about running a
   * contract except authoring its design or build: the whole book, the
   * money, the customers, tickets, billing, and the last word on any answer
   * design or development give outside their own step. Not `staff.manage`,
   * `assignments.override` or `apiTokens.manage` — those stay ADMIN's.
   */
  SALES: [
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
    'templates.scope',
    'dependencies.verifyGeneral',
  ],

  /**
   * Journeys build plan S1. Authors the design of the contracts they are
   * assigned to, keeps the template types and the theme catalogue, and
   * answers directly in the two steps that are theirs (design, mockup). Reads
   * active contracts, never money — so the fee field and the billing surface
   * are unreachable from this row, not merely hidden in the UI.
   */
  DESIGNER: [
    'contracts.readActive',
    'feedback.answer',
    'answers.direct.design',
    'answers.direct.mockup',
    'design.author',
    'templates.types',
  ],
};

/**
 * PD-20: the roles that can change a customer's contract or money —
 * `ADMIN`, `SALES`, `DESIGNER`, `DEVELOPER` — must clear a second factor to
 * sign in at all; `CONTRIBUTOR` and `REVIEWER` do not, because both are
 * routinely outside specialists invited by email who reach no customer
 * data. A literal set rather than a derived one (e.g. "any role granting
 * `contracts.readActive`"): the second factor is a property of the *role*,
 * decided once here, not an accidental consequence of today's capability
 * grants drifting under it later.
 */
const SECOND_FACTOR_ROLES: ReadonlySet<Role> = new Set(['ADMIN', 'SALES', 'DESIGNER', 'DEVELOPER']);

/**
 * PD-20 — the one function `signIn`/`verifySignInFactor` (resolvers/auth.ts)
 * ask instead of reading a role themselves, per house rule 1. A user holding
 * *any* second-factor role must clear the factor, even if they also hold a
 * role that would not require it on its own — the same union-never-subtracts
 * rule `can` already applies to capabilities.
 */
export function requiresSecondFactor(user: Pick<User, 'roles'>): boolean {
  return user.roles.some((role) => SECOND_FACTOR_ROLES.has(role));
}

/**
 * Journeys build plan S3. "Staff" is every role but CUSTOMER — the roles the
 * desk exists for, and so the roles `inviteStaff` and `setUserRoles` deal in.
 * Named here because it is a fact about *roles*, which no other file may read
 * (house rule 1); resolvers ask `isStaffRole` / `hasStaffRole` instead of
 * comparing to `'CUSTOMER'`.
 *
 * It is deliberately not "holds a capability" (the web's `isStaff`): that is
 * true of every staff role today, but a role that granted nothing would still
 * be a role a customer-manager must not be able to disable.
 */
export function isStaffRole(role: Role): boolean {
  return role !== 'CUSTOMER';
}

/** Any staff role at all — a mixed customer-and-staff account counts. */
export function hasStaffRole(user: Pick<User, 'roles'>): boolean {
  return user.roles.some(isStaffRole);
}

/**
 * The role no one may be left without: "the last active ADMIN" (S3's
 * `LAST_SUPERUSER`) is a fact about this role specifically, since it alone
 * holds `staff.manage` and so alone can grant a role to anyone. Exported as a
 * value so a query can say `roles: { has: SUPERUSER_ROLE }` without spelling
 * the name outside this file.
 */
export const SUPERUSER_ROLE: Role = 'ADMIN';

export function isSuperuser(user: Pick<User, 'roles'>): boolean {
  return user.roles.includes(SUPERUSER_ROLE);
}

/** Holds the customer role — alone, or alongside staff ones. */
export function hasCustomerRole(user: Pick<User, 'roles'>): boolean {
  return user.roles.includes('CUSTOMER');
}

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
