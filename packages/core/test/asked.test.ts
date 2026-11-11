import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AskedCandidate, askedBefore, subjectTokens } from '../src/asked.ts';

// A small notebook of earlier exchanges (made up).
const earlier: AskedCandidate[] = [
  { id: 'q1', threadId: 't1', question: 'What is entropy in information theory?', title: 'Entropy', headline: 'Entropy measures average surprise' },
  { id: 'q2', threadId: 't2', question: 'Why does the dot product of q and k have variance d_k?', title: 'Variance of q·k', headline: 'A sum of d_k unit-variance terms' },
  { id: 'q3', threadId: 't3', question: '我想学习 Rust 的所有权', title: 'Rust 所有权入门', headline: '每个值只有一个所有者' },
  { id: 'q4', threadId: 't4', question: '这是啥', passage: '生命周期标注', title: '生命周期标注是什么', headline: '告诉编译器引用活多久' },
  { id: 'q5', threadId: 't5', question: 'How do I write a binary search?', title: 'Binary search', headline: 'Halve the range each step' },
  { id: 'q6', threadId: 't6', question: 'what is this', passage: 'the softmax turns scores into weights', title: 'Softmax', headline: 'Exponentiate and normalise' },
  { id: 'q7', threadId: 't7', question: '梯度下降为什么会震荡？', title: '梯度下降的震荡', headline: '步长太大时在谷壁间来回' },
  { id: 'q8', threadId: 't1', question: 'And cross-entropy?', title: 'Entropy', headline: 'Cross-entropy compares two distributions' },
];

const top = (text: string, passage?: string, exceptThreads?: string[]) =>
  askedBefore({ text, passage }, earlier, { exceptThreads })[0];

test('question words, politeness and particles are not the subject', () => {
  assert.deepEqual(subjectTokens('Can you please explain what entropy is?').map((t) => t.key), ['entropy']);
  assert.deepEqual(subjectTokens('什么是熵？').map((t) => t.key), ['熵']);
  assert.deepEqual(subjectTokens('解释一下梯度下降').map((t) => t.key), ['梯度', '度下', '下降']);
  assert.deepEqual(subjectTokens('这是啥'), []);
  assert.deepEqual(subjectTokens('再详细一点'), []);
  assert.deepEqual(subjectTokens('gradients').map((t) => t.key), ['gradient']);
});

test('the same question in other words is found, in English and Chinese', () => {
  assert.equal(top('what is entropy')?.id, 'q1');
  assert.equal(top('what is entropy')?.strength, 'same');
  assert.equal(top('Explain entropy in information theory please')?.id, 'q1');
  assert.equal(top('variance of q·k: why d_k?')?.id, 'q2');
  assert.equal(top('Rust 所有权是什么')?.id, 'q3');
  assert.equal(top('how to write binary search')?.id, 'q5');
  assert.equal(top('为什么梯度下降会震荡')?.id, 'q7');
  assert.deepEqual(top('what is entropy')?.terms, ['entropy']);
  // The whole earlier question inside a longer one: related.
  assert.equal(top('Binary search: how do I write it, and when is it used?')?.id, 'q5');
  assert.equal(top('how do I write a binary search over a rotated array')?.id, 'q5');
  assert.equal(top('how do I write a binary search over a rotated array')?.strength, 'related');
});

test('a question about a passage is its passage: "what is this" on the same words is the same question', () => {
  assert.equal(top('这是什么', '生命周期标注')?.id, 'q4');
  assert.equal(top('生命周期标注是什么意思')?.id, 'q4', 'typed out, it meets the one asked by selecting');
  assert.equal(top('explain', 'the softmax turns scores into weights')?.id, 'q6');
  assert.equal(top('这是什么'), undefined, 'nothing to go on');
  assert.equal(top('继续'), undefined);
});

test('a different question that shares a word is left alone', () => {
  assert.equal(top('How do I write a binary tree in Rust?'), undefined);
  assert.equal(top('What is the entropy of a black hole and how does Hawking radiation carry it away?'), undefined);
  assert.equal(top('梯度下降和牛顿法的区别'), undefined);
  assert.equal(top('What is a monad?'), undefined);
  assert.equal(top('Rust 的异步运行时怎么选'), undefined);
  assert.equal(top('search for a file by name in the terminal'), undefined);
});

test('one reminder per thread, the best first, never the thread being asked in or the ones it came from', () => {
  const found = askedBefore({ text: 'entropy' }, earlier);
  assert.deepEqual(
    found.map((m) => m.threadId),
    ['t1'],
  );
  assert.equal(found[0]?.id, 'q1');
  assert.equal(top('what is entropy', undefined, ['t1']), undefined);
  assert.deepEqual(askedBefore({ text: 'entropy' }, []), []);
});
