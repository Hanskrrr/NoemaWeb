import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { answered, currentThreadId, freshThread, showList, ulidish } from './helpers.ts';

// Notes stay with what they were made from: a note's citations open beside
// it, a note made from a thread is listed under that thread (and so under its
// source), and threads and sources name their notes.

/** A thread with two exchanges, rewritten as a note citing both. Returns the thread and the note. */
async function threadWithNote(page: Page, first: string, second: string): Promise<{ thread: string; note: string }> {
  await answered(page, first);
  await answered(page, second);
  const thread = currentThreadId(page);
  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  return { thread, note: page.url().split('/').at(-1) as string };
}

async function notebookId(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
}

test('a note’s citations open beside it: step through them, open the thread, come back', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/#/new');
  const { thread, note } = await threadWithNote(page, 'What is a numbat?', 'What does a numbat eat?');
  const before = await page.evaluate(() => history.length);

  await page.getByTestId('note').getByTestId('cite').first().click();
  const pane = page.getByTestId('ref-pane');
  await expect(pane).toHaveAttribute('data-label', 'E1');
  await expect(pane).toContainText('1 of 2');
  await expect(pane.getByTestId('ref-question')).toContainText('What is a numbat?');
  await expect(page.getByTestId('note').getByTestId('cite').first()).toHaveAttribute('aria-pressed', 'true');
  // The next citation, in the order the note cites them.
  await pane.getByTestId('ref-next').click();
  await expect(pane).toHaveAttribute('data-label', 'E2');
  await expect(pane.getByTestId('ref-question')).toContainText('What does a numbat eat?');
  await expect(pane.getByTestId('ref-next')).toBeDisabled();
  await pane.getByTestId('ref-prev').click();
  await expect(pane).toHaveAttribute('data-label', 'E1');
  // Which exchange is open is not a step in the browser's history.
  expect(await page.evaluate(() => history.length)).toBe(before);

  // Clicking the open citation again closes it.
  await page.getByTestId('note').getByTestId('cite').first().click();
  await expect(pane).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/note/${note}$`));

  // Open the thread from the pane; Back comes back to the note with the exchange beside it.
  await page.getByTestId('note').getByTestId('cite').nth(1).click();
  await pane.getByTestId('ref-open').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${thread}/m/[0-9A-Z]{26}$`));
  await expect(page.locator('[data-testid=message].flash')).toContainText('What does a numbat eat?');
  await page.goBack();
  await expect(page.getByTestId('ref-pane')).toHaveAttribute('data-label', 'E2');
  await expect(page.getByTestId('note')).toBeVisible();
});

test('a note made from a thread sits under it; the thread names it; the Notes list says where it came from', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/#/new');
  const { thread, note } = await threadWithNote(page, 'Why do bilbies dig?', 'How deep do they dig?');

  // Opened from the thread: the sidebar shows the thread, with the note under it, marked.
  await expect(page.getByTestId('rail-threads')).toHaveAttribute('aria-pressed', 'true');
  const home = page.locator(`li:has(> .thread-row [data-thread-id="${thread}"])`);
  await expect(home.locator(`[data-testid=thread-note][data-note-id="${note}"]`)).toHaveClass(/active/);

  // The thread names its note under its title.
  await home.locator(`[data-testid=thread-link][data-thread-id="${thread}"]`).click();
  await expect(page.getByTestId('thread-notes-line')).toContainText('Note from this thread:');
  await page.locator(`[data-testid=thread-note-open][data-note-id="${note}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/note/${note}$`));

  // Folding the thread hides its note too, and counts it.
  await home.locator(`[data-testid=fold][data-thread-id="${thread}"]`).click();
  await page.getByTestId('rail-notes').click();
  // In the Notes list: where it came from. Opening it from here keeps the Notes list.
  const item = page.locator(`[data-testid=note-link][data-note-id="${note}"]`).locator('xpath=..');
  await expect(item.getByTestId('note-from')).toContainText('from ');
  await page.locator(`[data-testid=note-link][data-note-id="${note}"]`).click();
  await expect(page.getByTestId('rail-notes')).toHaveAttribute('aria-pressed', 'true');
  // "from …" opens the thread, and the list follows it.
  await item.getByTestId('note-from').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${thread}$`));
  await expect(page.getByTestId('rail-threads')).toHaveAttribute('aria-pressed', 'true');
  // The fold the learner chose stays, with the note counted; the note is listed again when unfolded.
  await expect(home.locator(`[data-testid=thread-note][data-note-id="${note}"]`)).toHaveCount(0);
  await expect(home.getByTestId('fold-count')).toHaveText('1');
  await home.locator(`[data-testid=fold][data-thread-id="${thread}"]`).click();
  await expect(home.locator(`[data-testid=thread-note][data-note-id="${note}"]`)).toBeVisible();
});

test('a note made from a question about a source sits with the source, and its citation shows the passage', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const res = await request.post(`/api/notebooks/${await notebookId(request)}/sources`, {
    data: { id: ulidish(), text: '# Echidna notes\n\nThe echidna lays eggs and has spines.', title: 'Echidna notes' },
    headers: { 'x-noema-client': 'web' },
  });
  const source = (await res.json()) as { id: string };
  await page.goto(`/#/s/${source.id}`);
  await page.getByTestId('source-text').evaluate((root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.textContent?.indexOf('lays eggs') ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 'lays eggs'.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(r);
        return;
      }
    }
  });
  await page.getByTestId('ask-source').click();
  const { note } = await threadWithNote(page, 'Which mammals lay eggs?', 'How many kinds are there?');

  // Under the source, under the thread asked about it.
  await expect(page.getByTestId('rail-sources')).toHaveAttribute('aria-pressed', 'true');
  const under = page.locator(`[data-testid=source-link][data-source-id="${source.id}"]`).locator('xpath=ancestor::li[1]');
  await expect(under.locator(`[data-testid=thread-note][data-note-id="${note}"]`)).toBeVisible();
  // Its citation shows the passage of the source the question was about.
  await page.getByTestId('note').getByTestId('cite').first().click();
  await expect(page.getByTestId('ref-passage')).toContainText('lays eggs');
  await expect(page.getByTestId('ref-passage')).toContainText('Echidna notes');

  // The source lists the note with the passage.
  await page.locator(`[data-testid=source-link][data-source-id="${source.id}"]`).click();
  const passage = page.getByTestId('asked-passage').filter({ hasText: 'lays eggs' });
  await expect(passage.locator(`[data-testid=asked-thread]`)).toHaveCount(1);
  await passage.locator(`[data-testid=asked-note][data-note-id="${note}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/note/${note}$`));
  await showList(page, 'notes');
  await expect(page.locator(`[data-testid=note-link][data-note-id="${note}"]`)).toBeVisible();
});
