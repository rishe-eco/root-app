-- CreateEnum
CREATE TYPE "FileVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "FileClass" AS ENUM ('DESIGN_IMAGE', 'RESEARCH_TEXT');

-- AlterTable
ALTER TABLE "DesignConcept" ADD COLUMN     "imageFileId" TEXT;

-- AlterTable
ALTER TABLE "PageDesign" ADD COLUMN     "imageFileId" TEXT;

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "class" "FileClass" NOT NULL,
    "visibility" "FileVisibility" NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "contractId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_key_key" ON "StoredFile"("key");

-- CreateIndex
CREATE INDEX "StoredFile_contractId_idx" ON "StoredFile"("contractId");

-- CreateIndex
CREATE INDEX "StoredFile_class_visibility_idx" ON "StoredFile"("class", "visibility");

-- AddForeignKey
ALTER TABLE "DesignConcept" ADD CONSTRAINT "DesignConcept_imageFileId_fkey" FOREIGN KEY ("imageFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageDesign" ADD CONSTRAINT "PageDesign_imageFileId_fkey" FOREIGN KEY ("imageFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A private file is authorised by asking who owns the contract it belongs to.
-- Without a contract there is no question to ask and no answer that is safe to
-- give, so the row must not exist. Prisma's schema language cannot state this,
-- which is the only reason it is hand-written here rather than generated.
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_private_has_owner"
  CHECK ("visibility" <> 'PRIVATE' OR "contractId" IS NOT NULL);
