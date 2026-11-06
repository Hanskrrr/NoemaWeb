import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type DeleteThreadResponse,
  type Note,
  type OpenBranchesResponse,
  type SearchResponse,
  type Thread,
  type ThreadDetail,
  type Trash,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// The Trash: deleting a thread or a note hides it everywhere and keeps it,
// so restoring brings it back as it was. A thread takes its side questions
// along; threads that became their own stay.

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

const listed = async (notebookId: string) =>
  (await api<{ threads: Thread[] }>(s, 'GET', `/api/notebooks/${notebookId}/threads`)).json.threads.map((t) => t.id);
const trashOf = async (notebookId: string) => (await api<Trash>(s, 'GET', `/api/notebooks/${notebookId}/trash`)).json;
const search = async (q: string) =>
  (await api<SearchResponse>(s, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).json.hits;

test('a deleted thread takes its side questions to the Trash; its own threads stay; restore brings it all back', async () => {
  const { threadId, notebookId } = await newThread(s);
  const q1 = await ask(threadId, 'About the wombat burrow');
  const side = await branch(threadId, q1.assistant.id, 'offline fake model', 'A side question about numbats');
  const deeper = await branch(side.thread.id, side.assistant.id, 'offline fake model', 'Deeper, about bilbies');
  const own = await branch(threadId, q1.assistant.id, 'every question', 'One that became its own thread');
  await api(s, 'POST', `/api/threads/${own.thread.id}/split`, { split: true });
  const q2 = await ask(threadId, 'A second subject, quolls');
  const cont = await api<Thread>(s, 'POST', `/api/threads/${threadId}/split-off`, { id: ulid(), messageId: q2.user.id });

  const r = await api<DeleteThreadResponse>(s, 'DELETE', `/api/threads/${threadId}`);
  assert.deepEqual(r.json, { ok: true, deleted: 3 }, 'the thread and its two side questions');

  // Gone from the list, search and the side questions left open; the own and the split-off thread stay.
  const ids = await listed(notebookId);
  for (const id of [threadId, side.thread.id, deeper.thread.id]) assert.ok(!ids.includes(id));
  assert.ok(ids.includes(own.thread.id) && ids.includes(cont.json.id));
  assert.equal((await search('numbats')).length, 0);
  assert.equal((await search('wombat')).length, 0);
  assert.ok((await search('quolls')).some((h) => h.threadId === cont.json.id), 'what moved out is still found');
  const open = (await api<OpenBranchesResponse>(s, 'GET', `/api/notebooks/${notebookId}/open-branches`)).json;
  assert.ok(!open.branches.some((b) => b.threadId === side.thread.id || b.threadId === deeper.thread.id));
  assert.deepEqual((await trashOf(notebookId)).threads.map((t) => [t.threadId, t.sideQuestions]), [[threadId, 2]]);

  // Still readable, marked; but nothing new is asked in it until it is restored.
  const d = (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json;
  assert.ok(d.thread.deletedAt);
  assert.equal(d.messages.length, 2, "its own two (the second subject moved out)");
  assert.equal(
    (await api(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: 'More?' })).status,
    409,
  );
  assert.equal(
    (await api(s, 'POST', `/api/threads/${side.thread.id}/messages`, { id: ulid(), content: 'More?' })).status,
    409,
  );
  // The own thread works as before.
  await ask(own.thread.id, 'Still mine');
  assert.equal((await api<DeleteThreadResponse>(s, 'DELETE', `/api/threads/${threadId}`)).json.deleted, 0, 'once');

  const back = await api<Thread>(s, 'POST', `/api/threads/${threadId}/restore`);
  assert.equal(back.json.deletedAt, null);
  const after = await listed(notebookId);
  for (const id of [threadId, side.thread.id, deeper.thread.id]) assert.ok(after.includes(id));
  assert.ok((await search('numbats')).some((h) => h.threadId === side.thread.id));
  assert.deepEqual((await trashOf(notebookId)).threads, []);
  await ask(threadId, 'Asking again works');
});

test('restoring a side question whose thread is in the Trash brings that thread back too', async () => {
  const { threadId, notebookId } = await newThread(s);
  const q1 = await ask(threadId, 'Main');
  const side = await branch(threadId, q1.assistant.id, 'offline fake model', 'Side');
  assert.equal((await api<DeleteThreadResponse>(s, 'DELETE', `/api/threads/${side.thread.id}`)).json.deleted, 1);
  assert.equal((await api<DeleteThreadResponse>(s, 'DELETE', `/api/threads/${threadId}`)).json.deleted, 1, 'already gone');
  assert.deepEqual(
    (await trashOf(notebookId)).threads.map((t) => t.threadId),
    [threadId, side.thread.id],
    'two items, last deleted first',
  );
  await api(s, 'POST', `/api/threads/${side.thread.id}/restore`);
  const ids = await listed(notebookId);
  assert.ok(ids.includes(side.thread.id) && ids.includes(threadId));
  assert.equal((await api(s, 'POST', `/api/threads/${ulid()}/restore`)).status, 404);
  assert.equal((await api(s, 'DELETE', `/api/threads/${ulid()}`)).status, 404);
});

test('a deleted note leaves the list and search, cannot be changed, and comes back as it was', async () => {
  const { notebookId } = await newThread(s);
  const note = (await api<Note>(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: ulid(), title: 'Platypus' })).json;
  const block = ulid();
  await api(s, 'POST', `/api/notes/${note.id}/blocks`, { id: block, after: null, content: 'Echidnas lay eggs.' });

  assert.equal((await api(s, 'DELETE', `/api/notes/${note.id}`)).status, 200);
  const list = (await api<{ notes: Note[] }>(s, 'GET', `/api/notebooks/${notebookId}/notes`)).json.notes;
  assert.ok(!list.some((n) => n.id === note.id));
  assert.equal((await search('echidnas')).length, 0);
  assert.deepEqual((await trashOf(notebookId)).notes.map((n) => [n.noteId, n.title]), [[note.id, 'Platypus']]);
  const shown = (await api<Note>(s, 'GET', `/api/notes/${note.id}`)).json;
  assert.ok(shown.deletedAt);
  assert.equal(shown.blocks.length, 1);
  assert.equal((await api(s, 'PATCH', `/api/notes/${note.id}/blocks/${block}`, { content: 'x' })).status, 409);

  const back = (await api<Note>(s, 'POST', `/api/notes/${note.id}/restore`)).json;
  assert.equal(back.deletedAt, null);
  assert.deepEqual(back.blocks.map((b) => b.content), ['Echidnas lay eggs.']);
  assert.ok((await search('echidnas')).some((h) => h.blockId === block));
  assert.equal((await api(s, 'DELETE', `/api/notes/${ulid()}`)).status, 404);
});
