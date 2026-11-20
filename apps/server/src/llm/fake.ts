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
//   [[call:NAME:JSON]] any other tool (a change, show), with these arguments;
//                      $made in them is the label of what the last change made (ADR 0033)
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
    if (req.purpose === 'gist') {
      // A predictable summary: its points quote the first lines of the text (so they link there), and one
      // quote that is not in the text (so it links nowhere).
      const text = /<<<TEXT>>>\n([\s\S]*?)\n<<<END>>>/.exec(question)?.[1] ?? '';
      if (text.includes('[[fail-gist]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      const title = /: “(.*)”\n/.exec(question)?.[1] ?? '';
      const lines = text
        .split('\n')
        .map((l) => l.replace(/^(#+|Q:|A:|Side question:|-)\s*/, '').trim())
        .filter((l) => l.length > 8 && !l.startsWith('['));
      const points = lines.slice(0, 2).map((l, i) => ({ point: `Point ${i + 1}`, quote: l.split(/\s+/).slice(0, 6).join(' ') }));
      points.push({ point: 'Not in the text', quote: 'words that are nowhere in it' });
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ gist: `Fake summary of “${title}”: ${(lines[0] ?? 'nothing').slice(0, 80)}.`, points }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'links') {
      // Predictable links: each thing to the one before it, kinds in turn, none twice.
      if (question.includes('[[fail-links]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      const n = [...question.matchAll(/^(\d+)\. /gm)].length;
      const already = new Set([...(/Already linked: (.*)\./.exec(question)?.[1] ?? '').matchAll(/(\d+)–(\d+)/g)].map((m) => `${m[1]}-${m[2]}`));
      const kinds = ['explains', 'builds-on', 'example-of', 'contrasts-with'];
      const links = [];
      for (let i = 2; i <= n; i++) {
        if (already.has(`${i - 1}-${i}`)) continue;
        links.push({ from: i, to: i - 1, kind: kinds[(i - 2) % kinds.length], why: `Fake: ${i} bears on ${i - 1}.` });
      }
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ links }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'concepts') {
      // The concept-reading skill, made predictable (ADR 0037): each **bold** phrase of the piece is a concept,
      // mentioned in its sentence. A sentence that starts with it and says "is", "are" or "means" defines it; a
      // question asks about it; otherwise it uses it. "(GC)" right after it is another name. A bold phrase whose
      // name is a known concept's other name ("GC") is given the known name. Its own answers' words ("offline fake
      // model") are not a subject of the learner's, so they are not read as one.
      if (question.includes('[[fail-concepts]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      const piece = /<<<\n([\s\S]*)\n>>>/.exec(question)?.[1] ?? '';
      const known = [...(/Known concepts: (.*)\.$/m.exec(question)?.[1] ?? '').matchAll(/“(.*?)”/g)].map((m) => m[1] as string);
      const mentions = [];
      for (const sentence of piece.split(/(?<=[.?!])\s+|\n+/)) {
        for (const m of sentence.matchAll(/\*\*([^*]+)\*\*(?:\s*\(([^)]+)\))?/g)) {
          const phrase = (m[1] as string).trim();
          if (phrase === 'offline fake model') continue;
          const also = m[2] ? [m[2].trim()] : [];
          const initials = (name: string) => name.split(/\s+/).map((w) => w[0] ?? '').join('').toLowerCase();
          const name = known.find((k) => k.toLowerCase() === phrase.toLowerCase() || initials(k) === phrase.toLowerCase()) ?? phrase.toLowerCase();
          const role = sentence.trim().endsWith('?')
            ? 'asks'
            : sentence.trim().startsWith(m[0]) && /\b(is|are|means)\b/.test(sentence)
              ? 'defines'
              : 'uses';
          mentions.push({ name, also: name === phrase.toLowerCase() ? also : [phrase, ...also], role, quote: sentence.trim(), says: `Fake: about ${name}.` });
        }
      }
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ mentions }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'concept-join') {
      // The same when one name is the other's initials ("GC", "gradient checkpointing"); otherwise new.
      const known = [...(/Known concepts:\n([\s\S]*?)\n\n/.exec(question)?.[1] ?? '').matchAll(/^- (.*)$/gm)].map((m) => m[1] as string);
      const fresh = [...(/New names:\n([\s\S]*)$/.exec(question)?.[1] ?? '').matchAll(/^- (.*)$/gm)].map((m) => m[1] as string);
      const initials = (name: string) => name.split(/\s+/).map((w) => w[0] ?? '').join('').toLowerCase();
      const same: Record<string, string | null> = {};
      for (const f of fresh) {
        const k = known.find((x) => initials(x) === f.toLowerCase() || initials(f) === x.toLowerCase()) ?? fresh.find((x) => x !== f && x.includes(' ') && initials(x) === f.toLowerCase());
        same[f] = k ?? null;
      }
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ same }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'concept-links') {
      // The second builds on the first, the third contrasts with the second.
      const n = [...question.matchAll(/^(\d+)\. /gm)].length;
      const links = [];
      if (n >= 2) links.push({ from: 2, to: 1, kind: 'builds-on', why: 'Fake: the second needs the first.' });
      if (n >= 3) links.push({ from: 3, to: 2, kind: 'contrasts-with', why: 'Fake: another way.' });
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ links }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'web-plan') {
      // Searches only when a question asks for it: [[web]] one search, [[web2]] two; nothing otherwise.
      const words = (/The question:\n([\s\S]*)$/.exec(question)?.[1] ?? '').replace(/\[\[[^\]]*\]\]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
      const queries = question.includes('[[web2]]') ? [words, `${words} explained`] : question.includes('[[web]]') ? [words] : [];
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ queries }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'brief') {
      // A predictable brief: the room's name and how many things; one question open in the first thing.
      if (question.includes('[[fail-brief]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      const room = /^The room “(.*)”:/m.exec(question)?.[1] ?? '';
      const n = [...question.matchAll(/^(\d+)\. /gm)].length;
      const first = /^1\. \w+ “(.*?)”/m.exec(question)?.[1] ?? '';
      // The rooms in it (ADR 0032), by name: the brief is written from theirs.
      const inner = [...question.matchAll(/^\d+\. room “(.*?)”/gm)].map((m) => m[1]);
      await sleep(this.delayMs, req.signal);
      const brief = `Fake brief of “${room}”: ${n} things, read in order.${inner.length ? ` Its rooms: ${inner.join(', ')}.` : ''}`;
      yield { type: 'text', text: JSON.stringify({ brief, open: [{ question: `What is still unclear about ${first}?`, from: 1 }] }) };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (req.purpose === 'link-kind') {
      // A line the learner drew: "builds on", turned around if a title asks for it ([[flip-link]]).
      if (question.includes('[[fail-link-kind]]')) throw new ProviderError('unavailable', 'fake failure: unavailable');
      const flip = question.includes('[[flip-link]]');
      await sleep(this.delayMs, req.signal);
      yield { type: 'text', text: JSON.stringify({ kind: flip ? 'explains' : 'builds-on', flip, why: `Fake: the AI chose ${flip ? 'explains, turned around' : 'builds on'}.` }) };
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
    // Pages found on the web with the question (ADR 0031): it cites them all, or those [[web-cites:2,3]] names (ADR 0033).
    const pages = [...question.matchAll(/^\[web (\d+)\]/gm)].map((m) => m[1] as string);
    const chosen = /\[\[web-cites:([\d,]*)\]\]/.exec(question)?.[1];
    const cites = chosen === undefined ? pages : chosen.split(',').filter((n) => pages.includes(n));
    const fromWeb = pages.length > 0 ? `\n\nFrom the web: ${cites.length ? cites.map((n) => `[web ${n}]`).join('') : 'nothing I used'}.` : '';
    const slow = question.includes('[[slow]]');
    const again = req.revision && req.revision > 1 ? `\n\nAsked again: this is answer ${req.revision}.` : '';
    // With pages from the web before it, the question is what comes after them.
    const onlyAsked = pages.length > 0 ? question.slice(question.lastIndexOf('\n\n') + 2) : question;
    const answer = seen + (question.includes('[[tex]]') ? texAnswer() : fakeAnswer(onlyAsked)) + fromWeb + again;
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
    // The label of what the last change made, as the server told it.
    const made = [...after.filter((m) => m.role === 'tool').map((m) => m.content).join('\n').matchAll(/What it made is \[(\d+)\]/g)].at(-1)?.[1] ?? '0';
    const lookups = [...question.matchAll(/\[\[(search|open|list|call):(.*?)\]\](?!\])/g)].map((m) => {
      const [name, arg] = [m[1] as string, m[2] as string];
      if (name === 'call') {
        const colon = arg.indexOf(':');
        return { name: arg.slice(0, colon), arguments: arg.slice(colon + 1).replaceAll('$made', made) };
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
