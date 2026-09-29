-- T1 — template types, scope templates, and `ScopeItem.kind` (journeys build
-- plan §5 "T1"). Three things: what kind each registry row is, which contract
-- agreed it (PD-5), and the two tables a designer and sales maintain the
-- site-type catalogue in.
--
-- Generated with `prisma migrate diff` and read. Hand-extended in three
-- places, each marked below: `kind` is added nullable so a database that
-- already holds rows can be backfilled before the column is made required
-- (Prisma emits `ADD COLUMN … NOT NULL`, which fails on the first existing
-- row); the backfill itself; and a CHECK Prisma cannot express.
--
-- Production holds no data (plan P0-1), but this migration must be correct on
-- a database that does — so the backfill is SQL here rather than a script, and
-- `t1.test.ts` runs *this block of this file* over fixture rows.

-- CreateEnum
CREATE TYPE "ScopeKind" AS ENUM ('PAGE', 'FEATURE', 'DELIVERABLE', 'EXTRA');

-- AlterTable — `kind` is nullable for now; see the SET NOT NULL below.
ALTER TABLE "ScopeItem" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "kind" "ScopeKind";

-- CreateTable
CREATE TABLE "TemplateType" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TemplateType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateScopeItem" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "ScopeKind" NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TemplateScopeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TemplateType_slug_key" ON "TemplateType"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateScopeItem_typeId_key_key" ON "TemplateScopeItem"("typeId", "key");

-- CreateIndex
CREATE INDEX "ScopeItem_contractId_idx" ON "ScopeItem"("contractId");

-- AddForeignKey
ALTER TABLE "ScopeItem" ADD CONSTRAINT "ScopeItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateScopeItem" ADD CONSTRAINT "TemplateScopeItem_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "TemplateType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: a template's list holds pages, features and deliverables —
-- `EXTRA` is the completeness checklist's kind, and the checklist is seeded at
-- project creation, never from a template. The resolver refuses it too; this
-- is the backstop for anything that writes around the resolver.
ALTER TABLE "TemplateScopeItem"
  ADD CONSTRAINT "TemplateScopeItem_kind_not_extra" CHECK ("kind" <> 'EXTRA');

-- BACKFILL:BEGIN
-- Hand-written. `t1.test.ts` extracts everything between the BEGIN and END
-- markers and runs it over fixture rows; keep every statement of the backfill
-- inside them, and keep it free of anything but UPDATEs on "ScopeItem".

-- The kind. `checklist.*` are the completeness checklist's rows (EXTRA); the
-- four keys below are `PAGES` in `src/lib/templates.ts` (a unit test fails if
-- the two lists drift); everything else is a FEATURE. `scopeKindForKey` is the
-- same rule for rows created after this migration.
UPDATE "ScopeItem"
SET "kind" = CASE
  WHEN "key" LIKE 'checklist.%' THEN 'EXTRA'::"ScopeKind"
  WHEN "key" IN ('home', 'about', 'contracts', 'portal') THEN 'PAGE'::"ScopeKind"
  ELSE 'FEATURE'::"ScopeKind"
END;

-- The agreement. Every row — EXTRA and not-yet-agreed rows too — gets its
-- project's first contract: the earliest by `createdAt`, exactly what
-- `firstContractId` (resolvers/admin/shared.ts) returns. That function leaves
-- a tie undefined; `id` breaks it here so the backfill is deterministic. A
-- project with no contract leaves the column NULL, which is the column's
-- honest value for "no agreement yet".
UPDATE "ScopeItem" AS s
SET "contractId" = (
  SELECT c."id"
  FROM "Contract" AS c
  WHERE c."projectId" = s."projectId"
  ORDER BY c."createdAt" ASC, c."id" ASC
  LIMIT 1
);
-- BACKFILL:END

-- Every row has a kind now; make it required, as schema.prisma says.
ALTER TABLE "ScopeItem" ALTER COLUMN "kind" SET NOT NULL;
