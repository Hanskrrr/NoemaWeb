import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bounds, fitName, fitParts, layoutConcepts, leafRadius, nameFor, pack } from '../src/conceptMap.ts';

// The map of a room's concepts (ADR 0038): circles that never overlap, what is
// under a concept inside its circle, bigger with more of the learner's work,
// the same every time, and where the learner moved one stays.

const inside = (a: { x: number; y: number; r: number }, b: { x: number; y: number; r: number }) => Math.hypot(a.x - b.x, a.y - b.y) + a.r <= b.r + 1e-6;
const apart = (a: { x: number; y: number; r: number }, b: { x: number; y: number; r: number }) => Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1e-6;

test('discs packed around a center do not overlap; the radius holds them all', () => {
  const discs = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, x: 0, y: 0, r: 20 + i * 3, fixed: false }));
  const r = pack(discs, 8);
  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) assert.ok(apart(discs[i] as never, discs[j] as never), `${i} and ${j} overlap`);
    assert.ok(Math.hypot(discs[i]?.x ?? 0, discs[i]?.y ?? 0) + (discs[i]?.r ?? 0) <= r + 1e-6);
  }
});

test('the map: topics hold their concepts, concepts hold theirs, none overlap, more work is bigger, the same each time', () => {
  const nodes = [
    { id: 'opt', parent: null, weight: 0 },
    { id: 'adam', parent: 'opt', weight: 9 },
    { id: 'adamw', parent: 'adam', weight: 1 },
    { id: 'sgd', parent: 'opt', weight: 2 },
    { id: 'mem', parent: null, weight: 0 },
    { id: 'gc', parent: 'mem', weight: 4 },
    { id: 'act', parent: 'mem', weight: 1 },
    { id: 'loose', parent: null, weight: 1 },
    { id: 'lost', parent: 'nowhere', weight: 1 },
  ];
  const map = layoutConcepts(nodes);
  const at = (id: string) => map.get(id) as { x: number; y: number; r: number; depth: number; parent: string | null };
  assert.ok(inside(at('adam'), at('opt')));
  assert.ok(inside(at('adamw'), at('adam')));
  assert.ok(inside(at('sgd'), at('opt')));
  assert.ok(apart(at('adam'), at('sgd')));
  assert.ok(apart(at('opt'), at('mem')));
  assert.ok(apart(at('opt'), at('loose')));
  assert.equal(at('adamw').depth, 2);
  // Under something not on the map: at the top.
  assert.equal(at('lost').parent, null);
  assert.ok(at('gc').r > at('act').r);
  assert.equal(leafRadius(9), 80);
  assert.deepEqual([...layoutConcepts(nodes)], [...map]);
  const b = bounds(map.values());
  assert.ok(b && b.maxX > b.minX);
});

test('where the learner moved a concept stays, relative to what it is under; a circle of parents is broken', () => {
  const nodes = [
    { id: 'opt', parent: null, weight: 0 },
    { id: 'adam', parent: 'opt', weight: 3 },
    { id: 'sgd', parent: 'opt', weight: 3 },
  ];
  const before = layoutConcepts(nodes);
  const moved = layoutConcepts(nodes, new Map([['adam', { x: 40, y: -10 }]]));
  const opt = moved.get('opt') as { x: number; y: number };
  const adam = moved.get('adam') as { x: number; y: number };
  assert.ok(Math.abs(adam.x - opt.x - 40) < 1e-6);
  assert.notDeepEqual(before.get('adam'), moved.get('adam'));
  const round = layoutConcepts([
    { id: 'a', parent: 'b', weight: 1 },
    { id: 'b', parent: 'a', weight: 1 },
  ]);
  assert.equal(round.size, 2);
  assert.ok([...round.values()].some((n) => n.parent === null));
});

test('a name cut to fit', () => {
  assert.equal(fitName('gradient checkpointing', 30), 'gradient checkpointing');
  assert.equal(fitName('gradient checkpointing', 9), 'gradient…');
  assert.equal(fitName('abc', 1), '…');
  assert.equal(fitParts(['1 question', '1 note'], 30), '1 question · 1 note');
  assert.equal(fitParts(['1 question', '1 note'], 15), '1 question');
  assert.equal(fitParts(['12 questions'], 6), '12 qu…');
});

test('a name shows whole, cut a little, or not at all until its circle is bigger', () => {
  assert.equal(nameFor('adam', 30, 12, false), 'adam');
  assert.equal(nameFor('gradient checkpointing', 80, 12, false), 'gradient checkpointing');
  assert.equal(nameFor('gradient checkpointing', 22, 12, false), null);
  const cut = nameFor('gradient checkpointing', 60, 12, false);
  assert.ok(cut === null || cut.endsWith('…') || cut === 'gradient checkpointing' || cut === 'gradient\ncheckpointing');
  // At the top of a circle holding others, there is less room, and one line.
  assert.equal(nameFor('gradient checkpointing', 50, 12, true), null);
  // A circle holding nothing breaks a long name between words (or after a hyphen), onto two or three lines.
  assert.equal(nameFor('learning-rate warmup', 40, 11.8, false), 'learning-\nrate\nwarmup');
  assert.equal(nameFor('learning-rate warmup', 52, 12, false), 'learning-rate\nwarmup');
  assert.equal(nameFor('gradient checkpointing', 50, 12, false), 'gradient\ncheckpointing');
  assert.equal(nameFor('supercalifragilistic', 30, 12, false), null);
});
