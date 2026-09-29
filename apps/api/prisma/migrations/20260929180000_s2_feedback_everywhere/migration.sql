-- S2 — one feedback model for every step, the §3.1 rule, answers and the
-- approval queue (journeys build plan §5 "S2", PD-1 … PD-4, PD-21). The
-- widest migration in the plan: it rewrites L3's `FeedbackItem` into the
-- model every step shares. Cheap only because production holds no data
-- (P0-1) — but written to be *correct* on a database that does, and the two
-- places that would otherwise fail on real rows (the enum rewrite and the
-- three columns that become required) are handled below, not assumed away.
--
-- Generated with `prisma migrate diff --from-migrations … --to-schema-datamodel`
-- against a shadow database, and read. Hand-extended in the places marked
-- "Hand-written":
--
--   1. the `RATIFIED` → `OPEN` mapping inside the enum rewrite (the generated
--      cast would fail on any row holding the removed value);
--   2. the backfill and the guard before `projectId` / `contractId` become
--      required — `j2`'s pattern: the block between the VERIFY markers is run
--      by `s2.test.ts` over a legacy-shaped row, inside a rolled-back
--      transaction;
--   3. `step` added with a default the migration then drops — every existing
--      item is a demo item;
--   4. the old CHECK dropped and the new one, `FeedbackItem_anchor_matches_step`;
--   5. four partial unique indexes, which Prisma cannot express;
--   6. `FeedbackComment_declined_has_reason`.
--
-- Every hand-written CHECK and index is exercised by a direct insert in
-- `s2.test.ts`.

-- CreateEnum
CREATE TYPE "FeedbackResolution" AS ENUM ('ADDRESSED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AnswerApproval" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DECLINED');

-- AlterEnum
-- Hand-written (1): PD-2 retires RATIFIED. A ratified item is an open one that
-- has been decided upon — which every submission now is — so it becomes OPEN,
-- keeping its `ratifiedAt`. Done through the cast rather than an UPDATE first,
-- so it does not depend on the order the statements run in.
BEGIN;
CREATE TYPE "FeedbackStatus_new" AS ENUM ('OPEN', 'ADDRESSED', 'DECLINED', 'MOVED', 'ACCEPTED');
ALTER TABLE "FeedbackItem" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "FeedbackItem" ALTER COLUMN "status" TYPE "FeedbackStatus_new"
  USING (CASE WHEN "status"::text = 'RATIFIED' THEN 'OPEN' ELSE "status"::text END::"FeedbackStatus_new");
ALTER TYPE "FeedbackStatus" RENAME TO "FeedbackStatus_old";
ALTER TYPE "FeedbackStatus_new" RENAME TO "FeedbackStatus";
DROP TYPE "FeedbackStatus_old";
ALTER TABLE "FeedbackItem" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;

-- AlterTable
ALTER TABLE "FeedbackComment" ADD COLUMN     "approval" "AnswerApproval" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "originalBody" TEXT,
ADD COLUMN     "resolution" "FeedbackResolution";

-- AlterTable
-- Hand-written (2, 3): `projectId` and `contractId` are added nullable and made
-- required after the backfill; `step` is added with a DEFAULT so existing rows
-- get a value, and the default is dropped straight after so no future insert
-- can forget to say which step it is about.
ALTER TABLE "FeedbackItem" ADD COLUMN     "anchorScopeItemId" TEXT,
ADD COLUMN     "articleNumber" INTEGER,
ADD COLUMN     "briefField" TEXT,
ADD COLUMN     "conceptId" TEXT,
ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "contractRevisionId" TEXT,
ADD COLUMN     "designRevisionId" TEXT,
ADD COLUMN     "general" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pageDesignId" TEXT,
ADD COLUMN     "paletteItemId" TEXT,
ADD COLUMN     "phaseId" TEXT,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "step" "StepKind" NOT NULL DEFAULT 'DEMO',
ALTER COLUMN "demoId" DROP NOT NULL;

ALTER TABLE "FeedbackItem" ALTER COLUMN "step" DROP DEFAULT;

-- Hand-written (2). Every item that exists is a demo item (`step` above), so
-- its project and phase come from its demo, and its contract is the project's
-- primary one — the earliest, `primaryContractId`'s ordering (J2). The guard
-- stops, rather than inventing a contract, if a project somehow has none.
-- VERIFY:BEGIN
UPDATE "FeedbackItem" AS fi
SET "phaseId" = d."phaseId", "projectId" = ph."projectId"
FROM "Demo" AS d
JOIN "Phase" AS ph ON ph."id" = d."phaseId"
WHERE fi."demoId" = d."id" AND fi."projectId" IS NULL;

UPDATE "FeedbackItem" AS fi
SET "contractId" = (
  SELECT c."id" FROM "Contract" AS c
  WHERE c."projectId" = fi."projectId"
  ORDER BY c."createdAt" ASC, c."id" ASC
  LIMIT 1
)
WHERE fi."contractId" IS NULL;

DO $$
DECLARE orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "FeedbackItem" WHERE "projectId" IS NULL OR "contractId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'S2: % feedback item(s) have no project or contract; give each one before making FeedbackItem.projectId and contractId required', orphans;
  END IF;
END $$;
-- VERIFY:END

ALTER TABLE "FeedbackItem" ALTER COLUMN "projectId" SET NOT NULL,
ALTER COLUMN "contractId" SET NOT NULL;

-- Hand-written (4): L3's "exactly one of demoPageId / frameLineId" no longer
-- holds — a `general` item has neither, and other steps have other anchors.
-- The one CHECK below replaces it, as one `CASE step` expression, and
-- `lib/feedbackRules.ts`'s `anchorMatchesStep` is its twin.
--
-- Written with `num_nonnulls`, which counts the columns that are set, and
-- `IS NOT NULL` tests — every operand is a definite boolean, so the CHECK can
-- never evaluate to NULL (which would *pass*, house rule 11). AGREEMENT and
-- SUMMARY take no feedback at all: the `ELSE false`.
ALTER TABLE "FeedbackItem" DROP CONSTRAINT "FeedbackItem_exactly_one_target";

ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_anchor_matches_step" CHECK (
  CASE "step"
    WHEN 'REQUIREMENTS' THEN
      num_nonnulls("anchorScopeItemId", "contractRevisionId", "articleNumber", "designRevisionId", "conceptId",
                   "pageDesignId", "paletteItemId", "demoId", "demoPageId", "frameLineId") = 0
      AND "general" <> ("briefField" IS NOT NULL)
    WHEN 'SCOPE' THEN
      num_nonnulls("briefField", "contractRevisionId", "articleNumber", "designRevisionId", "conceptId",
                   "pageDesignId", "paletteItemId", "demoId", "demoPageId", "frameLineId") = 0
      AND "general" <> ("anchorScopeItemId" IS NOT NULL)
    WHEN 'DRAFT' THEN
      num_nonnulls("briefField", "anchorScopeItemId", "designRevisionId", "conceptId",
                   "pageDesignId", "paletteItemId", "demoId", "demoPageId", "frameLineId") = 0
      AND "general" <> ("contractRevisionId" IS NOT NULL)
      AND ("articleNumber" IS NULL OR "contractRevisionId" IS NOT NULL)
    WHEN 'DESIGN' THEN
      num_nonnulls("briefField", "anchorScopeItemId", "contractRevisionId", "articleNumber",
                   "demoId", "demoPageId", "frameLineId") = 0
      AND "general" <> ("designRevisionId" IS NOT NULL)
      AND num_nonnulls("conceptId", "pageDesignId", "paletteItemId") <= 1
      AND (num_nonnulls("conceptId", "pageDesignId", "paletteItemId") = 0 OR "designRevisionId" IS NOT NULL)
    WHEN 'MOCKUP' THEN
      num_nonnulls("briefField", "anchorScopeItemId", "contractRevisionId", "articleNumber", "designRevisionId",
                   "conceptId", "pageDesignId", "paletteItemId") = 0
      AND (
        ("general" AND num_nonnulls("demoId", "demoPageId", "frameLineId") = 0)
        OR (NOT "general" AND "demoId" IS NOT NULL AND num_nonnulls("demoPageId", "frameLineId") = 1)
      )
    WHEN 'DEMO' THEN
      num_nonnulls("briefField", "anchorScopeItemId", "contractRevisionId", "articleNumber", "designRevisionId",
                   "conceptId", "pageDesignId", "paletteItemId") = 0
      AND (
        ("general" AND num_nonnulls("demoId", "demoPageId", "frameLineId") = 0)
        OR (NOT "general" AND "demoId" IS NOT NULL AND num_nonnulls("demoPageId", "frameLineId") = 1)
      )
    ELSE false
  END
);

-- Hand-written (6): "declined *with a reason*" (journeys Q-S1). Stronger than
-- the plan's `IS NOT NULL`: a note of only whitespace is not a reason.
ALTER TABLE "FeedbackComment" ADD CONSTRAINT "FeedbackComment_declined_has_reason" CHECK (
  "approval" <> 'DECLINED' OR ("approvalNote" IS NOT NULL AND btrim("approvalNote") <> '')
);

-- CreateIndex
CREATE INDEX "FeedbackComment_approval_createdAt_idx" ON "FeedbackComment"("approval", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_conceptId_key" ON "FeedbackItem"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_pageDesignId_key" ON "FeedbackItem"("pageDesignId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_paletteItemId_key" ON "FeedbackItem"("paletteItemId");

-- CreateIndex
CREATE INDEX "FeedbackItem_contractId_step_status_idx" ON "FeedbackItem"("contractId", "step", "status");

-- CreateIndex
CREATE INDEX "FeedbackItem_projectId_step_status_idx" ON "FeedbackItem"("projectId", "step", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_contractId_briefField_key" ON "FeedbackItem"("contractId", "briefField");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_contractId_anchorScopeItemId_key" ON "FeedbackItem"("contractId", "anchorScopeItemId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackItem_contractRevisionId_articleNumber_key" ON "FeedbackItem"("contractRevisionId", "articleNumber");

-- Hand-written (5): duplicate collapse where a plain unique cannot say it.
-- A `general` item collapses per step — two indexes, not one, because
-- `phaseId` is NULL for every step but DEMO and a NULL is distinct from every
-- other NULL (the same reason `StepApproval` has two, and not
-- `NULLS NOT DISTINCT`, which needs Postgres 15). The other two collapse an
-- anchor that names a whole revision rather than one article (DRAFT) or one
-- concept / page / palette item (DESIGN): the plain uniques above see a NULL
-- article number, or three NULL design anchors, as distinct from each other.
CREATE UNIQUE INDEX "FeedbackItem_one_general_per_step" ON "FeedbackItem"("contractId", "step") WHERE "general" AND "phaseId" IS NULL;

CREATE UNIQUE INDEX "FeedbackItem_one_general_per_step_phase" ON "FeedbackItem"("contractId", "step", "phaseId") WHERE "general" AND "phaseId" IS NOT NULL;

CREATE UNIQUE INDEX "FeedbackItem_one_per_revision" ON "FeedbackItem"("contractRevisionId") WHERE "contractRevisionId" IS NOT NULL AND "articleNumber" IS NULL;

CREATE UNIQUE INDEX "FeedbackItem_one_per_design_revision" ON "FeedbackItem"("designRevisionId") WHERE "designRevisionId" IS NOT NULL AND "conceptId" IS NULL AND "pageDesignId" IS NULL AND "paletteItemId" IS NULL;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_anchorScopeItemId_fkey" FOREIGN KEY ("anchorScopeItemId") REFERENCES "ScopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_contractRevisionId_fkey" FOREIGN KEY ("contractRevisionId") REFERENCES "ContractRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_designRevisionId_fkey" FOREIGN KEY ("designRevisionId") REFERENCES "DesignRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "DesignConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_pageDesignId_fkey" FOREIGN KEY ("pageDesignId") REFERENCES "PageDesign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackComment" ADD CONSTRAINT "FeedbackComment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
