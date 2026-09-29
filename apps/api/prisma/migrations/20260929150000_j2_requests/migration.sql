-- J2 — requests: a project before a contract (journeys build plan §5 "J2").
-- Three things: a `REQUESTED` project status with the request held on the
-- project, the `RequestMessage` thread, and `Contract.projectId` becoming
-- required (lifecycle plan §0.3.4, owed since L2).
--
-- Generated with `prisma migrate diff` and read. Hand-extended in three
-- places, each marked below: the guard that refuses to make `projectId`
-- required over a row that would violate it, a defensive backfill for the
-- CHECK, and the CHECK itself, which Prisma cannot express.
--
-- `ALTER TYPE … ADD VALUE` runs inside this migration's transaction, which
-- Postgres allows from 12 on *provided the new value is not used before the
-- commit* — so nothing below mentions 'REQUESTED' (the CHECK is written
-- against 'ARCHIVED', an old value, on purpose).

-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'REQUESTED';

-- DropForeignKey
ALTER TABLE "Contract" DROP CONSTRAINT "Contract_projectId_fkey";

-- Hand-written. Production holds no data (plan P0-1), but this migration must
-- be correct on a database that does: every contract L1 migrated got a
-- project of its own and `createContract` has made one since, so this should
-- never fire — and if it does, the honest answer is to stop and look at the
-- row, not to invent a project for it here. `j2.test.ts` runs *this block of
-- this file* against a contract with no project, inside a rolled-back
-- transaction.
-- VERIFY:BEGIN
DO $$
DECLARE orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "Contract" WHERE "projectId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'J2: % contract(s) have no project; give each one a project before making Contract.projectId required', orphans;
  END IF;
END $$;
-- VERIFY:END

-- AlterTable
ALTER TABLE "Contract" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "archivedReason" TEXT,
ADD COLUMN     "requestBody" TEXT,
ADD COLUMN     "requestLang" TEXT,
ADD COLUMN     "requestTitle" TEXT,
ADD COLUMN     "requestedAt" TIMESTAMP(3);

-- Hand-written, once the columns exist and before the CHECK below: nothing
-- set ARCHIVED before this stage, so this touches no row on any database the
-- app produced — it exists so the CHECK cannot fail the migration on one
-- that was edited by hand.
UPDATE "Project"
SET "archivedReason" = 'Archived before reasons were recorded',
    "archivedAt" = "updatedAt"
WHERE "status" = 'ARCHIVED' AND "archivedReason" IS NULL;

-- CreateTable
CREATE TABLE "RequestMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestMessage_projectId_createdAt_idx" ON "RequestMessage"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestMessage" ADD CONSTRAINT "RequestMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestMessage" ADD CONSTRAINT "RequestMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: an archived request always carries the reason the customer is
-- shown. `IS NOT NULL` on a nullable column is a plain boolean, so unlike an
-- `array_length` check this cannot evaluate to NULL and pass (house rule 11).
ALTER TABLE "Project"
  ADD CONSTRAINT "Project_archived_has_reason" CHECK ("status" <> 'ARCHIVED' OR "archivedReason" IS NOT NULL);
