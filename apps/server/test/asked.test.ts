import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskedHit, type AskResponse, type CreateBranchResponse, type ThreadDetail, ulid } from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Asked before: a question about to be asked is checked against the
// notebook, so the learner is pointed at the earlier exchange instead of
// making another thread.

let s: TestServer;
let notebookId: string;
let entropy: { threadId: string; question: string; answer: string };
let side: { threadId: string };
before(async () => {
  s = await startServer();
  const first = await newThread(s);
  notebookId = first.notebookId;
  const r = await ask(first.threadId, 'What is entropy in information theory?');
  entropy = { threadId: first.threadId, question: r.user.id, answer: r.assistant.id };
  // A side question on a passage of the answer: its words say nothing, the passage does.
  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${first.threadId}`)).json;
  const content = detail.messages.find((m) => m.id === r.assistant.id)?.content ?? '';
  const at = content.indexOf('offline fake model');
  const b = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${first.threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: r.assistant.id, start: at, end: at + 18 },
    question: { id: ulid(), content: '这是啥' },
  });
  await readEvents(`${s.base}/api/messages/${b.json.assistant.id}/events`);
  side = { threadId: b.json.thread.id };
  const other = await newThread(s);
  await ask(other.threadId, 'How do I write a binary search?');
});
after(() => s.close());

async function ask(threadId: string, content: string) {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

const asked = async (body: { text: string; passage?: string; threadId?: string }) =>
  (await api<{ hits: AskedHit[] }>(s, 'POST', `/api/notebooks/${notebookId}/asked`, body)).json.hits;

test('a question asked before is found, with where and when, in other words too', async () => {
  const hits = await asked({ text: 'what is entropy?' });
  assert.equal(hits.length, 1);
  const hit = hits[0] as AskedHit;
  assert.equal(hit.messageId, entropy.question);
  assert.equal(hit.threadId, entropy.threadId);
  assert.equal(hit.strength, 'related', 'part of what was asked there');
  assert.equal(hit.question, 'What is entropy in information theory?');
  assert.deepEqual(hit.terms, ['entropy']);
  assert.equal((await asked({ text: 'entropy in information theory: what is it?' }))[0]?.strength, 'same');
  assert.ok(hit.askedAt && hit.threadTitle !== undefined);
  assert.equal((await asked({ text: 'Please explain entropy in information theory' }))[0]?.messageId, entropy.question);
});

test('a different question, and one with nothing to go on, bring nothing', async () => {
  assert.deepEqual(await asked({ text: 'What is a monad?' }), []);
  assert.deepEqual(await asked({ text: 'How do I write a binary tree in Rust?' }), []);
  assert.deepEqual(await asked({ text: '这是什么' }), []);
  assert.deepEqual(await asked({ text: '' }), []);
});

test('a question on a passage is found by its passage; never the thread being asked in, or the ones it came from', async () => {
  // Selecting the same words elsewhere and asking "what is this": the side question already asked it.
  const hits = await asked({ text: 'what is this', passage: 'offline fake model' });
  assert.equal(hits[0]?.threadId, side.threadId);
  assert.equal(hits[0]?.passage, 'offline fake model');
  // From inside that side question, or asking in the thread itself, it is not a reminder.
  assert.deepEqual(await asked({ text: 'what is this', passage: 'offline fake model', threadId: side.threadId }), []);
  assert.deepEqual(await asked({ text: 'what is entropy', threadId: entropy.threadId }), []);
  // But a side question of the entropy thread is not reminded of the thread it came from.
  assert.deepEqual(await asked({ text: 'what is entropy', threadId: side.threadId }), []);
});

test('the Trash does not remind; what was done with a reminder is logged without its words', async () => {
  const gone = await newThread(s);
  await ask(gone.threadId, 'What is a Fourier transform?');
  assert.equal((await asked({ text: 'Fourier transform?' })).length, 1);
  await api(s, 'DELETE', `/api/threads/${gone.threadId}`);
  assert.deepEqual(await asked({ text: 'Fourier transform?' }), []);

  const r = await api(s, 'POST', '/api/asked/events', { action: 'opened', strength: 'same', place: 'thread' });
  assert.equal(r.status, 200);
  const event = s.db.sql.prepare("SELECT data FROM event WHERE type = 'asked_before.opened'").get() as { data: string };
  assert.deepEqual(JSON.parse(event.data), { strength: 'same', place: 'thread', by: 'words' });
  assert.equal((await api(s, 'POST', '/api/asked/events', { action: 'nope', strength: 'same', place: 'thread' })).status, 400);
  assert.equal((await api(s, 'POST', `/api/notebooks/${ulid()}/asked`, { text: 'x' })).status, 404);
});

// By meaning: the model reads the earlier questions. (The fake model knows
// that "heavens" is the sky and "azure" is blue; the word matcher does not.)

const meaning = async (body: { text: string; passage?: string; threadId?: string }) =>
  (await api<{ hits: AskedHit[]; checked: boolean }>(s, 'POST', `/api/notebooks/${notebookId}/asked/meaning`, body)).json;

test('the same question in quite different words is found by meaning, not by words', async () => {
  const sky = await newThread(s);
  const q = await ask(sky.threadId, 'Why is the sky blue?');
  assert.deepEqual(await asked({ text: 'What makes the heavens azure?' }), [], 'no word in common');
  const r = await meaning({ text: 'What makes the heavens azure?' });
  assert.equal(r.checked, true);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]?.messageId, q.user.id);
  assert.equal(r.hits[0]?.strength, 'same');
  assert.equal(r.hits[0]?.by, 'meaning');
  assert.equal(r.hits[0]?.question, 'Why is the sky blue?');
  // In another language too.
  assert.equal((await meaning({ text: '天空为什么是蓝色' })).hits[0]?.messageId, q.user.id);
  // Its subject, another question: related.
  assert.equal((await meaning({ text: 'Are the heavens red?' })).hits[0]?.strength, 'related');
  // A new question: nothing, and it was checked.
  assert.deepEqual(await meaning({ text: 'How do vaccines train the immune system?' }), { hits: [], checked: true });
  // Not from the thread itself, nor in the Trash.
  assert.deepEqual((await meaning({ text: 'What makes the heavens azure?', threadId: sky.threadId })).hits, []);
  await api(s, 'DELETE', `/api/threads/${sky.threadId}`);
  assert.deepEqual((await meaning({ text: 'What makes the heavens azure?' })).hits, []);
  await api(s, 'POST', `/api/threads/${sky.threadId}/restore`);
});

test('when the model cannot be asked, it says so and nothing breaks; what it judged is logged without words', async () => {
  assert.deepEqual(await meaning({ text: 'What makes the heavens azure? [[no-judge]]' }), { hits: [], checked: false });
  assert.deepEqual(await meaning({ text: '   ' }), { hits: [], checked: false });
  assert.equal((await api(s, 'POST', `/api/notebooks/${ulid()}/asked/meaning`, { text: 'x' })).status, 404);
  const rows = s.db.sql.prepare("SELECT data FROM event WHERE type = 'asked_before.judged'").all() as Array<{
    data: string;
  }>;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.deepEqual(Object.keys(JSON.parse(row.data)).sort(), ['entries', 'model', 'related', 'same']);
  }
  const r = await api(s, 'POST', '/api/asked/events', { action: 'opened', strength: 'same', place: 'thread', by: 'meaning' });
  assert.equal(r.status, 200);
});
