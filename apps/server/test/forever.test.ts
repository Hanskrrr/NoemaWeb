import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type Note,
  type Room,
  type SearchResponse,
  type Source,
  type SourceDetail,
  type Thread,
  type ThreadDetail,
  type Trash,
  ulid,
} from '@noema/core';
import { api, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

// Deleting for good (ADR 0034): a thread (with the side questions still its
// own), a source or a note goes from the notebook, in the Trash or not, with
// no Undo. What only pointed at it stays and lets go of it: a side question
// made its own thread, threads asked about a source, notes made from a
// thread. Its places in rooms, its links, its summaries and its words in
// search go. Made-up text.

let s: TestServer;
let notebookId = '';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
});
after(() => s.close());

async function thread(question: string): Promise<{ id: string; answer: string }> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id });
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${id}/messages`, { id: ulid(), content: question });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return { id, answer: r.json.assistant.id };
}
async function sideQuestion(threadId: string, answerId: string, question: string): Promise<string> {
  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json;
  const content = detail.messages.find((m) => m.id === answerId)?.content ?? '';
  const at = content.indexOf('offline fake model');
  const b = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: answerId, start: at, end: at + 18 },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${b.json.assistant.id}/events`);
  return b.json.thread.id;
}
const found = async (q: string) => (await api<SearchResponse>(s, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).json.hits;
const room = async (id: string) => (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms.find((r) => r.id === id);
const trash = async () => (await api<Trash>(s, 'GET', `/api/notebooks/${notebookId}/trash`)).json;

test('a thread goes for good with its side questions; one made its own stays, and so does a note made from it', async () => {
  const t = await thread('Why does the quokkafish glow?');
  const side = await sideQuestion(t.id, t.answer, 'And underwater?');
  const own = await sideQuestion(t.id, t.answer, 'Its own thread?');
  await api(s, 'POST', `/api/threads/${own}/split`, { split: true });
  const deep = await sideQuestion(side, (await api<ThreadDetail>(s, 'GET', `/api/threads/${side}`)).json.messages[1]?.id as string, 'Deeper?');
  // A note from it, a room with it, a link, a pin.
  const noteId = ulid();
  await api(s, 'POST', `/api/threads/${t.id}/notes`, { id: noteId });
  await waitFor(() => s.repo.getNote(noteId)?.status === 'done', 5000);
  const other = await thread('Something else entirely');
  const roomId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, {
    id: roomId,
    title: 'Glowing fish',
    items: [
      { kind: 'thread', id: t.id },
      { kind: 'thread', id: other.id },
    ],
  });
  const linkId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/links`, {
    id: linkId,
    from: { kind: 'thread', id: t.id },
    to: { kind: 'thread', id: other.id },
    kind: 'related',
  });
  assert.ok((await found('quokkafish')).length > 0);

  const gone = await api<{ deleted: number }>(s, 'DELETE', `/api/threads/${t.id}/forever`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.deleted, 3, 'it, its side question and the one under that');
  for (const id of [t.id, side, deep]) assert.equal((await api(s, 'GET', `/api/threads/${id}`)).status, 404);
  // Made its own: stays, no longer under it.
  const left = (await api<ThreadDetail>(s, 'GET', `/api/threads/${own}`)).json;
  assert.equal(left.thread.parentThreadId, null);
  assert.equal(left.messages.length, 2);
  // The note stays.
  const note = (await api<Note>(s, 'GET', `/api/notes/${noteId}`)).json;
  assert.equal(note.threadId, null);
  // Out of the room, the link gone, nothing found by its words.
  assert.deepEqual((await room(roomId))?.members, [`thread:${other.id}`, `note:${noteId}`], 'the note came into the room with it, and stays');
  assert.equal(s.repo.getItemLink(linkId), null);
  assert.deepEqual(await found('quokkafish'), []);
  // Again: not there.
  assert.equal((await api(s, 'DELETE', `/api/threads/${t.id}/forever`)).status, 404);
});

test('from the Trash too; then it is no longer in the Trash', async () => {
  const t = await thread('A question to throw away');
  await api(s, 'DELETE', `/api/threads/${t.id}`);
  assert.ok((await trash()).threads.some((x) => x.threadId === t.id));
  assert.equal((await api(s, 'DELETE', `/api/threads/${t.id}/forever`)).status, 200);
  assert.ok(!(await trash()).threads.some((x) => x.threadId === t.id));
});

test('a source goes for good; the thread asked about its passage stays, no longer tied to it', async () => {
  const text = '# Bioluminescence\n\nThe lanternbloom makes light with luciferin.';
  const source = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text })).json;
  const detail = (await api<SourceDetail>(s, 'GET', `/api/sources/${source.id}`)).json;
  const p = text.indexOf('luciferin');
  const about = await api<CreateBranchResponse>(s, 'POST', `/api/sources/${source.id}/threads`, {
    id: ulid(),
    passage: { versionId: detail.version.id, start: p, end: p + 9 },
    question: { id: ulid(), content: 'What is luciferin?' },
  });
  await readEvents(`${s.base}/api/messages/${about.json.assistant.id}/events`);
  const roomId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id: roomId, title: 'Light', items: [{ kind: 'source', id: source.id }] });
  assert.ok((await found('lanternbloom')).length > 0);

  assert.equal((await api(s, 'DELETE', `/api/sources/${source.id}/forever`)).status, 200);
  assert.equal((await api(s, 'GET', `/api/sources/${source.id}`)).status, 404);
  const asked = (await api<ThreadDetail>(s, 'GET', `/api/threads/${about.json.thread.id}`)).json;
  assert.equal(asked.thread.sourceId, null);
  assert.equal(asked.messages.length, 2);
  assert.deepEqual((await room(roomId))?.members, [`thread:${about.json.thread.id}`], 'the thread came into the room with it, and stays');
  assert.deepEqual(await found('lanternbloom'), []);
});

test('a note goes for good, with its blocks; a note being written waits', async () => {
  const noteId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: noteId, title: 'Glow notes' });
  await api(s, 'POST', `/api/notes/${noteId}/blocks`, { id: ulid(), after: null, content: 'Photophores are the glowing organs.' });
  assert.ok((await found('photophores')).length > 0);
  assert.equal((await api(s, 'DELETE', `/api/notes/${noteId}/forever`)).status, 200);
  assert.equal((await api(s, 'GET', `/api/notes/${noteId}`)).status, 404);
  assert.deepEqual(await found('photophores'), []);

  const t = await thread('Notes on waiting');
  const writing = ulid();
  s.repo.startNote(writing, notebookId, t.id, 'Being written');
  const r = await api<{ error: { message: string } }>(s, 'DELETE', `/api/notes/${writing}/forever`);
  assert.equal(r.status, 409);
});

test('the Assistant is not a thread to delete', async () => {
  const me = (await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json;
  assert.equal((await api(s, 'DELETE', `/api/threads/${me.id}/forever`)).status, 400);
});
