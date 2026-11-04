import { expect, test } from '@playwright/test';
import { ask, freshThread, lastAnswer, threadDetail } from './helpers.ts';

test('ask a question and watch the answer stream in, with math rendered', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'What is a derivative?');
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute('data-status', 'done');
  await expect(answer).toContainText('You asked: "What is a derivative?"');
  await expect(answer.locator('.katex').first()).toBeVisible();
  await expect(answer.locator('pre code')).toContainText('const answer = 42;');
  await expect(page.locator('[data-testid=message][data-role=user]')).toHaveAttribute('data-status', 'done');
});

test('reloading mid-answer picks up where it was, with no duplicated text', async ({ page, request }) => {
  const threadId = await freshThread(request);
  await page.goto('/');
  await ask(page, 'Take your time [[slow]]');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming');
  await expect.poll(async () => (await lastAnswer(page).innerText()).length).toBeGreaterThan(20);
  await page.reload();
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const text = await answer.innerText();
  expect(text.split('You asked:').length - 1).toBe(1);
  const stored = (await threadDetail(request, threadId)).messages.find((m) => m.role === 'assistant');
  expect(stored?.status).toBe('done');
  expect(stored?.content.startsWith('You asked: "Take your time"')).toBe(true);
});

test('stop keeps the partial answer', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'A long answer please [[slow]]');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming');
  await page.getByTestId('stop-composer').click();
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'stopped');
  await expect(lastAnswer(page)).toContainText('You asked');
  await expect(page.getByTestId('send')).toBeVisible();
});

test('a failed answer says why, in words', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Trigger [[fail:rate_limit]]');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'failed');
  await expect(lastAnswer(page)).toContainText('limiting requests');
});

test('a draft survives a reload', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await page.getByTestId('composer').fill('half-written question about 特征值');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByTestId('composer')).toHaveValue('half-written question about 特征值');
});
