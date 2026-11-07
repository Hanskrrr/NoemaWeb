import { expect, type Page, test } from '@playwright/test';
import { ask, currentThreadId, doubleClickWord, freshThread, highlighted, lastAnswer, threadDetail } from './helpers.ts';

// Ask again: a new answer to the same question. Every answer is kept, the
// side questions asked from an old one still lead back to it, and the
// learner chooses which one is in use.

test.beforeEach(async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Tell me about optimisation');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
});

async function askAgain(page: Page) {
  await lastAnswer(page).getByTestId('ask-again').click();
  await expect(lastAnswer(page)).toContainText('Asked again: this is answer 2.');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
}

test('asking again keeps the first answer, its side question leads back to it, and either can be the one in use', async ({
  page,
  request,
}) => {
  const parentId = currentThreadId(page);
  // A side question from the first answer.
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await ask(page, 'Why offline?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  const branchId = currentThreadId(page);
  await page.getByTestId('back').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parentId}/from/${branchId}$`));

  // Ask again: a new answer, shown and in use.
  await askAgain(page);
  await expect(lastAnswer(page).getByTestId('versions')).toContainText('2 / 2');
  await expect(page.getByTestId('earlier-note')).toHaveCount(0);
  // The side question's passage is in the first answer, so it is not marked on the new one.
  await expect.poll(() => highlighted(page, 'noema-branches')).toBeNull();

  // The first answer is still there, word for word, with its mark.
  await lastAnswer(page).getByTestId('earlier-answer').click();
  await expect(page.getByTestId('earlier-note')).toContainText('1 of 2');
  await expect(lastAnswer(page)).not.toContainText('Asked again');
  await expect.poll(() => highlighted(page, 'noema-branches')).toBe('offline');
  await lastAnswer(page).getByTestId('later-answer').click();
  await expect(page.getByTestId('earlier-note')).toHaveCount(0);

  // Back from the side question shows the answer it was asked from, at the passage.
  await page.getByTestId('branch-link').click();
  await expect(page.getByTestId('origin')).toBeVisible();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('earlier-note')).toContainText('1 of 2');
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('offline');

  // Use the first one: it is in use again, after a reload too.
  await page.getByTestId('use-revision').click();
  await expect(page.getByTestId('earlier-note')).toHaveCount(0);
  await expect(lastAnswer(page).getByTestId('versions')).toContainText('1 / 2');
  const detail = await threadDetail(request, parentId);
  expect(detail.messages.at(-1)?.content).not.toContain('Asked again');
  await page.reload();
  await expect(lastAnswer(page).getByTestId('versions')).toContainText('1 / 2');
  await expect(lastAnswer(page)).not.toContainText('Asked again');
});

test('a side question can be asked from an earlier answer, and What was sent follows the answer shown', async ({
  page,
  request,
}) => {
  await askAgain(page);
  await lastAnswer(page).getByTestId('earlier-answer').click();
  await expect(page.getByTestId('earlier-note')).toBeVisible();

  // What was sent: for the answer on the screen.
  const asked = page.waitForRequest((r) => /\/api\/messages\/[0-9A-Z]+\/context\?revision=/.test(r.url()));
  await lastAnswer(page).getByTestId('show-context').click();
  await asked;
  await expect(page.getByTestId('context-dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // A side question from the first answer is anchored in it.
  const parentId = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await ask(page, 'Why offline, the first time?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  const branch = (await (await request.get(`/api/threads/${currentThreadId(page)}`)).json()) as {
    origin: { anchor: { messageId: string; revisionId: string; exact: string } };
  };
  const parent = (await (await request.get(`/api/threads/${parentId}`)).json()) as {
    messages: Array<{ id: string; revisionId: string }>;
  };
  const answer = parent.messages.find((m) => m.id === branch.origin.anchor.messageId);
  expect(branch.origin.anchor.exact).toBe('offline');
  expect(branch.origin.anchor.revisionId).not.toBe(answer?.revisionId);
});
