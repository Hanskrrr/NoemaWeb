import { expect, type Page, test } from '@playwright/test';
import { ask, currentThreadId, doubleClickWord, freshThread, lastAnswer } from './helpers.ts';

// Merging, like a merge commit: what a side question (or another thread)
// found is drafted, checked by the learner, and carried into the target from
// the next question on. Nothing already said is rewritten.

async function answered(page: Page, question: string) {
  await ask(page, question);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
}

test('a side question merged back: checked, merged, shown under its passage, carried, undone', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Tell me about optimisation');
  const parent = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await answered(page, 'Why is it offline?');
  const side = currentThreadId(page);

  // The AI drafts a summary; the learner edits it before anything is merged.
  await page.getByTestId('merge-back').click();
  const draft = page.getByTestId('merge-draft');
  await expect(draft).toHaveAttribute('data-status', 'draft');
  await expect(draft).toContainText('What the side question found');
  await draft.getByTestId('merge-edit').click();
  await page.getByTestId('merge-textarea').fill('Offline: the fake model answers the same way every time [E1].');
  await page.getByTestId('merge-save').click();
  await expect(draft).toContainText('the same way every time');
  await draft.getByTestId('merge-accept').click();
  await expect(page.getByTestId('merge-done')).toContainText('Merged into');
  await expect(page.getByTestId('merge-draft')).toHaveCount(0);
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).toContainText('merged');

  // In the parent, the card sits under the answer the side question left from.
  await page.getByTestId('merge-done').getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parent}$`));
  const card = page.getByTestId('merge-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('the same way every time');
  await expect(card).toContainText('offline');
  // Inside the answer, right after the paragraph that holds the passage.
  const inAnswer = page.locator('[data-testid=message][data-role=assistant] .md-slot [data-testid=merge-card]');
  await expect(inAnswer).toHaveCount(1);
  const before = page.locator('.md-slot').locator('xpath=preceding-sibling::*[1]');
  await expect(before).toContainText('offline fake model');
  await expect(page.locator('.md-slot').locator('xpath=following-sibling::*[1]')).toContainText('Inline math');
  // Selecting inside the card is not a passage of the answer.
  const word = card.getByText('every time', { exact: false });
  await word.dblclick();
  await expect(page.getByTestId('branch-button')).toHaveCount(0);
  // Its citation opens the side question's exchange.
  await card.getByTestId('cite').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${side}/m/[0-9A-Z]{26}$`));
  await page.goBack();

  // The next question carries it (the fake model echoes what it was sent).
  await answered(page, 'So what follows?');
  await expect(lastAnswer(page)).toContainText('Merged into this conversation from');
  await expect(lastAnswer(page)).toContainText('the same way every time');

  await page.getByTestId('merge-undo').click();
  await expect(page.getByTestId('merge-card')).toHaveCount(0);
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).not.toContainText('merged');
});

test('merge one thread into another, as the whole exchange', async ({ page, request }) => {
  const a = await freshThread(request);
  await page.goto('/');
  await answered(page, 'First topic, thread A');
  const b = await freshThread(request);
  await page.goto(`/#/t/${b}`);
  await answered(page, 'Second topic, thread B');

  await page.getByTestId('merge-into').click();
  await page.getByTestId('merge-picker').locator(`[data-thread-id="${a}"]`).click();
  const draft = page.getByTestId('merge-draft');
  await expect(draft).toHaveAttribute('data-status', 'draft');
  await draft.getByTestId('merge-switch').click();
  await expect(draft).toContainText('the whole exchange');
  await expect(draft).toContainText('Q:');
  await expect(draft).toContainText('Second topic, thread B');
  await draft.getByTestId('merge-accept').click();

  await page.goto(`/#/t/${a}`);
  const card = page.getByTestId('merge-card');
  await expect(card).toContainText('Second topic, thread B');
  // After the last message of A.
  const slot = page.locator('.message-slot').filter({ has: card });
  await expect(slot).toBeVisible();
  await expect(page.locator('.message-slot').last()).toContainText('Second topic, thread B');
});

test('merge one note into another: its blocks move over and the other note goes', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Topic for the first note');
  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  const first = page.url();

  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Topic for the second note');
  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  const secondId = page.url().split('/').at(-1);
  await page.getByTestId('note-rename').click();
  await page.getByTestId('note-title-input').fill('Second note');
  await page.getByTestId('note-title-input').press('Enter');
  await expect(page.locator(`[data-testid=note-link][data-note-id="${secondId}"]`)).toContainText('Second note');

  await page.goto(first);
  const blocks = page.getByTestId('note').getByTestId('block');
  await expect(blocks).toHaveCount(4);
  await page.getByTestId('note-merge').click();
  await page.getByTestId('note-merge-option').filter({ hasText: 'Second note' }).click();
  await page.getByTestId('note-merge-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('Merged “Second note” into this note');
  await expect(blocks).toHaveCount(8);
  await expect(page.locator(`[data-testid=note-link][data-note-id="${secondId}"]`)).toHaveCount(0);
  // The second note's citation was renumbered and still opens its own exchange.
  await blocks.nth(4).getByTestId('cite').click();
  await expect(page.locator('[data-testid=message].flash')).toContainText('Topic for the second note');
});
