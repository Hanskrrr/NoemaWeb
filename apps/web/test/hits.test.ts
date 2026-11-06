import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchHit } from '@noema/core';
import { dayOf, kindOf, snippetParts, whereOf } from '../src/hits.ts';
import { parseHash, toHash } from '../src/route.ts';

const ID = '01JC0000000000000000000000';
const ID2 = '01JC0000000000000000000001';

const hit = (over: Partial<SearchHit>): SearchHit => ({
  kind: 'message',
  threadId: ID,
  messageId: ID2,
  noteId: null,
  blockId: null,
  role: 'user',
  title: 'Why scale by √d?',
  path: [],
  headline: null,
  at: '2026-10-12T09:00:00.000Z',
  snippet: '',
  matches: [],
  ...over,
});

test('snippets are cut into plain and marked parts; overlapping matches merge', () => {
  assert.deepEqual(snippetParts('the variance of a sum', [{ start: 4, end: 12 }]), [
    { text: 'the ', mark: false },
    { text: 'variance', mark: true },
    { text: ' of a sum', mark: false },
  ]);
  assert.deepEqual(
    snippetParts('机器学习', [
      { start: 0, end: 2 },
      { start: 1, end: 4 },
    ]),
    [{ text: '机器学习', mark: true }],
  );
  assert.deepEqual(snippetParts('abc', [{ start: 2, end: 9 }]), [
    { text: 'ab', mark: false },
    { text: 'c', mark: true },
  ]);
  assert.deepEqual(snippetParts('abc', []), [{ text: 'abc', mark: false }]);
});

test('a hit says where it is and what it is', () => {
  const side = hit({ path: [{ threadId: ID2, title: 'Attention' }] });
  assert.equal(whereOf(side), 'Attention › Why scale by √d?');
  assert.equal(kindOf(side), 'You asked in a side question');
  assert.equal(kindOf(hit({ role: 'assistant' })), 'Answer');
  assert.equal(whereOf(hit({ kind: 'block', title: '' })), 'Note · Untitled');
  assert.equal(kindOf(hit({ kind: 'thread', path: side.path })), 'Side question title');
});

test('days read as "12 Oct", with the year only when it is another year', () => {
  assert.equal(dayOf('2026-10-12T09:00:00.000Z', new Date('2026-11-06T00:00:00Z')), '12 Oct');
  assert.equal(dayOf('2025-10-12T09:00:00.000Z', new Date('2026-11-06T00:00:00Z')), '12 Oct 2025');
  assert.equal(dayOf('not a date'), '');
});

test('a note can be opened at one block, and the route survives a round trip', () => {
  const route = parseHash(`#/note/${ID}/b/${ID2}`);
  assert.deepEqual(route, { kind: 'note', id: ID, block: ID2 });
  assert.equal(toHash(route as NonNullable<typeof route>), `#/note/${ID}/b/${ID2}`);
  assert.deepEqual(parseHash(`#/note/${ID}/b/nope`), { kind: 'note', id: ID });
  assert.deepEqual(parseHash(`#/t/${ID}/m/${ID2}`), { kind: 'thread', id: ID, message: ID2 });
});
