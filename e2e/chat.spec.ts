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
  await expect.poll(async () => (await lastAnswer(page).textContent())?.length ?? 0).toBeGreaterThan(20);
  await page.reload();
  const answer = lastAnswer(page);
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const text = (await answer.textContent()) ?? '';
  expect(text.split('You asked:').length - 1).toBe(1);
  const stored = (await threadDetail(request, threadId)).messages.find((m) => m.role === 'assistant');
  expect(stored?.status).toBe('done');
  expect(stored?.content.startsWith('You asked: "Take your time"')).toBe(true);
});

test('stop keeps the partial answer', async ({ page, request }) => {
  const threadId = await freshThread(request);
  await page.goto('/');
  await ask(page, 'A long answer please [[slow]]');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming');
  // Let some text arrive first: how much has streamed when Stop lands depends on the machine.
  await expect.poll(async () => (await lastAnswer(page).textContent())?.length ?? 0).toBeGreaterThan(30);
  await page.getByTestId('stop-composer').click();
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'stopped');
  await expect(lastAnswer(page)).toContainText('You asked');
  const stored = (await threadDetail(request, threadId)).messages.find((m) => m.role === 'assistant');
  expect(stored?.status).toBe('stopped');
  expect(stored?.content.startsWith('You asked')).toBe(true);
  expect(stored?.content).not.toContain('const answer = 42;'); // it really stopped early
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

test('New thread starts empty and appears in the sidebar after the first question', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await page.getByTestId('new-thread').click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByTestId('message')).toHaveCount(0);
  await ask(page, 'A brand new topic');
  await expect(page).toHaveURL(/#\/t\/[0-9A-Z]{26}$/);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await expect(page.locator('[data-testid=thread-link].active')).toHaveText('A brand new topic');
});
