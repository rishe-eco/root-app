-- L4 — ratified item -> change ticket; the three channels (build plan §3
-- "L4"; spec §5, §6). Surfaces the as-built Ticket/TicketMessage models
-- (modelled since the first migration, unreachable from the API until now)
-- and grows Ticket with: a nullable project edge, an optional pointer at the
-- ratified FeedbackItem it was converted from, and the snapshotted brief.
--
-- **Hand-authored, cross-checked against `prisma migrate diff`, not pasted
-- from it** — same discipline as L1/L2/L3/L3b. The raw diff needed no
-- correction for a NOT NULL-with-no-default trap: every new column on
-- `Ticket` is nullable (a ticket created before this migration has no project
-- and no source feedback item, and both stay legitimately absent forever for
-- most tickets), so there is nothing on this machine to backfill. What the
-- raw diff cannot express, and this file adds by hand: the CHECK constraint
-- holding "the five brief columns are set together, or not at all" — the
-- same route L1's `ScopeItem_decided_both_or_neither` and L3b's
-- `BuildChangeEntry_at_most_one_origin` already take.
--
-- Order: the new enum value first (nothing in this file's own DDL uses it,
-- so there is no same-transaction hazard), then the new columns, then the
-- indexes and foreign keys, then the CHECK.

-- ---------------------------------------------------------------------------
-- TicketType: a fourth value beside the original three (spec §5) — never a
-- customer's own choice (resolvers/tickets.ts's createTicket refuses it),
-- set by staff via moveTicketChannel once a support ticket is recognized as
-- one. Counted by Query.adminRequestCount — the only input to the parked
-- §10.2 decision on whether site administration becomes a product.
-- ---------------------------------------------------------------------------
ALTER TYPE "TicketType" ADD VALUE 'ADMIN_REQUEST';

-- ---------------------------------------------------------------------------
-- Ticket: the project edge (nullable — build plan L4's own banked trap: a
-- change ticket derived from a demo belongs to a project, a support ticket
-- after delivery may not, and the two are never conflated into one required
-- column), the source-feedback pointer, and the brief itself, snapshotted at
-- conversion time (same reasoning as DemoFrameLine.textFa/textEn).
-- ---------------------------------------------------------------------------
ALTER TABLE "Ticket" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "sourceFeedbackItemId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefPageFa" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefPageEn" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefAnnotation" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefCurrentState" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefDesiredState" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "briefLang" TEXT;

-- At most one ticket may ever claim a given feedback item — a second
-- conversion of the same item is refused (ALREADY_CONVERTED) at the resolver,
-- and this is the database-level backstop, the same role the two partial
-- unique indexes on FeedbackItem already play for D4's duplicate collapse.
CREATE UNIQUE INDEX "Ticket_sourceFeedbackItemId_key" ON "Ticket"("sourceFeedbackItemId");
CREATE INDEX "Ticket_projectId_idx" ON "Ticket"("projectId");
-- Serves Query.adminRequestCount and allTickets's type filter — a query
-- across every ticket of one type has nothing else to use.
CREATE INDEX "Ticket_type_idx" ON "Ticket"("type");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sourceFeedbackItemId_fkey"
  FOREIGN KEY ("sourceFeedbackItemId") REFERENCES "FeedbackItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- All five brief columns travel together — a ticket either carries the whole
-- brief (page, annotation, current state, desired state, the language the
-- last two were authored in) or none of it. Prisma cannot express a
-- five-column "all or none" rule, so it is hand-written here, the same route
-- every other cross-column rule in this schema already takes.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_brief_all_or_none" CHECK (
  ("briefPageFa" IS NULL) = ("briefPageEn" IS NULL) AND
  ("briefPageFa" IS NULL) = ("briefAnnotation" IS NULL) AND
  ("briefPageFa" IS NULL) = ("briefCurrentState" IS NULL) AND
  ("briefPageFa" IS NULL) = ("briefDesiredState" IS NULL) AND
  ("briefPageFa" IS NULL) = ("briefLang" IS NULL)
);
