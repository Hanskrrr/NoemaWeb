import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { freshThread, highlighted, ulidish } from './helpers.ts';

// Rooms (ADR 0026): things of one subject set together, whatever kind they
// are. Made in the sidebar; things go in by dragging them onto a room, by
// right-click, or by choosing in the room; files and links dropped on
// Sources (or on a room) are read as sources. Made-up text only.

const H = { 'x-noema-client': 'web' };

async function notebookId(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
}
async function addSource(request: APIRequestContext, title: string): Promise<string> {
  const id = ulidish();
  const res = await request.post(`/api/notebooks/${await notebookId(request)}/sources`, {
    data: { id, title, text: `# ${title}\n\nEvery worker holds a copy of the model.` },
    headers: H,
  });
  expect(res.ok()).toBe(true);
  return id;
}
async function addNote(request: APIRequestContext, title: string): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/notes`, { data: { id, title }, headers: H });
  return id;
}

test.beforeEach(async ({ page }) => {
  // These are about the Board, the map; a room opens in the way last chosen (ADR 0035).
  await page.addInitScript(() => localStorage.setItem('noema:room-view', 'board'));
});

test.afterEach(async ({ request }) => {
  // Taken down, so other tests see no rooms.
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  for (const r of rooms) await request.delete(`/api/rooms/${r.id}`, { headers: H });
});

async function makeRoom(page: Page, title: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  await page.getByTestId('new-room').click();
  await page.getByTestId('new-room-title').fill(title);
  await page.getByTestId('new-room-title').press('Enter');
  await expect(page.getByTestId('room')).toBeVisible();
  await expect(page.getByTestId('room-rename')).toContainText(title);
}

test('a room is made in the sidebar; a source dragged onto it is in it, with its cluster on the map', async ({ page, request }) => {
  await freshThread(request);
  const sourceId = await addSource(request, 'Week 4 slides');
  await page.goto('/');
  await makeRoom(page, 'Distributed training');
  await expect(page.getByTestId('room-empty')).toBeVisible();

  // Drag the source from Sources onto the room: held over the Rooms icon, the list of rooms shows.
  await page.getByTestId('rail-sources').click();
  const source = page.locator(`[data-testid=source-link][data-source-id="${sourceId}"]`);
  const roomRow = page.getByTestId('room-link').filter({ hasText: 'Distributed training' });
  await source.hover();
  await page.mouse.down();
  await page.getByTestId('rail-rooms').hover();
  await page.waitForTimeout(250);
  await page.getByTestId('rail-rooms').hover({ position: { x: 10, y: 10 } });
  await expect(roomRow).toBeVisible();
  await roomRow.hover();
  await page.mouse.up();
  const loose = page.locator(`[data-testid=loose-link][data-id="${sourceId}"]`);
  await expect(page.getByTestId('room-notice')).toContainText('Put in Distributed training');
  await expect(loose).toHaveCount(0);
  await expect(roomRow).toContainText('1');

  await roomRow.click();
  const cluster = page.getByTestId('room-cluster');
  await expect(cluster).toHaveCount(1);
  await expect(cluster.getByTestId('room-card').first()).toContainText('Week 4 slides');
  await expect(page.getByTestId('room-meta')).toHaveText('1 source · 0 threads · 0 notes');
});

test('right-click puts a note in a room, or in a new one; in the room, it is taken out the same way', async ({ page, request }) => {
  await freshThread(request);
  const noteId = await addNote(request, 'Questions for office hours');
  await page.goto('/');
  await makeRoom(page, 'Office hours');
  await page.getByTestId('rail-notes').click();
  const note = page.locator(`[data-testid=note-link][data-note-id="${noteId}"]`);
  await note.click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('menu-room')).toHaveText('Office hours');
  await expect(menu.getByTestId('menu-room')).toHaveAttribute('aria-checked', 'false');
  await menu.getByTestId('menu-room').click();
  await expect(page.getByTestId('room-notice')).toContainText('Put in Office hours');

  // Again: it is ticked; a new room with it, by name.
  await note.click({ button: 'right' });
  await expect(menu.getByTestId('menu-room')).toHaveAttribute('aria-checked', 'true');
  await menu.getByTestId('menu-new-room').click();
  await menu.getByTestId('menu-new-room-input').fill('Exam prep');
  await menu.getByTestId('menu-new-room-input').press('Enter');
  await expect(page.getByTestId('room-notice')).toContainText('Put in the new room Exam prep');

  await page.getByTestId('rail-rooms').click();
  await page.getByTestId('room-link').filter({ hasText: 'Office hours' }).click();
  const card = page.getByTestId('room-card').filter({ hasText: 'Questions for office hours' });
  await expect(card).toBeVisible();
  await card.click({ button: 'right' });
  await menu.getByTestId('menu-take-out').click();
  await expect(page.getByTestId('room-empty')).toBeVisible();
  await expect(page.getByTestId('room-link').filter({ hasText: 'Exam prep' })).toContainText('1');
});

test('in a room, you choose what is in it; a card held a moment lifts its cluster to move it, kept after a reload', async ({ page, request }) => {
  await freshThread(request);
  const a = await addSource(request, 'Attention paper');
  const b = await addNote(request, 'Softmax note');
  await page.goto('/');
  await makeRoom(page, 'Transformers');
  await page.getByTestId('room-pick').click();
  const picker = page.getByTestId('room-picker');
  await picker.getByTestId('room-picker-filter').fill('attention');
  await picker.locator(`[data-testid=room-picker-row][data-id="${a}"] input`).check();
  await picker.getByTestId('room-picker-filter').fill('softmax');
  await picker.locator(`[data-testid=room-picker-row][data-id="${b}"] input`).check();
  await expect(page.getByTestId('room-cluster')).toHaveCount(2);

  const first = page.locator(`[data-testid=room-cluster][data-key="source:${a}"]`);
  const before = await first.boundingBox();
  const box = before as { x: number; y: number; width: number; height: number };
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  // Held still a moment, it lifts; then it moves with the pointer.
  await expect(first).toHaveClass(/is-lifted/);
  await page.mouse.move(box.x + 130, box.y + 152, { steps: 6 });
  await page.mouse.up();
  await expect(first).not.toHaveClass(/is-lifted/);
  // Alt+arrow moves it on from the keyboard.
  await first.getByTestId('room-card-open').first().focus();
  await page.keyboard.press('Alt+ArrowRight');
  const moved = (await first.boundingBox()) as typeof box;
  expect(Math.round(moved.x - box.x)).toBe(124);
  expect(Math.round(moved.y - box.y)).toBe(140);
  // Dragging did not open it.
  await expect(page.getByTestId('room')).toBeVisible();

  // Where it sits in the room (the picker above moves the whole map down).
  const inRoom = async () => {
    const c = (await page.getByTestId('room-canvas').boundingBox()) as typeof box;
    const x = (await page.locator(`[data-testid=room-cluster][data-key="source:${a}"]`).boundingBox()) as typeof box;
    return { x: Math.round(x.x - c.x), y: Math.round(x.y - c.y) };
  };
  const there = await inRoom();
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('room-cluster')).toHaveCount(2);
  expect(await inRoom()).toEqual(there);
});

test('files dropped on Sources are read as sources; dropped on a room, they are in it too', async ({ page, request }) => {
  await freshThread(request);
  await page.goto('/');
  // The last thread opens first (and shows the thread list); only then switch to Sources.
  await expect(page.getByTestId('composer')).toBeVisible();
  await page.getByTestId('rail-sources').click();
  await expect(page.getByTestId('rail-sources')).toHaveAttribute('aria-pressed', 'true');
  const files = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# Gradient checkpointing\n\nRecompute activations in the backward pass.'], 'checkpointing.md', { type: 'text/markdown' }));
    dt.items.add(new File(['def step():\n    return 1\n'], 'recompute_step.py', { type: 'text/x-python' }));
    dt.items.add(new File([new Uint8Array([0, 1, 2, 3, 0, 5])], 'photo.png', { type: 'image/png' }));
    return dt;
  });
  await page.getByTestId('sources-drop').dispatchEvent('drop', { dataTransfer: files });
  await expect(page.getByTestId('sources-drop-status')).toContainText('photo.png: not text');
  await expect(page.getByTestId('source-link').filter({ hasText: 'Gradient checkpointing' })).toBeVisible();
  await expect(page.getByTestId('source-link').filter({ hasText: 'recompute_step.py' })).toBeVisible();

  await makeRoom(page, 'Memory');
  const more = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# ZeRO\n\nShard the optimizer state.'], 'zero.md', { type: 'text/markdown' }));
    return dt;
  });
  await page.getByTestId('room-canvas').dispatchEvent('drop', { dataTransfer: more, clientX: 600, clientY: 500 });
  await expect(page.getByTestId('room-status')).toContainText('Added 1 source to this room.');
  await expect(page.getByTestId('room-card').filter({ hasText: 'ZeRO' })).toBeVisible();
});

test('read with AI: summaries whose points open the words they quote; suggested links kept, changed, deleted; a link drawn by hand', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const a = await addSource(request, 'Ring all-reduce');
  const b = await addSource(request, 'Parameter server');
  const c = await addNote(request, 'Bandwidth note');
  const nb = await notebookId(request);
  await request.post(`/api/notes/${c}/blocks`, { data: { id: ulidish(), after: null, content: 'Each worker sends and receives about twice the gradient size.' }, headers: H });
  const room = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, {
    data: { id: room, title: 'Communication', items: [{ kind: 'source', id: a }, { kind: 'source', id: b }] },
    headers: H,
  });
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-read')).toHaveText('Read with AI · 2 new');
  await page.getByTestId('room-read').click();
  await expect(page.getByTestId('room-reading')).toContainText('Read. 2 summaries written; 1 link suggested');
  await expect(page.getByTestId('room-read')).toHaveText('Read again');

  // A summary on each card; its first point opens the source at the words it quotes.
  const card = page.locator(`[data-testid=room-card][data-id="${a}"]`);
  await expect(card.getByTestId('room-gist')).toContainText('Fake summary of “Ring all-reduce”');
  await card.getByTestId('room-point').first().click();
  await expect(page).toHaveURL(new RegExp(`#/s/${a}`));
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('Ring all-reduce');
  await page.goBack();

  // The suggested link waits in Review, not on the map; kept, it is drawn in its kind's colour.
  const label = page.getByTestId('link-label');
  await expect(label).toHaveCount(0);
  await page.getByTestId('room-review-open').click();
  const row = page.getByTestId('review-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('“Parameter server” explains “Ring all-reduce”');
  await expect(row).toContainText('Fake: 2 bears on 1.');
  await row.getByTestId('link-keep').click();
  await expect(page.getByTestId('room-review-open')).toHaveCount(0);
  await expect(label).toHaveCount(1);
  await expect(label).toHaveAttribute('data-status', 'accepted');
  await expect(page.getByTestId('item-line')).toHaveAttribute('data-kind', 'explains');
  await expect(page.getByTestId('room-legend')).toContainText('explains');
  // At rest a dot; pointing at one of its cards shows its words.
  await expect(label).toHaveClass(/is-dot/);
  await page.locator(`[data-testid=room-card][data-id="${b}"]`).hover();
  await expect(label).toHaveText('explains');
  // Nothing covers anything: a link's words are on no card, key points stay in their card, clusters apart.
  await expect.poll(() => coverings(page)).toEqual({ wordsOnCards: 0, pointsOut: 0, clustersOnClusters: 0 });
  await label.click();
  const editor = page.getByTestId('link-editor');
  await expect(editor).toContainText('“Parameter server” explains “Ring all-reduce”');
  await editor.getByTestId('link-kind').selectOption('contrasts-with');
  await expect(label).toHaveText('contrasts with');
  await editor.getByTestId('link-words').fill('central vs ring');
  await editor.getByTestId('link-words').press('Enter');
  await expect(label).toHaveText('central vs ring');
  await editor.getByTestId('link-delete').click();
  await expect(label).toHaveCount(0);

  // Drawn from the menu: right-click, Link to…, pick the other card; the AI chooses what it means.
  await page.getByTestId('room-pick').click();
  await page.locator(`[data-testid=room-picker-row][data-id="${c}"] input`).check();
  const noteCard = page.locator(`[data-testid=room-card][data-id="${c}"]`);
  await expect(noteCard).toBeVisible();
  await noteCard.click({ button: 'right' });
  await page.getByTestId('context-menu').getByTestId('menu-link-to').click();
  await expect(page.getByTestId('room-linking')).toContainText('Pick the card “Bandwidth note” links to');
  await card.getByTestId('room-card-open').click();
  await expect(editor).toContainText('“Bandwidth note” builds on “Ring all-reduce”');
  await expect(editor.getByTestId('link-by')).toHaveText('Drawn by you; the AI chose what it means: Fake: the AI chose builds on.');
  await editor.getByTestId('link-kind').selectOption('example-of');
  await expect(page.getByTestId('link-label')).toHaveText('is an example of');
  // Still on the room: picking a card in link mode did not open it.
  await expect(page.getByTestId('room')).toBeVisible();
});

test('with the Assistant open on a room, nothing of the room is drawn over it: floating, the room keeps its width; pinned, the map scrolls sideways', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const ids = [await addSource(request, 'Tensor parallel'), await addSource(request, 'Pipeline parallel'), await addSource(request, 'Expert parallel')];
  const nb = await notebookId(request);
  const room = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, {
    data: { id: room, title: 'Parallelism', items: ids.map((id) => ({ kind: 'source', id })) },
    headers: H,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-cluster')).toHaveCount(3);
  const map = page.getByTestId('room-map');
  const mapWidth = () => map.evaluate((e) => e.clientWidth);
  const wide = await mapWidth();
  // The map fits the room: no sideways scrolling before the Assistant opens.
  expect(await map.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.getByTestId('assistant-open').click();
  const dock = page.getByTestId('assistant-dock');
  await expect(dock).toBeVisible();
  // Every point of the Assistant shows the Assistant, not a card of the room.
  const covered = () =>
    page.evaluate(() => {
      const d = document.querySelector('[data-testid=assistant-dock]')?.getBoundingClientRect();
      if (!d) return -1;
      let n = 0;
      for (let x = d.left + 8; x < d.right - 2; x += 24) {
        for (let y = d.top + 8; y < d.bottom - 2; y += 24) {
          const e = document.elementFromPoint(x, y);
          if (e && !e.closest('[data-testid=assistant-dock]')) n++;
        }
      }
      return n;
    });
  // Floating: over the room, which keeps its width.
  await expect(dock).toHaveAttribute('data-mode', 'float');
  expect(await covered()).toBe(0);
  expect(await mapWidth()).toBe(wide);

  // Pinned beside it: the map keeps its place and scrolls sideways to the cluster that does not fit.
  await dock.getByTestId('assistant-pin').click();
  await expect(dock).toHaveAttribute('data-mode', 'pinned');
  expect(await covered()).toBe(0);
  expect(await map.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  const last = page.getByTestId('room-cluster').nth(2);
  await last.scrollIntoViewIfNeeded();
  const [b, d] = [await last.boundingBox(), await dock.boundingBox()];
  expect(b && d && b.x + b.width <= d.x + 1).toBe(true);
});

test('drag from one card to another to link them: the line glows while the AI chooses what it means, then takes its colour', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const a = await addSource(request, 'Activation memory');
  const b = await addSource(request, 'Checkpointing');
  const nb = await notebookId(request);
  const room = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, {
    data: { id: room, title: 'Memory', items: [{ kind: 'source', id: a }, { kind: 'source', id: b }] },
    headers: H,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-cluster')).toHaveCount(2);
  const from = page.locator(`[data-testid=room-card][data-id="${b}"]`);
  const to = page.locator(`[data-testid=room-card][data-id="${a}"]`);
  const fb = (await from.boundingBox()) as { x: number; y: number; width: number; height: number };
  const tb = (await to.boundingBox()) as typeof fb;
  // Pressed and moved at once: a line follows the pointer; the card under it is the target.
  await page.mouse.move(fb.x + 40, fb.y + 20);
  await page.mouse.down();
  await page.mouse.move(fb.x + 80, fb.y + 40, { steps: 3 });
  await page.mouse.move(tb.x + 60, tb.y + 30, { steps: 8 });
  await expect(to).toHaveClass(/is-target/);
  await page.mouse.up();
  // The AI chose; the line is kept, in its kind's colour, and its editor says why.
  const editor = page.getByTestId('link-editor');
  await expect(editor.getByTestId('link-by')).toHaveText('Drawn by you; the AI chose what it means: Fake: the AI chose builds on.');
  await expect(editor).toContainText('“Checkpointing” builds on “Activation memory”');
  await expect(page.getByTestId('item-line')).toHaveAttribute('data-kind', 'builds-on');
  // Dragging did not open either card.
  await expect(page.getByTestId('room')).toBeVisible();
  // Drawn again between the same two: that link is shown, not a second one.
  await page.keyboard.press('Escape');
  await page.mouse.move(fb.x + 40, fb.y + 20);
  await page.mouse.down();
  await page.mouse.move(tb.x + 60, tb.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('room-status')).toContainText('Those two are linked already');
  await expect(page.getByTestId('item-line')).toHaveCount(1);
  // A click still opens the card.
  await to.getByTestId('room-card-open').click();
  await expect(page).toHaveURL(new RegExp(`#/s/${a}`));
});

test('a room you work in: its brief and what is still open; asked, written and added from the room, each lands in it', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const a = await addSource(request, 'Activation memory');
  const b = await addNote(request, 'Checkpointing');
  const nb = await notebookId(request);
  await request.post(`/api/notes/${b}/blocks`, { data: { id: ulidish(), after: null, content: 'Recompute some activations in the backward pass.' }, headers: H });
  const room = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, {
    data: { id: room, title: 'ML systems', items: [{ kind: 'source', id: a }, { kind: 'note', id: b }] },
    headers: H,
  });
  await page.goto(`/#/room/${room}`);
  // Not read yet: the brief invites reading, and says what it costs.
  const brief = page.getByTestId('room-brief');
  await expect(brief).toContainText('Read this room');
  // Two summaries, the links and the brief; each thing read for its concepts, new names, their links.
  await expect(brief).toContainText('about 8 calls, 2 of them reading its things for concepts');
  await brief.getByTestId('room-read').click();
  await expect(page.getByTestId('room-brief-text')).toHaveText('Fake brief of “ML systems”: 2 things, read in order.');
  await expect(brief).toContainText('What this room adds up to');
  // What is still open opens the thing it is open in.
  const open = page.getByTestId('room-open-q');
  await expect(open).toContainText('What is still unclear about');
  await open.first().click();
  await expect(page).toHaveURL(/#\/(s|note)\/[0-9A-Z]{26}/);
  await expect(page.getByTestId('room-trail-room')).toHaveText('⌂ ML systems');
  await page.getByTestId('room-trail-room').click();
  await expect(page).toHaveURL(new RegExp(`#/room/${room}`));

  // Asked in the room: a thread in it, its question answered with the room's brief.
  await page.getByTestId('room-ask').fill('Why is backprop memory-bound?');
  await page.getByTestId('room-ask').press('Enter');
  await expect(page).toHaveURL(/#\/t\/[0-9A-Z]{26}$/);
  await expect(page.getByTestId('room-trail-room')).toHaveText('⌂ ML systems');
  const answer = page.locator('.main [data-testid=message][data-role=assistant]').first();
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await answer.getByTestId('show-context').click();
  const part = page.getByTestId('context-part').filter({ hasText: 'The room it is in' });
  await expect(part).toHaveCount(1);
  await expect(part).toContainText('Fake brief of “ML systems”');
  await page.keyboard.press('Escape');
  await page.getByTestId('room-trail-room').click();
  await expect(page.locator('[data-testid=room-card][data-kind=thread]')).toHaveCount(1);

  // A note here: made, in the room, opened.
  await page.getByTestId('room-note-here').click();
  await expect(page).toHaveURL(/#\/note\/[0-9A-Z]{26}/);
  await expect(page.getByTestId('room-trail-room')).toHaveText('⌂ ML systems');
  await page.getByTestId('room-trail-room').click();
  await expect(page.locator('[data-testid=room-card][data-kind=note]')).toHaveCount(2);

  // A source here: added, in the room, and the room stays open.
  await page.getByTestId('room-source-here').click();
  await page.getByTestId('source-mode-paste').click();
  await page.getByTestId('source-text-input').fill('# Mixed precision\n\nHalf precision halves activation memory.');
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('room-card').filter({ hasText: 'Mixed precision' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/room/${room}`));
  // Something new: the brief is older, and Read with AI says how many are new.
  await expect(brief).toContainText('older: things changed since');
  await expect(brief.getByTestId('room-read')).toContainText('new');
});

test('sources from the web: asked in a room, it searches when the question needs it and offers pages; for what is still open too; the web can be off', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const a = await addSource(request, 'Activation memory');
  const nb = await notebookId(request);
  const room = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, { data: { id: room, title: 'Memory', items: [{ kind: 'source', id: a }] }, headers: H });
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-web')).toHaveText('◎ Web on');

  // Asked in the room: it searched, shows what it searched, and offers the pages.
  await page.getByTestId('room-ask').fill('Checkpointing papers this year [[web]]');
  await page.getByTestId('room-ask').press('Enter');
  await expect(page).toHaveURL(/#\/t\/[0-9A-Z]{26}$/);
  const answer = page.locator('.main [data-testid=message][data-role=assistant]').first();
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(page.getByTestId('lookup-step')).toHaveText(['◎Searched the web “Checkpointing papers this year”· 3']);
  const finds = page.getByTestId('web-find');
  await expect(finds).toHaveCount(3);
  await expect(finds.first()).toContainText('Fake page 1 on Checkpointing papers this year');
  await expect(finds.first()).toContainText('web 1 · example.org · 2026-01-01');
  await finds.nth(2).getByTestId('web-find-dismiss').click();
  await expect(finds).toHaveCount(2);
  // What was sent says the question went with what was found.
  await answer.getByTestId('show-context').click();
  await expect(page.getByTestId('context-part').filter({ hasText: 'Your question, with what was found on the web' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Back in the room: read it, then find sources for what is still open; they wait in Review.
  await page.getByTestId('room-trail-room').click();
  await page.getByTestId('room-read').click();
  await expect(page.getByTestId('room-brief-text')).toContainText('Fake brief');
  await page.getByTestId('room-find-sources').click();
  const review = page.getByTestId('room-review-web');
  await expect(review.getByTestId('web-find')).toHaveCount(3);
  await expect(review).toContainText('Sources for what is still open');
  await review.getByTestId('web-find-dismiss').first().click();
  await expect(review.getByTestId('web-find')).toHaveCount(2);

  // The web off: the room says so, and keeps it.
  await page.getByTestId('room-web').click();
  await expect(page.getByTestId('room-web')).toHaveText('◎ Web off');
  await page.reload();
  await expect(page.getByTestId('room-web')).toHaveText('◎ Web off');
});

test('rooms in rooms: a room put in a bigger one is a door there; through it, the way back; a card drawn onto it goes in; never inside itself', async ({
  page,
  request,
}) => {
  await freshThread(request);
  const a = await addSource(request, 'Course outline');
  const b = await addNote(request, 'Activation memory');
  await request.post(`/api/notes/${b}/blocks`, { data: { id: ulidish(), after: null, content: 'Saved activations fill memory.' }, headers: H });
  const nb = await notebookId(request);
  const big = ulidish();
  const small = ulidish();
  await request.post(`/api/notebooks/${nb}/rooms`, { data: { id: big, title: 'Machine learning', items: [{ kind: 'source', id: a }] }, headers: H });
  await request.post(`/api/notebooks/${nb}/rooms`, { data: { id: small, title: 'ML systems', items: [{ kind: 'note', id: b }] }, headers: H });
  await request.post(`/api/notebooks/${nb}/rooms`, { data: { id: ulidish(), title: 'Cooking' }, headers: H });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/room/${big}`);

  // Room here: the rooms that can go in it, or a new one.
  await page.getByTestId('room-room-here').click();
  const here = page.getByTestId('room-here');
  await expect(here.getByTestId('room-here-pick')).toHaveText(['⌂ ML systems', '⌂ Cooking']);
  await here.getByTestId('room-here-pick').filter({ hasText: 'ML systems' }).click();
  await expect(here).toHaveCount(0);
  const door = page.getByTestId('room-door');
  await expect(door).toHaveCount(1);
  await expect(door).toContainText('ML systems');
  await expect(door).toContainText('1 note');
  await expect(door.locator('.room-door-tile')).toHaveCount(1);
  await expect(page.getByTestId('room-meta')).toContainText('1 room inside');
  // In the sidebar, it is under the bigger room.
  if (!(await page.getByTestId('room-list').isVisible())) await page.getByTestId('rail-rooms').click();
  await expect(page.locator(`[data-testid=room-link][data-room-id="${small}"]`)).toHaveAttribute('data-depth', '1');

  // A card drawn onto the door goes in that room, and stays here until taken out.
  const card = page.locator(`[data-testid=room-card][data-id="${a}"]`);
  const cb = (await card.boundingBox()) as { x: number; y: number; width: number; height: number };
  const db = (await door.boundingBox()) as typeof cb;
  await page.mouse.move(cb.x + 40, cb.y + 20);
  await page.mouse.down();
  await page.mouse.move(cb.x + 80, cb.y + 40, { steps: 3 });
  await page.mouse.move(db.x + 60, db.y + 30, { steps: 8 });
  await expect(door).toHaveClass(/is-target/);
  await page.mouse.up();
  await expect(page.getByTestId('room-put-into')).toContainText('“Course outline” is in “ML systems” now, and still here.');
  await expect(door).toContainText('1 source · 1 note');
  await page.getByTestId('room-put-into-move').click();
  await expect(card).toHaveCount(0);

  // Through the door: the way back above its name; the bigger room is not offered to go in it.
  await door.getByTestId('room-door-open').click();
  await expect(page).toHaveURL(new RegExp(`#/room/${small}`));
  await expect(page.getByTestId('room-path-room')).toHaveText('⌂ Machine learning');
  await expect(page.locator(`[data-testid=room-card][data-id="${a}"]`)).toBeVisible();
  await page.getByTestId('room-room-here').click();
  await expect(page.getByTestId('room-here-pick')).toHaveText(['⌂ Cooking']);
  await page.getByTestId('room-here').getByRole('button', { name: 'Cancel' }).click();
  // The small room read; then the bigger one, whose brief is written from it.
  await page.getByTestId('room-read').click();
  await expect(page.getByTestId('room-brief-text')).toHaveText('Fake brief of “ML systems”: 2 things, read in order.');
  await page.getByTestId('room-path-room').click();
  await expect(page).toHaveURL(new RegExp(`#/room/${big}`));
  await expect(page.getByTestId('room-door-brief')).toContainText('Fake brief of “ML systems”');
  await page.getByTestId('room-read').click();
  await expect(page.getByTestId('room-brief-text')).toHaveText('Fake brief of “Machine learning”: 1 things, read in order. Its rooms: ML systems.');
});

/** What covers what on the map of a room. */
async function coverings(page: Page) {
  return page.evaluate(() => {
    const r = (e: Element) => e.getBoundingClientRect();
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const cards = [...document.querySelectorAll('[data-testid=room-card]')];
    const clusters = [...document.querySelectorAll('[data-testid=room-cluster]')];
    let wordsOnCards = 0;
    for (const l of document.querySelectorAll('[data-testid=link-label]')) for (const c of cards) if (hit(r(l), r(c))) wordsOnCards++;
    let pointsOut = 0;
    for (const p of document.querySelectorAll('.room-point')) {
      const c = p.closest('[data-testid=room-card]');
      if (c && r(p).right > r(c).right + 1) pointsOut++;
    }
    let clustersOnClusters = 0;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) if (hit(r(clusters[i] as Element), r(clusters[j] as Element))) clustersOnClusters++;
    return { wordsOnCards, pointsOut, clustersOnClusters };
  });
}
