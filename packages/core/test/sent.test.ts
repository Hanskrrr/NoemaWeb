import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleContext, type ChatMessage, describeSent } from '../src/context.ts';

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
