import { expect, type Page, test } from '@playwright/test';
import { freshThread, ulidish } from './helpers.ts';

// The Assistant (ADRs 0023, 0024): beside whatever is open (⌘J, the header
// or the rail), or on its own page. It knows what is open and what is
// selected, looks things up as it answers (the fake model does what the
// question's markers say), cites with cards that preview the very words,
// proposes changes that wait for Do it, and the frame shows it working.

const H = { 'x-noema-client': 'web' };

async function addPasted(page: Page, text: string): Promise<string> {
  const nb = await (await page.request.get('/api/notebooks')).json();
  const res = await page.request.post(`/api/notebooks/${nb.notebooks[0].id}/sources`, { data: { id: ulidish(), text }, headers: H });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

const dock = (page: Page) => page.getByTestId('assistant-dock');
const frame = (page: Page) => page.getByTestId('living-frame');
const answers = (page: Page) => dock(page).locator('[data-testid=message][data-role=assistant]');

async function openDock(page: Page): Promise<void> {
  if (!(await dock(page).isVisible())) await page.getByTestId('assistant-open').click();
  await expect(dock(page)).toBeVisible();
}

/** Ask in the dock and wait for this question's answer to finish. */
async function askDock(page: Page, question: string): Promise<void> {
  const n = await answers(page).count();
  await dock(page).getByTestId('composer').fill(question);
  await dock(page).getByTestId('composer').press('Enter');
  await expect(answers(page)).toHaveCount(n + 1);
  await expect(answers(page).last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
}

test('beside a source: it knows what is selected, looks things up, and its cards preview the very words', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const id = await addPasted(page, '# Week 9: Kernels\n\n## Tiling\n\nA tile of the matrix is kept in shared memory while threads reuse it.');
  await page.goto(`/#/s/${id}`);
  await page.getByTestId('source-text').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf('kept in shared memory') ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 21);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
        return;
      }
    }
  });
  await page.keyboard.press('ControlOrMeta+j');
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByTestId('assistant-where')).toContainText('“Week 9: Kernels”');
  await expect(dock(page).getByTestId('assistant-selection')).toHaveText('“kept in shared memory”');

  // [1] is the newest source in the overview it is given.
  await askDock(page, 'What does this say? [[search:tile]] [[open:1]] [[quote:kept in shared memory|1]]');
  const answer = answers(page).last();
  await expect(answer.getByTestId('lookup-step')).toHaveText(['⌕Searched “tile”· 1', '❐Opened “Week 9: Kernels”']);
  await expect(answer).toContainText('[99]');
  await expect(dock(page).getByTestId('assistant-selection')).toHaveCount(0);

  // What was sent: where the learner was and what they selected, then each lookup.
  await answer.getByTestId('show-context').click();
  const question = page.getByTestId('context-part').filter({ hasText: 'Your question, with an overview of your notebook' });
  await expect(question).toContainText('They are reading the source “Week 9: Kernels”.');
  await expect(question).toContainText('> kept in shared memory');
  await expect(page.getByTestId('context-part').filter({ hasText: 'It searched “tile”: what came back' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The card: its quote, checked; the preview marks it in the text around it; Open there goes to it.
  const card = dock(page).getByTestId('mention').first();
  await expect(card).toHaveAttribute('data-kind', 'source');
  await expect(card).toContainText('“kept in shared memory”');
  await card.locator('.mention-main').click();
  await expect(dock(page).getByTestId('preview-quote')).toHaveText('kept in shared memory');
  await expect(dock(page).getByTestId('quote-preview')).toContainText('A tile of the matrix is');
  await dock(page).getByTestId('preview-open').click();
  await expect(page).toHaveURL(/#\/s\/[0-9A-Z]{26}\/at\/\d+$/);
  await expect(dock(page)).toBeVisible();
});

test('a change waits for Do it; then Open goes there and Undo takes it back', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await openDock(page);
  await askDock(page, 'Start one about warps [[call:start_thread:{"question":"What is a warp?"}]]');
  const card = dock(page).getByTestId('action-card').last();
  await expect(card).toHaveAttribute('data-status', 'proposed');
  await expect(card).toContainText('Start a thread: “What is a warp?”');
  await card.getByTestId('action-run').click();
  await expect(card).toHaveAttribute('data-status', 'done');
  await card.getByTestId('action-open').click();
  await expect(page).toHaveURL(/#\/t\/[0-9A-Z]{26}$/);
  await expect(page.locator('.main [data-testid=message][data-role=user]').first()).toHaveText('What is a warp?');
  // The place changed: the Assistant sees the new thread.
  await expect(dock(page).getByTestId('assistant-where')).toContainText('What is a warp');
  await card.getByTestId('action-undo').click();
  await expect(card).toHaveAttribute('data-status', 'undone');
  await expect(page.getByTestId('in-trash')).toBeVisible();

  // Show takes the learner there at once.
  await askDock(page, 'Take me to it [[list:threads]] [[call:show:{"ref":1}]]');
  await expect(dock(page).getByTestId('action-card').last()).toHaveAttribute('data-kind', 'show');
});

test('the frame shows what the Assistant is doing: listening, thinking, looking, writing, a bloom, then waiting', async ({
  page,
}) => {
  await page.goto('/');
  await openDock(page);
  const seen: string[] = [];
  await page.exposeFunction('noteFrame', (state: string) => seen.push(state));
  await frame(page).evaluate((el) => {
    new MutationObserver(() => {
      (window as unknown as { noteFrame: (s: string) => void }).noteFrame((el as HTMLElement).dataset.presence ?? '');
    }).observe(el, { attributeFilter: ['data-presence'] });
  });
  const n = await answers(page).count();
  await dock(page).getByTestId('composer').fill('Where did I leave off? [[search:kernels]] [[slow]]');
  await expect(frame(page)).toHaveAttribute('data-presence', 'listening');
  await dock(page).getByTestId('composer').press('Enter');
  await expect(answers(page)).toHaveCount(n + 1);
  await expect(answers(page).last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(frame(page)).toHaveAttribute('data-presence', 'idle', { timeout: 5000 });
  const order = seen.filter((s, i) => s !== seen[i - 1]);
  for (const state of ['thinking', 'looking', 'writing', 'done', 'idle']) expect(order).toContain(state);
  expect(order.indexOf('thinking')).toBeLessThan(order.indexOf('writing'));
  expect(order.indexOf('writing')).toBeLessThan(order.indexOf('done'));
  // Closed, the frame goes out.
  await dock(page).getByTestId('assistant-close').click();
  await expect(frame(page)).toHaveAttribute('data-presence', 'off');
});

test('with reduced motion asked for, the frame does not turn', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await openDock(page);
  const spinning = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.classList.contains('lf-spin')).length,
  );
  expect(spinning).toBe(0);
});

test('its own page, and back beside what it opens; never a thread in the list, never "asked before"', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await openDock(page);
  await dock(page).getByTestId('assistant-expand').click();
  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId('assistant-page')).toBeVisible();
  const nb = await (await request.get('/api/notebooks')).json();
  const threads = await (await request.get(`/api/notebooks/${nb.notebooks[0].id}/threads`)).json();
  expect(threads.threads.some((t: { kind: string }) => t.kind === 'assistant')).toBe(false);
  await page.getByTestId('rail-threads').click();
  await expect(page.getByTestId('thread-link').filter({ hasText: 'Assistant' })).toHaveCount(0);
});
