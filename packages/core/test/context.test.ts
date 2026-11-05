import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleContext, ContextBudgetError, estimateTokens } from '../src/index.ts';

const h = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content });

test('stable prefix first: system, About me, history, then the question', () => {
  const { messages, manifest } = assembleContext({
    system: 'You are Noema.',
    aboutMe: 'Second-year CS student.',
    history: [h('u1', 'user', 'What is a gradient?'), h('a1', 'assistant', 'The direction of steepest ascent.')],
    question: { id: 'u2', content: 'And descent?' },
    budgetTokens: 1000,
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.match(messages[0]?.content ?? '', /^You are Noema\.\n\n## About the learner\nSecond-year CS student\.$/);
  assert.equal(messages.at(-1)?.content, 'And descent?');
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'about_me', 'history', 'history', 'question'],
  );
  assert.deepEqual(manifest.omitted, []);
});

test('when the budget is tight the oldest history goes first, with no gaps', () => {
  const long = 'x'.repeat(300); // about 94 tokens each
  const history = [
    h('u1', 'user', long),
    h('a1', 'assistant', long),
    h('u2', 'user', long),
    h('a2', 'assistant', long),
  ];
  const { messages, manifest } = assembleContext({
    system: 'S',
    history,
    question: { id: 'u3', content: 'Q' },
    budgetTokens: 250,
  });
  assert.deepEqual(
    manifest.omitted.map((o) => o.id),
    ['u1', 'a1'],
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.ok(manifest.estimatedTokens <= 250);
});

test('history never starts with an orphaned assistant turn', () => {
  const long = 'y'.repeat(300);
  const { messages, manifest } = assembleContext({
    system: 'S',
    history: [h('u1', 'user', long), h('a1', 'assistant', 'short')],
    question: { id: 'u2', content: 'Q' },
    budgetTokens: 40,
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user'],
  );
  assert.deepEqual(manifest.omitted.map((o) => o.id).sort(), ['a1', 'u1']);
});

test('a question bigger than the budget is a named error, not a silent cut', () => {
  assert.throws(
    () =>
      assembleContext({
        system: 'S',
        history: [],
        question: { id: 'q', content: 'z'.repeat(10_000) },
        budgetTokens: 100,
      }),
    (e: unknown) => e instanceof ContextBudgetError && e.kind === 'context_too_large',
  );
});

test('token estimates count CJK more heavily than Latin text', () => {
  assert.ok(estimateTokens('学习学习学习学习学习') > estimateTokens('abcdefghij'));
});
