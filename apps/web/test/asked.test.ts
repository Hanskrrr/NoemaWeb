import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskedHit } from '@noema/core';
import { mergeAsked } from '../src/asked.ts';

const hit = (thread: string, strength: AskedHit['strength'], by: AskedHit['by'], message = `${thread}-q`): AskedHit => ({
  messageId: message,
  threadId: thread,
  threadTitle: thread,
  question: 'q',
  passage: null,
  headline: null,
  askedAt: '2026-11-01T00:00:00.000Z',
  strength,
  by,
  terms: [],
});

test('reminders found by words and by meaning are put together: one per thread, same first, two at most', () => {
  const ids = (hits: AskedHit[]) => hits.map((h) => `${h.threadId}:${h.strength}:${h.by}`);
  // Only words yet (the model has not answered).
  assert.deepEqual(ids(mergeAsked([hit('a', 'related', 'words')], [])), ['a:related:words']);
  // Found both ways: one reminder, the stronger reading.
  assert.deepEqual(ids(mergeAsked([hit('a', 'related', 'words')], [hit('a', 'same', 'meaning')])), ['a:same:meaning']);
  assert.deepEqual(ids(mergeAsked([hit('a', 'same', 'words')], [hit('a', 'related', 'meaning')])), ['a:same:words']);
  // Meaning adds what words missed; same goes first; no more than two.
  assert.deepEqual(
    ids(mergeAsked([hit('a', 'related', 'words'), hit('b', 'related', 'words')], [hit('c', 'same', 'meaning')])),
    ['c:same:meaning', 'a:related:words'],
  );
  assert.deepEqual(mergeAsked([], []), []);
});
