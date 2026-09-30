/**
 * The standard article titles, scope items and page keys — the shape every
 * contract starts from. Shared by `prisma/seed.ts` (which needs the fixture)
 * and `applyContractTemplate` (which needs the convenience): one list, not
 * two that can drift apart.
 */

/**
 * The two parties an article's prose may name (journeys build plan J5, D-5).
 *
 * The template used to carry one customer's name — "between Nahal Studio (the
 * Client) and Root" — so every contract started by naming the wrong client.
 * Its bodies now hold `{{client}}` and `{{provider}}`, **rendered when the
 * template is applied** (`renderArticleBody`), and what is stored on the
 * `Article` row — and so frozen into every snapshot — is the finished text.
 * Rendering at apply time and not at read time is deliberate: a published
 * revision is immutable, and a placeholder resolved on every read would let a
 * customer's renamed `clientName` rewrite a signed instrument.
 *
 * `ROOT_PARTY` is Root's name in each language, the `{{provider}}` constant.
 * There was no brand or legal-name constant anywhere in the API before this
 * one (the mail templates type «ریشه» inline); when the legal entity's name is
 * settled it changes here, once. The client is the customer's `clientName`
 * (the company or studio) and, when none is recorded, their own name — one
 * string for both languages, because it is a name the customer gave and not
 * something to translate.
 */
export const ROOT_PARTY = { fa: 'ریشه', en: 'Root' } as const;

export type ArticleParties = { client: string; provider: string };

export const partiesFor = (customer: { clientName: string | null; name: string }, locale: 'fa' | 'en'): ArticleParties => ({
  client: customer.clientName?.trim() || customer.name,
  provider: ROOT_PARTY[locale],
});

/** `{{client}}` and `{{provider}}` — the only placeholders a template body may
 *  hold (`templates.test.ts` scans `ARTICLES` for any other). An unknown one is
 *  left as written rather than swallowed, so a typo is visible, not silent. */
export function renderArticleBody(body: string | null | undefined, parties: ArticleParties): string | null {
  if (body === undefined || body === null) return null;
  return body.replace(/\{\{(client|provider)\}\}/g, (_m, name: 'client' | 'provider') => parties[name]);
}

/** [number, titleFa, titleEn, bodyFa?, bodyEn?] — bodies may hold `{{client}}` / `{{provider}}`. */
export const ARTICLES: Array<[number, string, string, string?, string?]> = [
  [1, 'طرفین', 'Parties',
    'این قرارداد میان {{client}} (کارفرما) و {{provider}} (مجری) بسته می‌شود. نشانی و اطلاعات تماسِ هر دو طرف در سربرگ آمده است.',
    'This contract is between {{client}} (the Client) and {{provider}} (the Provider). The address and contact details of both parties appear in the header.'],
  [2, 'موضوع و دامنه', 'Subject & Scope',
    'موضوع، طراحی و ساختِ وب‌سایت و پرتالِ {{client}} است، مطابق دامنه‌ی پیوست ۱. هر چیزی بیرون از این فهرست، تغییرِ دامنه شمرده می‌شود.',
    'The subject is the design and build of the {{client}} website and portal, per the scope in Appendix 1. Anything outside that list counts as a scope change.'],
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

/**
 * The articles whose prose is about money (journeys build plan J4, PD-14): *Fees*
 * and *Payment Schedule*, by number and English title. The template sets
 * `Article.sensitive` on exactly these, and the J4 migration backfilled the
 * same pair, so a contract that predates the flag and one made after it agree.
 * A bare number would flag a hand-numbered contract's unrelated article 4; the
 * title alone would flag one renamed on purpose — both together is the template.
 *
 * **The convention, stated where the template lives: money appears only in
 * these articles and in structured fields** (the brief's budget, the payment
 * plan, the fee). Prose that names a price in any other article is invisible to
 * the withholding — which is why the convention is written here and not left to
 * be discovered. Everything withheld is withheld through `mayReadMoney`
 * (`lib/visibility.ts`): staff without `money.read` who are not the customer.
 */
const SENSITIVE_ARTICLES: ReadonlyArray<readonly [number, string]> = [
  [4, 'Fees'],
  [5, 'Payment Schedule'],
];

export function isTemplateSensitiveArticle(number: number, titleEn: string): boolean {
  return SENSITIVE_ARTICLES.some(([n, title]) => n === number && title === titleEn);
}

/**
 * **The article the payment plan renders** (journeys build plan J7, trap 2):
 * *Payment Schedule*, article 5, matched by number and English title exactly as
 * the sensitive flag is — J4's matching, not a second one. On the new road that
 * article's body stays empty in the template, and the renderer shows the plan
 * (structured data, in the snapshot) beneath its title. A body typed into it as
 * well would be two schedules that can disagree, in a document somebody signs —
 * so `setArticle` refuses one on a new-road contract (`SCHEDULE_IS_GENERATED`).
 * The web renderer asks this same function (mirrored in `apps/web/src/lib/`,
 * pinned by a test reading both), not a hard-coded 5.
 *
 * *Fees* (article 4) is sensitive too but is prose about the fee, which is one
 * number and not a schedule; it keeps its body.
 */
export function isPaymentScheduleArticle(number: number, titleEn: string): boolean {
  return number === 5 && titleEn === 'Payment Schedule';
}

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
