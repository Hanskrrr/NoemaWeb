import { expect, type Page, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord, freshThread, highlighted, lastAnswer } from './helpers.ts';

// Finding things again (M4), and the brief's acceptance tests 1 (zero
// records) and 5 (find again inside a branch).


async function branchFrom(page: Page, word: string, question: string) {
  await doubleClickWord(page, word);
  await page.getByTestId('branch-button').click();
  await answered(page, question);
}

/** Open search from the keyboard and type a query. */
async function searchFor(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('search')).toBeVisible();
  await page.getByTestId('search-input').fill(query);
}

test('acceptance 1, zero records: ask, branch, return, quit, reopen, search, ask again', async ({
  page,
  context,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'How does a zebra crossing work?');
  const main = currentThreadId(page);
  await branchFrom(page, 'offline', 'Why is the okapi offline?');
  const side = currentThreadId(page);
  await page.getByTestId('back').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}/from/${side}$`));

  // Quit and reopen: Noema opens where you were, the main thread, not the side question.
  await page.close();
  const again = await context.newPage();
  await again.goto('/');
  await expect(again).toHaveURL(new RegExp(`#/t/${main}$`));
  await expect(again.locator('[data-testid=message][data-role=user]').first()).toContainText('zebra crossing');

  // Search for the side question's word and open it.
  await searchFor(again, 'okapi');
  const hit = again.getByTestId('search-hit').first();
  await expect(hit).toContainText('okapi');
  await hit.click();
  await expect(again).toHaveURL(new RegExp(`#/t/${side}/m/[0-9A-Z]{26}$`));
  await expect(again.getByTestId('search')).toHaveCount(0);

  // And carry on there. No note or summary was ever needed.
  await answered(again, 'And what about giraffes?');
  await expect(lastAnswer(again)).toContainText('And what about giraffes?');
  expect(currentThreadId(again)).toBe(side);
});

test('acceptance 5, find again: a word jumps to the exact message inside a side question, and is marked there', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Tell me about attention');
  const main = currentThreadId(page);
  await branchFrom(page, 'offline', 'Why scale by the square root?');
  const side = currentThreadId(page);
  await answered(page, 'What is the variance of a dot product of capybara vectors?');
  await answered(page, 'One more question after it');
  await answered(page, 'And another one');

  // From somewhere else entirely.
  await page.goto(`/#/t/${main}`);
  await searchFor(page, 'capybara');
  const hits = page.getByTestId('search-hit');
  await expect(hits.first()).toBeVisible();
  const question = hits.filter({ hasText: 'You asked in a side question' });
  await expect(question).toHaveCount(1);
  // It says where it is: the main thread, then the side question.
  await expect(question.locator('.hit-where')).toContainText('›');
  await expect(question.locator('mark')).toHaveText('capybara');

  // Keyboard: down to it, Enter.
  const index = await hits.evaluateAll((els) =>
    els.findIndex((el) => el.textContent?.includes('You asked in a side question')),
  );
  for (let i = 0; i < index; i++) await page.getByTestId('search-input').press('ArrowDown');
  await expect(question).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('search-input').press('Enter');

  await expect(page).toHaveURL(new RegExp(`#/t/${side}/m/[0-9A-Z]{26}$`));
  const target = page.locator('[data-testid=message][data-role=user]').filter({ hasText: 'capybara' });
  await expect(target).toBeInViewport();
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('capybara');

  // Words in Chinese work too (the fake answer has 机器学习).
  await searchFor(page, '机器学习');
  await expect(page.getByTestId('search-hit').first().locator('mark')).toContainText('机器学习');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toHaveCount(0);

  // Nothing found says so.
  await page.getByTestId('search-open').click();
  await page.getByTestId('search-input').fill('qzxjv');
  await expect(page.getByTestId('search-empty')).toContainText('Nothing found');
});

test('a word in a note opens the note at that block', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Topic for a searchable note');
  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  const noteUrl = page.url();
  const blocks = page.getByTestId('note').getByTestId('block');
  const last = blocks.last();
  await last.hover();
  await last.getByTestId('block-edit').click();
  await page.getByTestId('block-textarea').fill('Pangolins roll into a ball.');
  await page.getByTestId('block-textarea').press('Control+Enter');
  await expect(last).toContainText('Pangolins');

  await page.goto('/#/new');
  await searchFor(page, 'pangolins');
  const hit = page.getByTestId('search-hit').first();
  await expect(hit).toHaveAttribute('data-kind', 'block');
  await expect(hit).toContainText('In a note');
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`${noteUrl.split('#')[1]}/b/[0-9A-Z]{26}$`));
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('Pangolins');
});

test('side questions you never came back from: listed in search, set aside, and offered when Noema opens', async ({
  page,
  context,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'A main question about tapirs');
  const main = currentThreadId(page);
  await branchFrom(page, 'offline', 'A side question I leave open');
  const side = currentThreadId(page);
  // Away by the sidebar, not by Back: the side question stays open.
  await page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}$`));

  // Opened fresh: one quiet line names it, in sight.
  const fresh = await context.newPage();
  await fresh.goto('/');
  await expect(fresh).toHaveURL(new RegExp(`#/t/${main}$`));
  const line = fresh.getByTestId('come-back');
  await expect(line).toContainText('Left open');
  await expect(line.locator(`[data-thread-id="${side}"]`)).toBeInViewport();
  // Reopened inside the side question itself, the line doesn't offer it.
  await fresh.goto(`/#/t/${side}`);
  await expect(fresh.locator('[data-testid=message][data-role=user]').first()).toContainText('leave open');
  const inside = await context.newPage();
  await inside.goto('/');
  await expect(inside).toHaveURL(new RegExp(`#/t/${side}$`));
  await expect(inside.locator(`[data-testid=come-back-item][data-thread-id="${side}"]`)).toHaveCount(0);
  await inside.close();
  await fresh.goto(`/#/t/${main}`);

  // Search with nothing typed lists it, with where it came from.
  await fresh.keyboard.press('ControlOrMeta+k');
  const item = fresh.locator(`[data-testid=left-open-item][data-thread-id="${side}"]`);
  await expect(item).toContainText('offline');
  await item.click();
  await expect(fresh).toHaveURL(new RegExp(`#/t/${side}$`));
  await expect(fresh.getByTestId('come-back')).toHaveCount(0);

  // "Not now" takes it off the list.
  await fresh.getByTestId('search-open').click();
  await fresh.locator(`[data-testid=left-open-item][data-thread-id="${side}"]`).locator('..').getByTestId('left-open-aside').click();
  await expect(fresh.locator(`[data-testid=left-open-item][data-thread-id="${side}"]`)).toHaveCount(0);
  await fresh.keyboard.press('Escape');
  await fresh.keyboard.press('ControlOrMeta+k');
  await expect(fresh.locator(`[data-testid=left-open-item][data-thread-id="${side}"]`)).toHaveCount(0);
});
