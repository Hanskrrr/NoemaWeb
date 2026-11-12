import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { answered, freshThread, highlighted, showList } from './helpers.ts';

// PDF sources (ADR 0021): a PDF from this computer is read page by page into
// the reading pane, asked about like any text, and opened at the page being
// read. The fixture is a made-up three-slide deck.

const SLIDES = new URL('../apps/server/test/fixtures/slides.pdf', import.meta.url);

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

test('a PDF from this computer: read page by page, asked about, and opened at the page being read', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await showList(page, 'sources');
  await page.getByTestId('add-source').click();
  await page.getByTestId('source-mode-pdf').click();

  // Not a PDF: said at once, nothing sent.
  await page.getByTestId('source-pdf-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByTestId('source-error')).toContainText('“notes.txt” is not a PDF');
  await expect(page.getByTestId('source-add')).toBeDisabled();

  await page
    .getByTestId('source-pdf-input')
    .setInputFiles({ name: 'week5-slides.pdf', mimeType: 'application/pdf', buffer: readFileSync(SLIDES) });
  await expect(page.getByTestId('source-pdf-pick')).toContainText('week5-slides.pdf');
  await page.getByTestId('source-add').click();

  const pane = page.getByTestId('source-pane');
  await expect(pane.locator('h1').first()).toContainText('Week 5: Optimisation');
  await expect(page.getByTestId('source-file-name')).toHaveText('week5-slides.pdf');
  await expect(page.getByTestId('source-pages')).toHaveText('PDF, 3 pages');
  const text = page.getByTestId('source-text');
  await expect(text.locator('.md > h3')).toHaveText(['Page 1', 'Page 2', 'Page 3']);
  await expect(text.locator('li')).toHaveCount(5);
  await expect(text).toContainText('The learning rate sets the step size');

  // Asked about like any text; Back returns to the passage.
  await selectInSource(page, 'running average of past gradients');
  await page.getByTestId('ask-source').click();
  await answered(page, 'Why average them?');
  await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('running average of past gradients');

  // Open the PDF at the page in view: the last page heading above the top of the pane.
  await text.locator('.md > h3', { hasText: 'Page 3' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
  const opened = page.waitForEvent('popup');
  await page.getByTestId('source-open-pdf').click();
  await (await opened).close();
  const link = page.getByTestId('source-open-pdf');
  await expect(link).toHaveAttribute('href', /^\/api\/sources\/[0-9A-Z]{26}\/versions\/[0-9A-Z]{26}\/file#page=3$/);

  // A click on a page heading opens that page (window.open, recorded here).
  await page.evaluate(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = (url?: string | URL) => {
      w.opened.push(String(url));
      return null;
    };
  });
  await text.locator('.md > h3', { hasText: 'Page 2' }).click();
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    expect.stringMatching(/\/file#page=2$/),
  ]);

  // The file itself is there to open.
  const fileUrl = ((await link.getAttribute('href')) as string).replace(/#.*$/, '');
  const res = await request.get(fileUrl);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await res.body()).equals(readFileSync(SLIDES))).toBe(true);
});
