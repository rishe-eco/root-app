-- T2 — the theme catalogue (journeys build plan §5 "T2 + J8", the catalogue
-- half only). `Theme` and `TemplateTypeTheme`, one new `FileClass`
-- (`THEME_PREVIEW`), and `StoredFile` grows a third optional owning edge
-- (`themeId`) beside `contractId` and `projectId`. Nothing on a contract
-- changes: `DesignConcept.themeId`, the rounds and the palette are J8's.
--
-- Generated with `prisma migrate diff --from-migrations … --to-schema-datamodel
-- … --shadow-database-url <shadow> --script` and read; the only hand-written
-- part is the CHECK at the bottom, which Prisma cannot express. `Theme` and
-- `TemplateTypeTheme` are brand-new and start empty, and the one new column on
-- an existing table (`StoredFile.themeId`) is nullable, so there is no
-- NOT NULL-with-no-default backfill to write.
--
-- **Invariant change — the second widening of `StoredFile_private_has_owner`**
-- (written in `20260803085059_stored_files`, widened once in
-- `20260921160000_l7_services`). A PRIVATE file must still name an owner it can
-- be authorised against, and there are now three: a contract, a project, or a
-- theme. Without this, the first THEME_PREVIEW row — PRIVATE, owned by a
-- theme, with neither `contractId` nor `projectId` — would violate the L7
-- form. What stays true: a private file with *no* owner is still refused. What
-- changes: "has an owner" now includes a theme. `t2.test.ts` proves both by
-- direct insert.

-- CreateEnum
CREATE TYPE "RtlSupport" AS ENUM ('FULL', 'PARTIAL', 'NONE', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "FileClass" ADD VALUE 'THEME_PREVIEW';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "themeId" TEXT;

-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT,
    "demoUrl" TEXT,
    "previewFileId" TEXT,
    "rtlSupport" "RtlSupport" NOT NULL DEFAULT 'UNKNOWN',
    "licenseCost" BIGINT,
    "notesFa" TEXT,
    "notesEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateTypeTheme" (
    "typeId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,

    CONSTRAINT "TemplateTypeTheme_pkey" PRIMARY KEY ("typeId","themeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Theme_previewFileId_key" ON "Theme"("previewFileId");

-- CreateIndex
CREATE INDEX "TemplateTypeTheme_themeId_idx" ON "TemplateTypeTheme"("themeId");

-- CreateIndex
CREATE INDEX "StoredFile_themeId_idx" ON "StoredFile"("themeId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Theme" ADD CONSTRAINT "Theme_previewFileId_fkey" FOREIGN KEY ("previewFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateTypeTheme" ADD CONSTRAINT "TemplateTypeTheme_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "TemplateType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateTypeTheme" ADD CONSTRAINT "TemplateTypeTheme_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Widen the private-file ownership CHECK (L7's form) to accept a theme as a
-- third valid owner — THEME_PREVIEW is PRIVATE and owned by a Theme, never a
-- Contract or a Project.
ALTER TABLE "StoredFile" DROP CONSTRAINT "StoredFile_private_has_owner";
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_private_has_owner"
  CHECK ("visibility" <> 'PRIVATE' OR "contractId" IS NOT NULL OR "projectId" IS NOT NULL OR "themeId" IS NOT NULL);
