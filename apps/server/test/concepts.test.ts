import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type AskResponse, type Concept, type ConceptWords, type Note, type Room, type RoomReading, type RoomView, type Source, ulid } from '@noema/core';
import { FakeProvider } from '../src/llm/fake.ts';
import { Db } from '../src/store/db.ts';
import { api, readEvents, startServer, type TestServer } from './helpers.ts';

// The concept-reading skill (ADRs 0037, 0038): every piece of the learner's
// threads and notes is read once (by its hash), the concepts it discusses
// joined across the notebook; a change re-reads only what changed; the
// learner's decisions stick. Sources are not read: their words are found by
// text search. Concepts sit in a tree: topics, concepts, concepts inside. With
// the fake model, whose concepts are the **bold** phrases of a piece. Made-up text.

let s: TestServer;
let notebookId = '';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
});
after(() => s.close());

const view = async (id: string) => (await api<RoomView>(s, 'GET', `/api/rooms/${id}`)).json;
async function read(id: string): Promise<RoomView> {
  assert.equal((await api(s, 'POST', `/api/rooms/${id}/read`, {})).status, 202);
  let v = await view(id);
  const start = Date.now();
  while (v.reading && ['summaries', 'links', 'concepts', 'brief'].includes(v.reading.phase)) {
    if (Date.now() - start > 30000) throw new Error('reading did not finish');
    await new Promise((r) => setTimeout(r, 20));
    v = await view(id);
  }
  return v;
}
async function source(text: string): Promise<Source> {
  return (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text })).json;
}
async function note(title: string, ...blocks: string[]): Promise<Note> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id, title });
  let after: string | null = null;
  for (const content of blocks) {
    const b = ulid();
    await api(s, 'POST', `/api/notes/${id}/blocks`, { id: b, after, content });
    after = b;
  }
  return (await api<Note>(s, 'GET', `/api/notes/${id}`)).json;
}
async function room(title: string, items: Array<{ kind: 'source' | 'note' | 'thread'; id: string }>): Promise<string> {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title, items });
  return id;
}
const byTitle = (v: RoomView, title: string) => v.concepts.find((c) => c.title === title) as Concept;
/** The room's concepts, not its topics (which hold concepts, not things). */
const ideas = (v: RoomView) => v.concepts.filter((c) => c.members.length > 0);
async function thread(...questions: string[]): Promise<string> {
  const t = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: t });
  for (const q of questions) {
    const r = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: q });
    await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  }
  return t;
}
const pieceRows = () => (s.db.sql.prepare('SELECT kind, item_id, hash, read_at FROM concept_piece ORDER BY read_at').all() as Array<Record<string, string>>);

test('threads and notes are read for their concepts, sources are not; one discussed in two materials, or defined in one, is suggested; one concept across rooms', async () => {
  const slides = await source('# Glowfin winters\n\n**Moss blanket** is a woven layer. **Snow crust** is hard snow.');
  const notes = await note('Den notes', '**Moss blanket** is a woven layer that keeps the glowfin warm.', 'The **den** is dug under the ice. **Ice fishing** happens nearby.');
  const asked = await thread('Why is the **den** so deep?');
  const id = await room('Glowfin', [
    { kind: 'source', id: slides.id },
    { kind: 'note', id: notes.id },
    { kind: 'thread', id: asked },
  ]);
  const v = await read(id);
  assert.equal(v.reading?.phase, 'done');
  // "moss blanket": defined in the note. "den": in the note and the thread. "ice fishing": once, in passing.
  // "snow crust": only in the source, which is not read.
  assert.deepEqual(ideas(v).map((c) => [c.title, c.status, c.materials]).sort(), [
    ['den', 'suggested', 2],
    ['moss blanket', 'suggested', 1],
  ]);
  assert.equal(pieceRows().filter((r) => r.item_id === slides.id).length, 0, 'the source is not read');
  const moss = byTitle(v, 'moss blanket');
  assert.equal(moss.definition, 'Fake: about moss blanket.');
  assert.equal(moss.quote?.kind, 'note');
  // The learner's work: the thread asks about the den; the note discusses both.
  assert.deepEqual(byTitle(v, 'den').work, { questions: 1, notes: 1, materials: 2 });
  // Each place says where its words are: the note's place is its block.
  const notePlace = moss.sources[0]?.places[0];
  assert.equal(notePlace?.target?.kind === 'note' && notePlace.target.blockId, notes.blocks[0]?.id);
  assert.deepEqual(v.conceptsToRead, { materials: 0, changed: 0, pieces: 0 });
  // A material's concepts, from its side.
  const here = (await api<{ concepts: Array<{ title: string; places: unknown[] }> }>(s, 'GET', `/api/items/note/${notes.id}/concepts`)).json.concepts;
  assert.deepEqual(here.map((c) => [c.title, c.places.length]).sort(), [
    ['den', 1],
    ['moss blanket', 1],
  ]);
  // Where its words appear in the sources: text search, with the words around them.
  const words = (await api<ConceptWords>(s, 'GET', `/api/concepts/${moss.id}/words`)).json;
  assert.deepEqual(words.sources.map((x) => [x.id, x.count]), [[slides.id, 1]]);
  assert.match(words.sources[0]?.places[0]?.quote ?? '', /Moss blanket\*\* is a woven layer/);
  assert.equal(words.sources[0]?.places[0]?.target.kind, 'source');

  // Another room with only the note: the same concepts, the same ids.
  const other = await room('Dens', [{ kind: 'note', id: notes.id }]);
  const w = await view(other);
  assert.deepEqual(ideas(w).map((c) => c.id).sort(), ideas(v).map((c) => c.id).sort());
  assert.ok(byTitle(w, 'den').also.includes(id));
  const rooms = (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;
  assert.ok(!rooms.some((r) => r.kind === 'concept'));
});

test('a thread asked about a passage of a source is read with that passage', async () => {
  const src = await source('# Sea ice\n\n**Brine channel** is a thin tube of salty water inside sea ice. More text follows here.');
  const detail = (await api<{ version: { id: string; content: string } }>(s, 'GET', `/api/sources/${src.id}`)).json;
  const words = '**Brine channel** is a thin tube of salty water inside sea ice.';
  const start = detail.version.content.indexOf(words);
  const t = ulid();
  const made = await api<{ assistant: { id: string } }>(s, 'POST', `/api/sources/${src.id}/threads`, {
    id: t,
    passage: { versionId: detail.version.id, start, end: start + words.length },
    question: { id: ulid(), content: 'What does it do?' },
  });
  assert.equal(made.status, 201);
  await readEvents(`${s.base}/api/messages/${made.json.assistant.id}/events`);
  const id = await room('Brine', [{ kind: 'thread', id: t }]);
  const v = await read(id);
  const brine = byTitle(v, 'brine channel');
  assert.ok(brine, 'the passage asked about is read with the thread');
  assert.deepEqual(brine.sources.map((x) => x.item), [`thread:${t}`]);
  // Its place points at the source, where the words are.
  assert.equal(brine.quote?.kind, 'source');
  assert.equal(brine.quote?.kind === 'source' && brine.quote.at, start);
});

test('by hash: read again, nothing is read; a block edited, only its note is read again, its mentions follow; a dismissed concept is not suggested again', async () => {
  const a = await note('Moss facts', '**Lantern moss** is moss that glows at night.');
  const n = await note('Moss notes', '**Lantern moss** is grown in caves.');
  const id = await room('Lantern', [
    { kind: 'note', id: a.id },
    { kind: 'note', id: n.id },
  ]);
  await read(id);
  const before = pieceRows().filter((r) => r.item_id === a.id || r.item_id === n.id);
  assert.equal(before.length, 2);
  await read(id);
  assert.deepEqual(
    pieceRows().filter((r) => r.item_id === a.id || r.item_id === n.id),
    before,
    'nothing read again',
  );

  // The note now speaks of something else: only it is read again.
  await api(s, 'PATCH', `/api/notes/${n.id}/blocks/${n.blocks[0]?.id}`, { content: '**Cave glow** is what lantern moss gives off.' });
  let v = await view(id);
  assert.deepEqual(v.conceptsToRead, { materials: 1, changed: 1, pieces: 1 });
  v = await read(id);
  const after = pieceRows().filter((r) => r.item_id === a.id || r.item_id === n.id);
  assert.deepEqual(after.find((r) => r.item_id === a.id), before.find((r) => r.item_id === a.id));
  assert.notEqual(after.find((r) => r.item_id === n.id)?.hash, before.find((r) => r.item_id === n.id)?.hash);
  assert.deepEqual(byTitle(v, 'lantern moss').sources.map((x) => x.item), [`note:${a.id}`]);
  const glow = byTitle(v, 'cave glow');
  assert.equal(glow.status, 'suggested');

  // Dismissed: gone, and not suggested again, even when more materials discuss it.
  assert.equal((await api(s, 'DELETE', `/api/concepts/${glow.id}`)).status, 200);
  const more = await note('Glow', '**Cave glow** is faint and green.');
  await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: more.id }] });
  v = await read(id);
  assert.ok(!v.concepts.some((c) => c.title === 'cave glow'));
});

test('a thread whose answer ends after the room was shown is still seen as changed', async () => {
  const t = await thread('Why does **night bloom** open late?');
  const id = await room('Night', [{ kind: 'thread', id: t }]);
  await read(id);
  assert.deepEqual((await view(id)).conceptsToRead, { materials: 0, changed: 0, pieces: 0 });
  // The answer's words change while the thread's own time stays where the question put it, as when an answer
  // ends after the room was shown.
  const answer = s.db.sql.prepare("SELECT current_revision_id AS rev FROM message WHERE thread_id = ? AND role = 'assistant'").get(t) as { rev: string };
  s.db.sql.prepare("UPDATE message_revision SET content = content || ' **Moon moss** opens with it.', updated_at = ? WHERE id = ?").run(new Date().toISOString(), answer.rev);
  assert.deepEqual((await view(id)).conceptsToRead, { materials: 1, changed: 1, pieces: 1 });
});

test("new names are joined: a known concept's other name; two new names for one idea, judged the same; a renamed concept keeps its old name", async () => {
  const a = await note('Training', '**Gradient checkpointing** is keeping fewer activations and recomputing them.');
  const id = await room('Memory', [{ kind: 'note', id: a.id }]);
  let v = await read(id);
  const gc = byTitle(v, 'gradient checkpointing');
  assert.ok(gc);
  const b = await note('Short', '**GC** saves memory on long sequences.');
  const c = await note('Optimizers', '**Stochastic gradient descent** is stepping along a noisy gradient.');
  const d = await note('Steps', '**SGD** needs a learning rate.');
  for (const x of [b, c, d]) await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: x.id }] });
  v = await read(id);
  assert.deepEqual(byTitle(v, 'gradient checkpointing').sources.map((x) => x.item), [`note:${a.id}`, `note:${b.id}`]);
  assert.ok(byTitle(v, 'gradient checkpointing').names.includes('GC'));
  const sgd = byTitle(v, 'stochastic gradient descent');
  assert.deepEqual(sgd.sources.map((x) => x.item).sort(), [`note:${c.id}`, `note:${d.id}`].sort());
  assert.ok(!v.concepts.some((x) => x.title === 'sgd'));

  // Renamed: the old name still means it; a new material using it joins it.
  await api(s, 'PATCH', `/api/rooms/${gc.id}`, { title: 'Activation recomputation' });
  const e = await note('More', 'More on **gradient checkpointing** in practice.');
  await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: e.id }] });
  v = await read(id);
  const renamed = byTitle(v, 'Activation recomputation');
  assert.ok(renamed.sources.some((x) => x.item === `note:${e.id}`));
  assert.ok(renamed.names.includes('gradient checkpointing'));
});

test('the learner decides: kept holds its things; a material moved or split to another concept stays there when read again; taken out stays out; places by hand stay', async () => {
  const a = await note('Dens', '**Snow den** is a den dug in snow. A **snow den** stays warm.');
  const b = await note('Den A', 'A **snow den** has one door.');
  const c = await note('Den B', 'A **snow den** needs a vent.');
  const id = await room('Snow', [
    { kind: 'note', id: a.id },
    { kind: 'note', id: b.id },
    { kind: 'note', id: c.id },
  ]);
  let v = await read(id);
  const den = byTitle(v, 'snow den');
  assert.equal((await api(s, 'POST', `/api/concepts/${den.id}/keep`, {})).status, 200);

  // Split: note B to a new concept "Den doors", with its place.
  const doors = ulid();
  const split = await api<Room>(s, 'POST', `/api/concepts/${den.id}/split`, { id: doors, title: 'Den doors', items: [{ kind: 'note', id: b.id }] });
  assert.equal(split.status, 201);
  v = await view(id);
  assert.deepEqual(byTitle(v, 'Den doors').sources.map((x) => [x.item, x.places.length]), [[`note:${b.id}`, 1]]);
  assert.ok(!byTitle(v, 'snow den').sources.some((x) => x.item === `note:${b.id}`));
  const nb = (await api<Note>(s, 'GET', `/api/notes/${b.id}`)).json;
  await api(s, 'PATCH', `/api/notes/${b.id}/blocks/${nb.blocks[0]?.id}`, { content: 'A **snow den** has one low door.' });
  v = await read(id);
  assert.deepEqual(byTitle(v, 'Den doors').sources.map((x) => x.item), [`note:${b.id}`]);
  assert.ok(!byTitle(v, 'snow den').sources.some((x) => x.item === `note:${b.id}`));

  // Taken out of the kept concept: note C stays out after reading again.
  await api(s, 'POST', `/api/rooms/${den.id}/items/remove`, { kind: 'note', id: c.id });
  v = await read(id);
  assert.ok(!byTitle(v, 'snow den').sources.some((x) => x.item === `note:${c.id}`));

  // A place by hand, in note C, under "Den doors": kept through a reading; its words gone, it is not found.
  const nc = (await api<Note>(s, 'GET', `/api/notes/${c.id}`)).json;
  const placed = await api(s, 'POST', `/api/concepts/${doors}/places`, {
    target: { kind: 'note', noteId: c.id, blockId: nc.blocks[0]?.id, title: 'Den B', quote: 'needs a vent' },
  });
  assert.equal(placed.status, 201);
  v = await read(id);
  let mine = byTitle(v, 'Den doors').sources.find((x) => x.item === `note:${c.id}`)?.places[0];
  assert.equal(mine?.by, 'you');
  assert.equal(mine?.target?.kind, 'note');
  await api(s, 'PATCH', `/api/notes/${c.id}/blocks/${nc.blocks[0]?.id}`, { content: 'A **snow den** has a chimney.' });
  v = await read(id);
  mine = byTitle(v, 'Den doors').sources.find((x) => x.item === `note:${c.id}`)?.places[0];
  assert.equal(mine?.by, 'you');
  assert.equal(mine?.target, null, 'its words are gone: not found');

  // Kept, and its material no longer discusses it: it stays, with its things, "no longer found".
  const cave = await note('Caves', '**Ice cave** is a cave in a glacier.');
  await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: cave.id }] });
  v = await read(id);
  const ice = byTitle(v, 'ice cave');
  await api(s, 'POST', `/api/concepts/${ice.id}/keep`, {});
  await api(s, 'PATCH', `/api/notes/${cave.id}/blocks/${cave.blocks[0]?.id}`, { content: 'Nothing about it here now.' });
  v = await read(id);
  const lost = byTitle(v, 'ice cave');
  assert.equal(lost.status, 'kept');
  assert.equal(lost.places, 0);
  assert.equal(lost.lost, true);
  assert.deepEqual(lost.members, [`note:${cave.id}`]);
  // A material deleted for good takes its places with it.
  await api(s, 'DELETE', `/api/notes/${a.id}/forever`);
  v = await view(id);
  assert.ok(!byTitle(v, 'snow den')?.sources.some((x) => x.item === `note:${a.id}`));
  assert.equal((s.db.sql.prepare('SELECT count(*) AS n FROM concept_mention WHERE item_id = ?').get(a.id) as { n: number }).n, 0);
});

test('moved between concepts: its places go with it; merged: one concept with both names; made a room: a room inside, its names never suggested again', async () => {
  const a = await note('Ice', '**Ice shelf** is floating ice. **Pack ice** is broken ice.');
  const b = await note('Shelf', 'The **ice shelf** cracks in spring. **Pack ice** drifts.');
  const id = await room('Ice', [
    { kind: 'note', id: a.id },
    { kind: 'note', id: b.id },
  ]);
  let v = await read(id);
  const shelf = byTitle(v, 'ice shelf');
  const pack = byTitle(v, 'pack ice');
  assert.equal((await api(s, 'POST', `/api/concepts/${shelf.id}/move`, { item: { kind: 'note', id: b.id }, to: pack.id })).status, 200);
  v = await view(id);
  assert.deepEqual(byTitle(v, 'pack ice').sources.find((x) => x.item === `note:${b.id}`)?.places.length, 2);
  assert.ok(!byTitle(v, 'ice shelf').sources.some((x) => x.item === `note:${b.id}`));
  assert.equal((await api(s, 'POST', `/api/rooms/${shelf.id}/merge`, { into: pack.id })).status, 200);
  v = await view(id);
  assert.equal(ideas(v).length, 1);
  assert.ok(byTitle(v, 'pack ice').names.includes('ice shelf'));
  assert.equal(byTitle(v, 'pack ice').places, 4);
  const grown = await api<Room>(s, 'POST', `/api/concepts/${pack.id}/room`, { inside: id });
  assert.equal(grown.json.kind, 'room');
  v = await read(id);
  assert.deepEqual(ideas(v), []);
  assert.deepEqual(
    v.doors.map((d) => d.id),
    [pack.id],
  );
  const other = await room('Other', []);
  const c = await api<Room>(s, 'POST', `/api/rooms/${id}/concepts`, { id: ulid(), title: 'Floe', items: [{ kind: 'note', id: b.id }] });
  assert.equal(c.json.kind, 'concept');
  assert.equal((await api(s, 'POST', `/api/rooms/${c.json.id}/merge`, { into: other })).status, 400);
  assert.equal((await api(s, 'POST', `/api/rooms/${c.json.id}/rooms`, { room: other })).status, 400);
  await api(s, 'DELETE', `/api/rooms/${id}`);
  assert.equal((await api(s, 'GET', `/api/rooms/${c.json.id}`)).status, 200);
});

test('levels: a kind of what a piece says it is; the others in a topic, suggested; kept with Keep all; what you place the AI does not move', async () => {
  const a = await note('Fern facts', '**Frost fern** is a fern that grows on ice. **Deep frost fern** is a kind of **frost fern** that grows lower.');
  const b = await note('Fern notes', 'The **frost fern** curls at night. **Ice lichen** is a crust on the stones.', '**Ice lichen** is slow.');
  const id = await room('Fern walk', [
    { kind: 'note', id: a.id },
    { kind: 'note', id: b.id },
  ]);
  let v = await read(id);
  const fern = byTitle(v, 'frost fern');
  const deep = byTitle(v, 'deep frost fern');
  const lichen = byTitle(v, 'ice lichen');
  // The piece said it: a kind of frost fern. The others: in a topic the AI suggested, named for the room.
  assert.deepEqual(deep.home, { id: fern.id, how: 'kind-of', status: 'suggested', by: 'ai' });
  const topic = byTitle(v, 'Fern walk basics');
  assert.ok(topic, 'a topic');
  assert.deepEqual(topic.members, [], 'a topic holds concepts, not things');
  assert.equal(topic.status, 'suggested');
  assert.match(topic.scope ?? '', /Fake: what “Fern walk” is about/);
  assert.deepEqual(fern.home, { id: topic.id, how: 'in', status: 'suggested', by: 'ai' });
  assert.deepEqual(lichen.home?.id, topic.id);
  // The order of the room's concepts: the room's own first, the topic after.
  assert.equal(v.concepts.at(-1)?.id, topic.id);

  // Keep all: the concepts, the topic and their places.
  await api(s, 'POST', `/api/rooms/${id}/concepts/keep`, {});
  v = await view(id);
  assert.ok(v.concepts.every((c) => c.status === 'kept'));
  assert.ok(v.concepts.filter((c) => c.home).every((c) => c.home?.status === 'kept'));

  // You take the lichen to the top: read again, the AI does not put it back.
  assert.equal((await api(s, 'POST', `/api/concepts/${lichen.id}/under`, { parent: null })).status, 200);
  const c = await note('Lichen more', '**Ice lichen** is grey.');
  await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: c.id }] });
  v = await read(id);
  assert.equal(byTitle(v, 'ice lichen').home, null);
  // You put it under the fern: kept, by you; a topic it goes in, a concept it is a kind of.
  await api(s, 'POST', `/api/concepts/${lichen.id}/under`, { parent: fern.id });
  v = await view(id);
  assert.deepEqual(byTitle(v, 'ice lichen').home, { id: fern.id, how: 'kind-of', status: 'kept', by: 'you' });
  // Never inside itself, or inside what is inside it.
  assert.equal((await api(s, 'POST', `/api/concepts/${fern.id}/under`, { parent: lichen.id })).status, 400);
  assert.equal((await api(s, 'POST', `/api/concepts/${fern.id}/under`, { parent: fern.id })).status, 400);

  // A suggested place you say no to is not suggested again.
  const d = await note('Sorrel', '**Snow sorrel** is a red leaf. **Snow sorrel** tastes sour.');
  const e = await note('Sorrel more', '**Snow sorrel** grows by the fern.');
  await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: d.id }, { kind: 'note', id: e.id }] });
  v = await read(id);
  const sorrel = byTitle(v, 'snow sorrel');
  assert.equal(sorrel.home?.id, topic.id, 'in the topic the notebook has');
  await api(s, 'DELETE', `/api/concepts/${sorrel.id}/home`);
  await api(s, 'PATCH', `/api/notes/${d.id}/blocks/${d.blocks[0]?.id}`, { content: '**Snow sorrel** is a red leaf, sour.' });
  v = await read(id);
  assert.equal(byTitle(v, 'snow sorrel').home, null);

  // Where you moved a concept on the map stays.
  assert.equal((await api(s, 'PUT', `/api/rooms/${id}/concept-xy`, { id: fern.id, x: 12, y: -40 })).status, 200);
  v = await view(id);
  assert.deepEqual(v.conceptXY, [{ id: fern.id, x: 12, y: -40 }]);
  // A topic with nothing left in it goes, if the AI made it and it was not kept: kept, it stays.
  assert.ok(byTitle(v, 'Fern walk basics'));
});

test('a concept you make is filled: its scope written, the concepts inside it and the materials that discuss it found, waiting to be kept', async () => {
  const a = await note('Reeds', '**Reed raft** is a mat the otters float on.');
  const b = await note('Rafts', 'The **reed raft** drifts. **Kelp raft** is a raft of kelp.');
  const t = await thread('Do otters sleep on a raft at night?');
  const id = await room('Otters', [
    { kind: 'note', id: a.id },
    { kind: 'note', id: b.id },
    { kind: 'thread', id: t },
  ]);
  let v = await read(id);
  const raft = ulid();
  await api<Room>(s, 'POST', `/api/rooms/${id}/concepts`, { id: raft, title: 'raft' });
  const found = await api<{ inside: number; materials: number }>(s, 'POST', `/api/concepts/${raft}/find`, {});
  assert.equal(found.status, 200);
  v = await view(id);
  const made = byTitle(v, 'raft');
  assert.match(made.scope ?? '', /Fake scope: what “raft” covers/);
  // Inside it: the concepts whose names hold it, waiting to be kept.
  const inside = v.concepts.filter((c) => c.home?.id === raft || c.alsoUnder.some((h) => h.id === raft));
  assert.deepEqual(inside.map((c) => c.title).sort(), ['kelp raft', 'reed raft']);
  // Materials found, with the words that show it; not in it until kept.
  const waiting = made.sources.filter((x) => x.places.some((p) => !p.kept));
  assert.ok(waiting.some((x) => x.item === `thread:${t}`));
  assert.ok(!made.members.includes(`thread:${t}`));
  const place = waiting.find((x) => x.item === `thread:${t}`)?.places[0];
  assert.match(place?.quote ?? '', /raft at night/);
  assert.equal((await api(s, 'POST', `/api/concept-places/${place?.id}/keep`, {})).status, 200);
  v = await view(id);
  assert.ok(byTitle(v, 'raft').members.includes(`thread:${t}`));
  // You change its scope.
  await api(s, 'POST', `/api/concepts/${raft}/scope`, { scope: 'Things otters float on.' });
  v = await view(id);
  assert.equal(byTitle(v, 'raft').scope, 'Things otters float on.');
});

test('a reading stopped keeps what it read, and the next reading carries on', async () => {
  const slow = await startServer({ models: { fake: () => new FakeProvider({ delayMs: 120 }) } });
  try {
    const nb = (await api<{ notebooks: Array<{ id: string }> }>(slow, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
    const items: Array<{ kind: 'note'; id: string }> = [];
    for (let i = 0; i < 6; i++) {
      const n = ulid();
      await api(slow, 'POST', `/api/notebooks/${nb}/notes`, { id: n, title: `Pond ${i}` });
      await api(slow, 'POST', `/api/notes/${n}/blocks`, { id: ulid(), after: null, content: `**Pond weed ${i}** is a weed of pond ${i}.` });
      items.push({ kind: 'note', id: n });
    }
    const id = ulid();
    await api(slow, 'POST', `/api/notebooks/${nb}/rooms`, { id, title: 'Ponds', items });
    await api(slow, 'POST', `/api/rooms/${id}/read`, {});
    const stopped = await api<{ reading: RoomReading }>(slow, 'POST', `/api/rooms/${id}/read/stop`, {});
    assert.equal(stopped.status, 200);
    let v = (await api<RoomView>(slow, 'GET', `/api/rooms/${id}`)).json;
    for (const start = Date.now(); v.reading?.phase !== 'done' && Date.now() - start < 20000; ) {
      await new Promise((r) => setTimeout(r, 30));
      v = (await api<RoomView>(slow, 'GET', `/api/rooms/${id}`)).json;
    }
    assert.equal(v.reading?.stopped, true);
    assert.ok(v.conceptsToRead.pieces > 0, 'some left to read');
    await api(slow, 'POST', `/api/rooms/${id}/read`, {});
    for (const start = Date.now(); Date.now() - start < 30000; ) {
      await new Promise((r) => setTimeout(r, 50));
      v = (await api<RoomView>(slow, 'GET', `/api/rooms/${id}`)).json;
      if (v.reading?.phase === 'done') break;
    }
    assert.equal(v.reading?.stopped, false);
    assert.deepEqual(v.conceptsToRead, { materials: 0, changed: 0, pieces: 0 });
    assert.equal(ideas(v).length, 6);
  } finally {
    slow.close();
  }
});

test('upgrading: suggestions only sources brought go, with the places read in sources; kept concepts and places by hand stay', () => {
  const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v27 = join(dir, 'v27');
  mkdirSync(v27);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= 27)) copyFileSync(join(MIGRATIONS, f), join(v27, f));
  const file = join(dir, 'n.db');
  const old = new Db(file);
  old.migrate(v27);
  const t = new Date().toISOString();
  const nb = ulid();
  old.sql.prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(nb, 'N', '', t, t);
  const concept = (title: string, status: string, by: string) => {
    const id = ulid();
    old.sql
      .prepare("INSERT INTO room (id, notebook_id, title, kind, status, made_by, created_at, updated_at) VALUES (?, ?, ?, 'concept', ?, ?, ?, ?)")
      .run(id, nb, title, status, by, t, t);
    return id;
  };
  const mention = (conceptId: string, kind: string, by: string, hash: string | null) =>
    old.sql
      .prepare(
        `INSERT INTO concept_mention (id, notebook_id, concept_id, kind, item_id, hash, name, key, role, quote, made_by, created_at)
         VALUES (?, ?, ?, ?, 'x', ?, 'n', 'n', 'uses', 'q', ?, ?)`,
      )
      .run(ulid(), nb, conceptId, kind, hash, by, t);
  const bookOnly = concept('book idea', 'suggested', 'ai');
  mention(bookOnly, 'source', 'ai', 'h1');
  const fromNote = concept('note idea', 'suggested', 'ai');
  mention(fromNote, 'source', 'ai', 'h1');
  mention(fromNote, 'note', 'ai', 'h2');
  const keptBook = concept('kept book idea', 'kept', 'ai');
  mention(keptBook, 'source', 'ai', 'h1');
  const byHand = concept('hand idea', 'suggested', 'ai');
  mention(byHand, 'source', 'you', null);
  old.sql.prepare("INSERT INTO concept_piece (notebook_id, kind, item_id, hash, model, read_at) VALUES (?, 'source', 'x', 'h1', 'm', ?)").run(nb, t);
  old.sql.prepare("INSERT INTO concept_piece (notebook_id, kind, item_id, hash, model, read_at) VALUES (?, 'note', 'x', 'h2', 'm', ?)").run(nb, t);
  old.close();
  const db = new Db(file);
  db.migrate();
  const titles = (db.sql.prepare("SELECT title FROM room WHERE kind = 'concept' ORDER BY title").all() as Array<{ title: string }>).map((r) => r.title);
  assert.deepEqual(titles, ['hand idea', 'kept book idea', 'note idea']);
  assert.deepEqual(
    (db.sql.prepare('SELECT kind, made_by FROM concept_mention ORDER BY kind, made_by').all() as Array<{ kind: string; made_by: string }>).map((r) => [r.kind, r.made_by]),
    [
      ['note', 'ai'],
      ['source', 'you'],
    ],
  );
  assert.deepEqual((db.sql.prepare('SELECT kind FROM concept_piece').all() as Array<{ kind: string }>).map((r) => r.kind), ['note']);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
