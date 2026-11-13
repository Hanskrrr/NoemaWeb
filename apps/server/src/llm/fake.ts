// A deterministic provider for tests, demos and working offline.
// Markers in the question change its behaviour:
//   [[fail:KIND]]     fail before the first token with that error kind
//   [[error-midway]]  fail with a network error halfway through the answer
//   [[slow]]          stream slowly (for reload and stop tests)
//   [[no-judge]]      the "asked before" check by meaning fails
//   [[tex]]           answer with math written \( … \) and \[ … \], as many models do
// Asked again (a revision after the first), it adds a line saying which one.
// As the Assistant (purpose 'assistant', with tools), it looks things up as
// the question says, one marker a round, then answers citing what it found:
//   [[search:WORDS]] [[open:N]] [[open:N:PAGE]] [[list:WHAT]]   a lookup
//   [[together]]       all the lookups in one round
//   [[cite:3, 4]]      write this citation as given (to test normalising)
//   [[no-tools]]       refuse a request with tools (a model without them)
//   [[no-thinking-tools]]  refuse tools unless thinking is off
//   [[say-first]]      write a sentence before the first lookup
//   [[call:NAME:JSON]] any other tool (a change, show), with these arguments
//   [[quote:WORDS|N]]  quote these words and cite label N

import { type ErrorKind, subjectTokens } from '@noema/core';
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

// The fake judge of "asked before" knows a few synonyms, so tests can ask the
// same thing in words the word matcher cannot connect.
const SYNONYMS: Record<string, string> = {
  heavens: 'sky',
  azure: 'blue',
  automobile: 'car',
  quick: 'fast',
  天空: 'sky',
  蓝色: 'blue',
};

function meaningOf(text: string): Set<string> {
  let t = text.toLowerCase();
  for (const [word, same] of Object.entries(SYNONYMS)) t = t.split(word).join(` ${same} `);
  return new Set(subjectTokens(t).map((k) => k.key));
}

/** Reads the list as the real prompt writes it, and answers as the real model is asked to. */
export function fakeVerdict(prompt: string): string {
  const asked = /\nNew question: ([\s\S]*)$/.exec(prompt)?.[1] ?? '';
  if (asked.includes('[[no-judge]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
  const mine = meaningOf(asked.replace(/It is asked about this passage:/, ' '));
  const same: number[] = [];
  const related: number[] = [];
  for (const m of prompt.matchAll(/^(\d+)\. Q: (.*?)(?: \| passage: "(.*?)")?(?: \| answer in short: .*?)?(?: \| thread: .*)?$/gm)) {
    const theirs = meaningOf(`${m[2]} ${m[3] ?? ''}`);
    const shared = [...mine].filter((k) => theirs.has(k)).length;
    const either = new Set([...mine, ...theirs]).size;
    const alike = either > 0 ? shared / either : 0;
    if (alike >= 0.6) same.push(Number(m[1]));
    else if (alike >= 0.3) related.push(Number(m[1]));
  }
  return JSON.stringify({ same, related });
}

/** Math with LaTeX's own delimiters, inline, displayed, in a quote and in code. */
export function texAnswer(): string {
  return [
    'On a circle \\(S^1\\), a map \\(f:S^1\\to\\mathbb R\\) has a point where',
    '\\[',
    'f(t)=f(t+\\pi).',
    '\\]',
    '> Quoted:',
    '> \\[',
    '> g(-x)=-g(x)',
    '> \\]',
    '',
    'In code it stays as written: `\\(x\\)`.',
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
    if (req.purpose === 'assistant') {
      yield* this.assistant(req);
      return;
    }
    if (req.purpose === 'asked') {
      yield { type: 'text', text: fakeVerdict(question) };
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
    // Pictures with the question: [[no-pictures]] plays a model that cannot take them; otherwise it says what it got.
    const asked = [...req.messages].reverse().find((m) => m.role === 'user');
    const pictures = (asked?.images ?? []).filter((image) => req.images?.(image.ref));
    if (pictures.length > 0 && question.includes('[[no-pictures]]')) {
      throw new ProviderError('bad_request', 'fake model: image input is not supported');
    }
    const seen = pictures.length > 0 ? `I can see ${pictures.map((p) => p.label).join(' and ')}.\n\n` : '';
    const slow = question.includes('[[slow]]');
    const again = req.revision && req.revision > 1 ? `\n\nAsked again: this is answer ${req.revision}.` : '';
    const answer = seen + (question.includes('[[tex]]') ? texAnswer() : fakeAnswer(question)) + again;
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

  private async *assistant(req: StreamRequest): AsyncIterable<StreamEvent> {
    const at = req.messages.map((m) => m.role).lastIndexOf('user');
    const question = req.messages[at]?.content ?? '';
    if (/\[\[fail:([a-z_]+)\]\]/.test(question)) {
      const kind = /\[\[fail:([a-z_]+)\]\]/.exec(question)?.[1] as ErrorKind;
      throw new ProviderError(kind, `fake failure: ${kind}`);
    }
    if (req.tools && question.includes('[[no-tools]]')) throw new ProviderError('bad_request', 'fake model: tools are not supported');
    if (req.tools && !req.light && question.includes('[[no-thinking-tools]]')) {
      throw new ProviderError('bad_request', 'fake model: reasoning_content is missing');
    }
    const slow = question.includes('[[slow]]');
    const delay = slow ? Math.max(this.delayMs, 25) : this.delayMs;
    // [[slow]]: each round thinks for a moment, as a real model does, so a watcher sees every phase.
    const think = slow ? Math.max(this.delayMs, 250) : delay;
    const after = req.messages.slice(at + 1);
    const rounds = after.filter((m) => m.role === 'assistant' && m.toolCalls).length;
    const lookups = [...question.matchAll(/\[\[(search|open|list|call):(.*?)\]\](?!\])/g)].map((m) => {
      const [name, arg] = [m[1] as string, m[2] as string];
      if (name === 'call') {
        const colon = arg.indexOf(':');
        return { name: arg.slice(0, colon), arguments: arg.slice(colon + 1) };
      }
      if (name === 'search') return { name, arguments: JSON.stringify({ query: arg }) };
      if (name === 'list') return { name, arguments: JSON.stringify({ what: arg }) };
      const [ref, page] = arg.split(':');
      return { name, arguments: JSON.stringify(page ? { ref: Number(ref), page: Number(page) } : { ref: Number(ref) }) };
    });
    const together = question.includes('[[together]]');
    const pending = together ? (rounds === 0 ? lookups : []) : lookups.slice(rounds, rounds + 1);
    await sleep(think, req.signal);
    yield { type: 'reasoning', text: pending.length > 0 ? 'I should look this up.' : 'I can answer now.' };
    if (req.tools && req.toolChoice !== 'none' && pending.length > 0) {
      if (rounds === 0 && question.includes('[[say-first]]')) yield { type: 'text', text: 'Let me look.' };
      await sleep(think, req.signal);
      yield { type: 'tool_calls', calls: pending.map((c, i) => ({ id: `fake_${rounds}_${i}`, ...c })) };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    // The answer: cites the first label of the last lookup, or of the overview.
    const results = after.filter((m) => m.role === 'tool').map((m) => m.content);
    const source = results.at(-1) ?? question;
    const first = /^\[(\d+)\]/m.exec(source)?.[1];
    const cite = /\[\[cite:([^\]]*)\]\]/.exec(question)?.[1];
    const quotes = [...question.matchAll(/\[\[quote:([^|\]]*)\|(\d+)\]\]/g)].map((m) => `“${m[1]}” [${m[2]}]`);
    const asked = question.slice(question.lastIndexOf('\n\n') + 2).replace(/\[\[[^\]]*\]\]/g, '').trim();
    const answer = [
      `You asked the Assistant: "${asked}"`,
      '',
      `I looked ${results.length} time${results.length === 1 ? '' : 's'}.${first ? ` The first thing I found is here [${first}].` : ''}${cite ? ` See also [${cite}].` : ''}`,
      ...(quotes.length > 0 ? ['', `It says ${quotes.join(' and ')}.`] : []),
      '',
      'A label it was never given stays as written [99].',
    ].join('\n');
    for (const part of chunks(answer, slow ? 2 : 6)) {
      await sleep(delay, req.signal);
      yield { type: 'text', text: part };
    }
    yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 0, cacheMissTokens: 100 } };
    yield { type: 'finish', reason: 'stop' };
  }
}
