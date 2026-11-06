import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingLevel, joinBlocks, sectionOf, splitBlocks } from '../src/blocks.ts';

test('paragraphs, headings, tables, code and math each become a block', () => {
  const md = [
    '这篇笔记整理两条线。[E3][E5]',
    '',
    '## 一、机器学习系统',
    '**模型**是一个函数。',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```',
    'code',
    '',
    'still code',
    '```',
    '',
    '$$',
    'x = 1',
    '',
    'y = 2',
    '$$',
    '',
    '$$z$$',
    '',
    '---',
  ].join('\n');
  assert.deepEqual(splitBlocks(md), [
    '这篇笔记整理两条线。[E3][E5]',
    '## 一、机器学习系统',
    '**模型**是一个函数。',
    '| A | B |\n|---|---|\n| 1 | 2 |',
    '```\ncode\n\nstill code\n```',
    '$$\nx = 1\n\ny = 2\n$$',
    '$$z$$',
    '---',
  ]);
});

test('a list stays one block across blank lines, with its indented parts', () => {
  const md = '- one\n\n- two\n\n  more about two\n\n1. next list\n\nAfter the lists.\n\n- a\n- b';
  assert.deepEqual(splitBlocks(md), [
    '- one\n\n- two\n\n  more about two\n\n1. next list',
    'After the lists.',
    '- a\n- b',
  ]);
});

test('fences close only on a matching marker; CRLF and extra blank lines are fine', () => {
  const md = '````md\n```\ninside\n```\n````\r\n\r\n\r\nText\n\n\n';
  assert.deepEqual(splitBlocks(md), ['````md\n```\ninside\n```\n````', 'Text']);
  assert.deepEqual(splitBlocks(''), []);
  assert.deepEqual(splitBlocks('\n\n  \n'), []);
});

test('split and join round-trip', () => {
  const md = '# T\n\nPara one.\nStill para one.\n\n- a\n\n- b\n\n```\nx\n\ny\n```\n\n> quote\n\nEnd.';
  const blocks = splitBlocks(md);
  assert.deepEqual(splitBlocks(joinBlocks(blocks)), blocks);
  assert.equal(joinBlocks(['a ', '', '\n\nb']), 'a\n\nb');
  assert.equal(joinBlocks(['    indented code', 'x']), '    indented code\n\nx');
});

test('sections run to the next heading of the same or a higher level', () => {
  const blocks = ['intro', '## A', 'a1', '### A.1', 'a2', '## B', 'b1', '# Top', 'z'];
  assert.equal(headingLevel('## A'), 2);
  assert.equal(headingLevel('intro'), null);
  assert.equal(headingLevel('#hashtag'), null);
  assert.deepEqual(sectionOf(blocks, 1), [1, 2, 3, 4]);
  assert.deepEqual(sectionOf(blocks, 3), [3, 4]);
  assert.deepEqual(sectionOf(blocks, 5), [5, 6]);
  assert.deepEqual(sectionOf(blocks, 0), [0]);
});
