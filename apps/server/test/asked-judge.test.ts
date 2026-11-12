import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASKED_PROMPT, askedEntry, askedRequest, readVerdict } from '../src/chat/asked.ts';

const entry = (id: string, question: string, extra: Partial<Parameters<typeof askedEntry>[1]> = {}) => ({
  id,
  threadId: `t-${id}`,
  question,
  title: '',
  askedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

test('the request lists the earlier questions first, in order, and the new question last', () => {
  const messages = askedRequest(
    [
      entry('a', 'Why is the sky blue?', { headline: 'Air scatters blue light most', title: 'Sky colour' }),
      entry('b', '这是啥', { passage: 'Rayleigh **scattering**\nof light' }),
    ],
    { text: 'What makes the heavens azure?', passage: 'the heavens' },
  );
  assert.equal(messages[0]?.content, ASKED_PROMPT);
  assert.equal(
    messages[1]?.content,
    [
      'Questions already asked:',
      '1. Q: Why is the sky blue? | answer in short: Air scatters blue light most | thread: Sky colour',
      '2. Q: 这是啥 | passage: "Rayleigh scattering of light"',
      '',
      'New question: What makes the heavens azure?',
      'It is asked about this passage: "the heavens"',
    ].join('\n'),
  );
  // One more earlier question only adds a line: what came before is unchanged (the provider's cache holds).
  const longer = askedRequest(
    [entry('a', 'Why is the sky blue?', { headline: 'Air scatters blue light most', title: 'Sky colour' }), entry('b', '这是啥', { passage: 'Rayleigh **scattering**\nof light' }), entry('c', 'And at dusk?')],
    { text: 'Another' },
  );
  const head = (messages[1]?.content ?? '').split('\n\nNew question')[0] ?? '';
  assert.ok(longer[1]?.content.startsWith(head));
});

test('the verdict is read from what a model may send back, and only numbers of the list count', () => {
  assert.deepEqual(readVerdict('{"same":[2],"related":[5,1]}', 5), { same: [2], related: [5, 1] });
  assert.deepEqual(readVerdict('```json\n{"same": [], "related": []}\n```', 5), { same: [], related: [] });
  assert.deepEqual(readVerdict('Here you go: {"same":["3"],"related":[3, 9, 0, 2.5]} hope it helps', 5), {
    same: [3],
    related: [],
  });
  assert.deepEqual(readVerdict('{"same":[1,1]}', 3), { same: [1], related: [] });
  assert.equal(readVerdict('none', 5), null);
  assert.equal(readVerdict('{"same":[1', 5), null);
});
