import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskResponse, type CreateBranchResponse, type ThreadDetail, type ThreadMap, ulid } from '@noema/core';
import { cleanHeadline, headlineRequest } from '../src/chat/headlines.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

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

test('each finished answer gets a line saying what the exchange established, before it ends', async () => {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'What is this?');
  // Written before the stream's end, so a client refreshing on "end" sees it.
  assert.equal(s.repo.getMessage(q1.assistant.id)?.headline, 'In short: What is this');
  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json;
  assert.equal(detail.messages.find((m) => m.id === q1.assistant.id)?.headline, 'In short: What is this');
  assert.equal(detail.messages.find((m) => m.id === q1.user.id)?.headline, null, 'questions have none');

  // The map leads with it.
  const map = (await api<ThreadMap>(s, 'GET', `/api/threads/${threadId}/map`)).json;
  assert.deepEqual(
    map.root.exchanges.map((e) => [e.question, e.headline]),
    [['What is this?', 'In short: What is this']],
  );
});

test('no line for an answer that failed or was stopped, and a failed line leaves none', async () => {
  const { threadId } = await newThread(s);
  const failed = await ask(threadId, 'Break [[fail:unavailable]]');
  assert.equal(s.repo.getMessage(failed.assistant.id)?.headline, null);
  const quiet = await ask(threadId, 'Fine answer [[no-headline]]');
  assert.equal(s.repo.getMessage(quiet.assistant.id)?.status, 'done', 'the answer is unaffected');
  assert.equal(s.repo.getMessage(quiet.assistant.id)?.headline, null);
});

test('earlier answers get their lines at start-up', async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'An older question');
  s.db.sql.prepare('UPDATE message_revision SET headline = NULL').run();
  assert.ok(s.repo.unheadlined(500).includes(q.assistant.id));
  const n = await s.headliner.backfill(500);
  assert.ok(n >= 1);
  assert.equal(s.repo.getMessage(q.assistant.id)?.headline, 'In short: An older question');
  assert.ok(!s.repo.unheadlined(500).includes(q.assistant.id));
});

test('a side question’s line is written knowing its passage', async () => {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'Main');
  const content = s.repo.getMessage(q1.assistant.id)?.content ?? '';
  const start = content.indexOf('offline fake model');
  const r = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: q1.assistant.id, start, end: start + 'offline fake model'.length },
    question: { id: ulid(), content: 'What is this?' },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  assert.equal(s.repo.getMessage(r.json.assistant.id)?.headline, 'In short: What is this');

  const req = headlineRequest({ question: 'What is this?', answer: 'It is…', passage: 'offline fake model' });
  assert.match(req[1]?.content ?? '', /^It was asked about this passage:\n> offline fake model\n\nQuestion:\nWhat is this\?/);
});

test('the model’s reply is cleaned into one line', () => {
  assert.equal(cleanHeadline('Headline: “梯度指向上升最快的方向，所以下降要反着走。”'), '梯度指向上升最快的方向，所以下降要反着走');
  assert.equal(cleanHeadline('**Batching trades latency for throughput.**\nMore text'), 'Batching trades latency for throughput');
  assert.equal(cleanHeadline('   '), null);
});
