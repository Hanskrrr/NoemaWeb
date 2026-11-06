import { expect, type Page, test } from '@playwright/test';
import { ask, currentThreadId, doubleClickWord, freshThread, highlighted, lastAnswer } from './helpers.ts';

// The notebook around a conversation: your own titles, the sidebar and map as
// ways back to the exact place, and a thread rewritten as an editable note
// whose citations lead to the exchanges they came from.

test.beforeEach(async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Tell me about optimisation');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
});

/** From the open thread, ask about "offline" in a branch. Returns [parent, branch]. */
async function branchOnOffline(page: Page): Promise<[string, string]> {
  const parent = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await ask(page, 'Why is it offline?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  const branch = currentThreadId(page);
  expect(branch).not.toBe(parent);
  return [parent, branch];
}

test('the learner renames a thread, and the AI never overwrites that title', async ({ page }) => {
  const id = currentThreadId(page);
  await expect(page.getByTestId('rename')).toContainText('About Tell me about optimisation');

  await page.getByTestId('rename').click();
  await page.getByTestId('title-input').fill('Gradient descent, my notes');
  await page.getByTestId('title-input').press('Enter');
  await expect(page.getByTestId('rename')).toContainText('Gradient descent, my notes');
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${id}"]`)).toHaveText(
    'Gradient descent, my notes',
  );

  // Escape leaves the title as it was.
  await page.getByTestId('rename').click();
  await page.getByTestId('title-input').fill('Something else');
  await page.getByTestId('title-input').press('Escape');
  await expect(page.getByTestId('rename')).toContainText('Gradient descent, my notes');

  await ask(page, 'And a second question');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await page.reload();
  await expect(page.getByTestId('rename')).toContainText('Gradient descent, my notes');
});

test('the sidebar shows each branch with its passage; the passage jumps to the exact spot', async ({ page }) => {
  const [parent, branch] = await branchOnOffline(page);

  const passage = page.locator(`[data-testid=passage-link][data-thread-id="${branch}"]`);
  await expect(passage).toContainText('offline');
  await passage.click();

  await expect(page).toHaveURL(new RegExp(`#/t/${parent}/from/${branch}$`));
  await expect(page.getByTestId('origin')).toHaveCount(0);
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('offline');

  // The title still opens the branch itself.
  await page.locator(`[data-testid=thread-link][data-thread-id="${branch}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${branch}$`));
  await expect(page.getByTestId('origin')).toBeVisible();
});

test('the map shows the whole tree, and every node leads back to its exact message', async ({ page }) => {
  const [parent, branch] = await branchOnOffline(page);

  await page.getByTestId('open-map').click();
  await expect(page).toHaveURL(new RegExp(`#/map/${branch}$`));
  const map = page.getByTestId('map');
  await expect(map.getByRole('heading', { level: 1 })).toContainText('About Tell me about optimisation');
  await expect(map.getByTestId('map-exchange')).toHaveCount(2);
  await expect(map.getByTestId('map-branch')).toHaveCount(1);
  await expect(map.getByTestId('map-passage')).toContainText('offline');
  await expect(map.locator('.map-thread.is-focus [data-testid=map-question]')).toHaveText('Why is it offline?');

  // The passage: back to the spot in the parent, highlighted.
  await map.getByTestId('map-passage').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parent}/from/${branch}$`));
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('offline');

  // A question: that exact message, flashed.
  await page.goBack();
  await expect(page.getByTestId('map')).toBeVisible();
  await page.getByTestId('map-question').filter({ hasText: 'Why is it offline?' }).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${branch}/m/[0-9A-Z]{26}$`));
  const flashed = page.locator('[data-testid=message].flash');
  await expect(flashed).toHaveAttribute('data-role', 'user');
  await expect(flashed).toContainText('Why is it offline?');
});

test('rewrite as note: an AI-labelled note whose citations jump to the exchange, editable with history', async ({
  page,
  request,
}) => {
  const [parent] = await branchOnOffline(page);
  await page.locator(`[data-testid=thread-link][data-thread-id="${parent}"]`).click();
  await expect(page.getByTestId('rewrite')).toBeEnabled();
  await page.getByTestId('rewrite').click();

  const note = page.getByTestId('note');
  await expect(note).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('note-author')).toHaveText('Written by AI from the thread');
  await expect(note.getByRole('heading', { name: 'Study note' })).toBeVisible();
  await expect(note.getByTestId('cite')).toHaveCount(2);
  const noteUrl = page.url();
  const id = noteUrl.split('/').at(-1);
  const link = page.locator(`[data-testid=note-link][data-note-id="${id}"]`);
  await expect(link).toContainText('Study note');

  // [E1] is the first answer in the parent; [E2] the answer in the branch.
  await note.getByTestId('cite').first().click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parent}/m/[0-9A-Z]{26}$`));
  const flashed = page.locator('[data-testid=message].flash');
  await expect(flashed).toHaveAttribute('data-role', 'assistant');
  await expect(flashed).toContainText('You asked: "Tell me about optimisation"');

  await page.goto(noteUrl);
  await page.getByTestId('cite').nth(1).click();
  await expect(page.locator('[data-testid=message].flash')).toContainText('Why is it offline?');
  await expect(page.getByTestId('origin')).toBeVisible();

  // Edit: citations are plain [E1] labels in the text, so the editor stays
  // readable and a label the learner writes works too. A new version,
  // labelled as edited; the AI draft is kept in the history.
  await page.goto(noteUrl);
  await page.getByTestId('note-edit').click();
  await expect(page.getByTestId('note-textarea')).toHaveValue(/first question \[E1\]\./);
  await expect(page.getByTestId('note-textarea')).not.toHaveValue(/noema|01[0-9A-Z]{24}/);
  await page.getByTestId('note-title-input').fill('Optimisation, revised');
  await page.getByTestId('note-textarea').fill('## Mine\n\nI rewrote this in my own words, see the side question [E2].');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('note-author')).toHaveText('AI draft, edited by you');
  await expect(page.getByTestId('note')).toContainText('version 2');
  await expect(page.getByTestId('note')).toContainText('I rewrote this in my own words');
  await expect(link).toContainText('Optimisation, revised');
  await page.getByTestId('cite').click();
  await expect(page.locator('[data-testid=message].flash')).toContainText('Why is it offline?');
  await page.goBack();

  await page.reload();
  await expect(page.getByTestId('note')).toContainText('I rewrote this in my own words');
  const history = (await (await request.get(`/api/notes/${id}/history`)).json()) as {
    revisions: Array<{ n: number; author: string }>;
  };
  expect(history.revisions.map((r) => [r.n, r.author])).toEqual([
    [1, 'ai'],
    [2, 'user'],
  ]);
});
