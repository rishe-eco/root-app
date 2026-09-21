-- L5 — the dependency board (build plan §3 "L5"; spec §7). One new enum, one
-- new table. Symmetric commitments — customer-side and Root-side — under one
-- rule, with a verification step that is the whole feature: `verifiedNote`
-- holds *what was done*, never only a timestamp.
--
-- **Hand-authored, cross-checked against `prisma migrate diff`, not pasted
-- from it** — same discipline as every prior stage. The raw diff needed no
-- correction for a NOT NULL-with-no-default trap: `Dependency` is a brand
-- new table and starts empty, so every NOT NULL column on it is free. What
-- the raw diff cannot express, and this file adds by hand: the CHECK
-- constraint holding "verifiedAt, verifiedById and verifiedNote travel
-- together, or not at all" — the same "both or neither" route L1's
-- `ScopeItem_decided_both_or_neither` already takes, generalized to three
-- columns instead of two.

CREATE TYPE "DependencySide" AS ENUM ('CUSTOMER', 'ROOT');

CREATE TABLE "Dependency" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "side" "DependencySide" NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedNote" TEXT,

    CONSTRAINT "Dependency_pkey" PRIMARY KEY ("id")
);

-- Serves the board's own ordering (soonest-due first) and the overdue scan
-- (dueAt < now() AND verifiedAt IS NULL) for one project at a time.
CREATE INDEX "Dependency_projectId_dueAt_idx" ON "Dependency"("projectId", "dueAt");

ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The banked trap, held at the database and not only in the resolver: a
-- verification cannot exist without its own "how." verifiedById is held to
-- the same rule as verifiedNote rather than left optional, so a verified row
-- always names *who* did the checking as well as what they did.
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_verified_both_or_neither" CHECK (
  ("verifiedAt" IS NULL) = ("verifiedById" IS NULL) AND
  ("verifiedAt" IS NULL) = ("verifiedNote" IS NULL)
);
