import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { answered, freshThread, highlighted, lastAnswer, showList } from './helpers.ts';

// PDF sources (ADR 0021): a PDF from this computer is read page by page into
// the reading pane, asked about like any text, and opened at the page being
// read. The fixture is a made-up three-slide deck.

const SLIDES = new URL('../apps/server/test/fixtures/slides.pdf', import.meta.url);
const FIGURE = new URL('../apps/server/test/fixtures/figure-slides.pdf', import.meta.url);

async function addPdf(page: Page, url: URL, name: string): Promise<void> {
  await page.getByTestId('add-source').click();
  await page.getByTestId('source-mode-pdf').click();
  await page.getByTestId('source-pdf-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: readFileSync(url) });
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-file-name')).toHaveText(name);
}

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
  // Shown as its pages; here, as its text.
  await expect(page.getByTestId('pdf-pages').locator('.pdf-page')).toHaveCount(3);
  await page.getByTestId('view-text').click();
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

test('a PDF opens as its pages: drawn as printed, selected from, asked about with a picture of the page', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await showList(page, 'sources');
  await addPdf(page, FIGURE, 'figure-slides.pdf');

  // Its pages, drawn: the chart is on the first one.
  const pages = page.getByTestId('pdf-pages').locator('.pdf-page');
  await expect(pages).toHaveCount(2);
  await expect(page.getByTestId('view-pages')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pages.first().locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
  const inked = await pages.first().locator('canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data ?? new Uint8ClampedArray();
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i + 2] ?? 0) > 120 && (data[i] ?? 0) < 90) blue++;
    return blue;
  });
  expect(inked).toBeGreaterThan(100); // the blue curve of the chart

  // Selected on the page, asked about: the question goes with the picture of the page.
  await selectInSource(page, 'bounces because');
  await page.getByTestId('ask-source').click();
  await answered(page, 'Why does it bounce?');
  await expect(lastAnswer(page)).toContainText('I can see Page 1 of “Loss during training”.');
  await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('bounces because');
  await lastAnswer(page).getByTestId('show-context').click();
  const picture = page.getByTestId('context-image');
  await expect(picture).toContainText('Page 1 of “Loss during training”, sent as a picture');
  await expect.poll(() => picture.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1000);
  await page.keyboard.press('Escape');

  // The same passage in the text, marked there too.
  await page.getByTestId('view-text').click();
  await expect(page.getByTestId('source-text')).toContainText('The red curve bounces because the step is too large.');
  await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('bounces because');
  await page.getByTestId('view-pages').click();
  await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('bounces because');
  // Asked about: marked on the page.
  await expect.poll(() => highlighted(page, 'noema-source-asked')).toBe('bounces because');

  // Search finds a passage of the PDF and opens it at its page, the words marked there.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').fill('smooth the steps');
  await page.locator('[data-testid=search-hit][data-kind=passage]').first().click();
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('smooth');
  const found = await page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('noema-found');
    const range = h ? [...h][0] : undefined;
    return range?.startContainer.parentElement?.closest<HTMLElement>('.pdf-page')?.dataset.page ?? null;
  });
  expect(found).toBe('2');
});
