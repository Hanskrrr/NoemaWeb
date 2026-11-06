import { expect, type Page, test } from '@playwright/test';
import { ask, currentThreadId, doubleClickWord, freshThread, highlighted, lastAnswer, ulidish } from './helpers.ts';

// Finding your way: a catalog on the right of long threads and notes, and a
// way straight back from deep side questions.

const H = { 'x-noema-client': 'web' };

async function answered(page: Page, question: string) {
  await ask(page, question);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
}

test('a long thread has a catalog: each question, its side questions, and where you are', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'First question about gradients');
  await answered(page, 'Second question about momentum');
  await expect(page.getByTestId('outline')).toHaveCount(0); // short threads do without
  await answered(page, 'Third question about Adam');
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'A side question');
  await page.getByTestId('back').click();

  const outline = page.getByTestId('outline');
  const items = outline.getByTestId('outline-item');
  await expect(outline.locator('[data-testid=outline-item][data-kind=question]')).toHaveCount(3);
  await expect(outline.locator('[data-kind=side]')).toContainText('↳');

  await page.evaluate(() => window.scrollTo(0, 0));
  await outline.hover();
  await expect(outline.getByText('Third question about Adam')).toBeVisible();
  await items.filter({ hasText: 'Third question about Adam' }).click();
  const third = page.locator('[data-testid=message][data-role=user]').filter({ hasText: 'Third question about Adam' });
  await expect(third).toBeInViewport();
  await expect(items.filter({ hasText: 'Third question about Adam' })).toHaveAttribute('aria-current', 'location');

  await items.filter({ hasText: 'First question' }).click();
  await expect(page.locator('[data-testid=message][data-role=user]').first()).toBeInViewport();
  await expect(items.filter({ hasText: 'First question' })).toHaveAttribute('aria-current', 'location');
});

test('a note has a catalog of its headings', async ({ page, request }) => {
  const nb = await (await request.get('/api/notebooks')).json();
  const id = ulidish();
  const created = await request.post(`/api/notebooks/${nb.notebooks[0].id}/notes`, { data: { id }, headers: H });
  expect(created.status()).toBe(201);
  let after: string | null = null;
  const filler = 'Some text that takes room. '.repeat(40);
  for (const text of ['# Part one', filler, '## A detail', filler, '# Part two', filler]) {
    const blockId = ulidish();
    const r = await request.post(`/api/notes/${id}/blocks`, { data: { id: blockId, after, content: text }, headers: H });
    expect(r.ok()).toBe(true);
    after = blockId;
  }
  await page.goto(`/#/note/${id}`);
  const outline = page.getByTestId('outline');
  await expect(outline.getByTestId('outline-item')).toHaveText(['Part one', 'A detail', 'Part two']);
  await outline.getByTestId('outline-item').filter({ hasText: 'Part two' }).click();
  await expect(page.getByTestId('block').filter({ hasText: 'Part two' })).toBeInViewport();
});

test('two side questions deep, one click goes back to where the detours began', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'The main question');
  const main = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'First detour');
  const first = currentThreadId(page);
  await expect(page.getByTestId('back-to-main')).toHaveCount(0); // one level: Back is enough
  await doubleClickWord(page, 'tests');
  await page.getByTestId('branch-button').click();
  await answered(page, 'Second detour');

  await page.getByTestId('back-to-main').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}/from/${first}$`));
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('offline');
});
