// Merging a thread into another. The AI drafts what the source established,
// to carry into the target; or the exchanges are taken as they are. The
// learner edits and accepts the draft; nothing in either thread is rewritten.

import { type ChatMessage, type CiteRefs, describeError, normalizeCitations } from '@noema/core';
import { ProviderError } from '../llm/provider.ts';
import type { ModelSource } from '../llm/settings.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';
import { buildOutline } from './notes.ts';

export const MERGE_FLUSH_MS = 300;
const MAX_FULL_CHARS = 20_000;

export const MERGE_PROMPT = [
  'You write what one conversation established, so it can be carried into another conversation.',
  '- Keep only what matters later: conclusions, definitions, formulas, examples worth keeping, and questions left open. Leave out how the conversation got there.',
  '- A few bullet points or a short paragraph; at most about 200 words unless the conversation is long.',
  '- Cite the exchanges with their labels, like [E3]. Use only labels that exist.',
  '- Write in the language of the conversation. Math as $...$ inline and $$...$$ on their own lines.',
  '- No preamble, no heading, no code fence around the answer.',
].join('\n');

export function mergeRequest(args: {
  outline: string;
  sourceTitle: string;
  targetTitle: string;
  quote: string | null;
}): ChatMessage[] {
  const where = args.quote
    ? `It was a side question about this passage of "${args.targetTitle}":\n\n> ${args.quote.replace(/\n/g, '\n> ')}`
    : `It will be carried into the conversation "${args.targetTitle}".`;
  return [
    { role: 'system', content: MERGE_PROMPT },
    { role: 'user', content: `The conversation "${args.sourceTitle}":\n\n${args.outline}\n\n${where}` },
  ];
}

/** The source's own exchanges as they are, each answer cited. */
export function fullTranscript(repo: Repo, sourceId: string): { text: string; refs: CiteRefs } {
  const outline = buildOutline(repo, sourceId);
  const labelOf = new Map([...outline.refs.entries()].map(([label, r]) => [r.messageId, label]));
  const parts: string[] = [];
  const refs: CiteRefs = {};
  for (const h of repo.history(sourceId, Number.MAX_SAFE_INTEGER)) {
    if (h.role === 'user') parts.push(`**Q:** ${h.content.trim()}`);
    else {
      const label = labelOf.get(h.id);
      if (label) refs[label] = { threadId: sourceId, messageId: h.id };
      parts.push(`**A:** ${h.content.trim()}${label ? ` [${label}]` : ''}`);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_FULL_CHARS) text = `${text.slice(0, MAX_FULL_CHARS)}…`;
  return { text, refs };
}

export class MergeWriter {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly log: Logger;
  private readonly live = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(deps: { repo: Repo; models: ModelSource; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.log = deps.log;
  }

  start(mergeId: string): void {
    if (this.live.has(mergeId)) return;
    const controller = new AbortController();
    const done = this.run(mergeId, controller.signal)
      .catch((err: unknown) => this.log.error('merge draft crashed', { mergeId, err }))
      .finally(() => this.live.delete(mergeId));
    this.live.set(mergeId, { controller, done });
  }

  async shutdown(): Promise<void> {
    const all = [...this.live.values()];
    for (const w of all) w.controller.abort();
    await Promise.all(all.map((w) => w.done));
  }

  private async run(mergeId: string, signal: AbortSignal): Promise<void> {
    const merge = this.repo.getMerge(mergeId);
    if (!merge || merge.status !== 'drafting') return;
    const outline = buildOutline(this.repo, merge.sourceThreadId);
    const refs = Object.fromEntries(outline.refs);
    let text = '';
    let saved = 0;
    const timer = setInterval(() => {
      if (text.length === saved) return;
      try {
        this.repo.saveMergeDraft(mergeId, text);
        saved = text.length;
      } catch (err) {
        this.log.error('merge flush failed', { mergeId, err });
      }
    }, MERGE_FLUSH_MS);
    try {
      const provider = this.models.current();
      if (!provider.configured) throw new ProviderError('not_configured', 'no model connected');
      for await (const ev of provider.stream({
        messages: mergeRequest({
          outline: outline.text,
          sourceTitle: merge.sourceTitle,
          targetTitle: merge.targetTitle,
          quote: merge.quote,
        }),
        purpose: 'merge',
        signal,
      })) {
        if (ev.type === 'text') text += ev.text;
      }
      clearInterval(timer);
      const clean = normalizeCitations(text.trim());
      if (!clean) throw new ProviderError('bad_request', 'empty summary');
      this.repo.finishMergeDraft(mergeId, clean, refs, 'draft', null);
      this.log.info('merge drafted', { mergeId, chars: clean.length });
    } catch (err) {
      clearInterval(timer);
      const kind = err instanceof ProviderError ? err.kind : 'internal';
      if (!(err instanceof ProviderError)) this.log.error('merge draft failed', { mergeId, err });
      const message = signal.aborted ? 'The server stopped before this was finished.' : describeError(kind);
      this.repo.finishMergeDraft(mergeId, text, refs, 'failed', message);
    }
  }
}
