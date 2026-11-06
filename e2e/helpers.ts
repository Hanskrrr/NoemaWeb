import { type APIRequestContext, expect, type Page } from '@playwright/test';

const H = { 'x-noema-client': 'web' };

export function ulidish(): string {
  // Good enough for tests: a valid ULID made from the clock and Math.random.
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = A[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += A[Math.floor(Math.random() * 32)];
  return time + rand;
}

/** Start each test in a brand-new thread: the app opens the most recent one. */
export async function freshThread(request: APIRequestContext): Promise<string> {
  const nb = await (await request.get('/api/notebooks')).json();
  const id = ulidish();
  const res = await request.post(`/api/notebooks/${nb.notebooks[0].id}/threads`, { data: { id }, headers: H });
  expect(res.status()).toBe(201);
  return id;
}

export async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('composer').fill(question);
  await page.getByTestId('composer').press('Enter');
}

export function lastAnswer(page: Page) {
  return page.locator('[data-testid=message][data-role=assistant]').last();
}

export async function threadDetail(request: APIRequestContext, threadId: string) {
  return (await request.get(`/api/threads/${threadId}`)).json() as Promise<{
    messages: Array<{ id: string; role: string; content: string; status: string }>;
  }>;
}

/** Select `word` inside the last answer with a real double-click. */
export async function doubleClickWord(page: Page, word: string): Promise<void> {
  const box = await lastAnswer(page).evaluate((root, w) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf(w) ?? -1;
      if (i >= 0) {
        // Bring it into view first: a click outside the window selects nothing useful.
        n.parentElement?.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
    }
    return null;
  }, word);
  if (!box) throw new Error(`"${word}" is not in the answer`);
  await page.mouse.dblclick(box.x, box.y);
}

/** The text currently painted by a CSS custom highlight, or null if there is none. */
export async function highlighted(page: Page, name: string): Promise<string | null> {
  return page.evaluate((n) => {
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
    const h = registry?.get(n);
    return h ? [...h].map((r) => r.toString()).join('|') : null;
  }, name);
}

/** The id in the URL, #/t/<id>. */
export function currentThreadId(page: Page): string {
  const m = /#\/t\/([0-9A-Z]{26})/.exec(page.url());
  if (!m?.[1]) throw new Error(`not on a thread: ${page.url()}`);
  return m[1];
}
