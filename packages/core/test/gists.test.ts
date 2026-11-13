import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gistRequest, type ItemText, linksRequest, readGist, readLinks } from '../src/index.ts';

// A conversation of two exchanges, as the AI reads it for a summary.
const q1 = 'Q: What does an all-reduce do?\nA: It sums the gradients of every worker and gives each worker the result.';
const q2 = 'Q: And the cost?\nA: About twice the model size moves per step, whatever the number of workers.';
const thread: ItemText = {
  kind: 'thread',
  title: 'All-reduce',
  text: `${q1}\n\n${q2}`,
  segments: [
    { start: 0, end: q1.length, target: { kind: 'thread', threadId: 'T', messageId: 'M1', title: 'All-reduce' } },
    { start: q1.length + 2, end: q1.length + 2 + q2.length, target: { kind: 'thread', threadId: 'T', messageId: 'M2', title: 'All-reduce' } },
  ],
};
const source: ItemText = {
  kind: 'source',
  title: 'Week 4',
  text: '# Week 4\n\nEvery worker holds a copy of the model.',
  segments: [{ start: 0, end: 47, target: { kind: 'source', sourceId: 'S', versionId: 'V', at: 0, title: 'Week 4' } }],
};

test('a summary is asked for with the thing, cut when long', () => {
  const [system, user] = gistRequest({ ...source, text: 'x'.repeat(20_000) });
  assert.match(system?.content ?? '', /Reply with one JSON object/);
  assert.match(user?.content ?? '', /^A source the learner read: “Week 4”/);
  assert.match(user?.content ?? '', /\[… the rest is not shown\]/);
});

test('each key point links to the words it quotes, where they are; a quote not there links nowhere', () => {
  const raw = `Here: {"gist": "  How an all-reduce averages gradients, and its cost.  ",
    "points": [
      {"point": "Sum and share", "quote": "sums the gradients of every worker"},
      {"point": "Cost", "quote": "twice the model   size moves per step"},
      {"point": "Made up", "quote": "a ring of eight GPUs"},
      {"point": "Fourth", "quote": "x"}
    ]}`;
  const g = readGist(raw, thread);
  assert.equal(g?.text, 'How an all-reduce averages gradients, and its cost.');
  assert.deepEqual(
    g?.points.map((p) => [p.text, p.target?.kind === 'thread' ? p.target.messageId : null]),
    [
      ['Sum and share', 'M1'],
      ['Cost', 'M2'],
      ['Made up', null],
    ],
  );
  const s = readGist('{"gist":"A copy each.","points":[{"point":"Copies","quote":"holds a copy of the model"}]}', source);
  const at = s?.points[0]?.target;
  assert.equal(at?.kind === 'source' ? at.at : -1, source.text.indexOf('holds a copy'));
  assert.equal(readGist('no json', thread), null);
  assert.equal(readGist('{"points": []}', thread), null);
});

test('links are suggested over the summaries; only numbers in the list, known kinds, each pair once', () => {
  const [, user] = linksRequest(
    [
      { kind: 'source', title: 'Week 4', gist: 'Data parallel.' },
      { kind: 'thread', title: 'All-reduce', gist: 'How gradients are averaged.' },
      { kind: 'note', title: 'Notes', gist: 'A summary.' },
    ],
    [[1, 3]],
  );
  assert.match(user?.content ?? '', /^The things:\n1\. source “Week 4”: Data parallel\.\n2\. thread/);
  assert.match(user?.content ?? '', /Already linked: 1–3\./);
  const links = readLinks(
    JSON.stringify({
      links: [
        { from: 2, to: 1, kind: 'explains', why: 'It says how the slide works.' },
        { from: 1, to: 2, kind: 'related', why: 'again, the other way' },
        { from: 3, to: 3, kind: 'related' },
        { from: 4, to: 1, kind: 'related' },
        { from: 3, to: 1, kind: 'friend-of' },
        { from: 3, to: 2, kind: 'part-of' },
      ],
    }),
    3,
  );
  assert.deepEqual(links, [
    { from: 2, to: 1, kind: 'explains', why: 'It says how the slide works.' },
    { from: 3, to: 2, kind: 'part-of', why: '' },
  ]);
  assert.equal(readLinks('{"nope": 1}', 3), null);
});
