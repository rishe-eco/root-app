import { test, expect } from '@playwright/test';
import { REVIEWER, publishTestRound, resetTestDatabase, signIn } from './helpers';

/**
 * C1's e2e spec (§6): the seeded reviewer signs in, lands on the desk with
 * exactly the sections review.participate grants, opens a round and reads
 * a document. Kept cheap on purpose, same reasoning as R1/R2's — the value
 * is in the integration suite (c1.test.ts), which holds the trust-boundary
 * revalidation this spec has no way to see.
 *
 * The round itself is seeded through `publishReviewRound` directly (see
 * `publishTestRound` in helpers.ts), not through the publish-round CLI —
 * there is no root-sot checkout to shell git against here. The CLI's own
 * git-and-split half is proven separately, against a real throwaway repo.
 */

const SHA = 'c'.repeat(40);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  await publishTestRound(request, {
    sha: SHA,
    label: 'Learn Module 1 review',
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

test('the seeded reviewer signs in, lands on the desk with one round-holding section, opens a round and reads a document', async ({
  page,
}) => {
  await signIn(page, REVIEWER);

  const nav = page.locator('.desk-nav');
  await expect(nav.getByText('Review')).toBeVisible();
  await expect(nav.getByText('Library')).toHaveCount(0);

  await page.goto('/en/desk/review');
  await expect(page.getByText('Learn Module 1 review')).toBeVisible();
  await expect(page.getByText(SHA.slice(0, 12))).toBeVisible();

  await page.getByRole('link', { name: 'Learn' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/review\/[a-z0-9]+\/[a-z0-9]+$/);

  // Rendered from the blocks — a real <h1>, not the raw "# Learn" markdown.
  await expect(page.getByRole('heading', { name: 'Learn', level: 1 })).toBeVisible();
  await expect(page.getByText('The pillar is about growing a mind that grows.')).toBeVisible();
});
