/**
 * Bilingual copy for the mail flows that exist today: customer invite,
 * password reset, reviewer invite, a new Review Room comment (C2.md §6), and
 * — build plan L3/L3b — a published demo, a submitted feedback item and a
 * published build; and, since S2, the three answer notifications (pending,
 * published, declined). L3's ratified-batch email is gone with ratification. The first user-facing text written
 * on the API side — everything else lives in
 * `apps/web/src/i18n/locales/*.json`, a different workspace this module
 * deliberately doesn't reach into.
 *
 * The L3 templates are not polish (build plan L3's second banked trap, and
 * L3b.2's fourth rule for the build one): the spec's own diagnosis of why
 * the customer left for WhatsApp is that the built-in channel was a dead
 * end, and submit-in-place without "the team has been notified" rebuilds
 * that dead end with better styling.
 *
 * A fifth was once promised alongside the first four — contract-revised —
 * and never built; no stage has needed it yet. See `later-tracks.md`'s C0
 * section.
 *
 * Journeys build plan J2 adds three for a customer's request: submitted (to
 * sales), a new message (to whichever side did not write it), and archived
 * (to the customer, with the reason).
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

/*
 * House rule 14 (Persian digits for counts, Latin for versions/refs/hashes)
 * had a `toPersianDigits` here for L3's ratification email, the one template
 * that carried a count. S2 retired that email (PD-2) and no template carries a
 * count now; if one does again, bring the helper back rather than
 * interpolating a raw number into Persian prose.
 */

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

/** Journeys build plan S3. A member of the Root team, not a customer or an
 *  outside reviewer — the copy says which door this link opens. */
export function staffInviteEmail(
  locale: string | null | undefined,
  params: { name: string; inviteUrl: string },
): MailContent {
  const name = escapeHtml(params.name);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: 'You’re invited to join the Root team',
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>You’ve been invited to join the Root team. Use the link below to set your password and get started. This link expires soon.</p>
        <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
      `),
      text: `Hi ${params.name},\n\nYou've been invited to join the Root team. Use the link below to set your password and get started. This link expires soon.\n\n${params.inviteUrl}`,
    };
  }
  return {
    subject: 'دعوت به تیم ریشه',
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>شما به تیمِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.</p>
      <p><a href="${params.inviteUrl}">${params.inviteUrl}</a></p>
    `),
    text: `${params.name} عزیز،\n\nشما به تیمِ ریشه دعوت شده‌اید. برای تعیین رمز عبور و شروع کار از لینک زیر استفاده کنید. این لینک به‌زودی منقضی می‌شود.\n\n${params.inviteUrl}`,
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
  params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; step: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const step = stepName(params.step, 'en');
    return {
      subject: `New feedback — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>New feedback came in on the “${escapeHtml(step)}” step of <strong>${title}</strong>.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nNew feedback came in on the "${step}" step of "${params.projectTitleEn}".\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const step = stepName(params.step, 'fa');
  return {
    subject: `بازخورد تازه — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>بازخوردِ تازه‌ای روی مرحله‌ی «${escapeHtml(step)}» در «${title}» ثبت شد.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nبازخوردِ تازه‌ای روی مرحله‌ی «${step}» در «${params.projectTitleFa}» ثبت شد.\n\n${params.deskUrl}`,
  };
}

/**
 * Build plan L3b.2's fourth rule: "publishing a build notifies." A build the
 * customer is not told about is a deployment, not a version — this is the
 * direct answer to F6's eighteen silent days, reusing C0's seam exactly as
 * `demoPublishedEmail` does.
 *
 * `buildNumber` is printed as a bare Latin numeral in **both** languages,
 * never through `toPersianDigits` — house rule 14's own exception for
 * versions, refs and hashes, and the exact shape of bug a previous Persian
 * pass found five times ("version ۴").
 */
export function buildPublishedEmail(
  locale: string | null | undefined,
  params: { customerName: string; projectTitleFa: string; projectTitleEn: string; buildNumber: number; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Build ${params.buildNumber} is up — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Build <strong>${params.buildNumber}</strong> of <strong>${title}</strong> is on staging now.</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nBuild ${params.buildNumber} of "${params.projectTitleEn}" is on staging now.\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `بیلد ${params.buildNumber} منتشر شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>بیلدِ <span dir="ltr">${params.buildNumber}</span> از «${title}» هم‌اکنون روی سرورِ آزمایشی است.</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nبیلدِ ${params.buildNumber} از «${params.projectTitleFa}» هم‌اکنون روی سرورِ آزمایشی است.\n\n${params.portalUrl}`,
  };
}

/**
 * The step names, for the sentence a notification says ("… on the design
 * step"). The same words the wizard shows (`wizard.step.*` in the locale
 * files); repeated here because this workspace does not reach into the web's.
 */
const STEP_NAMES: Record<string, { fa: string; en: string }> = {
  REQUIREMENTS: { fa: 'نیازمندی‌ها', en: 'Requirements' },
  SCOPE: { fa: 'صفحه‌ها و امکانات', en: 'Pages and features' },
  DRAFT: { fa: 'پیش‌نویس قرارداد', en: 'The draft' },
  AGREEMENT: { fa: 'تأیید و امضا', en: 'Approve and sign' },
  DESIGN: { fa: 'طرح', en: 'Design' },
  MOCKUP: { fa: 'ماکت', en: 'Mockup' },
  DEMO: { fa: 'دمو', en: 'Demo' },
  SUMMARY: { fa: 'جمع‌بندی', en: 'Summary' },
};

const stepName = (step: string, lang: 'fa' | 'en'): string => STEP_NAMES[step]?.[lang] ?? step;

/** Both spellings of a step's name — a change ticket's brief snapshots a
 *  `general` comment's step this way (`lib/ticket.ts`). */
export const stepNamesFor = (step: string): { fa: string; en: string } => ({
  fa: stepName(step, 'fa'),
  en: stepName(step, 'en'),
});

type AnswerMailParams = { projectTitleFa: string; projectTitleEn: string; step: string };

/**
 * Journeys build plan S2: a staff answer that needs approval has been written
 * (PD-4) — sent to the people who can approve it. The customer has seen
 * nothing yet; this is the queue's only nudge, and the approval queue lands on
 * the founder (plan §9 risk 5), so it says which step and nothing more.
 */
export function answerPendingEmail(
  locale: string | null | undefined,
  params: AnswerMailParams & { recipientName: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const step = stepName(params.step, 'en');
    return {
      subject: `An answer is waiting for your approval — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>An answer on the “${escapeHtml(step)}” step of <strong>${title}</strong> is waiting for your approval. The customer will not see it until you approve it.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nAn answer on the "${step}" step of "${params.projectTitleEn}" is waiting for your approval. The customer will not see it until you approve it.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const step = stepName(params.step, 'fa');
  return {
    subject: `پاسخی منتظر تأیید شماست — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>پاسخی درباره‌ی مرحله‌ی «${escapeHtml(step)}» در «${title}» نوشته شده و منتظر تأیید شماست. تا تأیید نکنید، مشتری آن را نمی‌بیند.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nپاسخی درباره‌ی مرحله‌ی «${step}» در «${params.projectTitleFa}» نوشته شده و منتظر تأیید شماست. تا تأیید نکنید، مشتری آن را نمی‌بیند.\n\n${params.deskUrl}`,
  };
}

/**
 * Journeys build plan S2: Root has answered — sent to the customer, **once per
 * act** (an approval, a direct answer), never once per item. The answer is the
 * dead-end the L3 spec warned about turned round: the customer must be told,
 * or they go back to WhatsApp to ask.
 */
export function answerPublishedEmail(
  locale: string | null | undefined,
  params: AnswerMailParams & { customerName: string; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const step = stepName(params.step, 'en');
    return {
      subject: `Root answered your feedback — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root has answered your feedback on the “${escapeHtml(step)}” step of <strong>${title}</strong>. Read the answer — if you disagree, reply to reopen it; otherwise you can approve the step.</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nRoot has answered your feedback on the "${step}" step of "${params.projectTitleEn}". Read the answer — if you disagree, reply to reopen it; otherwise you can approve the step.\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const step = stepName(params.step, 'fa');
  return {
    subject: `ریشه به بازخورد شما پاسخ داد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه به بازخورد شما درباره‌ی مرحله‌ی «${escapeHtml(step)}» در «${title}» پاسخ داد. پاسخ را بخوانید؛ اگر موافق نیستید، با یک نظر تازه آن را دوباره باز کنید، وگرنه می‌توانید مرحله را تأیید کنید.</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه به بازخورد شما درباره‌ی مرحله‌ی «${step}» در «${params.projectTitleFa}» پاسخ داد. پاسخ را بخوانید؛ اگر موافق نیستید، با یک نظر تازه آن را دوباره باز کنید، وگرنه می‌توانید مرحله را تأیید کنید.\n\n${params.portalUrl}`,
  };
}

/**
 * Journeys build plan S2: sales declined a pending answer — sent to its
 * author, **with the reason** (Q-S1: "the designer sees it"). Staff to staff,
 * so the free text is fine here; SMS carries none (this router has no SMS
 * body for it).
 */
export function answerDeclinedEmail(
  locale: string | null | undefined,
  params: AnswerMailParams & { recipientName: string; reason: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const step = stepName(params.step, 'en');
    return {
      subject: `Your answer was sent back — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Your answer on the “${escapeHtml(step)}” step of <strong>${title}</strong> was not published. The reason:</p>
        <p>${multiline(params.reason)}</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nYour answer on the "${step}" step of "${params.projectTitleEn}" was not published. The reason:\n\n${params.reason}\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const step = stepName(params.step, 'fa');
  return {
    subject: `پاسخ شما برگردانده شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>پاسخ شما درباره‌ی مرحله‌ی «${escapeHtml(step)}» در «${title}» منتشر نشد. دلیل:</p>
      <p>${multiline(params.reason)}</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nپاسخ شما درباره‌ی مرحله‌ی «${step}» در «${params.projectTitleFa}» منتشر نشد. دلیل:\n\n${params.reason}\n\n${params.deskUrl}`,
  };
}

/** A request's title and reason are the customer's and sales's own words, so
 *  they are escaped like any other name; a reason keeps its line breaks. */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/**
 * Journeys build plan J2: the first the desk hears of a request — sent to
 * every account that can answer one (`contracts.author`), so a request is not
 * something a customer submits into silence and finds out about a week later.
 */
export function requestSubmittedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; customerName: string; requestTitle: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  const title = escapeHtml(params.requestTitle);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: `New request from ${params.customerName}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} submitted a new request: <strong>${title}</strong>.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} submitted a new request: "${params.requestTitle}".\n\n${params.deskUrl}`,
    };
  }
  return {
    subject: `درخواست تازه از ${params.customerName}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} درخواست تازه‌ای با عنوانِ «${title}» ثبت کرد.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} درخواست تازه‌ای با عنوانِ «${params.requestTitle}» ثبت کرد.\n\n${params.deskUrl}`,
  };
}

/**
 * Journeys build plan J2: one template, two directions, like
 * `newCommentEmail` — sales gets it when the customer writes, the customer
 * when sales replies. The caller decides who the "other side" is from the
 * message's author; the message itself is not in the email, because the thread
 * is the record and a copy in an inbox is a second, unmoderated one.
 */
export function requestMessageEmail(
  locale: string | null | undefined,
  params: { recipientName: string; requestTitle: string; url: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const title = escapeHtml(params.requestTitle);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: `New message on “${params.requestTitle}”`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>There’s a new message on the request <strong>${title}</strong>.</p>
        <p><a href="${params.url}">${params.url}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nThere's a new message on the request "${params.requestTitle}".\n\n${params.url}`,
    };
  }
  return {
    subject: `پیام تازه روی «${params.requestTitle}»`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>پیام تازه‌ای روی درخواستِ «${title}» ثبت شد.</p>
      <p><a href="${params.url}">${params.url}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nپیام تازه‌ای روی درخواستِ «${params.requestTitle}» ثبت شد.\n\n${params.url}`,
  };
}

/**
 * Journeys build plan J2: a request that is not going ahead is closed *with
 * the reason*, and the customer is told what it was — an archive nobody
 * explains is the silence this stage exists to remove.
 */
export function requestArchivedEmail(
  locale: string | null | undefined,
  params: { customerName: string; requestTitle: string; reason: string; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  const title = escapeHtml(params.requestTitle);
  const reason = multiline(params.reason);
  if (resolveLocale(locale) === 'en') {
    return {
      subject: `Your request was archived — ${params.requestTitle}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Your request <strong>${title}</strong> was archived. The reason:</p>
        <p>${reason}</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nYour request "${params.requestTitle}" was archived. The reason:\n\n${params.reason}\n\n${params.portalUrl}`,
    };
  }
  return {
    subject: `درخواستِ شما بایگانی شد — ${params.requestTitle}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>درخواستِ شما با عنوانِ «${title}» بایگانی شد. دلیل:</p>
      <p>${reason}</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nدرخواستِ شما با عنوانِ «${params.requestTitle}» بایگانی شد. دلیل:\n\n${params.reason}\n\n${params.portalUrl}`,
  };
}

/**
 * Journeys build plan J4: sales has handed step 1 to the customer
 * (`publishContract` on a new-road contract) — the first time the contract is
 * theirs to read. It says what they will find and that the unfinished parts are
 * Root's to complete, not theirs to fill in: a customer told "your requirements
 * are ready" who then finds blanks reads the blanks as Root's mistake.
 */
export function briefSharedEmail(
  locale: string | null | undefined,
  params: { customerName: string; projectTitleFa: string; projectTitleEn: string; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Your project requirements are ready to read — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root has written down what you asked for on <strong>${title}</strong>: the kind of site, your budget and deadlines, what each side provides, the phases and the payment plan. Please read it and comment on anything that is not right. Some parts may still be marked as being completed by Root.</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nRoot has written down what you asked for on "${params.projectTitleEn}". Please read it and comment on anything that is not right.\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `نیازمندی‌های پروژه‌ی شما برای خواندن آماده است — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه آنچه را برای «${title}» خواسته‌اید نوشته است: نوعِ سایت، بودجه و مهلت‌ها، تعهدِ هر طرف، فازها و برنامه‌ی پرداخت. لطفاً بخوانید و هر جا درست نیست نظر بگذارید. ممکن است بعضی بخش‌ها هنوز به‌عنوانِ «در حال تکمیل توسط ریشه» علامت خورده باشد.</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه آنچه را برای «${params.projectTitleFa}» خواسته‌اید نوشته است. لطفاً بخوانید و هر جا درست نیست نظر بگذارید.\n\n${params.portalUrl}`,
  };
}

/**
 * Journeys build plan J5: a customer proposed a change to their contract's
 * scope (add, remove or restore an item) — sent to every account that can
 * decide it (`contracts.author`), since the contract has no sales assignee to
 * route to (S1 assigns a designer and a developer, not a seller). Staff to
 * staff, so the customer's own words are in the body (escaped; line breaks
 * kept); the SMS carries none, as the request SMSs do.
 */
const PROPOSAL_PHRASES: Record<'ADD' | 'REMOVE' | 'RESTORE', { fa: string; en: string }> = {
  ADD: { fa: 'افزودنِ یک مورد', en: 'add an item' },
  REMOVE: { fa: 'حذفِ یک مورد', en: 'remove an item' },
  RESTORE: { fa: 'بازگرداندنِ یک مورد', en: 'bring an item back' },
};

export function scopeProposedEmail(
  locale: string | null | undefined,
  params: {
    recipientName: string;
    projectTitleFa: string;
    projectTitleEn: string;
    proposalKind: 'ADD' | 'REMOVE' | 'RESTORE';
    text: string;
    deskUrl: string;
  },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const phrase = PROPOSAL_PHRASES[params.proposalKind];
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `A scope proposal is waiting — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>The customer proposed to ${phrase.en} in the scope of <strong>${title}</strong>:</p>
        <p>${multiline(params.text)}</p>
        <p>Confirm it (with the bilingual label) or decline it with a reason.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nThe customer proposed to ${phrase.en} in the scope of "${params.projectTitleEn}":\n\n${params.text}\n\nConfirm it (with the bilingual label) or decline it with a reason.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `پیشنهادی برای دامنه منتظر تصمیم است — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>مشتری پیشنهادِ ${phrase.fa} را در دامنه‌ی «${title}» ثبت کرده است:</p>
      <p>${multiline(params.text)}</p>
      <p>آن را با برچسبِ دوزبانه تأیید کنید یا با ذکرِ دلیل نپذیرید.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nمشتری پیشنهادِ ${phrase.fa} را در دامنه‌ی «${params.projectTitleFa}» ثبت کرده است:\n\n${params.text}\n\nآن را با برچسبِ دوزبانه تأیید کنید یا با ذکرِ دلیل نپذیرید.\n\n${params.deskUrl}`,
  };
}

/**
 * Journeys build plan J5: Root decided a proposal — sent to the customer, with
 * the reason when it was declined (the reason is *for* them: a "no" they cannot
 * read is the silence this step exists to remove).
 */
export function scopeProposalDecidedEmail(
  locale: string | null | undefined,
  params: {
    customerName: string;
    projectTitleFa: string;
    projectTitleEn: string;
    decision: 'ACCEPTED' | 'DECLINED';
    reason: string | null;
    portalUrl: string;
  },
): MailContent {
  const name = escapeHtml(params.customerName);
  const accepted = params.decision === 'ACCEPTED';
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const verdict = accepted ? 'accepted' : 'declined';
    const tail = accepted ? ' The list is up to date in the portal.' : ' The reason:';
    return {
      subject: `Your scope proposal was ${verdict} — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root ${verdict} your proposal for the scope of <strong>${title}</strong>.${tail}</p>
        ${!accepted && params.reason ? `<p>${multiline(params.reason)}</p>` : ''}
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nRoot ${verdict} your proposal for the scope of "${params.projectTitleEn}".${tail}${!accepted && params.reason ? `\n\n${params.reason}` : ''}\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const verdict = accepted ? 'پذیرفت. فهرستِ به‌روز در پرتال است.' : 'نپذیرفت. دلیل:';
  return {
    subject: accepted
      ? `پیشنهادت برای دامنه پذیرفته شد — ${params.projectTitleFa}`
      : `پیشنهادت برای دامنه پذیرفته نشد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه پیشنهادِ تو را برای دامنه‌ی «${title}» ${verdict}</p>
      ${!accepted && params.reason ? `<p>${multiline(params.reason)}</p>` : ''}
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه پیشنهادِ تو را برای دامنه‌ی «${params.projectTitleFa}» ${verdict}${!accepted && params.reason ? `\n\n${params.reason}` : ''}\n\n${params.portalUrl}`,
  };
}

/**
 * Journeys build plan J6: the draft contract has been published — the
 * `contract-revised` email C0 promised and no stage built. Sent to the customer
 * on every publish (the first is "read this", a later one is "it changed — your
 * notes show what"), with the version in Latin digits (house rule 14: a version
 * is an identifier).
 */
export function draftPublishedEmail(
  locale: string | null | undefined,
  params: { customerName: string; projectTitleFa: string; projectTitleEn: string; version: number; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  const later = params.version > 1;
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const what = later ? `version ${params.version} of the contract draft` : 'the contract draft';
    const tail = later ? ' Each of your earlier notes shows whether its article changed.' : '';
    return {
      subject: later
        ? `The contract draft was revised (v${params.version}) — ${params.projectTitleEn}`
        : `The contract draft is ready to read — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root published ${what} for <strong>${title}</strong>. Read it article by article and leave a note wherever something is not right.${tail}</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nRoot published ${what} for "${params.projectTitleEn}". Read it article by article and leave a note wherever something is not right.${tail}\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const tail = later ? ' زیرِ هر نظرِ قبلی‌ات دیده می‌شود که مادّه‌اش تغییر کرده یا نه.' : '';
  return {
    subject: later
      ? `پیش‌نویسِ قرارداد بازبینی شد (v${params.version}) — ${params.projectTitleFa}`
      : `پیش‌نویسِ قرارداد آماده‌ی خواندن است — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه ${later ? `نسخه‌ی <span dir="ltr">${params.version}</span> از ` : ''}پیش‌نویسِ قرارداد «${title}» را منتشر کرد. مادّه‌به‌مادّه بخوان و هر جا درست نیست نظر بگذار.${tail}</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه ${later ? `نسخه‌ی ${params.version} از ` : ''}پیش‌نویسِ قرارداد «${params.projectTitleFa}» را منتشر کرد. مادّه‌به‌مادّه بخوان و هر جا درست نیست نظر بگذار.${tail}\n\n${params.portalUrl}`,
  };
}

/**
 * Journeys build plan J7 — to sales, the two moments the agreement moves: the
 * customer **approved** it (steps 1–3 are locked from this instant), and then
 * **signed** it (the invoice plan can start issuing, J13). Two events, not one,
 * because the customer does them one after the other on a single screen and may
 * stop between — an approved-and-unsigned agreement is a thing sales wants to
 * hear about, and can chase.
 *
 * Both go to whoever holds `contracts.author` (J5/J6's choice: no sales
 * assignee exists), so they name the customer — the one thing a recipient cannot
 * infer from a link.
 */
export function agreementApprovedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; customerName: string; projectTitleFa: string; projectTitleEn: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Agreement approved — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} approved the agreement for <strong>${title}</strong>. Steps 1 to 3 are now locked; further changes go through an amendment or a scope trade. They sign next.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} approved the agreement for "${params.projectTitleEn}". Steps 1 to 3 are now locked; further changes go through an amendment or a scope trade. They sign next.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `توافق‌نامه تأیید شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} توافق‌نامه‌ی «${title}» را تأیید کرد. گام‌های ۱ تا ۳ از همین لحظه قفل شدند؛ تغییرِ بعدی از راهِ الحاقیه یا معاوضه‌ی دامنه انجام می‌شود. مشتری در ادامه امضا می‌کند.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} توافق‌نامه‌ی «${params.projectTitleFa}» را تأیید کرد. گام‌های ۱ تا ۳ از همین لحظه قفل شدند؛ تغییرِ بعدی از راهِ الحاقیه یا معاوضه‌ی دامنه انجام می‌شود. مشتری در ادامه امضا می‌کند.\n\n${params.deskUrl}`,
  };
}

export function agreementSignedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; customerName: string; projectTitleFa: string; projectTitleEn: string; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Agreement signed — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} signed the agreement for <strong>${title}</strong>. The payment plan can now be issued invoice by invoice.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} signed the agreement for "${params.projectTitleEn}". The payment plan can now be issued invoice by invoice.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `توافق‌نامه امضا شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} توافق‌نامه‌ی «${title}» را امضا کرد. حالا صورت‌حساب‌های برنامه‌ی پرداخت را می‌شود یکی‌یکی صادر کرد.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} توافق‌نامه‌ی «${params.projectTitleFa}» را امضا کرد. حالا صورت‌حساب‌های برنامه‌ی پرداخت را می‌شود یکی‌یکی صادر کرد.\n\n${params.deskUrl}`,
  };
}

/** A Toman amount (a decimal string) in the locale's own digits. */
function tomanText(amount: string, locale: Locale): string {
  const n = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US').format(Number(amount));
  return locale === 'fa' ? `${n} تومان` : `${n} Toman`;
}

/** A calendar day (`YYYY-MM-DD`, PD-19) in UTC — the Jalali date, for `fa-IR`. */
function dayText(dueOn: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${dueOn.slice(0, 10)}T00:00:00Z`),
  );
}

/**
 * Journeys build plan J13: an invoice was issued — the customer's first word
 * that they owe something, so it carries the three facts they will look for
 * (the number, the amount, the day it is due) and says how Root is paid, which
 * is *not* in the portal (the no-gateway boundary: record-keeping only).
 *
 * **House rule 14, both halves at once:** the amount and the due date go
 * through the locale's own digits (`Intl`), the invoice number stays Latin — it
 * is an identifier the customer will quote or find on a bank slip.
 */
export function invoiceIssuedEmail(
  locale: string | null | undefined,
  params: { customerName: string; invoiceNumber: string; amount: string; dueOn: string; portalUrl: string },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const amount = tomanText(params.amount, 'en');
    const due = dayText(params.dueOn, 'en');
    return {
      subject: `Invoice ${params.invoiceNumber} from Root`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root has issued invoice <strong>${params.invoiceNumber}</strong> for <strong>${amount}</strong>. It is due on <strong>${due}</strong>.</p>
        <p>You can read it, and print it, here:</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
        <p>The portal does not take payment. Pay Root directly, and Root marks the invoice paid here once it has arrived. If you need Root’s payment details, ask your contact at Root.</p>
      `),
      text: `Hi ${params.customerName},\n\nRoot has issued invoice ${params.invoiceNumber} for ${amount}. It is due on ${due}.\n\nYou can read it, and print it, here:\n${params.portalUrl}\n\nThe portal does not take payment. Pay Root directly, and Root marks the invoice paid here once it has arrived. If you need Root's payment details, ask your contact at Root.`,
    };
  }
  const amount = tomanText(params.amount, 'fa');
  const due = dayText(params.dueOn, 'fa');
  return {
    subject: `صورت‌حساب ${params.invoiceNumber} از ریشه`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه صورت‌حساب <strong dir="ltr">${params.invoiceNumber}</strong> را به مبلغ <strong>${amount}</strong> صادر کرد. سررسید آن <strong>${due}</strong> است.</p>
      <p>می‌توانید آن را همین‌جا ببینید و چاپ کنید:</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      <p>پرداخت از راه پرتال انجام نمی‌شود. مبلغ را مستقیماً به ریشه بپردازید؛ پس از رسیدنِ آن، ریشه صورت‌حساب را همین‌جا «پرداخت‌شده» علامت می‌زند. اگر به مشخصات پرداخت ریشه نیاز دارید، از رابطِ خود در ریشه بپرسید.</p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه صورت‌حساب ${params.invoiceNumber} را به مبلغ ${amount} صادر کرد. سررسید آن ${due} است.\n\nمی‌توانید آن را همین‌جا ببینید و چاپ کنید:\n${params.portalUrl}\n\nپرداخت از راه پرتال انجام نمی‌شود. مبلغ را مستقیماً به ریشه بپردازید؛ پس از رسیدنِ آن، ریشه صورت‌حساب را همین‌جا «پرداخت‌شده» علامت می‌زند. اگر به مشخصات پرداخت ریشه نیاز دارید، از رابطِ خود در ریشه بپرسید.`,
  };
}

/** A whole count in the locale's own digits (house rule 14) — a round is a
 *  count, not an identifier. */
function countText(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US').format(n);
}

/**
 * Journeys build plan J8 — a design round was published: the customer's cue to
 * look, choose or comment. "Round 2 of 3" is in the subject line's body because
 * the allowance is a promise the customer has been told about (journeys §7.4),
 * and the count is the fastest way to see it move. `allowance` is null when the
 * brief set none (unreachable on a real contract — see `lib/allowance.ts`); the
 * sentence then drops the "of".
 */
export function designRoundPublishedEmail(
  locale: string | null | undefined,
  params: {
    customerName: string;
    projectTitleFa: string;
    projectTitleEn: string;
    round: number;
    allowance: number | null;
    premade: boolean;
    portalUrl: string;
  },
): MailContent {
  const name = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const which = params.allowance === null ? `Round ${params.round}` : `Round ${params.round} of ${params.allowance}`;
    const what = params.premade ? 'a new set of themes to choose from' : 'a new version of the wireframes and palette';
    return {
      subject: `${which} of the design is ready — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${which} of the design for <strong>${title}</strong> is ready: ${what}. Take a look, leave a note on anything that is not right, and approve the design when you are happy with it.</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\n${which} of the design for "${params.projectTitleEn}" is ready: ${what}. Take a look, leave a note on anything that is not right, and approve the design when you are happy with it.\n\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const round = countText(params.round, 'fa');
  const which =
    params.allowance === null ? `دورِ ${round}` : `دورِ ${round} از ${countText(params.allowance, 'fa')}`;
  const what = params.premade ? 'مجموعه‌ی تازه‌ای از پوسته‌ها برای انتخاب' : 'نسخه‌ی تازه‌ای از وایرفریم‌ها و پالت رنگ';
  return {
    subject: `${which} طراحی آماده است — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${which} طراحیِ «${title}» آماده است: ${what}. نگاهی بینداز، هر جا درست نیست نظر بگذار و وقتی راضی بودی طراحی را تأیید کن.</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\n${which} طراحیِ «${params.projectTitleFa}» آماده است: ${what}. نگاهی بینداز، هر جا درست نیست نظر بگذار و وقتی راضی بودی طراحی را تأیید کن.\n\n${params.portalUrl}`,
  };
}

type DesignerMailParams = {
  recipientName: string;
  customerName: string;
  projectTitleFa: string;
  projectTitleEn: string;
  deskUrl: string;
};

/**
 * Journeys build plan J8 — to the contract's designer, the three things the
 * customer does in the design step that the designer is waiting on: a concept
 * chosen, "show me other options", the design approved (the step is locked from
 * this instant). One template each, on the shape J7 gave sales, because each
 * asks the designer for something different.
 */
export function designConceptChosenEmail(locale: string | null | undefined, params: DesignerMailParams): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `A design was chosen — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} chose a design for <strong>${title}</strong>. They may still leave notes before approving it.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} chose a design for "${params.projectTitleEn}". They may still leave notes before approving it.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `یک طرح انتخاب شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} برای «${title}» یک طرح را انتخاب کرد. ممکن است پیش از تأیید هنوز نکته‌ای بنویسد.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} برای «${params.projectTitleFa}» یک طرح را انتخاب کرد. ممکن است پیش از تأیید هنوز نکته‌ای بنویسد.\n\n${params.deskUrl}`,
  };
}

export function designOtherOptionsEmail(locale: string | null | undefined, params: DesignerMailParams): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `New options requested — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} asked to see other options for <strong>${title}</strong>. Propose a new set of themes and publish the next round; that answers the request.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} asked to see other options for "${params.projectTitleEn}". Propose a new set of themes and publish the next round; that answers the request.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `گزینه‌های تازه خواسته شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} برای «${title}» گزینه‌های دیگری خواست. مجموعه‌ی تازه‌ای از پوسته‌ها را پیشنهاد دهید و دور بعد را منتشر کنید؛ همین پاسخ درخواست است.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} برای «${params.projectTitleFa}» گزینه‌های دیگری خواست. مجموعه‌ی تازه‌ای از پوسته‌ها را پیشنهاد دهید و دور بعد را منتشر کنید؛ همین پاسخ درخواست است.\n\n${params.deskUrl}`,
  };
}

export function designApprovedEmail(locale: string | null | undefined, params: DesignerMailParams): MailContent {
  const name = escapeHtml(params.recipientName);
  const customer = escapeHtml(params.customerName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    return {
      subject: `Design approved — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>${customer} approved the design for <strong>${title}</strong>. The design step is now locked; the next step can begin.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\n${params.customerName} approved the design for "${params.projectTitleEn}". The design step is now locked; the next step can begin.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  return {
    subject: `طراحی تأیید شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>${customer} طراحیِ «${title}» را تأیید کرد. مرحله‌ی طراحی از همین لحظه قفل شد و مرحله‌ی بعد می‌تواند آغاز شود.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\n${params.customerName} طراحیِ «${params.projectTitleFa}» را تأیید کرد. مرحله‌ی طراحی از همین لحظه قفل شد و مرحله‌ی بعد می‌تواند آغاز شود.\n\n${params.deskUrl}`,
  };
}

/**
 * Journeys build plan J8 (plan §6.2, "allowance exhausted → sales") — the
 * designer tried to publish another round and the brief's allowance, and any
 * extension, is used up. Sales is the only one who can extend it (Q-S5), and
 * the designer cannot proceed until they do, so this is the nudge.
 */
export function allowanceExhaustedEmail(
  locale: string | null | undefined,
  params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; step: string; used: number; allowance: number; deskUrl: string },
): MailContent {
  const name = escapeHtml(params.recipientName);
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const step = stepName(params.step, 'en');
    return {
      subject: `Rounds used up — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>The “${escapeHtml(step)}” step of <strong>${title}</strong> has used all ${params.allowance} of its rounds, and the designer needs another. Extending the allowance — with or without a charge — is yours to approve.</p>
        <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
      `),
      text: `Hi ${params.recipientName},\n\nThe "${step}" step of "${params.projectTitleEn}" has used all ${params.allowance} of its rounds, and the designer needs another. Extending the allowance — with or without a charge — is yours to approve.\n\n${params.deskUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const step = stepName(params.step, 'fa');
  const allowance = countText(params.allowance, 'fa');
  return {
    subject: `دورهای مجاز تمام شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>مرحله‌ی «${escapeHtml(step)}» در «${title}» هر ${allowance} دورِ مجاز را مصرف کرده و طراح به دورِ دیگری نیاز دارد. افزایش سهمیه — با هزینه یا بی‌هزینه — با تأیید شماست.</p>
      <p><a href="${params.deskUrl}">${params.deskUrl}</a></p>
    `),
    text: `${params.recipientName} عزیز،\n\nمرحله‌ی «${step}» در «${params.projectTitleFa}» هر ${allowance} دورِ مجاز را مصرف کرده و طراح به دورِ دیگری نیاز دارد. افزایش سهمیه — با هزینه یا بی‌هزینه — با تأیید شماست.\n\n${params.deskUrl}`,
  };
}

/**
 * Journeys build plan J11 — **a contract was closed**, to the customer: the
 * work is delivered, and the summary is theirs to keep. It says three things in
 * order of how much they matter: that it is finished (every phase accepted,
 * everything agreed handed over), where the record is, and — because the
 * support promise is the one thing still running — how long it runs. The
 * support end is a calendar day (PD-19), rendered in the locale's own digits;
 * the months are a count, in the locale's digits too (house rule 14).
 * `supportUntil` is null when the brief promised none, and then that sentence
 * is simply not there: a line saying "0 months" would be a claim.
 */
export function contractClosedEmail(
  locale: string | null | undefined,
  params: {
    customerName: string;
    projectTitleFa: string;
    projectTitleEn: string;
    supportMonths: number | null;
    supportUntil: string | null;
    portalUrl: string;
  },
): MailContent {
  const name = escapeHtml(params.customerName);
  const supported = params.supportMonths !== null && params.supportUntil !== null;
  if (resolveLocale(locale) === 'en') {
    const title = escapeHtml(params.projectTitleEn);
    const support = supported
      ? ` Your support period is ${params.supportMonths} ${params.supportMonths === 1 ? 'month' : 'months'}, until ${dayText(params.supportUntil!, 'en')}.`
      : '';
    return {
      subject: `Delivered — ${params.projectTitleEn}`,
      html: wrap('en', `
        <p>Hi ${name},</p>
        <p>Root has delivered <strong>${title}</strong>: every phase is accepted and everything agreed has been handed over.${support}</p>
        <p>The summary — what was agreed, what became of each item, the hand-over notes and the dates — is here, and you can print it:</p>
        <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
      `),
      text: `Hi ${params.customerName},\n\nRoot has delivered "${params.projectTitleEn}": every phase is accepted and everything agreed has been handed over.${support}\n\nThe summary — what was agreed, what became of each item, the hand-over notes and the dates — is here, and you can print it:\n${params.portalUrl}`,
    };
  }
  const title = escapeHtml(params.projectTitleFa);
  const support = supported
    ? ` دوره‌ی پشتیبانی‌ات ${countText(params.supportMonths!, 'fa')} ماه است، تا ${dayText(params.supportUntil!, 'fa')}.`
    : '';
  return {
    subject: `تحویل شد — ${params.projectTitleFa}`,
    html: wrap('fa', `
      <p>${name} عزیز،</p>
      <p>ریشه «${title}» را تحویل داد: همه‌ی مرحله‌ها پذیرفته شده و هرچه توافق شده بود تحویل داده شده است.${support}</p>
      <p>خلاصه‌ی کار — آنچه توافق شد، سرانجام هر مورد، یادداشت‌های تحویل و تاریخ‌ها — همین‌جاست و می‌توانی چاپش کنی:</p>
      <p><a href="${params.portalUrl}">${params.portalUrl}</a></p>
    `),
    text: `${params.customerName} عزیز،\n\nریشه «${params.projectTitleFa}» را تحویل داد: همه‌ی مرحله‌ها پذیرفته شده و هرچه توافق شده بود تحویل داده شده است.${support}\n\nخلاصه‌ی کار — آنچه توافق شد، سرانجام هر مورد، یادداشت‌های تحویل و تاریخ‌ها — همین‌جاست و می‌توانی چاپش کنی:\n${params.portalUrl}`,
  };
}
