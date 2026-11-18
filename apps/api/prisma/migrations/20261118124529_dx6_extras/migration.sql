-- DX6 — the founder's walk through the steps (2026-11-18).
--
-- 1. Zero is a valid count: an allowance of 0 means "no rounds of change" (the
--    customer approves or not). The CHECK that demanded > 0 is replaced by one
--    that demands >= 0. NULL (unset) still passes, as before.
-- 2. The desk's default list of extras, `ExtraType`, seeded with the ten areas
--    `CHECKLIST` (lib/templates.ts) held, so a new contract starts exactly as
--    it did.

-- CreateTable
CREATE TABLE "ExtraType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ExtraType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExtraType_key_key" ON "ExtraType"("key");

-- The default list, as `CHECKLIST` names the ten (keys, labels and order).
INSERT INTO "ExtraType" ("id", "key", "labelFa", "labelEn", "position") VALUES
  ('extra_type_publicPages', 'checklist.publicPages', 'صفحات عمومیِ سایت', 'Public-facing pages', 0),
  ('extra_type_adminDashboard', 'checklist.adminDashboard', 'داشبورد مدیریت', 'Admin dashboard', 1),
  ('extra_type_themeSettings', 'checklist.themeSettings', 'تنظیماتِ ظاهر و قالب', 'Theme & settings coverage', 2),
  ('extra_type_auth', 'checklist.auth', 'احراز هویت', 'Authentication', 3),
  ('extra_type_notifications', 'checklist.notifications', 'اطلاع‌رسانی (پیامک/ایمیل)', 'Notifications (SMS/email)', 4),
  ('extra_type_payment', 'checklist.payment', 'درگاه پرداخت', 'Payment', 5),
  ('extra_type_multilingual', 'checklist.multilingual', 'چندزبانه‌بودن', 'Multilingual support', 6),
  ('extra_type_hosting', 'checklist.hosting', 'میزبانی', 'Hosting', 7),
  ('extra_type_legal', 'checklist.legal', 'الزامات قانونی (اینماد)', 'Legal (Enamad)', 8),
  ('extra_type_analytics', 'checklist.analytics', 'تحلیلِ ترافیک', 'Analytics', 9);

-- Hand-written: what Prisma cannot say. Proven by a direct insert in `dx6.test.ts`.
ALTER TABLE "ContractBrief" DROP CONSTRAINT "ContractBrief_allowances_positive";
ALTER TABLE "ContractBrief"
  ADD CONSTRAINT "ContractBrief_allowances_not_negative" CHECK (
    "premadeRounds" >= 0 AND "wireframeIterations" >= 0 AND "mockupIterations" >= 0 AND "demoIterationsPerPhase" >= 0
  );
