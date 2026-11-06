import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCitations, splitCitations } from '../src/cite.ts';

test('the model’s citation variants become one label per bracket', () => {
  assert.equal(
    normalizeCitations('See [E1][E3], also [E2, E4], [E5，E6] and 【E1】 or ［E7］.'),
    'See [E1][E3], also [E2][E4], [E5][E6] and [E1] or [E7].',
  );
  // A real Markdown link, or text that only looks like a label, is left alone.
  assert.equal(normalizeCitations('[E1](https://example.com) [Eq] [E]'), '[E1](https://example.com) [Eq] [E]');
});

test('only labels with a target split out of the text', () => {
  const known = (l: string) => l === 'E1' || l === 'E3';
  assert.deepEqual(splitCitations('a [E1][E3] b [E9] c [E1]', known), [
    'a ',
    { label: 'E1' },
    { label: 'E3' },
    ' b [E9] c ',
    { label: 'E1' },
  ]);
  assert.deepEqual(splitCitations('no labels', known), ['no labels']);
  assert.deepEqual(splitCitations('[E1]', known), [{ label: 'E1' }]);
});
