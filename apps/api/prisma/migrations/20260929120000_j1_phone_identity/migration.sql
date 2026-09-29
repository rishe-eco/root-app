-- J1 — phone identity, SMS, the notification router, rate limits, the staff
-- second factor (journeys build plan §5 "J1"). `prisma migrate dev
-- --create-only` refuses to run in this non-interactive shell, so this file
-- was produced the equivalent way: `prisma migrate diff --from-url
-- <this checkout's own already-migrated database> --to-schema-datamodel
-- schema.prisma --script`, against the same starting point `migrate dev`
-- would have diffed from, then read and hand-extended exactly as house rule
-- 11 asks. `prisma migrate diff` (no drift) is how this was verified below.
--
-- Two `ADD VALUE`s to `TokenPurpose` in one migration, same as S1's own
-- migration: fine on Postgres 12+ (this runs 16) as long as neither is used
-- in the same transaction, and nothing here does.

-- CreateEnum
CREATE TYPE "SmsPurpose" AS ENUM ('INVITE', 'LOGIN_CODE', 'SIGNIN_FACTOR', 'NOTIFY');

-- AlterEnum
ALTER TYPE "TokenPurpose" ADD VALUE 'LOGIN_CODE';
ALTER TYPE "TokenPurpose" ADD VALUE 'SIGNIN_FACTOR';

-- AlterTable
ALTER TABLE "AuthToken" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- Hand-added (house rule 11): Prisma has no way to express "at least one of
-- these two columns is set." Without it, `email` becoming optional would
-- silently admit a row reachable by neither identifier — an account nothing,
-- not even the set-phone recovery CLI, could ever sign into.
ALTER TABLE "User" ADD CONSTRAINT "User_has_identifier" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "toPhone" TEXT NOT NULL,
    "purpose" "SmsPurpose" NOT NULL,
    "providerRef" TEXT,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsLog_userId_idx" ON "SmsLog"("userId");

-- CreateIndex
CREATE INDEX "SmsLog_toPhone_idx" ON "SmsLog"("toPhone");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- AddForeignKey
ALTER TABLE "SmsLog" ADD CONSTRAINT "SmsLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
