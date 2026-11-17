-- DX4 review: NOT VALID. Postgres enforces each CHECK on every insert and update from
-- now on but does not scan the rows already there. Every create path required both
-- languages before DX4, and the founder's dev database has no row with both blank, but
-- production can't be read from here, and a failed migration stops the container from
-- booting (deploy/README.md). An old row with both blank (if any) stays readable and
-- is refused only when someone edits it without giving a title.

-- DX4: a title in one language is enough (desk UX review item 26, decision log
-- rows 20-21). The columns stay NOT NULL text; one of the pair may be '' and the
-- other must say something. No schema change for Prisma to generate, so this
-- file is wholly hand-written (house rule 11: Prisma cannot express a CHECK).
-- Existing rows already have both languages, so there is no backfill and the
-- constraints validate at once. Each is proven by a direct insert in
-- apps/api/src/test/dx4.test.ts. btrim() strips spaces only, which is what the
-- API's trim() will have stripped before it got here; the API is the first gate
-- (lib/titles.ts), this is the backstop.

ALTER TABLE "Contract"
  ADD CONSTRAINT "Contract_one_title" CHECK (btrim("titleFa") <> '' OR btrim("titleEn") <> '') NOT VALID;

ALTER TABLE "Article"
  ADD CONSTRAINT "Article_one_title" CHECK (btrim("titleFa") <> '' OR btrim("titleEn") <> '') NOT VALID;

ALTER TABLE "Amendment"
  ADD CONSTRAINT "Amendment_one_title" CHECK (btrim("titleFa") <> '' OR btrim("titleEn") <> '') NOT VALID;

ALTER TABLE "Phase"
  ADD CONSTRAINT "Phase_one_title" CHECK (btrim("titleFa") <> '' OR btrim("titleEn") <> '') NOT VALID;

ALTER TABLE "ScopeItem"
  ADD CONSTRAINT "ScopeItem_one_title" CHECK (btrim("labelFa") <> '' OR btrim("labelEn") <> '') NOT VALID;

ALTER TABLE "PlannedInvoice"
  ADD CONSTRAINT "PlannedInvoice_one_title" CHECK (btrim("labelFa") <> '' OR btrim("labelEn") <> '') NOT VALID;

ALTER TABLE "Dependency"
  ADD CONSTRAINT "Dependency_one_title" CHECK (btrim("titleFa") <> '' OR btrim("titleEn") <> '') NOT VALID;

ALTER TABLE "DemoPage"
  ADD CONSTRAINT "DemoPage_one_title" CHECK (btrim("labelFa") <> '' OR btrim("labelEn") <> '') NOT VALID;

ALTER TABLE "PageDesign"
  ADD CONSTRAINT "PageDesign_one_title" CHECK (btrim("labelFa") <> '' OR btrim("labelEn") <> '') NOT VALID;
