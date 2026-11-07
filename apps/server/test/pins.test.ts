import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  describeSent,
  MAX_PINS,
  type MessageContext,
  type Pin,
  type SourceDetail,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Pins: a passage kept in front of the AI. It is sent with every question in
// the thread it was pinned to, and in that thread's side questions, until it
// is unpinned; What was sent shows it as its own part.

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

async function ask(threadId: string, content: string) {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json.messages.find(
    (m) => m.id === r.json.assistant.id,
  ) as ThreadDetail['messages'][number] & { id: string };
}

const sent = async (messageId: string) => {
  const c = (await api<MessageContext>(s, 'GET', `/api/messages/${messageId}/context`)).json;
  return { system: c.request?.[0]?.content ?? '', parts: describeSent(c.manifest, c.request ?? []) };
};

const pinsOf = async (threadId: string) =>
  (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json.pins;

test('a pinned passage of an answer is sent with every later question, until unpinned', async () => {
  const { threadId } = await newThread(s);
  const answer = await ask(threadId, 'What is attention?');
  const at = answer.content.indexOf('offline fake model');
  const id = ulid();
  const body = { id, message: { messageId: answer.id, start: at, end: at + 18 } };
  const r = await api<Pin>(s, 'POST', `/api/threads/${threadId}/pins`, body);
  assert.equal(r.status, 201);
  assert.equal(r.json.exact, 'offline fake model');
  assert.equal(r.json.message?.revisionId, answer.revisionId);
  assert.equal((await api(s, 'POST', `/api/threads/${threadId}/pins`, body)).status, 200, 'sending twice pins once');
  assert.deepEqual(
    (await pinsOf(threadId)).map((p) => p.id),
    [id],
  );

  const next = await ask(threadId, 'And self-attention?');
  const { system, parts } = await sent(next.id);
  assert.ok(system.includes('## Passages the learner pinned'));
  assert.ok(system.includes('> offline fake model'));
  assert.ok(parts.some((p) => p.kind === 'pinned' && p.text.includes('offline fake model')));

  assert.equal((await api(s, 'DELETE', `/api/pins/${id}`)).status, 200);
  assert.equal((await api(s, 'DELETE', `/api/pins/${id}`)).status, 404);
  assert.deepEqual(await pinsOf(threadId), []);
  const after = await ask(threadId, 'And cross-attention?');
  assert.ok(!(await sent(after.id)).system.includes('Passages the learner pinned'));
  // The answer asked with the pin still shows it: what was sent is kept.
  assert.ok((await sent(next.id)).system.includes('> offline fake model'));
});

test('side questions have the pins of the threads they came from; their own stay theirs', async () => {
  const { threadId } = await newThread(s);
  const answer = await ask(threadId, 'What is a norm?');
  const at = answer.content.indexOf('offline');
  await api(s, 'POST', `/api/threads/${threadId}/pins`, {
    id: ulid(),
    message: { messageId: answer.id, start: at, end: at + 7 },
  });
  const side = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: answer.id, start: at, end: at + 7 },
    question: { id: ulid(), content: 'Why offline?' },
  });
  await readEvents(`${s.base}/api/messages/${side.json.assistant.id}/events`);
  const sideId = side.json.thread.id;
  assert.ok((await sent(side.json.assistant.id)).system.includes('> offline'), 'inherited');
  const own = await api<Pin>(s, 'POST', `/api/threads/${sideId}/pins`, {
    id: ulid(),
    message: { messageId: side.json.user.id, start: 0, end: 3 },
  });
  assert.equal(own.status, 201);
  assert.deepEqual(
    (await pinsOf(sideId)).map((p) => p.threadId),
    [threadId, sideId],
    'the parent’s first',
  );
  assert.equal((await pinsOf(threadId)).length, 1, 'the side question’s pin is not the parent’s');
  // Made its own thread, it keeps only its own.
  await api(s, 'POST', `/api/threads/${sideId}/split`, { split: true });
  assert.deepEqual(
    (await pinsOf(sideId)).map((p) => p.threadId),
    [sideId],
  );
});

test('a passage of a source can be pinned to a thread', async () => {
  const { notebookId, threadId } = await newThread(s);
  const text = '# Notes\n\nThe softmax turns scores into weights.';
  const source = await api<{ id: string }>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text });
  const detail = (await api<SourceDetail>(s, 'GET', `/api/sources/${source.json.id}`)).json;
  const at = text.indexOf('softmax');
  const r = await api<Pin>(s, 'POST', `/api/threads/${threadId}/pins`, {
    id: ulid(),
    source: { versionId: detail.version.id, start: at, end: at + 7 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.source?.sourceId, source.json.id);
  assert.equal(r.json.exact, 'softmax');
  const answer = await ask(threadId, 'What does it do?');
  assert.ok((await sent(answer.id)).system.includes(`From "${detail.source.title}", which they are reading:\n\n> softmax`));
});

test('pins are refused with reasons: a bad range, both or neither, too many, the Trash', async () => {
  const { threadId } = await newThread(s);
  const answer = await ask(threadId, 'What is a tensor?');
  const pin = (start: number, end: number) =>
    api(s, 'POST', `/api/threads/${threadId}/pins`, { id: ulid(), message: { messageId: answer.id, start, end } });
  assert.equal((await pin(0, answer.content.length + 10)).status, 400);
  assert.equal((await api(s, 'POST', `/api/threads/${threadId}/pins`, { id: ulid() })).status, 400);
  assert.equal((await api(s, 'POST', `/api/threads/${ulid()}/pins`, { id: ulid(), message: { messageId: answer.id, start: 0, end: 3 } })).status, 404);
  for (let i = 0; i < MAX_PINS; i++) assert.equal((await pin(i, i + 3)).status, 201);
  const tooMany = await api<{ error: { message: string } }>(s, 'POST', `/api/threads/${threadId}/pins`, {
    id: ulid(),
    message: { messageId: answer.id, start: 0, end: 2 },
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error.message, /unpin one first/);
  const one = (await pinsOf(threadId))[0] as Pin;
  await api(s, 'DELETE', `/api/threads/${threadId}`);
  assert.equal((await pin(0, 2)).status, 409, 'not in the Trash');
  assert.equal((await api(s, 'DELETE', `/api/pins/${one.id}`)).status, 409);
});
