-- DX2a — the new step order and "No design" (desk UX review items 4, 10).
--
-- Two additive enum values, nothing else; no data is touched.
--
--   * `StepKind.PHASES` — "Phases and payment", between SCOPE and DRAFT on the
--     new road. Placed BEFORE 'DRAFT' so the enum's own order is the road's
--     (nothing orders by it today, but a later `ORDER BY step` should not
--     surprise anyone). No existing row names it: a StepApproval for PHASES is
--     never written (it locks with the agreement), and FeedbackItem's CHECK
--     refuses a PHASES row (the step takes no feedback of its own).
--   * `DesignTier.NONE` — a contract with no design (chiefly a feature on an
--     existing site). Its road has neither DESIGN nor MOCKUP.
--
-- Postgres cannot use a value in the transaction that adds it, and nothing here
-- does.

-- AlterEnum
ALTER TYPE "DesignTier" ADD VALUE 'NONE';

-- AlterEnum
ALTER TYPE "StepKind" ADD VALUE 'PHASES' BEFORE 'DRAFT';
