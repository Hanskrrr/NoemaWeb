// How a search hit reads: where it is, what kind of thing it is, when, and
// its snippet with the matched words marked. Pure, so it is tested in Node.

import type { SearchHit } from '@noema/core';

export type Part = { text: string; mark: boolean };

/** The snippet cut into plain and marked parts; overlapping or touching matches become one mark. */
export function snippetParts(text: string, matches: Array<{ start: number; end: number }>): Part[] {
  const spans = matches
    .map((m) => ({ start: Math.max(0, m.start), end: Math.min(text.length, m.end) }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const m of spans) {
    const last = merged.at(-1);
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else merged.push({ ...m });
  }
  const parts: Part[] = [];
  let at = 0;
  for (const m of merged) {
    if (m.start > at) parts.push({ text: text.slice(at, m.start), mark: false });
    parts.push({ text: text.slice(m.start, m.end), mark: true });
    at = m.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/** Where a hit is, top first: the threads down to it, or the note. */
export function whereParts(hit: SearchHit): string[] {
  const title = (t: string) => t || 'Untitled';
  if (hit.kind === 'note' || hit.kind === 'block') return [`Note · ${title(hit.title)}`];
  return [...hit.path.map((p) => title(p.title)), title(hit.title)];
}

/** Where a hit is, in one line ("Attention › Why scale by √d?"). */
export function whereOf(hit: SearchHit): string {
  return whereParts(hit).join(' › ');
}

/** What kind of thing matched, in a few words. */
export function kindOf(hit: SearchHit): string {
  const side = hit.path.length > 0 ? ' in a side question' : '';
  switch (hit.kind) {
    case 'message':
      return hit.role === 'user' ? `You asked${side}` : `Answer${side}`;
    case 'thread':
      return hit.path.length > 0 ? 'Side question title' : 'Thread title';
    case 'note':
      return 'Note title';
    case 'block':
      return 'In a note';
  }
}

/** "12 Oct", with the year when it is not this year. */
export function dayOf(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
