-- L6 — billing: subscriptions, invoices, the report (build plan §3 "L6";
-- spec §8). `BillingEntry` existed and was unsurfaced; this stage grows it
-- rather than replacing it, and adds one new table (`Subscription`) and one
-- new enum (`SubscriptionPeriod`) beside the enum value it adds to the
-- existing `BillingSource`.
--
-- **Hand-authored, cross-checked against `prisma migrate diff
-- --from-schema-datamodel <pre-L6> --to-schema-datamodel <post-L6>`, not
-- pasted from it** — same discipline as every prior stage. No correction for
-- a NOT NULL-with-no-default trap was needed: `Subscription` is a brand-new
-- table and starts empty, and every new column on `BillingEntry`
-- (subscriptionId, periodStart, periodEnd, phaseId, ticketId) is nullable —
-- a pre-existing entry has none of these and stays legitimately absent
-- forever for most rows (only a SUBSCRIPTION-sourced entry ever sets the
-- first three; only a TICKET-sourced entry converted from a billable ticket
-- ever sets the last).
--
-- `ALTER TYPE … ADD VALUE` runs first and nothing in this file's own DDL
-- reads `SUBSCRIPTION` in the same transaction, so there is no
-- add-then-read-in-one-transaction hazard (checked, not assumed — the same
-- note L4's migration recorded for `ADMIN_REQUEST`).
--
-- What the raw diff cannot express, and this file adds by hand: nothing.
-- Unlike L1/L4/L5's CHECK constraints, this stage's one correctness rule —
-- "a subscription's period is billed at most once" — **is** expressible as a
-- plain unique index (`BillingEntry_subscriptionId_periodStart_key` below),
-- because it is a uniqueness rule, not a "these columns agree" rule. Prisma
-- emits it on its own; there is no gap here to fill by hand.

-- CreateEnum
CREATE TYPE "SubscriptionPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- AlterEnum
ALTER TYPE "BillingSource" ADD VALUE 'SUBSCRIPTION';

-- AlterTable
ALTER TABLE "BillingEntry" ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "phaseId" TEXT,
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "ticketId" TEXT;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "period" "SubscriptionPeriod" NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "activeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");

-- CreateIndex
CREATE INDEX "Subscription_projectId_idx" ON "Subscription"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEntry_ticketId_key" ON "BillingEntry"("ticketId");

-- CreateIndex — the banked trap, held at the database and not only in the
-- lazy generator's own read-then-write: two concurrent requests computing
-- the same due period can each attempt the insert, but only one survives.
-- `ensureSubscriptionEntries` (lib/billing.ts) relies on this by using
-- `createMany({ skipDuplicates: true })` rather than a check-then-create,
-- so the "lazy generation is idempotent on repeated reads" requirement is a
-- property of this index, not of any ordering the application code happens
-- to run in.
CREATE UNIQUE INDEX "BillingEntry_subscriptionId_periodStart_key" ON "BillingEntry"("subscriptionId", "periodStart");

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
