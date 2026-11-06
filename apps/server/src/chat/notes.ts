// "Rewrite as a note": the model turns a thread and its branches into a
// readable study note, organised by idea. Every paragraph cites the exchanges
// it came from as [E3] labels, which the note maps to the exact messages. The
// note is an extra, editable document; the chat itself never changes.
// Like answers, notes are written by the server, saved as they arrive, and
// survive the tab closing.

import {
  type ChatMessage,
  type CiteRefs,
  describeError,
  joinBlocks,
  type Note,
  normalizeCitations,
} from '@noema/core';
import { ProviderError } from '../llm/provider.ts';
import type { ModelSource } from '../llm/settings.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';

export const REWRITE_PROMPT = [
  "You turn a learner's study conversation into a clear note they will keep and reread.",
  'The conversation is given as numbered exchanges [E1], [E2], … Side questions (branches) are marked with the passage they were asked about.',
  '- Write in the language the learner used.',
  '- Organise by idea, not by the order of the chat. Put what a side question taught where it helps the main explanation.',
  '- Start with a one-line title as a Markdown heading, then a short summary, then sections.',
  '- Keep the key definitions, formulas, code and worked examples. Drop greetings, repetition and offers to continue.',
  '- After each paragraph or list that uses the conversation, cite the exchanges it comes from, like [E3] or [E3][E5]. Use only the labels given.',
  '- Add nothing that is not in the conversation. If something was left open or unclear, list it under a final "Open questions" section.',
  '- Markdown. Math as $...$ inline and $$...$$ on their own lines.',
].join('\n');

const MAX_QUESTION = 4000;
const MAX_ANSWER = 8000;
const MAX_TOTAL = 200_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(shortened)` : text;
}

export interface Outline {
  text: string;
  /** E-number to the message it cites (the answer, or the question if unanswered). */
  refs: Map<string, { threadId: string; messageId: string }>;
}

/**
 * The thread and every branch below it, as numbered exchanges, in reading
 * order. Branches made their own thread are left out: they have their own
 * notes. `keep`: labels a note already uses keep pointing at the same
 * exchange, and new exchanges get new numbers, so a note's citations stay
 * right when the AI is asked about it again later.
 */
export function buildOutline(repo: Repo, threadId: string, keep: CiteRefs = {}): Outline {
  const refs: Outline['refs'] = new Map();
  const lines: string[] = [];
  const known = new Map(Object.entries(keep).map(([label, ref]) => [ref.messageId, label]));
  let n = Math.max(0, ...Object.keys(keep).map((l) => Number(l.slice(1)) || 0));
  let total = 0;
  const visit = (id: string, depth: number, from: string | null) => {
    if (depth > 20 || total > MAX_TOTAL) return;
    if (depth > 0 && repo.getThread(id)?.splitAt) return;
    const thread = repo.getThread(id);
    const origin = repo.originOf(id);
    if (origin) {
      const passage = clip(origin.anchor.exact.replace(/\s+/g, ' '), 400);
      lines.push(`--- Side question${from ? ` opened from ${from}` : ''}, about the passage: "${passage}" ---`);
    } else {
      lines.push(`# Conversation: ${thread?.title || 'Untitled'}`);
    }
    const messages = repo.listMessages(id);
    const answers = new Map(messages.filter((m) => m.role === 'assistant').map((m) => [m.replyTo, m]));
    const branches = repo.branchesOf(id);
    for (const q of messages.filter((m) => m.role === 'user')) {
      if (total > MAX_TOTAL) {
        lines.push('(The conversation continues; the rest is left out for length.)');
        return;
      }
      const a = answers.get(q.id);
      const messageId = a?.id ?? q.id;
      let label = known.get(messageId) ?? known.get(q.id);
      if (!label) {
        n += 1;
        label = `E${n}`;
      }
      refs.set(label, { threadId: id, messageId });
      const block = [`[${label}] Question:`, clip(q.content, MAX_QUESTION), '', `[${label}] Answer:`, a?.content ? clip(a.content, MAX_ANSWER) : '(no answer)', ''];
      total += block.join('\n').length;
      lines.push(...block);
      for (const b of branches.filter((x) => x.anchor.messageId === q.id || x.anchor.messageId === a?.id)) {
        visit(b.threadId, depth + 1, label);
      }
    }
    if (origin) lines.push('--- End of side question ---', '');
  };
  visit(threadId, 0, null);
  return { text: lines.join('\n'), refs };
}

/**
 * The note's title is the heading the model starts with ("# Title"); the
 * heading is then taken out of the body, which the page shows under the title.
 */
export function splitTitle(text: string): { title: string | null; body: string } {
  const m = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(text);
  const title = m?.[1]?.replace(/(\*\*|__|`)(.+?)\1/g, '$2').trim().slice(0, 200);
  if (!m || !title) return { title: null, body: text };
  return { title, body: text.slice(m[0].length).replace(/^\s*\n/, '') };
}

export function rewriteRequest(outline: string): ChatMessage[] {
  return [
    { role: 'system', content: REWRITE_PROMPT },
    { role: 'user', content: outline },
  ];
}

export const NOTE_FLUSH_MS = 300;

export class NoteWriter {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly maxOutputTokens: number | null;
  private readonly log: Logger;
  private readonly live = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(deps: { repo: Repo; models: ModelSource; maxOutputTokens: number | null; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.maxOutputTokens = deps.maxOutputTokens;
    this.log = deps.log;
  }

  isWriting(noteId: string): boolean {
    return this.live.has(noteId);
  }

  start(noteId: string, threadId: string): void {
    if (this.live.has(noteId)) return;
    const controller = new AbortController();
    const done = this.run(noteId, threadId, controller.signal)
      .catch((err: unknown) => this.log.error('note writer crashed', { noteId, err }))
      .finally(() => this.live.delete(noteId));
    this.live.set(noteId, { controller, done });
  }

  async shutdown(): Promise<void> {
    const all = [...this.live.values()];
    for (const w of all) w.controller.abort();
    await Promise.all(all.map((w) => w.done));
  }

  private async run(noteId: string, threadId: string, signal: AbortSignal): Promise<void> {
    let content = '';
    let saved = 0;
    const timer = setInterval(() => {
      if (content.length === saved) return;
      try {
        this.repo.saveNoteContent(noteId, content);
        saved = content.length;
      } catch (err) {
        this.log.error('note flush failed', { noteId, err });
      }
    }, NOTE_FLUSH_MS);
    try {
      const provider = this.models.current();
      if (!provider.configured) throw new ProviderError('not_configured', 'no model connected');
      const outline = buildOutline(this.repo, threadId);
      this.repo.setNoteRefs(noteId, Object.fromEntries(outline.refs));
      for await (const ev of provider.stream({
        messages: rewriteRequest(outline.text),
        maxTokens: this.maxOutputTokens ?? undefined,
        purpose: 'note',
        signal,
      })) {
        if (ev.type === 'text') content += ev.text;
      }
      clearInterval(timer);
      const { title, body } = splitTitle(normalizeCitations(content));
      this.repo.finishNote(noteId, body, 'done', null, title);
      this.log.info('note written', { noteId, chars: content.length, exchanges: outline.refs.size });
    } catch (err) {
      clearInterval(timer);
      const kind = err instanceof ProviderError ? err.kind : 'internal';
      if (!(err instanceof ProviderError)) this.log.error('note failed', { noteId, err });
      const message = signal.aborted ? 'The server stopped before this note was finished.' : describeError(kind);
      this.repo.finishNote(noteId, content, 'failed', message);
    }
  }
}

// Suggestions: the AI writes at one place, a new version of a block or new
// text where the learner asked, following the learner's instruction. The
// result waits as one suggestion; the learner accepts or discards it as a
// whole, and accepted text becomes as many blocks as it holds.

export const SUGGEST_PROMPT = [
  "You help a learner edit their study note. The note is Markdown, made of blocks (paragraphs, headings, lists, tables, formulas). You write at one place, following the learner's instruction: either a new version of the block marked <<<REWRITE>>>, or new text at the place marked <<<NEW BLOCK HERE>>>.",
  '- Reply with that Markdown only: no preamble, no explanation, no code fence around it, no markers.',
  '- For a rewrite, keep to what that block covers; it may become two blocks if that reads better. For new text, write as much as the instruction asks: a sentence, a paragraph, or a short section with its own heading, paragraphs, lists or formulas. Separate blocks with a blank line.',
  "- Write in the note's language unless the instruction asks otherwise. Fit the surrounding blocks: do not repeat them.",
  '- When a point comes from the conversation, cite the exchange with its label, like [E3]. Keep citations that still apply. Use only labels that exist.',
  '- Math as $...$ inline and $$...$$ on their own lines.',
].join('\n');

const NOTE_WINDOW = 40_000;

/** The note with the place marked. Long notes are cut down to the blocks around it. */
export function markedNote(note: Note, blockId: string, mode: 'rewrite' | 'insert'): string {
  const blocks = note.blocks.filter((b) => b.content !== '' || b.id === blockId);
  let i = blocks.findIndex((b) => b.id === blockId);
  if (i < 0) i = blocks.length;
  const parts = blocks.map((b, j) => {
    if (j !== i) return b.content;
    return mode === 'rewrite' ? `<<<REWRITE>>>\n${b.content}\n<<<END>>>` : '<<<NEW BLOCK HERE>>>';
  });
  let lo = 0;
  let hi = parts.length;
  while (joinBlocks(parts.slice(lo, hi)).length > NOTE_WINDOW && hi - lo > 1) {
    if (i - lo > hi - 1 - i) lo += 1;
    else hi -= 1;
  }
  const body = joinBlocks(parts.slice(lo, hi).filter((p) => p !== ''));
  return [lo > 0 ? '(…earlier blocks left out)' : '', body, hi < parts.length ? '(…later blocks left out)' : '']
    .filter(Boolean)
    .join('\n\n');
}

export function suggestRequest(args: {
  outline: string | null;
  note: string;
  title: string;
  instruction: string;
}): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: SUGGEST_PROMPT }];
  // The conversation first: it changes least, so the provider can cache it.
  if (args.outline) messages.push({ role: 'user', content: `The conversation this note comes from:\n\n${args.outline}` });
  messages.push({
    role: 'user',
    content: `The note "${args.title}":\n\n${args.note}\n\nInstruction: ${args.instruction}`,
  });
  return messages;
}

/** Models sometimes wrap the block in a code fence or echo the markers; take them off. */
export function cleanSuggestion(text: string): string {
  let t = text.trim();
  const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/.exec(t);
  if (fenced) t = (fenced[1] as string).trim();
  t = t.replace(/<<<(?:REWRITE|END|NEW BLOCK HERE)>>>/g, '').trim();
  return normalizeCitations(t);
}

export class Suggester {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly maxOutputTokens: number | null;
  private readonly log: Logger;
  private readonly live = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(deps: { repo: Repo; models: ModelSource; maxOutputTokens: number | null; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.maxOutputTokens = deps.maxOutputTokens;
    this.log = deps.log;
  }

  start(noteId: string, blockId: string, mode: 'rewrite' | 'insert', instruction: string): void {
    if (this.live.has(blockId)) return;
    const controller = new AbortController();
    const done = this.run(noteId, blockId, mode, instruction, controller.signal)
      .catch((err: unknown) => this.log.error('suggestion crashed', { noteId, blockId, err }))
      .finally(() => this.live.delete(blockId));
    this.live.set(blockId, { controller, done });
  }

  async shutdown(): Promise<void> {
    const all = [...this.live.values()];
    for (const w of all) w.controller.abort();
    await Promise.all(all.map((w) => w.done));
  }

  private async run(
    noteId: string,
    blockId: string,
    mode: 'rewrite' | 'insert',
    instruction: string,
    signal: AbortSignal,
  ): Promise<void> {
    let text = '';
    let saved = 0;
    const timer = setInterval(() => {
      if (text.length === saved) return;
      try {
        this.repo.saveProposal(blockId, text);
        saved = text.length;
      } catch (err) {
        this.log.error('suggestion flush failed', { blockId, err });
      }
    }, NOTE_FLUSH_MS);
    try {
      const provider = this.models.current();
      if (!provider.configured) throw new ProviderError('not_configured', 'no model connected');
      const note = this.repo.getNote(noteId);
      if (!note) throw new ProviderError('bad_request', 'the note is gone');
      let outline: string | null = null;
      if (note.threadId && this.repo.getThread(note.threadId)) {
        const o = buildOutline(this.repo, note.threadId, note.refs);
        this.repo.mergeNoteRefs(noteId, Object.fromEntries(o.refs));
        outline = o.text;
      }
      for await (const ev of provider.stream({
        messages: suggestRequest({ outline, note: markedNote(note, blockId, mode), title: note.title, instruction }),
        maxTokens: this.maxOutputTokens ?? undefined,
        purpose: 'suggest',
        signal,
      })) {
        if (ev.type === 'text') text += ev.text;
      }
      clearInterval(timer);
      const clean = cleanSuggestion(text);
      if (!clean) throw new ProviderError('bad_request', 'empty suggestion');
      this.repo.finishProposal(blockId, clean, 'ready', null);
      this.log.info('suggestion written', { noteId, blockId, chars: clean.length });
    } catch (err) {
      clearInterval(timer);
      const kind = err instanceof ProviderError ? err.kind : 'internal';
      if (!(err instanceof ProviderError)) this.log.error('suggestion failed', { blockId, err });
      const message = signal.aborted ? 'The server stopped before this was finished.' : describeError(kind);
      this.repo.finishProposal(blockId, text, 'failed', message);
    }
  }
}
