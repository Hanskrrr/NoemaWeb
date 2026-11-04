import { expect, test } from '@playwright/test';
import { ask, doubleClickWord, freshThread, lastAnswer, threadDetail } from './helpers.ts';

// The M0 anchor spike: a selection in rendered Markdown becomes exact offsets
// in the raw text of an immutable revision, and comes back as a highlight.

test.beforeEach(async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Tell me about optimisation');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
});

test('a double-clicked word becomes an anchor on the exact raw characters', async ({ page, request }) => {
  await doubleClickWord(page, 'offline');
  await page.getByTestId('pin').click();
  const pinned = page.getByTestId('pinned').last();
  const exact = await pinned.getAttribute('data-exact');
  const start = Number(await pinned.getAttribute('data-start'));
  const end = Number(await pinned.getAttribute('data-end'));
  expect(exact?.trim()).toBe('offline');

  const nb = await (await request.get('/api/notebooks')).json();
  const threads = await (await request.get(`/api/notebooks/${nb.notebooks[0].id}/threads`)).json();
  const content = (await threadDetail(request, threads.threads[0].id)).messages.find((m) => m.role === 'assistant')
    ?.content as string;
  // "offline" sits inside **bold** in the raw Markdown; the anchor skips the asterisks.
  expect(content.slice(start, end)).toBe(exact);
  expect(content.slice(start - 2, start)).toBe('**');
  await expect(pinned).toHaveAttribute('data-status', 'exact');
});

test('a selection inside rendered math snaps to the whole formula', async ({ page }) => {
  await lastAnswer(page).locator('.math-inline .katex-html').first().evaluate((el) => {
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) throw new Error('no math text');
    const r = document.createRange();
    r.setStart(text, 0);
    r.setEnd(text, 1);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  });
  await page.getByTestId('pin').click();
  await expect(page.getByTestId('pinned').last()).toHaveAttribute('data-exact', '$e^{i\\pi} + 1 = 0$');
});

test('a selection across Chinese text, inline code and a list keeps the raw Markdown between', async ({ page }) => {
  await lastAnswer(page).evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let startNode: Node | null = null;
    let endNode: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!startNode && n.textContent?.includes('A list item with')) startNode = n;
      if (n.textContent?.includes('机器学习')) endNode = n;
    }
    if (!startNode || !endNode) throw new Error('text not found');
    const r = document.createRange();
    r.setStart(startNode, (startNode.textContent ?? '').indexOf('list item'));
    r.setEnd(endNode, (endNode.textContent ?? '').indexOf('机器学习') + 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
  });
  await page.getByTestId('pin').click();
  await expect(page.getByTestId('pinned').last()).toHaveAttribute(
    'data-exact',
    'list item with `inline code`\n- 中文也可以：机器学习',
  );
});

test('show brings the passage back as a highlight', async ({ page }) => {
  await doubleClickWord(page, 'tests');
  await page.getByTestId('pin').click();
  await page.getByTestId('show-pin').last().click();
  const highlighted = await page.evaluate(() => {
    const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const h = reg.get('noema-pin');
    return h ? [...h].map((r) => r.toString()).join('') : null;
  });
  expect(highlighted?.trim()).toBe('tests');
});

test('pins survive a reload and still resolve exactly', async ({ page }) => {
  await doubleClickWord(page, 'answers');
  await page.getByTestId('pin').click();
  await page.reload();
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('pinned').last()).toHaveAttribute('data-status', 'exact');
});
