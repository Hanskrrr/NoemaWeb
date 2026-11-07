import { expect, test } from '@playwright/test';
import { answered, freshThread, lastAnswer, ulidish } from './helpers.ts';

// Context you can see (M5): About you, written once and sent with every
// question; and under any answer, exactly what the AI was sent for it.

test('About you goes with every question, and What was sent shows it, word for word, part by part', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/#/new');
  await page.getByTestId('about-open').click();
  const about = page.getByTestId('about-input');
  await expect(about).toBeEnabled();
  await about.fill('I study machine learning and know C++.');
  await page.getByTestId('about-save').click();
  await expect(about).toHaveCount(0);

  await answered(page, 'What is a numbat?');
  await answered(page, 'And where does it live?');
  await lastAnswer(page).getByTestId('show-context').click();
  const dialog = page.getByTestId('context-dialog');
  await expect(dialog.getByTestId('context-meta')).toContainText('To fake-model');
  const parts = dialog.getByTestId('context-part');
  await expect(parts).toHaveCount(5);
  expect(await parts.evaluateAll((els) => els.map((el) => el.getAttribute('data-kind')))).toEqual([
    'instructions',
    'about_me',
    'history',
    'history',
    'question',
  ]);
  await expect(parts.nth(1)).toContainText('I study machine learning and know C++.');
  await expect(parts.nth(2)).toContainText('Earlier in this thread · your question');
  await expect(parts.nth(4).locator('pre')).toHaveText('And where does it live?');
  // The instructions are folded away; the question is open.
  await expect(parts.nth(0).locator('details')).not.toHaveAttribute('open', '');
  // From here, change what it says about you.
  await dialog.getByTestId('context-about-edit').click();
  await expect(page.getByTestId('context-dialog')).toHaveCount(0);
  await expect(page.getByTestId('about-input')).toHaveValue('I study machine learning and know C++.');
  await page.getByTestId('about-input').fill('');
  await page.getByTestId('about-save').click();
  await expect(page.getByTestId('about-input')).toHaveCount(0);
});

test('for a question about a source: the section of the text and the passage are in what was sent', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const notebookId = (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
  const source = await (
    await request.post(`/api/notebooks/${notebookId}/sources`, {
      data: { id: ulidish(), text: '# Quoll notes\n\n## Diet\n\nThe quoll hunts insects at night.', title: 'Quoll notes' },
      headers: { 'x-noema-client': 'web' },
    })
  ).json();
  await page.goto(`/#/s/${source.id}`);
  await page.getByTestId('source-text').evaluate((root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.textContent?.indexOf('hunts insects') ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 'hunts insects'.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(r);
        return;
      }
    }
  });
  await page.getByTestId('ask-source').click();
  await answered(page, 'What else does it eat?');
  await lastAnswer(page).getByTestId('show-context').click();
  const parts = page.getByTestId('context-dialog').getByTestId('context-part');
  const source_ = parts.and(page.locator('[data-kind=source]'));
  await expect(source_).toContainText('What you are reading');
  await expect(source_.locator('pre')).toContainText('"Quoll notes"');
  await expect(source_.locator('pre')).toContainText('The quoll hunts insects at night.');
  const question = parts.and(page.locator('[data-kind=question]'));
  await expect(question).toContainText('Your question, with the passage it is about');
  await expect(question.locator('pre')).toContainText('> hunts insects');
  await expect(question.locator('pre')).toContainText('What else does it eat?');
});
