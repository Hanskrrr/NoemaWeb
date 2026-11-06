import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type Note,
  type Thread,
  Thread as ThreadSchema,
  type ThreadMap,
  ulid,
} from '@noema/core';
import { buildOutline, splitTitle } from '../src/chat/notes.ts';
import { api, newThread, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

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

async function branch(parentId: string, messageId: string, phrase: string, question: string) {
  const content = s.repo.getMessage(messageId)?.content ?? '';
  const start = content.indexOf(phrase);
  const r = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${parentId}/branches`, {
    id: ulid(),
    anchor: { messageId, start, end: start + phrase.length },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

/** Main thread with two exchanges, a branch from the first answer, and a branch of that branch. */
async function journey() {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'What is backprop?');
  const q2 = await ask(threadId, 'And Adam?');
  const b1 = await branch(threadId, q1.assistant.id, 'offline fake model', 'Why offline?');
  const b2 = await branch(b1.thread.id, b1.assistant.id, 'every question', 'Every one?');
  return { threadId, q1, q2, b1, b2 };
}

test('the learner can rename a thread, and the AI never renames it back', async () => {
  const { threadId } = await newThread(s);
  await ask(threadId, 'Name me');
  const r = await api<Thread>(s, 'PATCH', `/api/threads/${threadId}`, { title: '  My chain-rule notes  ' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.title, r.json.titleSource], ['My chain-rule notes', 'user']);
  await ask(threadId, 'Another question');
  assert.equal(s.repo.getThread(threadId)?.title, 'My chain-rule notes');
  assert.equal((await api(s, 'PATCH', `/api/threads/${threadId}`, { title: '   ' })).status, 400);
});

test('every way of getting a thread answers in the contract’s shape', async () => {
  const created = await api<{ id: string }>(s, 'POST', `/api/notebooks/${s.repo.ensureDefaultNotebook().id}/threads`, {
    id: ulid(),
  });
  assert.equal(created.status, 201);
  ThreadSchema.parse(created.json);
  const { threadId, b1 } = await journey();
  ThreadSchema.parse(s.repo.getThread(threadId));
  ThreadSchema.parse(b1.thread);
  ThreadSchema.parse((await api(s, 'POST', `/api/threads/${b1.thread.id}/split`, { split: true })).json);
});

test('the thread list carries each branch’s passage for the sidebar', async () => {
  const { threadId, b1 } = await journey();
  const list = await api<{ threads: Thread[] }>(s, 'GET', `/api/notebooks/${s.repo.getThread(threadId)?.notebookId}/threads`);
  const b = list.json.threads.find((t) => t.id === b1.thread.id);
  assert.equal(b?.originQuote, 'offline fake model');
  assert.equal(list.json.threads.find((t) => t.id === threadId)?.originQuote, null);
});

test('every thread has its own map: the branches below it, and the way up', async () => {
  const { threadId, q1, q2, b1, b2 } = await journey();
  const whole = (await api<ThreadMap>(s, 'GET', `/api/threads/${threadId}/map`)).json;
  assert.deepEqual([whole.root.threadId, whole.path, whole.parent], [threadId, [], null]);
  const root = whole.root;
  assert.deepEqual(
    root.exchanges.map((e) => [e.index, e.question, e.questionId, e.answerId]),
    [
      [1, 'What is backprop?', q1.user.id, q1.assistant.id],
      [2, 'And Adam?', q2.user.id, q2.assistant.id],
    ],
  );
  assert.match(root.exchanges[0]?.gist ?? '', /^You asked: "What is backprop\?"/);
  const first = root.exchanges[0]?.branches ?? [];
  assert.deepEqual(
    first.map((n) => [n.threadId, n.origin?.exact, n.origin?.messageId, n.split]),
    [[b1.thread.id, 'offline fake model', q1.assistant.id, false]],
  );
  assert.equal(root.exchanges[1]?.branches.length, 0);
  const nested = first[0]?.exchanges[0]?.branches ?? [];
  assert.deepEqual(
    nested.map((n) => [n.threadId, n.origin?.exact]),
    [[b2.thread.id, 'every question']],
  );

  // From a branch: that branch and what is below it, with the way up.
  const r = await api<ThreadMap>(s, 'GET', `/api/threads/${b1.thread.id}/map`);
  assert.equal(r.status, 200);
  assert.equal(r.json.root.threadId, b1.thread.id);
  assert.deepEqual(r.json.root.exchanges.map((e) => e.question), ['Why offline?']);
  assert.deepEqual(r.json.root.exchanges[0]?.branches.map((n) => n.threadId), [b2.thread.id]);
  assert.deepEqual(r.json.path.map((p) => p.threadId), [threadId]);
  assert.equal(r.json.parent?.threadId, threadId);
  const deep = (await api<ThreadMap>(s, 'GET', `/api/threads/${b2.thread.id}/map`)).json;
  assert.deepEqual(deep.path.map((p) => p.threadId), [threadId, b1.thread.id]);
});

test('the rewrite outline numbers every exchange, branches included, in reading order', async () => {
  const { threadId, q1, q2, b1, b2 } = await journey();
  const { text, refs } = buildOutline(s.repo, threadId);
  assert.deepEqual(
    [...refs.entries()].map(([label, r]) => [label, r.messageId]),
    [
      ['E1', q1.assistant.id],
      ['E2', b1.assistant.id],
      ['E3', b2.assistant.id],
      ['E4', q2.assistant.id],
    ],
  );
  assert.match(text, /Side question opened from E1, about the passage: "offline fake model"/);
  assert.match(text, /Side question opened from E2, about the passage: "every question"/);
});

test('rewrite as a note: written by the server, cited, in blocks, with every version kept', async () => {
  const { threadId, q1, b1 } = await journey();
  const id = ulid();
  const created = await api<Note>(s, 'POST', `/api/threads/${threadId}/notes`, { id });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'generating');
  assert.equal((await api<Note>(s, 'POST', `/api/threads/${threadId}/notes`, { id })).status, 200);

  await waitFor(() => s.repo.getNote(id)?.status === 'done', 5000);
  const note = (await api<Note>(s, 'GET', `/api/notes/${id}`)).json;
  assert.equal(note.author, 'ai');
  assert.equal(note.revision, 1);
  // The model's heading becomes the note's title and leaves the body.
  assert.equal(note.title, 'Study note');
  assert.ok(note.content.startsWith('The main idea'));
  // The text is split into blocks, each written by the AI.
  assert.deepEqual(
    note.blocks.map((b) => [b.content.split('\n')[0], b.author]),
    [
      ['The main idea, from the first question [E1].', 'ai'],
      ['- A detail that came from a side question [E2].', 'ai'],
      ['## Open questions', 'ai'],
      ['- None yet.', 'ai'],
    ],
  );
  // Citations stay plain labels in the text; the note maps each to its exact message.
  assert.deepEqual(note.refs.E1, { threadId, messageId: q1.assistant.id });
  assert.deepEqual(note.refs.E2, { threadId: b1.thread.id, messageId: b1.assistant.id });
  assert.equal(Object.keys(note.refs).length, 4);

  const renamed = await api<Note>(s, 'PATCH', `/api/notes/${id}`, { title: 'Chain rule, my way' });
  assert.deepEqual([renamed.json.title, renamed.json.revision], ['Chain rule, my way', 2]);
  assert.equal((await api(s, 'PATCH', `/api/notes/${id}`, { content: 'whole text' })).status, 400);

  const again = await api<Note>(s, 'POST', `/api/notes/${id}/rewrite`, {});
  assert.equal(again.status, 202);
  assert.deepEqual(again.json.blocks, [], 'blocks are hidden while the whole note is rewritten');
  await waitFor(() => s.repo.getNote(id)?.status === 'done', 5000);
  // The learner named it, so the title stays theirs.
  assert.equal(s.repo.getNote(id)?.title, 'Chain rule, my way');
  assert.equal(s.repo.getNote(id)?.blocks.length, 4);
  const history = await api<{ revisions: Array<{ n: number; author: string; change: string }> }>(
    s,
    'GET',
    `/api/notes/${id}/history`,
  );
  assert.deepEqual(
    history.json.revisions.map((r) => [r.n, r.author, r.change]),
    [
      [1, 'ai', 'AI wrote the note'],
      [2, 'user', 'renamed the note'],
      [3, 'ai', 'AI wrote the note'],
    ],
  );
  const list = await api<{ notes: Array<{ id: string; threadId: string }> }>(
    s,
    'GET',
    `/api/notebooks/${note.notebookId}/notes`,
  );
  assert.ok(list.json.notes.some((n) => n.id === id && n.threadId === threadId));
  assert.ok(list.json.notes.every((n) => !('content' in n) && !('refs' in n) && !('blocks' in n)));
});

test('a note title comes from the heading the model starts with', () => {
  assert.deepEqual(splitTitle('# Gradient **descent** ##\n\nThe body [E1].'), {
    title: 'Gradient descent',
    body: 'The body [E1].',
  });
  assert.deepEqual(splitTitle('  # 梯度下降\r\n正文'), { title: '梯度下降', body: '正文' });
  assert.deepEqual(splitTitle('No heading first\n# Later'), { title: null, body: 'No heading first\n# Later' });
  assert.deepEqual(splitTitle('## A section\nx'), { title: null, body: '## A section\nx' });
  assert.deepEqual(splitTitle('#hashtag'), { title: null, body: '#hashtag' });
});

test('a note cut off by a restart is marked failed with its text kept', async () => {
  const { threadId } = await newThread(s);
  await ask(threadId, 'Something');
  const id = ulid();
  s.repo.startNote(id, s.repo.getThread(threadId)?.notebookId as string, threadId, 'T');
  s.repo.saveNoteContent(id, 'Half a note');
  assert.equal(s.repo.recoverNotes().failed, 1);
  const note = s.repo.getNote(id);
  assert.deepEqual([note?.status, note?.content], ['failed', 'Half a note']);
  // What arrived is kept as blocks, so it can be edited.
  assert.deepEqual(note?.blocks.map((b) => b.content), ['Half a note']);
  assert.match(note?.error ?? '', /stopped before/);
});

test('a note cannot be changed while the AI writes it', async () => {
  const { threadId } = await newThread(s);
  await ask(threadId, 'Busy');
  const id = ulid();
  s.repo.startNote(id, s.repo.getThread(threadId)?.notebookId as string, threadId, 'T');
  const r = await api(s, 'POST', `/api/notes/${id}/blocks`, { id: ulid(), after: null, content: 'x' });
  assert.equal(r.status, 409);
  s.repo.finishNote(id, '', 'failed', 'test');
});
