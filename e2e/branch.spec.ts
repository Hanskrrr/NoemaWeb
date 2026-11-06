import { expect, type Page, test } from '@playwright/test';
import {
  ask,
  currentThreadId,
  doubleClickWord,
  freshThread,
  highlighted,
  lastAnswer,
  threadDetail,
} from './helpers.ts';

// The detour (prototype brief §10, test 2): a branch from a selection keeps
// its exact origin, and Back returns to that passage, highlighted.

test.beforeEach(async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Tell me about optimisation');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
});

async function askInBranch(page: Page, question: string) {
  await page.getByTestId('branch-button').click();
  await expect(page.getByTestId('origin')).toBeVisible();
  await ask(page, question);
  await expect(page.locator('[data-testid=message][data-role=user]')).toHaveText(question);
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
}

test('a double-clicked word opens a branch pinned to the exact raw characters', async ({ page, request }) => {
  const parentId = currentThreadId(page);
  await doubleClickWord(page, 'offline');
  await askInBranch(page, 'Why is it offline?');

  const branchId = currentThreadId(page);
  expect(branchId).not.toBe(parentId);
  const branch = (await (await request.get(`/api/threads/${branchId}`)).json()) as {
    origin: { parentThreadId: string; anchor: { messageId: string; start: number; end: number; exact: string } };
  };
  expect(branch.origin.parentThreadId).toBe(parentId);
  expect(branch.origin.anchor.exact.trim()).toBe('offline');
  const parent = await threadDetail(request, parentId);
  const content = parent.messages.find((m) => m.id === branch.origin.anchor.messageId)?.content ?? '';
  // "offline" sits inside **bold** in the raw Markdown; the anchor skips the asterisks.
  expect(content.slice(branch.origin.anchor.start, branch.origin.anchor.end)).toBe(branch.origin.anchor.exact);
  expect(content.slice(branch.origin.anchor.start - 2, branch.origin.anchor.start)).toBe('**');
});

test('a selection inside rendered math snaps to the whole formula', async ({ page }) => {
  await lastAnswer(page)
    .locator('.math-inline .katex-html')
    .first()
    .evaluate((el) => {
      const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) throw new Error('no math text');
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 1);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
  await page.getByTestId('branch-button').click();
  await expect(page.getByTestId('origin')).toHaveAttribute('data-exact', '$e^{i\\pi} + 1 = 0$');
});

test('a selection across a list, inline code and Chinese keeps the raw Markdown between', async ({ page }) => {
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
  await page.getByTestId('branch-button').click();
  await expect(page.getByTestId('origin')).toHaveAttribute(
    'data-exact',
    'list item with `inline code`\n- 中文也可以：机器学习',
  );
});

test('Back returns to the exact passage, highlighted, with the branch marked where it left', async ({ page }) => {
  const parentId = currentThreadId(page);
  await doubleClickWord(page, 'tests');
  await askInBranch(page, 'Why tests?');
  const branchId = currentThreadId(page);

  // The sidebar shows the branch under its thread.
  await expect(page.locator(`[data-testid=thread-link][data-thread-id="${branchId}"]`)).toContainText('Why tests?');

  await page.getByTestId('back').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${parentId}/from/${branchId}$`));
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('tests');
  expect(await highlighted(page, 'noema-branches')).toBe('tests');
  const inView = await page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('noema-return');
    const range = h ? [...h][0] : undefined;
    const box = range?.getBoundingClientRect();
    return box ? box.top >= 0 && box.bottom <= window.innerHeight : false;
  });
  expect(inView).toBe(true);
  await expect(page.getByTestId('branch-link')).toHaveText(/Why tests\?/);

  // The browser's own Back goes to the branch again.
  await page.goBack();
  await expect(page.getByTestId('origin')).toBeVisible();
  await expect(page.locator('[data-testid=message][data-role=user]')).toHaveText('Why tests?');
});

test('a branch of a branch shows the whole path', async ({ page }) => {
  await doubleClickWord(page, 'answers');
  await askInBranch(page, 'First detour');
  await doubleClickWord(page, 'question');
  await askInBranch(page, 'Second detour');
  await expect(page.getByTestId('origin').locator('.crumbs')).toContainText('Tell me about optimisation');
  await expect(page.getByTestId('origin').locator('.crumbs')).toContainText('First detour');
  const nested = page.locator('.sidebar ul ul ul [data-testid=thread-link]');
  await expect(nested).toContainText('Second detour');
});

test('cancelling a branch before asking returns to the passage', async ({ page }) => {
  await doubleClickWord(page, 'exact');
  await page.getByTestId('branch-button').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('origin')).toHaveCount(0);
  await expect.poll(() => highlighted(page, 'noema-return')).toBe('exact');
});

test('branch marks survive a reload', async ({ page }) => {
  await doubleClickWord(page, 'same');
  await askInBranch(page, 'Same how?');
  await page.getByTestId('back').click();
  await page.reload();
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await expect.poll(() => highlighted(page, 'noema-branches')).toBe('same');
});
