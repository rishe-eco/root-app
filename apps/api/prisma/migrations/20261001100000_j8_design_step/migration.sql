-- J8 — step 4, design (journeys build plan §5 "T2 + J8", the J8 half): a
-- pre-made round's concept is a theme (`DesignConcept.themeId` / `themeSnapshot`),
-- a custom design has a palette (`PaletteKind`, `DesignPaletteItem`), the
-- palette item becomes something feedback can point at (`FeedbackItem.paletteItemId`
-- gains the foreign key S2 left off), the customer's "show me other options"
-- gets its marker (`FeedbackItem.otherOptionsAskedAt`), and an allowance can be
-- extended (`AllowanceExtension`). The catalogue itself (`Theme`,
-- `TemplateTypeTheme`, `THEME_PREVIEW`, the widened private-file CHECK) is T2's
-- and is not touched here.
--
-- Generated with `prisma migrate diff --from-schema-datamodel <main> --to-schema-datamodel
-- <this> --script` and read. Every new table starts empty and every new column
-- on an existing table is nullable, so there is no backfill and no NOT NULL
-- without a default to write. The one foreign key onto existing rows is
-- `FeedbackItem.paletteItemId` -> `DesignPaletteItem`: the column existed and
-- nothing could write a meaningful value into it (there was no palette), so no
-- row can be left dangling — if one is, this statement fails loudly, which is
-- the right answer to a row that points at nothing.
--
-- The two hand-written CHECKs are at the bottom, each proven by a direct insert
-- in `j8.test.ts` (the CHECK-proven-by-insert rule):
--
--   * `AllowanceExtension_extra_positive` — an extension adds at least one
--     round. `extra` is NOT NULL, so unlike the brief's "when set" allowances
--     there is no NULL reading to worry about.
--   * `DesignPaletteItem_color_is_hex` — a COLOR's value is `#` and six
--     lowercase hex digits. `kind <> 'COLOR' OR …` rather than a bare regex,
--     because the same column holds a font's name and a logo note; and it
--     evaluates to TRUE, not NULL, for every non-colour row.

-- CreateEnum
CREATE TYPE "PaletteKind" AS ENUM ('COLOR', 'FONT', 'LOGO_USAGE');

-- AlterTable
ALTER TABLE "DesignConcept" ADD COLUMN     "themeId" TEXT,
ADD COLUMN     "themeSnapshot" JSONB;

-- AlterTable
ALTER TABLE "FeedbackItem" ADD COLUMN     "otherOptionsAskedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DesignPaletteItem" (
    "id" TEXT NOT NULL,
    "designRevisionId" TEXT NOT NULL,
    "kind" "PaletteKind" NOT NULL,
    "role" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "imageFileId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DesignPaletteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllowanceExtension" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "step" "StepKind" NOT NULL,
    "phaseId" TEXT,
    "extra" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "billingEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllowanceExtension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignPaletteItem_designRevisionId_position_idx" ON "DesignPaletteItem"("designRevisionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DesignPaletteItem_designRevisionId_kind_role_key" ON "DesignPaletteItem"("designRevisionId", "kind", "role");

-- CreateIndex
CREATE UNIQUE INDEX "AllowanceExtension_billingEntryId_key" ON "AllowanceExtension"("billingEntryId");

-- CreateIndex
CREATE INDEX "AllowanceExtension_contractId_step_idx" ON "AllowanceExtension"("contractId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "DesignConcept_designRevisionId_themeId_key" ON "DesignConcept"("designRevisionId", "themeId");

-- AddForeignKey
ALTER TABLE "DesignConcept" ADD CONSTRAINT "DesignConcept_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignPaletteItem" ADD CONSTRAINT "DesignPaletteItem_designRevisionId_fkey" FOREIGN KEY ("designRevisionId") REFERENCES "DesignRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignPaletteItem" ADD CONSTRAINT "DesignPaletteItem_imageFileId_fkey" FOREIGN KEY ("imageFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowanceExtension" ADD CONSTRAINT "AllowanceExtension_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowanceExtension" ADD CONSTRAINT "AllowanceExtension_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowanceExtension" ADD CONSTRAINT "AllowanceExtension_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowanceExtension" ADD CONSTRAINT "AllowanceExtension_billingEntryId_fkey" FOREIGN KEY ("billingEntryId") REFERENCES "BillingEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_paletteItemId_fkey" FOREIGN KEY ("paletteItemId") REFERENCES "DesignPaletteItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: constraints Prisma cannot express (house rule 11).
ALTER TABLE "AllowanceExtension"
  ADD CONSTRAINT "AllowanceExtension_extra_positive" CHECK ("extra" > 0);

ALTER TABLE "DesignPaletteItem"
  ADD CONSTRAINT "DesignPaletteItem_color_is_hex" CHECK ("kind" <> 'COLOR' OR "value" ~ '^#[0-9a-f]{6}$');
