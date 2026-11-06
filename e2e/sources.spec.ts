import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { answered, currentThreadId, doubleClickWord, freshThread, highlighted, lastAnswer, ulidish } from './helpers.ts';

// Sources (M3): paste text or read a page; a reading pane with the thread
// beside it; select in the text to ask; versioned anchors. The milestone's
// acceptance test is the first one: a branch from a source passage returns
// to that passage.

const H = { 'x-noema-client': 'web' };

// Long enough that the passage is far down the pane, so returning has to scroll to it.
const FILLER = Array.from(
  { length: 24 },
  (_, i) => `Paragraph ${i + 1} of the background: sequence models, recurrence and the cost of long paths.`,
).join('\n\n');
const PAPER = [
  '# Attention, briefly',
  '## 1 Background',
  FILLER,
  '## 3.2.1 Scaled Dot-Product Attention',
  'We suspect that for large values of $d_k$, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients.',
  'To counteract this effect, we scale the dot products by $\\frac{1}{\\sqrt{d_k}}$.',
  '## 3.2.2 Multi-Head Attention',
  'Instead of performing a single attention function, we project the queries, keys and values h times.',
].join('\n\n');

async function notebookId(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
}

async function addSource(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post(`/api/notebooks/${await notebookId(request)}/sources`, {
    data: { id: ulidish(), ...body },
    headers: H,
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; title: string; latestVersionId: string };
}

/** Select `phrase` in the source pane, as a reader would, and wait for "Ask about this". */
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

/** Whether the highlighted passage is inside the visible part of the pane. */
async function passageInView(page: Page, name: string): Promise<boolean> {
  return page.evaluate((n) => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(n);
    const range = h ? [...h][0] : undefined;
    const pane = document.querySelector('[data-testid=source-pane]');
    if (!range || !pane) return false;
    const r = range.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom;
  }, name);
}

test('acceptance (M3): a question about a source passage opens beside the text, and Back returns to that passage', async ({
  page,
  request,
}) => {
  const src = await addSource(request, { text: PAPER });
  await page.goto(`/#/s/${src.id}`);
  await expect(page.getByTestId('source-pane')).toContainText('Scaled Dot-Product Attention');
  await expect(page.getByTestId('source-overview')).toContainText('Select any passage to ask about it.');
  // Its own first heading is the title, shown once, in the header.
  await expect(page.getByTestId('source-text').locator('h2').first()).toBeHidden();
  // Contents jumps to a section in the pane (far below, after the background).
  await page.getByTestId('source-contents').click();
  await page.locator('.source-contents button', { hasText: '3.2.2 Multi-Head Attention' }).click();
  await expect
    .poll(() =>
      page.getByTestId('source-pane').evaluate((pane) => {
        const h = [...pane.querySelectorAll('h3')].find((x) => x.textContent?.includes('3.2.2'));
        const r = h?.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        return r ? pane.scrollTop > 0 && r.top >= p.top && r.bottom <= p.bottom : false;
      }),
    )
    .toBe(true);

  await selectInSource(page, 'the dot products grow large');
  await page.getByTestId('ask-source').click();
  await expect(page.getByTestId('origin')).toContainText('the dot products grow large');
  await expect(page.getByTestId('origin')).toContainText('from Attention, briefly');
  await answered(page, 'Why do they grow with d_k?');

  // The thread is beside the text, which still shows the passage, marked.
  const threadId = currentThreadId(page);
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect(page.getByTestId('source-origin')).toHaveAttribute('data-exact', 'the dot products grow large');
  expect(await highlighted(page, 'noema-source-here')).toBe('the dot products grow large');
  await expect(page.locator(`[data-testid=source-thread-link][data-thread-id="${threadId}"]`)).toBeVisible();
  const detail = await (await request.get(`/api/sources/${src.id}`)).json();
  expect(detail.threads.map((t: { threadId: string; passage: { exact: string } }) => [t.threadId, t.passage.exact])).toEqual([
    [threadId, 'the dot products grow large'],
  ]);

  // Read on, far away from it; then Back.
  await page.getByTestId('source-pane').evaluate((el) => el.scrollTo({ top: 0 }));
  expect(await passageInView(page, 'noema-source-here')).toBe(false);
  await page.getByTestId('back').click();
  await expect(page).toHaveURL(new RegExp(`#/s/${src.id}/from/${threadId}$`));
  await expect(page.getByTestId('source-overview')).toContainText('Where you asked');
  expect(await highlighted(page, 'noema-source-here')).toBe('the dot products grow large');
  await expect.poll(() => passageInView(page, 'noema-source-here')).toBe(true);
  await expect(page.getByTestId('asked-passage')).toHaveCount(1);
  await expect(page.getByTestId('asked-passage')).toContainText('1 question');

  // The browser's Back opens the thread again beside the text; so does a reload.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/t/${threadId}$`));
  await expect(page.getByTestId('source-origin')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done');
  await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('the dot products grow large');
});

test('a side question of a source thread stays beside the text; the sidebar keeps them under the source', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const src = await addSource(request, { text: PAPER, title: 'Okapi reading' });
  await page.goto(`/#/s/${src.id}`);
  await selectInSource(page, 'extremely small gradients');
  await page.getByTestId('ask-source').click();
  await answered(page, 'What is a small gradient?');
  const asked = currentThreadId(page);

  // A side question from the answer: still beside the source, which still shows where it all started.
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await answered(page, 'Why offline?');
  const side = currentThreadId(page);
  expect(side).not.toBe(asked);
  await expect(page.getByTestId('source-pane')).toBeVisible();
  expect(await highlighted(page, 'noema-source-here')).toBe('extremely small gradients');

  // In the sidebar: the source, the thread asked about it, and its side question under that.
  const source = page.locator(`[data-testid=source-link][data-source-id="${src.id}"]`);
  await expect(source).toContainText('Okapi reading');
  const item = source.locator('xpath=ancestor::li[1]');
  await expect(item.locator(`[data-testid=thread-link][data-thread-id="${asked}"]`)).toBeVisible();
  await expect(item.locator(`[data-testid=thread-link][data-thread-id="${side}"]`)).toBeVisible();
  await expect(page.locator('.sidebar > ul [data-testid=thread-link]').filter({ hasText: 'small gradient' })).toHaveCount(0);

  // The passage counts both questions; its margin mark is darker than for one.
  await source.click();
  await expect(page.getByTestId('asked-passage')).toContainText('2 questions');
  const strength = await page.locator('.source-mark').first().evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(strength).toBeGreaterThan(0.4);

  // The quote under the thread in the sidebar goes back to the passage in the text.
  await page.getByTestId('thread-link').and(page.locator(`[data-thread-id="${asked}"]`)).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${asked}$`));
  await item.locator('[data-testid=passage-link]').first().click();
  await expect(page).toHaveURL(new RegExp(`#/s/${src.id}/from/${asked}$`));
});

/** A small site on this machine for the server to read, whose page can change. */
function site(): Promise<{ server: Server; base: string; page: { body: string } }> {
  const page = {
    body: `<!doctype html><html><head><title>Okapi field notes — A Blog</title></head><body>
      <nav class="site-nav"><a href="/">Home</a></nav>
      <article><h1>Okapi field notes</h1>
      <p>The okapi is related to the giraffe, not the zebra.</p>
      <p>It lives in the Ituri rainforest.</p></article>
      <footer>© A Blog</footer></body></html>`,
  };
  const server = createServer((req, res) => {
    if (req.url === '/paper.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page.body);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, page });
    }),
  );
}

test('a web page read from its address, read again when it changes; what was asked stays with its version', async ({
  page,
  request,
}) => {
  const local = await site();
  try {
    await freshThread(request);
    await page.goto('/');
    await page.getByTestId('add-source').click();
    // A PDF is refused with a reason.
    await page.getByTestId('source-url-input').fill(`${local.base}/paper.pdf`);
    await page.getByTestId('source-add').click();
    await expect(page.getByTestId('source-error')).toContainText('it is a PDF');
    // A page is read: its article, without the site around it.
    await page.getByTestId('source-url-input').fill(`${local.base}/okapi`);
    await page.getByTestId('source-add').click();
    await expect(page.getByTestId('source-pane')).toContainText('related to the giraffe');
    await expect(page.getByTestId('source-pane').locator('h1').first()).toContainText('Okapi field notes');
    await expect(page.getByTestId('source-text')).not.toContainText('Home');
    await expect(page.getByTestId('source-url')).toContainText('127.0.0.1');
    const sourceId = /#\/s\/([0-9A-Z]{26})/.exec(page.url())?.[1] as string;

    await selectInSource(page, 'related to the giraffe');
    await page.getByTestId('ask-source').click();
    await answered(page, 'How are they related?');
    const asked = currentThreadId(page);

    // Unchanged: nothing new. Changed: a new version, shown; the question stays with the first.
    await page.locator(`[data-testid=source-link][data-source-id="${sourceId}"]`).click();
    await page.getByTestId('source-refetch').click();
    await expect(page.getByTestId('source-notice')).toContainText('Nothing has changed');
    local.page.body = local.page.body.replace('not the zebra', 'and only distantly to the zebra');
    await page.getByTestId('source-refetch').click();
    await expect(page.getByTestId('source-notice')).toContainText('version 2');
    await expect(page.getByTestId('source-text')).toContainText('only distantly');
    await expect(page.getByTestId('source-overview')).toContainText('1 more question was asked about other versions');
    await expect(page.getByTestId('source-version')).toBeVisible();

    // Opening the thread shows the text it was asked about: version 1, marked as older.
    await page.locator(`[data-testid=thread-link][data-thread-id="${asked}"]`).click();
    await expect(page.getByTestId('source-older')).toContainText('version 1 of 2');
    await expect(page.getByTestId('source-text')).toContainText('not the zebra');
    await expect(page.getByTestId('source-origin')).toContainText('Asked about an earlier version');
    await expect.poll(() => highlighted(page, 'noema-source-here')).toBe('related to the giraffe');
    await page.getByTestId('source-latest').click();
    await expect(page).toHaveURL(new RegExp(`#/s/${sourceId}$`));
    await expect(page.getByTestId('source-text')).toContainText('only distantly');
  } finally {
    local.server.close();
  }
});

test('pasting from a web page keeps its structure; search finds a passage and opens the text there', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.goto('/');
  await page.getByTestId('add-source').click();
  await page.getByTestId('source-mode-paste').click();
  await page.getByTestId('source-text-input').evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<h2>Capybara habits</h2><p>The <strong>capybara</strong> grazes at dusk.</p><ul><li>Semi-aquatic</li><li>Social</li></ul>',
    );
    data.setData('text/plain', 'Capybara habits The capybara grazes at dusk. Semi-aquatic Social');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('source-text-input')).toHaveValue(
    '## Capybara habits\n\nThe **capybara** grazes at dusk.\n\n- Semi-aquatic\n- Social',
  );
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-pane').locator('h1').first()).toContainText('Capybara habits');
  await expect(page.getByTestId('source-text').locator('li')).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').fill('grazes');
  const hit = page.locator('[data-testid=search-hit][data-kind=passage]').first();
  await expect(hit).toContainText('Source · Capybara habits');
  await expect(hit).toContainText('In a source');
  await hit.click();
  await expect(page).toHaveURL(/#\/s\/[0-9A-Z]{26}\/at\/\d+$/);
  await expect.poll(() => highlighted(page, 'noema-found')).toBe('grazes');
});

test('a source goes to the Trash with Undo; the threads asked about it stay', async ({ page, request }) => {
  await freshThread(request);
  const src = await addSource(request, { text: '# Tapir notes\n\nThe tapir has a short trunk.', title: 'Tapir notes' });
  await page.goto(`/#/s/${src.id}`);
  await selectInSource(page, 'short trunk');
  await page.getByTestId('ask-source').click();
  await answered(page, 'What is the trunk for?');
  const asked = currentThreadId(page);

  await page.getByTestId('back').click();
  await page.getByTestId('source-delete').click();
  await expect(page.getByTestId('source-delete-confirm')).toContainText('The thread asked about it stays.');
  await page.getByTestId('source-delete-yes').click();
  await expect(page.getByTestId('app-toast')).toContainText('“Tapir notes” moved to the Trash.');
  await expect(page.locator(`[data-testid=source-link][data-source-id="${src.id}"]`)).toHaveCount(0);
  // Its thread is still listed, now with the other threads, and opens on its own.
  await page.locator(`[data-testid=thread-link][data-thread-id="${asked}"]`).click();
  await expect(page.getByTestId('source-origin')).toContainText('(in the Trash)');
  await expect(page.getByTestId('source-pane')).toHaveCount(0);

  await page.getByTestId('trash-toggle').click();
  await page.locator(`[data-testid=trash-item][data-id="${src.id}"] [data-testid=trash-restore]`).click();
  await expect(page.locator(`[data-testid=source-link][data-source-id="${src.id}"]`)).toBeVisible();
  await expect(page.getByTestId('source-pane')).toContainText('short trunk');
});
