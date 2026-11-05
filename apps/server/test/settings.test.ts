import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, type TestContext, test } from 'node:test';
import { type AskResponse, type Health, type Message, type ModelSettingsView, ulid } from '@noema/core';
import { FakeProvider } from '../src/llm/fake.ts';
import { ModelSettings } from '../src/llm/settings.ts';
import { silentLogger } from '../src/log.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// A stand-in for an OpenAI-compatible provider such as DeepSeek.
const GOOD_KEY = 'sk-good-0123456789';
const LISTED = ['mock-1', 'mock-2'];
const ACCEPTED = new Set([...LISTED, 'legacy-alias']); // answers, but is not in the list
let lastChat: Record<string, unknown> = {};
let mockBase = '';
const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c: Buffer) => {
    raw += c.toString();
  });
  req.on('end', () => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      return json(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
    }
    const path = req.url ?? '';
    if (req.method === 'GET' && path === '/models')
      return json(200, { object: 'list', data: LISTED.map((id) => ({ id })) });
    if (req.method === 'GET' && path === '/nolist/models') return json(404, { error: { message: 'Not Found' } });
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      lastChat = JSON.parse(raw) as Record<string, unknown>;
      if (!ACCEPTED.has(lastChat.model as string)) return json(400, { error: { message: 'Model Not Exist' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['Hello ', 'from the ', 'mock model.']) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    json(404, { error: { message: 'Not Found' } });
  });
});

let dir = '';
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'noema-settings-'));
});
after(() => {
  mock.closeAllConnections();
  mock.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A server whose .env has no key, saving settings to `file`. Closed when the test ends, pass or fail. */
async function unconfigured(t: TestContext, file: string | null = null): Promise<TestServer> {
  const s = await startServer({
    models: { env: { provider: 'openai-compatible', baseUrl: mockBase, model: 'mock-1', apiKey: '' }, filePath: file },
  });
  t.after(() => s.close());
  return s;
}

const save = (s: TestServer, body: Record<string, unknown>) =>
  api<{ settings: ModelSettingsView; available: string[]; error?: { code: string; message: string } }>(
    s,
    'PUT',
    '/api/settings/model',
    body,
  );

test('with no key anywhere, the app says so and answers fail with a plain reason', async (t) => {
  const s = await unconfigured(t);
  const health = await api<Health>(s, 'GET', '/api/health');
  assert.equal(health.json.configured, false);
  assert.equal(health.json.model, null);
  const view = await api<ModelSettingsView>(s, 'GET', '/api/settings/model');
  assert.deepEqual([view.json.hasKey, view.json.keyHint, view.json.source], [false, null, 'environment']);

  const { threadId } = await newThread(s);
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: 'hi' });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const answer = s.repo.getMessage(r.json.assistant.id) as Message;
  assert.equal(answer.status, 'failed');
  assert.equal(answer.error?.kind, 'not_configured');
  assert.match(answer.error?.message ?? '', /Model settings/);
});

test('a wrong key is refused and nothing is saved', async (t) => {
  const file = join(dir, 'wrong.json');
  const s = await unconfigured(t, file);
  const r = await save(s, { baseUrl: mockBase, model: 'mock-1', apiKey: 'sk-wrong-000000000' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error?.code, 'auth');
  assert.match(r.json.error?.message ?? '', /rejected the API key/);
  assert.throws(() => statSync(file));
  assert.equal((await api<Health>(s, 'GET', '/api/health')).json.configured, false);
});

test('a working key is checked, saved privately, used for answers, and never sent back', async (t) => {
  const file = join(dir, 'good.json');
  const s = await unconfigured(t, file);
  const res = await fetch(`${s.base}/api/settings/model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-noema-client': 'web' },
    body: JSON.stringify({ baseUrl: `${mockBase}/`, model: 'mock-1', apiKey: ` ${GOOD_KEY} ` }),
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(GOOD_KEY), 'the key came back in the response');
  const body = JSON.parse(text) as { settings: ModelSettingsView; available: string[] };
  assert.equal(body.settings.keyHint, 'sk-…6789');
  assert.equal(body.settings.source, 'saved');
  assert.equal(body.settings.baseUrl, mockBase);
  assert.deepEqual(body.available, LISTED);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).apiKey, GOOD_KEY);
  const health = (await api<Health>(s, 'GET', '/api/health')).json;
  assert.deepEqual([health.configured, health.model], [true, 'mock-1']);

  const { threadId } = await newThread(s);
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: 'hi' });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const answer = s.repo.getMessage(r.json.assistant.id) as Message;
  assert.equal(answer.status, 'done');
  assert.equal(answer.content, 'Hello from the mock model.');
  assert.equal('max_tokens' in lastChat, false, 'no output cap unless one is configured');

  const exported = await (await fetch(`${s.base}/api/export`)).text();
  assert.ok(!exported.includes(GOOD_KEY), 'the key leaked into the export');
});

test('changing only the model keeps the saved key', async (t) => {
  const s = await unconfigured(t, join(dir, 'change.json'));
  assert.equal((await save(s, { baseUrl: mockBase, model: 'mock-1', apiKey: GOOD_KEY })).status, 200);
  const r = await save(s, { baseUrl: mockBase, model: 'mock-2' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.settings.model, r.json.settings.keyHint], ['mock-2', 'sk-…6789']);
});

test('a model the provider does not list is tried directly', async (t) => {
  const s = await unconfigured(t);
  const alias = await save(s, { baseUrl: mockBase, model: 'legacy-alias', apiKey: GOOD_KEY });
  assert.equal(alias.status, 200);
  const missing = await save(s, { baseUrl: mockBase, model: 'no-such-model', apiKey: GOOD_KEY });
  assert.equal(missing.status, 422);
  assert.equal(missing.json.error?.code, 'bad_request');
  assert.match(missing.json.error?.message ?? '', /Model Not Exist/);
  assert.equal((await api<ModelSettingsView>(s, 'GET', '/api/settings/model')).json.model, 'legacy-alias');
});

test('providers without a model list are checked with a tiny answer', async (t) => {
  const s = await unconfigured(t);
  const r = await save(s, { baseUrl: `${mockBase}/nolist`, model: 'mock-1', apiKey: GOOD_KEY });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.available, []);
});

test('an unreachable provider and a non-web URL are explained', async (t) => {
  const s = await unconfigured(t);
  const down = await save(s, { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: GOOD_KEY });
  assert.equal(down.status, 422);
  assert.equal(down.json.error?.code, 'network');
  const ftp = await save(s, { baseUrl: 'ftp://example.com', model: 'm', apiKey: GOOD_KEY });
  assert.equal(ftp.status, 400);
});

test('saved settings survive a restart, win over .env, and can be removed', async (t) => {
  const file = join(dir, 'restart.json');
  const first = await startServer({
    models: { env: { provider: 'openai-compatible', baseUrl: mockBase, model: 'mock-1', apiKey: '' }, filePath: file },
  });
  try {
    assert.equal((await save(first, { baseUrl: mockBase, model: 'mock-2', apiKey: GOOD_KEY })).status, 200);
  } finally {
    await first.close();
  }

  const options = {
    env: {
      provider: 'openai-compatible' as const,
      baseUrl: 'https://api.deepseek.com',
      model: 'x',
      apiKey: 'sk-env-key-999999',
    },
    filePath: file,
    fake: () => new FakeProvider(),
    log: silentLogger,
  };
  const again = new ModelSettings(options);
  assert.deepEqual([again.view().source, again.view().model, again.current().model], ['saved', 'mock-2', 'mock-2']);

  const second = await startServer({ models: options });
  t.after(() => second.close());
  const removed = await api<{ settings: ModelSettingsView }>(second, 'DELETE', '/api/settings/model');
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.json.settings.source, removed.json.settings.model], ['environment', 'x']);
  assert.throws(() => statSync(file));
});

test('a damaged settings file is ignored, not fatal', () => {
  const file = join(dir, 'broken.json');
  writeFileSync(file, '{ not json');
  const m = new ModelSettings({
    env: { provider: 'openai-compatible', baseUrl: mockBase, model: 'mock-1', apiKey: '' },
    filePath: file,
    fake: () => new FakeProvider(),
    log: silentLogger,
  });
  assert.deepEqual([m.view().source, m.view().configured], ['environment', false]);
});
