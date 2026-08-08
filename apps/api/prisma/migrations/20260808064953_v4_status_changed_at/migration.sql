-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill (V4.md defect D7): the column default above stamps every existing
-- row with the migration's own run time, which would tell the Needs-Root
-- queue every contract just arrived. updatedAt is not exactly right either —
-- any write bumps it — but it is the best available guess for a row that
-- predates this column, and strictly better than "just now".
UPDATE "Contract" SET "statusChangedAt" = "updatedAt";

-- CreateIndex
CREATE INDEX "ChangeLog_createdAt_idx" ON "ChangeLog"("createdAt");

-- CreateIndex
CREATE INDEX "Contract_status_statusChangedAt_idx" ON "Contract"("status", "statusChangedAt");
