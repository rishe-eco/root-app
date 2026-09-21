-- L7 — services: the product-import panel (build plan §3 "L7"; spec §9).
-- Two new tables (`ServiceRun`, `ServiceRunRow`), one new `FileClass` value
-- (`SERVICE_IMPORT`), and `StoredFile` grows a second, optional owning edge
-- (`projectId`) beside its existing `contractId` — the first file class this
-- schema attaches to a project rather than a contract.
--
-- **Hand-authored, cross-checked against `prisma migrate diff
-- --from-migrations ./prisma/migrations --to-schema-datamodel
-- ./prisma/schema.prisma --shadow-database-url <shadow>`, not pasted from
-- it** — same discipline as every prior stage. No correction for a NOT
-- NULL-with-no-default trap was needed: `ServiceRun`/`ServiceRunRow` are
-- brand-new tables and start empty, and the one new column on an existing
-- table (`StoredFile.projectId`) is nullable — a pre-existing file has no
-- project and stays legitimately absent forever for every class but
-- SERVICE_IMPORT.
--
-- What the raw diff cannot express, and this file adds by hand, in two
-- parts:
--
-- 1. Two "declined-because"-shaped CHECK constraints — the same route L1's
--    `ScopeItem_decided_both_or_neither` and L3b's
--    `BuildChangeEntry_at_most_one_origin` already take: `failureReason` is
--    required exactly when a run's `status` is FAILED, and `rejectReason`
--    is required exactly when a row's `action` is REJECTED. Spec §9 asks
--    for "rejected rows with reasons" — a nullable reason column with no
--    CHECK would let that promise ship unenforced, the same omission R1's
--    own rule warns against.
--
-- 2. `StoredFile_private_has_owner` (from the first migration,
--    `20260803085059_stored_files`) is dropped and re-added widened to
--    accept `projectId` as an equally-valid owner alongside `contractId`.
--    Without this, inserting the first SERVICE_IMPORT row — PRIVATE, owned
--    by a project, with `contractId` null — would violate the original
--    constraint outright.

-- CreateEnum
CREATE TYPE "ServiceRunStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "ServiceRowAction" AS ENUM ('CREATE', 'UPDATE', 'UNCHANGED', 'REJECTED');

-- AlterEnum
ALTER TYPE "FileClass" ADD VALUE 'SERVICE_IMPORT';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "ServiceRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ServiceRunStatus" NOT NULL DEFAULT 'UPLOADED',
    "failureReason" TEXT,
    "previewedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "billingEntryId" TEXT,

    CONSTRAINT "ServiceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRunRow" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "nameFa" TEXT NOT NULL,
    "nameEn" TEXT,
    "price" BIGINT,
    "stock" INTEGER,
    "action" "ServiceRowAction" NOT NULL,
    "rejectReason" TEXT,
    "raw" JSONB NOT NULL,

    CONSTRAINT "ServiceRunRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRun_fileId_key" ON "ServiceRun"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRun_billingEntryId_key" ON "ServiceRun"("billingEntryId");

-- CreateIndex
CREATE INDEX "ServiceRun_projectId_createdAt_idx" ON "ServiceRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceRunRow_runId_rowNumber_idx" ON "ServiceRunRow"("runId", "rowNumber");

-- CreateIndex
CREATE INDEX "StoredFile_projectId_idx" ON "StoredFile"("projectId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_billingEntryId_fkey" FOREIGN KEY ("billingEntryId") REFERENCES "BillingEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRunRow" ADD CONSTRAINT "ServiceRunRow_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ServiceRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The "declined-because" shape, held at the database (build plan L7's
-- banked trap: rejected rows must carry a reason, not merely a status).
ALTER TABLE "ServiceRun" ADD CONSTRAINT "ServiceRun_failure_reason_required" CHECK (
  ("status" = 'FAILED') = ("failureReason" IS NOT NULL)
);

ALTER TABLE "ServiceRunRow" ADD CONSTRAINT "ServiceRunRow_reject_reason_required" CHECK (
  ("action" = 'REJECTED') = ("rejectReason" IS NOT NULL)
);

-- Widen the private-file ownership CHECK (first written in
-- 20260803085059_stored_files) to accept a project as an equally-valid
-- owner alongside a contract — SERVICE_IMPORT is PRIVATE and owned by a
-- Project, never a Contract.
ALTER TABLE "StoredFile" DROP CONSTRAINT "StoredFile_private_has_owner";
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_private_has_owner"
  CHECK ("visibility" <> 'PRIVATE' OR "contractId" IS NOT NULL OR "projectId" IS NOT NULL);
