// One line per exchange, written by the model after the answer: what the
// exchange established, not the question asked. "What is this?" says
// nothing on a map; "Gradients point uphill, so descent steps the other
// way" does. The answer itself is never changed; the line is derived.

import type { ChatMessage } from '@noema/core';
import type { ModelSource } from '../llm/settings.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';
import { cleanTitle } from './titles.ts';

export const HEADLINE_PROMPT = [
  "You label exchanges on the map of a learner's notebook. Write one short line that says what this exchange established: the point of the answer, not the question asked, so the learner understands it at a glance.",
  '- Use the language of the question.',
  '- At most 12 words, or at most 24 characters in Chinese or Japanese.',
  '- No quotation marks, no Markdown, no full stop at the end.',
  'Reply with the line only.',
].join('\n');

const MAX_HEADLINE_CHARS = 80;

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

export function headlineRequest(input: { question: string; answer: string; passage?: string | undefined }): ChatMessage[] {
  const passage = input.passage
    ? `It was asked about this passage:\n> ${clip(input.passage, 300).replace(/\n/g, '\n> ')}\n\n`
    : '';
  return [
    { role: 'system', content: HEADLINE_PROMPT },
    {
      role: 'user',
      content: `${passage}Question:\n${clip(input.question, 800)}\n\nAnswer:\n${clip(input.answer, 3000)}`,
    },
  ];
}

/** The model's reply as one clean line, or null. */
export function cleanHeadline(raw: string): string | null {
  const line = cleanTitle(raw.replace(/^(headline|summary|标题|摘要|要点)\s*[:：]\s*/i, ''));
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > MAX_HEADLINE_CHARS ? `${chars.slice(0, MAX_HEADLINE_CHARS).join('')}…` : line;
}

export class Headliner {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly log: Logger;

  constructor(deps: { repo: Repo; models: ModelSource; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.log = deps.log;
  }

  /** Write the line for a finished answer. Never throws; returns the line or null. */
  async headline(answerId: string, signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<string | null> {
    try {
      const answer = this.repo.getMessage(answerId);
      if (!answer || answer.role !== 'assistant' || answer.status !== 'done' || !answer.content) return null;
      if (answer.headline) return answer.headline;
      const question = answer.replyTo ? this.repo.getMessage(answer.replyTo) : null;
      if (!question) return null;
      const provider = this.models.current();
      if (!provider.configured) return null;
      const passage = this.repo.originOf(answer.threadId)?.anchor.exact;
      let text = '';
      for await (const ev of provider.stream({
        messages: headlineRequest({ question: question.content, answer: answer.content, passage }),
        maxTokens: 80,
        light: true,
        purpose: 'headline',
        signal,
      })) {
        if (ev.type === 'text') text += ev.text;
      }
      const line = cleanHeadline(text);
      if (!line || !this.repo.setHeadline(answer.revisionId, line)) return null;
      return line;
    } catch (err) {
      this.log.warn('could not write a headline', { answerId, err });
      return null;
    }
  }

  /** Lines for earlier answers that have none. One at a time. */
  async backfill(limit = 200): Promise<number> {
    let n = 0;
    for (const id of this.repo.unheadlined(limit)) {
      if (!this.models.current().configured) break;
      if (await this.headline(id)) n++;
    }
    if (n > 0) this.log.info('wrote headlines for earlier answers', { count: n });
    return n;
  }
}
