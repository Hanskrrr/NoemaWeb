import { expect, test } from '@playwright/test';
import { answered, ask, doubleClickWord, freshThread, lastAnswer, showList } from './helpers.ts';

// Asked before: a question about to be asked again is pointed at the earlier
// exchange, so no new thread, side question or note is added without need.

test('a new thread: typing a question asked before offers to open it or to ask there, and never blocks', async ({
  page,
  request,
}) => {
  const first = await freshThread(request);
  await page.goto('/');
  await answered(page, 'What is a Lagrange multiplier?');

  await showList(page, 'threads');
  await page.getByTestId('new-thread').click();
  const box = page.getByTestId('composer');
  // A different question: nothing.
  await box.fill('How do I reverse a linked list?');
  await page.waitForTimeout(700);
  await expect(page.getByTestId('asked')).toHaveCount(0);

  // The same question in other words: a reminder, with where it was asked.
  await box.fill('Lagrange multiplier: what is it?');
  const hit = page.getByTestId('asked-hit').first();
  await expect(hit).toContainText('What is a Lagrange multiplier?');
  await expect(page.getByTestId('asked')).toContainText('You asked');

  // Open it: the earlier exchange, in its thread. The draft is kept.
  await hit.getByTestId('asked-open').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${first}/m/`));
  await expect(page.locator('[data-testid=message][data-role=user]').first()).toContainText('Lagrange multiplier');

  // Back in the new thread, ask there instead: the question goes into the earlier thread, and no thread is added.
  const threadsBefore = (await (await request.get('/api/notebooks')).json()).notebooks[0].id as string;
  const count = async () =>
    ((await (await request.get(`/api/notebooks/${threadsBefore}/threads`)).json()) as { threads: unknown[] }).threads.length;
  const before = await count();
  await page.getByTestId('new-thread').click();
  await expect(box).toHaveValue('Lagrange multiplier: what is it?');
  await page.getByTestId('asked-hit').first().getByTestId('asked-there').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${first}$`));
  await expect(page.locator('[data-testid=message][data-role=user]')).toHaveCount(2);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  expect(await count()).toBe(before);

  // Asking anyway is just asking: the reminder is dismissed or ignored, and a new thread is made.
  await page.getByTestId('new-thread').click();
  await expect(box).toHaveValue('');
  await box.fill('What is a Lagrange multiplier, again?');
  await expect(page.getByTestId('asked-hit').first()).toBeVisible();
  await page.getByTestId('asked-dismiss').first().click();
  await expect(page.getByTestId('asked')).toHaveCount(0);
  await box.press('Enter');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  expect(await count()).toBe(before + 1);
});

test('a side question on a passage already asked about says so before anything is typed', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await answered(page, 'Tell me about convex sets');
  await doubleClickWord(page, 'select');
  await expect(page.getByTestId('branch-button')).toBeVisible();
  await page.getByTestId('branch-button').click();
  await ask(page, 'What does this mean here?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await page.getByTestId('back').click();

  // The same passage again: the side question already asked is offered first.
  await doubleClickWord(page, 'select');
  await page.getByTestId('branch-button').click();
  const hit = page.getByTestId('asked-hit').first();
  await expect(hit).toBeVisible();
  await expect(hit).toHaveAttribute('data-strength', 'same');
  await expect(hit).toContainText('What does this mean here?');
  await hit.getByTestId('asked-open').click();
  await expect(page.getByTestId('origin')).toBeVisible();
  await expect(page.locator('[data-testid=message][data-role=user]').first()).toContainText('What does this mean here?');
});

test('a thread that already has a note says so before writing another', async ({ page, request }) => {
  const threadId = await freshThread(request);
  await page.goto('/');
  await answered(page, 'Something worth a note');
  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  await page.goto(`/#/t/${threadId}`);
  await expect(page.getByTestId('thread-note-open')).toHaveCount(1);

  await page.getByTestId('rewrite').click();
  await expect(page.getByTestId('note-already')).toBeVisible();
  // Still on the thread: nothing was written.
  await expect(page).toHaveURL(new RegExp(`#/t/${threadId}`));
  await page.getByTestId('rewrite-again').click();
  await expect(page.getByTestId('note')).toHaveAttribute('data-status', 'done');
  await page.goto(`/#/t/${threadId}`);
  await expect(page.getByTestId('thread-note-open')).toHaveCount(2);
});
