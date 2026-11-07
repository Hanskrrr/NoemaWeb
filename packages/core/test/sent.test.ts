import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleContext, type ChatMessage, describeSent, MAX_PINNED_CHARS, PINNED_HEADING } from '../src/context.ts';

const SYSTEM = 'You are a patient tutor.';

/** The parts, put back together as messages. */
function rejoin(parts: ReturnType<typeof describeSent>): ChatMessage[] {
  const system = parts.filter((p) => p.role === 'system').map((p) => p.text).join('');
  const rest = parts.filter((p) => p.role !== 'system').map((p) => ({ role: p.role, content: p.text }));
  return [...(system ? [{ role: 'system' as const, content: system }] : []), ...rest];
}

test('what was sent, part by part: About me, the source, the conversation, the question with its passage', () => {
  const { messages, manifest } = assembleContext({
    system: SYSTEM,
    aboutMe: 'I know C++.\n\n## What the learner is reading — a heading I typed myself',
    source: { title: 'Attention', url: 'https://arxiv.org/abs/1706.03762', section: '## 3.2 Attention\n\nThe dot products grow.' },
    inherited: [
      { id: 'a1', role: 'user', content: 'An earlier question in the parent' },
      { id: 'a2', role: 'assistant', content: 'Its answer' },
    ],
    history: [
      { id: 'h1', role: 'user', content: 'First question here', merged: [{ id: 'm1', title: 'Other', text: 'A merged finding' }] },
      { id: 'h2', role: 'assistant', content: 'First answer here' },
    ],
    origin: { quote: 'grow large', from: 'source' },
    question: { id: 'q', content: 'Why do they grow?' },
    budgetTokens: 10_000,
  });
  const parts = describeSent(manifest, messages);
  assert.deepEqual(
    parts.map((p) => [p.kind, p.role, p.id ?? null, p.merged, p.withPassage]),
    [
      ['instructions', 'system', null, 0, false],
      ['about_me', 'system', null, 0, false],
      ['source', 'system', null, 0, false],
      ['inherited', 'user', 'a1', 0, false],
      ['inherited', 'assistant', 'a2', 0, false],
      ['history', 'user', 'h1', 1, false],
      ['history', 'assistant', 'h2', 0, false],
      ['question', 'user', 'q', 0, true],
    ],
  );
  assert.equal(parts[0]?.text, SYSTEM);
  assert.match(parts[1]?.text ?? '', /I know C\+\+\.\n\n## What the learner is reading — a heading I typed myself$/);
  assert.match(parts[2]?.text ?? '', /^\n\n## What the learner is reading\n\n"Attention"/);
  assert.match(parts.at(-1)?.text ?? '', /^About this passage of what I am reading:\n\n> grow large\n\nWhy do they grow\?$/);
  // Put back together, the parts are exactly what was sent.
  assert.deepEqual(rejoin(parts), messages);
  // Their estimates add up to the manifest's.
  assert.equal(
    parts.reduce((n, p) => n + p.tokens, 0),
    manifest.parts.reduce((n, p) => n + p.tokens, 0),
  );
});

test('what was sent: no About me, no source, nothing earlier; older turns left out are not in it', () => {
  const plain = assembleContext({ system: SYSTEM, history: [], question: { id: 'q', content: 'Hello?' }, budgetTokens: 1000 });
  assert.deepEqual(
    describeSent(plain.manifest, plain.messages).map((p) => p.kind),
    ['instructions', 'question'],
  );
  const long = 'x'.repeat(900);
  const tight = assembleContext({
    system: SYSTEM,
    history: [
      { id: 'h1', role: 'user', content: long },
      { id: 'h2', role: 'assistant', content: long },
      { id: 'h3', role: 'user', content: 'short' },
      { id: 'h4', role: 'assistant', content: 'short too' },
    ],
    question: { id: 'q', content: 'And now?' },
    budgetTokens: 120,
  });
  const parts = describeSent(tight.manifest, tight.messages);
  assert.deepEqual(parts.map((p) => p.id ?? p.kind), ['instructions', 'h3', 'h4', 'q']);
  assert.deepEqual(rejoin(parts), tight.messages);
});

test('pinned passages go after the source, quoted line by line, and come back as their own part', () => {
  const { messages, manifest } = assembleContext({
    system: SYSTEM,
    aboutMe: 'I know C++.',
    // A page that holds the pinned heading itself must not be mistaken for the pins.
    source: { title: 'Attention', url: null, section: `Some text.\n\n${PINNED_HEADING}\nnot really` },
    pinned: [
      { id: 'p1', quote: 'Q = XW_Q\n\nK = XW_K', from: 'source', title: 'Attention' },
      { id: 'p2', quote: `## A heading inside\n\n${PINNED_HEADING}`, from: 'conversation', title: 'Variance' },
    ],
    history: [],
    question: { id: 'q', content: 'Why scale?' },
    budgetTokens: 10_000,
  });
  const system = messages[0]?.content ?? '';
  assert.ok(system.indexOf('Some text.') < system.lastIndexOf(PINNED_HEADING), 'after the source');
  assert.ok(system.includes('> Q = XW_Q\n>\n> K = XW_K'), 'quoted line by line');
  assert.ok(system.includes('> ## A heading inside'), 'a heading in a pin is quoted too');
  assert.ok(system.includes('From "Attention", which they are reading:'));
  assert.ok(system.includes('From the conversation "Variance":'));
  const parts = describeSent(manifest, messages);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['instructions', 'about_me', 'source', 'pinned', 'question'],
  );
  assert.ok(parts.find((p) => p.kind === 'source')?.text.includes('not really'), 'the page keeps its own text');
  assert.ok(parts.find((p) => p.kind === 'pinned')?.text.includes('> Q = XW_Q'));
  assert.deepEqual(rejoin(parts), messages);
  const sum = parts.reduce((n, p) => n + p.tokens, 0);
  assert.equal(sum, manifest.estimatedTokens);
});

test('a long pin is cut when sent; pins count toward the fixed budget', () => {
  const long = 'x'.repeat(MAX_PINNED_CHARS + 50);
  const { messages } = assembleContext({
    system: SYSTEM,
    pinned: [{ id: 'p', quote: long, from: 'conversation', title: 'T' }],
    history: [],
    question: { id: 'q', content: 'Hm?' },
    budgetTokens: 10_000,
  });
  assert.ok(messages[0]?.content.includes(`${'x'.repeat(MAX_PINNED_CHARS)}…`));
  assert.ok(!messages[0]?.content.includes('x'.repeat(MAX_PINNED_CHARS + 1)));
  assert.throws(
    () =>
      assembleContext({
        system: SYSTEM,
        pinned: [{ id: 'p', quote: long, from: 'conversation', title: 'T' }],
        history: [],
        question: { id: 'q', content: 'Hm?' },
        budgetTokens: 300,
      }),
    /budget/,
  );
});
