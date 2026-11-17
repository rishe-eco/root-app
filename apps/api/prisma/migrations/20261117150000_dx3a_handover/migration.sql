-- DX3a — handover items: one list, edited from Requirements and the Dependencies tab.
--
-- The `Dependency` row *is* the handover item. The brief's three provider
-- columns become rows, a desk-managed default list seeds new briefs, and the
-- columns are dropped — after the backfill, in this order: add, copy, drop.

-- CreateTable
CREATE TABLE "HandoverItemType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "technical" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HandoverItemType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HandoverItemType_key_key" ON "HandoverItemType"("key");

-- The default list, as `COMMITMENTS` (lib/brief.ts) names the three: the domain
-- and the host are technical (a developer checks them), the content is not.
INSERT INTO "HandoverItemType" ("id", "key", "titleFa", "titleEn", "technical", "position") VALUES
  ('handover_type_domain', 'domain', 'دامنه‌ی وب‌سایت', 'Website domain', true, 0),
  ('handover_type_host', 'host', 'میزبانی وب‌سایت', 'Website hosting', true, 1),
  ('handover_type_content', 'content', 'محتوای وب‌سایت (متن و تصویر)', 'Website content (text and images)', false, 2);

-- AlterTable
ALTER TABLE "Dependency" ADD COLUMN     "inBrief" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notNeeded" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "side" DROP NOT NULL,
ALTER COLUMN "dueAt" DROP NOT NULL;

-- Backfill 1: every row the brief already owned (domain, host, content, and the
-- extras' gateway, smsLine, enamad) is now part of the requirements. Such a row
-- keeps the side and the date it has — the board's row was already what the
-- brief's sync wrote.
UPDATE "Dependency" SET "inBrief" = true WHERE "briefKey" IS NOT NULL;

-- Backfill 2: for each project, each of the three keys that has no row yet gets
-- one, on the side the brief named (null when it named none), undated. One row
-- per (project, key) however many contracts the project has: the brief that
-- names a side wins over one that does not, then the earliest.
-- `createdById` is required: the earliest admin (the contract has no creator to
-- name), else the earliest user. A database with briefs has an admin.
WITH creator AS (
  SELECT "id" FROM "User"
  ORDER BY ('ADMIN'::"Role" = ANY("roles")) DESC, "createdAt" ASC, "id" ASC
  LIMIT 1
),
provided AS (
  SELECT c."projectId", b."createdAt", k.key, k.side
  FROM "ContractBrief" b
  JOIN "Contract" c ON c."id" = b."contractId"
  CROSS JOIN LATERAL (VALUES
    ('domain', b."domainProvidedBy"),
    ('host', b."hostProvidedBy"),
    ('content', b."contentProvidedBy")
  ) AS k(key, side)
  WHERE c."status"::text <> 'DISCARDED'
),
chosen AS (
  SELECT DISTINCT ON ("projectId", key) "projectId", key, side
  FROM provided
  ORDER BY "projectId", key, (side IS NULL), "createdAt" ASC
)
INSERT INTO "Dependency" ("id", "projectId", "side", "titleFa", "titleEn", "dueAt", "createdById", "briefKey", "technical", "inBrief")
SELECT gen_random_uuid()::text, ch."projectId", ch.side, t."titleFa", t."titleEn", NULL, (SELECT "id" FROM creator), ch.key, t."technical", true
FROM chosen ch
JOIN "HandoverItemType" t ON t."key" = ch.key
WHERE NOT EXISTS (
  SELECT 1 FROM "Dependency" d WHERE d."projectId" = ch."projectId" AND d."briefKey" = ch.key
);

-- AlterTable
ALTER TABLE "ContractBrief" DROP COLUMN "contentProvidedBy",
DROP COLUMN "domainProvidedBy",
DROP COLUMN "hostProvidedBy";

-- A row that is only on the board still needs a side and a date, as it always
-- did; only a row that is part of the requirements may be undecided or undated.
-- Hand-written (house rule 11): Prisma cannot express a CHECK. Proven by direct
-- insert in dx3a.test.ts. Booleans here are NOT NULL, so the OR cannot go NULL.
ALTER TABLE "Dependency"
  ADD CONSTRAINT "Dependency_board_row_complete" CHECK ("inBrief" OR ("side" IS NOT NULL AND "dueAt" IS NOT NULL));
