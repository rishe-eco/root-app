/**
 * Bilingual copy for the two mail flows that exist today: invite and
 * password reset. The first user-facing text written on the API side —
 * everything else lives in `apps/web/src/i18n/locales/*.json`, a different
 * workspace this module deliberately doesn't reach into.
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
