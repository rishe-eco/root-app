-- L2 — phases and the live demo surface (build plan D2; §3 "L2 · Phases and
-- the live demo surface", L2.1, L2.2). Four new tables (Phase, Demo,
-- DemoPage, DemoUnmatchedPath) plus one nullable column on the existing
-- ScopeItem table.
--
-- **This file is hand-authored, cross-checked against `prisma migrate diff`,
-- not pasted from it.** Unlike L1's migration, the raw diff here needed no
-- correction for a NOT NULL-with-no-default trap — every new table starts
-- empty, and the one new column on an existing table (`ScopeItem.phaseId`)
-- is nullable by the schema's own design (schema.prisma: "an item can be
-- agreed long before a phase exists to carry it"), so there is no row on
-- earth this migration needs to backfill. That is a genuine difference from
-- L1's ScopeItem.projectId, not an oversight — it is checked below (banked
-- trap, L2 has none of L1's own) rather than left to be assumed.
--
-- Order still matters, the same discipline as L1: a table is created before
-- anything is asked to reference it. Phase before Demo, Demo before DemoPage
-- and DemoUnmatchedPath, and ScopeItem's new foreign key added only after
-- Phase exists to be pointed at.

-- ---------------------------------------------------------------------------
-- Phase: a slice of the build, ordered per project. References Project,
-- which L1 already created — nothing here touches that table.
-- ---------------------------------------------------------------------------
CREATE TABLE "Phase" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    -- A stand-in for a real Milestone/BillingEntry linkage (L6) — see the
    -- schema comment. Free text, so no relation is invented to an object
    -- that does not exist yet.
    "milestoneLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Phase" ADD CONSTRAINT "Phase_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Project-scoped ordinal, not a global one — two projects both have a
-- "phase 1" (schema.prisma).
CREATE UNIQUE INDEX "Phase_projectId_number_key" ON "Phase"("projectId", "number");

-- ---------------------------------------------------------------------------
-- Demo: the live staging site, embedded (D2) — never a capture, never a
-- rewriting proxy (D2 rejects that outright).
--
-- `stagingUrl` has no CHECK holding it to HTTPS here. L2.2's requirement —
-- "staging must be HTTPS, or the portal cannot frame it at all" — is
-- enforced where the column is written (`assertHttps` in
-- resolvers/admin/phases.ts), the same choice this codebase already made for
-- `declinedReason` in L1 (see that migration's banked trap #6): a database
-- CHECK cannot distinguish "not HTTPS yet because Root is still typing the
-- URL into an unrelated draft field" from "saved as non-HTTPS", and every
-- write path in this stage is the same one or two resolvers, not open
-- ad-hoc SQL.
-- ---------------------------------------------------------------------------
CREATE TABLE "Demo" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "stagingUrl" TEXT NOT NULL,
    -- D2's "record the build reference on the demo" — a plain string until
    -- L3b grows a real Build object.
    "buildRef" TEXT,
    -- The review window is a convention, not machinery (D2, L2.2) — no
    -- deploy-lock accompanies these two columns.
    "reviewWindowStart" TIMESTAMP(3),
    "reviewWindowEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Demo_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Demo" ADD CONSTRAINT "Demo_phaseId_fkey"
  FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Demo_phaseId_idx" ON "Demo"("phaseId");

-- ---------------------------------------------------------------------------
-- DemoPage: the page list a demo declares "from the registry" (L2.1) — what
-- makes a reported path mean anything. `pageDesignId` is the design-image
-- toggle (L2.1: "near zero, conditional on the mapping"); nullable, because a
-- demo can declare a page before any design exists for it.
-- ---------------------------------------------------------------------------
CREATE TABLE "DemoPage" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    -- What lib/demoPages.ts's normalizePath() reduces a reported path to.
    "canonicalPath" TEXT NOT NULL,
    "pageDesignId" TEXT,

    CONSTRAINT "DemoPage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DemoPage" ADD CONSTRAINT "DemoPage_demoId_fkey"
  FOREIGN KEY ("demoId") REFERENCES "Demo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not RESTRICT or CASCADE: deleting a page design must not delete
-- (or be blocked by) the demo page that merely displays it alongside the
-- live site — the toggle is read-only reuse (D5; schema.prisma's note on
-- PageDesign.demoPages), never a dependency the design side owes anything to.
ALTER TABLE "DemoPage" ADD CONSTRAINT "DemoPage_pageDesignId_fkey"
  FOREIGN KEY ("pageDesignId") REFERENCES "PageDesign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "DemoPage_demoId_key_key" ON "DemoPage"("demoId", "key");
CREATE INDEX "DemoPage_demoId_canonicalPath_idx" ON "DemoPage"("demoId", "canonicalPath");

-- ---------------------------------------------------------------------------
-- DemoUnmatchedPath: "a page we did not expect" (L2.2) — every reported path
-- that matched no declared DemoPage, deduplicated and counted rather than
-- dropped or turned into a note nobody routes.
-- ---------------------------------------------------------------------------
CREATE TABLE "DemoUnmatchedPath" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "normalizedPath" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DemoUnmatchedPath_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DemoUnmatchedPath" ADD CONSTRAINT "DemoUnmatchedPath_demoId_fkey"
  FOREIGN KEY ("demoId") REFERENCES "Demo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per (demo, normalized path) — a second report of the same
-- unexpected path is a count increment (resolvers/demo.ts's upsert), never a
-- second row.
CREATE UNIQUE INDEX "DemoUnmatchedPath_demoId_normalizedPath_key" ON "DemoUnmatchedPath"("demoId", "normalizedPath");

-- ---------------------------------------------------------------------------
-- ScopeItem: which phase (if any) is building this item. Added nullable —
-- and, unlike L1's ScopeItem.projectId, it stays nullable at rest, not just
-- during the migration: "an item can be agreed long before a phase exists to
-- carry it" (schema.prisma). No backfill statement follows this ALTER
-- TABLE on purpose — there is nothing true to backfill it to. A pre-L2
-- ScopeItem has no phase, and NULL is exactly that fact, not a placeholder
-- standing in for one.
-- ---------------------------------------------------------------------------
ALTER TABLE "ScopeItem" ADD COLUMN "phaseId" TEXT;

ALTER TABLE "ScopeItem" ADD CONSTRAINT "ScopeItem_phaseId_fkey"
  FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
