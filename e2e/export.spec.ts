import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ask, freshThread, lastAnswer } from './helpers.ts';
import { EMPTY_URL } from './ports.ts';

// Export and import from the app: a copy of everything, a Markdown file to
// read, and the copy imported into an empty Noema. The round-trip itself,
// table by table, is the acceptance test in apps/server/test/export-import.test.ts.

test('export a copy and a Markdown file; the copy imports into an empty Noema, not into this one', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'What is a basis of a vector space?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');

  await page.getByTestId('export-open').click();
  const [copy] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  expect(copy.suggestedFilename()).toMatch(/^noema-export-\d{4}-\d{2}-\d{2}\.json$/);
  const copyPath = await copy.path();
  const data = JSON.parse(readFileSync(copyPath, 'utf8'));
  expect(data.format).toBe('noema-export');

  const [readable] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-md').click()]);
  expect(readable.suggestedFilename()).toMatch(/\.md$/);
  expect(readFileSync(await readable.path(), 'utf8')).toContain('**You asked:** What is a basis of a vector space?');

  // This notebook has things in it: the copy is not imported over them.
  await page.getByTestId('import-file').setInputFiles(copyPath);
  await expect(page.getByTestId('import-error')).toContainText('empty');

  // An empty Noema takes it, and opens with the same threads.
  await page.goto(EMPTY_URL);
  await page.getByTestId('export-open').click();
  await page.getByTestId('import-file').setInputFiles(copyPath);
  await expect(page.getByTestId('import-done')).toContainText(/Imported \d+ threads?/);
  await page.getByTestId('import-open').click();
  await expect(page.locator('[data-testid=thread-link]', { hasText: 'basis of a vector space' }).first()).toBeVisible();
});
