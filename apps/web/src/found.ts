// Arriving somewhere from a jump (search, the map, a citation): the place is
// scrolled into view and flashed. When search led here, the words searched
// for are marked in it, and the first one is centred, so a long answer opens
// at the line that matched rather than at its top.

import { highlight } from './markdown/selection.ts';

let pending: { target: string; terms: string[] } | null = null;

/** Search is about to open `target` (a message or block id): mark these words there. */
export function expectFound(target: string, terms: string[]): void {
  pending = terms.length > 0 ? { target, terms } : null;
}

export function clearFound(): void {
  highlight('noema-found', null);
}

const SKIP = '.katex, [data-foreign], script, style, textarea';
const MAX_RANGES = 200;

/** Ranges of text in `root` where any of the terms occurs, ignoring case, in document order. */
export function findTerms(root: Element, terms: string[]): Range[] {
  const wanted = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t !== ''))];
  if (wanted.length === 0) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node && ranges.length < MAX_RANGES; node = walker.nextNode()) {
    const text = (node as Text).data;
    const lower = text.toLowerCase();
    // Case folding that changes length (rare) would misplace the range; skip such nodes.
    if (lower.length !== text.length) continue;
    const hits: Array<[number, number]> = [];
    for (const term of wanted) {
      for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) hits.push([i, i + term.length]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (const [start, end] of hits) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Bring a jump target into view and flash it. If search is opening it, mark
 * the words searched for and centre the first; otherwise centre the element.
 */
export function arrive(el: Element, target: string): void {
  const terms = pending?.target === target ? pending.terms : null;
  if (terms) pending = null;
  const ranges = terms ? findTerms(el, terms) : [];
  const first = ranges[0];
  if (first) {
    highlight('noema-found', ranges);
    const rect = first.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2 });
  } else {
    el.scrollIntoView({ block: 'center' });
  }
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2400);
}
