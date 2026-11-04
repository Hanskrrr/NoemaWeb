// Markdown parsing that keeps track of where every rendered character came
// from in the raw source. Anchors are offsets into the raw Markdown of an
// immutable revision, so a selection in the rendered page has to be mapped
// back to those offsets exactly.
//
// Pure functions, no DOM: unit-tested in apps/web/test.

import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-math';

export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
}

export function nodeRange(node: Nodes): { start: number; end: number } | null {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  return s === undefined || e === undefined ? null : { start: s, end: e };
}

/**
 * Where a code block's text sits inside its node: after the opening fence
 * line and before the closing fence. Indented code has no fences.
 */
export function codeRegion(source: string, start: number, end: number): { start: number; end: number } {
  const raw = source.slice(start, end);
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
  if (!marker) return { start, end }; // indented code: no fences
  const firstNl = raw.indexOf('\n');
  if (firstNl === -1) return { start: end, end }; // only the opening fence has arrived
  const bodyStart = start + firstNl + 1;
  const lastNl = raw.lastIndexOf('\n');
  const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
  const bodyEnd = closing.test(raw.slice(lastNl + 1)) ? start + lastNl : end; // unclosed while streaming
  return { start: bodyStart, end: Math.max(bodyStart, bodyEnd) };
}

/**
 * For each code unit of `value` (the text as rendered), its offset in
 * `source.slice(base, ...)` (the raw Markdown), or null if `value` is not a
 * subsequence of the raw text (then the caller snaps to the whole node).
 * Markdown only removes characters from text (escapes, indentation, quote
 * markers), except for character references like &amp;, which still align
 * on their first character.
 */
export function alignOffsets(value: string, raw: string, base: number): number[] | null {
  const map = new Array<number>(value.length);
  if (value === raw) {
    for (let i = 0; i < value.length; i++) map[i] = base + i;
    return map;
  }
  let j = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    while (j < raw.length && raw[j] !== c) j++;
    if (j >= raw.length) return null;
    map[i] = base + j;
    j++;
  }
  return map;
}

/** Map a rendered [from, to) inside one leaf to raw offsets. */
export function leafToSource(
  value: string,
  raw: string,
  base: number,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (to <= from) return null;
  const map = alignOffsets(value, raw, base);
  if (!map) return { start: base, end: base + raw.length };
  return { start: map[from] as number, end: (map[to - 1] as number) + 1 };
}

/** The inverse: raw [start, end) to rendered [from, to) inside one leaf, clipped to it. */
export function sourceToLeaf(
  value: string,
  raw: string,
  base: number,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const map = alignOffsets(value, raw, base);
  if (!map) return start < base + raw.length && end > base ? { from: 0, to: value.length } : null;
  let from = -1;
  let to = -1;
  for (let i = 0; i < map.length; i++) {
    const at = map[i] as number;
    if (at >= start && at < end) {
      if (from === -1) from = i;
      to = i + 1;
    }
  }
  return from === -1 ? null : { from, to };
}

export interface Leaf {
  kind: 'text' | 'inlineCode' | 'code' | 'html' | 'inlineMath' | 'math';
  start: number;
  end: number;
  value: string;
  /** Selected as a whole or not at all (rendered math). */
  atomic: boolean;
}

/** Every rendered leaf in document order, with the raw range it maps to. */
export function leaves(root: Root, source: string): Leaf[] {
  const out: Leaf[] = [];
  const visit = (node: Nodes) => {
    const r = nodeRange(node);
    switch (node.type) {
      case 'text':
      case 'html':
        if (r) out.push({ kind: node.type, ...r, value: node.value, atomic: false });
        return;
      case 'inlineCode':
        if (r) out.push({ kind: 'inlineCode', ...r, value: node.value, atomic: false });
        return;
      case 'code':
        if (r) out.push({ kind: 'code', ...codeRegion(source, r.start, r.end), value: node.value, atomic: false });
        return;
      case 'inlineMath':
      case 'math':
        if (r) out.push({ kind: node.type, ...r, value: node.value, atomic: true });
        return;
      default:
        if ('children' in node) for (const child of node.children as Nodes[]) visit(child);
    }
  };
  visit(root);
  return out;
}
