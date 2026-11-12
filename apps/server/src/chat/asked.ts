// "Asked before", by meaning: the learner's chat model reads the questions
// already in the notebook (each with its passage and one-line summary) and
// says whether the one being written was asked already, in other words or
// another language. Comparing words (core/asked.ts) answers at once and
// catches literal repeats; this answers a moment later and catches the rest.
//
// The list of earlier questions comes first and grows only at its end, so
// the provider's prompt cache holds from one check to the next.

import {
  type AskedCandidate,
  type AskedHit,
  type ChatMessage,
  readableQuote,
} from '@noema/core';
import type { ModelSource } from '../llm/settings.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';

export const ASKED_PROMPT = [
  'You help a learner keep a study notebook free of repeats.',
  'You get a numbered list of questions the learner already asked. Each has the passage it was asked about (if any), a one-line summary of the answer it got, and its thread. Then you get a new question the learner is about to ask.',
  'Decide whether the new question was asked before:',
  '- "same": an earlier entry asks the same thing, in the same or other words or in another language, so the answer it got would answer the new question too.',
  '- "related": an earlier entry is about the same specific subject, so the learner should probably go on there, but the new question asks something that answer does not cover.',
  'Sharing a field or a broad topic is not enough. A question about a passage ("what is this?") is a question about that passage. Most new questions are new: when unsure, list nothing.',
  'Reply with one line of JSON and nothing else: {"same":[numbers],"related":[numbers]}',
].join('\n');

/** At most this many earlier questions are read (the newest). */
export const MAX_ASKED_ENTRIES = 300;

export type Candidate = AskedCandidate & { title: string; askedAt: string };

const clip = (text: string, max: number) => {
  const chars = Array.from(readableQuote(text));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

/** One earlier question as a line of the list. */
export function askedEntry(n: number, c: Candidate): string {
  const parts = [`${n}. Q: ${clip(c.question, 240)}`];
  if (c.passage) parts.push(`passage: "${clip(c.passage, 160)}"`);
  if (c.headline) parts.push(`answer in short: ${clip(c.headline, 140)}`);
  if (c.title) parts.push(`thread: ${clip(c.title, 60)}`);
  return parts.join(' | ');
}

export function askedRequest(
  entries: Candidate[],
  query: { text: string; passage?: string | null | undefined },
): ChatMessage[] {
  const list = entries.map((c, i) => askedEntry(i + 1, c)).join('\n');
  const passage = query.passage ? `\nIt is asked about this passage: "${clip(query.passage, 400)}"` : '';
  return [
    { role: 'system', content: ASKED_PROMPT },
    {
      role: 'user',
      content: `Questions already asked:\n${list}\n\nNew question: ${clip(query.text, 600)}${passage}`,
    },
  ];
}

/** The model's reply as entry numbers, or null if it cannot be read. Numbers outside the list are dropped. */
export function readVerdict(raw: string, count: number): { same: number[]; related: number[] } | null {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const numbers = (value: unknown) =>
    Array.isArray(value)
      ? [...new Set(value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 1 && v <= count))]
      : [];
  const same = numbers((parsed as { same?: unknown }).same);
  const related = numbers((parsed as { related?: unknown }).related).filter((v) => !same.includes(v));
  return { same, related };
}

export function askedHit(c: Candidate, strength: AskedHit['strength'], by: AskedHit['by'], terms: string[]): AskedHit {
  return {
    messageId: c.id,
    threadId: c.threadId,
    threadTitle: c.title,
    question: c.question,
    passage: c.passage ?? null,
    headline: c.headline ?? null,
    askedAt: c.askedAt,
    strength,
    by,
    terms,
  };
}

export class AskedJudge {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly log: Logger;
  /** The last few verdicts, so the same text is not judged twice (typing, pausing, coming back). */
  private readonly recent = new Map<string, AskedHit[]>();

  constructor(deps: { repo: Repo; models: ModelSource; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.log = deps.log;
  }

  /**
   * Earlier exchanges that asked this, as the model reads them: at most two,
   * one per thread, `same` first. `checked` is false when no model could be
   * asked (none connected, nothing to compare, or the call failed). Never throws.
   */
  async judge(
    notebookId: string,
    query: { text: string; passage?: string | null | undefined; threadId?: string | undefined },
    signal: AbortSignal = AbortSignal.timeout(20_000),
  ): Promise<{ hits: AskedHit[]; checked: boolean }> {
    try {
      const text = query.text.trim();
      if (!text) return { hits: [], checked: false };
      const provider = this.models.current();
      if (!provider.configured) return { hits: [], checked: false };
      const except = new Set(query.threadId ? this.repo.lineage(query.threadId) : []);
      const entries = this.repo
        .askedCandidates(notebookId)
        .filter((c) => !except.has(c.threadId) && c.question.trim())
        .slice(-MAX_ASKED_ENTRIES);
      if (entries.length === 0) return { hits: [], checked: true };
      const key = JSON.stringify([notebookId, text, query.passage ?? '', entries.length, entries.at(-1)?.id, [...except]]);
      const known = this.recent.get(key);
      if (known) return { hits: known, checked: true };
      const read = await this.among(entries, { text, passage: query.passage }, signal);
      if (!read) return { hits: [], checked: false };
      if (this.recent.size >= 50) this.recent.delete(this.recent.keys().next().value as string);
      this.recent.set(key, read.hits);
      this.repo.logEvent('asked_before.judged', null, {
        entries: entries.length,
        same: read.same,
        related: read.related,
        model: this.models.current().model,
      });
      return { hits: read.hits, checked: true };
    } catch (err) {
      this.log.warn('could not check whether it was asked before', { err });
      return { hits: [], checked: false };
    }
  }

  /**
   * Ask the model about these earlier questions (oldest first). Null when its
   * reply cannot be read. Throws what the provider throws.
   */
  async among(
    entries: Candidate[],
    query: { text: string; passage?: string | null | undefined },
    signal: AbortSignal = AbortSignal.timeout(20_000),
  ): Promise<{ hits: AskedHit[]; same: number; related: number } | null> {
    let raw = '';
    for await (const ev of this.models.current().stream({
      messages: askedRequest(entries, query),
      maxTokens: 80,
      light: true,
      purpose: 'asked',
      signal,
    })) {
      if (ev.type === 'text') raw += ev.text;
    }
    const verdict = readVerdict(raw, entries.length);
    if (!verdict) {
      this.log.warn('could not read the asked-before verdict', { chars: raw.length });
      return null;
    }
    const threads = new Set<string>();
    const hits: AskedHit[] = [];
    // Newest first within each strength: the latest place it was asked is where to go on.
    for (const [strength, numbers] of [
      ['same', verdict.same],
      ['related', verdict.related],
    ] as const) {
      for (const n of [...numbers].sort((a, b) => b - a)) {
        const c = entries[n - 1];
        if (!c || threads.has(c.threadId) || hits.length >= 2) continue;
        threads.add(c.threadId);
        hits.push(askedHit(c, strength, 'meaning', []));
      }
    }
    return { hits, same: verdict.same.length, related: verdict.related.length };
  }
}
