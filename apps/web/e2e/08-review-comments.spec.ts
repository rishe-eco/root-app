import { test, expect } from '@playwright/test';
import { ADMIN, REVIEWER, REVIEWER2, publishTestRound, resetTestDatabase, signIn } from './helpers';

/**
 * C2's e2e spec (§8): a reviewer selects a passage, opens a thread, Root
 * replies and resolves it, and a second seeded reviewer — the property the
 * whole stage rests on (§3) — sees no trace that a thread exists at all.
 */

const SHA = 'd'.repeat(40);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  await publishTestRound(request, {
    sha: SHA,
    label: 'Comments smoke round',
    documents: [
      {
        path: 'ecosystem/canon/02-pillars/learn.md',
        title: 'Learn',
        order: 0,
        blocks: [
          { id: 'b1', kind: 'HEADING', depth: 1, text: '# Learn' },
          { id: 'b2', kind: 'PARAGRAPH', text: 'The pillar is about growing a mind that grows.' },
        ],
      },
    ],
  });
});

/** Selects "growing a mind" inside the seeded paragraph and fires the same
 *  mouseup the real UI listens for — Playwright has no built-in drag-select
 *  gesture that lands inside specific text offsets, so the selection is
 *  made programmatically and the event dispatched to match. */
async function selectGrowingAMind(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const block = document.querySelector('[data-block-id="b2"]')!;
    const textNode = block.querySelector('p')!.firstChild as Text;
    const needle = 'growing a mind';
    const start = textNode.data.indexOf(needle);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator('.review-doc-body').dispatchEvent('mouseup');
}

test('a reviewer opens a thread, Root replies and resolves it, and a second reviewer sees an unmarked document', async ({
  page,
}) => {
  await signIn(page, REVIEWER);
  await page.goto('/en/desk/review');
  await page.getByRole('link', { name: 'Learn' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/review\/[a-z0-9]+\/[a-z0-9]+$/);

  await selectGrowingAMind(page);
  await expect(page.getByText('“growing a mind”')).toBeVisible();
  await page.locator('.review-thread-compose textarea').fill('Say more about this?');
  await page.getByRole('button', { name: 'Open thread' }).click();

  const threadCard = page.locator('.review-thread-card');
  await expect(threadCard).toBeVisible();
  await expect(threadCard.getByText('Say more about this?')).toBeVisible();
  await expect(page.locator('mark.review-mark')).toHaveText('growing a mind');

  await signIn(page, ADMIN);
  await page.goto('/en/desk/review');
  await page.getByRole('link', { name: 'Learn' }).click();

  const rootThreadCard = page.locator('.review-thread-card');
  await expect(rootThreadCard).toBeVisible();
  await expect(rootThreadCard.getByText('Say more about this?')).toBeVisible();
  await rootThreadCard.locator('textarea').fill('It means practising, deliberately, at the edge of what you can do.');
  await rootThreadCard.getByRole('button', { name: 'Reply' }).click();
  await expect(rootThreadCard.getByText('It means practising, deliberately, at the edge of what you can do.')).toBeVisible();

  await rootThreadCard.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Resolved')).toBeVisible();

  await signIn(page, REVIEWER2);
  await page.goto('/en/desk/review');
  await page.getByRole('link', { name: 'Learn' }).click();
  await expect(page.locator('.review-thread-card')).toHaveCount(0);
  await expect(page.locator('mark.review-mark')).toHaveCount(0);
  await expect(page.getByText('Say more about this?')).toHaveCount(0);
});
