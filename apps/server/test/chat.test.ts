import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { type AskResponse, type Message, ulid } from '@noema/core';
import { fakeAnswer } from '../src/llm/fake.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, finalStatus, newThread, readEvents, startServer, type TestServer, textFrom, waitFor } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(async () => {
  await s.close();
});

async function ask(threadId: string, content: string, id = ulid()) {
  return api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id, content });
}

test('ask, then watch the answer stream to the end', async () => {
  const { threadId } = await newThread(s);
  const r = await ask(threadId, 'What is a derivative?');
  assert.equal(r.status, 201);
  assert.equal(r.json.user.content, 'What is a derivative?');
  const events = await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  assert.equal(events[0]?.event, 'snapshot');
  assert.equal(events.at(-1)?.event, 'end');
  assert.equal(textFrom(events), fakeAnswer('What is a derivative?'));
  const thread = await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${threadId}`);
  const answer = thread.json.messages[1];
  assert.equal(answer?.status, 'done');
  assert.equal(answer?.content, fakeAnswer('What is a derivative?'));
  const calls = s.repo.modelCallsFor(answer?.revisionId as string);
  assert.equal(calls.length, 1);
  const manifest = JSON.parse(calls[0]?.manifest as string) as { parts: Array<{ kind: string }> };
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'question'],
  );
});

test('posting the same message twice asks once', async () => {
  const { threadId } = await newThread(s);
  const id = ulid();
  const a = await ask(threadId, 'Twice?', id);
  const b = await ask(threadId, 'Twice?', id);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.assistant.id, a.json.assistant.id);
  const c = await ask(threadId, 'Different text, same id', id);
  assert.equal(c.status, 409);
  await readEvents(`${s.base}/api/messages/${a.json.assistant.id}/events`);
  const thread = await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${threadId}`);
  assert.equal(thread.json.messages.length, 2);
});

test('a watcher that joins mid-answer gets everything once: snapshot then deltas', async () => {
  const { threadId } = await newThread(s);
  const r = await ask(threadId, 'Explain slowly [[slow]]');
  const url = `${s.base}/api/messages/${r.json.assistant.id}/events`;
  const early = await readEvents(url, { stopAfter: 4 }); // a tab that closes early
  assert.ok(early.length >= 2);
  const late = await readEvents(url, { timeoutMs: 15_000 }); // a tab that reloads
  const firstSnapshot = late[0]?.data as { message: Message };
  assert.ok(firstSnapshot.message.content.length > 0, 'the reload starts from text already streamed');
  assert.equal(textFrom(late), fakeAnswer('Explain slowly [[slow]]'));
});

test('stop keeps the partial answer and marks it stopped', async () => {
  const { threadId } = await newThread(s);
  const r = await ask(threadId, 'A long one [[slow]]');
  const id = r.json.assistant.id;
  await readEvents(`${s.base}/api/messages/${id}/events`, { stopAfter: 6 });
  const stop = await api<{ stopping: boolean }>(s, 'POST', `/api/messages/${id}/stop`, {});
  assert.equal(stop.status, 202);
  assert.equal(stop.json.stopping, true);
  await waitFor(() => s.repo.getMessage(id)?.status === 'stopped');
  const m = s.repo.getMessage(id) as Message;
  assert.ok(m.content.length > 0);
  assert.ok(fakeAnswer('A long one [[slow]]').startsWith(m.content));
  const again = await api<{ stopping: boolean }>(s, 'POST', `/api/messages/${id}/stop`, {});
  assert.equal(again.json.stopping, false);
});

test('provider failures become named errors on the message', async () => {
  const { threadId } = await newThread(s);
  const r = await ask(threadId, 'please [[fail:rate_limit]]');
  const events = await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const status = finalStatus(events);
  assert.equal(status.status, 'failed');
  assert.equal(status.error?.kind, 'rate_limit');

  const mid = await ask(threadId, 'break [[error-midway]]');
  await readEvents(`${s.base}/api/messages/${mid.json.assistant.id}/events`);
  const m = s.repo.getMessage(mid.json.assistant.id) as Message;
  assert.equal(m.status, 'failed');
  assert.equal(m.error?.kind, 'network');
  assert.ok(m.content.length > 0, 'the text that arrived before the failure is kept');
});

test('the second question sees the first exchange as history', async () => {
  const { threadId } = await newThread(s);
  const one = await ask(threadId, 'First');
  await readEvents(`${s.base}/api/messages/${one.json.assistant.id}/events`);
  const two = await ask(threadId, 'Second');
  await readEvents(`${s.base}/api/messages/${two.json.assistant.id}/events`);
  const calls = s.repo.modelCallsFor(two.json.assistant.revisionId);
  const manifest = JSON.parse(calls[0]?.manifest as string) as { parts: Array<{ kind: string; id?: string }> };
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'history', 'history', 'question'],
  );
  assert.equal(manifest.parts[1]?.id, one.json.user.id);
});

test('About me is part of the stable prefix', async () => {
  const { notebookId, threadId } = await newThread(s);
  const patch = await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { aboutMe: 'I am learning linear algebra.' });
  assert.equal(patch.status, 200);
  const r = await ask(threadId, 'Hi');
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const manifest = JSON.parse(s.repo.modelCallsFor(r.json.assistant.revisionId)[0]?.manifest as string) as {
    parts: Array<{ kind: string }>;
  };
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'about_me', 'question'],
  );
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { aboutMe: '' });
});

test('bad requests get clear errors', async () => {
  const { threadId } = await newThread(s);
  assert.equal((await api(s, 'POST', `/api/threads/${threadId}/messages`, { id: 'x', content: 'hi' })).status, 400);
  assert.equal((await api(s, 'POST', `/api/threads/${ulid()}/messages`, { id: ulid(), content: 'hi' })).status, 404);
  assert.equal((await api(s, 'GET', '/api/nope')).status, 404);
  assert.equal((await api(s, 'DELETE', '/api/health')).status, 405);
  const res = await fetch(`${s.base}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noema-client': 'web' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_json');
});

test('other sites cannot drive the server', async () => {
  const { threadId } = await newThread(s);
  const body = JSON.stringify({ id: ulid(), content: 'hi' });
  const noHeader = await fetch(`${s.base}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(noHeader.status, 403);
  const foreignOrigin = await fetch(`${s.base}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noema-client': 'web', origin: 'https://evil.example' },
    body,
  });
  assert.equal(foreignOrigin.status, 403);
  const preflight = await fetch(`${s.base}/api/health`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('a rebinding attack (foreign Host header) is refused', async () => {
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${s.base}/api/health`, { headers: { host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('search over HTTP', async () => {
  const { threadId } = await newThread(s);
  const r = await ask(threadId, '什么是拉格朗日乘数？');
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const res = await api<{ hits: Array<{ messageId: string; snippet: string }> }>(
    s,
    'GET',
    `/api/search?q=${encodeURIComponent('拉格朗日')}`,
  );
  assert.ok(res.json.hits.some((h) => h.messageId === r.json.user.id));
});

test('after a crash (SIGKILL), the next boot marks the cut-off answer interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noema-'));
  const dbPath = join(dir, 'n.db');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
    cwd: dir,
    env: {
      ...process.env,
      NOEMA_DB_PATH: dbPath,
      NOEMA_BACKUP_DIR: join(dir, 'backups'),
      NOEMA_PORT: '0',
      NOEMA_PROVIDER: 'fake',
      NOEMA_LOG: 'info',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        const m = /"url":"(http:[^"]+)"/.exec(out);
        if (m) resolve(m[1] as string);
      });
      child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    });
    const remote: TestServer = { base, repo: undefined as never, db: undefined as never, close: async () => {} };
    const { threadId } = await newThread(remote);
    const r = await api<AskResponse>(remote, 'POST', `/api/threads/${threadId}/messages`, {
      id: ulid(),
      content: 'Crash during this [[slow]]',
    });
    const id = r.json.assistant.id;
    // Wait until the server has flushed some text to disk.
    for (let i = 0; ; i++) {
      const t = await api<{ messages: Message[] }>(remote, 'GET', `/api/threads/${threadId}`);
      const stored = new Db(dbPath);
      const content = new Repo(stored).getMessage(id)?.content ?? '';
      stored.close();
      if (content.length > 0 && t.json.messages[1]?.status === 'streaming') break;
      if (i > 200) throw new Error('nothing was flushed');
      await new Promise((res) => setTimeout(res, 25));
    }
    child.kill('SIGKILL');
    await once(child, 'exit');

    const next = await startServer({ dbPath });
    const m = next.repo.getMessage(id) as Message;
    assert.equal(m.status, 'interrupted');
    assert.ok(m.content.length > 0, 'flushed text survived the crash');
    assert.ok(fakeAnswer('Crash during this [[slow]]').startsWith(m.content));
    const events = await readEvents(`${next.base}/api/messages/${id}/events`);
    assert.deepEqual(
      events.map((e) => e.event),
      ['snapshot', 'end'],
    );
    await next.close();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
