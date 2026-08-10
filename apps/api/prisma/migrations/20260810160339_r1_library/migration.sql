-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('PAPER', 'BOOK', 'ARTICLE', 'ROOT_RESEARCH');

-- CreateEnum
CREATE TYPE "TranslationProvenance" AS ENUM ('PUBLISHED', 'ROOT', 'NONE_YET');

-- CreateEnum
CREATE TYPE "RightsBasis" AS ENUM ('PUBLIC_DOMAIN', 'OPEN_LICENCE', 'PERMISSION_GRANTED', 'LINK_ONLY');

-- CreateEnum
CREATE TYPE "EntryVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "LibraryEntry" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "EntryType" NOT NULL,
    "originalLang" TEXT NOT NULL,
    "titleOriginal" TEXT NOT NULL,
    "authors" TEXT NOT NULL,
    "venue" TEXT,
    "year" INTEGER,
    "doi" TEXT,
    "sourceUrl" TEXT,
    "abstractOriginal" TEXT,
    "translationProvenance" "TranslationProvenance" NOT NULL,
    "titleTranslated" TEXT,
    "abstractTranslated" TEXT,
    "translationCredit" TEXT,
    "rightsBasis" "RightsBasis" NOT NULL,
    "rightsNote" TEXT,
    "fullTextFileId" TEXT,
    "visibility" "EntryVisibility" NOT NULL DEFAULT 'PUBLIC',
    "publishedAt" TIMESTAMP(3),
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryConcept" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "titleFa" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryEntryConcept" (
    "entryId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,

    CONSTRAINT "LibraryEntryConcept_pkey" PRIMARY KEY ("entryId","conceptId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibraryEntry_slug_key" ON "LibraryEntry"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryEntry_fullTextFileId_key" ON "LibraryEntry"("fullTextFileId");

-- CreateIndex
CREATE INDEX "LibraryEntry_publishedAt_visibility_idx" ON "LibraryEntry"("publishedAt", "visibility");

-- CreateIndex
CREATE INDEX "LibraryEntry_type_idx" ON "LibraryEntry"("type");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryConcept_slug_key" ON "LibraryConcept"("slug");

-- CreateIndex
CREATE INDEX "LibraryEntryConcept_conceptId_idx" ON "LibraryEntryConcept"("conceptId");

-- AddForeignKey
ALTER TABLE "LibraryEntry" ADD CONSTRAINT "LibraryEntry_fullTextFileId_fkey" FOREIGN KEY ("fullTextFileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryEntry" ADD CONSTRAINT "LibraryEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryEntryConcept" ADD CONSTRAINT "LibraryEntryConcept_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibraryEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryEntryConcept" ADD CONSTRAINT "LibraryEntryConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "LibraryConcept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added (R1.md §1.1, §3.1): the rule that shapes the whole schema, as one
-- CHECK on one row. A hosted file may exist only when the entry is PUBLIC and
-- its rights basis is not LINK_ONLY — this refuses the bad INSERT and, just as
-- importantly, the bad UPDATE: flipping a hosted entry to LINK_ONLY or PRIVATE
-- fails here unless fullTextFileId is cleared first, which forces the
-- mutation to deal with the bytes (see resolvers/library.ts) rather than
-- silently orphaning them.
ALTER TABLE "LibraryEntry" ADD CONSTRAINT "LibraryEntry_hosted_text_is_publishable"
  CHECK (
    "fullTextFileId" IS NULL
    OR ("rightsBasis" <> 'LINK_ONLY' AND "visibility" = 'PUBLIC')
  );

-- Hand-added (R1.md §3.2, §5.2): fold Persian/Arabic orthographic variants so
-- text compares equal to itself. Not a stemmer — the search problem here is
-- that the same word is routinely stored as several different byte sequences
-- (Arabic vs. Persian yeh/kaf, hamza-bearing alefs, ZWNJ, tatweel, harakat,
-- Arabic-Indic vs. Persian digits), and Postgres has no opinion about any of
-- it. IMMUTABLE because a generated column or an index would require it, and
-- because it genuinely is: same input, same output, forever.
--
-- The two translate() arguments are verified equal in character length by
-- lib/library.test.ts (26 each) — translate() maps position to position and
-- silently *deletes* any character in the first string with no partner in
-- the second, so a miscount would quietly remove letters from the corpus
-- rather than error.
CREATE OR REPLACE FUNCTION library_fold(t text) RETURNS text AS $$
  SELECT lower(
    translate(
      regexp_replace(coalesce(t, ''), '[ً-ْـ‌]', '', 'g'),
      'ىيكأإآ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'ییکااا01234567890123456789'
    )
  );
$$ LANGUAGE sql IMMUTABLE STRICT;
