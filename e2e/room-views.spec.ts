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

async function sources(request: APIRequestContext, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const t of titles) ids.push(await source(request, t));
  return ids;
}

test('Concepts: read with AI, the key ideas are suggested, each defined by your own words; kept, dismissed, filled from the tray; in Folders and Path too', async ({
  page,
  request,
}) => {
  const ids = await sources(request, ['Moss blanket', 'Winter den', 'Glowfin fur', 'Ice fishing']);
  const big = await room(
    request,
    'Glowfin winters',
    ids.map((id) => ({ kind: 'source', id })),
  );
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await expect(page.getByTestId('concepts-empty')).toContainText('What is this room about?');
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts from your 4 things · 3 suggested');
  await expect(nodes.first()).toHaveAttribute('data-status', 'suggested');
  // Laid out by what comes first: the second builds on the first; the third stands beside the second.
  await expect(page.getByTestId('concepts-lane').nth(0).getByTestId('concept-node')).toHaveText([/Fake concept 1/]);
  await expect(page.getByTestId('concepts-lane').nth(1).getByTestId('concept-node')).toHaveText([/Fake concept 2/, /Fake concept 3/]);
  await expect(page.getByTestId('concept-line-label')).toHaveText(['builds on', 'contrasts']);
  // Nothing lost: the last thing is in the tray.
  await expect(page.getByTestId('tray-item')).toHaveText([/Ice fishing/]);

  // The first concept: defined by the words of a source, which open where they are.
  await nodes.first().click();
  const drawer = page.getByTestId('concept-drawer');
  await expect(drawer.getByTestId('concept-rename')).toContainText('Fake concept 1');
  await expect(drawer.getByTestId('concept-quote')).toContainText('“Moss blanket”');
  await expect(drawer.getByTestId('concept-thing')).toHaveText([/Moss blanket/, /Winter den/]);

  // Not this: gone. Keep all: the rest are kept.
  await nodes.filter({ hasText: 'Fake concept 3' }).getByTestId('concept-not-this').click();
  await expect(nodes).toHaveCount(2);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('2 concepts from your 4 things');
  await expect(nodes.first()).toHaveAttribute('data-status', 'kept');

  // From the tray onto a concept.
  await drag(page, page.getByTestId('tray-item').first(), nodes.filter({ hasText: 'Fake concept 2' }));
  await expect(page.getByTestId('concepts-status')).toContainText('“Ice fishing” is under “Fake concept 2” now.');
  await expect(page.getByTestId('tray-item')).toHaveCount(0);
  await expect(page.getByTestId('room-meta')).toContainText('2 concepts');

  // Read again: kept stay, the dismissed one is not suggested again.
  await page.getByTestId('concepts-read').click();
  await expect(page.getByTestId('concepts-read')).toHaveText(/Read again/);
  await expect(nodes.filter({ hasText: 'Fake concept 3' })).toHaveCount(0);
  await expect(nodes.filter({ hasText: 'Fake concept 1' })).toHaveAttribute('data-status', 'kept');

  // Folders: kept concepts are folders of their things.
  await page.getByTestId('room-mode-folders').click();
  const conceptRow = page.locator('[data-testid=folder-row][data-key^="concept:"]').filter({ hasText: 'Fake concept 2' });
  await expect(conceptRow).toContainText('Concept · 2');
  await conceptRow.getByTestId('folder-toggle').click();
  await expect(page.locator('[data-testid=folder-row][data-depth="1"] .folders-title')).toHaveText(['Glowfin fur', 'Ice fishing']);
  // Opened: shown in Concepts.
  await conceptRow.dblclick();
  await expect(page.getByTestId('room-mode-concepts')).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer.getByTestId('concept-rename')).toContainText('Fake concept 2');

  // Path: concept by concept.
  await page.getByTestId('room-mode-path').click();
  await expect(page.getByTestId('path-step').locator('.path-title')).toHaveText([/Fake concept 1/, /Fake concept 2/]);
  await expect(page.getByTestId('path-step').nth(1).getByTestId('path-after')).toHaveText('builds on 1');
  await expect(page.getByTestId('path-step').nth(1).getByTestId('path-thing')).toHaveText([/Glowfin fur/, /Ice fishing/]);
});

test('a concept is split, merged back, linked by hand, asked about, and made a room of its own', async ({ page, request }) => {
  const ids = await sources(request, ['Moss blanket', 'Winter den', 'Glowfin fur']);
  const big = await room(
    request,
    'Glowfin homes',
    ids.map((id) => ({ kind: 'source', id })),
  );
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts from your 3 things');
  const drawer = page.getByTestId('concept-drawer');

  // Split: "Winter den" to a new concept.
  await nodes.filter({ hasText: 'Fake concept 1' }).click();
  await drawer.getByTestId('concept-split').click();
  await drawer.getByTestId('concept-split-pick').nth(1).check();
  await drawer.getByTestId('concept-split-title').fill('Dens');
  await drawer.getByTestId('concept-split-save').click();
  await expect(nodes).toHaveCount(4);
  await expect(drawer.getByTestId('concept-rename')).toContainText('Dens');
  await expect(drawer.getByTestId('concept-thing')).toHaveText([/Winter den/]);
  await expect(nodes.filter({ hasText: 'Fake concept 1' })).toContainText('1');

  // Linked by hand: Dens builds on Fake concept 1.
  await drawer.getByTestId('concept-link-to').click();
  await drawer.getByTestId('concept-link-kind').selectOption('builds-on');
  await drawer.getByTestId('concept-link-other').selectOption({ label: 'Fake concept 1' });
  await drawer.getByTestId('concept-link-save').click();
  await expect(drawer.getByTestId('concept-link')).toContainText('builds on “Fake concept 1”');

  // Merged back.
  await drawer.getByTestId('concept-merge').click();
  await drawer.getByTestId('concept-merge-into').filter({ hasText: 'Fake concept 1' }).click();
  await expect(nodes).toHaveCount(3);
  await expect(drawer.getByTestId('concept-rename')).toContainText('Fake concept 1');
  await expect(drawer.getByTestId('concept-thing')).toHaveText([/Moss blanket/, /Winter den/]);

  // Asked about: the question waits in the bar at the foot, to finish and send.
  await drawer.getByTestId('concept-ask').click();
  await expect(page.getByTestId('room-ask')).toHaveValue('About “Fake concept 1”: ');
  await expect(page.getByTestId('room-ask')).toBeFocused();

  // Made a room: a room inside now, in the sidebar's list.
  await nodes.filter({ hasText: 'Fake concept 3' }).click();
  await drawer.getByTestId('concept-to-room').click();
  await expect(nodes).toHaveCount(2);
  await page.getByTestId('room-mode-folders').click();
  await expect(page.locator('[data-testid=folder-row][data-key^="room:"]')).toHaveText([/Fake concept 3/]);
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  expect(rooms.map((r: { title: string }) => r.title).sort()).toEqual(['Fake concept 3', 'Glowfin homes']);
});
