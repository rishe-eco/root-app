/**
 * The standard article titles, scope items and page keys — the shape every
 * contract starts from. Shared by `prisma/seed.ts` (which needs the fixture)
 * and `applyContractTemplate` (which needs the convenience): one list, not
 * two that can drift apart.
 */

/** [number, titleFa, titleEn, bodyFa?, bodyEn?] */
export const ARTICLES: Array<[number, string, string, string?, string?]> = [
  [1, 'طرفین', 'Parties',
    'این قرارداد میان استودیو نهال (کارفرما) و ریشه (مجری) بسته می‌شود. نشانی و اطلاعات تماسِ هر دو طرف در سربرگ آمده است.',
    'This contract is between Nahal Studio (the Client) and Root (the Provider). The address and contact details of both parties appear in the header.'],
  [2, 'موضوع و دامنه', 'Subject & Scope',
    'موضوع، طراحی و ساختِ وب‌سایت و پرتالِ مشتریِ نهال است، مطابق دامنه‌ی پیوست ۱. هر چیزی بیرون از این فهرست، تغییرِ دامنه شمرده می‌شود.',
    'The subject is the design and build of the Nahal customer website and portal, per the scope in Appendix 1. Anything outside that list counts as a scope change.'],
  [3, 'زمان‌بندی و مراحل', 'Timeline & Milestones',
    'کار در فازهای مشخص انجام می‌شود؛ هر فاز با تأییدِ کارفرما بسته می‌شود. زمان‌بندیِ دقیق پس از تأییدِ طرح نهایی می‌شود.',
    'Work proceeds in defined phases; each phase closes on the Client’s approval. The precise timeline is finalized once the design is approved.'],
  [4, 'حق‌الزحمه', 'Fees'],
  [5, 'برنامه‌ی پرداخت', 'Payment Schedule'],
  [6, 'بازبینی و تأییدها', 'Revisions & Approvals'],
  [7, 'مالکیت فکری', 'Intellectual Property'],
  [8, 'محرمانگی', 'Confidentiality'],
  [9, 'تضمین‌ها', 'Warranties'],
  [10, 'محدودیت مسئولیت', 'Limitation of Liability'],
  [11, 'فسخ', 'Termination'],
  [12, 'فورس ماژور', 'Force Majeure'],
  [13, 'قانون حاکم', 'Governing Law'],
  [14, 'اطلاع‌رسانی', 'Notices'],
  [15, 'پیوست ۱ — فهرست ویژگی‌ها', 'Appendix 1 — Feature list'],
];

/** [key, labelFa, labelEn] */
export const SCOPE: Array<[string, string, string]> = [
  ['bilingual', 'دوزبانه (فارسی-اول) با چیدمانِ راست‌به‌چپ', 'Bilingual (Persian-first) with full RTL'],
  ['landing', 'صفحه‌ی فرود مطابق طرحِ مرجع', 'Landing page matching the reference design'],
  ['about', 'صفحه‌ی «درباره‌ی ما»', 'About Us page'],
  ['portal', 'ورود به پرتال (دعوت‌نامه و بازیابی رمز)', 'Portal login (invite + password reset)'],
  ['contracts', 'ماژول قراردادها: فهرست و صفحه‌ی تعاملی', 'Contracts module: list + interactive detail'],
  ['tracking', 'ثبتِ تغییرات با کاربر و زمان', 'Change tracking with actor and timestamp'],
];

/**
 * The completeness checklist (build plan L1; spec §3): standard scope areas
 * every web project must explicitly address or explicitly decline, so a hole
 * like Nahal's missing dashboard and theme-settings coverage (friction F7) is
 * a discovery at project creation rather than in review.
 *
 * Seeded DECLINED at project creation — deliberately, not PROPOSED — so an
 * area nobody has scoped in reads as "declined, and worth a second look"
 * rather than silently absent from the registry. `createProject` (see
 * resolvers/admin/registry.ts) is the one place this list is applied; it is
 * not part of `applyContractTemplate`'s SCOPE list above, and the two key
 * spaces are kept apart (`checklist.*` vs the plain keys in SCOPE) so the two
 * mechanisms never collide on one row.
 *
 * [key, labelFa, labelEn]
 */
export const CHECKLIST: Array<[string, string, string]> = [
  ['checklist.publicPages', 'صفحات عمومیِ سایت', 'Public-facing pages'],
  ['checklist.adminDashboard', 'داشبورد مدیریت', 'Admin dashboard'],
  ['checklist.themeSettings', 'تنظیماتِ ظاهر و قالب', 'Theme & settings coverage'],
  ['checklist.auth', 'احراز هویت', 'Authentication'],
  ['checklist.notifications', 'اطلاع‌رسانی (پیامک/ایمیل)', 'Notifications (SMS/email)'],
  ['checklist.payment', 'درگاه پرداخت', 'Payment'],
  ['checklist.multilingual', 'چندزبانه‌بودن', 'Multilingual support'],
  ['checklist.hosting', 'میزبانی', 'Hosting'],
  ['checklist.legal', 'الزامات قانونی (اینماد)', 'Legal (Enamad)'],
  ['checklist.analytics', 'تحلیلِ ترافیک', 'Analytics'],
];

/** [key, labelFa, labelEn] */
export const PAGES: Array<[string, string, string]> = [
  ['home', 'صفحه‌ی فرود', 'Landing'],
  ['about', 'درباره‌ی ما', 'About Us'],
  ['contracts', 'قراردادها', 'Contracts'],
  ['portal', 'ورود به پرتال', 'Portal login'],
];

/** The kinds a registry row can have — mirrors the Prisma `ScopeKind` enum,
 *  written out here so this file stays free of a Prisma import (the seed and
 *  the pure tests both read it). */
export type ScopeKindName = 'PAGE' | 'FEATURE' | 'DELIVERABLE' | 'EXTRA';

/** What a template's own scope list may hold — never `EXTRA`, the
 *  checklist's kind (see `TemplateScopeItem_kind_not_extra`). */
export const TEMPLATE_KINDS = ['PAGE', 'FEATURE', 'DELIVERABLE'] as const;

/**
 * The kind of a registry row nobody has classified (journeys build plan T1):
 * `checklist.*` are the completeness checklist's standard areas (`EXTRA`),
 * a key in `PAGES` is a page, and anything else is a feature.
 *
 * **The one rule for the legacy creators** — `applyContractTemplate`,
 * `addScopeItem` without a `kind`, a scope trade's incoming item and the seed
 * all ask this, so a row created today is classified exactly as the T1
 * migration classified the rows that existed. The migration cannot call
 * TypeScript, so it states the same rule in SQL; `templates.test.ts` reads
 * the migration as text and fails if its page list stops matching `PAGES`.
 */
export function scopeKindForKey(key: string): ScopeKindName {
  if (key.startsWith('checklist.')) return 'EXTRA';
  if (PAGES.some(([pageKey]) => pageKey === key)) return 'PAGE';
  return 'FEATURE';
}

/**
 * The five site types T1 seeds, with **placeholder** scope lists.
 *
 * Root's product catalogue — what a store or a portfolio really comes with —
 * is Root's to write, and the build plan says this stage does not write it.
 * So each type gets one page, one feature and one deliverable whose labels say
 * outright that they are stand-ins, in both languages, for sales to replace
 * on the Scope tab. The *types* are real; their contents are not.
 *
 * [slug, labelFa, labelEn]
 */
export const TEMPLATE_TYPES: Array<[string, string, string]> = [
  ['store', 'فروشگاهی', 'Store'],
  ['blog', 'وبلاگ', 'Blog'],
  ['brand', 'وب‌سایت برند', 'Brand site'],
  ['portfolio', 'نمونه‌کار', 'Portfolio'],
  ['other', 'سایر', 'Other'],
];

/** [key, kind, labelFa, labelEn] — the same three stand-ins under every type. */
export const PLACEHOLDER_SCOPE: Array<[string, (typeof TEMPLATE_KINDS)[number], string, string]> = [
  ['placeholder-page', 'PAGE', 'صفحه — نمونه، جایگزین کنید', 'Page — placeholder, replace'],
  ['placeholder-feature', 'FEATURE', 'ویژگی — نمونه، جایگزین کنید', 'Feature — placeholder, replace'],
  ['placeholder-deliverable', 'DELIVERABLE', 'تحویلی — نمونه، جایگزین کنید', 'Deliverable — placeholder, replace'],
];
