import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeClusters, type RoomGraph, type RoomRow, roomKey, roomMap, roomMembers } from '../src/index.ts';

const T = (id: string, over: Partial<RoomGraph['threads'][number]> = {}): RoomGraph['threads'][number] => ({
  id,
  title: id,
  parentThreadId: null,
  splitAt: null,
  continuedFromId: null,
  mergedIntoId: null,
  sourceId: null,
  sourceQuote: null,
  updatedAt: '2026-11-01',
  questions: 1,
  open: false,
  ...over,
});

// A deck with two threads about it (one with a side question left open) and a
// note made from one; a paper with a thread; a thread split off from the first.
const g: RoomGraph = {
  threads: [
    T('deckA', { sourceId: 'deck', sourceQuote: 'all-reduce', questions: 3 }),
    T('sideA', { parentThreadId: 'deckA', questions: 2, open: true, updatedAt: '2026-11-05' }),
    T('deckB', { sourceId: 'deck', questions: 1 }),
    T('paperA', { sourceId: 'paper' }),
    T('split', { continuedFromId: 'deckA' }),
    T('loose'),
  ],
  sources: [
    { id: 'deck', title: 'Week 4 slides', updatedAt: '2026-10-30', linked: false },
    { id: 'paper', title: 'Attention paper', updatedAt: '2026-10-29', linked: true },
  ],
  notes: [
    { id: 'n1', title: 'Data parallel', threadId: 'sideA', cites: ['paperA'], blocks: 4, updatedAt: '2026-11-02' },
    { id: 'n2', title: 'Loose note', threadId: null, cites: [], blocks: 1, updatedAt: '2026-11-03' },
  ],
  pins: [{ threadId: 'split', sourceId: 'paper' }],
};
const row = (kind: RoomRow['kind'], id: string, over: Partial<RoomRow> = {}): RoomRow => ({
  kind,
  id,
  state: 'in',
  x: null,
  y: null,
  at: '2026-11-10',
  ...over,
});

test('a source brings the threads asked about it and the notes made from them; a thread its notes', () => {
  const m = roomMembers([row('source', 'deck')], g);
  assert.deepEqual([...m.keys()].sort(), ['note:n1', 'source:deck', 'thread:deckA', 'thread:deckB']);
  assert.deepEqual(m.get('note:n1'), { explicit: false, via: 'source:deck' });
  // A side question goes in as the thread it is part of.
  assert.deepEqual([...roomMembers([row('thread', 'sideA')], g).keys()].sort(), ['note:n1', 'thread:deckA']);
  // A note brings nothing.
  assert.deepEqual([...roomMembers([row('note', 'n1')], g).keys()], ['note:n1']);
});

test('something that came with another can be taken out, and stays out unless put in by hand', () => {
  const out = roomMembers([row('source', 'deck'), row('thread', 'deckA', { state: 'out' })], g);
  // Out goes the thread, and the note that came with it.
  assert.deepEqual([...out.keys()].sort(), ['source:deck', 'thread:deckB']);
  const back = roomMembers([row('source', 'deck'), row('thread', 'deckA', { state: 'out' }), row('note', 'n1')], g);
  assert.ok(back.has('note:n1'));
  // A thing that was deleted is not there.
  assert.equal(roomMembers([row('source', 'gone')], g).size, 0);
});

test('a room is drawn as clusters of what belongs together, with marks, and lines that say how they are linked', () => {
  const map = roomMap([row('source', 'deck'), row('source', 'paper'), row('thread', 'split'), row('note', 'n2')], g);
  assert.deepEqual(
    map.clusters.map((c) => c.cards.map((x) => roomKey(x.kind, x.id))),
    [['source:deck', 'thread:deckA', 'thread:deckB', 'note:n1'], ['source:paper', 'thread:paperA'], ['thread:split'], ['note:n2']],
  );
  const deck = map.clusters[0]?.cards[0];
  assert.deepEqual(deck?.marks, { questions: 6, sides: 1, open: 1, threads: 2, blocks: 0, at: '2026-11-05' });
  assert.equal(map.clusters[1]?.cards[0]?.file, true);
  assert.deepEqual(map.counts, { sources: 2, threads: 4, notes: 2 });
  assert.deepEqual(
    map.links.map((l) => [l.from, l.to, l.kinds]),
    [
      ['thread:split', 'source:deck', ['came-from']],
      ['thread:split', 'source:paper', ['keeps-in-view']],
      ['source:deck', 'source:paper', ['cites']],
    ],
  );
});

test('a cluster sits where any of its cards was placed; new ones go into the column that ends highest', () => {
  const map = roomMap([row('source', 'deck'), row('note', 'n1', { state: 'placed', x: 40, y: 300 }), row('note', 'n2')], g);
  assert.deepEqual([map.clusters[0]?.x, map.clusters[0]?.y], [40, 300]);
  const spots = placeClusters(
    [
      { key: 'a', w: 280, h: 200, x: 24, y: 24 },
      { key: 'b', w: 280, h: 100, x: null, y: null },
      { key: 'c', w: 280, h: 100, x: null, y: null },
      { key: 'd', w: 280, h: 100, x: null, y: null },
    ],
    { columns: 2, columnWidth: 280, gap: 24, left: 24, top: 24 },
  );
  assert.deepEqual(Object.fromEntries(spots), { b: { x: 328, y: 24 }, c: { x: 328, y: 148 }, d: { x: 24, y: 248 } });
});
