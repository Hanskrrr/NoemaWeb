import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PathLink, pathOrder } from '../src/path.ts';

// A room as a path (ADR 0035): an order made only from the links kept.

const l = (from: string, kind: PathLink['kind'], to: string): PathLink => ({ from, to, kind });

test('what a thing builds on comes first; things that contrast stand side by side; what no link orders is not on the path', () => {
  const keys = ['backprop', 'memory', 'checkpoint', 'fp16', 'zero', 'syllabus'];
  const p = pathOrder(keys, [
    l('memory', 'builds-on', 'backprop'),
    l('checkpoint', 'builds-on', 'memory'),
    l('fp16', 'contrasts-with', 'checkpoint'),
    l('zero', 'builds-on', 'backprop'),
    l('syllabus', 'related', 'backprop'),
  ]);
  assert.deepEqual(
    p.steps.map((s) => [s.key, s.beside, s.level, s.after]),
    [
      ['backprop', [], 0, []],
      ['memory', [], 1, ['backprop']],
      ['zero', [], 1, ['backprop']],
      ['checkpoint', ['fp16'], 2, ['memory']],
    ],
  );
  assert.deepEqual(p.loose, ['syllabus'], '"related" does not order');
  assert.equal(p.broken, 0);
});

test('an example, a part and an explanation come after what they are of', () => {
  const p = pathOrder(['example', 'idea', 'part', 'whole', 'note'], [
    l('example', 'example-of', 'idea'),
    l('part', 'part-of', 'whole'),
    l('note', 'explains', 'idea'),
  ]);
  assert.deepEqual(
    p.steps.map((s) => s.key),
    ['idea', 'whole', 'example', 'part', 'note'],
  );
});

test('a circle is broken at its last link, and said', () => {
  const p = pathOrder(['a', 'b', 'c'], [l('b', 'builds-on', 'a'), l('c', 'builds-on', 'b'), l('a', 'builds-on', 'c')]);
  assert.deepEqual(
    p.steps.map((s) => s.key),
    ['a', 'b', 'c'],
  );
  assert.equal(p.broken, 1);
});

test('nothing kept: nothing on the path; two things that only contrast are not on it either', () => {
  assert.deepEqual(pathOrder(['a', 'b'], []), { steps: [], loose: ['a', 'b'], broken: 0 });
  assert.deepEqual(pathOrder(['a', 'b'], [l('a', 'contrasts-with', 'b')]).loose, ['a', 'b']);
  // Links to things not in the room, or to itself, are ignored.
  assert.deepEqual(pathOrder(['a'], [l('a', 'builds-on', 'zzz'), l('a', 'builds-on', 'a')]).loose, ['a']);
});

test('side by side, at different depths, they are two steps', () => {
  const p = pathOrder(['a', 'b', 'c'], [l('b', 'builds-on', 'a'), l('c', 'contrasts-with', 'a'), l('c', 'contrasts-with', 'b')]);
  assert.deepEqual(
    p.steps.map((s) => [s.key, s.beside]),
    [
      ['a', ['c']],
      ['b', []],
    ],
  );
});
