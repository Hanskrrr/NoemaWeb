import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskResponse, type CreateBranchResponse, type ThreadDetail, ulid } from '@noema/core';
import { cleanTitle, titleRequest } from '../src/chat/titles.ts';
import { extraBody } from '../src/llm/openai-compatible.ts';
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

const titleOf = async (id: string) => (await api<ThreadDetail>(s, 'GET', `/api/threads/${id}`)).json.thread.title;

test('model replies become clean one-line titles', () => {
  assert.equal(cleanTitle('Title: “Gradient descent basics”.'), 'Gradient descent basics');
  assert.equal(cleanTitle('**梯度下降的方向**。'), '梯度下降的方向');
  assert.equal(cleanTitle('\n\n# Backprop, briefly\nmore text'), 'Backprop, briefly');
  assert.equal(cleanTitle('标题：类型擦除'), '类型擦除');
  assert.equal(cleanTitle('   '), null);
  const long = cleanTitle('word '.repeat(40)) ?? '';
  assert.ok(long.endsWith('…') && Array.from(long).length === 61);
});

test('a branch title request carries its passage', () => {
  const [system, user] = titleRequest({ question: 'Why?', answer: 'Because.', passage: 'the chain rule' });
  assert.equal(system?.role, 'system');
  assert.match(user?.content ?? '', /^This is a side question about this passage:\n> the chain rule\n\nQuestion:\nWhy\?/);
});

test('titles skip DeepSeek’s thinking step, and nothing extra goes to other providers', () => {
  assert.deepEqual(extraBody('https://api.deepseek.com', { light: true }), { thinking: { type: 'disabled' } });
  assert.deepEqual(extraBody('https://api.deepseek.com', { light: false }), {});
  assert.deepEqual(extraBody('https://api.openai.com/v1', { light: true }), {});
});

test('a thread is titled by the model after its first answer, once', async () => {
  const { threadId } = await newThread(s);
  assert.equal((await ask(threadId, 'What is a Hessian?')).user.content, 'What is a Hessian?');
  assert.equal(await titleOf(threadId), 'About What is a Hessian');
  await ask(threadId, 'And its eigenvalues?');
  assert.equal(await titleOf(threadId), 'About What is a Hessian', 'a later answer must not rename the thread');
  // The model's title is searchable ("About" is only in the title; a title is its own hit when nothing inside matched).
  const hits = await api<{ hits: Array<{ threadId: string; kind: string }> }>(s, 'GET', '/api/search?q=about%20Hessian');
  assert.ok(hits.json.hits.some((h) => h.kind === 'thread' && h.threadId === threadId));
});

test('branches are titled too', async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'Main topic');
  const content = s.repo.getMessage(q.assistant.id)?.content ?? '';
  const start = content.indexOf('fake');
  const b = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: q.assistant.id, start, end: start + 4 },
    question: { id: ulid(), content: 'Why fake?' },
  });
  await readEvents(`${s.base}/api/messages/${b.json.assistant.id}/events`);
  assert.equal(await titleOf(b.json.thread.id), 'About Why fake');
});

test('a title the learner chose is never overwritten', async () => {
  const { threadId } = await newThread(s);
  s.repo.setTitle(threadId, 'My own name', 'user');
  await ask(threadId, 'Anything');
  assert.equal(await titleOf(threadId), 'My own name');
});

test('threads from before AI titles are titled at start', async () => {
  const { threadId } = await newThread(s);
  s.repo.createAsk(threadId, ulid(), 'An old question');
  const [answer] = s.repo.listMessages(threadId).filter((m) => m.role === 'assistant');
  s.repo.finishRevision(answer?.revisionId as string, 'An old answer.', 'done', null);
  assert.ok(s.repo.untitledThreads(100).includes(threadId));
  await s.titler.backfill(100);
  assert.equal(await titleOf(threadId), 'About An old question');
  assert.ok(!s.repo.untitledThreads(100).includes(threadId));
});
