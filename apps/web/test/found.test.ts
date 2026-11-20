import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteWords } from '../src/found.ts';

// Arriving at quoted words (ADR 0037): the quote is the material's Markdown,
// the page shows it rendered, so each run between the marks is found on its own.

test('a quote is marked by the runs of words between its Markdown marks, the first 48 characters of each', () => {
  assert.deepEqual(quoteWords('**Lantern moss** is a moss that glows at night.'), ['Lantern moss', 'is a moss that glows at night.']);
  assert.deepEqual(quoteWords('Plain words stay one run.'), ['Plain words stay one run.']);
  assert.deepEqual(quoteWords('Call `torch.utils.checkpoint` on a *block*'), ['Call', 'torch.utils.checkpoint', 'on a', 'block']);
  assert.deepEqual(quoteWords('A sentence much longer than forty-eight characters is cut at a space.'), ['A sentence much longer than forty-eight']);
  assert.deepEqual(quoteWords('2 * 3 is six'), ['2 * 3 is six']);
});
