// Browser selection <-> raw Markdown offsets, using the data-s/data-e spans
// that Markdown.tsx renders. Offsets are UTF-16 code units, like JS strings.

import { leafToSource, sourceToLeaf } from './parse.ts';

function spansIn(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-s][data-e]'));
}

function rangeOf(span: HTMLElement): { s: number; e: number } {
  return { s: Number(span.dataset.s), e: Number(span.dataset.e) };
}

/** Text offset of a DOM boundary point, counted within `span`. */
function localOffset(span: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(span, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The raw range covered by the current selection inside `root`, or null. */
export function selectionToSource(root: Element, source: string): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spansIn(root)) {
    if (!range.intersectsNode(span)) continue;
    const { s, e } = rangeOf(span);
    if (span.hasAttribute('data-atomic')) {
      start = Math.min(start, s);
      end = Math.max(end, e);
      continue;
    }
    const value = span.textContent ?? '';
    const from = span.contains(range.startContainer) ? localOffset(span, range.startContainer, range.startOffset) : 0;
    const to = span.contains(range.endContainer)
      ? localOffset(span, range.endContainer, range.endOffset)
      : value.length;
    const mapped = leafToSource(value, source.slice(s, e), s, from, to);
    if (!mapped) continue; // the selection only touches this span's edge
    start = Math.min(start, mapped.start);
    end = Math.max(end, mapped.end);
  }
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

function pointAt(span: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Node | null = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = t.textContent?.length ?? 0;
    if (remaining <= len) return { node: t, offset: remaining };
    remaining -= len;
    last = t;
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: span, offset: 0 };
}

/** A DOM Range covering the raw range [start, end) inside `root`, for highlighting. */
export function sourceToRange(root: Element, source: string, start: number, end: number): Range | null {
  let range: Range | null = null;
  for (const span of spansIn(root)) {
    const { s, e } = rangeOf(span);
    if (e <= start || s >= end) continue;
    let from: { node: Node; offset: number };
    let to: { node: Node; offset: number };
    if (span.hasAttribute('data-atomic')) {
      const r = document.createRange();
      r.selectNode(span);
      from = { node: r.startContainer, offset: r.startOffset };
      to = { node: r.endContainer, offset: r.endOffset };
    } else {
      const local = sourceToLeaf(span.textContent ?? '', source.slice(s, e), s, start, end);
      if (!local) continue;
      from = pointAt(span, local.from);
      to = pointAt(span, local.to);
    }
    if (!range) {
      range = document.createRange();
      range.setStart(from.node, from.offset);
    }
    range.setEnd(to.node, to.offset);
  }
  return range;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };

/** Highlight with the CSS Custom Highlight API where supported; otherwise do nothing. */
export function highlight(name: string, range: Range | null): boolean {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Ctor) return false;
  if (range) registry.set(name, new Ctor(range));
  else registry.delete(name);
  return true;
}
