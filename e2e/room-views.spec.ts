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

/** A concept's card, by its name (not by words elsewhere in it). */
function node(page: Page, name: string): Locator {
  return page.getByTestId('concept-node').filter({ has: page.locator('.concept-name', { hasText: new RegExp(`^\\W*${name}$`) }) });
}
/** A topic's heading, by its name. */
function topic(page: Page, name: string): Locator {
  return page.getByTestId('concepts-topic').filter({ has: page.locator('.concepts-topic-name', { hasText: new RegExp(`^\\W*${name}$`) }) });
}
/** The cards under a topic's heading (or under "In no topic"). */
function inTopic(page: Page, name: string): Locator {
  return page.getByTestId('concepts-section').filter({ has: topic(page, name) }).getByTestId('concept-node');
}
/** A concept chosen: a click on its card. */
async function pick(page: Page, name: string): Promise<void> {
  await node(page, name).click();
}
/** A source with its own words. Sources are not read for concepts (ADR 0038); their words are found by search. */
async function written(request: APIRequestContext, title: string, text: string): Promise<string> {
  const id = ulidish();
  await request.post(`/api/notebooks/${await notebookId(request)}/sources`, { data: { id, title, text: `# ${title}\n\n${text}` }, headers: H });
  return id;
}
/** A note with these blocks. The fake model reads each **bold** phrase as a concept (ADR 0037). */
async function noteWith(request: APIRequestContext, title: string, ...blocks: string[]): Promise<string> {
  const id = await note(request, title);
  let after: string | null = null;
  for (const content of blocks) {
    const b = ulidish();
    await request.post(`/api/notes/${id}/blocks`, { data: { id: b, after, content }, headers: H });
    after = b;
  }
  return id;
}
/** A question asked in a thread, and its answer waited for. */
async function asked(request: APIRequestContext, threadId: string, question: string): Promise<void> {
  const r = await (await request.post(`/api/threads/${threadId}/messages`, { data: { id: ulidish(), content: question }, headers: H })).json();
  await request.get(`/api/messages/${r.assistant.id}/events`, { headers: H });
}
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);
/**
 * A glowfin room: two notes and a thread with concepts (a cover, a kind of it, a den), a note with none, a source
 * that is only searched. Concepts are the notebook's, across its rooms, so each test names its own.
 */
async function glowfins(
  request: APIRequestContext,
  { cover, kind, den, title }: { cover: string; kind: string; den: string; title: string },
): Promise<{ room: string; almanac: string }> {
  const moss = await noteWith(
    request,
    cap(cover),
    `**${cap(cover)}** is the winter cover of a glowfin. It keeps the warmth in.`,
    `**${cap(kind)}** is a kind of **${cover}** that is thinner.`,
  );
  const short = cover
    .split(' ')
    .map((w) => w[0]?.toUpperCase())
    .join('');
  const lair = await noteWith(request, cap(den), `**${cap(den)}** is a hole dug under the roots. The **${cover}** (${short}) lines it.`);
  const t = await freshThread(request);
  await asked(request, t, `Why does a **${den}** have one door?`);
  const ice = await noteWith(request, 'Ice fishing', 'Glowfins fish through holes in the ice.');
  const almanac = await written(request, 'Glowfin almanac', `A ${cover} is shaken out in spring.\n\nThe ${den} is dug in autumn.`);
  const r = await room(request, title, [
    { kind: 'note', id: moss },
    { kind: 'note', id: lair },
    { kind: 'thread', id: t },
    { kind: 'note', id: ice },
    { kind: 'source', id: almanac },
  ]);
  return { room: r, almanac };
}

test('Concepts: read from threads and notes only, in levels (a topic holds concepts, a kind of one inside it); reviewed beside the map; a concept says where your sources use its words', async ({
  page,
  request,
}) => {
  const { room: big, almanac } = await glowfins(request, { cover: 'moss blanket', kind: 'spring moss blanket', den: 'winter den', title: 'Glowfin winters' });
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await expect(page.getByTestId('concepts-empty')).toContainText('What is this room about?');
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  // Three concepts in a topic the AI suggests (its heading dashed until kept); a kind of one says so on its card.
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts in 1 topic · your 5 things · 4 to review');
  await expect(topic(page, 'Glowfin winters basics')).toHaveAttribute('data-status', 'suggested');
  await expect(inTopic(page, 'Glowfin winters basics')).toHaveCount(3);
  await expect(node(page, 'spring moss blanket').getByTestId('concept-under')).toHaveText('a kind of moss blanket · suggested');
  // In the topic, laid out by what comes first: a kind of a concept after it.
  await expect(page.getByTestId('concepts-lane').last().getByTestId('concept-node')).toContainText(['spring moss blanket']);
  const review = page.getByTestId('concepts-review');
  await expect(review.getByTestId('review-idea')).toHaveText([/winter den/, /^\W*moss blanket/, /spring moss blanket/, /Glowfin winters basics/]);
  await expect(review.getByTestId('review-idea').nth(2)).toContainText('a kind of moss blanket');
  await expect(review.getByTestId('review-idea').nth(0)).toContainText('1 question · 1 note · in 2 materials');
  // The source was not read: nothing of it is under a concept, so it waits in the tray, with the note on ice.
  await expect(page.getByTestId('tray-item')).toHaveCount(2);
  await expect(page.getByTestId('tray-item').filter({ hasText: 'Glowfin almanac' })).toHaveCount(1);

  // Not this: gone. The topic kept; then the rest.
  await review.getByTestId('review-idea').filter({ hasText: 'spring moss blanket' }).getByTestId('review-not-this').click();
  await expect(nodes).toHaveCount(2);
  await expect(page.getByTestId('concepts-bar')).toHaveText('2 concepts in 1 topic · your 5 things · 3 to review');
  await topic(page, 'Glowfin winters basics').getByTestId('topic-keep').click();
  await expect(topic(page, 'Glowfin winters basics')).toHaveAttribute('data-status', 'kept');
  await expect(review.getByTestId('review-idea')).toHaveCount(2);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('2 concepts in 1 topic · your 5 things');
  await expect(review).toContainText('Choose a concept to see');

  // A concept: where it is in the tree, your work on it, the words that define it, and where your sources use its words.
  await pick(page, 'moss blanket');
  const drawer = page.getByTestId('concept-drawer');
  await expect(drawer.getByTestId('concept-rename')).toContainText('moss blanket');
  await expect(drawer.getByTestId('concept-home')).toHaveText(/^In\W+Glowfin winters basics$/);
  await expect(drawer.getByTestId('concept-work')).toHaveText('Your work: 2 notes · in 2 materials');
  await expect(drawer.getByTestId('concept-quote')).toContainText('“Moss blanket is the winter cover of a glowfin.”');
  await expect(drawer.getByTestId('concept-quote')).toContainText('your note “Moss blanket”');
  await expect(drawer.getByTestId('concept-sources-label')).toHaveText('In 2 materials · 3 places');
  await expect(drawer.getByTestId('concept-words-source')).toHaveText([/Glowfin almanac · 1 place/]);
  await drawer.getByTestId('concept-words-place').first().click();
  await expect(page).toHaveURL(new RegExp(`#/s/${almanac}`));
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('moss blanket');
  // Back: the review is beside the cards again when nothing is chosen.
  await page.goBack();
  await expect(page.getByTestId('room-mode-concepts')).toHaveAttribute('aria-pressed', 'true');
});

test('the cards: a concept put under another (by its list, or its card dragged onto another), in a topic (dragged onto its heading) and in none; found by name; a topic folded; a concept you make gets materials found for it', async ({
  page,
  request,
}) => {
  const { room: big } = await glowfins(request, { cover: 'fern quilt', kind: 'summer fern quilt', den: 'reed burrow', title: 'Glowfin summers' });
  await request.post(`/api/rooms/${big}/read`, { headers: H });
  await expect.poll(async () => (await (await request.get(`/api/rooms/${big}`)).json()).reading?.phase, { timeout: 30_000 }).toBe('done');
  await request.post(`/api/rooms/${big}/concepts/keep`, { headers: H });
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts in 1 topic · your 5 things');
  const drawer = page.getByTestId('concept-drawer');
  const status = page.getByTestId('concepts-status');
  const nodes = page.getByTestId('concept-node');

  // Put under by its list: a kind of it; then in no topic, under nothing.
  await pick(page, 'fern quilt');
  await drawer.getByTestId('concept-put-under').selectOption({ label: 'reed burrow' });
  await expect(drawer.getByTestId('concept-home')).toContainText('reed burrow');
  await expect(node(page, 'fern quilt').getByTestId('concept-under')).toHaveText('a kind of reed burrow');
  await drawer.getByTestId('concept-put-under').selectOption({ label: 'Nothing: in no topic' });
  await expect(drawer.getByTestId('concept-home')).toHaveText('In no topic, under no concept');
  // Later topics start folded; open this one to see what was put in it.
  await topic(page, 'In no topic').getByTestId('concepts-topic-toggle').click();
  await expect(inTopic(page, 'In no topic')).toContainText(['fern quilt']);
  // A concept put under another by its list (dragging across sections is covered by its own test below).
  await pick(page, 'summer fern quilt');
  await drawer.getByTestId('concept-put-under').selectOption({ label: 'reed burrow' });
  await expect(node(page, 'summer fern quilt').getByTestId('concept-under')).toHaveText('a kind of reed burrow');
  await drawer.getByTestId('concept-drawer-close').click();
  // Onto a topic's heading: in it (the window tall enough for both to be seen as the card is carried).
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.getByTestId('concepts-find').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await drag(page, node(page, 'fern quilt'), topic(page, 'Glowfin summers basics'));
  await expect(status).toContainText('“fern quilt” is in “Glowfin summers basics” now.');
  await expect(inTopic(page, 'Glowfin summers basics')).toHaveCount(3);

  // Found by name: only the cards that match; then all again.
  await page.getByTestId('concepts-find').fill('burrow');
  await expect(nodes).toHaveCount(1);
  await expect(page.getByTestId('concepts-found')).toContainText('1 concept found');
  await page.getByTestId('concepts-found').getByRole('button', { name: 'Show all' }).click();
  await expect(nodes).toHaveCount(3);
  // A topic folded shut, and open again.
  await topic(page, 'Glowfin summers basics').getByTestId('concepts-topic-toggle').click();
  await expect(nodes).toHaveCount(0);
  await topic(page, 'Glowfin summers basics').getByTestId('concepts-topic-toggle').click();
  await expect(nodes).toHaveCount(3);
  // The topic chosen: what it covers and what is in it.
  await topic(page, 'Glowfin summers basics').getByTestId('concepts-topic-name').click();
  await expect(drawer.getByTestId('concept-rename')).toContainText('Glowfin summers basics');
  await expect(drawer.getByTestId('concept-inside-chip')).toHaveCount(2);
  await drawer.getByTestId('concept-drawer-close').click();
  await expect(page.getByTestId('concepts-review')).toBeVisible();

  // A concept you make: the AI says what it covers, and finds what goes inside it and where your materials discuss it,
  // each waiting until you keep it.
  await page.getByTestId('concept-new').click();
  await page.getByTestId('concept-new-title').fill('quilt');
  await page.getByTestId('concept-new-title').press('Enter');
  await expect(drawer.getByTestId('concept-rename')).toContainText('quilt');
  await expect(node(page, 'quilt')).toContainText('Nothing under it yet');
  await drawer.getByTestId('concept-find').click();
  await expect(status).toContainText(/Found for “quilt”: .*dashed until you keep them\./);
  await expect(drawer.getByTestId('concept-scope')).toContainText('Fake scope: what “quilt” covers.');
  const found = drawer.getByTestId('concept-place').filter({ hasText: 'found for it' });
  const n = await found.count();
  expect(n).toBeGreaterThan(0);
  await found.first().getByTestId('concept-place-keep').click();
  await expect(drawer.getByTestId('concept-place').filter({ hasText: 'found for it' })).toHaveCount(n - 1);

  // Folders: a topic is a folder of its concepts; a concept of its things.
  await page.getByTestId('room-mode-folders').click();
  const topicRow = page.locator('[data-testid=folder-row][data-key^="concept:"]').filter({ hasText: 'Glowfin summers basics' });
  await expect(topicRow).toContainText('Topic');
  await topicRow.getByTestId('folder-toggle').click();
  await expect(page.locator('[data-testid=folder-row][data-depth="1"] .folders-title')).toContainText(['reed burrow']);
  // Path: by topic.
  await page.getByTestId('room-mode-path').click();
  await expect(page.getByTestId('path-topic').first()).toContainText('Glowfin summers basics');
});

test('a concept is split, merged back, linked by hand, asked about, and made a room of its own', async ({ page, request }) => {
  const raft = await noteWith(request, 'Reed raft', '**Reed raft** is a mat the otters float on. It drifts near the **tide pool**.');
  const pool = await noteWith(request, 'Tide pool', '**Tide pool** is water left by the sea. Salt dries into a **salt crust** there.');
  const crust = await noteWith(request, 'Salt crust', '**Salt crust** is the white rim on the rocks. Otters lick it from the **reed raft**.');
  const big = await room(
    request,
    'Otter shores',
    [raft, pool, crust].map((id) => ({ kind: 'note', id })),
  );
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(3);
  await page.getByTestId('concepts-keep-all').click();
  await expect(page.getByTestId('concepts-bar')).toHaveText('3 concepts in 1 topic · your 3 things');
  const drawer = page.getByTestId('concept-drawer');

  // Split: "Salt crust" to a new concept; the words stay with the thing.
  await pick(page, 'reed raft');
  await expect(drawer.getByTestId('concept-source')).toHaveText([/Reed raft/, /Salt crust/]);
  await drawer.getByTestId('concept-split').click();
  await drawer.getByTestId('concept-split-pick').nth(1).check();
  await drawer.getByTestId('concept-split-title').fill('Licking spots');
  await drawer.getByTestId('concept-split-save').click();
  await expect(nodes).toHaveCount(4);
  await expect(drawer.getByTestId('concept-rename')).toContainText('Licking spots');
  await expect(drawer.getByTestId('concept-source')).toHaveText([/Salt crust/]);
  await expect(drawer.getByTestId('concept-place')).toHaveText([/“Otters lick it from the reed raft\.”/]);

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
  await pick(page, 'salt crust');
  await drawer.getByTestId('concept-to-room').click();
  await expect(nodes).toHaveCount(2);
  await page.getByTestId('room-mode-folders').click();
  await expect(page.locator('[data-testid=folder-row][data-key^="room:"]')).toHaveText([/salt crust/]);
  const { rooms } = await (await request.get(`/api/notebooks/${await notebookId(request)}/rooms`)).json();
  expect(rooms.map((r: { title: string }) => r.title).sort()).toEqual(['Otter shores', 'salt crust']);
  const { concepts } = await (await request.get(`/api/notebooks/${await notebookId(request)}/concepts`)).json();
  expect(concepts.map((c: { title: string }) => c.title)).not.toContain('salt crust');
});

test('a thread that grows is read again, only what changed; a concept shows from its things’ side, and words in a source are put under one by hand', async ({
  page,
  request,
}) => {
  const lantern = await noteWith(request, 'Lantern moss', '**Lantern moss** is a moss that glows at night.');
  const stones = await written(request, 'Old stones', 'Lantern moss grows on old stones. It grows on old stones in the shade.');
  const thread = await freshThread(request);
  await asked(request, thread, 'Why does **lantern moss** glow?');
  const big = await room(request, 'Night garden', [
    { kind: 'note', id: lantern },
    { kind: 'thread', id: thread },
    { kind: 'source', id: stones },
  ]);
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  await page.getByTestId('concepts-read').click();
  const nodes = page.getByTestId('concept-node');
  await expect(nodes).toHaveCount(1);
  await page.getByTestId('concepts-keep-all').click();
  await pick(page, 'lantern moss');
  const drawer = page.getByTestId('concept-drawer');
  // The note defines it; the thread asks, and its answer uses it. The source is not read: its words are found.
  await expect(drawer.getByTestId('concept-sources-label')).toHaveText('In 2 materials · 3 places');
  await expect(drawer.getByTestId('concept-words-source')).toHaveText([/Old stones · 1 place/]);
  await expect(page.getByTestId('concepts-changed')).toHaveCount(0);

  // The thread grows: the room says so, and Update reads that thread again.
  await asked(request, thread, 'Where does **lantern moss** grow best?');
  await page.reload();
  await expect(page.getByTestId('concepts-changed')).toContainText('1 material changed since its concepts were read');
  await expect(page.getByTestId('concepts-read')).toHaveText(/Update/);
  await page.getByTestId('concepts-update').click();
  await expect(page.getByTestId('concepts-changed')).toHaveCount(0);
  await pick(page, 'lantern moss');
  // Its new question asks, its answer uses: the thread's three places at most for one concept (the skill's rule).
  await expect(drawer.getByTestId('concept-sources-label')).toHaveText('In 2 materials · 4 places');
  await expect(nodes.first()).toHaveAttribute('data-status', 'kept');

  // From the note's side: its concepts under its title, each a click away from its words there.
  await page.goto(`/#/note/${lantern}`);
  const here = page.getByTestId('concepts-here-chip');
  await expect(here).toHaveText([/lantern moss · 1 place/]);

  // Words in the source put under it by hand: a place of its own, kept when the AI reads again.
  await page.goto(`/#/s/${stones}`);
  await expect(page.getByTestId('source-text')).toContainText('It grows on old stones in the shade.');
  await page.getByTestId('source-text').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf('It grows on old stones in the shade.') ?? -1;
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 'It grows on old stones in the shade.'.length);
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
  await expect(here).toHaveText([/lantern moss · 1 place/]);
  await here.click();
  await expect.poll(() => highlighted(page, 'noema-found')).toContain('It grows on old stones in the shade.');
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

  await pick(page, 'lantern moss');
  const yours = drawer.getByTestId('concept-place').filter({ hasText: 'you put it here' });
  await expect(yours).toContainText('“It grows on old stones in the shade.”');
  await page.getByTestId('concepts-read').click();
  await expect(page.getByTestId('concepts-read')).toHaveText(/Read again/);
  await expect(yours).toHaveCount(1);
});

test('Concepts: cards sit in one column with relations in words, and later topics start folded', async ({ page, request }) => {
  const { room: big } = await glowfins(request, { cover: 'cloud cap', kind: 'summer cloud cap', den: 'reed cradle', title: 'Glowfin clouds' });
  await request.post(`/api/rooms/${big}/read`, { headers: H });
  await expect.poll(async () => (await (await request.get(`/api/rooms/${big}`)).json()).reading?.phase, { timeout: 30_000 }).toBe('done');
  await request.post(`/api/rooms/${big}/concepts/keep`, { headers: H });
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  // A second topic, made by hand: an empty concept that another one is put under.
  await page.getByTestId('concept-new').click();
  await page.getByTestId('concept-new-title').fill('Second topic');
  await page.getByTestId('concept-new-title').press('Enter');
  await pick(page, 'summer cloud cap');
  await page.getByTestId('concept-drawer').getByTestId('concept-put-under').selectOption({ label: 'Second topic' });
  await page.getByTestId('concept-drawer-close').click();
  // Reopen: only the first topic is open, and its cards are one column.
  await page.reload();
  await page.getByTestId('room-mode-concepts').click();
  await expect(topic(page, 'Second topic').getByTestId('concepts-topic-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('concepts-lane')).toHaveCount(1);
  // A relation is in words on the card, not only in the column the card sits in.
  await expect(page.getByTestId('concept-rel').first()).toBeVisible();
});

test('Concepts lenses: Explore opens every topic, Audit shows only the gaps', async ({ page, request }) => {
  const { room: big } = await glowfins(request, { cover: 'silver veil', kind: 'winter silver veil', den: 'reed court', title: 'Glowfin lenses' });
  await request.post(`/api/rooms/${big}/read`, { headers: H });
  await expect.poll(async () => (await (await request.get(`/api/rooms/${big}`)).json()).reading?.phase, { timeout: 30_000 }).toBe('done');
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  // A second topic, so Explore's "open every topic" can be seen.
  await page.getByTestId('concept-new').click();
  await page.getByTestId('concept-new-title').fill('Other ideas');
  await page.getByTestId('concept-new-title').press('Enter');
  await pick(page, 'winter silver veil');
  await page.getByTestId('concept-drawer').getByTestId('concept-put-under').selectOption({ label: 'Other ideas' });
  await page.getByTestId('concept-drawer-close').click();
  await page.reload();
  await page.getByTestId('room-mode-concepts').click();
  // Study: later topics start folded (the default from the previous test).
  await expect(topic(page, 'Other ideas').getByTestId('concepts-topic-toggle')).toHaveAttribute('aria-expanded', 'false');
  // Explore: every topic open.
  await page.getByTestId('concepts-lens').selectOption('explore');
  await expect(topic(page, 'Other ideas').getByTestId('concepts-topic-toggle')).toHaveAttribute('aria-expanded', 'true');
  // Audit: only gaps are on the cards; relations are not shown there.
  await page.getByTestId('concepts-lens').selectOption('audit');
  await expect(page.getByTestId('concept-rel')).toHaveCount(0);
  await expect(page.getByTestId('concepts-audit')).toBeVisible();
  // Back to Study: the relation words return.
  await page.getByTestId('concepts-lens').selectOption('study');
  await expect(page.getByTestId('concept-rel').first()).toBeVisible();
});

test('a card dragged onto another card puts it under it', async ({ page, request }) => {
  const a = await noteWith(request, 'Alpha', '**alpha** is a thing.');
  const b = await noteWith(request, 'Beta', '**beta** is another thing.');
  const big = await room(request, 'Drag cards', [{ kind: 'note', id: a }, { kind: 'note', id: b }]);
  await request.post(`/api/rooms/${big}/read`, { headers: H });
  await expect.poll(async () => (await (await request.get(`/api/rooms/${big}`)).json()).reading?.phase, { timeout: 30_000 }).toBe('done');
  await request.post(`/api/rooms/${big}/concepts/keep`, { headers: H });
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  const alpha = node(page, 'alpha');
  const beta = node(page, 'beta');
  await expect(alpha.getByTestId('concept-under')).toHaveCount(0);
  await alpha.dragTo(beta);
  await expect(alpha.getByTestId('concept-under')).toHaveText('a kind of beta');
});

test('a topic with many concepts shows the most worked with; the rest fold under “N more”', async ({ page, request }) => {
  const stones = ['Amber', 'Basalt', 'Chert', 'Dolomite', 'Flint', 'Gneiss', 'Jasper', 'Marble', 'Onyx', 'Quartz'];
  const beach = await noteWith(request, 'Beach stones', ...stones.map((s) => `**${s}** is a stone found on the shingle beach.`));
  const asked1 = await freshThread(request);
  await asked(request, asked1, 'Why is **Quartz** so common on the beach?');
  const big = await room(request, 'Shingle beach', [
    { kind: 'note', id: beach },
    { kind: 'thread', id: asked1 },
  ]);
  await request.post(`/api/rooms/${big}/read`, { headers: H });
  await expect.poll(async () => (await (await request.get(`/api/rooms/${big}`)).json()).reading?.phase, { timeout: 30_000 }).toBe('done');
  await page.goto(`/#/room/${big}`);
  await page.getByTestId('room-mode-concepts').click();
  const cards = inTopic(page, 'Shingle beach basics');
  await expect(cards).toHaveCount(8);
  // The one asked about is among those shown.
  await expect(node(page, 'quartz')).toHaveCount(1);
  await expect(page.getByTestId('concepts-more')).toHaveText('▸ 2 more in Shingle beach basics, less worked with');
  await page.getByTestId('concepts-more').click();
  await expect(cards).toHaveCount(10);
  // Found by name, a folded one shows too.
  await page.getByRole('button', { name: /Show the 8 most worked with/ }).click();
  await expect(cards).toHaveCount(8);
  await page.getByTestId('concepts-find').fill('onyx');
  await expect(page.getByTestId('concept-node')).toHaveText([/onyx/]);
});
