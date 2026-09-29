-- J3 — steps, sequence, the wizard shell, internal notes (journeys build plan
-- §5 "J3"). Generated with `prisma migrate diff` and read; hand-extended in
-- two places, both marked below.

-- CreateEnum
CREATE TYPE "ContractSequence" AS ENUM ('DESIGN_FIRST', 'AGREEMENT_FIRST');

-- CreateEnum
CREATE TYPE "StepKind" AS ENUM ('REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO', 'SUMMARY');

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "plannedEndAt" DATE,
ADD COLUMN     "plannedStartAt" DATE,
-- HAND-EDITED (PD-7): Prisma wrote `DEFAULT 'AGREEMENT_FIRST'` here, which
-- would backfill every existing contract onto the road that has no panels yet.
-- Every contract that exists before this migration is DESIGN_FIRST and keeps
-- running on today's gate, so the column is added with that default (Postgres
-- fills existing rows from it) and the default is then moved to the value the
-- schema declares for contracts created from here on.
ADD COLUMN     "sequence" "ContractSequence" NOT NULL DEFAULT 'DESIGN_FIRST';

ALTER TABLE "Contract" ALTER COLUMN "sequence" SET DEFAULT 'AGREEMENT_FIRST';

-- CreateTable
CREATE TABLE "StepApproval" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "step" "StepKind" NOT NULL,
    "phaseId" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT NOT NULL,

    CONSTRAINT "StepApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalNote" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepApproval_contractId_idx" ON "StepApproval"("contractId");

-- CreateIndex
CREATE INDEX "InternalNote_contractId_createdAt_idx" ON "InternalNote"("contractId", "createdAt");

-- AddForeignKey
ALTER TABLE "StepApproval" ADD CONSTRAINT "StepApproval_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepApproval" ADD CONSTRAINT "StepApproval_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepApproval" ADD CONSTRAINT "StepApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN — Prisma cannot express a partial unique index, and
-- `NULLS NOT DISTINCT` (the alternative) is Postgres 15+ while development has
-- run on 14. A step is approved once per contract, and a demo once per phase:
-- a plain UNIQUE (contractId, step, phaseId) would let any number of
-- NULL-phase rows through, because NULLs are distinct — so the two cases get
-- one index each. Each is proven by a direct insert in j3.test.ts.
CREATE UNIQUE INDEX "StepApproval_one_per_step" ON "StepApproval"("contractId", "step") WHERE "phaseId" IS NULL;

CREATE UNIQUE INDEX "StepApproval_one_per_step_phase" ON "StepApproval"("contractId", "step", "phaseId") WHERE "phaseId" IS NOT NULL;
