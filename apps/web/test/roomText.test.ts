import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asRead } from '../src/roomText.ts';

// Words quoted from a material's Markdown, shown as read (ADR 0037): the marks
// of bold, italics and code go; everything else stays as it is.

test('quoted words are shown without the marks of bold, italics and code', () => {
  assert.equal(asRead('**Gradient checkpointing** (GC) keeps only some **activations**.'), 'Gradient checkpointing (GC) keeps only some activations.');
  assert.equal(asRead('Use `torch.utils.checkpoint` and __never__ *guess*.'), 'Use torch.utils.checkpoint and never guess.');
  assert.equal(asRead('2 * 3 * 4 and a lone ** mark stay'), '2 * 3 * 4 and a lone ** mark stay');
  assert.equal(asRead('snake_case_name stays'), 'snake_case_name stays');
});
