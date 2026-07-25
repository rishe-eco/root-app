/**
 * Seeds the one contract Phase 1 exists for, plus the two accounts needed to
 * drive it. Idempotent — safe to re-run.
 *
 * Article bodies 1–3 are the real text from the design handoff; the rest are
 * left empty on purpose, so the placeholder shows until the real contract text
 * is pasted in.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@root.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-please';
const CUSTOMER_EMAIL = process.env.SEED_CUSTOMER_EMAIL ?? 'nahal@example.com';
const CUSTOMER_PASSWORD = process.env.SEED_CUSTOMER_PASSWORD ?? 'change-me-please';

const ARTICLES: Array<[number, string, string, string?, string?]> = [
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

const SCOPE: Array<[string, string, string]> = [
  ['bilingual', 'دوزبانه (فارسی-اول) با چیدمانِ راست‌به‌چپ', 'Bilingual (Persian-first) with full RTL'],
  ['landing', 'صفحه‌ی فرود مطابق طرحِ مرجع', 'Landing page matching the reference design'],
  ['about', 'صفحه‌ی «درباره‌ی ما»', 'About Us page'],
  ['portal', 'ورود به پرتال (دعوت‌نامه و بازیابی رمز)', 'Portal login (invite + password reset)'],
  ['contracts', 'ماژول قراردادها: فهرست و صفحه‌ی تعاملی', 'Contracts module: list + interactive detail'],
  ['tracking', 'ثبتِ تغییرات با کاربر و زمان', 'Change tracking with actor and timestamp'],
];

const PAGES: Array<[string, string, string]> = [
  ['home', 'صفحه‌ی فرود', 'Landing'],
  ['about', 'درباره‌ی ما', 'About Us'],
  ['contracts', 'قراردادها', 'Contracts'],
  ['portal', 'ورود به پرتال', 'Portal login'],
];

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      name: 'Root',
      role: 'ADMIN',
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    },
  });

  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    update: {},
    create: {
      email: CUSTOMER_EMAIL,
      name: 'نهال رضایی',
      clientName: 'استودیو نهال',
      role: 'CUSTOMER',
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 12),
    },
  });

  const contract = await prisma.contract.upsert({
    where: { ref: 'RC-2026-014' },
    update: {},
    create: {
      ref: 'RC-2026-014',
      titleFa: 'وب‌سایت و پرتال نهال',
      titleEn: 'Nahal website & portal',
      customerId: customer.id,
      amount: BigInt(180_000_000),
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date(),
    },
  });

  for (const [i, [key, labelFa, labelEn]] of (
    [
      ['1a', 'طرح ۱a', 'Concept 1a'],
      ['1b', 'طرح ۱b', 'Concept 1b'],
      ['1c', 'طرح ۱c', 'Concept 1c'],
    ] as Array<[string, string, string]>
  ).entries()) {
    const concept = await prisma.designConcept.upsert({
      where: { contractId_key: { contractId: contract.id, key } },
      update: {},
      create: { contractId: contract.id, key, labelFa, labelEn, position: i },
    });

    for (const [j, [pk, pFa, pEn]] of PAGES.entries()) {
      await prisma.pageDesign.upsert({
        where: { conceptId_key: { conceptId: concept.id, key: pk } },
        update: {},
        create: { conceptId: concept.id, key: pk, labelFa: pFa, labelEn: pEn, position: j },
      });
    }
  }

  for (const [i, [key, labelFa, labelEn]] of SCOPE.entries()) {
    await prisma.scopeItem.upsert({
      where: { contractId_key: { contractId: contract.id, key } },
      update: {},
      create: { contractId: contract.id, key, labelFa, labelEn, position: i },
    });
  }

  for (const [number, titleFa, titleEn, bodyFa, bodyEn] of ARTICLES) {
    await prisma.article.upsert({
      where: { contractId_number: { contractId: contract.id, number } },
      update: {},
      create: {
        contractId: contract.id,
        number,
        titleFa,
        titleEn,
        bodyFa: bodyFa ?? null,
        bodyEn: bodyEn ?? null,
      },
    });
  }

  const logCount = await prisma.changeLog.count({ where: { contractId: contract.id } });
  if (logCount === 0) {
    await prisma.changeLog.createMany({
      data: [
        { contractId: contract.id, actorId: admin.id, action: 'CREATED' },
        { contractId: contract.id, actorId: admin.id, action: 'PUBLISHED' },
      ],
    });
    await prisma.comment.create({
      data: {
        contractId: contract.id,
        authorId: admin.id,
        target: 'DESIGN',
        body: 'سه طرحِ کلی برایت آماده کردیم. هر کدام حالِ متفاوتی دارد — با خیال راحت نظر بده و یکی را انتخاب کن.',
      },
    });
  }

  console.info(`Seeded. Admin: ${admin.email} · Customer: ${customer.email}`);
  console.info('Change both passwords before this touches anything real.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
