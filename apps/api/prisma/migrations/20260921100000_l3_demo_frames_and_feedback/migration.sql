-- L3 — review frames and feedback intake (build plan §3 "L3 · Review frames
-- and feedback intake"; spec §6). Four new tables (DemoFrame, DemoFrameLine,
-- FeedbackItem, FeedbackComment) plus one nullable column on the existing
-- Demo table.
--
-- **Hand-authored, cross-checked against `prisma migrate diff`, not pasted
-- from it** — same discipline as L1 and L2. Unlike L1's ScopeItem.projectId,
-- the raw diff here needed no correction for a NOT NULL-with-no-default trap:
-- every new table starts empty, and the one new column on an existing table
-- (Demo.publishedAt) is nullable by the schema's own design ("a demo cannot
-- be published naked" is enforced by `publishDemo` refusing without a frame,
-- not by every existing demo suddenly needing one), so there is no row on
-- this machine this migration needs to backfill. One thing the raw diff
-- cannot express and this file adds by hand: the CHECK constraint on
-- FeedbackItem's target, the same route L1's `ScopeItem_decided_both_or_neither`
-- and the pre-existing `Signature_exactly_one_target` already take.
--
-- Order matters, the same discipline as L1 and L2: DemoFrame before
-- DemoFrameLine, both before FeedbackItem (which references both, plus
-- DemoPage and ScopeItem), FeedbackItem before FeedbackComment.

-- ---------------------------------------------------------------------------
-- Demo: the publish gate (spec §6: "a demo cannot be published naked").
-- Null means draft — visible to staff shaping the phase, invisible to the
-- customer's own portal query (Project.phases filters on this for non-staff).
-- ---------------------------------------------------------------------------
ALTER TABLE "Demo" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- DemoFrame: the review frame itself (spec §6) — at most one per Demo.
-- Named without the bare word "review" in the identifier on purpose: see
-- schema.prisma's section comment on why (desk/sections.ts already has
-- `review`/`reviewAdmin` for the unrelated Review Room).
-- ---------------------------------------------------------------------------
CREATE TABLE "DemoFrame" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "authoredById" TEXT NOT NULL,
    -- Freeform context beside the generated lines — optional.
    "summaryFa" TEXT,
    "summaryEn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoFrame_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DemoFrame" ADD CONSTRAINT "DemoFrame_demoId_fkey"
  FOREIGN KEY ("demoId") REFERENCES "Demo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemoFrame" ADD CONSTRAINT "DemoFrame_authoredById_fkey"
  FOREIGN KEY ("authoredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One frame per demo — this is the row `publishDemo` checks for (NO_FRAME).
CREATE UNIQUE INDEX "DemoFrame_demoId_key" ON "DemoFrame"("demoId");

-- ---------------------------------------------------------------------------
-- DemoFrameLine: one line of the frame, in one of the four buckets spec §6
-- names. textFa/textEn are a snapshot of the source scope item's label at
-- generation time (schema.prisma's own comment) — never recomputed live.
-- ---------------------------------------------------------------------------
CREATE TYPE "DemoFrameLineKind" AS ENUM ('NEW', 'KNOWN_MISSING', 'TEMPORARY', 'DECIDED');

CREATE TABLE "DemoFrameLine" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "kind" "DemoFrameLineKind" NOT NULL,
    "textFa" TEXT NOT NULL,
    "textEn" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    -- Where this line was generated from, and what interception (D4) reads
    -- temporary/decidedAt from. SetNull: deleting the scope item must not
    -- delete a line (or the feedback anchored to it) that already shipped.
    "scopeItemId" TEXT,

    CONSTRAINT "DemoFrameLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DemoFrameLine" ADD CONSTRAINT "DemoFrameLine_frameId_fkey"
  FOREIGN KEY ("frameId") REFERENCES "DemoFrame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DemoFrameLine" ADD CONSTRAINT "DemoFrameLine_scopeItemId_fkey"
  FOREIGN KEY ("scopeItemId") REFERENCES "ScopeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DemoFrameLine_frameId_kind_position_idx" ON "DemoFrameLine"("frameId", "kind", "position");

-- ---------------------------------------------------------------------------
-- FeedbackItem: per-item feedback intake (spec §6) — never a comment blob.
-- Binds to a demo page or a frame line, exactly one of the two, the same
-- shape Signature already uses for contractRevisionId/amendmentId.
--
-- **Duplicate collapse (D4) is the two unique indexes below**, not
-- application logic alone: at most one FeedbackItem may ever point at a
-- given DemoPage, and at most one at a given DemoFrameLine. A second
-- submission against the same target is application-level "find existing,
-- append a comment" (resolvers/feedback.ts) precisely because the database
-- would refuse a second row outright if that logic ever slipped.
-- ---------------------------------------------------------------------------
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'RATIFIED', 'ADDRESSED', 'ACCEPTED', 'DECLINED');

CREATE TABLE "FeedbackItem" (
    "id" TEXT NOT NULL,
    "demoId" TEXT NOT NULL,
    "demoPageId" TEXT,
    "frameLineId" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    -- D4's interception, recorded when the submitter proceeded past it.
    "reopenedScopeItemId" TEXT,
    -- Ratification (spec §6, D3) — who decided this batch, and when. Not a
    -- Signature (build plan L3's banked trap #4 — see schema.prisma).
    "ratifiedAt" TIMESTAMP(3),
    "ratifiedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_demoId_fkey"
  FOREIGN KEY ("demoId") REFERENCES "Demo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_demoPageId_fkey"
  FOREIGN KEY ("demoPageId") REFERENCES "DemoPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_frameLineId_fkey"
  FOREIGN KEY ("frameLineId") REFERENCES "DemoFrameLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_reopenedScopeItemId_fkey"
  FOREIGN KEY ("reopenedScopeItemId") REFERENCES "ScopeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_ratifiedById_fkey"
  FOREIGN KEY ("ratifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express a CHECK): exactly one of the two
-- target columns is set — the same route the pre-existing
-- Signature_one_instrument_check and L1's ScopeItem_decided_both_or_neither
-- already take.
ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_exactly_one_target"
  CHECK (("demoPageId" IS NOT NULL) <> ("frameLineId" IS NOT NULL));

-- Duplicate collapse (D4): at most one FeedbackItem per non-null target.
CREATE UNIQUE INDEX "FeedbackItem_demoPageId_key" ON "FeedbackItem"("demoPageId");
CREATE UNIQUE INDEX "FeedbackItem_frameLineId_key" ON "FeedbackItem"("frameLineId");

CREATE INDEX "FeedbackItem_demoId_status_idx" ON "FeedbackItem"("demoId", "status");

-- ---------------------------------------------------------------------------
-- FeedbackComment: the individual voices on one feedback item (spec §6, F8).
-- ---------------------------------------------------------------------------
CREATE TABLE "FeedbackComment" (
    "id" TEXT NOT NULL,
    "feedbackItemId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackComment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FeedbackComment" ADD CONSTRAINT "FeedbackComment_feedbackItemId_fkey"
  FOREIGN KEY ("feedbackItemId") REFERENCES "FeedbackItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackComment" ADD CONSTRAINT "FeedbackComment_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FeedbackComment_feedbackItemId_createdAt_idx" ON "FeedbackComment"("feedbackItemId", "createdAt");
