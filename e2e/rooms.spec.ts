import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { freshThread, ulidish } from './helpers.ts';

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

test('in a room, you choose what is in it; clusters stay where they are moved, after a reload too', async ({ page, request }) => {
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
  await page.mouse.move(box.x + 130, box.y + 152, { steps: 6 });
  await page.mouse.up();
  // Alt+arrow moves it on from the keyboard.
  await first.getByTestId('room-card').first().focus();
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
  await page.getByTestId('rail-sources').click();
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
