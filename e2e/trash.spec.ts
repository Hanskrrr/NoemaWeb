import { expect, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord, freshThread, showList, ulidish } from './helpers.ts';

const H = { 'x-noema-client': 'web' };

// The Trash: threads and notes are deleted to it and restored from it, and a
// thread's side questions fold away in the sidebar. Right-click deletes a
// thread, source or note to the Trash, or for good after saying what goes
// (ADR 0034).

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

test('right-click deletes for good, after saying what goes: a thread with its side question, a source, a note, and from the Trash', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'A thread about okapis to delete for good');
  const main = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'An okapi side question');
  const side = currentThreadId(page);
  await showList(page, 'threads');
  const link = page.locator(`[data-testid=thread-link][data-thread-id="${main}"]`);

  // The menu asks first, in words; Cancel leaves it.
  await link.click({ button: 'right' });
  await page.getByTestId('menu-forever').click();
  await expect(page.getByTestId('context-ask')).toContainText('and its side question will be gone for good');
  await expect(page.getByTestId('context-ask')).toContainText('This cannot be undone.');
  await page.getByTestId('context-ask').getByRole('menuitem', { name: 'Cancel' }).click();
  await expect(link).toBeVisible();

  // Deleted for good: gone from the list, not in the Trash, and its page is gone too.
  await link.click({ button: 'right' });
  await page.getByTestId('menu-forever').click();
  await page.getByTestId('menu-forever-yes').click();
  await expect(page.getByTestId('app-toast')).toContainText('and its side question deleted for good.');
  await expect(page.getByTestId('toast-undo')).toHaveCount(0);
  await expect(link).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(side));
  expect((await request.get(`/api/threads/${main}`)).status()).toBe(404);
  expect((await request.get(`/api/threads/${side}`)).status()).toBe(404);

  // A source: Move to the Trash from right-click, then for good from the Trash.
  const nb = await (await request.get('/api/notebooks')).json();
  const sourceId = ulidish();
  await request.post(`/api/notebooks/${nb.notebooks[0].id}/sources`, { data: { id: sourceId, text: '# Okapi field notes\n\nStriped legs.' }, headers: H });
  await page.reload();
  await showList(page, 'sources');
  const source = page.locator(`[data-testid=source-link][data-source-id="${sourceId}"]`);
  await source.click({ button: 'right' });
  await page.getByTestId('menu-trash').click();
  await expect(page.getByTestId('app-toast')).toContainText('“Okapi field notes” moved to the Trash.');
  await showList(page, 'trash');
  const trashed = page.locator(`[data-testid=trash-item][data-id="${sourceId}"]`);
  await trashed.click({ button: 'right' });
  await expect(page.getByTestId('menu-trash')).toHaveCount(0);
  await page.getByTestId('menu-forever').click();
  await expect(page.getByTestId('context-ask')).toContainText('“Okapi field notes” will be gone for good');
  await page.getByTestId('menu-forever-yes').click();
  await expect(trashed).toHaveCount(0);
  expect((await request.get(`/api/sources/${sourceId}`)).status()).toBe(404);

  // A note, open: deleted for good, and the page leaves it.
  const noteId = ulidish();
  await request.post(`/api/notebooks/${nb.notebooks[0].id}/notes`, { data: { id: noteId, title: 'Okapi note' }, headers: H });
  await page.goto(`/#/note/${noteId}`);
  await page.reload();
  // The note open, the sidebar shows its list on its own: then ask for it.
  await expect(page.getByTestId('note-rename')).toContainText('Okapi note');
  await showList(page, 'notes');
  await page.locator('[data-testid=note-link]').filter({ hasText: 'Okapi note' }).click({ button: 'right' });
  await page.getByTestId('menu-forever').click();
  await expect(page.getByTestId('context-ask')).toContainText('“Okapi note” will be gone for good, with its blocks and its history.');
  await page.getByTestId('menu-forever-yes').click();
  await expect(page.locator('[data-testid=note-link]').filter({ hasText: 'Okapi note' })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(noteId));
});
