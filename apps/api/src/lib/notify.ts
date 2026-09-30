import type { User } from '@prisma/client';
import { prisma } from './prisma.js';
import { can, type Capability } from './capabilities.js';
import { sendMail } from './mail.js';
import { sendSmsText } from './sms.js';
import {
  inviteEmail,
  reviewerInviteEmail,
  staffInviteEmail,
  resetEmail,
  newCommentEmail,
  demoPublishedEmail,
  feedbackSubmittedEmail,
  buildPublishedEmail,
  answerPendingEmail,
  answerPublishedEmail,
  answerDeclinedEmail,
  requestSubmittedEmail,
  requestMessageEmail,
  requestArchivedEmail,
  briefSharedEmail,
  invoiceIssuedEmail,
  type MailContent,
} from './mailTemplates.js';
import {
  inviteSms,
  requestSubmittedSms,
  requestMessageSms,
  requestArchivedSms,
  briefSharedSms,
  invoiceIssuedSms,
} from './smsTemplates.js';

/**
 * The notification router (journeys build plan J1). One call, `notify(user,
 * event)`, replaces every direct `sendMail(...)` call site the codebase had
 * before this stage: invite, reset, reviewer-invite, new-comment,
 * demo-published, feedback-submitted, build-published, and (S2) the three answer events.
 * It renders whichever templates this event kind defines, sends to
 * whichever channels the user actually has, logs the SMS half, and **never
 * throws** — a failed notification must never fail the act that caused it
 * (the C0 rule `requestPasswordReset`'s own comment already states, applied
 * to every event now instead of just that one).
 *
 * **Not every event kind has an SMS body.** `smsTemplates.ts` defines one for
 * `INVITE_CUSTOMER` — the identity flow where a customer may have no email at
 * all, so SMS is not an enhancement there, it can be the *only* way the
 * invite reaches them — and, since J2, for the three request events
 * (`REQUEST_SUBMITTED`, `REQUEST_MESSAGE`, `REQUEST_ARCHIVED`) and, since J4,
 * `BRIEF_SHARED` (step 1 handed over) and, since J13, `INVOICE_ISSUED`: a customer who
 * signs in by phone alone is asking a question and waiting for the answer,
 * and the answer must be able to reach them. The five L3/L3b retrofits
 * (`NEW_COMMENT`/`DEMO_PUBLISHED`/`FEEDBACK_SUBMITTED`/`BUILD_PUBLISHED`/
 * `ANSWER_*` — S2's replacement for `FEEDBACK_RATIFIED`) and `PASSWORD_RESET`
 * keep going by email only: every
 * recipient of those is either a reviewer (never has a phone, PD-20) or a
 * customer/staff member already reachable by email, and a one-segment SMS
 * for "new comment on a document" is cost with no delivery gap to close.
 * Adding an SMS body for one of these later is a `smsTemplates.ts` change
 * and one new case below — this router does not need to change shape.
 *
 * `INVITE_STAFF` (journeys build plan S3) sends SMS like the customer invite:
 * a staff member in a factor role always has a phone (PD-20), and may have no
 * email.
 *
 * `INVITE_REVIEWER` renders through `inviteEmail`-adjacent
 * `reviewerInviteEmail` and has no SMS counterpart for the same reason:
 * `REVIEWER` never carries a phone (PD-20; `prisma/seed.ts` leaves it
 * unset on purpose).
 */

export type NotifyEvent =
  | { kind: 'INVITE_CUSTOMER'; params: { name: string; inviteUrl: string } }
  | { kind: 'INVITE_REVIEWER'; params: { name: string; inviteUrl: string } }
  | { kind: 'INVITE_STAFF'; params: { name: string; inviteUrl: string } }
  | { kind: 'PASSWORD_RESET'; params: { resetUrl: string } }
  | { kind: 'NEW_COMMENT'; params: { recipientName: string; documentTitle: string; threadUrl: string } }
  | {
      kind: 'DEMO_PUBLISHED';
      params: { customerName: string; projectTitleFa: string; projectTitleEn: string; portalUrl: string };
    }
  | {
      kind: 'FEEDBACK_SUBMITTED';
      params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; step: string; deskUrl: string };
    }
  | {
      kind: 'BUILD_PUBLISHED';
      params: {
        customerName: string;
        projectTitleFa: string;
        projectTitleEn: string;
        buildNumber: number;
        portalUrl: string;
      };
    }
  // Journeys build plan S2 (PD-2 retired the ratification email): a staff
  // answer waiting for sales, published to the customer, or sent back.
  | {
      kind: 'ANSWER_PENDING';
      params: { recipientName: string; projectTitleFa: string; projectTitleEn: string; step: string; deskUrl: string };
    }
  | {
      kind: 'ANSWER_PUBLISHED';
      params: { customerName: string; projectTitleFa: string; projectTitleEn: string; step: string; portalUrl: string };
    }
  | {
      kind: 'ANSWER_DECLINED';
      params: {
        recipientName: string;
        projectTitleFa: string;
        projectTitleEn: string;
        step: string;
        reason: string;
        deskUrl: string;
      };
    }
  // Journeys build plan J2 — a customer's request.
  | {
      kind: 'REQUEST_SUBMITTED';
      params: { recipientName: string; customerName: string; requestTitle: string; deskUrl: string };
    }
  | { kind: 'REQUEST_MESSAGE'; params: { recipientName: string; requestTitle: string; url: string } }
  | {
      kind: 'REQUEST_ARCHIVED';
      params: { customerName: string; requestTitle: string; reason: string; portalUrl: string };
    }
  // Journeys build plan J4 — sales handed step 1 to the customer.
  | {
      kind: 'BRIEF_SHARED';
      params: { customerName: string; projectTitleFa: string; projectTitleEn: string; portalUrl: string };
    }
  // Journeys build plan J13 — an invoice was issued to the customer.
  | {
      kind: 'INVOICE_ISSUED';
      params: { customerName: string; invoiceNumber: string; amount: string; dueOn: string; portalUrl: string };
    };

/** Every event's email rendering — always defined, since every event this
 *  router carries today has a recipient who might have an email. */
function renderEmail(locale: string | null | undefined, event: NotifyEvent): MailContent {
  switch (event.kind) {
    case 'INVITE_CUSTOMER':
      return inviteEmail(locale, event.params);
    case 'INVITE_REVIEWER':
      return reviewerInviteEmail(locale, event.params);
    case 'INVITE_STAFF':
      return staffInviteEmail(locale, event.params);
    case 'PASSWORD_RESET':
      return resetEmail(locale, event.params);
    case 'NEW_COMMENT':
      return newCommentEmail(locale, event.params);
    case 'DEMO_PUBLISHED':
      return demoPublishedEmail(locale, event.params);
    case 'FEEDBACK_SUBMITTED':
      return feedbackSubmittedEmail(locale, event.params);
    case 'BUILD_PUBLISHED':
      return buildPublishedEmail(locale, event.params);
    case 'ANSWER_PENDING':
      return answerPendingEmail(locale, event.params);
    case 'ANSWER_PUBLISHED':
      return answerPublishedEmail(locale, event.params);
    case 'ANSWER_DECLINED':
      return answerDeclinedEmail(locale, event.params);
    case 'REQUEST_SUBMITTED':
      return requestSubmittedEmail(locale, event.params);
    case 'REQUEST_MESSAGE':
      return requestMessageEmail(locale, event.params);
    case 'REQUEST_ARCHIVED':
      return requestArchivedEmail(locale, event.params);
    case 'BRIEF_SHARED':
      return briefSharedEmail(locale, event.params);
    case 'INVOICE_ISSUED':
      return invoiceIssuedEmail(locale, event.params);
  }
}

/** Only the kinds `smsTemplates.ts` actually renders a body for — see this
 *  file's own header for why the rest are `null` here. */
function renderSms(locale: string | null | undefined, event: NotifyEvent): { text: string } | null {
  switch (event.kind) {
    // S3: a staff invite reuses the customer invite's body — it carries the
    // one placeholder (the URL) the provider's pre-approved pattern declares,
    // and "you're invited to Root, set your password" is true of both. A
    // third pattern to register for the same sentence would be cost with no
    // gain.
    case 'INVITE_CUSTOMER':
    case 'INVITE_STAFF':
      return inviteSms(locale, event.params);
    case 'REQUEST_SUBMITTED':
      return requestSubmittedSms(locale, event.params);
    case 'REQUEST_MESSAGE':
      return requestMessageSms(locale, event.params);
    case 'REQUEST_ARCHIVED':
      return requestArchivedSms(locale, event.params);
    // J4: a customer who signs in by phone alone would otherwise never learn
    // step 1 is theirs to read — the same reason the request events have one.
    case 'BRIEF_SHARED':
      return briefSharedSms(locale, event.params);
    // J13: an invoice is money owed, and a customer who signs in by phone
    // alone must be able to learn it exists — the same reason as above. The SMS
    // carries only the link; the amount and the due day are the email's.
    case 'INVOICE_ISSUED':
      return invoiceIssuedSms(locale, event.params);
    default:
      return null;
  }
}

/**
 * Every **active** account holding a capability — how "sales" (or "Root") is
 * found for a notification, by what the account can do rather than what it is
 * called (house rule 1). The one place this is written: feedback's "Root"
 * recipients and J2's request recipients both come here instead of each
 * filtering the user table their own way. Filtered in application code
 * because a capability is a function of a role *set*, not a column.
 */
export async function recipientsHolding(capability: Capability): Promise<User[]> {
  const active = await prisma.user.findMany({ where: { state: 'ACTIVE' } });
  return active.filter((u) => can(u, capability));
}

export type NotifyRecipient = Pick<User, 'id' | 'email' | 'phone' | 'locale'>;

export async function notify(user: NotifyRecipient, event: NotifyEvent): Promise<void> {
  if (user.email) {
    try {
      await sendMail({ to: user.email, ...renderEmail(user.locale, event) });
    } catch (err) {
      console.error(`[notify] email send failed (${event.kind})`, err);
    }
  }

  if (user.phone) {
    const sms = renderSms(user.locale, event);
    if (sms) {
      // The invites log as SmsPurpose.INVITE — the same send AuthToken
      // already knows by that name — never NOTIFY, which is reserved for
      // events with no AuthToken row behind them at all.
      const purpose = event.kind === 'INVITE_CUSTOMER' || event.kind === 'INVITE_STAFF' ? 'INVITE' : 'NOTIFY';
      try {
        await sendSmsText(user.phone, sms.text);
        await prisma.smsLog.create({ data: { userId: user.id, toPhone: user.phone, purpose } }).catch(() => undefined);
      } catch (err) {
        console.error(`[notify] sms send failed (${event.kind})`, err);
      }
    }
  }
}
