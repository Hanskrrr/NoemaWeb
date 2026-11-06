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

test('every thread has its own map, and every node leads back to its exact message', async ({ page }) => {
  const [parent, branch] = await branchOnOffline(page);

  // From the side question: its own map, with the way up.
  await page.getByTestId('open-map').click();
  await expect(page).toHaveURL(new RegExp(`#/map/${branch}$`));
  let map = page.getByTestId('map');
  await expect(map.getByRole('heading', { level: 1 })).toContainText('About Why is it offline');
  await expect(map.getByTestId('map-exchange')).toHaveCount(1);
  await expect(map.getByTestId('map-from')).toContainText('offline');
  await map.getByTestId('map-up').click();

  // The parent's map: the whole tree.
  await expect(page).toHaveURL(new RegExp(`#/map/${parent}$`));
  map = page.getByTestId('map');
  await expect(map.getByRole('heading', { level: 1 })).toContainText('About Tell me about optimisation');
  await expect(map.getByTestId('map-exchange')).toHaveCount(2);
  await expect(map.getByTestId('map-branch')).toHaveCount(1);
  await expect(map.getByTestId('map-passage')).toContainText('offline');
  // Each exchange leads with what it established (the model's line), the question beneath.
  const first = map.getByTestId('map-exchange').first();
  await expect(first.getByTestId('map-headline').first()).toHaveText('In short: Tell me about optimisation');
  await expect(first.getByTestId('map-question').first()).toHaveText('You asked: Tell me about optimisation');
  await first.getByTestId('map-headline').first().click();
  await expect(page.locator('[data-testid=message].flash')).toHaveAttribute('data-role', 'assistant');
  await page.goBack();

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

test('a side question becomes its own thread, and can be put back', async ({ page }) => {
  const [parent, branch] = await branchOnOffline(page);
  const nested = page.locator(`li.branch-item [data-testid=thread-link][data-thread-id="${branch}"]`);
  await expect(nested).toHaveCount(1);

  await page.getByTestId('split').click();
  await expect(page.getByTestId('unsplit')).toBeVisible();
  // Its own thread now: listed at the top level, right after the thread it came from.
  await expect(nested).toHaveCount(0);
  const own = page.locator(`nav.sidebar > ul > li:has(> .thread-row [data-thread-id="${branch}"])`);
  await expect(own).toContainText('↗');
  await expect(own.locator('xpath=preceding-sibling::li[1]').locator(`[data-thread-id="${parent}"]`).first()).toBeVisible();
  // Back still goes to the passage.
  await expect(page.getByTestId('origin')).toContainText('offline');

  // The parent's map shows it as a link to its own map.
  await page.locator(`[data-testid=thread-link][data-thread-id="${parent}"]`).click();
  await page.getByTestId('open-map').click();
  await expect(page.getByTestId('map-exchange')).toHaveCount(1);
  await page.getByTestId('map-split').click();
  await expect(page).toHaveURL(new RegExp(`#/map/${branch}$`));
  await expect(page.getByTestId('map-up')).toHaveCount(0);
  await expect(page.getByTestId('map-from')).toContainText('Made its own thread from');

  await page.getByTestId('map-back').click();
  await page.getByTestId('unsplit').click();
  await expect(page.getByTestId('split')).toBeVisible();
  await expect(nested).toHaveCount(1);
  await expect(nested).toContainText('↳');
});

test('rewrite as note: blocks you edit in place, with citations that open the exchange', async ({ page, request }) => {
  const [parent] = await branchOnOffline(page);
  await page.locator(`[data-testid=thread-link][data-thread-id="${parent}"]`).click();
  await expect(page.getByTestId('rewrite')).toBeEnabled();
  await page.getByTestId('rewrite').click();

  const note = page.getByTestId('note');
  await expect(note).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('note-author')).toHaveText('Written by AI from the thread');
  await expect(page.getByTestId('note-rename')).toContainText('Study note');
  const blocks = note.getByTestId('block');
  await expect(blocks).toHaveCount(4);
  await expect(blocks.first()).toHaveAttribute('data-author', 'ai');
  await expect(note.getByTestId('cite')).toHaveCount(2);
  const noteUrl = page.url();
  const id = noteUrl.split('/').at(-1);
  const link = page.locator(`[data-testid=note-link][data-note-id="${id}"]`);
  await expect(link).toContainText('Study note');

  // [E1] is the first answer in the parent.
  await note.getByTestId('cite').first().click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parent}/m/[0-9A-Z]{26}$`));
  const flashed = page.locator('[data-testid=message].flash');
  await expect(flashed).toHaveAttribute('data-role', 'assistant');
  await expect(flashed).toContainText('You asked: "Tell me about optimisation"');
  await page.goto(noteUrl);

  // Click a block to edit it right there: plain Markdown with plain [E1] labels.
  await blocks.first().locator('.nblock-body').click({ position: { x: 30, y: 10 } });
  const area = page.getByTestId('block-textarea');
  await expect(area).toHaveValue('The main idea, from the first question [E1].');
  await area.fill('The main idea, in my words, from [E1] and the side question [E2].');
  await page.getByTestId('note-rename').click({ position: { x: 5, y: 5 } }); // clicking away saves
  await page.getByTestId('note-title-input').press('Escape');
  await expect(blocks.first()).toContainText('in my words');
  await expect(blocks.first()).toHaveAttribute('data-author', 'ai+user');
  await expect(page.getByTestId('note-author')).toHaveText('Written by AI and you');
  await blocks.first().getByTestId('cite').nth(1).click();
  await expect(page.locator('[data-testid=message].flash')).toContainText('Why is it offline?');
  await page.goto(noteUrl);

  // Escape leaves a block as it was.
  await blocks.nth(1).hover();
  await blocks.nth(1).getByTestId('block-edit').click();
  await page.getByTestId('block-textarea').fill('Not this.');
  await page.getByTestId('block-textarea').press('Escape');
  await expect(blocks.nth(1)).toContainText('A detail that came from a side question');

  const history = (await (await request.get(`/api/notes/${id}/history`)).json()) as {
    revisions: Array<{ n: number; author: string; change: string }>;
  };
  expect(history.revisions.map((r) => [r.n, r.author, r.change])).toEqual([
    [1, 'ai', 'AI wrote the note'],
    [2, 'user', 'edited a block'],
  ]);
});

test('write or ask the AI anywhere, accept its suggestions, move, delete, undo and split a note', async ({ page }) => {
  await page.getByTestId('rewrite').click();
  const note = page.getByTestId('note');
  await expect(note).toHaveAttribute('data-status', 'done');
  const blocks = note.getByTestId('block');
  await expect(blocks).toHaveCount(4);

  // Write a block of your own between the first two.
  await blocks.nth(1).hover();
  const gap = note.getByTestId('gap').nth(1);
  await gap.hover();
  await gap.getByTestId('gap-write').click();
  await page.getByTestId('block-textarea').fill('My **own** paragraph, $x^2$.');
  await page.getByTestId('block-textarea').press('Control+Enter');
  await expect(blocks).toHaveCount(5);
  await expect(blocks.nth(1)).toHaveAttribute('data-author', 'user');
  await expect(blocks.nth(1).locator('.katex')).toHaveCount(1);

  // Ask the AI for a block at the end: a suggestion first, part of the note only once added.
  await note.getByTestId('gap-end').getByTestId('gap-ask').click();
  await page.getByTestId('ask-input').fill('A worked example');
  await page.getByTestId('ask-send').click();
  const proposal = note.getByTestId('proposal');
  await expect(proposal).toHaveAttribute('data-status', 'ready');
  await expect(proposal).toContainText('New block (A worked example)');
  await proposal.getByTestId('proposal-accept').click();
  await expect(blocks).toHaveCount(6);
  await expect(blocks.last()).toContainText('New block (A worked example)');
  await expect(blocks.last()).toHaveAttribute('data-author', 'ai');

  // Ask the AI to rewrite a block: the original stays until you replace it.
  await blocks.first().hover();
  await blocks.first().getByTestId('block-ai').click();
  await blocks.first().getByTestId('ask-quick').filter({ hasText: 'Simpler' }).click();
  await expect(blocks.first().getByTestId('proposal')).toHaveAttribute('data-status', 'ready');
  await expect(blocks.first().locator('.nblock-body')).toContainText('The main idea, from the first question');
  await blocks.first().getByTestId('proposal-accept').click();
  await expect(blocks.first().locator('.nblock-body')).toContainText('Rewritten (Simpler)');
  await expect(note.getByTestId('proposal')).toHaveCount(0);

  // Move the learner's block up, delete it, and undo.
  await blocks.nth(1).hover();
  await blocks.nth(1).getByTestId('block-up').click();
  await expect(blocks.first()).toContainText('My own paragraph');
  await blocks.first().hover();
  await blocks.first().getByTestId('block-delete').click();
  await expect(blocks).toHaveCount(5);
  await page.getByTestId('undo').click();
  await expect(blocks).toHaveCount(6);
  await expect(blocks.first()).toContainText('My own paragraph');

  // Move the "Open questions" section into its own note.
  const heading = blocks.filter({ hasText: 'Open questions' });
  await heading.hover();
  await heading.getByTestId('block-move-out').click();
  await expect(page.getByTestId('toast')).toContainText('Moved 3 blocks to “Open questions”');
  await expect(blocks).toHaveCount(3);
  await page.getByTestId('open-moved').click();
  await expect(page.getByTestId('note-rename')).toContainText('Open questions');
  await expect(page.getByTestId('note').getByTestId('block')).toHaveCount(3);

  // Split here: this block and everything below it.
  const moved = page.getByTestId('note').getByTestId('block');
  await moved.nth(1).hover();
  await moved.nth(1).getByTestId('block-split').click();
  await expect(page.getByTestId('toast')).toContainText('Moved 2 blocks to “Open questions (part)”');
  await expect(moved).toHaveCount(1);
});

test('a blank note: write it yourself, with AI help on request', async ({ page }) => {
  await page.getByTestId('new-note').click();
  const note = page.getByTestId('note');
  await expect(page.getByTestId('note-rename')).toContainText('Untitled note');
  await expect(page.getByTestId('note-author')).toHaveText('Written by you');
  await page.getByTestId('note-rename').click();
  await page.getByTestId('note-title-input').fill('Exam checklist');
  await page.getByTestId('note-title-input').press('Enter');
  await expect(page.getByTestId('note-rename')).toContainText('Exam checklist');

  await note.getByTestId('gap-write').click();
  await page.getByTestId('block-textarea').fill('- [ ] Chain rule\n- [x] Backprop');
  await page.getByTestId('block-textarea').press('Control+Enter');
  await expect(note.getByTestId('block')).toHaveCount(1);
  await expect(note.locator('input[type=checkbox]')).toHaveCount(2);

  await note.getByTestId('gap-end').getByTestId('gap-ask').click();
  await page.getByTestId('ask-input').fill('One more item');
  await page.getByTestId('ask-input').press('Enter');
  await expect(note.getByTestId('proposal')).toContainText('New block (One more item).');
  await note.getByTestId('proposal-discard').click();
  await expect(note.getByTestId('block')).toHaveCount(1);
  await expect(note.getByTestId('proposal')).toHaveCount(0);

  await page.getByTestId('note-delete').click();
  await page.getByTestId('note-delete-confirm').click();
  await expect(page.getByTestId('note')).toHaveCount(0);
  await expect(page.locator('[data-testid=note-link]').filter({ hasText: 'Exam checklist' })).toHaveCount(0);
});
