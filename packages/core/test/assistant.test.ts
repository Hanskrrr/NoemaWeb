import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTION_KINDS,
  ActionArgs,
  ASSISTANT_TOOLS,
  assembleContext,
  type ChatMessage,
  citedLabels,
  cutLookup,
  describeSent,
  findQuote,
  Lookups,
  normalizeNumbered,
  OpenArgs,
  quotesNear,
  SearchArgs,
  splitNumbered,
  withoutLabels,
} from '../src/index.ts';

const known = (...labels: string[]) => (label: string) => labels.includes(label);

test('the lookups come first, then the changes; all in the model\'s own format', () => {
  assert.deepEqual(
    ASSISTANT_TOOLS.slice(0, 7).map((t) => t.name),
    ['search', 'open', 'list', 'list_files', 'find_in_files', 'open_file', 'show'],
  );
  for (const t of ASSISTANT_TOOLS) {
    assert.equal((t.parameters as { type: string }).type, 'object');
    assert.ok(t.description.length > 40);
  }
  assert.deepEqual(OpenArgs.parse({ ref: '3' }), { ref: 3 });
  assert.equal(OpenArgs.safeParse({ ref: 0 }).success, false);
  assert.equal(SearchArgs.safeParse({ query: '  ' }).success, false);
});

test('labels it cites, in order, only those it was given; variants become one form', () => {
  const text = 'Variance adds up [2]. You asked twice [3, 2]. An interval [0, 1] stays. A link [4](https://x.org).';
  const normal = normalizeNumbered(text, known('2', '3', '4'));
  assert.equal(normal, 'Variance adds up [2]. You asked twice [3][2]. An interval [0, 1] stays. A link [4](https://x.org).');
  assert.deepEqual(citedLabels(normal, known('2', '3', '4')), ['2', '3']);
  assert.equal(normalizeNumbered('全角【2】和［3］', known('2', '3')), '全角[2]和[3]');
  // Code and math are left alone.
  assert.equal(normalizeNumbered('`a[1, 2]` and $x_{[1,2]}$', known('1', '2')), '`a[1, 2]` and $x_{[1,2]}$');
  const parts = splitNumbered('See [1] and [9].', known('1'));
  assert.deepEqual(parts, ['See ', { label: '1' }, ' and [9].']);
});

test('an earlier answer goes back without its labels', () => {
  assert.equal(
    withoutLabels('You asked this in Week 4 [1], and again [2]. Keep [7] and `x[1]`.', ['1', '2']),
    'You asked this in Week 4, and again. Keep [7] and `x[1]`.',
  );
});

test('a long lookup is cut, and says so', () => {
  const cut = cutLookup('a'.repeat(50), 20);
  assert.ok(cut.startsWith('a'.repeat(20)));
  assert.match(cut, /30 more characters/);
  assert.equal(cutLookup('short', 20), 'short');
});

test('lookups kept with an answer are checked', () => {
  const ok = Lookups.safeParse({
    steps: [{ tool: 'search', label: 'Searched “variance”', found: 3 }],
    refs: {
      '1': { kind: 'thread', threadId: 'T', messageId: null, title: 'Variance' },
      '2': { kind: 'source', sourceId: 'S', versionId: 'V', at: 120, title: 'Week 4' },
      '3': { kind: 'note', noteId: 'N', blockId: null, title: 'Notes' },
    },
  });
  assert.equal(ok.success, true);
  assert.equal(Lookups.safeParse({ steps: [], refs: { E1: { kind: 'note', noteId: 'N', blockId: null, title: '' } } }).success, false);
});

test('the overview goes with the question, after the history, so the prefix stays cached', () => {
  const { messages, manifest } = assembleContext({
    system: 'You are the Assistant.',
    history: [
      { id: 'u1', role: 'user', content: 'Hi' },
      { id: 'a1', role: 'assistant', content: 'Hello' },
    ],
    overview: '## The notebook now\n\n[1] Source “Week 4”',
    question: { id: 'u2', content: 'What did Week 4 cover?' },
    budgetTokens: 2000,
  });
  assert.equal(messages[0]?.content, 'You are the Assistant.');
  assert.equal(messages.at(-1)?.content, '## The notebook now\n\n[1] Source “Week 4”\n\nWhat did Week 4 cover?');
  assert.deepEqual(
    manifest.parts.map((p) => p.kind),
    ['system', 'history', 'history', 'overview', 'question'],
  );
});

test('What was sent shows each lookup after the question: what was asked for, its thinking, what came back', () => {
  const { messages, manifest } = assembleContext({
    system: 'S',
    overview: 'O',
    history: [],
    question: { id: 'q', content: 'Q' },
    budgetTokens: 2000,
  });
  const request: ChatMessage[] = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      reasoning: 'I should search.',
      toolCalls: [
        { id: 'c1', name: 'search', arguments: '{"query":"variance"}' },
        { id: 'c2', name: 'list', arguments: '{"what":"sources"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: '[1] Thread “Variance”' },
    { role: 'tool', toolCallId: 'c2', content: '[2] Source “Week 4”' },
    { role: 'assistant', content: 'Let me open it.', toolCalls: [{ id: 'c3', name: 'open', arguments: '{"ref":1}' }] },
    { role: 'tool', toolCallId: 'c3', content: 'Opened' },
  ];
  const parts = describeSent(
    { parts: [...manifest.parts, { kind: 'lookup', tokens: 5 }, { kind: 'lookup', tokens: 6 }, { kind: 'lookup', tokens: 7 }] },
    request,
  );
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['instructions', 'question', 'lookup', 'lookup', 'lookup'],
  );
  const question = parts[1];
  assert.equal(question?.text, 'O\n\nQ');
  assert.equal(question?.withOverview, true);
  assert.deepEqual(
    parts.slice(2).map((p) => [p.call?.name, p.text, p.tokens, p.thinking ?? null, p.said ?? null]),
    [
      ['search', '[1] Thread “Variance”', 5, 'I should search.', null],
      ['list', '[2] Source “Week 4”', 6, null, null],
      ['open', 'Opened', 7, null, 'Let me open it.'],
    ],
  );
});

test('quotes it attributes to a label: in quotation marks just before it, or a quoted paragraph', () => {
  const text = [
    'The slides say “gradients are averaged with an all-reduce” [3], and also "stages live on devices", [4].',
    '',
    '> Each worker holds a copy',
    '> of the model.',
    '[5]',
    '',
    'Not a quote [6]. 中文「梯度会被平均」[7]',
  ].join('\n');
  assert.deepEqual(quotesNear(text, '3'), ['gradients are averaged with an all-reduce']);
  assert.deepEqual(quotesNear(text, '4'), ['stages live on devices']);
  assert.deepEqual(quotesNear(text, '5'), ['Each worker holds a copy of the model.']);
  assert.deepEqual(quotesNear(text, '6'), []);
  assert.deepEqual(quotesNear(text, '7'), ['梯度会被平均']);
});

test('a quote is checked against the original, white space aside; … stands for words left out', () => {
  const original = 'Each worker holds a copy\nof the model and a shard   of the batch; gradients are averaged.';
  assert.equal(findQuote(original, 'a copy of the model'), original.indexOf('a copy'));
  assert.equal(findQuote(original, 'Each worker … gradients are averaged'), 0);
  assert.equal(findQuote(original, 'a copy of the modle'), -1);
  assert.equal(findQuote(original, 'gradients … Each worker'), -1);
});

test('changes the Assistant can propose are checked before anything happens', () => {
  assert.equal(ActionArgs.start_thread.safeParse({ question: 'Why?' }).success, true);
  assert.equal(ActionArgs.pin.safeParse({ ref: '3', quote: 'x' }).success, true);
  assert.equal(ActionArgs.add_source.safeParse({ url: 'https://arxiv.org/abs/1706.03762' }).success, true);
  assert.equal(ActionArgs.add_source.safeParse({}).success, false);
  assert.equal(ActionArgs.add_source.safeParse({ url: 'https://x.org', text: 'both' }).success, false);
  assert.ok(ASSISTANT_TOOLS.some((t) => t.name === 'show'));
  for (const kind of ACTION_KINDS) {
    const tool = ASSISTANT_TOOLS.find((t) => t.name === kind);
    assert.ok(tool, kind);
    assert.match(tool.description, /confirms it/);
  }
});
