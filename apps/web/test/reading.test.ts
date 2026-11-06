import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchHit, Thread } from '@noema/core';
import { kindOf, whereOf } from '../src/hits.ts';
import { askedPassages, headingText, markStrength, sourceFamily } from '../src/reading.ts';
import { parseHash, toHash } from '../src/route.ts';

const id = (n: number) => `01JC00000000000000000000${String(n).padStart(2, '0')}`;
const SRC = id(90);
const V1 = id(91);
const V2 = id(92);

const thread = (n: number, over: Partial<Thread> = {}): Thread => ({
  id: id(n),
  notebookId: id(99),
  parentThreadId: null,
  originQuote: null,
  splitAt: null,
  mergedIntoId: null,
  continuedFromId: null,
  deletedAt: null,
  sourceId: null,
  sourceVersionId: null,
  sourceQuote: null,
  title: `t${n}`,
  titleSource: 'question',
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
  ...over,
});

test('source routes: a version, an offset from search, and the way back from a thread', () => {
  const cases = [
    [`#/s/${SRC}`, { kind: 'source', id: SRC }],
    [`#/s/${SRC}/v/${V1}`, { kind: 'source', id: SRC, version: V1 }],
    [`#/s/${SRC}/at/120`, { kind: 'source', id: SRC, at: 120 }],
    [`#/s/${SRC}/v/${V2}/from/${id(1)}`, { kind: 'source', id: SRC, version: V2, from: id(1) }],
  ] as const;
  for (const [hash, route] of cases) {
    assert.deepEqual(parseHash(hash), route);
    assert.equal(toHash(route), hash);
  }
  assert.deepEqual(parseHash(`#/s/${SRC}/at/-3`), { kind: 'source', id: SRC });
  assert.equal(parseHash('#/s/nope'), null);
});

test('a thread belongs to the source its first question was asked about, side questions and split-offs too', () => {
  const asked = thread(1, { sourceId: SRC, sourceVersionId: V1, sourceQuote: 'x' });
  const side = thread(2, { parentThreadId: asked.id });
  const sideOfSide = thread(3, { parentThreadId: side.id });
  const splitOff = thread(4, { continuedFromId: asked.id });
  const plain = thread(5);
  const threads = [asked, side, sideOfSide, splitOff, plain];
  const family = { sourceId: SRC, versionId: V1, rootId: asked.id };
  for (const t of [asked, side, sideOfSide, splitOff]) assert.deepEqual(sourceFamily(threads, t.id), family);
  assert.equal(sourceFamily(threads, plain.id), null);
  assert.equal(sourceFamily(threads, id(77)), null);
});

test('asked passages: overlapping ones are one stretch; most questions first, then reading order', () => {
  const content = 'aaaa bbbb cccc dddd eeee';
  const at = (n: number, start: number, end: number, questions: number) => ({
    threadId: id(n),
    title: `t${n}`,
    createdAt: '2026-11-06T10:00:00.000Z',
    passage: { versionId: V1, start, end, exact: content.slice(start, end), prefix: '', suffix: '' },
    questions,
  });
  const passages = askedPassages([at(1, 0, 4, 1), at(2, 10, 14, 1), at(3, 12, 19, 2), at(4, 20, 24, 1)], content);
  assert.deepEqual(
    passages.map((p) => [p.exact, p.questions, p.threads.map((t) => t.threadId)]),
    [
      ['cccc dddd', 3, [id(2), id(3)]],
      ['aaaa', 1, [id(1)]],
      ['eeee', 1, [id(4)]],
    ],
  );
  assert.ok(markStrength(1) < markStrength(2) && markStrength(5) === 1 && markStrength(20) === 1);
});

test('search hits in a source say so; headings read as plain words', () => {
  const base: SearchHit = {
    kind: 'passage',
    threadId: null,
    messageId: null,
    noteId: null,
    blockId: null,
    sourceId: SRC,
    versionId: V1,
    offset: 10,
    role: null,
    title: 'Attention Is All You Need',
    path: [],
    headline: null,
    at: '2026-11-06T10:00:00.000Z',
    snippet: '',
    matches: [],
  };
  assert.equal(kindOf(base), 'In a source');
  assert.equal(kindOf({ ...base, kind: 'source' }), 'Source title');
  assert.equal(whereOf(base), 'Source · Attention Is All You Need');
  assert.equal(headingText('3.2 \\*Scaled\\* [Dot-Product](#x) **Attention**'), '3.2 *Scaled* Dot-Product Attention');
});
