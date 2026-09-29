-- S3 — tool grants (journeys build plan §5 "S3"). A customer can use a tool
-- only while an active row here says so; L7's product-import panel is the
-- first (and, today, only) tool.
--
-- Generated with `prisma migrate diff` and read; hand-extended once, marked
-- below. No backfill: production holds no customers (plan P0-1), and the seed
-- grants PRODUCT_IMPORT to the seeded customer so L7's suites keep passing.

-- CreateEnum
CREATE TYPE "ToolKey" AS ENUM ('PRODUCT_IMPORT');

-- CreateTable
CREATE TABLE "ToolGrant" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tool" "ToolKey" NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "ToolGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolGrant_customerId_idx" ON "ToolGrant"("customerId");

-- AddForeignKey
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolGrant" ADD CONSTRAINT "ToolGrant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HAND-WRITTEN — Prisma cannot express a partial unique index. At most one
-- *active* grant per (customer, tool): a revoked row is history and a
-- re-grant is a new row, so uniqueness has to ignore the revoked ones. This
-- is what makes `grantTool` safe under a double click — the second insert
-- loses to the index instead of leaving two active rows for one `revokeTool`
-- to half-revoke. Same shape as DesignRevision_one_draft_per_contract.
CREATE UNIQUE INDEX "ToolGrant_one_active_per_tool" ON "ToolGrant"("customerId", "tool") WHERE "revokedAt" IS NULL;
