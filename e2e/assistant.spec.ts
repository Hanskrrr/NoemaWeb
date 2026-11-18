import { expect, type Page, test } from '@playwright/test';
import { freshThread, ulidish } from './helpers.ts';

// The Assistant (ADRs 0023, 0024, 0028): floating over whatever is open (⌘J,
// the header, the rail or its orb in the corner), folded to a bar until
// something is asked; pinned beside it; or on its own page. It knows what is open and what is
// selected, looks things up as it answers (the fake model does what the
// question's markers say), cites with cards that preview the very words (one
// a thing, the first few), makes changes itself with Undo and Undo all (ADR
// 0033) or, asked to, proposes them for Do it; and the frame shows it working.

const H = { 'x-noema-client': 'web' };

async function addPasted(page: Page, text: string): Promise<string> {
  const nb = await (await page.request.get('/api/notebooks')).json();
  const res = await page.request.post(`/api/notebooks/${nb.notebooks[0].id}/sources`, { data: { id: ulidish(), text }, headers: H });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

const dock = (page: Page) => page.getByTestId('assistant-dock');

/** Whether the Assistant asks before it changes things (ADR 0033), set before the page opens. */
async function setAsks(page: Page, asks: boolean): Promise<void> {
  const nb = await (await page.request.get('/api/notebooks')).json();
  await page.request.patch(`/api/notebooks/${nb.notebooks[0].id}`, { data: { assistantAsks: asks }, headers: H });
}
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

test('it acts itself: a change is done as it is made, Open goes there, Undo takes it back; many at once fold, with Undo all', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await setAsks(page, false);
  for (const n of [1, 2, 3, 4, 5]) await addPasted(page, `# Reading ${n}\n\nWarps of thirty-two threads, part ${n}.`);
  await page.goto('/');
  await openDock(page);
  await expect(dock(page).getByTestId('assistant-acts')).toHaveText('Acts itself');

  // Cited five times, five things: three cards, and the rest on asking.
  await askDock(page, 'Where did I read about warps? [[cite:1, 2, 3, 4, 5]]');
  const cited = dock(page).locator('.assistant-a').last();
  await expect(cited.getByTestId('mention')).toHaveCount(3);
  await cited.getByTestId('mention-more').click();
  await expect(cited.getByTestId('mention')).toHaveCount(5);

  await askDock(page, 'Start one about warps [[call:start_thread:{"question":"What is a warp?"}]]');
  const card = dock(page).getByTestId('action-card').last();
  await expect(card).toHaveAttribute('data-status', 'done');
  await expect(card).toContainText('Start a thread: “What is a warp?”');
  await card.getByTestId('action-open').click();
  await expect(page).toHaveURL(/#\/t\/[0-9A-Z]{26}$/);
  await expect(page.locator('.main [data-testid=message][data-role=user]').first()).toHaveText('What is a warp?');
  // The place changed: the Assistant sees the new thread.
  await expect(dock(page).getByTestId('assistant-where')).toContainText('What is a warp');
  await card.getByTestId('action-undo').click();
  await expect(card).toHaveAttribute('data-status', 'undone');
  await expect(page.getByTestId('in-trash')).toBeVisible();

  // Five changes in one answer: a line says so, the list folds, and Undo all takes them all back.
  const tag = ulidish().slice(-6);
  const calls = [1, 2, 3, 4, 5].map((n) => `[[call:put_in_room:{"refs":[${n}],"room":"Warps ${tag} ${n}"}]]`).join(' ');
  await askDock(page, `File these [[together]] ${calls}`);
  const group = dock(page).getByTestId('action-group').last();
  await expect(group.getByTestId('action-head')).toContainText('Did 5 things');
  await expect(group.getByTestId('action-card')).toHaveCount(0);
  await group.getByTestId('action-show-all').click();
  await expect(group.getByTestId('action-card')).toHaveCount(5);
  await group.getByTestId('action-undo-all').click();
  await expect(group.locator('[data-testid=action-card][data-status=undone]')).toHaveCount(5);
  const rooms = await (await page.request.get(`/api/notebooks/${(await (await page.request.get('/api/notebooks')).json()).notebooks[0].id}/rooms`)).json();
  expect(rooms.rooms.filter((r: { title: string }) => r.title.startsWith(`Warps ${tag}`))).toHaveLength(0);

  // Show takes the learner there at once.
  await askDock(page, 'Take me to it [[list:threads]] [[call:show:{"ref":1}]]');
  await expect(dock(page).getByTestId('action-card').last()).toHaveAttribute('data-kind', 'show');
});

test('asked to ask first, a change waits for Do it, and Do all does what waits', async ({ page, request }) => {
  await freshThread(request);
  await setAsks(page, false);
  await page.goto('/');
  await openDock(page);
  const acts = dock(page).getByTestId('assistant-acts');
  await acts.click();
  await expect(acts).toHaveText('Asks first');
  try {
    await askDock(page, 'Start one about lanes [[call:start_thread:{"question":"What is a lane?"}]]');
    const card = dock(page).getByTestId('action-card').last();
    await expect(card).toHaveAttribute('data-status', 'proposed');
    await card.getByTestId('action-run').click();
    await expect(card).toHaveAttribute('data-status', 'done');

    const tag = ulidish().slice(-6);
    await askDock(page, `File it twice [[together]] [[call:put_in_room:{"refs":[1],"room":"Lanes ${tag} A"}]] [[call:put_in_room:{"refs":[1],"room":"Lanes ${tag} B"}]]`);
    const group = dock(page).getByTestId('action-group').last();
    await expect(group.getByTestId('action-head')).toContainText('2 wait for you');
    await group.getByTestId('action-run-all').click();
    await expect(group.locator('[data-testid=action-card][data-status=done]')).toHaveCount(2);
  } finally {
    // Back to acting itself, for the tests after.
    await acts.click();
    await expect(acts).toHaveText('Acts itself');
  }
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

test('pinned beside what is open, the panel can be made wider or narrower, and the catalog stays clear of it', async ({ page, request }) => {
  const id = await freshThread(request);
  for (const q of ['What is a warp?', 'And a block?', 'And a grid?']) {
    const r = await request.post(`/api/threads/${id}/messages`, { data: { id: ulidish(), content: q }, headers: H });
    const { assistant } = await r.json();
    await expect.poll(async () => (await (await request.get(`/api/threads/${id}`)).json()).messages.find((m: { id: string }) => m.id === assistant.id)?.status).toBe('done');
  }
  await page.goto(`/#/t/${id}`);
  const catalog = page.locator('nav.outline');
  await expect(catalog).toBeVisible();
  await openDock(page);
  await dock(page).getByTestId('assistant-pin').click();
  await expect(dock(page)).toHaveAttribute('data-mode', 'pinned');
  const clear = async () => {
    const c = await catalog.boundingBox();
    const d = await dock(page).boundingBox();
    return c && d ? c.x + c.width <= d.x : false;
  };
  await expect.poll(clear).toBe(true);

  // Drag its left edge 150 px to the left: 150 px wider, and still clear; kept after a reload.
  const before = (await dock(page).boundingBox())?.width ?? 0;
  const handle = page.getByTestId('dock-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const width = async () => Math.round((await dock(page).boundingBox())?.width ?? 0);
  // Within a pixel or two: where in the handle the pointer is.
  await expect.poll(async () => Math.abs((await width()) - (before + 150))).toBeLessThanOrEqual(3);
  await expect.poll(clear).toBe(true);
  const dragged = await width();
  await page.reload();
  await expect(dock(page)).toBeVisible();
  await expect.poll(width).toBe(dragged);
  // The keyboard works too.
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(dragged - 24);
});

test('it floats over what is open: a bar that knows the place, the conversation once asked, folded back; Esc puts it away and its orb brings it back', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const id = await addPasted(page, '# Week 10: Warps\n\nA warp is 32 threads that run in step.');
  await page.goto(`/#/s/${id}`);
  await expect(page.getByTestId('source-text')).toBeVisible();
  const mainWidth = () => page.locator('.main').evaluate((e) => e.clientWidth);
  const before = await mainWidth();
  await expect(page.getByTestId('assistant-launcher')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+j');
  await expect(dock(page)).toHaveAttribute('data-mode', 'float');
  await expect(dock(page)).toHaveAttribute('data-folded', 'true');
  await expect(page.getByTestId('assistant-launcher')).toHaveCount(0);
  // It floats: what is open keeps its width.
  expect(await mainWidth()).toBe(before);
  // Questions for a source, and the place in its words.
  const chips = dock(page).getByTestId('assistant-glance').getByTestId('assistant-ask');
  await expect(chips.first()).toHaveText('What are the key ideas here?');
  await expect(dock(page).getByTestId('composer')).toHaveAttribute('placeholder', 'Ask about “Week 10: Warps”, or anything…');

  // Asked, it opens on the conversation.
  await chips.first().click();
  await expect(dock(page)).toHaveAttribute('data-folded', 'false');
  await expect(answers(page).last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(answers(page).last()).toBeVisible();

  // Folded: what was last asked, one click from the conversation.
  await dock(page).getByTestId('assistant-fold').click();
  await expect(dock(page)).toHaveAttribute('data-folded', 'true');
  await expect(answers(page).last()).toBeHidden();
  await expect(dock(page).getByTestId('assistant-last')).toContainText('What are the key ideas here?');

  // Esc puts it away; the orb in the corner brings it back as it was.
  await dock(page).getByTestId('composer').press('Escape');
  await expect(dock(page)).toHaveCount(0);
  await expect(frame(page)).toHaveAttribute('data-presence', 'off');
  await page.getByTestId('assistant-launcher').click();
  await expect(dock(page)).toHaveAttribute('data-folded', 'true');
  await dock(page).getByTestId('assistant-last').click();
  await expect(dock(page)).toHaveAttribute('data-folded', 'false');
});

test('moved by its header and resized from its corner, it stays where it was put; pinned, it is the side panel again, and floats back', async ({
  page,
  request,
}) => {
  await freshThread(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openDock(page);
  if ((await dock(page).getAttribute('data-folded')) === 'true') await dock(page).getByTestId('assistant-fold').click();
  await expect(dock(page)).toHaveAttribute('data-folded', 'false');
  const box = async () => {
    const b = await dock(page).boundingBox();
    if (!b) throw new Error('no box');
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const start = await box();

  // Dragged by its header, 300 left and 100 up.
  const head = await dock(page).getByTestId('assistant-head').boundingBox();
  if (!head) throw new Error('no header');
  await page.mouse.move(head.x + 90, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 90 - 300, head.y + head.height / 2 - 100, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => { const b = await box(); return [b.x - start.x, b.y - start.y]; }).toEqual([-300, -100]);

  // Resized from its top-left corner: 80 wider, 60 taller, its bottom-right where it was.
  const moved = await box();
  const grip = await dock(page).getByTestId('float-grip').boundingBox();
  if (!grip) throw new Error('no grip');
  await page.mouse.move(grip.x + 6, grip.y + 6);
  await page.mouse.down();
  await page.mouse.move(grip.x + 6 - 80, grip.y + 6 - 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => { const b = await box(); return [b.w - moved.w, b.h - moved.h, b.x + b.w - (moved.x + moved.w), b.y + b.h - (moved.y + moved.h)]; }).toEqual([80, 60, 0, 0]);

  // Kept after a reload.
  const kept = await box();
  await page.reload();
  await expect(dock(page)).toBeVisible();
  await expect.poll(box).toEqual(kept);

  // Pinned beside: the side panel, and what is open makes room; floated back, as it was.
  const mainWidth = () => page.locator('.main').evaluate((e) => e.clientWidth);
  const floating = await mainWidth();
  await dock(page).getByTestId('assistant-pin').click();
  await expect(dock(page)).toHaveAttribute('data-mode', 'pinned');
  await expect.poll(mainWidth).toBeLessThan(floating - 200);
  await dock(page).getByTestId('assistant-float').click();
  await expect(dock(page)).toHaveAttribute('data-mode', 'float');
  await expect.poll(box).toEqual(kept);
});
