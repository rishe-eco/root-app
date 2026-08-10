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

/** [key, labelFa, labelEn] */
export const PAGES: Array<[string, string, string]> = [
  ['home', 'صفحه‌ی فرود', 'Landing'],
  ['about', 'درباره‌ی ما', 'About Us'],
  ['contracts', 'قراردادها', 'Contracts'],
  ['portal', 'ورود به پرتال', 'Portal login'],
];
