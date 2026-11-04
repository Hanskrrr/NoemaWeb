import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUlid, ulid, ulidTime } from '../src/index.ts';

test('ulid is 26 Crockford base32 characters and carries its time', () => {
  const t = Date.UTC(2026, 10, 4, 12, 0, 0);
  const id = ulid(t);
  assert.equal(id.length, 26);
  assert.ok(isUlid(id));
  assert.equal(ulidTime(id), t);
});

test('ulids made in the same millisecond still sort in creation order', () => {
  const t = Date.now() + 10_000;
  const ids = Array.from({ length: 1000 }, () => ulid(t));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test('a clock that goes backwards does not break ordering', () => {
  const a = ulid(Date.now() + 20_000);
  const b = ulid(Date.now()); // earlier wall clock
  assert.ok(b > a);
});

test('isUlid rejects lookalikes', () => {
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI'), false); // I is not in the alphabet
  assert.equal(isUlid('81ARZ3NDEKTSV4RRFFQ69G5FAV'), false); // time overflow
  assert.equal(isUlid('short'), false);
  assert.equal(isUlid(42), false);
});
