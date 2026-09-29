import { test, expect } from '@playwright/test';
import { ADMIN, SALES, resetTestDatabase, signIn } from './helpers';

/**
 * Phone identity, the staff second factor, and phone recovery (journeys
 * build plan J1), end to end against the dev transport — `DevSmsTransport`,
 * reading codes back through the e2e-only outbox route
 * (`routes/smsOutbox.ts`, `SMS_E2E_OUTBOX=1` in this suite's API env).
 *
 * The three scenarios the plan names: invite → set password → sign in with
 * phone; forgot → code → forced new password → portal; the seeded sales
 * user through the second factor, driven by hand rather than through
 * `signIn`'s own shortcut, so the factor screen itself is proven to render
 * and work, not merely completed invisibly.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

/** The same e2e-only outbox `helpers.ts`'s own `signIn` reads — duplicated
 *  rather than imported, the same reasoning that file gives for
 *  `TEST_DATABASE_URL`: one string, easy to keep in step by inspection. */
const E2E_API_URL = `http://localhost:${process.env.E2E_API_PORT || 4101}`;

async function readSmsCode(phone: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${E2E_API_URL}/__e2e/sms-outbox?phone=${encodeURIComponent(phone)}`);
    if (res.ok) {
      const body = (await res.json()) as { code: string | null };
      if (body.code) return body.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no SMS code turned up in the e2e outbox for ${phone}`);
}

test('invite by phone → set password → sign in with phone', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/customers');

  const stamp = Date.now();
  const phone = `+9891${String(stamp).slice(-8)}`;

  // Phone only — no email, per J1's Q1: a customer may be identified by
  // phone alone, and the desk invite form leaves email optional.
  await page.locator('#i-phone').fill(phone);
  await page.locator('#i-name').fill('New Phone Customer');
  await page.getByRole('button', { name: 'Generate invite link' }).click();

  const link = await page.locator('.desk-code').textContent();
  expect(link).toBeTruthy();
  const inviteUrl = new URL(link!.trim());

  await page.context().clearCookies();
  await page.goto(inviteUrl.pathname);
  await page.locator('#name').fill('نام تازه');
  await page.locator('#pw').fill('a-brand-new-password');
  await page.locator('#pw2').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Activate my account' }).click();

  // acceptInvite signs the account in directly — it lands in the portal,
  // not back at the sign-in form.
  await expect(page).toHaveURL(/\/en\/app\/contracts/);

  // Sign out, and prove the phone (not an email this account never had)
  // signs back in with the password just set.
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/en\/portal/);

  await page.locator('#email').fill(phone);
  await page.locator('#password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/en\/app\/contracts/);
});

test('forgot password by phone → code → forced new password → portal (fa)', async ({ page }) => {
  // A fresh, already-active phone-only account, created the same way the
  // previous test proved the invite path produces one — but built directly
  // here so this test does not depend on that one's ordering or timing.
  await signIn(page, ADMIN);
  await page.goto('/en/desk/customers');
  const stamp = Date.now();
  const phone = `+9892${String(stamp).slice(-8)}`;
  await page.locator('#i-phone').fill(phone);
  await page.locator('#i-name').fill('Forgot Flow Customer');
  await page.getByRole('button', { name: 'Generate invite link' }).click();
  const link = await page.locator('.desk-code').textContent();
  const inviteUrl = new URL(link!.trim());
  await page.context().clearCookies();
  await page.goto(inviteUrl.pathname);
  await page.locator('#name').fill('مشتری فراموش‌کار');
  await page.locator('#pw').fill('the-old-password-123');
  await page.locator('#pw2').fill('the-old-password-123');
  await page.getByRole('button', { name: 'Activate my account' }).click();
  await expect(page).toHaveURL(/\/en\/app\/contracts/);
  await page.getByRole('button', { name: /sign out/i }).click();

  // The forgot flow itself, in Persian — one identifier field, a phone this time.
  await page.goto('/fa/portal/reset');
  await page.locator('#identifier').fill(phone);
  await page.getByRole('button', { name: 'ادامه' }).click();

  // The identifier step gives way to the code step, on the same screen.
  await expect(page.locator('#reset-code')).toBeVisible();
  const code = await readSmsCode(phone);
  await page.locator('#reset-code').fill(code);
  await page.getByRole('button', { name: 'تأیید' }).click();

  // Landing on the forced route, not the portal — a phone-code sign-in sets
  // passwordChangeRequired (PD-10), and it must clear before anything else.
  await expect(page).toHaveURL(/\/fa\/portal\/set-password/);
  await page.locator('#pw').fill('a-completely-different-password');
  await page.locator('#pw2').fill('a-completely-different-password');
  await page.getByRole('button', { name: 'ذخیره‌ی رمز تازه' }).click();
  await expect(page).toHaveURL(/\/fa\/app\/contracts/);

  // And the new password, not the one this account was created with, is
  // what actually signs it in from here on.
  await page.getByRole('button', { name: /sign out|خروج/i }).click();
  await page.locator('#email').fill(phone);
  await page.locator('#password').fill('a-completely-different-password');
  await page.getByRole('button', { name: /sign in|ورود/i }).click();
  await expect(page).toHaveURL(/\/fa\/app\/contracts/);
});

test('the seeded sales user through the second factor, driven by hand', async ({ page }) => {
  // Not through helpers.signIn's own shortcut — this is the one test that
  // proves the factor screen itself renders and works, rather than relying
  // on every other spec completing it invisibly.
  await page.context().clearCookies();
  await page.goto('/en/portal');
  await page.locator('#email').fill(SALES.email);
  await page.locator('#password').fill(SALES.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/en\/portal\/factor/);
  const code = await readSmsCode(SALES.phone);
  await page.locator('#factor-code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page).toHaveURL(/\/en\/desk/);
});

test('a wrong factor code is refused, and the real one still works after', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/en/portal');
  await page.locator('#email').fill(SALES.email);
  await page.locator('#password').fill(SALES.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/en\/portal\/factor/);

  const code = await readSmsCode(SALES.phone);
  const wrongCode = code === '000000' ? '111111' : '000000';
  await page.locator('#factor-code').fill(wrongCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('That code is not valid.')).toBeVisible();
  // Still on the factor screen — a wrong code does not bounce the visitor
  // back to plain sign-in, it just refuses.
  await expect(page).toHaveURL(/\/en\/portal\/factor/);

  await page.locator('#factor-code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/en\/desk/);
});
