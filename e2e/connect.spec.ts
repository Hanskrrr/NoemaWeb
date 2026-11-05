import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { FRESH_URL } from './ports.ts';

// A stand-in for DeepSeek or any OpenAI-compatible provider. The Noema server
// talks to it; the browser never does.
const GOOD_KEY = 'sk-e2e-good-0123456789';
let mock: Server;
let mockUrl = '';

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-chat' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of ['Hello from ', 'the mock model.']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  mock.closeAllConnections();
  mock.close();
});

test('first run: connect a model with your own key, ask, then remove the key', async ({ page }) => {
  await page.goto(FRESH_URL);
  await expect(page.getByRole('heading', { name: 'Connect a model' })).toBeVisible();
  await expect(page.getByTestId('model-name')).toHaveValue('deepseek-flash');

  await page.getByTestId('model-provider').selectOption('other');
  await page.getByTestId('model-base-url').fill(mockUrl);
  await page.getByTestId('model-name').fill('mock-chat');
  await page.getByTestId('model-key').fill('sk-e2e-wrong-000000000');
  await page.getByTestId('model-save').click();
  await expect(page.getByTestId('model-error')).toContainText('rejected the API key');

  await page.getByTestId('model-key').fill(GOOD_KEY);
  await page.getByTestId('model-save').click();
  await expect(page.getByTestId('model-button')).toHaveText('mock-chat');

  await page.getByTestId('composer').fill('Say hello');
  await page.getByTestId('composer').press('Enter');
  const answer = page.locator('[data-testid=message][data-role=assistant]').last();
  await expect(answer).toHaveAttribute('data-status', 'done');
  await expect(answer).toContainText('Hello from the mock model.');

  // The settings say a key is saved without ever showing it.
  await page.getByTestId('model-button').click();
  await expect(page.getByTestId('model-key')).toHaveAttribute('placeholder', /Saved \(sk-…6789\)/);
  expect(await page.content()).not.toContain(GOOD_KEY);

  await page.getByTestId('model-remove').click();
  await expect(page.getByRole('heading', { name: 'Connect a model' })).toBeVisible();
});
