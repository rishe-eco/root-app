-- Two "declined has a reason" CHECKs tightened (found by J11's review,
-- 2026-10-04). S2's `FeedbackComment_declined_has_reason` and J5's
-- `ScopeProposal_declined_has_reason` asked `btrim(x) <> ''`, but `btrim` strips
-- spaces only: a reason of tabs or newlines passed both. J11's
-- `ScopeItem_handover_is_a_deliverable` asks the stronger question — one
-- character that is not whitespace of any kind — and these two now ask it too.
--
-- An invariant change, not a new invariant: every row the old CHECKs admitted
-- that the new ones refuse is a "reason" that says nothing. Production holds no
-- data (P0-1); on a database that did, a row of that kind would make the ADD
-- fail, which is the right way for it to fail. `IS NOT NULL` stays explicit: a
-- NULL reason makes `~` evaluate to NULL, and a CHECK passes on NULL.
--
-- Proven by direct inserts in `s2.test.ts` and `j5.test.ts` (a tab-and-newline
-- reason refused beside the space-only one).

ALTER TABLE "FeedbackComment" DROP CONSTRAINT "FeedbackComment_declined_has_reason";
ALTER TABLE "FeedbackComment" ADD CONSTRAINT "FeedbackComment_declined_has_reason" CHECK (
  "approval" <> 'DECLINED' OR ("approvalNote" IS NOT NULL AND "approvalNote" ~ '[^[:space:]]')
);

ALTER TABLE "ScopeProposal" DROP CONSTRAINT "ScopeProposal_declined_has_reason";
ALTER TABLE "ScopeProposal" ADD CONSTRAINT "ScopeProposal_declined_has_reason" CHECK (
  "decision" <> 'DECLINED' OR ("declineReason" IS NOT NULL AND "declineReason" ~ '[^[:space:]]')
);
