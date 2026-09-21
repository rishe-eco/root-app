-- L3b — builds and the resolution ledger (build plan §3 "L3b · Builds and
-- the resolution ledger"; spec §6's gap). Two new tables (Build,
-- BuildChangeEntry) plus three nullable columns spread across two existing
-- tables (FeedbackItem, DemoFrameLine).
--
-- **Hand-authored, cross-checked against `prisma migrate diff`, not pasted
-- from it** — same discipline as L1, L2 and L3. The raw diff needed no
-- correction for a NOT NULL-with-no-default trap: both new tables start
-- empty, and every new column on an existing table is nullable by the
-- schema's own design, so there is nothing on this machine's data this
-- migration needs to backfill. What the raw diff cannot express, and this
-- file adds by hand: the three CHECK constraints below, the same route L1's
-- `ScopeItem_decided_both_or_neither` and L3's `FeedbackItem_exactly_one_target`
-- already take.
--
-- Order matters, the same discipline as before: Build before BuildChangeEntry
-- (which references it, plus FeedbackItem and ScopeItem), both before the new
-- columns on FeedbackItem and DemoFrameLine that point back at them.

-- ---------------------------------------------------------------------------
-- Build: a declared state of the staging site, belonging to a phase (build
-- plan L3b.1). Not hash-sealed, not a revision — see schema.prisma's comment.
-- ---------------------------------------------------------------------------
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    -- Denormalized off phase.projectId so the numbering below can be
    -- project-wide without a join through Phase on every read.
    "projectId" TEXT NOT NULL,
    -- Latin figures always (house rule 14) — a version, never rendered in
    -- Persian digits. Project-wide and monotonic: see the unique index below.
    "number" INTEGER NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declaredById" TEXT NOT NULL,
    "ref" TEXT,
    -- Null means declared but not yet told to the customer (build plan
    -- L3b.2's fourth rule) — the same shape Demo.publishedAt already uses.
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Build" ADD CONSTRAINT "Build_phaseId_fkey"
  FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Build" ADD CONSTRAINT "Build_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Build" ADD CONSTRAINT "Build_declaredById_fkey"
  FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Project-wide and monotonic (build plan L3b.3) — never per-phase, which
-- would make "version 2" ambiguous the day a project has a second phase with
-- its own build. Also the backstop against two concurrent declareBuild calls
-- racing on the same next number (lib/build.ts's nextBuildNumber computes it,
-- this index is what makes a race a refusal rather than a duplicate).
CREATE UNIQUE INDEX "Build_projectId_number_key" ON "Build"("projectId", "number");
CREATE INDEX "Build_phaseId_idx" ON "Build"("phaseId");

-- ---------------------------------------------------------------------------
-- BuildChangeEntry: one entry in a build's change list — a feedback item's
-- disposition, a scope item shipping, or an unprompted change nobody asked
-- for (build plan L3b.1: one list, one optional origin, not two lists).
-- ---------------------------------------------------------------------------
CREATE TYPE "BuildChangeOutcome" AS ENUM ('ADDRESSED', 'DECLINED', 'CARRIED_FORWARD');

CREATE TABLE "BuildChangeEntry" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "feedbackItemId" TEXT,
    "scopeItemId" TEXT,
    -- Set exactly when feedbackItemId is (validated in lib/build.ts) — a
    -- scope-item-origin or no-origin entry is documented as done, not
    -- ratified or declined.
    "outcome" "BuildChangeOutcome",
    -- The authored prose. Required when outcome is DECLINED, or when there
    -- is no origin at all ("the note *is* the entry") — see the two CHECKs
    -- below.
    "note" TEXT,
    -- Which language `note` was authored in ("fa"/"en"), not a second
    -- required translation column (build plan L3b.3's Persian-authorship
    -- decision). Null exactly when note is.
    "noteLang" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildChangeEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_feedbackItemId_fkey"
  FOREIGN KEY ("feedbackItemId") REFERENCES "FeedbackItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_scopeItemId_fkey"
  FOREIGN KEY ("scopeItemId") REFERENCES "ScopeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express a CHECK), the same route
-- FeedbackItem_exactly_one_target already takes for the stricter version of
-- this shape: at most one origin, not exactly one — "neither" is the third,
-- legal state the plan's table names ("we changed this and nobody asked").
ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_at_most_one_origin"
  CHECK (NOT ("feedbackItemId" IS NOT NULL AND "scopeItemId" IS NOT NULL));

-- Build plan L3b.2's third rule: "declined requires its reason, structurally."
-- A nullable note on a DECLINED outcome would ship null — the same shape a
-- defaulted enum is omission with a friendly face (R1's rule). Held with a
-- CHECK, the same route L1's ScopeItem_decided_both_or_neither already takes.
ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_declined_requires_note"
  CHECK ("outcome" IS DISTINCT FROM 'DECLINED' OR "note" IS NOT NULL);

-- L3b.1's third source, held at the database too: "the note *is* the entry"
-- when there is no origin — an entry naming neither a feedback item nor a
-- scope item with no note at all would be a change nobody can read about.
ALTER TABLE "BuildChangeEntry" ADD CONSTRAINT "BuildChangeEntry_no_origin_requires_note"
  CHECK ("feedbackItemId" IS NOT NULL OR "scopeItemId" IS NOT NULL OR "note" IS NOT NULL);

CREATE INDEX "BuildChangeEntry_buildId_idx" ON "BuildChangeEntry"("buildId");
CREATE INDEX "BuildChangeEntry_feedbackItemId_idx" ON "BuildChangeEntry"("feedbackItemId");

-- ---------------------------------------------------------------------------
-- FeedbackItem: the two fields build plan L3b.2's first rule insists stay
-- apart. addressedInBuildId is the developer's claim; acceptedAt/acceptedById
-- are the customer's separate acceptance — never inferred from the first.
-- ---------------------------------------------------------------------------
ALTER TABLE "FeedbackItem" ADD COLUMN "addressedInBuildId" TEXT;
ALTER TABLE "FeedbackItem" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "FeedbackItem" ADD COLUMN "acceptedById" TEXT;

ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_addressedInBuildId_fkey"
  FOREIGN KEY ("addressedInBuildId") REFERENCES "Build"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DemoFrameLine: the provenance link for L3b's third source, once a PM has
-- turned an unprompted change into genuine bilingual prose (see
-- DemoFrame.unpromptedChanges / addDemoFrameLine).
-- ---------------------------------------------------------------------------
ALTER TABLE "DemoFrameLine" ADD COLUMN "buildChangeEntryId" TEXT;

ALTER TABLE "DemoFrameLine" ADD CONSTRAINT "DemoFrameLine_buildChangeEntryId_fkey"
  FOREIGN KEY ("buildChangeEntryId") REFERENCES "BuildChangeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one line is ever the write-up of a given entry.
CREATE UNIQUE INDEX "DemoFrameLine_buildChangeEntryId_key" ON "DemoFrameLine"("buildChangeEntryId");
