import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type AssistantAction,
  type MessageContext,
  type Room,
  type RoomView,
  type Source,
  type Thread,
  ulid,
} from '@noema/core';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

// Rooms (ADR 0026): things of any kind put together by subject. What comes
// with them (the threads about a source, the notes made from a thread) is in
// the room too, as one cluster; it can be taken out. Made-up text only.

let s: TestServer;
let notebookId = '';
const TEXT = '# Week 4\n\nData parallel: every worker holds a copy of the model.\n\nGradients are averaged with an all-reduce.';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
});
after(() => s.close());

async function source(title: string): Promise<Source> {
  return (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), title, text: TEXT })).json;
}
async function askAbout(src: Source, phrase: string, question: string): Promise<Thread> {
  const start = TEXT.indexOf(phrase);
  const r = await api<{ thread: Thread; assistant: AskResponse['assistant'] }>(s, 'POST', `/api/sources/${src.id}/threads`, {
    id: ulid(),
    passage: { versionId: src.latestVersionId, start, end: start + phrase.length },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json.thread;
}
async function thread(question: string): Promise<{ thread: Thread; answer: AskResponse['assistant'] }> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id });
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${id}/messages`, { id: ulid(), content: question });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return { thread: s.repo.getThread(id) as Thread, answer: r.json.assistant };
}
async function sideQuestion(parent: string, messageId: string, question: string): Promise<string> {
  const content = s.repo.getMessage(messageId)?.content ?? '';
  const id = ulid();
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${parent}/branches`, {
    id,
    anchor: { messageId, start: 0, end: Math.min(4, content.length) },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return id;
}
const room = async (id: string) => (await api<RoomView>(s, 'GET', `/api/rooms/${id}`)).json;

test('a room holds a source with what was asked about it, and a note made from a thread, as clusters', async () => {
  const deck = await source('Week 4 slides');
  const t1 = await askAbout(deck, 'every worker holds a copy', 'Why a full copy?');
  const t2 = await askAbout(deck, 'all-reduce', 'What is an all-reduce?');
  const noteId = ulid();
  await api(s, 'POST', `/api/threads/${t1.id}/notes`, { id: noteId });
  await waitFor(() => s.repo.getNote(noteId)?.status !== 'generating');

  const id = ulid();
  const made = await api<Room>(s, 'POST', `/api/notebooks/${notebookId}/rooms`, {
    id,
    title: '  ML systems ',
    items: [{ kind: 'source', id: deck.id }],
  });
  assert.equal(made.status, 201);
  assert.equal(made.json.title, 'ML systems');
  assert.deepEqual(made.json.counts, { sources: 1, threads: 2, notes: 1 });
  // The same id again: the same room.
  assert.equal((await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Other' })).status, 200);

  const v = await room(id);
  assert.equal(v.clusters.length, 1);
  const cards = v.clusters[0]?.cards ?? [];
  assert.equal(cards[0]?.kind, 'source');
  assert.deepEqual(cards[0]?.marks.questions, 2);
  assert.deepEqual(cards[0]?.marks.threads, 2);
  assert.deepEqual(
    cards.slice(1).map((c) => [c.kind, c.explicit, c.via]),
    [
      ['thread', false, `source:${deck.id}`],
      ['thread', false, `source:${deck.id}`],
      ['note', false, `source:${deck.id}`],
    ],
  );
  assert.ok(cards.some((c) => c.id === t2.id && c.quote === 'all-reduce'));

  // Taking out a thread that came with the source: it stays out, with its note.
  const out = await api<Room>(s, 'POST', `/api/rooms/${id}/items/remove`, { kind: 'thread', id: t1.id });
  assert.deepEqual(out.json.counts, { sources: 1, threads: 1, notes: 0 });
  // Put back by hand: in again.
  const back = await api<Room>(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'thread', id: t1.id }] });
  assert.deepEqual(back.json.counts, { sources: 1, threads: 2, notes: 1 });
});

test('a side question goes in as its thread; things are placed, moved, and stay where they were put', async () => {
  const main = await thread('What is pipeline parallelism?');
  const side = await sideQuestion(main.thread.id, main.answer.id, 'What is a bubble?');
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Parallelism' });
  const r = await api<Room>(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'thread', id: side, x: 120, y: 80 }] });
  assert.deepEqual(r.json.members, [`thread:${main.thread.id}`]);
  let v = await room(id);
  assert.deepEqual([v.clusters[0]?.x, v.clusters[0]?.y], [120, 80]);
  assert.deepEqual(v.clusters[0]?.cards[0]?.marks.sides, 1);

  await api(s, 'PUT', `/api/rooms/${id}/places`, { places: [{ kind: 'thread', id: main.thread.id, x: 300.4, y: 40 }] });
  v = await room(id);
  assert.deepEqual([v.clusters[0]?.x, v.clusters[0]?.y], [300, 40]);

  // Renamed, then taken down: the thread is still there.
  assert.equal((await api<Room>(s, 'PATCH', `/api/rooms/${id}`, { title: 'Pipelines' })).json.title, 'Pipelines');
  assert.equal((await api(s, 'DELETE', `/api/rooms/${id}`)).status, 200);
  assert.equal((await api(s, 'GET', `/api/rooms/${id}`)).status, 404);
  assert.ok(s.repo.getThread(main.thread.id));
});

test('the rooms are listed in the order made, each with what is in it; wrong things are refused', async () => {
  const list = (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;
  assert.deepEqual(list.map((r) => r.title), ['ML systems']);
  const id = list[0]?.id as string;
  const missing = await api<{ error: { message: string } }>(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: ulid() }] });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error.message, /not in this notebook/);
  assert.equal((await api(s, 'POST', `/api/rooms/${ulid()}/items`, { items: [{ kind: 'note', id: ulid() }] })).status, 404);
  assert.equal((await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id: ulid(), title: '   ' })).status, 400);
});

test('a thing in the Trash is not drawn; back from the Trash, it is in its room again', async () => {
  const t = await thread('What is ZeRO?');
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Memory', items: [{ kind: 'thread', id: t.thread.id }] });
  await api(s, 'DELETE', `/api/threads/${t.thread.id}`);
  assert.equal((await room(id)).clusters.length, 0);
  await api(s, 'POST', `/api/threads/${t.thread.id}/restore`);
  assert.deepEqual((await room(id)).clusters.map((c) => c.key), [`thread:${t.thread.id}`]);
});

async function askAssistant(content: string) {
  const me = (await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json;
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${me.id}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const tools = ((await api<MessageContext>(s, 'GET', `/api/messages/${r.json.assistant.id}/context`)).json.request ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);
  const actions = (await api<{ actions: AssistantAction[] }>(s, 'GET', `/api/threads/${me.id}/actions`)).json.actions.filter(
    (a) => a.messageId === r.json.assistant.id,
  );
  return { tools, actions };
}
const act = async (a: AssistantAction, what: 'run' | 'undo') =>
  (await api<{ action: AssistantAction }>(s, 'POST', `/api/assistant/actions/${a.id}/${what}`, {})).json.action;
const rooms = async () => (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;

test('the Assistant sees the rooms and what is in them, and puts things in one on Do it, with Undo', async () => {
  const listed = await askAssistant('Rooms [[list:rooms]] [[list:sources]]');
  assert.match(listed.tools[0] ?? '', /^Rooms: 2\. .*\nRoom “ML systems”: 1 sources, 2 threads, 1 notes\.\n- \[\d+\] Source “Week 4 slides”/s);
  const deck = /\[(\d+)\] “Week 4 slides”/.exec(listed.tools[1] ?? '')?.[1];
  assert.ok(deck);

  // An existing room, named in other letters: the same room.
  const into = await askAssistant(`Put [[list:sources]] [[call:put_in_room:{"refs":[${deck}],"room":"memory"}]]`);
  assert.equal(into.actions[0]?.summary, 'Put “Week 4 slides” in the room “Memory”');
  const memory = (await rooms()).find((r) => r.title === 'Memory') as Room;
  assert.ok(!memory.members.some((k) => k.startsWith('source:')), 'nothing before Do it');
  const done = await act(into.actions[0] as AssistantAction, 'run');
  assert.equal(done.status, 'done');
  assert.ok((await rooms()).find((r) => r.id === memory.id)?.members.some((k) => k.startsWith('source:')));
  await act(done, 'undo');
  assert.ok(!(await rooms()).find((r) => r.id === memory.id)?.members.some((k) => k.startsWith('source:')));

  // A name no room has: a new room, gone again on Undo.
  const made = await askAssistant(`New [[list:sources]] [[call:put_in_room:{"refs":[${deck}],"room":"Systems reading"}]]`);
  assert.equal(made.actions[0]?.summary, 'Make the room “Systems reading” with “Week 4 slides”');
  const ran = await act(made.actions[0] as AssistantAction, 'run');
  assert.ok((await rooms()).some((r) => r.title === 'Systems reading'));
  await act(ran, 'undo');
  assert.ok(!(await rooms()).some((r) => r.title === 'Systems reading'));
});

test('a notebook from before rooms upgrades in place, with no rooms', () => {
  const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v18 = join(dir, 'v18');
  mkdirSync(v18);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= 18)) {
    copyFileSync(join(MIGRATIONS, f), join(v18, f));
  }
  const file = join(dir, 'n.db');
  const old = new Db(file);
  old.migrate(v18);
  assert.equal(old.version, 18);
  const t = new Date().toISOString();
  const nb = ulid();
  old.sql.prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(nb, 'N', '', t, t);
  old.close();
  const db = new Db(file);
  db.migrate();
  const repo = new Repo(db);
  assert.deepEqual(repo.listRooms(nb), []);
  const { room } = repo.createRoom(ulid(), nb, 'After');
  assert.equal(repo.listRooms(nb)[0]?.id, room.id);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
