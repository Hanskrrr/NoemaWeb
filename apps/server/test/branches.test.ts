import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type ContextManifest,
  type CreateBranchResponse,
  type Message,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

const MIGRATIONS = fileURLToPath(new URL('../src/store/migrations/', import.meta.url));

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(async () => {
  await s.close();
});

async function ask(threadId: string, content: string): Promise<AskResponse> {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

async function branch(parentId: string, message: Message, phrase: string, question: string, id = ulid()) {
  const content = s.repo.getMessage(message.id)?.content ?? '';
  const start = content.indexOf(phrase);
  assert.ok(start >= 0, `"${phrase}" not in message`);
  const r = await api<CreateBranchResponse & { error?: { code: string } }>(s, 'POST', `/api/threads/${parentId}/branches`, {
    id,
    anchor: { messageId: message.id, start, end: start + phrase.length },
    question: { id: ulid(), content: question },
  });
  if (r.status < 300) await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r;
}

const manifestOf = (revisionId: string) =>
  JSON.parse(s.repo.modelCallsFor(revisionId)[0]?.manifest as string) as ContextManifest;

test('a branch keeps its exact origin and inherits only the path up to it', async () => {
  const { threadId } = await newThread(s);
  const first = await ask(threadId, 'First question');
  const second = await ask(threadId, 'Second question');

  const r = await branch(threadId, first.assistant, 'offline fake model', 'Why is it fake?');
  assert.equal(r.status, 201);
  assert.equal(r.json.thread.parentThreadId, threadId);
  assert.equal(r.json.thread.title, 'Why is it fake?');

  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${r.json.thread.id}`)).json;
  assert.equal(detail.origin?.parentThreadId, threadId);
  assert.equal(detail.origin?.anchor.exact, 'offline fake model');
  assert.equal(detail.origin?.anchor.messageId, first.assistant.id);
  assert.equal(detail.origin?.anchor.revisionId, first.assistant.revisionId);
  assert.equal(detail.origin?.anchor.prefix.endsWith('This is the **'), true);
  assert.deepEqual(detail.path.map((p) => p.id), [threadId]);

  const parent = (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json;
  assert.deepEqual(
    parent.branches.map((b) => [b.threadId, b.anchor.exact]),
    [[r.json.thread.id, 'offline fake model']],
  );

  const manifest = manifestOf(r.json.assistant.revisionId);
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'inherited', 'inherited', 'origin', 'question'],
  );
  const ids = manifest.parts.map((p) => ('id' in p ? p.id : null));
  assert.ok(ids.includes(first.user.id) && ids.includes(first.assistant.id));
  assert.ok(!ids.includes(second.user.id), 'a later message of the parent leaked into the branch');
});

test('a branch of a branch inherits the whole path, outermost first', async () => {
  const { threadId } = await newThread(s);
  const main = await ask(threadId, 'Main question');
  const b1 = await branch(threadId, main.assistant, 'Inline math', 'What is inline math?');
  const b2 = await branch(b1.json.thread.id, b1.json.assistant, 'every question', 'Every one?');
  assert.equal(b2.status, 201);

  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${b2.json.thread.id}`)).json;
  assert.deepEqual(
    detail.path.map((p) => p.id),
    [threadId, b1.json.thread.id],
  );
  const manifest = manifestOf(b2.json.assistant.revisionId);
  const inherited = manifest.parts.filter((p) => p.kind === 'inherited').map((p) => ('id' in p ? p.id : ''));
  assert.deepEqual(inherited, [main.user.id, main.assistant.id, b1.json.user.id, b1.json.assistant.id]);

  const list = await api<{ threads: Array<{ id: string; parentThreadId: string | null }> }>(
    s,
    'GET',
    `/api/notebooks/${detail.thread.notebookId}/threads`,
  );
  const byId = new Map(list.json.threads.map((t) => [t.id, t.parentThreadId]));
  assert.equal(byId.get(b2.json.thread.id), b1.json.thread.id);
  assert.equal(byId.get(threadId), null);
});

test('branching from a question works too, and includes that question’s answer', async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'Explain the Jacobian matrix');
  const r = await branch(threadId, q.user, 'Jacobian', 'Why is it called that?');
  assert.equal(r.status, 201);
  const inherited = manifestOf(r.json.assistant.revisionId).parts.filter((p) => p.kind === 'inherited');
  assert.equal(inherited.length, 2);
});

test('sending the same branch twice opens it once', async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'Once');
  const id = ulid();
  const questionId = ulid();
  const content = s.repo.getMessage(q.assistant.id)?.content ?? '';
  const start = content.indexOf('fake');
  const body = {
    id,
    anchor: { messageId: q.assistant.id, start, end: start + 4 },
    question: { id: questionId, content: 'Twice?' },
  };
  const a = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, body);
  const b = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, body);
  assert.deepEqual([a.status, b.status], [201, 200]);
  assert.equal(b.json.assistant.id, a.json.assistant.id);
  assert.equal((await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json.branches.length, 1);
  await readEvents(`${s.base}/api/messages/${a.json.assistant.id}/events`);
});

test('bad branches are refused with a reason', async () => {
  const { threadId } = await newThread(s);
  const other = await newThread(s);
  const q = await ask(threadId, 'Refusals');
  const post = (parent: string, anchor: Record<string, unknown>) =>
    api<{ error: { code: string } }>(s, 'POST', `/api/threads/${parent}/branches`, {
      id: ulid(),
      anchor,
      question: { id: ulid(), content: 'x' },
    });
  assert.equal((await post(threadId, { messageId: q.assistant.id, start: 0, end: 10_000_000 })).status, 400);
  assert.equal((await post(threadId, { messageId: q.assistant.id, start: 5, end: 5 })).status, 400);
  assert.equal((await post(other.threadId, { messageId: q.assistant.id, start: 0, end: 4 })).status, 400);
  assert.equal((await post(ulid(), { messageId: q.assistant.id, start: 0, end: 4 })).status, 404);

  const live = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, {
    id: ulid(),
    content: 'still going [[slow]]',
  });
  const r = await post(threadId, { messageId: live.json.assistant.id, start: 0, end: 1 });
  assert.equal(r.status, 409);
  await api(s, 'POST', `/api/messages/${live.json.assistant.id}/stop`, {});
});

test('Back is recorded, so returns can be counted', async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'Count returns');
  const b = await branch(threadId, q.assistant, 'fake', 'Detour');
  assert.equal((await api(s, 'POST', `/api/threads/${b.json.thread.id}/return`, {})).status, 200);
  const n = s.db.sql
    .prepare("SELECT COUNT(*) AS n FROM event WHERE type = 'branch.returned' AND subject_id = ?")
    .get(b.json.thread.id) as { n: number };
  assert.equal(n.n, 1);
});

test('an existing notebook upgrades to branches without losing anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v1 = join(dir, 'v1');
  mkdirSync(v1);
  copyFileSync(join(MIGRATIONS, '001_init.sql'), join(v1, '001_init.sql'));
  const file = join(dir, 'n.db');
  const notebookId = ulid();
  const threadId = ulid();
  const old = new Db(file);
  old.migrate(v1); // a notebook made before branches existed
  assert.equal(old.version, 1);
  const t = new Date().toISOString();
  old.sql
    .prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(notebookId, 'N', '', t, t);
  old.sql
    .prepare('INSERT INTO thread (id, notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(threadId, notebookId, 'Old thread', t, t);
  old.close();

  const db = new Db(file);
  assert.equal(db.migrate(), 1);
  assert.equal(db.version, 2);
  const thread = new Repo(db).getThread(threadId);
  assert.equal(thread?.title, 'Old thread');
  assert.equal(thread?.parentThreadId, null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
