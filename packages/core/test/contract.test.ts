import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AskRequest, assertTransition, canTransition, describeError, ErrorKind, isTerminal, ulid } from '../src/index.ts';

test('AskRequest needs a ULID and some non-blank text', () => {
  assert.equal(AskRequest.safeParse({ id: ulid(), content: 'hi' }).success, true);
  assert.equal(AskRequest.safeParse({ id: 'nope', content: 'hi' }).success, false);
  assert.equal(AskRequest.safeParse({ id: ulid(), content: '   ' }).success, false);
});

test('terminal message states never change', () => {
  assert.ok(canTransition('pending', 'streaming'));
  assert.ok(canTransition('streaming', 'done'));
  assert.ok(isTerminal('done'));
  assert.throws(() => assertTransition('done', 'streaming'));
  assert.throws(() => assertTransition('interrupted', 'done'));
});

test('every error kind has a plain description', () => {
  for (const kind of ErrorKind.options) assert.ok(describeError(kind).length > 10, kind);
});
