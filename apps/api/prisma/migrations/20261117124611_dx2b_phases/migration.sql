-- AlterTable
ALTER TABLE "Phase" ADD COLUMN     "doneAt" TIMESTAMP(3),
ADD COLUMN     "doneById" TEXT,
ADD COLUMN     "hasDemo" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PlannedInvoice" ADD COLUMN     "dueOn" DATE;

-- CreateTable
CREATE TABLE "ScopeItemPhase" (
    "scopeItemId" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,

    CONSTRAINT "ScopeItemPhase_pkey" PRIMARY KEY ("scopeItemId","phaseId")
);

-- CreateIndex
CREATE INDEX "ScopeItemPhase_phaseId_idx" ON "ScopeItemPhase"("phaseId");

-- AddForeignKey
ALTER TABLE "Phase" ADD CONSTRAINT "Phase_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeItemPhase" ADD CONSTRAINT "ScopeItemPhase_scopeItemId_fkey" FOREIGN KEY ("scopeItemId") REFERENCES "ScopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeItemPhase" ADD CONSTRAINT "ScopeItemPhase_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DX2b, by hand: every item that already sits in a phase gets its one link, so
-- the join table and `ScopeItem.phaseId` agree from the first moment (phaseId
-- stays the highest-numbered phase of an item's links; with one link it is that
-- one). Items with no phase get no row.
INSERT INTO "ScopeItemPhase" ("scopeItemId", "phaseId")
SELECT "id", "phaseId" FROM "ScopeItem" WHERE "phaseId" IS NOT NULL;

-- DX2b, by hand (house rule 11): a planned invoice falls due on a phase being
-- done OR on a calendar day, never both. A NULL on either side passes, which is
-- right: neither set means "on signing", and one set is the other two triggers.
ALTER TABLE "PlannedInvoice"
  ADD CONSTRAINT "PlannedInvoice_phase_xor_date" CHECK ("phaseId" IS NULL OR "dueOn" IS NULL);
