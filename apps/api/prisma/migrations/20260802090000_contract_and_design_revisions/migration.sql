-- Two independent revision lineages per contract, plus amendments.
--
-- Hand-written rather than generated, because the DDL and the one-shot backfill
-- have to interleave: the new columns cannot be NOT NULL until existing rows
-- have been re-parented, and `Signature` has to move off the contract before
-- the old column can go. Everything below is idempotent-safe in the sense that
-- it runs exactly once, inside Prisma's transaction — either all of it lands or
-- none of it does.
--
-- What it deliberately does NOT do: build the contract snapshot or its hash.
-- Canonical serialization lives in `src/lib/revision.ts`, and reproducing it in
-- SQL would fork the one piece of logic that must never have two versions.
-- Backfilled revisions land unsealed (`snapshot` / `contentHash` null) and
-- `npm run backfill --workspace=apps/api` seals them.

-- ---------------------------------------------------------------------------
-- 1. New change-log actions
-- ---------------------------------------------------------------------------
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new value
-- is not used in the same transaction. Nothing below uses them.

ALTER TYPE "ChangeAction" ADD VALUE 'CONTRACT_REVISED';
ALTER TYPE "ChangeAction" ADD VALUE 'DESIGN_REVISED';
ALTER TYPE "ChangeAction" ADD VALUE 'CONTRACT_AMENDED';
ALTER TYPE "ChangeAction" ADD VALUE 'RE_APPROVED';
ALTER TYPE "ChangeAction" ADD VALUE 'RE_SIGNED';
ALTER TYPE "ChangeAction" ADD VALUE 'AMENDMENT_SIGNED';

-- ---------------------------------------------------------------------------
-- 2. The new tables
-- ---------------------------------------------------------------------------

CREATE TABLE "ContractRevision" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB,
    "contentHash" TEXT,
    "publishedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DesignRevision" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Amendment" (
    "id" TEXT NOT NULL,
    "contractRevisionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "bodyFa" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Amendment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContractRevision_contractId_version_key" ON "ContractRevision"("contractId", "version");
CREATE UNIQUE INDEX "DesignRevision_contractId_version_key" ON "DesignRevision"("contractId", "version");
CREATE UNIQUE INDEX "Amendment_contractRevisionId_ordinal_key" ON "Amendment"("contractRevisionId", "ordinal");

ALTER TABLE "ContractRevision" ADD CONSTRAINT "ContractRevision_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesignRevision" ADD CONSTRAINT "DesignRevision_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Amendment" ADD CONSTRAINT "Amendment_contractRevisionId_fkey" FOREIGN KEY ("contractRevisionId") REFERENCES "ContractRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. New columns, nullable for now so the backfill has somewhere to write
-- ---------------------------------------------------------------------------

ALTER TABLE "Contract"
    ADD COLUMN "currentContractRevisionId" TEXT,
    ADD COLUMN "currentDesignRevisionId" TEXT;

ALTER TABLE "DesignConcept" ADD COLUMN "designRevisionId" TEXT;

ALTER TABLE "Signature"
    ADD COLUMN "contractRevisionId" TEXT,
    ADD COLUMN "amendmentId" TEXT,
    ADD COLUMN "signedHash" TEXT;

-- ---------------------------------------------------------------------------
-- 4. Backfill — every existing contract becomes v1 of both lineages
-- ---------------------------------------------------------------------------
-- Cheap now and progressively worse with every real contract, which is the
-- whole argument for landing this stage early.

-- v1 of each lineage. `gen_random_uuid()` rather than a cuid: these ids are
-- opaque, never shown, and only the application layer needs cuids.
INSERT INTO "ContractRevision" ("id", "contractId", "version", "publishedAt", "approvedAt", "createdAt")
SELECT gen_random_uuid()::text, c."id", 1, c."publishedAt", c."contractApprovedAt", c."createdAt"
FROM "Contract" c;

INSERT INTO "DesignRevision" ("id", "contractId", "version", "publishedAt", "createdAt")
SELECT gen_random_uuid()::text, c."id", 1, c."publishedAt", c."createdAt"
FROM "Contract" c;

-- Concepts (and, through them, their pages and page approvals) re-parent onto
-- the design revision. PageDesign itself is untouched — it follows its concept.
UPDATE "DesignConcept" dc
SET "designRevisionId" = dr."id"
FROM "DesignRevision" dr
WHERE dr."contractId" = dc."contractId" AND dr."version" = 1;

-- The live pair.
UPDATE "Contract" c
SET "currentContractRevisionId" = cr."id"
FROM "ContractRevision" cr
WHERE cr."contractId" = c."id" AND cr."version" = 1;

UPDATE "Contract" c
SET "currentDesignRevisionId" = dr."id"
FROM "DesignRevision" dr
WHERE dr."contractId" = c."id" AND dr."version" = 1;

-- A signature that stood against the contract now stands against v1 of its
-- text. `signedHash` stays null: that signature was made before content
-- hashing existed, and back-dating a hash onto it would assert something the
-- signer never saw.
UPDATE "Signature" s
SET "contractRevisionId" = cr."id"
FROM "ContractRevision" cr
WHERE cr."contractId" = s."contractId" AND cr."version" = 1;

-- ---------------------------------------------------------------------------
-- 5. Now the constraints can be tightened and the old shape dropped
-- ---------------------------------------------------------------------------

ALTER TABLE "DesignConcept" ALTER COLUMN "designRevisionId" SET NOT NULL;

ALTER TABLE "DesignConcept" DROP CONSTRAINT "DesignConcept_contractId_fkey";
DROP INDEX "DesignConcept_contractId_key_key";
ALTER TABLE "DesignConcept" DROP COLUMN "contractId";

ALTER TABLE "Signature" DROP CONSTRAINT "Signature_contractId_fkey";
DROP INDEX "Signature_contractId_key";
ALTER TABLE "Signature" DROP COLUMN "contractId";

-- Approval moves onto the revision it approved. There is no longer a way to
-- say "this contract is approved" in the abstract, which was the point.
ALTER TABLE "Contract" DROP COLUMN "contractApprovedAt";

CREATE UNIQUE INDEX "Contract_currentContractRevisionId_key" ON "Contract"("currentContractRevisionId");
CREATE UNIQUE INDEX "Contract_currentDesignRevisionId_key" ON "Contract"("currentDesignRevisionId");
CREATE UNIQUE INDEX "DesignConcept_designRevisionId_key_key" ON "DesignConcept"("designRevisionId", "key");
CREATE UNIQUE INDEX "Signature_contractRevisionId_key" ON "Signature"("contractRevisionId");
CREATE UNIQUE INDEX "Signature_amendmentId_key" ON "Signature"("amendmentId");

ALTER TABLE "Contract" ADD CONSTRAINT "Contract_currentContractRevisionId_fkey" FOREIGN KEY ("currentContractRevisionId") REFERENCES "ContractRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_currentDesignRevisionId_fkey" FOREIGN KEY ("currentDesignRevisionId") REFERENCES "DesignRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DesignConcept" ADD CONSTRAINT "DesignConcept_designRevisionId_fkey" FOREIGN KEY ("designRevisionId") REFERENCES "DesignRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_contractRevisionId_fkey" FOREIGN KEY ("contractRevisionId") REFERENCES "ContractRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "Amendment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A signature binds to exactly one instrument — a contract revision or an
-- amendment, never both and never neither. Prisma cannot express this, so it
-- lives here; without it "one signature per contract" is replaced by nothing.
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_one_instrument_check"
    CHECK (("contractRevisionId" IS NOT NULL) <> ("amendmentId" IS NOT NULL));
