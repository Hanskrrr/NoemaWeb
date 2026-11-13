import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSent } from '@noema/core';
import { lookupWhat, partLabel } from '../src/sent.ts';
import { getPresence, onPulse, presenceOf, pulse, setPresence } from '../src/presence.ts';
import { parseHash, toHash } from '../src/route.ts';

test('the Assistant has its own place in the address', () => {
  assert.deepEqual(parseHash('#/assistant'), { kind: 'assistant' });
  assert.equal(toHash({ kind: 'assistant' }), '#/assistant');
});

test('what the frame shows follows the answer: thinking, looking, writing, then a bloom', () => {
  assert.equal(presenceOf('pending', null), 'thinking');
  assert.equal(presenceOf('pending', 'looking'), 'looking');
  assert.equal(presenceOf('streaming', null), 'writing');
  assert.equal(presenceOf('streaming', 'writing'), 'writing');
  assert.equal(presenceOf('done', null), 'done');
  assert.equal(presenceOf('failed', null), 'idle');
  assert.equal(presenceOf('stopped', 'looking'), 'idle');
});

test('presence is one value; pulses reach whoever listens', () => {
  setPresence('thinking');
  assert.equal(getPresence(), 'thinking');
  const got: number[] = [];
  const off = onPulse((n) => got.push(n));
  pulse(0.4);
  off();
  pulse(0.9);
  assert.deepEqual(got, [0.4]);
  setPresence('off');
  assert.equal(getPresence(), 'off');
});

test('What was sent names each lookup in a few words', () => {
  assert.equal(lookupWhat({ name: 'search', arguments: '{"query":"variance"}' }), '“variance”');
  assert.equal(lookupWhat({ name: 'open', arguments: '{"ref":3,"page":12}' }), '[3], page 12');
  assert.equal(lookupWhat({ name: 'list', arguments: '{"what":"notes"}' }), 'the notes');
  assert.equal(lookupWhat({ name: 'open', arguments: 'not json' }), 'not json');
  const parts = describeSent({ parts: [{ kind: 'overview', tokens: 3 }, { kind: 'question', id: 'q', tokens: 2 }, { kind: 'lookup', tokens: 4 }] }, [
    { role: 'user', content: 'O\n\nQ' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'search', arguments: '{"query":"x"}' }] },
    { role: 'tool', toolCallId: 'c', content: 'found' },
  ]);
  assert.deepEqual(parts.map(partLabel), ['Your question, with an overview of your notebook', 'It searched “x”: what came back']);
});
