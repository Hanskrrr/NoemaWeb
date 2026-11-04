import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnchor, resolveAnchor, toW3CSelectors } from '../src/index.ts';

const TEXT = 'Gradient descent moves against the gradient. The gradient points uphill.';

test('an anchor keeps the exact text, some context, and the offsets', () => {
  const start = TEXT.indexOf('against');
  const a = createAnchor('rev1', TEXT, start, start + 'against the gradient'.length, 10);
  assert.equal(a.quote.exact, 'against the gradient');
  assert.equal(a.quote.prefix, 'ent moves ');
  assert.equal(a.quote.suffix, '. The grad');
  assert.deepEqual(a.position, { start, end: start + 20 });
  assert.deepEqual(resolveAnchor(a, TEXT), { status: 'exact', start, end: start + 20 });
});

test('bad ranges throw instead of making a broken anchor', () => {
  assert.throws(() => createAnchor('r', TEXT, 5, 5), RangeError);
  assert.throws(() => createAnchor('r', TEXT, -1, 3), RangeError);
  assert.throws(() => createAnchor('r', TEXT, 0, TEXT.length + 1), RangeError);
  assert.throws(() => createAnchor('r', TEXT, 1.5, 3), RangeError);
});

test('offsets never split an emoji or other surrogate pair', () => {
  const text = 'ok 😀 then';
  const emoji = text.indexOf('😀');
  const a = createAnchor('r', text, emoji + 1, emoji + 2); // inside the pair
  assert.equal(a.quote.exact, '😀');
  assert.deepEqual(a.position, { start: emoji, end: emoji + 2 });
});

test('if the text moved, a unique quote still resolves, and says it moved', () => {
  const start = TEXT.indexOf('points uphill');
  const a = createAnchor('r', TEXT, start, start + 13);
  const edited = `Note: ${TEXT}`;
  const r = resolveAnchor(a, edited);
  assert.equal(r.status, 'moved');
  if (r.status === 'moved') assert.equal(edited.slice(r.start, r.end), 'points uphill');
});

test('a repeated quote resolves by context, or reports ambiguity instead of guessing', () => {
  const second = TEXT.lastIndexOf('gradient');
  const a = createAnchor('r', TEXT, second, second + 8);
  const shifted = `>> ${TEXT}`;
  const r = resolveAnchor(a, shifted);
  assert.deepEqual(r, { status: 'moved', start: second + 3, end: second + 11 });

  const bare = { targetId: 'r', quote: { exact: 'gradient', prefix: '', suffix: '' }, position: { start: 0, end: 0 } };
  assert.deepEqual(resolveAnchor(bare, TEXT), { status: 'unresolved', reason: 'ambiguous' });
});

test('a quote that is gone is unresolved, never a jump to somewhere else', () => {
  const a = createAnchor('r', TEXT, 0, 8);
  assert.deepEqual(resolveAnchor(a, 'Something else entirely.'), { status: 'unresolved', reason: 'not_found' });
});

test('random spans in mixed scripts always resolve exactly on the same text', () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pool = ['a', 'b', ' ', '学', '习', '😀', '$', '\\', '\n', 'é'];
  for (let round = 0; round < 300; round++) {
    const text = Array.from({ length: 5 + Math.floor(rand() * 60) }, () => pool[Math.floor(rand() * pool.length)]).join('');
    const s = Math.floor(rand() * (text.length - 1));
    const e = s + 1 + Math.floor(rand() * (text.length - s - 1));
    const a = createAnchor('r', text, s, e);
    const r = resolveAnchor(a, text);
    assert.equal(r.status, 'exact');
    if (r.status === 'exact') assert.equal(text.slice(r.start, r.end), a.quote.exact);
    assert.ok(!/^[\udc00-\udfff]/.test(a.quote.exact), 'starts mid-pair');
    assert.ok(!/[\ud800-\udbff]$/.test(a.quote.exact), 'ends mid-pair');
  }
});

test('export as W3C Web Annotation selectors', () => {
  const a = createAnchor('r', TEXT, 0, 8, 4);
  assert.deepEqual(toW3CSelectors(a), [
    { type: 'TextQuoteSelector', exact: 'Gradient', prefix: '', suffix: ' des' },
    { type: 'TextPositionSelector', start: 0, end: 8 },
  ]);
});
