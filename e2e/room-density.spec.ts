import { expect, test } from '@playwright/test';
import { ulidish } from './helpers.ts';

const H = { 'x-noema-client': 'web' };
const created: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/rooms/${id}`, { headers: H });
});

test('Board density: Compact keeps titles and links, and hides summaries, counts and words', async ({ page, request }) => {
  const { notebooks: [nb] } = await (await request.get('/api/notebooks')).json();
  const mk = async (title: string, text: string) => {
    const id = ulidish();
    await request.post(`/api/notebooks/${nb.id}/notes`, { data: { id, title }, headers: H });
    await request.post(`/api/notes/${id}/blocks`, { data: { id: ulidish(), after: null, content: text }, headers: H });
    return id;
  };
  const a = await mk('Warmup', '**warmup** keeps the early steps small so the estimates settle.');
  const b = await mk('Adam', '**Adam** corrects the bias of the first moments.');
  const room = ulidish();
  await request.post(`/api/notebooks/${nb.id}/rooms`, {
    data: { id: room, title: 'Density', items: [{ kind: 'note', id: a }, { kind: 'note', id: b }] },
    headers: H,
  });
  created.push(room);
  await request.post(`/api/rooms/${room}/read`, { headers: H });
  await expect
    .poll(async () => (await (await request.get(`/api/rooms/${room}`)).json()).reading?.phase, { timeout: 30_000 })
    .toBe('done');

  await page.goto(`/#/room/${room}`);
  await page.getByTestId('room-mode-board').click();
  // Normal first: the summary is on the card.
  await expect(page.getByTestId('room-gist').first()).toBeVisible();
  // Normal keeps the room's brief; Compact folds it to one line.
  await expect(page.getByTestId('room-brief-text')).toBeVisible();
  const link = page.locator('[data-testid="room-line"]');
  if ((await link.count()) > 0) await expect(link.first().locator('text')).toHaveCount(1);

  // Compact: titles stay; summaries, counts and the words on the lines go.
  await page.getByTestId('board-density').click();
  await expect(page.getByTestId('board-density')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('room-gist')).toHaveCount(0);
  await expect(page.getByTestId('room-card-marks')).toHaveCount(0);
  await expect(page.getByTestId('room-brief-text')).toHaveCount(0);
  await expect(page.getByTestId('room-open')).toHaveCount(0);
  await expect(page.getByTestId('room-brief-text')).toHaveCount(0);
  await expect(page.getByTestId('room-open')).toHaveCount(0);
  await expect(link.locator('text')).toHaveCount(0);
  await expect(page.locator('.room-card-title').first()).toBeVisible();

  // Remembered after a reload, and reversible.
  await page.reload();
  await page.getByTestId('room-mode-board').click();
  await expect(page.getByTestId('room-gist')).toHaveCount(0);
  await page.getByTestId('board-density').click();
  await expect(page.getByTestId('room-gist').first()).toBeVisible();
});
