import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conceptsRequest, readConcepts } from '../src/concepts.ts';

// Concepts (ADR 0036): what the AI is asked, and what of its reply is kept.

const opts = { things: 4, points: [2, 1, 0, 3], kept: [] as string[], dismissed: [] as string[], most: 12 };

test('the request numbers the things with their points lettered, the kept concepts first, the dismissed by name', () => {
  const [system, user] = conceptsRequest(
    'Glowfin winters',
    [
      { kind: 'source', title: 'Moss blanket', gist: 'Moss keeps it warm.', points: ['Moss is layered', 'It is warm'] },
      { kind: 'thread', title: 'Why moss?', gist: 'Asked why moss.', points: [] },
    ],
    [{ name: 'Warmth', definition: 'Keeping heat in.', things: [1] }],
    ['Fur'],
    11,
  );
  assert.match(system?.content ?? '', /concepts/);
  assert.equal(
    user?.content,
    'The room “Glowfin winters”:\n1. source “Moss blanket”: Moss keeps it warm.\n   a) Moss is layered\n   b) It is warm\n2. thread “Why moss?”: Asked why moss.\n\nConcepts the learner kept:\n[1] “Warmth”: Keeping heat in. (things 1)\n\nNot these, the learner dismissed them: “Fur”.\n\nGive at most 11 new concepts.',
  );
});

test('concepts are read with their things and the point that defines them; links follow them when some are left out', () => {
  const raw = `Here: ${JSON.stringify({
    concepts: [
      { name: 'Warmth', definition: ' Keeping  heat in. ', defined_by: '1b', things: [1, 2, 2, 9] },
      { name: 'Nothing about it', definition: 'x', defined_by: null, things: [] },
      { name: 'Dens', definition: 'Where it sleeps.', defined_by: '3a', things: [3] },
      { name: 'warmth', definition: 'the same name again', things: [4] },
    ],
    links: [
      { from: 3, to: 1, kind: 'builds-on', why: 'Dens need warmth.' },
      { from: 2, to: 1, kind: 'builds-on' },
      { from: 3, to: 1, kind: 'part-of' },
      { from: 1, to: 3, kind: 'related' },
    ],
    place: [{ thing: 4, concept: 1 }],
  })}`;
  const d = readConcepts(raw, opts);
  assert.deepEqual(d?.concepts, [
    { name: 'Warmth', definition: 'Keeping heat in.', definedBy: { thing: 1, point: 1 }, things: [1, 2] },
    // Thing 3 has no points: no definition by one.
    { name: 'Dens', definition: 'Where it sleeps.', definedBy: null, things: [3] },
  ]);
  // "Dens" was 3rd in the reply and is 2nd now; the link to the concept left out goes; a pair once; kinds concepts use.
  assert.deepEqual(d?.links, [{ from: 2, to: 1, kind: 'builds-on', why: 'Dens need warmth.' }]);
  assert.deepEqual(d?.place, [], 'no kept concepts to place things in');
});

test('kept and dismissed names are not given again; kept concepts come first in the numbers; the AI does not link two kept ones', () => {
  const raw = JSON.stringify({
    concepts: [
      { name: 'Fur', things: [1] },
      { name: 'Warmth', things: [1] },
      { name: 'Ice', defined_by: '4c', things: [4] },
    ],
    links: [
      { from: 3, to: 1, kind: 'contrasts-with' },
      { from: 2, to: 1, kind: 'builds-on' },
      { from: 5, to: 1, kind: 'builds-on' },
    ],
    place: [
      { thing: 2, concept: 1 },
      { thing: 2, concept: 1 },
      { thing: 3, concept: 3 },
      { thing: 9, concept: 1 },
    ],
  });
  const d = readConcepts(raw, { ...opts, kept: ['Warmth', 'Dens'], dismissed: ['fur'] });
  assert.deepEqual(
    d?.concepts.map((c) => [c.name, c.definedBy]),
    [['Ice', { thing: 4, point: 2 }]],
  );
  // The reply numbered "Fur" 3 and "Ice" 5 (after two kept): "Fur" is left out, so is its link; "Ice" is 3 now.
  // 2 → 1 is between two kept concepts: the AI does not link those.
  assert.deepEqual(
    d?.links.map((l) => [l.from, l.kind, l.to]),
    [[3, 'builds-on', 1]],
  );
  assert.deepEqual(d?.place, [{ thing: 2, concept: 1 }]);
});

test('no more new concepts than asked; an unreadable reply is null', () => {
  const raw = JSON.stringify({ concepts: [1, 2, 3].map((i) => ({ name: `C${i}`, things: [i] })) });
  assert.deepEqual(
    readConcepts(raw, { ...opts, most: 2 })?.concepts.map((c) => c.name),
    ['C1', 'C2'],
  );
  assert.equal(readConcepts('no json', opts), null);
  assert.equal(readConcepts('{"links": []}', opts), null);
});
