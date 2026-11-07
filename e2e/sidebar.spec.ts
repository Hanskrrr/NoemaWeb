import { expect, test } from '@playwright/test';
import { answered, currentThreadId, freshThread, showList, ulidish } from './helpers.ts';

// The sidebar shows one list at a time, picked on the rail of icons, and
// follows what is open. The list already shown hides on a second click.

test('the rail picks one list at a time, follows what is open, and hides the panel for more room', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const notebookId = (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
  const source = await (
    await request.post(`/api/notebooks/${notebookId}/sources`, {
      data: { id: ulidish(), text: '# Wombat notes\n\nThe wombat digs long burrows.', title: 'Wombat notes' },
      headers: { 'x-noema-client': 'web' },
    })
  ).json();

  await page.goto('/#/new');
  await answered(page, 'A plain question about quokkarivers');
  const plain = currentThreadId(page);
  const panel = page.getByTestId('sidebar-panel');
  await expect(page.getByTestId('rail-threads')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Threads');
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${plain}"]`)).toBeVisible();
  // One list at a time: no sources or notes here.
  await expect(page.getByTestId('source-link')).toHaveCount(0);

  await showList(page, 'sources');
  await expect(page.locator(`[data-testid=source-link][data-source-id="${source.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${plain}"]`)).toHaveCount(0);

  // Opening a note, from wherever, shows the notes.
  await showList(page, 'notes');
  const notes = await page.getByTestId('note-link').count();
  await page.getByTestId('new-note').click();
  await expect(page.getByTestId('note-link')).toHaveCount(notes + 1);
  const note = page.url().split('/').at(-1);
  // Opening a thread from search shows the threads again.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').fill('quokkarivers');
  await page.locator('[data-testid=search-hit][data-kind=message]').first().click();
  await expect(page.getByTestId('rail-threads')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${plain}"]`)).toHaveClass(/active/);

  // The list already shown hides on a second click, for more room; it stays hidden after a reload.
  await page.getByTestId('rail-threads').click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('rail-threads')).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('rail-notes').click();
  await expect(panel).toContainText('Notes');

  // Something in the Trash shows a count on its icon.
  const count = page.getByTestId('trash-count');
  const inTrash = (await count.count()) ? Number(await count.textContent()) : 0;
  await page.locator(`[data-testid=note-link][data-note-id="${note}"]`).click();
  await page.getByTestId('note-delete').click();
  await page.getByTestId('note-delete-confirm').click();
  await expect(count).toHaveText(String(inTrash + 1));
  await showList(page, 'trash');
  await expect(page.locator(`[data-testid=trash-item][data-id="${note}"]`)).toBeVisible();
});
