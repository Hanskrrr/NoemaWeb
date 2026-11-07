import { expect, type Page, test } from '@playwright/test';
import { answered, ask, doubleClickWord, freshThread, highlighted, lastAnswer, ulidish } from './helpers.ts';

// Pins (M5): a passage kept in front of the AI. Pinned from a selection in a
// thread or in the source beside it; sent with every question there and in
// its side questions until unpinned; shown in What was sent.

const H = { 'x-noema-client': 'web' };

async function selectInSource(page: Page, phrase: string): Promise<void> {
  await page.getByTestId('source-text').evaluate((root, p) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf(p) ?? -1;
      if (i >= 0) {
        n.parentElement?.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + p.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
        return;
      }
    }
    throw new Error(`"${p}" is not in the source`);
  }, phrase);
  await expect(page.getByTestId('ask-source')).toBeVisible();
}

test('a pinned passage is sent with every question, inherited by side questions, and unpinned', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await ask(page, 'Tell me about optimisation');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');

  await doubleClickWord(page, 'offline');
  await page.getByTestId('pin-button').click();
  await expect(page.getByTestId('pin')).toHaveCount(1);
  await expect(page.getByTestId('pin')).toContainText('offline');
  await expect.poll(() => highlighted(page, 'noema-pins')).toBe('offline');

  // The next question carries it, and What was sent shows it.
  await answered(page, 'And with momentum?');
  await lastAnswer(page).getByTestId('show-context').click();
  const pinned = page.getByTestId('context-part').filter({ hasText: 'Passages you pinned' });
  await expect(pinned).toContainText('> offline');
  await page.keyboard.press('Escape');

  // It stays after a reload, and a side question has it too (unpinned where it was pinned).
  await page.reload();
  await expect(page.getByTestId('pin')).toHaveCount(1);
  await doubleClickWord(page, 'tests');
  await page.getByTestId('branch-button').click();
  await ask(page, 'Why tests?');
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('pin')).toContainText('pinned in');
  await expect(page.getByTestId('unpin')).toHaveCount(0);
  await page.getByTestId('back').click();

  await page.getByTestId('unpin').click();
  await expect(page.getByTestId('pinned')).toHaveCount(0);
  await answered(page, 'And without it?');
  await lastAnswer(page).getByTestId('show-context').click();
  await expect(page.getByTestId('context-part').filter({ hasText: 'Passages you pinned' })).toHaveCount(0);
});

test('a passage of the source is pinned to the thread beside it', async ({ page, request }) => {
  const nb = (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
  const text = '# Pinning notes\n\nThe softmax turns scores into weights.\n\nScaling keeps the gradients alive.';
  const res = await request.post(`/api/notebooks/${nb}/sources`, { data: { id: ulidish(), text }, headers: H });
  const src = (await res.json()) as { id: string };
  await page.goto(`/#/s/${src.id}`);
  await selectInSource(page, 'turns scores into weights');
  await expect(page.getByTestId('pin-source')).toHaveCount(0); // no thread beside yet
  await page.getByTestId('ask-source').click();
  await answered(page, 'What does the softmax do?');

  await selectInSource(page, 'Scaling keeps the gradients alive');
  await page.getByTestId('pin-source').click();
  await expect(page.getByTestId('pin')).toContainText('Scaling keeps the gradients alive');
  await expect(page.getByTestId('pin')).toContainText('in “Pinning notes”');
  await answered(page, 'Why scale?');
  await lastAnswer(page).getByTestId('show-context').click();
  await expect(page.getByTestId('context-part').filter({ hasText: 'Passages you pinned' })).toContainText(
    '> Scaling keeps the gradients alive',
  );
});
