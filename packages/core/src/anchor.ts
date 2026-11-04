// Anchors point at a span of text inside one immutable revision (a message
// revision or a source version). They follow the W3C Web Annotation model:
// a TextQuoteSelector (exact + some context) and a TextPositionSelector
// (offsets). Offsets are UTF-16 code units over the raw Markdown, the same
// units as JavaScript string indices, and never split a surrogate pair.
//
// Resolution order: the stored position if the text there still matches,
// else the quote if it occurs exactly once (or one occurrence clearly has the
// best context), else "unresolved". Never a silent jump to a guess.

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPosition {
  start: number;
  end: number;
}

export interface Anchor {
  targetId: string;
  quote: TextQuote;
  position: TextPosition;
}

export type Resolution =
  | { status: 'exact'; start: number; end: number }
  | { status: 'moved'; start: number; end: number }
  | { status: 'unresolved'; reason: 'not_found' | 'ambiguous' };

export const DEFAULT_CONTEXT_CHARS = 32;

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Move an offset left so it does not sit between the halves of a surrogate pair. */
export function snapLeft(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && isLow(text.charCodeAt(offset)) && isHigh(text.charCodeAt(offset - 1))) {
    return offset - 1;
  }
  return offset;
}

/** Move an offset right so it does not sit between the halves of a surrogate pair. */
export function snapRight(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && isLow(text.charCodeAt(offset)) && isHigh(text.charCodeAt(offset - 1))) {
    return offset + 1;
  }
  return offset;
}

export function createAnchor(
  targetId: string,
  text: string,
  start: number,
  end: number,
  contextChars: number = DEFAULT_CONTEXT_CHARS,
): Anchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    throw new RangeError(`bad anchor range [${start}, ${end}) for text of length ${text.length}`);
  }
  const s = snapLeft(text, start);
  const e = snapRight(text, end);
  const prefixStart = snapRight(text, Math.max(0, s - contextChars));
  const suffixEnd = snapLeft(text, Math.min(text.length, e + contextChars));
  return {
    targetId,
    quote: { exact: text.slice(s, e), prefix: text.slice(prefixStart, s), suffix: text.slice(e, suffixEnd) },
    position: { start: s, end: e },
  };
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

/** How many characters of context agree, counted outward from the quote. */
function contextScore(text: string, at: number, quote: TextQuote): number {
  let score = 0;
  for (let k = 1; k <= quote.prefix.length; k++) {
    if (text[at - k] !== quote.prefix[quote.prefix.length - k]) break;
    score++;
  }
  const after = at + quote.exact.length;
  for (let k = 0; k < quote.suffix.length; k++) {
    if (text[after + k] !== quote.suffix[k]) break;
    score++;
  }
  return score;
}

export function resolveAnchor(anchor: Anchor, text: string): Resolution {
  const { quote, position } = anchor;
  if (text.slice(position.start, position.end) === quote.exact && quote.exact.length > 0) {
    return { status: 'exact', start: position.start, end: position.end };
  }
  const hits = occurrences(text, quote.exact);
  if (hits.length === 0) return { status: 'unresolved', reason: 'not_found' };
  if (hits.length === 1) {
    const at = hits[0] as number;
    return { status: 'moved', start: at, end: at + quote.exact.length };
  }
  const scored = hits.map((at) => ({ at, score: contextScore(text, at, quote) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (best && second && best.score > second.score && best.score > 0) {
    return { status: 'moved', start: best.at, end: best.at + quote.exact.length };
  }
  return { status: 'unresolved', reason: 'ambiguous' };
}

export type W3CSelector =
  | { type: 'TextQuoteSelector'; exact: string; prefix: string; suffix: string }
  | { type: 'TextPositionSelector'; start: number; end: number };

/** The anchor as W3C Web Annotation selectors, for export. */
export function toW3CSelectors(anchor: Anchor): W3CSelector[] {
  return [
    { type: 'TextQuoteSelector', ...anchor.quote },
    { type: 'TextPositionSelector', ...anchor.position },
  ];
}
