-- L1 — the scope registry's owner becomes a Project (build plan D1,
-- 2026-09-20). ScopeItem re-parents from Contract to Project; Contract gains
-- a nullable projectId. The DEVELOPER role (D6) travels with this migration
-- on F3's precedent — see schema.prisma's comment on Role.
--
-- **This file is hand-authored, not what `prisma migrate diff` produced.**
-- The raw diff drops ScopeItem.contractId and adds ScopeItem.projectId as
-- NOT NULL with no default in the same ALTER TABLE — which fails outright
-- against any table that already has rows, because there is no value that
-- could stand in for "which project". The plan's own §7.1 says production
-- carries none yet, so the only rows this backfill will ever actually touch
-- are the seed fixture's — but it is written as though it mattered, because
-- the day it does matter is the day this file cannot be rewritten.
--
-- Order matters throughout: Project exists and is populated before Contract
-- or ScopeItem is asked to point at it; ScopeItem.projectId is added
-- nullable, backfilled, and only then made NOT NULL.

-- ---------------------------------------------------------------------------
-- D6: the DEVELOPER role. Added but not used before commit, same shape as
-- the CONTRIBUTOR/REVIEWER migration (20260805103000_roles_as_a_set) — safe
-- inside a transaction because nothing below references the new value.
-- ---------------------------------------------------------------------------
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DEVELOPER';

-- ---------------------------------------------------------------------------
-- Project: the registry's new owner.
-- ---------------------------------------------------------------------------
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Project_customerId_idx" ON "Project"("customerId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One Project per existing Contract — customer and title copied across, so a
-- contract mid-flight does not lose its name. A contract created after this
-- migration gets its project from `createContract`
-- (resolvers/admin/registry.ts) instead; this INSERT runs exactly once, for
-- whatever contracts already existed at migration time. The id is a
-- deterministic, readable string rather than a cuid precisely because this is
-- a one-shot backfill, not application code — nothing generates another
-- Project with this shape ever again.
INSERT INTO "Project" ("id", "customerId", "titleFa", "titleEn", "status", "createdAt", "updatedAt")
SELECT
  'proj_' || "id",
  "customerId",
  "titleFa",
  "titleEn",
  'ACTIVE',
  "createdAt",
  "createdAt"
FROM "Contract";

-- ---------------------------------------------------------------------------
-- Contract: a nullable projectId, backfilled to the project just created for
-- each existing row.
-- ---------------------------------------------------------------------------
ALTER TABLE "Contract" ADD COLUMN "projectId" TEXT;

UPDATE "Contract" SET "projectId" = 'proj_' || "id";

ALTER TABLE "Contract" ADD CONSTRAINT "Contract_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ScopeItem: re-parent from Contract to Project (D1), and grow the columns
-- the status lifecycle, flags and origin need (build plan L1; spec §3).
-- ---------------------------------------------------------------------------

-- Added nullable first — see the file header for why this cannot be one
-- NOT NULL ADD COLUMN the way a from-scratch diff would write it.
ALTER TABLE "ScopeItem" ADD COLUMN "projectId" TEXT;

UPDATE "ScopeItem" SET "projectId" = 'proj_' || "contractId";

ALTER TABLE "ScopeItem" ALTER COLUMN "projectId" SET NOT NULL;

ALTER TABLE "ScopeItem" DROP CONSTRAINT "ScopeItem_contractId_fkey";
DROP INDEX "ScopeItem_contractId_key_key";
ALTER TABLE "ScopeItem" DROP COLUMN "contractId";

ALTER TABLE "ScopeItem" ADD CONSTRAINT "ScopeItem_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-project, not per-contract (banked trap #2): a project spanning two
-- contracts sharing one registry is the whole point of D1, and a
-- per-contract uniqueness would be a latent duplicate the day that happens.
CREATE UNIQUE INDEX "ScopeItem_projectId_key_key" ON "ScopeItem"("projectId", "key");

CREATE TYPE "ScopeStatus" AS ENUM ('PROPOSED', 'AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED', 'DECLINED', 'TRADED');

-- `status` takes the schema's own ongoing default (PROPOSED — what a brand
-- new item starts as), so a raw insert after this migration behaves exactly
-- as schema.prisma says. The backfill immediately below overrides that
-- default for every row that already existed, because under the old flat
-- model a pre-existing scope item was never merely "proposed" — it was
-- already part of the deal.
ALTER TABLE "ScopeItem"
  ADD COLUMN "status" "ScopeStatus" NOT NULL DEFAULT 'PROPOSED',
  ADD COLUMN "temporary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "decidedNote" TEXT,
  ADD COLUMN "outOfScope" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "adminWork" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "declinedReason" TEXT,
  ADD COLUMN "originNote" TEXT,
  ADD COLUMN "originRound" TEXT,
  ADD COLUMN "originAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Banked trap #1, held here rather than merely in a comment: backfill to
-- AGREED, never ACCEPTED, and `checkedAt` is not touched by this migration at
-- all. `checkedAt` is the customer's tick on the appendix; `status` is where
-- the item stands in the build lifecycle; conflating them would write a false
-- history into the one record whose purpose is being true.
UPDATE "ScopeItem" SET "status" = 'AGREED';

-- Prisma cannot express "these two columns agree" (house rule 11's family) —
-- `decided` needs a date *and* a pointer to what decided it, both or neither.
ALTER TABLE "ScopeItem" ADD CONSTRAINT "ScopeItem_decided_both_or_neither"
  CHECK (("decidedAt" IS NULL) = ("decidedNote" IS NULL));

-- ---------------------------------------------------------------------------
-- ScopeTrade: paired movements (spec §4).
-- ---------------------------------------------------------------------------
CREATE TABLE "ScopeTrade" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "outItemId" TEXT NOT NULL,
    "inItemId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rootConfirmedAt" TIMESTAMP(3),
    "customerConfirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "amendmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScopeTrade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScopeTrade_outItemId_key" ON "ScopeTrade"("outItemId");
CREATE UNIQUE INDEX "ScopeTrade_inItemId_key" ON "ScopeTrade"("inItemId");
CREATE UNIQUE INDEX "ScopeTrade_amendmentId_key" ON "ScopeTrade"("amendmentId");
CREATE INDEX "ScopeTrade_projectId_idx" ON "ScopeTrade"("projectId");

ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_outItemId_fkey"
  FOREIGN KEY ("outItemId") REFERENCES "ScopeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_inItemId_fkey"
  FOREIGN KEY ("inItemId") REFERENCES "ScopeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_proposedById_fkey"
  FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_amendmentId_fkey"
  FOREIGN KEY ("amendmentId") REFERENCES "Amendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A trade cannot swap an item for itself.
ALTER TABLE "ScopeTrade" ADD CONSTRAINT "ScopeTrade_out_ne_in" CHECK ("outItemId" <> "inItemId");
