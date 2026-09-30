-- Journeys build plan J7 (owed from J4) — an amendment's body can carry money in
-- prose, so it gets the same withholding an article's does. One column; the
-- backfill marks the amendments that already point at a sensitive article (the
-- only ones a rule could have identified), everything else stays false — an
-- amendment that talks about money without pointing at an article is for the
-- desk to mark. No CHECK, no index.

-- AlterTable
ALTER TABLE "Amendment" ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false;

-- BACKFILL: an amendment relating to a sensitive article of its own contract is sensitive.
UPDATE "Amendment" a
SET "sensitive" = true
FROM "ContractRevision" r
JOIN "Article" ar ON ar."contractId" = r."contractId"
WHERE a."contractRevisionId" = r."id"
  AND a."relatesToArticle" IS NOT NULL
  AND ar."number" = a."relatesToArticle"
  AND ar."sensitive";
