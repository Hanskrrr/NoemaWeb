// Reading a source: which threads belong to it, and where in it the learner
// asked most. Pure, so it is tested in Node.

import type { SourceDetail, Thread } from '@noema/core';

/** The source a thread belongs to: asked about a passage of it, or a side question or split-off of such a thread. */
export interface SourceFamily {
  sourceId: string;
  /** The version the first thread was asked about. */
  versionId: string;
  /** The thread asked about the passage. */
  rootId: string;
}

export function sourceFamily(threads: Thread[], id: string): SourceFamily | null {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (let t = byId.get(id); t && !seen.has(t.id); t = byId.get(t.parentThreadId ?? t.continuedFromId ?? '')) {
    seen.add(t.id);
    if (t.sourceId && t.sourceVersionId) return { sourceId: t.sourceId, versionId: t.sourceVersionId, rootId: t.id };
  }
  return null;
}

export type Asked = SourceDetail['threads'][number];

/** Threads asked about one stretch of the text: passages that overlap count as one. */
export interface AskedPassage {
  start: number;
  end: number;
  /** The text of the whole stretch. */
  exact: string;
  questions: number;
  threads: Asked[];
}

/** Where questions were asked, most questions first, then in reading order. */
export function askedPassages(threads: Asked[], content: string): AskedPassage[] {
  const sorted = [...threads].sort((a, b) => a.passage.start - b.passage.start || a.passage.end - b.passage.end);
  const out: AskedPassage[] = [];
  for (const t of sorted) {
    const last = out.at(-1);
    if (last && t.passage.start < last.end) {
      last.end = Math.max(last.end, t.passage.end);
      last.questions += t.questions;
      last.threads.push(t);
    } else {
      out.push({ start: t.passage.start, end: t.passage.end, exact: '', questions: t.questions, threads: [t] });
    }
  }
  for (const p of out) p.exact = content.slice(p.start, p.end);
  return out.sort((a, b) => b.questions - a.questions || a.start - b.start);
}

/** How dark a passage's mark in the margin is: one question is light, five or more is full. */
export function markStrength(questions: number): number {
  return Math.min(1, 0.3 + 0.175 * Math.max(0, questions - 1));
}

/** "example.org", for a link to where a source was read. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A heading's line as plain words for the contents list: no Markdown escapes, links or emphasis marks. */
export function headingText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?<!\\)(\*\*|__|\*|_|`)/g, '')
    .replace(/\\([\\`*_[\]$<#|])/g, '$1')
    .trim();
}
