import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFor, clampFloat, FLOAT_DEFAULT, growFloat, moveFloat, readFloat } from '../src/assistantFloat.ts';

const view = { w: 1440, h: 900 };

test('the floating window stays inside the browser, below the header, and never smaller than it can be used', () => {
  assert.deepEqual(clampFloat(FLOAT_DEFAULT, view), FLOAT_DEFAULT);
  // Dragged off the left and top: back in, under the header.
  assert.deepEqual(clampFloat({ right: 5000, bottom: 5000, width: 460, height: 620 }, view), { right: 972, bottom: 222, width: 460, height: 620 });
  // Dragged off the right and bottom.
  assert.deepEqual(clampFloat({ right: -300, bottom: -40, width: 460, height: 620 }, view), { right: 8, bottom: 8, width: 460, height: 620 });
  // Too small, too big.
  assert.deepEqual(clampFloat({ right: 24, bottom: 24, width: 100, height: 50 }, view), { right: 24, bottom: 24, width: 340, height: 280 });
  assert.deepEqual(clampFloat({ right: 24, bottom: 24, width: 3000, height: 3000 }, view), { right: 24, bottom: 8, width: 900, height: 834 });
  // A phone: as wide as it can be.
  assert.deepEqual(clampFloat(FLOAT_DEFAULT, { w: 360, h: 700 }), { right: 8, bottom: 22, width: 344, height: 620 });
});

test('dragged by its header it moves with the pointer; from its corner it grows, its bottom-right staying put', () => {
  assert.deepEqual(moveFloat(FLOAT_DEFAULT, -200, -100), { ...FLOAT_DEFAULT, right: 224, bottom: 124 });
  assert.deepEqual(growFloat(FLOAT_DEFAULT, -60, -40), { ...FLOAT_DEFAULT, width: 520, height: 660 });
  // Up against the header and the left edge, it stops growing; its bottom-right does not move.
  const grown = clampFloat(growFloat({ right: 24, bottom: 200, width: 460, height: 600 }, -2000, -2000, view), view);
  assert.deepEqual(grown, { right: 24, bottom: 200, width: 900, height: 642 });
});

test('the box as stored, or the default when there is none or it cannot be read', () => {
  assert.deepEqual(readFloat(null), FLOAT_DEFAULT);
  assert.deepEqual(readFloat('not json'), FLOAT_DEFAULT);
  assert.deepEqual(readFloat('{"right":40,"bottom":60,"width":500}'), { right: 40, bottom: 60, width: 500, height: 620 });
});

test('it offers questions for the place: a selection first, then the kind of thing open, else the whole notebook', () => {
  assert.deepEqual(asksFor('room', true), ['Explain what I selected', 'What have I asked about this before?', 'Make a note of this']);
  assert.equal(asksFor('room', false)[0], 'What does this room add up to?');
  assert.equal(asksFor('source', false)[0], 'What are the key ideas here?');
  assert.equal(asksFor('thread', false)[0], 'Where did this thread end up?');
  assert.equal(asksFor('note', false)[0], 'What is this note missing?');
  assert.equal(asksFor(null, false)[0], 'Where did I leave off?');
});
