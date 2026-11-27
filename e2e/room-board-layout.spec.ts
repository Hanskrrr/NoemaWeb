import { expect, type Page, test } from '@playwright/test';
import { ask, doubleClickWord, ulidish } from './helpers.ts';

const headers = { 'x-noema-client': 'web' };
const createdRooms: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of createdRooms.splice(0)) await request.delete(`/api/rooms/${id}`, { headers });
});

async function dragBy(page: Page, handle: ReturnType<Page['getByTestId']>, dx: number, dy: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('The board control is missing.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test('Room overview reopens its last question and leads to the Board', async ({ page, request }) => {
  const { notebooks: [notebook] } = await (await request.get('/api/notebooks')).json();
  const room = ulidish();
  expect((await request.post(`/api/notebooks/${notebook.id}/rooms`, {
    headers, data: { id: room, title: 'AI product architecture' },
  })).ok()).toBe(true);
  createdRooms.push(room);
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-overview')).toBeVisible();
  await page.getByRole('button', { name: 'Set a goal' }).click();
  await page.getByRole('textbox', { name: 'Learning goal' }).fill('Describe each module in a request.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('room-ask').fill('How should I design the AI product architecture?');
  await page.getByTestId('room-ask-send').click();
  await expect(page.locator('[data-testid=message][data-role=assistant]').last()).toHaveAttribute('data-status', 'done');
  const threadUrl = page.url();
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-resume')).toContainText('Continue');
  await page.getByTestId('room-resume').click();
  await expect(page).toHaveURL(threadUrl);
  await doubleClickWord(page, 'offline');
  await page.getByTestId('branch-button').click();
  await ask(page, 'What does offline mean here?');
  await expect(page.locator('[data-testid=message][data-role=assistant]').last()).toHaveAttribute('data-status', 'done');
  const branchUrl = page.url();
  await page.goto(`/#/room/${room}`);
  await expect(page.getByTestId('room-learning-goal')).toHaveText('Describe each module in a request.');
  await expect(page.getByTestId('room-resume')).toHaveText('Continue side question');
  await page.getByTestId('room-resume').click();
  await expect(page).toHaveURL(branchUrl);
});

test('Board groups notes, focuses links, nests cards, and keeps bounded sizes', async ({ page, request }) => {
  const { notebooks: [notebook] } = await (await request.get('/api/notebooks')).json();
  const [room, parent, child, other] = [ulidish(), ulidish(), ulidish(), ulidish()];
  const items = [
    { kind: 'note', id: parent, title: 'AI architecture overview' },
    { kind: 'note', id: child, title: 'RAG request flow' },
    { kind: 'note', id: other, title: 'Quality checklist' },
  ];
  for (const { id, title } of items) {
    expect((await request.post(`/api/notebooks/${notebook.id}/notes`, { headers, data: { id, title } })).ok()).toBe(true);
  }
  expect((await request.post(`/api/notebooks/${notebook.id}/rooms`, {
    headers, data: { id: room, title: 'Architecture notes', items: items.map(({ kind, id }) => ({ kind, id })) },
  })).ok()).toBe(true);
  createdRooms.push(room);
  const link = ulidish();
  expect((await request.post(`/api/notebooks/${notebook.id}/links`, {
    headers, data: { id: link, from: { kind: 'note', id: child }, to: { kind: 'note', id: other }, kind: 'explains' },
  })).ok()).toBe(true);
  expect((await request.post(`/api/notebooks/${notebook.id}/links`, {
    headers, data: { id: ulidish(), from: { kind: 'note', id: parent }, to: { kind: 'note', id: other }, kind: 'related' },
  })).ok()).toBe(true);
  const [topic, concept] = [ulidish(), ulidish()];
  for (const data of [
    { id: topic, title: 'Model and data', items: [] },
    { id: concept, title: 'Retrieval', items: [{ kind: 'note', id: child }] },
  ]) {
    expect((await request.post(`/api/rooms/${room}/concepts`, { headers, data })).ok()).toBe(true);
  }
  expect((await request.post(`/api/concepts/${concept}/under`, { headers, data: { parent: topic, how: 'in' } })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/#/room/${room}`);
  await page.getByTestId('room-overview').getByRole('button', { name: 'Model and data' }).click();
  await expect(page.getByTestId('room-board-topic')).toHaveText(['Model and data', 'Ungrouped']);
  const card = (id: string) => page.locator(`[data-testid=room-card][data-id="${id}"]`);
  await expect(page.getByTestId('item-line')).toHaveCount(0);
  await card(child).getByTestId('room-focus-card').click();
  await expect(page.getByTestId('item-line')).toHaveCount(1);
  await page.getByTestId('room-board-all-links').click();
  await expect(page.getByTestId('item-line')).toHaveCount(2);
  await page.getByTestId('room-board-all-links').click();

  await card(child).getByTestId('room-card-open').click({ button: 'right' });
  await page.getByTestId('room-nest-start').click();
  await card(parent).getByTestId('room-card-open').click();
  const contained = page.getByTestId('room-contained');
  await expect(contained.getByTestId('room-card')).toHaveAttribute('data-id', child);
  await page.getByTestId('room-nest-toggle').click();
  await expect(card(child)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('room-nest-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('room-nest-toggle').click();
  await expect(contained.getByTestId('room-card')).toHaveAttribute('data-id', child);
  await card(child).getByTestId('room-card-open').click({ button: 'right' });
  await page.getByTestId('room-nest-remove').click();
  await expect(contained).toHaveCount(0);
  await expect(card(child)).toBeVisible();

  await page.getByTestId('room-board-free').click();
  const cluster = page.locator(`[data-testid=room-cluster][data-key="note:${parent}"]`);
  const before = await cluster.boundingBox();
  await dragBy(page, cluster.getByTestId('room-move-handle'), 45, 32);
  const after = await cluster.boundingBox();
  expect(Math.round((after?.x ?? 0) - (before?.x ?? 0))).toBe(45);
  await dragBy(page, cluster.getByTestId('room-resize-handle'), 610, 450);
  await expect(card(parent)).toHaveCSS('height', '440px');
  await expect(cluster).toHaveCSS('width', '520px');
  await page.reload();
  await expect(cluster).toHaveCSS('width', '520px');
  await dragBy(page, cluster.getByTestId('room-resize-handle'), -305, -370);
  await expect(cluster).toHaveCSS('width', '220px');
  await expect(card(parent)).toHaveCSS('height', '84px');
});

test('a freshly made room highlights the existing picker once', async ({ page, request }) => {
  const { notebooks: [notebook] } = await (await request.get('/api/notebooks')).json();
  const note = ulidish();
  await request.post(`/api/notebooks/${notebook.id}/notes`, { headers, data: { id: note, title: 'Material to add' } });
  await page.goto('/');
  await page.getByTestId('rail-rooms').click();
  await page.getByTestId('new-room').click();
  await page.getByTestId('new-room-title').fill('New study room');
  await page.getByTestId('new-room-make').click();
  const prompt = page.getByTestId('room-picker-welcome');
  await expect(prompt.getByTestId('room-pick')).toBeVisible();
  const room = page.url().split('/').at(-1);
  if (room) createdRooms.push(room);
  await prompt.getByTestId('room-pick').click();
  await expect(prompt).toHaveCount(0);
  await page.locator(`[data-testid=room-picker-row][data-id="${note}"] input`).check();
  await page.getByTestId('room-pick').click();
  await page.reload();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('room-pick')).toBeVisible();
});

test('dropping a material on another card asks before nesting and preserves their link', async ({ page, request }) => {
  const { notebooks: [notebook] } = await (await request.get('/api/notebooks')).json();
  const [room, source, note, thread, link] = [ulidish(), ulidish(), ulidish(), ulidish(), ulidish()];
  await request.post(`/api/notebooks/${notebook.id}/sources`, { headers, data: { id: source, title: 'Reading', text: 'A reference passage.' } });
  await request.post(`/api/notebooks/${notebook.id}/notes`, { headers, data: { id: note, title: 'Working notes' } });
  await request.post(`/api/notebooks/${notebook.id}/threads`, { headers, data: { id: thread, title: 'Reading questions' } });
  const items = [{ kind: 'source', id: source }, { kind: 'note', id: note }, { kind: 'thread', id: thread }];
  expect((await request.post(`/api/notebooks/${notebook.id}/rooms`, {
    headers, data: { id: room, title: 'Mixed cards', items },
  })).ok()).toBe(true);
  createdRooms.push(room);
  await request.post(`/api/notebooks/${notebook.id}/links`, {
    headers, data: { id: link, from: items[0], to: items[2], kind: 'explains' },
  });
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.goto(`/#/room/${room}`);
  await page.getByTestId('room-mode-board').click();
  const card = (id: string) => page.locator(`[data-testid=room-card][data-id="${id}"]`);
  const nest = async (from: string, to: string) => {
    const handle = card(from).getByTestId('room-move-handle');
    const grip = await handle.boundingBox();
    const target = await card(to).boundingBox();
    if (!grip || !target) throw new Error('A card is missing from the Board.');
    await dragBy(page, handle, target.x + target.width / 2 - grip.x - grip.width / 2, target.y + target.height / 2 - grip.y - grip.height / 2);
  };
  const dialog = page.getByTestId('room-nest-dialog');
  await nest(source, thread);
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('room-contained')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('room-contained')).toHaveCount(0);
  await nest(source, thread);
  await dialog.getByRole('button', { name: 'Place inside' }).click();
  await expect(page.getByTestId('room-contained').locator(card(source))).toBeVisible();
  await nest(note, thread);
  await dialog.getByRole('button', { name: 'Place inside' }).click();
  await expect(page.getByTestId('room-contained').getByTestId('room-card')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('room-contained').getByTestId('room-card')).toHaveCount(2);
  for (const child of [source, note]) {
    await card(child).getByTestId('room-card-open').click({ button: 'right' });
    await page.getByTestId('room-nest-remove').click();
  }
  await nest(thread, source);
  await dialog.getByRole('button', { name: 'Place inside' }).click();
  await expect(page.getByTestId('room-contained').locator(card(thread))).toBeVisible();
  const relation = await (await request.get(`/api/links/${link}`)).json();
  expect(relation.kind).toBe('explains');
  const stored = await (await request.get(`/api/rooms/${room}`)).json();
  expect(stored.itemLinks).toHaveLength(1);
});

// fixme: the one-column concepts page is much taller than the three-lane one, and Chromium drops a native
// drag once the page scrolls far beneath it. The feature stays; this scenario needs a drag that survives it.
test.fixme('a material dragged from the bottom auto-scrolls to a concept at the top', async ({ page, request }) => {
  const { notebooks: [notebook] } = await (await request.get('/api/notebooks')).json();
  const [room, note, target] = [ulidish(), ulidish(), ulidish()];
  await request.post(`/api/notebooks/${notebook.id}/notes`, { headers, data: { id: note, title: 'Unfiled reading' } });
  expect((await request.post(`/api/notebooks/${notebook.id}/rooms`, {
    headers, data: { id: room, title: 'Long concept page', items: [{ kind: 'note', id: note }] },
  })).ok()).toBe(true);
  createdRooms.push(room);
  for (let i = 0; i < 10; i++) {
    expect((await request.post(`/api/rooms/${room}/concepts`, {
      headers, data: { id: i === 0 ? target : ulidish(), title: `Concept ${i}`, items: [] },
    })).ok()).toBe(true);
  }
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.goto(`/#/room/${room}`);
  await page.getByTestId('room-mode-concepts').click();
  const tray = page.getByTestId('tray-item').filter({ hasText: 'Unfiled reading' });
  await tray.scrollIntoViewIfNeeded();
  const from = await tray.boundingBox();
  if (!from) throw new Error('The material is missing.');
  const startingY = await page.evaluate(() => window.scrollY);
  expect(startingY).toBeGreaterThan(160);
  await page.mouse.move(from.x + 12, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 16, 300, { steps: 8 });
  const beforeWheel = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: -65, cancelable: true })));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(beforeWheel);
  await page.mouse.move(from.x + 16, 85, { steps: 16 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(startingY - 150);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(30);
  // The last scroll frame moves the target too; let the layout settle before measuring it.
  await page.waitForTimeout(200);
  const concept = page.locator(`[data-concept-id="${target}"]`);
  await concept.scrollIntoViewIfNeeded();
  const to = await concept.boundingBox();
  if (!to) throw new Error('The destination concept is missing.');
  await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 10 });
  await page.mouse.move(to.x + 20, to.y + to.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await expect(tray).toHaveCount(0);
});
