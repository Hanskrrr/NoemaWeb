import { expect, type Page, test } from '@playwright/test';
import { answered, freshThread, lastAnswer, ulidish } from './helpers.ts';

// The Assistant (ADR 0023): one assistant for the whole notebook, reached
// from the top of the sidebar. It looks things up (the fake model looks up
// what the question's markers say), shows each lookup as it goes, cites what
// it found with labels that open the exact place, and the frame around the
// window shows what it is doing.

const H = { 'x-noema-client': 'web' };

async function addPasted(page: Page, text: string): Promise<void> {
  const nb = await (await page.request.get('/api/notebooks')).json();
  const res = await page.request.post(`/api/notebooks/${nb.notebooks[0].id}/sources`, {
    data: { id: ulidish(), text },
    headers: H,
  });
  expect(res.status()).toBe(201);
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('rail-assistant').click();
  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId('assistant-head')).toBeVisible();
}

const frame = (page: Page) => page.getByTestId('living-frame');

test('ask the Assistant: it looks things up, shows what it looked at, and its citations open the place', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await addPasted(page, '# Week 9: Kernels\n\n## Tiling\n\nA tile of the matrix is kept in shared memory while threads reuse it.');
  await openAssistant(page);
  await expect(frame(page)).toHaveAttribute('data-presence', /idle|done|listening/);

  // [1] is the newest source in the overview it is given.
  await answered(page, 'What does the kernels lecture say? [[search:tile]] [[open:1]]');
  const answer = lastAnswer(page);
  await expect(answer.getByTestId('lookup-step')).toHaveText(['⌕Searched “tile”· 1', '❐Opened “Week 9: Kernels”']);
  await expect(answer).toContainText('I looked 2 times.');
  // A label it was given is a button; one it was never given stays text.
  await expect(answer).toContainText('[99]');
  const cite = answer.getByTestId('cite').first();
  await expect(cite).toHaveAttribute('data-kind', 'source');
  await expect(cite).toHaveAttribute('title', 'Open the source “Week 9: Kernels”');

  // What was sent: the question with the overview, then each lookup and what came back.
  await answer.getByTestId('show-context').click();
  const parts = page.getByTestId('context-part');
  await expect(parts.filter({ hasText: 'Your question, with an overview of your notebook' })).toHaveCount(1);
  await expect(parts.filter({ hasText: 'It searched “tile”: what came back' })).toHaveCount(1);
  await expect(parts.filter({ hasText: 'It opened [1]: what came back' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  await cite.click();
  await expect(page).toHaveURL(/#\/s\/[0-9A-Z]{26}/);
  await expect(page.getByTestId('source-text')).toContainText('A tile of the matrix');
  // Away from the Assistant, the frame goes out.
  await expect(frame(page)).toHaveAttribute('data-presence', 'off');
});

test('the frame shows what the Assistant is doing: listening, thinking, writing, a bloom, then waiting', async ({
  page,
}) => {
  await openAssistant(page);
  const seen: string[] = [];
  await page.exposeFunction('noteFrame', (state: string) => seen.push(state));
  await frame(page).evaluate((el) => {
    new MutationObserver(() => {
      (window as unknown as { noteFrame: (s: string) => void }).noteFrame((el as HTMLElement).dataset.presence ?? '');
    }).observe(el, { attributeFilter: ['data-presence'] });
  });
  const answers = page.locator('[data-testid=message][data-role=assistant]');
  const before = await answers.count();
  await page.getByTestId('composer').fill('Where did I leave off? [[search:kernels]] [[slow]]');
  await expect(frame(page)).toHaveAttribute('data-presence', 'listening');
  await page.getByTestId('composer').press('Enter');
  await expect(answers).toHaveCount(before + 1);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done', { timeout: 15000 });
  await expect(frame(page)).toHaveAttribute('data-presence', 'idle', { timeout: 5000 });
  const order = seen.filter((s, i) => s !== seen[i - 1]);
  for (const state of ['thinking', 'looking', 'writing', 'done', 'idle']) expect(order).toContain(state);
  expect(order.indexOf('thinking')).toBeLessThan(order.indexOf('writing'));
  expect(order.indexOf('writing')).toBeLessThan(order.indexOf('done'));
});

test('with reduced motion asked for, the frame does not turn', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openAssistant(page);
  const spinning = await page.evaluate(
    () => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).classList.contains('lf-spin')).length,
  );
  expect(spinning).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('the Assistant is not a thread in the list, and asking it is never "asked before"', async ({ page, request }) => {
  await freshThread(request);
  await openAssistant(page);
  await answered(page, 'What is a warp, in my notes?');
  const nb = await (await request.get('/api/notebooks')).json();
  const threads = await (await request.get(`/api/notebooks/${nb.notebooks[0].id}/threads`)).json();
  expect(threads.threads.some((t: { kind: string }) => t.kind === 'assistant')).toBe(false);
  await page.getByTestId('rail-threads').click();
  await expect(page.getByTestId('thread-link').filter({ hasText: 'Assistant' })).toHaveCount(0);
});
