import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskResponse, type AssistantAction, type MessageContext, type Room, type RoomView, type Source, type Thread, ulid } from '@noema/core';
import { api, readEvents, startServer, type TestServer } from './helpers.ts';

// Rooms in rooms (ADR 0032): a room put in other rooms, as a door: a small
// field inside a bigger one. One room, many homes, no copies, never inside
// itself. The bigger room's brief is written from its rooms' briefs. Fake
// model, made-up text.

let s: TestServer;
let notebookId = '';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
  // These tests are of changes proposed for the learner's Do it (ADR 0024); acting on its own is in assistant-acts.test.ts.
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { assistantAsks: true });
});
after(() => s.close());

const view = async (id: string) => (await api<RoomView>(s, 'GET', `/api/rooms/${id}`)).json;
const rooms = async () => (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;
const roomOf = async (id: string) => (await rooms()).find((r) => r.id === id) as Room;
async function makeRoom(title: string, items: Array<{ kind: 'thread' | 'source' | 'note'; id: string }> = []): Promise<string> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title, items });
  return id;
}
const putIn = (parent: string, child: string, at: { x?: number; y?: number } = {}) =>
  api<Room & { error?: { message: string } }>(s, 'POST', `/api/rooms/${parent}/rooms`, { room: child, ...at });
async function thread(question: string): Promise<string> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id });
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${id}/messages`, { id: ulid(), content: question });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return id;
}
async function read(id: string): Promise<RoomView> {
  assert.equal((await api(s, 'POST', `/api/rooms/${id}/read`, {})).status, 202);
  const start = Date.now();
  let v = await view(id);
  while (v.reading && v.reading.phase !== 'done' && v.reading.phase !== 'failed') {
    if (Date.now() - start > 5000) throw new Error('reading did not finish');
    await new Promise((r) => setTimeout(r, 20));
    v = await view(id);
  }
  return v;
}

test('a room goes in a bigger room as a door, and in more than one; what is in it stays in it', async () => {
  const t = await thread('Why are activations saved?');
  const ml = await makeRoom('Machine learning');
  const systems = await makeRoom('ML systems', [{ kind: 'thread', id: t }]);
  const hardware = await makeRoom('Hardware');

  const put = await putIn(ml, systems, { x: 400, y: 24 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.rooms, [systems]);
  assert.equal(put.json.counts.rooms, 1);
  assert.deepEqual(put.json.members, [], 'its contents are not spilled into the bigger room');
  assert.equal((await putIn(hardware, systems)).status, 200);
  assert.deepEqual((await roomOf(systems)).parents, [ml, hardware], 'one room, two homes, in the order put in');
  // Put in again: still one door, where it was.
  assert.equal((await putIn(ml, systems)).status, 200);

  const v = await view(ml);
  assert.equal(v.doors.length, 1);
  const door = v.doors[0];
  assert.equal(door?.title, 'ML systems');
  assert.deepEqual([door?.x, door?.y], [400, 24]);
  assert.deepEqual(door?.counts, { sources: 0, threads: 1, notes: 0, rooms: 0 });
  assert.deepEqual(door?.kinds, ['thread']);
  assert.equal(door?.things[0]?.kind, 'thread');
  assert.equal(door?.brief, null);

  // Moved on the map.
  assert.equal((await api(s, 'PUT', `/api/rooms/${ml}/door-places`, { doors: [{ room: systems, x: 120.4, y: 300 }] })).status, 200);
  assert.deepEqual(
    (await view(ml)).doors.map((d) => [d.x, d.y]),
    [[120, 300]],
  );

  // Taken out of one home: still in the other, still a room.
  const out = await api<Room>(s, 'DELETE', `/api/rooms/${hardware}/rooms/${systems}`);
  assert.deepEqual(out.json.rooms, []);
  assert.deepEqual((await roomOf(systems)).parents, [ml]);
});

test('never inside itself, at any depth: refused in words', async () => {
  const a = await makeRoom('Computing');
  const b = await makeRoom('Programming');
  const c = await makeRoom('Typescript');
  assert.equal((await putIn(a, b)).status, 200);
  assert.equal((await putIn(b, c)).status, 200);
  const self = await putIn(a, a);
  assert.equal(self.status, 400);
  assert.equal(self.json.error?.message, 'A room cannot be put inside itself.');
  const loop = await putIn(c, a);
  assert.equal(loop.status, 400);
  assert.equal(loop.json.error?.message, '“Typescript” is inside “Computing”, so “Computing” cannot go in it.');
  // Deeper is fine: Typescript in Computing too.
  assert.equal((await putIn(a, c)).status, 200);
  assert.equal((await putIn(a, ulid())).status, 404);
});

test('a room taken down: the rooms in it stay rooms; merged, its rooms and homes go to the other', async () => {
  const outer = await makeRoom('Outer');
  const inner = await makeRoom('Inner');
  const home = await makeRoom('Home');
  await putIn(outer, inner);
  await putIn(home, outer);
  // Outer merged into Inner (which is inside it): Inner is not put in itself, but goes where Outer was.
  const merged = await api<Room>(s, 'POST', `/api/rooms/${outer}/merge`, { into: inner });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.json.rooms, []);
  assert.deepEqual(merged.json.parents, [home]);
  assert.deepEqual((await roomOf(home)).rooms, [inner]);

  assert.equal((await api(s, 'DELETE', `/api/rooms/${home}`)).status, 200);
  const left = await roomOf(inner);
  assert.ok(left, 'the room inside stays');
  assert.deepEqual(left.parents, []);
});

test("the bigger room's brief is written from its rooms' briefs, and is older when one of them is read again", async () => {
  const src = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Course\n\nTwelve weeks of machine learning.' })).json;
  const t = await thread('What does checkpointing trade?');
  const big = await makeRoom('Deep learning', [{ kind: 'source', id: src.id }]);
  const small = await makeRoom('Memory', [{ kind: 'thread', id: t }]);
  await putIn(big, small);

  const smallRead = await read(small);
  assert.equal(smallRead.brief?.text, 'Fake brief of “Memory”: 1 things, read in order.');
  const door = (await view(big)).doors[0];
  assert.equal(door?.brief, 'Fake brief of “Memory”: 1 things, read in order.');
  assert.equal(door?.fresh, true);

  const bigRead = await read(big);
  assert.equal(bigRead.brief?.text, 'Fake brief of “Deep learning”: 2 things, read in order. Its rooms: Memory.');
  assert.equal(bigRead.brief?.fresh, true);
  // The small room read again: its brief is new, so the big room's is older.
  const again = await read(small);
  assert.equal(again.brief?.fresh, true);
  assert.equal((await view(big)).brief?.fresh, false, 'a room inside was read again since');

  // A thread in the small room is told the bigger room it is part of.
  const next = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'And recomputation?' });
  await readEvents(`${s.base}/api/messages/${next.json.assistant.id}/events`);
  const sent = (await api<MessageContext>(s, 'GET', `/api/messages/${next.json.assistant.id}/context`)).json;
  assert.match(sent.request?.[0]?.content ?? '', /room "Memory", .* The room is part of the bigger room "Deep learning"\./);
});

test('an open question of a room inside is tied to that room', async () => {
  const big = await makeRoom('Only rooms');
  const small = await makeRoom('Inside it', [{ kind: 'thread', id: await thread('What is a tensor?') }]);
  await putIn(big, small);
  await read(small);
  // The fake brief's open question is in thing 1: here, the room inside (the bigger room has nothing else).
  const v = await read(big);
  assert.equal(v.brief?.text, 'Fake brief of “Only rooms”: 1 things, read in order. Its rooms: Inside it.');
  assert.deepEqual(v.brief?.open[0]?.item, { kind: 'room', id: small });
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

test('the Assistant puts a room in another (or in a new one) and takes it out, each on Do it, with Undo; and sees where rooms are', async () => {
  const lang = await makeRoom('Languages');
  const rust = await makeRoom('Rust');

  const put = await askAssistant('[[call:put_room_in:{"room":"rust","into":"Languages"}]]');
  assert.equal(put.actions[0]?.summary, 'Put the room “Rust” in “Languages”');
  assert.deepEqual((await roomOf(lang)).rooms, [], 'nothing before Do it');
  const done = await act(put.actions[0] as AssistantAction, 'run');
  assert.equal(done.status, 'done');
  assert.deepEqual((await roomOf(lang)).rooms, [rust]);

  const listed = await askAssistant('[[list:rooms]]');
  assert.match(listed.tools[0] ?? '', /Room “Languages”: 0 sources, 0 threads, 0 notes\. Rooms in it: “Rust”\./);
  assert.match(listed.tools[0] ?? '', /Room “Rust”: 0 sources, 0 threads, 0 notes\. Inside “Languages”\./);

  // The other way round would put a room inside itself: refused before anything is proposed.
  const loop = await askAssistant('[[call:put_room_in:{"room":"Languages","into":"Rust"}]]');
  assert.equal(loop.actions.length, 0);

  const out = await askAssistant('[[call:take_room_out:{"room":"Rust","from":"languages"}]]');
  assert.equal(out.actions[0]?.summary, 'Take the room “Rust” out of “Languages” (it stays a room, with all in it)');
  const o1 = await act(out.actions[0] as AssistantAction, 'run');
  assert.deepEqual((await roomOf(lang)).rooms, []);
  await act(o1, 'undo');
  assert.deepEqual((await roomOf(lang)).rooms, [rust], 'Undo puts it back');
  await act(done, 'undo');
  assert.deepEqual((await roomOf(lang)).rooms, []);

  // A bigger room that does not exist yet is made for it; Undo takes it away again.
  const made = await askAssistant('[[call:put_room_in:{"room":"Rust","into":"Systems programming"}]]');
  assert.equal(made.actions[0]?.summary, 'Make the room “Systems programming” and put “Rust” in it');
  const m1 = await act(made.actions[0] as AssistantAction, 'run');
  const field = (await rooms()).find((r) => r.title === 'Systems programming');
  assert.deepEqual(field?.rooms, [rust]);
  await act(m1, 'undo');
  assert.ok(!(await rooms()).some((r) => r.title === 'Systems programming'));
  assert.deepEqual((await roomOf(rust)).parents, []);

  // Deleting a room with a room in it says so; Undo brings back its door too.
  await putIn(lang, rust);
  const del = await askAssistant('[[call:delete_room:{"room":"Languages"}]]');
  assert.equal(del.actions[0]?.summary, 'Delete the room “Languages” (the room in it stays a room)');
  const d1 = await act(del.actions[0] as AssistantAction, 'run');
  assert.deepEqual((await roomOf(rust)).parents, []);
  await act(d1, 'undo');
  assert.deepEqual((await roomOf(lang)).rooms, [rust]);
  // Deleting the room inside, then Undo: it is back in its home.
  const delInner = await askAssistant('[[call:delete_room:{"room":"Rust"}]]');
  const d2 = await act(delInner.actions[0] as AssistantAction, 'run');
  assert.deepEqual((await roomOf(lang)).rooms, []);
  await act(d2, 'undo');
  assert.deepEqual((await roomOf(rust)).parents, [lang]);
});
