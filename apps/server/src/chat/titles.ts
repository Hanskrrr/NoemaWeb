// Short titles for threads and branches, written by the model after the
// first answer, so the sidebar reads like a table of contents instead of a
// list of raw questions. A title the learner set is never overwritten.

import type { ChatMessage } from '@noema/core';
import type { ModelSource } from '../llm/settings.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';

export const TITLE_PROMPT = [
  'You name conversations in a learning notebook. Write a short title that says what this conversation is about, so the learner can find it again later.',
  '- Use the language of the question.',
  '- At most 8 words, or at most 16 characters in Chinese or Japanese.',
  '- No quotation marks, no Markdown, no full stop at the end.',
  'Reply with the title only.',
].join('\n');

const MAX_TITLE_CHARS = 60;

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

export function titleRequest(input: { question: string; answer: string; passage?: string | undefined }): ChatMessage[] {
  const passage = input.passage
    ? `This is a side question about this passage:\n> ${clip(input.passage, 300).replace(/\n/g, '\n> ')}\n\n`
    : '';
  return [
    { role: 'system', content: TITLE_PROMPT },
    {
      role: 'user',
      content: `${passage}Question:\n${clip(input.question, 800)}\n\nAnswer (beginning):\n${clip(input.answer, 1200)}`,
    },
  ];
}

/** The model's reply as a clean one-line title, or null if nothing usable came back. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  let t = line
    .replace(/^(title|标题|題名|タイトル)\s*[:：]\s*/i, '')
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ');
  // Quotes and end punctuation can wrap each other ("“Title”." or "“Title.”"): trim both, twice.
  for (let i = 0; i < 2; i++) {
    t = t
      .replace(/^["'“”‘’「」『』《》〈〉\s]+|["'“”‘’「」『』《》〈〉\s]+$/g, '')
      .replace(/[\s.。!！?？:：;；,，、]+$/u, '');
  }
  if (!t) return null;
  const chars = Array.from(t);
  if (chars.length > MAX_TITLE_CHARS) t = `${chars.slice(0, MAX_TITLE_CHARS).join('')}…`;
  return t;
}

export class Titler {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly log: Logger;

  constructor(deps: { repo: Repo; models: ModelSource; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.log = deps.log;
  }

  /**
   * Title a thread from its first finished exchange, unless the model or the
   * learner has titled it already. Never throws; returns the new title or null.
   */
  async title(threadId: string, signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<string | null> {
    try {
      if (this.repo.titleSourceOf(threadId) !== 'question') return null;
      const [question, answer] = this.repo.history(threadId, Number.MAX_SAFE_INTEGER);
      if (!question || !answer) return null;
      const provider = this.models.current();
      if (!provider.configured) return null;
      const passage = this.repo.originOf(threadId)?.anchor.exact;
      let text = '';
      for await (const ev of provider.stream({
        messages: titleRequest({ question: question.content, answer: answer.content, passage }),
        maxTokens: 60,
        light: true,
        purpose: 'title',
        signal,
      })) {
        if (ev.type === 'text') text += ev.text;
      }
      const title = cleanTitle(text);
      if (!title) return null;
      if (!this.repo.setTitle(threadId, title, 'model')) return null;
      this.repo.logEvent('thread.titled', threadId, { chars: title.length, model: provider.model });
      return title;
    } catch (err) {
      this.log.warn('could not title thread', { threadId, err });
      return null;
    }
  }

  /** Title older threads that still carry their first question as title. One at a time. */
  async backfill(limit = 30): Promise<number> {
    let n = 0;
    for (const id of this.repo.untitledThreads(limit)) {
      if (!this.models.current().configured) break;
      if (await this.title(id)) n++;
    }
    if (n > 0) this.log.info('titled earlier threads', { count: n });
    return n;
  }
}
