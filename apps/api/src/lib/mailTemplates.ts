/**
 * Bilingual copy for the mail flows that exist today: customer invite,
 * password reset, reviewer invite, a new Review Room comment (C2.md §6), and
 * — build plan L3 — a published demo, a submitted feedback item, and a
 * ratified batch. The first user-facing text written on the API side —
 * everything else lives in `apps/web/src/i18n/locales/*.json`, a different
 * workspace this module deliberately doesn't reach into.
 *
 * The three L3 templates are not polish (build plan L3's second banked
 * trap): the spec's own diagnosis of why the customer left for WhatsApp is
 * that the built-in channel was a dead end, and submit-in-place without "the
 * team has been notified" rebuilds that dead end with better styling.
 *
 * A fifth was once promised alongside the first four — contract-revised —
 * and never built; no stage has needed it yet. See `later-tracks.md`'s C0
 * section.
 */

export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** `fa` is the product's first language and the default, not a fallback-of-last-resort. */
export function resolveLocale(raw: string | null | undefined): Locale {
  return raw === 'en' ? 'en' : 'fa';
}

export type MailContent = { subject: string; html: string; text: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/**
 * House rule 14: Persian digits for counts, Latin for versions/refs/hashes.
 * `apps/web/src/lib/format.ts`'s `formatCount` is the web-side helper this
 * mirrors; the API has none of its own because no server-authored Persian
 * text has carried a count before this stage's ratification email.
 */
function toPersianDigits(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

function wrap(locale: Locale, bodyHtml: string): string {
  const dir = locale === 'fa' ? 'rtl' : 'ltr';
  return `<div dir="${dir}" style="font-family: sans-serif; font-size: 15px; line-height: 1.6;">${bodyHtml}</div>`;
}

export function inviteEmail(
  locale: string | null | undefined,
  params: { name: string; inviteUrl: string },
): MailContent {
  const name = escapeHtml(params.name);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: 'You’re invited to Root',
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>You’ve been invited to the Root customer portal. Use the link below to set your password and get started. This link expires soon.</p>
        <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
      `),
      text: `Hi ${params.name},\n\nYou've been invited to the Root customer portal. Use the link below to set your password and get started. This link expires soon.\n\n${params.inviteUrl}`,
    };
  }
  return {
    subject: 'دعوت به ریشه',
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>شما به پرتال مشتریانِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.</p>
      <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
    `),
    text: `${params.name} عزیز،\n\nشما به پرتال مشتریانِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.\n\n${params.inviteUrl}`,
  };
}

export function resetEmail(
  locale: string | null | undefined,
  params: { resetUrl: string },
): MailContent {
  if (resolveLocale(locale) === 'en') {
    return {
      subject: 'Reset your Root password',
      html: wrap('en', `
        <p>Use the link below to choose a new password. This link expires soon. If you didn’t request this, you can ignore this email.</p>
        <p><a href="${params.resetUrl}">${params.resetUrl}</a></p>
      `),
      text: `Use the link below to choose a new password. This link expires soon. If you didn't request this, you can ignore this email.\n\n${params.resetUrl}`,
    };
  }
  return {
    subject: 'بازیابی رمز عبور ریشه',
    html: wrap('fa', `
      <p>برای تعیین رمز عبور جدید از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود. اگر این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.</p>
      <p><a href="${params.resetUrl}">${params.resetUrl}</a></p>
    `),
    text: `برای تعیین رمز عبور جدید از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود. اگر این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.\n\n${params.resetUrl}`,
  };
}

/** C2 §5. Same shape as `inviteEmail` — a Review Room specialist, not a
 *  customer, so the copy says what they are actually being asked to do. */
export function reviewerInviteEmail(
  locale: string | null | undefined,
  params: { name: string; inviteUrl: string },
): MailContent {
  const name = escapeHtml(params.name);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: 'You’re invited to review at Root',
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>You’ve been invited to review documents in Root’s Review Room. Use the link below to set your password and get started. This link expires soon.</p>
        <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
      `),
      text: `Hi ${params.name},\n\nYou've been invited to review documents in Root's Review Room. Use the link below to set your password and get started. This link expires soon.\n\n${params.inviteUrl}`,
    };
  }
  return {
    subject: 'دعوت به بازبینی در ریشه',
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>شما برای بازبینیِ اسناد در اتاقِ بازبینیِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.</p>
      <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
    `),
    text: `${params.name} عزیز،\n\nشما برای بازبینیِ اسناد در اتاقِ بازبینیِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.\n\n${params.inviteUrl}`,
  };
}

/**
 * C2 §6. One template, two directions: Root gets it when a reviewer opens a
 * thread, the reviewer gets it when Root replies in theirs. **Never sent for
 * a different reviewer's thread** — the caller decides who to notify from
 * the ownership edge that already governs who may see the thread at all
 * (C2.md §3), so this template never has to re-derive that rule.
 */
export function newCommentEmail(
  locale: string | null | undefined,
  params: { recipientName: string; documentTitle: string; threadUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const title = escapeHtml(params.documentTitle);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: `New comment on “${params.documentTitle}”`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>There’s a new comment on <strong>${title}</strong> in the Review Room.</p>
        <p><a href="${params.threadUrl}">${params.threadUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nThere's a new comment on "${params.documentTitle}" in the Review Room.\n\n${params.threadUrl}`,
    };
  }
  return {
    subject: `نظر جدید روی «${params.documentTitle}»`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>نظر تازه‌ای روی «${title}» در اتاقِ بازبینی ثبت شد.</p>
      <p><a href="${params.threadUrl}">${params.threadUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nنظر تازه‌ای روی «${params.documentTitle}» در اتاقِ بازبینی ثبت شد.\n\n${params.threadUrl}`,
  };
}

/**
 * Build plan L3: publishing a demo is the direct answer half of "the channel
 * wins only by being alive" — the customer is told the moment there is
 * something to look at, rather than finding out from a link pasted into
 * WhatsApp.
 */
export function demoPublishedEmail(
  locale: string | null | undefined,
  params: { customerName: string; projectTitleFa: string; projectTitleEn: string; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `A new demo is ready to review — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>A new demo of <strong>${title}</strong> is ready for you to review, with its review frame — what's new, what's still missing, and what's temporary or already decided.</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nA new demo of "${params.projectTitleEn}" is ready for you to review, with its review frame.\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `دموی تازه برای بازبینی آماده است — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>دموی تازه‌ای از «${title}» برای بازبینیِ شما آماده است، همراه با چارچوبِ بازبینی‌اش — چه چیزی تازه است، چه چیزی هنوز مانده، و چه چیزی موقتی یا از پیش تصمیم‌گیری‌شده است.</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nدموی تازه‌ای از «${params.projectTitleFa}» برای بازبینیِ شما آماده است.\n\n${params.portalUrl}`,
  };
}

/**
 * Build plan L3: "get an immediate 'the team has been notified'" — sent to
 * Root when a feedback item is submitted or gains a new voice. Never sent to
 * a customer, and never sent when Root itself is the one submitting.
 */
export function feedbackSubmittedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `New demo feedback — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>New feedback came in on a demo for <strong>${title}</strong>.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nNew feedback came in on a demo for "${params.projectTitleEn}".\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `بازخورد تازه روی دمو — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>بازخوردِ تازه‌ای روی دموی «${title}» ثبت شد.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nبازخوردِ تازه‌ای روی دموی «${params.projectTitleFa}» ثبت شد.\n\n${params.deskUrl}`,
  };
}

/**
 * Build plan L3: sent to Root once the decider ratifies a batch — the
 * signal that turns "opinions" into a queue a developer may actually pull
 * from (spec §6, F8).
 */
export function feedbackRatifiedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; count: number; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Feedback ratified, ready to build — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${params.count} feedback item(s) on <strong>${title}</strong> were just ratified and are ready to act on.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.count} feedback item(s) on "${params.projectTitleEn}" were just ratified and are ready to act on.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const countFa = toPersianDigits(params.count);
  return {
    subject: `دسته‌ای از بازخوردها تأیید شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${countFa} موردِ بازخورد روی «${title}» تازه تأیید شد و آماده‌ی اقدام است.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${countFa} موردِ بازخورد روی «${params.projectTitleFa}» تازه تأیید شد و آماده‌ی اقدام است.\n\n${params.deskUrl}`,
  };
}
