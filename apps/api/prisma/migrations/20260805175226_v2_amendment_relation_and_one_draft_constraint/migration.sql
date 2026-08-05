-- AlterEnum
ALTER TYPE "ChangeAction" ADD VALUE 'AMENDMENT_APPROVED';

-- AlterTable
ALTER TABLE "Amendment" ADD COLUMN     "relatesToArticle" INTEGER;

-- Defect D5: nothing enforced "at most one unpublished design revision per
-- contract", which resolvers/contracts.ts's draftDesignRevision assumes
-- ("There is at most one"). Prisma cannot express a partial unique index —
-- @@unique([contractId]) would forbid more than one *published* revision too
-- — so this is hand-written, the same route the three existing CHECK
-- constraints took.
CREATE UNIQUE INDEX "DesignRevision_one_draft_per_contract" ON "DesignRevision"("contractId") WHERE "publishedAt" IS NULL;
