// A deterministic provider for tests, demos and working offline.
// Markers in the question change its behaviour:
//   [[fail:KIND]]     fail before the first token with that error kind
//   [[error-midway]]  fail with a network error halfway through the answer
//   [[slow]]          stream slowly (for reload and stop tests)

import type { ErrorKind } from '@noema/core';
import { ProviderError, type ModelProvider, type StreamEvent, type StreamRequest, sleep } from './provider.ts';

export function fakeAnswer(question: string): string {
  const q = question.replace(/\[\[[^\]]*\]\]/g, '').trim();
  return [
    `You asked: "${q}"`,
    '',
    'This is the **offline fake model**. It answers every question the same way, so tests can check exact text.',
    '',
    'Inline math such as $e^{i\\pi} + 1 = 0$ stays one unit when you select it, and so does a block:',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '- A list item with `inline code`',
    '- 中文也可以：机器学习的基础是优化。',
    '',
    '```ts',
    'const answer = 42;',
    '```',
  ].join('\n');
}

function chunks(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly configured = true;
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 15;
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const question = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    yield { type: 'attempt', n: 1 };
    const fail = /\[\[fail:([a-z_]+)\]\]/.exec(question);
    if (fail) throw new ProviderError(fail[1] as ErrorKind, `fake failure: ${fail[1]}`);
    const slow = question.includes('[[slow]]');
    const answer = fakeAnswer(question);
    const parts = chunks(answer, slow ? 2 : 6);
    const delay = slow ? Math.max(this.delayMs, 25) : this.delayMs;
    const breakAt = question.includes('[[error-midway]]') ? Math.floor(parts.length / 2) : -1;
    for (let i = 0; i < parts.length; i++) {
      if (i === breakAt) throw new ProviderError('network', 'fake connection dropped');
      await sleep(delay, req.signal);
      yield { type: 'text', text: parts[i] as string };
    }
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    yield {
      type: 'usage',
      usage: { promptTokens: Math.ceil(promptChars / 3), completionTokens: parts.length, cacheHitTokens: 0, cacheMissTokens: Math.ceil(promptChars / 3) },
    };
    yield { type: 'finish', reason: 'stop' };
  }
}
