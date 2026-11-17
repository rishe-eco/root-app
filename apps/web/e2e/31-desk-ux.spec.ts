import { test, expect, type Page } from '@playwright/test';
import {
  ADMIN,
  apiSignIn,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  DRAFT_CONTRACT_REF,
  expectSaved,
  gql,
  insertDraftNewRoadContract,
  resetTestDatabase,
  SALES,
  signIn,
  WIZARD_CONTRACT_REF,
} from './helpers';

/**
 * DX1 — the desk's inputs and the draft (desk UX review items 3, 5, 6, 13–17,
 * 21–25, 28, 33), driven the way sales drives them, in both languages and at
 * 360 px and 180 px.
 *
 * One story, in order: the step pills while step 1 is still empty; then the
 * requirements inputs on a contract that is not handed over; then — with steps 1
 * and 2 done over the API — the date field in Persian and English, the Draft
 * step without its settings, the Contract tab with them, and an English draft
 * whose articles have no English text.
 *
 * Every measurement waits for `document.fonts.ready`: Vazirmatn arrives after
 * first paint and moves every width (brief-common, Tests).
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';

test.beforeAll(() => {
  resetTestDatabase();
  insertDraftNewRoadContract();
});

const WIDTHS = [360, 180] as const;

/** The interactive controls inside `scope` that stick out of the viewport, and whether the page scrolls sideways. */
async function overflow(page: Page, scope: string): Promise<{ stuck: string[]; pageScrolls: boolean; wide: string[] }> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const w = document.documentElement.clientWidth;
    const stuck: string[] = [];
    root?.querySelectorAll<HTMLElement>('input, select, textarea, button, a.btn').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // hidden
      if (r.left < -1 || r.right > w + 1) stuck.push(`${el.tagName.toLowerCase()} ${el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 24) ?? ''} [${Math.round(r.left)}..${Math.round(r.right)}] of ${w}`);
    });
    // For the failure message only: what inside the column is wider than the column.
    const box = root?.getBoundingClientRect();
    const wide = root && box
      ? [...root.querySelectorAll<HTMLElement>('*')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1))
          .slice(0, 6)
          .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} [${Math.round(r.left)}..${Math.round(r.right)}] in [${Math.round(box.left)}..${Math.round(box.right)}]`)
      : [];
    // The column itself: inside the viewport, and not scrolling inside. (The desk's own nav row is wider than a phone —
    // it was before DX1 and is not this stage's — so the *page* scrolling sideways is not what is measured.)
    const rect = root?.getBoundingClientRect();
    const columnOut = !root || !rect || rect.left < -1 || rect.right > w + 1 || (root as HTMLElement).scrollWidth > (root as HTMLElement).clientWidth + 1;
    if (root) root.querySelectorAll<HTMLElement>('*').forEach((el) => { if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1 && !el.classList.contains('sr-only') && !/^(input|textarea|select)$/i.test(el.tagName)) wide.push(`self-overflow ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} ${el.scrollWidth}>${el.clientWidth}`); });
    if (columnOut && root && box) wide.push(`column [${Math.round(box.left)}..${Math.round(box.right)}] scrollWidth ${(root as HTMLElement).scrollWidth} clientWidth ${(root as HTMLElement).clientWidth} of ${w}`);
    return { stuck, pageScrolls: columnOut, wide };
  }, scope);
}

async function expectFits(page: Page, scope: string) {
  await page.locator(scope).first().waitFor();
  const { stuck, pageScrolls, wide } = await overflow(page, scope);
  const width = page.viewportSize()?.width;
  expect(stuck, `controls outside the column at ${width}px`).toEqual([]);
  expect(pageScrolls, `the column overflows at ${width}px: ${wide.join(' | ')}`).toBe(false);
}

async function openWorkspace(page: Page, who: typeof SALES | typeof ADMIN, ref: string, lang: 'en' | 'fa' = 'en') {
  await signIn(page, who, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: ref }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
  contractId = page.url().split('/contracts/')[1].split('/')[0];
}

test('the step you are on is unmistakable, every pill says where its step stands, and Requirements counts what is missing', async ({ page }) => {
  await openWorkspace(page, SALES, WIZARD_CONTRACT_REF);
  const pills = page.locator('.stepper-item');
  await page.evaluate(() => document.fonts.ready);

  // The current step: nobody has done anything yet, so it is Root's — "your turn" — and says how much is missing.
  const requirements = page.locator('.stepper-item[data-step="REQUIREMENTS"]');
  await expect(requirements).toHaveAttribute('data-pill', /YOUR_TURN|WAITING_CUSTOMER/);
  await expect(requirements.getByTestId('pill-missing')).toHaveText(/\d+ (missing|items? missing)/);
  await expect(requirements.getByTestId('pill-state')).toHaveText(/Your turn|Waiting on the customer/);
  // The others carry no count — there is no data for one.
  await expect(page.locator('.stepper-item[data-step="SCOPE"]').getByTestId('pill-missing')).toHaveCount(0);
  await expect(page.locator('.stepper-item[data-step="SCOPE"]').getByTestId('pill-state')).toHaveText('Upcoming');

  // Selected: exactly one pill, marked for assistive technology and drawn heavier than the rest in more than colour.
  await page.locator('.stepper-item[data-step="DRAFT"] button').click();
  await expect(page.locator('.stepper-item[data-selected="true"]')).toHaveCount(1);
  await expect(page.locator('.stepper-item[data-step="DRAFT"] button')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.stepper button[aria-current="step"]')).toHaveCount(1);
  const weight = (step: string) =>
    page.locator(`.stepper-item[data-step="${step}"] .stepper-label`).evaluate((el) => Number(getComputedStyle(el).fontWeight));
  const outline = (step: string) =>
    page.locator(`.stepper-item[data-step="${step}"] .stepper-hit`).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(await weight('DRAFT')).toBeGreaterThan(await weight('SCOPE'));
  expect(await outline('DRAFT')).not.toBe('none');
  expect(await outline('SCOPE')).toBe('none');

  // "What's next": whose turn, what to do, a button that opens that step.
  const next = page.getByTestId('next-up');
  await expect(next).toBeVisible();
  await expect(next).toHaveAttribute('data-step', 'REQUIREMENTS');
  await page.getByTestId('next-up-open').click();
  await expect(page.locator('.stepper-item[data-step="REQUIREMENTS"] button')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('requirements-panel')).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
    await expectFits(page, '[data-testid="next-up"]');
  }
  expect(await pills.count()).toBeGreaterThan(5);
});

test('requirements inputs: accordions open on what is missing, support months and providers are pills, counts step, money reads grouped — in both languages', async ({ page }) => {
  for (const lang of ['en', 'fa'] as const) {
    await openWorkspace(page, SALES, DRAFT_CONTRACT_REF, lang);
    await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
    const editor = page.getByTestId('requirements-editor');
    await expect(editor).toBeVisible();

    // Nothing is written: the first panel that lacks something is open, the others are folded.
    await expect(page.getByTestId('acc-brief')).toHaveAttribute('data-open', 'true');
    // (DX2a: Requirements holds the brief and the hand-over; the phases and the plan are the next step's accordions.)
    await expect(page.getByTestId('acc-handOver')).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('acc-brief').locator('[data-missing]')).toHaveAttribute('data-missing', /[1-9]/);
    await page.getByTestId('acc-handOver').getByRole('button').first().click();
    await expect(page.getByTestId('acc-handOver')).toHaveAttribute('data-open', 'true');
    await page.getByTestId('acc-handOver').getByRole('button').first().click();
    await expect(page.getByTestId('acc-handOver')).toHaveAttribute('data-open', 'false');

    // Money: the input stays plain digits, the readout groups them in the panel's own digits.
    const budget = page.locator('#brief-budget');
    await budget.fill('150000000');
    await expect(budget).toHaveValue('150000000');
    await expect(page.getByTestId('budget-readout')).toContainText(lang === 'fa' ? '۱۵۰٬۰۰۰٬۰۰۰' : '150,000,000');

    // Support months: pills; Other reveals the number field; the stored number is the same.
    const support = page.getByTestId('brief-support-pills');
    await expect(page.locator('#brief-support')).toHaveCount(0);
    await support.locator('button[data-value="12"]').click();
    await expect(support.locator('button[data-value="12"]')).toHaveAttribute('aria-pressed', 'true');
    await support.locator('button[data-value="other"]').click();
    await page.locator('#brief-support').fill('18');
    await expect(support.locator('button[data-value="other"]')).toHaveAttribute('aria-pressed', 'true');

    // (Who provides what moved to the handover panel, with Not needed — 35-handover.spec.ts drives it.)

    // Counts: a large number between − and +; it never goes below zero.
    const demos = page.getByTestId('brief-demos');
    await demos.getByRole('button', { name: /^(Increase|زیاد)/ }).click();
    await demos.getByRole('button', { name: /^(Increase|زیاد)/ }).click();
    await expect(demos).toHaveAttribute('data-value', '2');
    await expect(demos.locator('output')).toHaveText(lang === 'fa' ? '۲' : '2');
    for (let i = 0; i < 3; i += 1) {
      const less = demos.getByRole('button', { name: /^(Decrease|کم)/ });
      if (await less.isEnabled()) await less.click();
    }
    await expect(demos).toHaveAttribute('data-value', '0');
    await expect(demos.getByRole('button', { name: /^(Decrease|کم)/ })).toBeDisabled();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectFits(page, '[data-testid="requirements-editor"]');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

test.describe('with steps 1 and 2 done', () => {
  test.beforeAll(async ({ request }) => {
    resetTestDatabase();
    insertDraftNewRoadContract();
    contractId = await completeStepOneViaApi(request);
    await completeStepTwoViaApi(request, contractId);
  });

  const contractTab = (lang: 'en' | 'fa') => `/${lang}/desk/contracts/${contractId}/contract`;

  test('one date field: typed in Persian or English it stores the same day, the calendar opens in the panel’s own calendar, and the keyboard reaches it', async ({ page }) => {
    await signIn(page, SALES, 'en');
    await page.goto(contractTab('en'));
    const start = page.getByTestId('draft-date-start');
    const text = start.locator('input[data-part="text"]');
    await expect(start.locator('select')).toHaveCount(0);

    // English: a Gregorian day, a Jalali day, and the same day in each.
    await text.fill('2026-11-22');
    await expect(start).toHaveAttribute('data-value', '2026-11-22');
    await text.fill('1405/09/01');
    await expect(start).toHaveAttribute('data-value', '2026-11-22');
    await text.fill('1405/13/40');
    await expect(start).toHaveAttribute('data-value', '');
    await expect(start.getByTestId('dayinput-invalid')).toBeVisible();
    await text.fill('1403/12/30'); // a Jalali leap year's last day
    await expect(start).toHaveAttribute('data-value', '2025-03-20');
    await text.fill('1404/12/30'); // not a leap year: not a day
    await expect(start).toHaveAttribute('data-value', '');

    // The English calendar is Gregorian: November 2026, picked by the keyboard.
    await text.fill('2026-11-17');
    await start.locator('button[data-part="open"]').click();
    const calendar = start.locator('[data-part="calendar"]');
    await expect(calendar).toContainText('November 2026');
    await expect(calendar.locator('button[data-day="2026-11-17"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(calendar.locator('button[data-day="2026-11-25"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(calendar).toHaveCount(0);
    await expect(start).toHaveAttribute('data-value', '2026-11-25');
    await expect(text).toBeFocused();
    await page.keyboard.press('Escape');

    const end = page.getByTestId('draft-date-end');
    await end.locator('input[data-part="text"]').fill('2027-01-21');
    await end.locator('input[data-part="text"]').blur();
    await expectSaved(page, 'draft-dates-autosave');

    // Persian: the same stored day, shown as a Jalali date in Persian digits; the calendar is Jalali (Azar 1405).
    await page.goto(contractTab('fa'));
    const faStart = page.getByTestId('draft-date-start');
    await expect(faStart.locator('input[data-part="text"]')).toHaveValue('۱۴۰۵/۰۹/۰۴');
    await expect(faStart).toHaveAttribute('data-value', '2026-11-25');
    await faStart.locator('button[data-part="open"]').click();
    await expect(faStart.locator('[data-part="calendar"]')).toContainText('آذر ۱۴۰۵');
    // Typed in Persian digits, then in Latin digits: both land on the same day.
    await faStart.locator('input[data-part="text"]').fill('۱۴۰۵/۰۹/۰۱');
    await expect(faStart).toHaveAttribute('data-value', '2026-11-22');
    await faStart.locator('input[data-part="text"]').fill('1405/09/01');
    await expect(faStart).toHaveAttribute('data-value', '2026-11-22');
    // A day clicked in the Jalali grid.
    await faStart.locator('button[data-day="2026-11-24"]').click();
    await expect(faStart.locator('input[data-part="text"]')).toHaveValue('۱۴۰۵/۰۹/۰۳');
    await expect(faStart).toHaveAttribute('data-value', '2026-11-24');

    for (const lang of ['en', 'fa'] as const) {
      await page.goto(contractTab(lang));
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByTestId('draft-date-start').locator('button[data-part="open"]').click();
        await expectFits(page, '[data-testid="draft-dates-editor"]');
        await page.getByTestId('draft-date-start').locator('input[data-part="text"]').focus();
        await page.keyboard.press('Escape');
        await page.getByTestId('draft-date-start').locator('button[data-part="open"]').click(); // closes
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  test('the Draft step holds a summary and Publish twice — no title, price or dates; the Contract tab holds them, the readiness box, folding articles and Publish at the top', async ({ page }) => {
    await signIn(page, SALES, 'en');
    await page.goto(`/en/desk/contracts/${contractId}/steps?step=DRAFT`);
    const draft = page.getByTestId('draft-panel');
    await expect(draft).toBeVisible();
    await expect(page.getByTestId('draft-summary')).toBeVisible();
    await expect(page.getByTestId('draft-summary-requirements')).toContainText('Store');
    await expect(page.getByTestId('draft-summary-scope')).toContainText('Pages');
    await expect(draft.locator('#ct-en')).toHaveCount(0);
    await expect(draft.locator('#ct-amount')).toHaveCount(0);
    await expect(draft.getByTestId('draft-dates-editor')).toHaveCount(0);
    await expect(draft.getByTestId('draft-publish')).toBeVisible();
    await expect(draft.getByTestId('draft-publish-bottom')).toBeVisible();
    // The foot comes after the articles, the top before them.
    const order = await draft.evaluate((el) => {
      const pos = (id: string) => el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
      return [pos('draft-publish'), pos('draft-foot')];
    });
    expect(order[0]).toBeLessThan(order[1]);
    // The planned dates saved by the story above are an unpublished change: the button at the foot publishes them (v2) and
    // says so beside itself; a second press has nothing new to publish and says that, in the same place.
    await draft.getByTestId('draft-publish-bottom').click();
    await expect(draft.getByTestId('draft-published-bottom')).toBeVisible();
    await draft.getByTestId('draft-publish-bottom').click();
    await expect(draft.getByTestId('draft-publish-error-bottom')).toContainText('Nothing has changed');
    await draft.getByTestId('draft-publish').click();
    await expect(draft.getByTestId('draft-publish-error')).toContainText('Nothing has changed');

    // The Contract tab.
    await page.goto(contractTab('en'));
    await expect(page.locator('#ct-en')).toBeVisible();
    await expect(page.locator('#ct-amount')).toHaveValue('150000000');
    await expect(page.getByTestId('amount-readout')).toContainText('150,000,000');
    await expect(page.getByTestId('draft-dates-editor')).toBeVisible();
    const box = page.getByTestId('readiness-box');
    await expect(box).toBeVisible();
    await expect(box.getByTestId('readiness-clear')).toBeVisible();
    await expect(box.locator('[data-fact="last-published"]')).toContainText('v2');
    await expect(box.locator('[data-fact="unpublished-changes"]')).toHaveAttribute('data-dirty', 'no');
    await expect(page.getByTestId('publish-top')).toBeDisabled(); // nothing to publish yet

    // An edit makes the draft dirty — the box says yes, and Publish at the top is live.
    const cards = page.getByTestId('article-card');
    await expect(cards.first()).toHaveAttribute('data-folded', 'false');
    await cards.first().locator('textarea').nth(1).fill('Changed English text');
    await cards.first().locator('textarea').nth(1).blur();
    await expectSaved(cards.first(), 'article-autosave');
    await expect(cards.first().getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(box.locator('[data-fact="unpublished-changes"]')).toHaveAttribute('data-dirty', 'yes');
    await expect(page.getByTestId('publish-top')).toBeEnabled();

    // Folding: one article, then all, then all open again.
    await cards.first().getByTestId('article-toggle').click();
    await expect(cards.first()).toHaveAttribute('data-folded', 'true');
    await expect(cards.first().locator('textarea').first()).toBeHidden();
    await expect(cards.first().getByTestId('article-title')).toBeVisible();
    await expect(cards.nth(1)).toHaveAttribute('data-folded', 'false');
    await page.getByTestId('fold-all').click();
    for (let i = 0; i < (await cards.count()); i += 1) await expect(cards.nth(i)).toHaveAttribute('data-folded', 'true');
    await page.getByTestId('open-all').click();
    await expect(cards.first()).toHaveAttribute('data-folded', 'false');
    // A half-typed edit survives a fold.
    await cards.first().locator('textarea').nth(1).fill('Typed but not saved');
    await cards.first().getByTestId('article-toggle').click();
    await cards.first().getByTestId('article-toggle').click();
    await expect(cards.first().locator('textarea').nth(1)).toHaveValue('Typed but not saved');
    await cards.first().locator('textarea').nth(1).fill('Changed English text');

    // Publish from the top of the tab.
    await page.getByTestId('publish-top').click();
    await expect(box.locator('[data-fact="last-published"]')).toContainText('v3');
    await expect(box.locator('[data-fact="unpublished-changes"]')).toHaveAttribute('data-dirty', 'no');
    await expect(page.getByTestId('publish-top')).toBeDisabled();

    for (const lang of ['en', 'fa'] as const) {
      await page.goto(contractTab(lang));
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await expectFits(page, '.workspace-panel');
      }
      await page.goto(`/${lang}/desk/contracts/${contractId}/steps?step=DRAFT`);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await expectFits(page, '[data-testid="draft-panel"]');
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  test('the readiness box names what blocks publishing, each a link to its step', async ({ page, request }) => {
    // A new phase-less, scope-less contract: use the draft-state contract from the first stories.
    await signIn(page, SALES, 'en');
    await page.goto('/en/desk/contracts');
    await page.locator('tr.crow', { hasText: DRAFT_CONTRACT_REF }).locator('td').first().click();
    await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/steps$/);
    const id = page.url().split('/contracts/')[1].split('/')[0];
    await page.goto(`/en/desk/contracts/${id}/contract`);
    const blockers = page.getByTestId('readiness-blockers');
    await expect(blockers).toBeVisible();
    await expect(blockers.locator('[data-code="SCOPE_UNCONFIRMED"] a')).toHaveAttribute('href', /steps\?step=SCOPE/);
    await expect(blockers.locator('[data-code="BRIEF_INCOMPLETE"] a')).toHaveAttribute('href', /steps\?step=REQUIREMENTS/);
    await expect(page.getByTestId('readiness-box').locator('[data-fact="last-published"]')).toContainText('Never');
    await blockers.locator('[data-code="BRIEF_INCOMPLETE"] a').click();
    await expect(page.locator('.stepper-item[data-step="REQUIREMENTS"] button')).toHaveAttribute('aria-current', 'step');
    expect(request).toBeTruthy();
  });

  test('an admin reading the draft in English sees the articles — an article nobody wrote in English says so, and only money is “withheld”', async ({ page, request }) => {
    // An article with Persian text and no English text, published.
    await apiSignIn(request, SALES);
    await gql(
      request,
      'mutation($c: ID!){ setArticle(contractId: $c, number: 90, titleFa: "ماده‌ی آزمایشی", titleEn: "Persian only", bodyFa: "فقط فارسی", bodyEn: null, sensitive: false) { id } }',
      { c: contractId },
    );
    await gql(request, 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', { c: contractId });

    await signIn(page, ADMIN, 'en');
    await page.goto(`/en/desk/contracts/${contractId}/steps?step=DRAFT`);
    const draft = page.getByTestId('draft-panel');
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId('draft-body').first()).toBeVisible(); // the template's articles read
    const mine = draft.locator('.feedback-target-group').filter({ hasText: 'Persian only' });
    await expect(mine.getByTestId('draft-body-unwritten')).toHaveText('No English text yet.');
    // Nothing here is money-withheld for an admin — the bug drew every article without English text as if it were.
    await expect(draft.getByTestId('draft-body-hidden')).toHaveCount(0);

    // The same article in Persian reads its text.
    await page.goto(`/fa/desk/contracts/${contractId}/steps?step=DRAFT`);
    await expect(page.getByTestId('draft-panel').getByText('فقط فارسی')).toBeVisible();
    await expect(page.getByTestId('draft-body-hidden')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('draft-panel').locator('.feedback-target-group').filter({ hasText: 'فقط فارسی' }).getByTestId('draft-body-unwritten')).toHaveCount(0);
  });
});
