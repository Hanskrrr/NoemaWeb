import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ftsQuery, makeSnippet, parseQuery, plainText, readableQuote, searchText } from '../src/index.ts';

test('CJK runs become unigrams and bigrams; other words pass through', () => {
  assert.equal(searchText('机器学习 is fun'), '机 器 学 习 机器 器学 学习 is fun');
  assert.equal(searchText('AI学习'), 'AI 学 习 学习');
});

test('queries are quoted tokens joined by AND, with a prefix match on the last word', () => {
  assert.equal(ftsQuery('学习'), '"学习"');
  assert.equal(ftsQuery('学'), '"学"');
  assert.equal(ftsQuery('机器学习'), '"机器" AND "器学" AND "学习"');
  assert.equal(ftsQuery('gradient desc'), '"gradient" AND "desc"*');
  assert.equal(ftsQuery('  ***  '), null);
});

test('FTS syntax in a query cannot escape the quotes', () => {
  const q = ftsQuery('a" OR 1=1 NEAR(x) -- "') as string;
  for (const part of q.split(' AND ')) assert.match(part, /^"[^"]+"\*?$/);
});

test('full-width and compatibility characters are normalised', () => {
  assert.deepEqual(parseQuery('ＡＢＣ').tokens, ['ABC']);
});

test('snippets come from the original text with match ranges', () => {
  const s = makeSnippet('第一章讲的是机器学习的基础，第二章讲优化。', '学习', 4);
  assert.equal(s.text, '…的是机器学习的基础，…');
  assert.deepEqual(s.matches, [{ start: 5, end: 7 }]);
  assert.equal(s.text.slice(5, 7), '学习');
});

test('plain text drops citation labels and Markdown marks, keeping the words', () => {
  assert.equal(
    plainText('## Variance\n\n- The **sum** of `d` terms [E3].\n> quoted [E12]\n```ts\nconst x = 1;\n```'),
    'Variance\n\nThe sum of d terms.\nquoted\n\nconst x = 1;\n',
  );
  assert.equal(plainText('1. 方差 [E1]'), '方差');
});

test('a quote reads as text: no escapes outside math, no heading marks, one line', () => {
  assert.equal(
    readableQuote('###### Summary\n\nSmith et al. \\[2020\\] use $\\|x\\|_2$ and \\*stars\\*.'),
    'Summary Smith et al. [2020] use $\\|x\\|_2$ and *stars*.',
  );
  assert.equal(readableQuote('One.\n\n\n\nTwo \\_x', false), 'One.\n\nTwo _x');
});
