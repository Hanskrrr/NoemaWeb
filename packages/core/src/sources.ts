// Sources: what a learner reads (a paper, a page, pasted text), kept as
// immutable Markdown versions. Pure helpers: the part of a source around a
// passage (for the model), its headings (for the catalog), and its blocks
// with offsets (for search and jumps).

import { MAX_SOURCE_CHARS } from './context.ts';

export interface SourceBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * The top-level blocks of a Markdown text with their offsets: paragraphs,
 * headings, lists, tables, code and display math, as a reader sees them.
 */
export function sourceBlocks(markdown: string): SourceBlock[] {
  const out: SourceBlock[] = [];
  const lines = markdown.split('\n');
  let offset = 0;
  let start = -1;
  let fence: string | null = null;
  let math = false;
  const close = (end: number) => {
    if (start >= 0) {
      const text = markdown.slice(start, end).replace(/\s+$/, '');
      if (text.trim()) out.push({ start, end: start + text.length, text });
    }
    start = -1;
  };
  for (const line of lines) {
    const lineEnd = offset + line.length;
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith(fence)) {
        fence = null;
        close(lineEnd);
      }
    } else if (math) {
      if (trimmed === '$$') {
        math = false;
        close(lineEnd);
      }
    } else if (/^(```|~~~)/.test(trimmed)) {
      close(offset);
      start = offset;
      fence = trimmed.slice(0, 3);
    } else if (trimmed === '$$') {
      close(offset);
      start = offset;
      math = true;
    } else if (trimmed === '') {
      close(offset);
    } else if (/^#{1,6}\s/.test(trimmed)) {
      close(offset);
      start = offset;
      close(lineEnd);
    } else if (start < 0) {
      start = offset;
    }
    offset = lineEnd + 1;
  }
  close(markdown.length);
  return out;
}

export interface SourceHeading {
  start: number;
  level: number;
  text: string;
}

export function sourceHeadings(markdown: string): SourceHeading[] {
  return sourceBlocks(markdown)
    .map((b) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(b.text);
      return m ? { start: b.start, level: (m[1] as string).length, text: (m[2] as string).trim() } : null;
    })
    .filter((h): h is SourceHeading => h !== null);
}

/**
 * The part of a source around a passage: the smallest section (heading to
 * the next heading of the same or a higher level) that holds it, cut to
 * whole blocks around the passage when the section is long.
 */
export function sourceSection(markdown: string, start: number, end: number, maxChars = MAX_SOURCE_CHARS): string {
  const headings = sourceHeadings(markdown);
  let from = 0;
  let level = 0;
  let headingLine = '';
  for (const h of headings) {
    if (h.start > start) break;
    from = h.start;
    level = h.level;
    headingLine = markdown.slice(h.start, markdown.indexOf('\n', h.start) === -1 ? markdown.length : markdown.indexOf('\n', h.start));
  }
  const next = headings.find((h) => h.start > start && (level === 0 || h.level <= level));
  const to = next ? next.start : markdown.length;
  if (to - from <= maxChars) return markdown.slice(from, to).trim();
  // Too long: whole blocks around the passage, as many as fit, nearest first.
  const blocks = sourceBlocks(markdown).filter((b) => b.end > from && b.start < to);
  const at = Math.max(
    0,
    blocks.findIndex((b) => b.end >= end),
  );
  let lo = at;
  let hi = at;
  let size = (blocks[at]?.text.length ?? 0) + headingLine.length;
  for (let grew = true; grew; ) {
    grew = false;
    const before = blocks[lo - 1];
    if (before && size + before.text.length + 2 <= maxChars) {
      lo -= 1;
      size += before.text.length + 2;
      grew = true;
    }
    const after = blocks[hi + 1];
    if (after && size + after.text.length + 2 <= maxChars) {
      hi += 1;
      size += after.text.length + 2;
      grew = true;
    }
  }
  const picked = blocks.slice(lo, hi + 1).map((b) => b.text);
  const firstIsHeading = blocks[lo]?.start === from && headingLine !== '';
  const text = [!firstIsHeading && headingLine ? headingLine : null, lo > 0 && !firstIsHeading ? '…' : null, ...picked]
    .filter((x): x is string => x !== null)
    .join('\n\n');
  // A single block longer than the limit: cut around the passage itself.
  return text.length <= maxChars + headingLine.length + 4
    ? text
    : markdown.slice(Math.max(from, start - maxChars / 2), Math.min(to, end + maxChars / 2)).trim();
}
