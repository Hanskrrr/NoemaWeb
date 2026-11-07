import { expect, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord, freshThread, showList } from './helpers.ts';

// The Trash: threads and notes are deleted to it and restored from it, and a
// thread's side questions fold away in the sidebar.

test('a thread goes to the Trash with its side questions, and comes back with Undo or from the Trash', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'A thread about tapirs to delete');
  const main = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'Its side question');
  const side = currentThreadId(page);
  await page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}$`));

  // Asked first; says what goes with it.
  await page.getByTestId('thread-delete').click();
  await expect(page.getByTestId('thread-delete-confirm')).toContainText('and its side question');
  await page.getByTestId('thread-delete-yes').click();
  await expect(page.getByTestId('app-toast')).toContainText('moved to the Trash');
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).toHaveCount(0);

  // Undo.
  await page.getByTestId('toast-undo').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}$`));
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).toBeVisible();

  // Again, and back from the Trash this time.
  await page.getByTestId('thread-delete').click();
  await page.getByTestId('thread-delete-yes').click();
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`)).toHaveCount(0);
  await showList(page, 'trash');
  const item = page.locator(`[data-testid=trash-item][data-id="${main}"]`);
  await expect(item).toContainText('+ 1');
  // Open it to read: marked, with no box to ask in.
  await item.locator('.thread-link').click();
  await expect(page.getByTestId('in-trash')).toBeVisible();
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await page.getByTestId('restore').click();
  await expect(page.getByTestId('in-trash')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).toBeVisible();
});

test('a note goes to the Trash and comes back', async ({ page }) => {
  await page.goto('/#/new');
  await showList(page, 'notes');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-rename').click();
  await page.getByTestId('note-title-input').fill('Pangolin facts');
  await page.getByTestId('note-title-input').press('Enter');
  const link = page.locator('[data-testid=note-link]').filter({ hasText: 'Pangolin facts' });
  await expect(link).toBeVisible();
  await page.getByTestId('note-delete').click();
  await page.getByTestId('note-delete-confirm').click();
  await expect(link).toHaveCount(0);
  await page.getByTestId('toast-undo').click();
  await expect(link).toBeVisible();
  await expect(page.getByTestId('note-rename')).toContainText('Pangolin facts');
});

test('a thread’s side questions fold away in the sidebar, and stay folded', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'A thread with side questions about lemurs');
  const main = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'A side question');
  const side = currentThreadId(page);
  await page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${main}$`));

  const sideLink = page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`);
  const fold = page.locator(`[data-testid=fold][data-thread-id="${main}"]`);
  await expect(sideLink).toBeVisible();
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(sideLink).toHaveCount(0);
  await expect(page.locator(`li:has(> .thread-row [data-thread-id="${main}"]) [data-testid=fold-count]`)).toHaveText('1');
  await page.reload();
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`)).toBeVisible();
  await expect(sideLink).toHaveCount(0);
  // Opening a folded side question (here by its URL) shows it in place.
  await page.goto(`/#/t/${side}`);
  await expect(sideLink).toBeVisible();
  await page.goto(`/#/t/${main}`);
  await expect(sideLink).toHaveCount(0);
  await fold.click();
  await expect(sideLink).toBeVisible();
});
