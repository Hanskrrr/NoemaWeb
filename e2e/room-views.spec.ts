import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { freshThread, ulidish } from './helpers.ts';

// Ways to see a room (ADR 0035): Folders, as Finder lists a folder (rooms
// inside are folders that open in place, things are files, a thing in two
// rooms says where else), and the Board; each room opens in the way it was last
// seen. Made-up text only.

const H = { 'x-noema-client': 'web' };

async function notebookId(request: APIRequestContext): Promise<string> {
  return (await (await request.get('/api/notebooks')).json()).notebooks[0].id;
}
async function source(request: APIRequestContext, title: string): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/sources`, {
    data: { id, title, text: `# ${title}\n\nActivations are kept for the backward pass.` },
    headers: H,
  });
  return id;
}
async function note(request: APIRequestContext, title: string): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/notes`, { data: { id, title }, headers: H });
  return id;
}
async function thread(request: APIRequestContext, title: string): Promise<string> {
  const id = await freshThread(request);
  await request.patch(`/api/threads/${id}`, { data: { title }, headers: H });
  return id;
}
async function room(request: APIRequestContext, title: string, items: Array<{ kind: string; id: string }>): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/rooms`, { data: { id, title, items }, headers: H });
  return id;
}
async function members(request: APIRequestContext, id: string): Promise<string[]> {
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  return rooms.find((r: { id: string }) => r.id === id)?.members ?? [];
}
const row = (page: Page, title: string) => page.getByTestId('folder-row').filter({ hasText: title });
const folder = (page: Page, title: string) => page.locator('[data-testid=folder-row][data-key^="room:"]').filter({ hasText: title });
async function drag(page: Page, from: Locator, to: Locator, alt = false): Promise<void> {
  await from.hover();
  await page.mouse.down();
  await to.hover({ position: { x: 30, y: 8 } });
  await to.hover({ position: { x: 40, y: 10 } });
  if (alt) await page.keyboard.down('Alt');
  await to.hover({ position: { x: 50, y: 10 } });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test.afterEach(async ({ request }) => {
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  for (const r of rooms) await request.delete(`/api/rooms/${r.id}`, { headers: H });
});

test('a room opens in Folders: a room inside opens in place, a thing in two rooms says where else, the preview, sorting; each room keeps its view', async ({
  page,
  request,
}) => {
  const slides = await source(request, 'Week 4 slides');
  const notes = await note(request, 'Activation notes');
  const trade = await thread(request, 'What does checkpointing trade?');
  const adam = await note(request, 'Adam notes');
  const big = await room(request, 'ML systems', [
    { kind: 'source', id: slides },
    { kind: 'note', id: notes },
    { kind: 'thread', id: trade },
  ]);
  const inner = await room(request, 'Optimization', [
    { kind: 'thread', id: trade },
    { kind: 'note', id: adam },
  ]);
  await request.post(`/api/rooms/${big}/rooms`, { data: { room: inner }, headers: H });

  await page.goto(`/#/room/${big}`);
  await expect(page.getByTestId('room-mode-folders')).toHaveAttribute('aria-pressed', 'true');
  const rows = page.getByTestId('folder-row');
  // The room inside first, as a folder; then the things by name.
  await expect(rows.locator('.folders-title')).toHaveText(['Optimization', 'Activation notes', 'Week 4 slides', 'What does checkpointing trade?']);
  await expect(folder(page, 'Optimization')).toHaveAttribute('aria-expanded', 'false');
  // Kept in two rooms: ↗, and where else.
  await expect(row(page, 'What does checkpointing trade?').getByTestId('folder-alias')).toBeVisible();
  await expect(row(page, 'What does checkpointing trade?').getByTestId('folder-also')).toContainText('also in Optimization');
  await expect(row(page, 'Activation notes').getByTestId('folder-alias')).toHaveCount(0);

  // The preview: what it is and where it lives.
  await row(page, 'What does checkpointing trade?').click();
  await expect(page.getByTestId('folder-preview-title')).toHaveText('What does checkpointing trade?');
  await expect(page.getByTestId('folder-preview-homes')).toContainText('ML systems');
  await expect(page.getByTestId('folder-preview-homes')).toContainText('Optimization');

  // The room inside opens in place, one level in.
  await folder(page, 'Optimization').getByTestId('folder-toggle').click();
  await expect(folder(page, 'Optimization')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-testid=folder-row][data-depth="1"] .folders-title')).toHaveText(['Adam notes', 'What does checkpointing trade?']);
  await expect(page.locator('[data-testid=folder-row][data-depth="1"]').filter({ hasText: 'checkpointing' }).getByTestId('folder-also')).toContainText(
    'also in ML systems',
  );

  // Sorted the other way: folders stay on top.
  await page.getByTestId('folders-sort-name').click();
  await expect(page.locator('[data-testid=folder-row][data-depth="0"] .folders-title')).toHaveText([
    'Optimization',
    'What does checkpointing trade?',
    'Week 4 slides',
    'Activation notes',
  ]);

  // The keyboard: down a row, Enter opens it.
  await row(page, 'Week 4 slides').click();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'Activation notes')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note')).toBeVisible();
  await expect(page.getByTestId('note-rename')).toContainText('Activation notes');

  // The Board, remembered for this room after a reload; a room not seen yet opens in the way last chosen.
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-board').click();
  await expect(page.getByTestId('room-canvas')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('room-canvas')).toBeVisible();
  await expect(page.getByTestId('room-mode-board')).toHaveAttribute('aria-pressed', 'true');
  await page.goto(`/#/room/${inner}`);
  await expect(page.getByTestId('room-rename')).toContainText('Optimization');
  await expect(page.getByTestId('room-mode-board')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('room-mode-folders').click();
  await expect(page.getByTestId('room-folders')).toBeVisible();
  await page.goto(`/#/room/${big}`);
  await expect(page.getByTestId('room-rename')).toContainText('ML systems');
  await expect(page.getByTestId('room-canvas')).toBeVisible();
});

test('in Folders, a row dragged onto a folder moves there; with ⌥ it stays here too; right-click takes it out of the room it is listed in', async ({
  page,
  request,
}) => {
  const slides = await source(request, 'Week 4 slides');
  const notes = await note(request, 'Activation notes');
  const big = await room(request, 'ML systems', [
    { kind: 'source', id: slides },
    { kind: 'note', id: notes },
  ]);
  const inner = await room(request, 'Optimization', []);
  await request.post(`/api/rooms/${big}/rooms`, { data: { room: inner }, headers: H });
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-folders').click();
  await expect(folder(page, 'Optimization')).toBeVisible();

  // Moved: out of this room, into that one.
  await drag(page, row(page, 'Activation notes'), folder(page, 'Optimization'));
  await expect(page.getByTestId('folders-status')).toContainText('“Activation notes” is in “Optimization” now.');
  await expect(page.locator('[data-testid=folder-row][data-depth="0"]').filter({ hasText: 'Activation notes' })).toHaveCount(0);
  expect(await members(request, inner)).toEqual([`note:${notes}`]);
  expect(await members(request, big)).toEqual([`source:${slides}`]);

  // With ⌥: kept in both.
  await drag(page, row(page, 'Week 4 slides'), folder(page, 'Optimization'), true);
  await expect(page.getByTestId('folders-status')).toContainText('and still in “ML systems”');
  await expect(row(page, 'Week 4 slides').first().getByTestId('folder-also')).toContainText('also in Optimization');
  expect((await members(request, inner)).sort()).toEqual([`note:${notes}`, `source:${slides}`].sort());

  // Right-click, in the room opened in place: taken out of that room, not this one.
  await folder(page, 'Optimization').getByTestId('folder-toggle').click();
  const innerSlides = page.locator('[data-testid=folder-row][data-depth="1"]').filter({ hasText: 'Week 4 slides' });
  await innerSlides.click({ button: 'right' });
  await page.getByTestId('menu-take-out').click();
  await expect(innerSlides).toHaveCount(0);
  expect(await members(request, inner)).toEqual([`note:${notes}`]);
  expect(await members(request, big)).toEqual([`source:${slides}`]);
});

test('Path: the order to study a room in, from the links kept; side by side what contrasts; what no link orders waits at the end', async ({
  page,
  request,
}) => {
  const back = await thread(request, 'Why are activations saved?');
  const trade = await thread(request, 'What does checkpointing trade?');
  const fp = await thread(request, 'fp16 vs bf16');
  const syllabus = await source(request, 'Course syllabus');
  const big = await room(request, 'ML systems', [
    { kind: 'thread', id: back },
    { kind: 'thread', id: trade },
    { kind: 'thread', id: fp },
    { kind: 'source', id: syllabus },
  ]);
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-path').click();
  // Nothing kept yet: no order, and it says how one comes.
  await expect(page.getByTestId('path-empty')).toContainText('The path is made from the links you keep');

  const nb = await notebookId(request);
  const link = (from: string, kind: string, to: string) =>
    request.post(`/api/notebooks/${nb}/links`, { data: { id: ulidish(), from: { kind: 'thread', id: from }, to: { kind: 'thread', id: to }, kind }, headers: H });
  await link(trade, 'builds-on', back);
  await link(fp, 'contrasts-with', trade);
  await page.reload();
  const steps = page.getByTestId('path-step');
  await expect(steps.locator('.path-title')).toHaveText([/Why are activations saved\?/, /What does checkpointing trade\?/, /fp16 vs bf16/]);
  await expect(steps.nth(0).getByTestId('path-after')).toHaveText('start here');
  await expect(steps.nth(1).getByTestId('path-after')).toHaveText('builds on 1');
  await expect(steps.nth(2)).toHaveClass(/is-beside/);
  await expect(steps.nth(2).getByTestId('path-after')).toHaveText('beside 2: another way');
  await expect(page.getByTestId('path-loose')).toContainText('Course syllabus');
  // Remembered; a step opens its thing.
  await page.reload();
  await expect(page.getByTestId('room-mode-path')).toHaveAttribute('aria-pressed', 'true');
  await steps.nth(1).getByTestId('path-open').click();
  await expect(page).toHaveURL(new RegExp(`#/t/${trade}`));
  await expect(page.getByTestId('rename')).toContainText('What does checkpointing trade?');
});
