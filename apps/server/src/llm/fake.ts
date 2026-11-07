// A deterministic provider for tests, demos and working offline.
// Markers in the question change its behaviour:
//   [[fail:KIND]]     fail before the first token with that error kind
//   [[error-midway]]  fail with a network error halfway through the answer
//   [[slow]]          stream slowly (for reload and stop tests)
// Asked again (a revision after the first), it adds a line saying which one.

import type { ErrorKind } from '@noema/core';
import { type ModelProvider, ProviderError, type StreamEvent, type StreamRequest, sleep } from './provider.ts';

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
    '',
    '| Step | Cost |',
    '| --- | ---: |',
    '| Forward | $O(n)$ |',
    '| ~~Backward~~ | 3~5 ms or 4~6 ms |',
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
    if (req.purpose === 'note') {
      // A predictable note that cites the first two exchanges, so tests can follow the links.
      const labels = [...question.matchAll(/^\[(E\d+)\] Question:/gm)].map((m) => m[1]);
      const cite = (i: number) => (labels[i] ? `[${labels[i]}]` : '');
      const text = [
        '# Study note',
        '',
        `The main idea, from the first question ${cite(0)}.`,
        '',
        `- A detail that came from a side question ${cite(1)}.`,
        '- Inline math still works: $a^2 + b^2 = c^2$.',
        '',
        '## Open questions',
        '',
        '- None yet.',
      ].join('\n');
      for (const part of text.match(/[\s\S]{1,12}/g) ?? []) {
        await sleep(this.delayMs, req.signal);
        yield { type: 'text', text: part };
      }
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'headline') {
      // A predictable line that says which question it read.
      const asked = /Question:\n([\s\S]*?)\n\nAnswer:/.exec(question)?.[1] ?? '';
      if (asked.includes('[[no-headline]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      yield { type: 'text', text: `In short: ${asked.replace(/\[\[[^\]]*\]\]/g, '').trim()}` };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'merge') {
      // A predictable summary that names what it read, so tests can follow it.
      const all = req.messages.map((m) => m.content).join('\n');
      if (all.includes('[[fail-merge]]')) throw new ProviderError('rate_limit', 'fake failure: rate_limit');
      const labels = [...all.matchAll(/^\[(E\d+)\] Question:/gm)].map((m) => m[1]);
      const text = `- What the side question found${labels.length > 0 ? ` [${labels.join(', ')}]` : ''}.\n- One more point to keep.`;
      for (const part of text.match(/[\s\S]{1,12}/g) ?? []) {
        await sleep(this.delayMs, req.signal);
        yield { type: 'text', text: part };
      }
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'suggest') {
      // A predictable suggestion that says what it was asked, so tests can follow it.
      const instruction = /Instruction: (.*)$/s.exec(question)?.[1]?.trim() ?? '';
      const fail = /\[\[fail:([a-z_]+)\]\]/.exec(instruction);
      if (fail) throw new ProviderError(fail[1] as ErrorKind, `fake failure: ${fail[1]}`);
      const all = req.messages.map((m) => m.content).join('\n');
      const firstLabel = /^\[(E\d+)\] Question:/m.exec(all)?.[1];
      const target = /<<<REWRITE>>>\n([\s\S]*?)\n<<<END>>>/.exec(question)?.[1];
      const plain = instruction.replace(/\[\[[^\]]*\]\]/g, '').trim();
      const cite = firstLabel ? ` [${firstLabel}]` : '';
      // [[section]]: a heading, a paragraph and a list, as the AI writes when asked for a section.
      const text = instruction.includes('[[section]]')
        ? `## ${plain}\n\nA first paragraph about ${plain}${cite}.\n\n- one point\n- another point`
        : target
          ? `Rewritten (${plain}): ${target.replace(/\s+/g, ' ').slice(0, 60)}${cite}`
          : `New block (${plain})${cite}.`;
      const slow = instruction.includes('[[slow]]');
      for (const part of text.match(slow ? /[\s\S]{1,2}/g : /[\s\S]{1,12}/g) ?? []) {
        await sleep(slow ? Math.max(this.delayMs, 25) : this.delayMs, req.signal);
        yield { type: 'text', text: part };
      }
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'title') {
      // A predictable title: "About" plus the question, so tests can tell it was written.
      const asked = /Question:\n(.*)/.exec(question)?.[1] ?? 'this';
      yield { type: 'text', text: `About ${asked.replace(/\[\[[^\]]*\]\]/g, '').trim()}` };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    const fail = /\[\[fail:([a-z_]+)\]\]/.exec(question);
    if (fail) throw new ProviderError(fail[1] as ErrorKind, `fake failure: ${fail[1]}`);
    const slow = question.includes('[[slow]]');
    const again = req.revision && req.revision > 1 ? `\n\nAsked again: this is answer ${req.revision}.` : '';
    const answer = fakeAnswer(question) + again;
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
      usage: {
        promptTokens: Math.ceil(promptChars / 3),
        completionTokens: parts.length,
        cacheHitTokens: 0,
        cacheMissTokens: Math.ceil(promptChars / 3),
      },
    };
    yield { type: 'finish', reason: 'stop' };
  }
}
