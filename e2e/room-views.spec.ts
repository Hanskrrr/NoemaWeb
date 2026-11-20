import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { freshThread, highlighted, ulidish } from './helpers.ts';

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

/** A concept on the map, by its name (not by words in its card). */
function named(page: Page, name: string): Locator {
  return page.getByTestId('concept-node').filter({ has: page.locator('.concept-name', { hasText: new RegExp(`^\\W*${name}$`) }) });
}
/** A source with its own words; the fake model reads each **bold** phrase as a concept (ADR 0037). */
async function written(request: APIRequestContext, title: string, text: string): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/sources`, { data: { id, title, text: `# ${title}\n\n${text}` }, headers: H });
  return id;
}
/** A question asked in a thread, and its answer waited for. */
async function asked(request: APIRequestContext, threadId: string, question: string): Promise<void> {
  const r = await (await request.post(`/api/threads/${threadId}/messages`, { data: { id: ulidish(), content: question }, headers: H })).json();
  await request.get(`/api/messages/${r.assistant.id}/events`, { headers: H });
}

test('Concepts: every piece of every thing is read for the ideas it discusses, joined across things; kept, dismissed, filled from the tray; in Folders and Path too', async ({
  page,
  request,
}) => {
  const moss = await written(request, 'Moss blanket', '**Moss blanket** is the winter cover of a glowfin. It keeps **body heat** in. A **moss blanket** is shaken out in spring.');
  const den = await written(request, 'Winter den', '**Winter den** is a hole dug under the roots. The **moss blanket** (MB) lines it. Each **winter den** has one door.');
  const fur = await written(request, 'Glowfin fur', '**Body heat** is kept by the fur. Thick fur works like a **winter den** for one. A **moss blanket** is warmer still.');
  const ice = await written(request, 'Ice fishing', 'Glowfins fish through holes in the ice.');
  const big = await room(
    request,
    'Glowfin winters',
    [moss, den, fur, ice].map((id) => ({ kind: 'source', id })),
  );
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await expect(page.getByTestId('concepts-empty')).toContainText('What is this room about?');
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts in your 4 things · 3 suggested');
  await expect(nodes.first()).toHaveAttribute('data-status', 'suggested');
  // Each where its things discuss it: the one in most of them first, then by what builds on what.
  await expect(named(page, 'moss blanket').getByTestId('concept-where')).toHaveText('in 3 materials · 4 places');
  await expect(named(page, 'winter den').getByTestId('concept-where')).toHaveText('in 2 materials · 3 places');
  await expect(page.getByTestId('concepts-lane').nth(0).getByTestId('concept-node')).toHaveText([/moss blanket/]);
  await expect(page.getByTestId('concept-line-label')).toHaveText(['builds on', 'contrasts']);
  // Nothing lost: what discusses none is in the tray.
  await expect(page.getByTestId('tray-item')).toHaveText([/Ice fishing/]);

  // A concept: named as the field does, with its other names; defined by the words of a source; where it is discussed.
  await named(page, 'moss blanket').click();
  const drawer = page.getByTestId('concept-drawer');
  await expect(drawer.getByTestId('concept-rename')).toContainText('moss blanket');
  await expect(drawer.getByTestId('concept-names')).toHaveText('Also called “MB”');
  await expect(drawer.getByTestId('concept-quote')).toContainText('“Moss blanket is the winter cover of a glowfin.”');
  await expect(drawer.getByTestId('concept-quote')).toContainText('your source “Moss blanket”');
  await expect(drawer.getByTestId('concept-source')).toHaveCount(3);
  const inDen = drawer.getByTestId('concept-source').filter({ has: page.locator('.concepts-thing-open', { hasText: /^\W*Winter den$/ }) });
  await expect(inDen.getByTestId('concept-place')).toHaveText([/uses it.*“The moss blanket \(MB\) lines it\.”/]);
  // It shares a thing with each of the others: they say so.
  await expect(named(page, 'body heat').getByTestId('concept-shares')).toHaveText('shares 2');
  await expect(inDen.getByTestId('also-under')).toContainText('winter den');

  // Not this: gone. Keep all: the rest are kept.
  await named(page, 'body heat').getByTestId('concept-not-this').click();
  await expect(nodes).toHaveCount(2);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('2 concepts in your 4 things');
  await expect(nodes.first()).toHaveAttribute('data-status', 'kept');
  await expect(page.getByTestId('tray-item')).toHaveText([/Ice fishing/]);

  // From the tray onto a concept.
  await drag(page, page.getByTestId('tray-item').filter({ hasText: 'Ice fishing' }), named(page, 'winter den'));
  await expect(page.getByTestId('concepts-status')).toContainText('“Ice fishing” is under “winter den” now.');
  await expect(page.getByTestId('room-meta')).toContainText('2 concepts');

  // Read again: nothing changed, so nothing is read; kept stay, the dismissed one is not suggested again.
  await expect(page.getByTestId('concepts-changed')).toHaveCount(0);
  await page.getByTestId('concepts-read').click();
  await expect(page.getByTestId('concepts-read')).toHaveText(/Read again/);
  await expect(named(page, 'body heat')).toHaveCount(0);
  await expect(named(page, 'moss blanket')).toHaveAttribute('data-status', 'kept');

  // Folders: kept concepts are folders of their things; a thing under two says so.
  await page.getByTestId('room-mode-folders').click();
  const conceptRow = page.locator('[data-testid=folder-row][data-key^="concept:"]').filter({ hasText: 'winter den' });
  await expect(conceptRow).toContainText('Concept · 3');
  await conceptRow.getByTestId('folder-toggle').click();
  await expect(page.locator('[data-testid=folder-row][data-depth="1"] .folders-title')).toHaveText(['Glowfin fur', 'Ice fishing', 'Winter den']);
  await expect(page.locator('[data-testid=folder-row][data-depth="1"]').filter({ hasText: 'Winter den' }).getByTestId('folder-also-under')).toContainText('moss blanket');
  // Opened: shown in Concepts.
  await conceptRow.dblclick();
  await expect(page.getByTestId('room-mode-concepts')).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer.getByTestId('concept-rename')).toContainText('winter den');

  // Path: concept by concept; a thing on two steps says where else.
  await page.getByTestId('room-mode-path').click();
  await expect(page.getByTestId('path-step').locator('.path-title')).toHaveCount(2);
  await expect(page.getByTestId('path-thing').filter({ hasText: 'Winter den' }).first()).toContainText(/also \d/);
});

test('a concept is split, merged back, linked by hand, asked about, and made a room of its own', async ({ page, request }) => {
  const raft = await written(request, 'Reed raft', '**Reed raft** is a mat the otters float on. It drifts near the **tide pool**.');
  const pool = await written(request, 'Tide pool', '**Tide pool** is water left by the sea. Salt dries into a **salt crust** there.');
  const crust = await written(request, 'Salt crust', '**Salt crust** is the white rim on the rocks. Otters lick it from the **reed raft**.');
  const big = await room(
    request,
    'Otter shores',
    [raft, pool, crust].map((id) => ({ kind: 'source', id })),
  );
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts in your 3 things');
  const drawer = page.getByTestId('concept-drawer');

  // Split: "Salt crust" to a new concept; the words stay with the thing.
  await named(page, 'reed raft').click();
  await expect(drawer.getByTestId('concept-source')).toHaveText([/Reed raft/, /Salt crust/]);
  await drawer.getByTestId('concept-split').click();
  await drawer.getByTestId('concept-split-pick').nth(1).check();
  await drawer.getByTestId('concept-split-title').fill('Licking spots');
  await drawer.getByTestId('concept-split-save').click();
  await expect(nodes).toHaveCount(4);
  await expect(drawer.getByTestId('concept-rename')).toContainText('Licking spots');
  await expect(drawer.getByTestId('concept-source')).toHaveText([/Salt crust/]);
  await expect(drawer.getByTestId('concept-place')).toHaveText([/“Otters lick it from the reed raft\.”/]);
  await expect(named(page, 'reed raft').getByTestId('concept-where')).toHaveText('in 1 material · 1 place');

  // Linked by hand: Licking spots builds on reed raft.
  await drawer.getByTestId('concept-link-to').click();
  await drawer.getByTestId('concept-link-kind').selectOption('builds-on');
  await drawer.getByTestId('concept-link-other').selectOption({ label: 'reed raft' });
  await drawer.getByTestId('concept-link-save').click();
  await expect(drawer.getByTestId('concept-link')).toContainText('builds on “reed raft”');

  // Merged back: its name stays as another name.
  await drawer.getByTestId('concept-merge').click();
  await drawer.getByTestId('concept-merge-into').filter({ hasText: 'reed raft' }).click();
  await expect(nodes).toHaveCount(3);
  await expect(drawer.getByTestId('concept-rename')).toContainText('reed raft');
  await expect(drawer.getByTestId('concept-source')).toHaveText([/Reed raft/, /Salt crust/]);
  await expect(drawer.getByTestId('concept-names')).toContainText('Licking spots');

  // Asked about: the question waits in the bar at the foot, to finish and send.
  await drawer.getByTestId('concept-ask').click();
  await expect(page.getByTestId('room-ask')).toHaveValue('About “reed raft”: ');
  await expect(page.getByTestId('room-ask')).toBeFocused();

  // Made a room: a room inside now, in the sidebar's list; no longer a concept anywhere.
  await named(page, 'salt crust').click();
  await drawer.getByTestId('concept-to-room').click();
  await expect(nodes).toHaveCount(2);
  await page.getByTestId('room-mode-folders').click();
  await expect(page.locator('[data-testid=folder-row][data-key^="room:"]')).toHaveText([/salt crust/]);
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  expect(rooms.map((r: { title: string }) => r.title).sort()).toEqual(['Otter shores', 'salt crust']);
  const { concepts } = await (await request.get(`/api/notebooks/${await notebookId(request)}/concepts`)).json();
  expect(concepts.map((c: { title: string }) => c.title)).not.toContain('salt crust');
});

test('a thing that changes is read again, only what changed; its concepts show from its side, and words are put under one by hand', async ({
  page,
  request,
}) => {
  const lantern = await written(request, 'Lantern moss', '**Lantern moss** is a moss that glows at night. It grows on old stones.');
  const thread = await freshThread(request);
  await asked(request, thread, 'Why does **lantern moss** glow?');
  const big = await room(request, 'Night garden', [
    { kind: 'source', id: lantern },
    { kind: 'thread', id: thread },
  ]);
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(1);
  await page.getByTestId('concepts-keep-all').click();
  // The source defines it; the thread asks, and its answer uses it.
  await expect(nodes.first().getByTestId('concept-where')).toHaveText('in 2 materials · 3 places');
  await expect(page.getByTestId('concepts-changed')).toHaveCount(0);

  // The thread grows: the room says so, and Update reads that thread again.
  await asked(request, thread, 'Where does **lantern moss** grow best?');
  await page.reload();
  await expect(page.getByTestId('concepts-changed')).toContainText('1 material changed since its concepts were read');
  await expect(page.getByTestId('concepts-read')).toHaveText(/Update/);
  await page.getByTestId('concepts-update').click();
  await expect(page.getByTestId('concepts-changed')).toHaveCount(0);
  // Its new question asks, its answer uses: the thread's three places at most for one concept (the skill's rule).
  await expect(nodes.first().getByTestId('concept-where')).toHaveText('in 2 materials · 4 places');
  await expect(nodes.first()).toHaveAttribute('data-status', 'kept');

  // From the source's side: its concepts under its title, each a click away from its words there.
  await page.goto(`/#/s/${lantern}`);
  const here = page.getByTestId('concepts-here-chip');
  await expect(here).toHaveText([/lantern moss · 1 place/]);
  await here.click();
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('is a moss that glows at night.');

  // Words put under it by hand: a place of its own, kept when the AI reads again.
  await page.getByTestId('source-text').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf('It grows on old stones.') ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 'It grows on old stones.'.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
        return;
      }
    }
  });
  await page.getByTestId('under-concept').click();
  await page.getByTestId('concept-picker-find').fill('lantern');
  await page.getByTestId('concept-picker-item').filter({ hasText: 'lantern moss' }).click();
  await expect(page.getByTestId('room-notice')).toHaveText('Put under lantern moss');
  await expect(here).toHaveText([/lantern moss · 2 places/]);
  // The list closes when you go somewhere else.
  await page.getByTestId('source-text').evaluate((root) => {
    const r = document.createRange();
    r.selectNodeContents(root.querySelector('p') as Element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
  });
  await page.getByTestId('under-concept').click();
  await expect(page.getByTestId('concept-picker')).toBeVisible();
  await page.evaluate((id) => {
    window.location.hash = `#/room/${id}`;
  }, big);
  await expect(page.getByTestId('room')).toBeVisible();
  await expect(page.getByTestId('concept-picker')).toHaveCount(0);

  await nodes.first().click();
  const yours = page.getByTestId('concept-drawer').getByTestId('concept-place').filter({ hasText: 'you put it here' });
  await expect(yours).toContainText('“It grows on old stones.”');
  await page.getByTestId('concepts-read').click();
  await expect(page.getByTestId('concepts-read')).toHaveText(/Read again/);
  await expect(yours).toHaveCount(1);
});
