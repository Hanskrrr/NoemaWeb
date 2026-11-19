import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type Room, type RoomView, type Source, ulid } from '@noema/core';
import { api, startServer, type TestServer } from './helpers.ts';

// Concepts (ADR 0036): reading a room, the AI suggests the key ideas its things
// are about, each a small room inside it, defined by a point of one thing's
// summary, linked by what builds on what. The learner keeps them (all, or one
// by one), dismisses them (not suggested again), moves things between them,
// makes one a room. With the fake model, and made-up text.

let s: TestServer;
let notebookId = '';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
});
after(() => s.close());

const view = async (id: string) => (await api<RoomView>(s, 'GET', `/api/rooms/${id}`)).json;
const rooms = async () => (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;
async function read(id: string): Promise<RoomView> {
  assert.equal((await api(s, 'POST', `/api/rooms/${id}/read`, {})).status, 202);
  let v = await view(id);
  const start = Date.now();
  while (v.reading && ['summaries', 'links', 'concepts', 'brief'].includes(v.reading.phase)) {
    if (Date.now() - start > 5000) throw new Error('reading did not finish');
    await new Promise((r) => setTimeout(r, 20));
    v = await view(id);
  }
  return v;
}
async function source(title: string): Promise<Source> {
  const text = `# ${title}\n\nThe ${title.toLowerCase()} keeps the glowfin warm through the long winter nights.\n\nIt is made of layered moss.`;
  return (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text })).json;
}
async function room(title: string, sources: Source[]): Promise<string> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title, items: sources.map((x) => ({ kind: 'source', id: x.id })) });
  return id;
}
const key = (x: Source) => `source:${x.id}`;

test('reading a room suggests its concepts: each defined by the words of one of its things, holding its things, linked; nothing is lost', async () => {
  const s1 = await source('Moss blanket');
  const s2 = await source('Winter den');
  const s3 = await source('Glowfin fur');
  const s4 = await source('Ice fishing');
  const id = await room('Glowfin winters', [s1, s2, s3, s4]);
  const v = await read(id);
  assert.equal(v.reading?.phase, 'done');
  assert.equal(v.reading?.concepts, 3);
  assert.deepEqual(
    v.concepts.map((c) => [c.title, c.status, c.by, c.members]),
    [
      ['Fake concept 1', 'suggested', 'ai', [key(s1), key(s2)]],
      ['Fake concept 2', 'suggested', 'ai', [key(s3)]],
      ['Fake concept 3', 'suggested', 'ai', [key(s1), key(s3)]],
    ],
  );
  // Defined by the first point of its first thing: the words where they are.
  const first = v.concepts[0];
  assert.equal(first?.definition, 'The first idea of the room.');
  assert.equal(first?.quote?.kind, 'source');
  assert.equal(first?.quote?.quote, 'Moss blanket', 'the first point of the fake summary quotes the heading');
  // Linked, suggested: the second builds on the first, the third contrasts with the second.
  const byId = new Map(v.concepts.map((c) => [c.id, c.title]));
  assert.deepEqual(
    v.conceptLinks.map((l) => [byId.get(l.from), l.kind, byId.get(l.to), l.status]),
    [
      ['Fake concept 2', 'builds-on', 'Fake concept 1', 'suggested'],
      ['Fake concept 3', 'contrasts-with', 'Fake concept 2', 'suggested'],
    ],
  );
  // The last thing is in none: still in the room. Concepts are not rooms in it, nor in the list of rooms.
  assert.ok((v.room.members as string[]).includes(key(s4)));
  assert.equal(v.room.counts.rooms, 0);
  assert.deepEqual(v.doors, []);
  assert.ok(!(await rooms()).some((r) => r.kind === 'concept'));
  assert.ok(v.brief, 'the brief is written as before');

  // Read again: what was suggested and not kept is suggested afresh, not twice.
  const again = await read(id);
  assert.equal(again.concepts.length, 3);
});

test('kept: all at once with their links; one dismissed is not suggested again; the AI only guesses where new things go', async () => {
  const things = [await source('Moss blanket'), await source('Winter den'), await source('Glowfin fur'), await source('Ice fishing')];
  const id = await room('Glowfin dens', things);
  let v = await read(id);
  const third = v.concepts.find((c) => c.title === 'Fake concept 3');
  assert.equal((await api(s, 'DELETE', `/api/concepts/${third?.id}`)).status, 200);
  const kept = await api<{ kept: number }>(s, 'POST', `/api/rooms/${id}/concepts/keep`, {});
  assert.equal(kept.json.kept, 2);
  v = await view(id);
  assert.deepEqual(
    v.concepts.map((c) => [c.title, c.status]),
    [
      ['Fake concept 1', 'kept'],
      ['Fake concept 2', 'kept'],
    ],
  );
  assert.deepEqual(
    v.conceptLinks.map((l) => [l.kind, l.status]),
    [['builds-on', 'accepted']],
  );

  // Read again: the kept stay as they are; "Fake concept 3" was dismissed, so it is not suggested again.
  v = await read(id);
  const titles = v.concepts.map((c) => `${c.title}:${c.status}`);
  assert.deepEqual(titles.slice(0, 2), ['Fake concept 1:kept', 'Fake concept 2:kept']);
  assert.ok(!titles.some((t) => t.startsWith('Fake concept 3')), titles.join());
  // The thing in no concept: a guess for the first kept one, not put there.
  assert.deepEqual(v.guesses, [{ item: key(things[3] as Source), concept: v.concepts[0]?.id }]);
  assert.ok(!v.concepts[0]?.members.includes(key(things[3] as Source) as never));
});

test("a concept's things are things of its room: put in a concept, in the room too; out of the room, out of its concepts", async () => {
  const a = await source('Moss blanket');
  const b = await source('Winter den');
  const id = await room('Glowfin homes', [a]);
  const conceptId = ulid();
  const made = await api<Room>(s, 'POST', `/api/rooms/${id}/concepts`, { id: conceptId, title: 'Warmth', items: [{ kind: 'source', id: a.id }] });
  assert.equal(made.status, 201);
  assert.equal(made.json.kind, 'concept');
  assert.equal(made.json.status, 'kept');
  // Into the concept from outside the room: in the room too.
  await api(s, 'POST', `/api/rooms/${conceptId}/items`, { items: [{ kind: 'source', id: b.id }] });
  let v = await view(id);
  assert.deepEqual(v.concepts[0]?.members, [key(a), key(b)]);
  assert.ok((v.room.members as string[]).includes(key(b)));
  // Out of the concept: still in the room.
  await api(s, 'POST', `/api/rooms/${conceptId}/items/remove`, { kind: 'source', id: a.id });
  v = await view(id);
  assert.deepEqual(v.concepts[0]?.members, [key(b)]);
  assert.ok((v.room.members as string[]).includes(key(a)));
  // Out of the room: out of its concepts.
  await api(s, 'POST', `/api/rooms/${id}/items/remove`, { kind: 'source', id: b.id });
  v = await view(id);
  assert.deepEqual(v.concepts[0]?.members, []);
  // A concept holds things, not rooms.
  const other = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id: other, title: 'Elsewhere' });
  assert.equal((await api(s, 'POST', `/api/rooms/${conceptId}/rooms`, { room: other })).status, 400);
  assert.equal((await api(s, 'POST', `/api/rooms/${conceptId}/concepts`, { id: ulid(), title: 'Nested' })).status, 400);
});

test('a concept merged into another brings its things; one made a room is a room inside; the room deleted takes its concepts', async () => {
  const things = [await source('Moss blanket'), await source('Winter den'), await source('Glowfin fur')];
  const id = await room('Glowfin seasons', things);
  let v = await read(id);
  await api(s, 'POST', `/api/rooms/${id}/concepts/keep`, {});
  const [c1, c2, c3] = v.concepts;
  // The third into the first: its things join, its link to the second now starts at the first.
  assert.equal((await api(s, 'POST', `/api/rooms/${c3?.id}/merge`, { into: c1?.id })).status, 200);
  v = await view(id);
  assert.deepEqual(
    v.concepts.map((c) => c.title),
    ['Fake concept 1', 'Fake concept 2'],
  );
  assert.deepEqual(v.concepts[0]?.members.slice().sort(), [key(things[0] as Source), key(things[1] as Source), key(things[2] as Source)].sort());
  assert.deepEqual(
    v.conceptLinks.map((l) => [l.from === c2?.id ? 'c2' : 'c1', l.kind, l.to === c1?.id ? 'c1' : 'c2']).sort(),
    [
      ['c1', 'contrasts-with', 'c2'],
      ['c2', 'builds-on', 'c1'],
    ],
  );
  // Made a room: a room inside now, in the list of rooms; links to it go.
  const grown = await api<Room>(s, 'POST', `/api/concepts/${c2?.id}/room`, {});
  assert.equal(grown.json.kind, 'room');
  v = await view(id);
  assert.deepEqual(
    v.concepts.map((c) => c.id),
    [c1?.id],
  );
  assert.deepEqual(
    v.doors.map((d) => d.id),
    [c2?.id],
  );
  assert.deepEqual(v.conceptLinks, []);
  assert.ok((await rooms()).some((r) => r.id === c2?.id));
  // The room deleted: its concept goes; the room made of a concept stays.
  await api(s, 'DELETE', `/api/rooms/${id}`);
  assert.equal((await api(s, 'GET', `/api/rooms/${c1?.id}`)).status, 404);
  assert.equal((await api(s, 'GET', `/api/rooms/${c2?.id}`)).status, 200);
});
