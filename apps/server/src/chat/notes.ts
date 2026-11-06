// "Rewrite as a note": the model turns a thread and its branches into a
// readable study note, organised by idea. Every paragraph cites the exchanges
// it came from as [E3] labels, which the note maps to the exact messages. The
// note is an extra, editable document; the chat itself never changes.
// Like answers, notes are written by the server, saved as they arrive, and
// survive the tab closing.

import { type ChatMessage, describeError, normalizeCitations } from '@noema/core';
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

/** The thread and every branch below it, as numbered exchanges, in reading order. */
export function buildOutline(repo: Repo, threadId: string): Outline {
  const refs: Outline['refs'] = new Map();
  const lines: string[] = [];
  let n = 0;
  let total = 0;
  const visit = (id: string, depth: number, from: string | null) => {
    if (depth > 20 || total > MAX_TOTAL) return;
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
      n += 1;
      const label = `E${n}`;
      const a = answers.get(q.id);
      refs.set(label, { threadId: id, messageId: a?.id ?? q.id });
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
