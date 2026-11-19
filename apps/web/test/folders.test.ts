import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Room } from '@noema/core';
import { alsoIn, nextSort, roomAlsoIn, sortRows, typeAhead } from '../src/folders.ts';

// The Folders view (ADR 0035): folders stay on top, sorted by a column; a thing
// in more than one room says where else; typing jumps to a row.

const row = (title: string, folder = false, kind = 'Thread', at = '2026-11-01', open = 0) => ({ title, folder, kind, at, open });

test('folders stay on top, whichever column and way; the rest by the column, then by name', () => {
  const rows = [row('b note', false, 'Note', '2026-11-03'), row('Zeta', true, 'Room', '2026-11-01'), row('a thread', false, 'Thread', '2026-11-03', 2), row('Alpha', true, 'Room')];
  const titles = (r: typeof rows) => r.map((x) => x.title);
  assert.deepEqual(titles(sortRows(rows, { by: 'name', desc: false })), ['Alpha', 'Zeta', 'a thread', 'b note']);
  assert.deepEqual(titles(sortRows(rows, { by: 'name', desc: true })), ['Zeta', 'Alpha', 'b note', 'a thread']);
  // The same date: by name.
  assert.deepEqual(titles(sortRows(rows, { by: 'touched', desc: true })), ['Alpha', 'Zeta', 'a thread', 'b note']);
  assert.deepEqual(titles(sortRows(rows, { by: 'open', desc: true })), ['Alpha', 'Zeta', 'a thread', 'b note']);
  assert.deepEqual(titles(sortRows(rows, { by: 'kind', desc: false })), ['Alpha', 'Zeta', 'b note', 'a thread']);
  // Numbers in names count as numbers: week 2 before week 10.
  assert.deepEqual(titles(sortRows([row('Week 10'), row('Week 2')], { by: 'name', desc: false })), ['Week 2', 'Week 10']);
});

test('a click on a column sorts by it; again, the other way; dates and open questions start with the most', () => {
  assert.deepEqual(nextSort({ by: 'name', desc: false }, 'name'), { by: 'name', desc: true });
  assert.deepEqual(nextSort({ by: 'name', desc: false }, 'touched'), { by: 'touched', desc: true });
  assert.deepEqual(nextSort({ by: 'touched', desc: true }, 'kind'), { by: 'kind', desc: false });
});

const room = (id: string, members: string[], parents: string[] = []): Room => ({
  id,
  notebookId: 'nb',
  title: id,
  createdAt: '',
  updatedAt: '',
  members: members as Room['members'],
  counts: { sources: 0, threads: 0, notes: 0, rooms: 0 },
  web: true,
  parents,
  rooms: [],
});

test('also in: the other rooms a thing or a room is in, never the one it is listed in', () => {
  const t = 'thread:01JX0000000000000000000000';
  const rooms = [room('a', [t]), room('b', [t]), room('c', []), room('d', [], ['a', 'c'])];
  assert.deepEqual(alsoIn(rooms, t, 'a').map((r) => r.id), ['b']);
  assert.deepEqual(alsoIn(rooms, t, 'c').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(roomAlsoIn(rooms, 'd', 'a').map((r) => r.id), ['c']);
  assert.deepEqual(roomAlsoIn(rooms, 'missing', 'a'), []);
});

test('typing jumps to the next row whose name starts so, round again from the top', () => {
  const titles = ['Optimization', 'Activation notes', 'Adam notes', ''];
  assert.equal(typeAhead(titles, 'a', 0), 1);
  assert.equal(typeAhead(titles, 'a', 2), 2);
  assert.equal(typeAhead(titles, 'a', 3), 1);
  assert.equal(typeAhead(titles, 'ad', 1), 2);
  assert.equal(typeAhead(titles, 'unt', 0), 3, 'a row with no name is "Untitled"');
  assert.equal(typeAhead(titles, 'z', 0), -1);
  assert.equal(typeAhead(titles, '', 0), -1);
});
