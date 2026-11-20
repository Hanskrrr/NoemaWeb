import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskResponse, type Concept, type Note, type Room, type RoomView, type Source, ulid } from '@noema/core';
import { api, readEvents, startServer, type TestServer } from './helpers.ts';

// The concept-reading skill (ADR 0037): every piece of every material is read
// once (by its hash), the concepts it discusses joined across the notebook;
// a change re-reads only what changed; the learner's decisions stick. With the
// fake model, whose concepts are the **bold** phrases of a piece. Made-up text.

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
const pieceRows = () => (s.db.sql.prepare('SELECT kind, item_id, hash, read_at FROM concept_piece ORDER BY read_at').all() as Array<Record<string, string>>);

test('every material is read for its concepts: one discussed in two materials, or defined in one, is suggested; one used once in passing is not; one concept across rooms', async () => {
  const slides = await source('# Glowfin winters\n\n**Moss blanket** is a woven layer that keeps the glowfin warm. It is laid over a **den**.');
  const notes = await note('Den notes', 'The **moss blanket** is changed every week.', 'The **den** is dug under the ice. **Ice fishing** happens nearby.');
  const id = await room('Glowfin', [
    { kind: 'source', id: slides.id },
    { kind: 'note', id: notes.id },
  ]);
  const v = await read(id);
  assert.equal(v.reading?.phase, 'done');
  // "moss blanket": defined in the slides, used in the notes. "den": used in both. "ice fishing": once, in passing.
  assert.deepEqual(v.concepts.map((c) => [c.title, c.status, c.materials]).sort(), [
    ['den', 'suggested', 2],
    ['moss blanket', 'suggested', 2],
  ]);
  const moss = byTitle(v, 'moss blanket');
  assert.equal(moss.definition, 'Fake: about moss blanket.');
  assert.equal(moss.quote?.kind, 'source');
  assert.match(moss.quote?.quote ?? '', /is a woven layer/);
  assert.equal(moss.places, 2);
  assert.deepEqual(
    moss.sources.map((x) => [x.item, x.inRoom, x.places.map((p) => p.role)]),
    [
      [`source:${slides.id}`, true, ['defines']],
      [`note:${notes.id}`, true, ['uses']],
    ],
  );
  // Each place says where its words are: the note's place is its block.
  const notePlace = moss.sources[1]?.places[0];
  assert.equal(notePlace?.target?.kind, 'note');
  assert.equal(notePlace?.target?.kind === 'note' && notePlace.target.blockId, notes.blocks[0]?.id);
  // Read: nothing left to read.
  assert.deepEqual(v.conceptsToRead, { materials: 0, changed: 0, pieces: 0 });
  // Linked, suggested.
  assert.equal(v.conceptLinks.length, 1);
  // A material's concepts, from its side.
  const here = (await api<{ concepts: Array<{ title: string; places: unknown[] }> }>(s, 'GET', `/api/items/note/${notes.id}/concepts`)).json.concepts;
  assert.deepEqual(here.map((c) => [c.title, c.places.length]).sort(), [
    ['den', 1],
    ['moss blanket', 1],
  ]);

  // Another room with only the notes: the same concepts, the same ids.
  const other = await room('Dens', [{ kind: 'note', id: notes.id }]);
  const w = await view(other);
  assert.deepEqual(w.concepts.map((c) => c.id).sort(), v.concepts.map((c) => c.id).sort());
  assert.deepEqual(byTitle(w, 'moss blanket').sources.map((x) => x.inRoom), [false, true]);
  assert.ok(byTitle(w, 'moss blanket').also.includes(id));
  // Concepts are not rooms: not in the list of rooms.
  const rooms = (await api<{ rooms: Room[] }>(s, 'GET', `/api/notebooks/${notebookId}/rooms`)).json.rooms;
  assert.ok(!rooms.some((r) => r.kind === 'concept'));
});

test('by hash: read again, nothing is read; a block edited, only its note is read again, its mentions follow; a dismissed concept is not suggested again', async () => {
  const a = await source('# Lantern moss\n\n**Lantern moss** is moss that glows at night.');
  const n = await note('Moss notes', '**Lantern moss** is grown in caves.');
  const id = await room('Lantern', [
    { kind: 'source', id: a.id },
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
  // "lantern moss" is only in the source now; "cave glow" is defined in the note.
  assert.deepEqual(byTitle(v, 'lantern moss').sources.map((x) => x.item), [`source:${a.id}`]);
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
  const t = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: t });
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'Why does **night bloom** open late?' });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const id = await room('Night', [{ kind: 'thread', id: t }]);
  await read(id);
  assert.deepEqual((await view(id)).conceptsToRead, { materials: 0, changed: 0, pieces: 0 });
  // The answer's words change while the thread's own time stays where the question put it, as when an answer
  // ends after the room was shown.
  const answer = s.db.sql.prepare('SELECT current_revision_id AS rev FROM message WHERE id = ?').get(r.json.assistant.id) as { rev: string };
  s.db.sql.prepare("UPDATE message_revision SET content = content || ' **Moon moss** opens with it.', updated_at = ? WHERE id = ?").run(new Date().toISOString(), answer.rev);
  assert.deepEqual((await view(id)).conceptsToRead, { materials: 1, changed: 1, pieces: 1 });
});

test('new names are joined: a known concept\'s other name; two new names for one idea, judged the same; a renamed concept keeps its old name', async () => {
  const a = await source('# Training\n\n**Gradient checkpointing** is keeping fewer activations and recomputing them.');
  const id = await room('Memory', [{ kind: 'source', id: a.id }]);
  let v = await read(id);
  const gc = byTitle(v, 'gradient checkpointing');
  assert.ok(gc);
  // "GC", once the concept is known: the piece gives the known name.
  const b = await note('Short', '**GC** saves memory on long sequences.');
  // Two new names in one reading, the same idea: "SGD" and "stochastic gradient descent".
  const c = await note('Optimizers', '**Stochastic gradient descent** is stepping along a noisy gradient.');
  const d = await note('Steps', '**SGD** needs a learning rate.');
  for (const x of [b, c, d]) await api(s, 'POST', `/api/rooms/${id}/items`, { items: [{ kind: 'note', id: x.id }] });
  v = await read(id);
  assert.deepEqual(byTitle(v, 'gradient checkpointing').sources.map((x) => x.item), [`source:${a.id}`, `note:${b.id}`]);
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
  const a = await source('# Dens\n\n**Snow den** is a den dug in snow. A **snow den** stays warm.');
  const b = await note('Den A', 'A **snow den** has one door.');
  const c = await note('Den B', 'A **snow den** needs a vent.');
  const id = await room('Snow', [
    { kind: 'source', id: a.id },
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
  // Note B changes a little; read again, its mention joins "Den doors", not "snow den".
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
  await api(s, 'DELETE', `/api/sources/${a.id}/forever`);
  v = await view(id);
  assert.ok(!byTitle(v, 'snow den')?.sources.some((x) => x.item === `source:${a.id}`));
  assert.equal((s.db.sql.prepare('SELECT count(*) AS n FROM concept_mention WHERE item_id = ?').get(a.id) as { n: number }).n, 0);
});

test('moved between concepts: its places go with it; merged: one concept with both names; made a room: a room inside, its names never suggested again', async () => {
  const a = await source('# Ice\n\n**Ice shelf** is floating ice. **Pack ice** is broken ice.');
  const b = await note('Shelf', 'The **ice shelf** cracks in spring. **Pack ice** drifts.');
  const id = await room('Ice', [
    { kind: 'source', id: a.id },
    { kind: 'note', id: b.id },
  ]);
  let v = await read(id);
  const shelf = byTitle(v, 'ice shelf');
  const pack = byTitle(v, 'pack ice');
  // Moved: the note's "ice shelf" places go to "pack ice".
  assert.equal((await api(s, 'POST', `/api/concepts/${shelf.id}/move`, { item: { kind: 'note', id: b.id }, to: pack.id })).status, 200);
  v = await view(id);
  assert.deepEqual(byTitle(v, 'pack ice').sources.find((x) => x.item === `note:${b.id}`)?.places.length, 2);
  assert.ok(!byTitle(v, 'ice shelf').sources.some((x) => x.item === `note:${b.id}`));
  // Merged: names, places, things.
  assert.equal((await api(s, 'POST', `/api/rooms/${shelf.id}/merge`, { into: pack.id })).status, 200);
  v = await view(id);
  assert.equal(v.concepts.length, 1);
  assert.ok(byTitle(v, 'pack ice').names.includes('ice shelf'));
  assert.equal(byTitle(v, 'pack ice').places, 4);
  // Made a room, inside this one: a room now; the next reading does not suggest it again.
  const grown = await api<Room>(s, 'POST', `/api/concepts/${pack.id}/room`, { inside: id });
  assert.equal(grown.json.kind, 'room');
  v = await read(id);
  assert.deepEqual(v.concepts, []);
  assert.deepEqual(
    v.doors.map((d) => d.id),
    [pack.id],
  );
  // A concept and a room are not merged; a concept cannot hold rooms or concepts.
  const other = await room('Other', []);
  const c = await api<Room>(s, 'POST', `/api/rooms/${id}/concepts`, { id: ulid(), title: 'Floe', items: [{ kind: 'note', id: b.id }] });
  assert.equal(c.json.kind, 'concept');
  assert.equal((await api(s, 'POST', `/api/rooms/${c.json.id}/merge`, { into: other })).status, 400);
  assert.equal((await api(s, 'POST', `/api/rooms/${c.json.id}/rooms`, { room: other })).status, 400);
  // Deleting the room leaves the concept: it belongs to the notebook.
  await api(s, 'DELETE', `/api/rooms/${id}`);
  assert.equal((await api(s, 'GET', `/api/rooms/${c.json.id}`)).status, 200);
});
