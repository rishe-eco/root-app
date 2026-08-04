-- Roles become a set (build plan F3).
--
-- The two new enum values are added here but never *used* here: the backfill
-- only ever writes values that already existed. That is what makes this safe
-- in one transaction — Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a
-- transaction block precisely so long as the new value is not referenced
-- before commit. Adding a value is allowed; using it is not.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CONTRIBUTOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'REVIEWER';

-- Goes before the column it names. It was a b-tree over (role, state), and
-- neither half survives the move: `state` is filtered nowhere in the app, and
-- a b-tree cannot answer containment over an array.
DROP INDEX "User_role_state_idx";

ALTER TABLE "User" ADD COLUMN "roles" "Role"[] NOT NULL DEFAULT ARRAY['CUSTOMER']::"Role"[];

-- Every existing user holds exactly the one role they held before. Nobody
-- gains anything in the migration; the sets widen later, deliberately.
UPDATE "User" SET "roles" = ARRAY["role"];

ALTER TABLE "User" DROP COLUMN "role";

-- `cardinality`, not `array_length`. array_length(x, 1) returns NULL for an
-- empty array, and a CHECK that evaluates to NULL *passes* — the constraint
-- would admit exactly the row it exists to reject. cardinality returns 0.
ALTER TABLE "User" ADD CONSTRAINT "User_roles_non_empty" CHECK (cardinality("roles") > 0);

CREATE INDEX "User_roles_idx" ON "User" USING GIN ("roles");
