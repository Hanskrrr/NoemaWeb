// PDFs: the text pdf.js finds on each page, turned into Markdown. Pure: the
// server runs pdf.js and hands over each page's text items (string, position,
// size); this decides lines, paragraphs, headings and lists, drops running
// heads and page numbers, and starts every page with a "## Page N" heading,
// so a passage can be opened at its page in the original.
//
// What a PDF keeps is where each piece of text is drawn, not what it is, so
// all of this is guessing from geometry:
//  - a line: pieces at about the same height, in the order the file draws them
//    (columns come out one after the other, as the file draws them);
//  - a paragraph ends at a gap wider than the usual line spacing, a change of
//    size, an indented first line, or a line that stops well short of the
//    others; on a landscape page (slides) also at a line starting with a capital;
//  - a heading: a short line clearly larger than the body text;
//  - a list item: a line starting with a bullet.
// Formulas come out as the characters drawn, not as LaTeX. Text drawn as
// images (scans, some slides) is not there at all.

/** One piece of text on a page, in PDF units, y from the bottom. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  /** Font size (the vertical scale of the text). */
  size: number;
}

export interface PdfPageText {
  width: number;
  height: number;
  /** In the order the file draws them. Rotated text is left out by the caller. */
  items: PdfTextItem[];
}

export interface PdfReading {
  /** From the file's own title, else its first large line; '' if neither. */
  title: string;
  markdown: string;
  pages: number;
  /** Pages with no text: scanned, or only pictures. */
  emptyPages: number;
  /** The text was cut at a page because it was too long. */
  truncated: boolean;
}

/** Longest Markdown kept from one PDF (as for a web page). */
export const MAX_PDF_CHARS = 2_000_000;

const PAGE_HEADING = /^Page (\d+)$/;

/** The heading that starts page `n`. */
export function pageHeading(n: number): string {
  return `## Page ${n}`;
}

/** The page a heading's text marks ("Page 12" gives 12), or null. */
export function pageOfHeading(text: string): number | null {
  const m = PAGE_HEADING.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** Said in place of a page with no text. */
export const EMPTY_PAGE = '*No text on this page: it may be a picture or a scan.*';

// ---------------------------------------------------------------------------
// Characters

const CJK = /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
// Marks with no meaning as text: a glyph the file gives no character for
// (U+FFFC, as the server and cleanPdfText pass it on) and symbol-font characters
// (private use). At the start of a line they are taken as a bullet.
const NO_TEXT = /[\ufffc\ue000-\uf8ff]/g;

// Simplified-Chinese radicals some fonts draw in place of the ordinary
// character (U+2ED3 for U+957F, ...). NFKC does not map these.
const RADICALS: Record<string, string> = {
  '\u2ea0': '\u6c11', '\u2ec4': '\u897f', '\u2ec5': '\u89c1', '\u2ec6': '\u89d2', '\u2ec8': '\u8ba0',
  '\u2ec9': '\u8d1d', '\u2ecb': '\u8f66', '\u2ed1': '\u9577', '\u2ed3': '\u957f', '\u2ed4': '\u95e8',
  '\u2ed8': '\u9752', '\u2eda': '\u9875', '\u2edb': '\u98ce', '\u2edc': '\u98de', '\u2edd': '\u98df',
  '\u2ee2': '\u9a6c', '\u2ee3': '\u9aa8', '\u2ee5': '\u9c7c', '\u2ee6': '\u9e1f', '\u2ee7': '\u5364',
  '\u2ee8': '\u9ea6', '\u2ee9': '\u9ec4', '\u2eea': '\u9efe', '\u2eeb': '\u6589', '\u2eec': '\u9f50',
  '\u2eed': '\u6b6f', '\u2eee': '\u9f7f', '\u2ef0': '\u9f99',
};

/** A control character, other than tab and line ends (which become spaces). */
function isControl(code: number): boolean {
  return code <= 8 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159);
}

/** A file's name as given, without folders or control characters. */
export function cleanFileName(name: string): string {
  return Array.from(name)
    .filter((c) => c !== '/' && c !== '\\' && !isControl(c.codePointAt(0) ?? 0) && (c.codePointAt(0) ?? 0) > 13)
    .join('')
    .trim()
    .slice(0, 300);
}

/**
 * Clean the text of one piece: ligatures (U+FB01, "fi") and Kangxi radicals (U+2F12,
 * which some fonts draw for U+529B) become ordinary letters; soft hyphens and zero-width
 * marks go; a control character (how some TeX fonts come out) becomes U+FFFC, a
 * glyph with no text; odd spaces become spaces. Full-width punctuation stays.
 */
export function cleanPdfText(s: string): string {
  const cleaned = s
    .replace(/[\u2e80-\u2fdf\ufb00-\ufb4f]/g, (c) => RADICALS[c] ?? c.normalize('NFKC'))
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ');
  return Array.from(cleaned, (c) => (isControl(c.charCodeAt(0)) ? '\ufffc' : c)).join('');
}

/**
 * Text from a PDF made safe to put in Markdown: what would read as markup
 * (emphasis, code, math, links, a heading or a quote at the start) is escaped,
 * so it shows as it was printed.
 */
export function escapePdfText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if ('\\`*$~[]'.includes(c)) out += `\\${c}`;
    else if (c === '_') {
      // Inside a word (max_seq_len) it is never emphasis.
      const word = /[\p{L}\p{N}]/u;
      out += word.test(s[i - 1] ?? '') && word.test(s[i + 1] ?? '') ? c : '\\_';
    } else if (c === '&' && /^&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s.slice(i))) out += '\\&';
    else out += c;
  }
  return out.replace(/^(#{1,6}(?=\s|$)|>|\+(?=\s)|=+$|-+$)/, '\\$1');
}

// ---------------------------------------------------------------------------
// Lines

interface Line {
  text: string;
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  size: number;
}

function linesOf(page: PdfPageText): Line[] {
  const lines: Line[] = [];
  let cur: (Line & { sizeChars: number }) | null = null;
  const finish = () => {
    if (!cur) return;
    const text = cur.text.replace(/\s+/g, ' ').trim();
    if (text) lines.push({ text, x0: cur.x0, x1: cur.x1, y: cur.y, size: cur.size });
    cur = null;
  };
  for (const item of page.items) {
    const str = cleanPdfText(item.str);
    if (str === '') continue;
    const blank = str.trim() === '';
    const size = item.size > 0 ? item.size : 10;
    if (cur) {
      const c: Line & { sizeChars: number } = cur;
      const big = Math.max(size, c.size);
      // Raised or lowered pieces (a root sign, a big sum, a subscript) stay on the
      // line; a new line starts back to the left.
      const sameLine = Math.abs(item.y - c.y) <= 0.85 * big && item.x >= c.x1 - 2 * big;
      if (!sameLine) finish();
    }
    if (!cur) {
      if (blank) continue;
      cur = { text: '', x0: item.x, x1: item.x, y: item.y, size, sizeChars: 0 };
    }
    const c: Line & { sizeChars: number } = cur;
    if (blank) {
      if (!c.text.endsWith(' ')) c.text += ' ';
    } else {
      const gap = item.x - c.x1;
      if (c.text && !c.text.endsWith(' ') && !str.startsWith(' ') && gap > 0.2 * Math.min(size, c.size)) c.text += ' ';
      c.text += str;
      // The line's size and baseline are those of its longest piece (a
      // subscript or a footnote mark does not make a line small).
      const chars = str.trim().length;
      if (chars > c.sizeChars) {
        c.sizeChars = chars;
        c.size = size;
        c.y = item.y;
      }
    }
    c.x1 = Math.max(c.x1, item.x + Math.max(0, item.width));
  }
  finish();
  return lines;
}

// ---------------------------------------------------------------------------
// Running heads, feet and page numbers

const PAGE_NUMBER = /^(?:(?:page|p\.|seite|\u7b2c)\s*)?[-\u2013\u2014(]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[-\u2013\u2014)]?(?:\s*(?:\/|of|von|\u9875)\s*\d{1,4})?\s*(?:\u9875)?$/i;

function keyOf(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Drop page numbers (the top or bottom line, a number alone) and lines
 * repeated at the top or bottom of most pages, if they are not larger than
 * the text (a slide title used again is kept).
 */
function dropFurniture(pages: Line[][], body: number): Line[][] {
  const edges = pages.map((lines) => {
    const byHeight = [...lines].sort((a, b) => b.y - a.y);
    return new Set([...byHeight.slice(0, 2), ...byHeight.slice(-2)]);
  });
  const seen = new Map<string, number>();
  for (const edge of edges) {
    for (const key of new Set([...edge].map((l) => keyOf(l.text)))) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const enough = pages.length >= 3 ? Math.max(2, Math.ceil(pages.length / 2)) : 2;
  return pages.map((lines, i) => {
    const edge = edges[i] as Set<Line>;
    const byHeight = [...lines].sort((a, b) => b.y - a.y);
    const top = byHeight[0];
    const bottom = byHeight.at(-1);
    return lines.filter((l) => {
      if ((l === top || l === bottom) && PAGE_NUMBER.test(l.text)) return false;
      if (edge.has(l) && l.size <= 1.05 * body && (seen.get(keyOf(l.text)) ?? 0) >= enough && pages.length >= 2) return false;
      return true;
    });
  });
}

// ---------------------------------------------------------------------------
// Paragraphs, headings and lists

const BULLET = /^(?:[\u2022\u00b7\u25aa\u25ab\u25e6\u2023\u2043\u25cb\u25cf\u25a0\u25a1\u25b6\u25ba\u25b8\u25b9\u27a2\u27a4\u2713\u2714\u2756\u25c6\u25c7]|[-\u2013\u2014*](?=\s)|[\ufffc\ue000-\uf8ff](?=\s))\s*/u;
const GLYPH_START = /^[\ufffc\ue000-\uf8ff]\s/u;
const ENDS_SENTENCE = /[.!?\u3002\uff01\uff1f:\uff1a;\uff1b]["'\u201d\u2019)\uff09]?$/;

interface Block {
  kind: 'heading' | 'para' | 'item';
  text: string;
  size: number;
  /** The x where the block's first line starts. */
  x0: number;
  /** The rightmost end of its lines. */
  right: number;
  last: Line;
}

/**
 * Join two lines of a paragraph: a word broken with a hyphen is joined
 * (the hyphen kept before a capital, as in Jean-Paul); Chinese, Japanese and
 * Korean need no space; anything else gets one.
 */
function joinLines(a: string, b: string): string {
  if (/\p{L}[-\u2010\u2011]$/u.test(a) && /^\p{L}/u.test(b)) return /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : a + b;
  if (CJK.test(a.slice(-1)) || CJK.test(b[0] ?? '')) return a + b;
  return `${a} ${b}`;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/**
 * Read a PDF's pages as Markdown. `meta.title` is the file's own title, if it
 * has one. Pages start with "## Page N"; a page with no text says so.
 */
export function pdfToMarkdown(pages: PdfPageText[], meta: { title?: string | null } = {}): PdfReading {
  const all = pages.map(linesOf);
  // The body text size: the size most characters are set in.
  const chars = new Map<number, number>();
  for (const l of all.flat()) {
    const s = Math.round(l.size * 2) / 2;
    chars.set(s, (chars.get(s) ?? 0) + l.text.length);
  }
  const body = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const kept = dropFurniture(all, body);
  // The usual distance between lines of body text.
  const gaps: number[] = [];
  for (const lines of kept) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1] as Line;
      const b = lines[i] as Line;
      const dy = a.y - b.y;
      if (Math.abs(a.size - body) < 0.1 * body && Math.abs(b.size - body) < 0.1 * body && dy > 0.5 * body && dy < 3 * body) gaps.push(dy);
    }
  }
  const leading = median(gaps) ?? 1.2 * body;
  const isHeading = (l: Line) => l.size >= 1.15 * body && l.text.length <= 150 && /\p{L}/u.test(l.text);
  const headingSizes = [...new Set(kept.flat().filter(isHeading).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
  const level = (size: number) => Math.min(6, 3 + Math.max(0, headingSizes.indexOf(Math.round(size))));

  const continues = (block: Block, line: Line, landscape: boolean): boolean => {
    const prev = block.last;
    const dy = prev.y - line.y;
    if (Math.abs(line.size - prev.size) > 0.2 * Math.max(line.size, prev.size)) return false;
    // Up the page: the next column. The paragraph goes on if its sentence does.
    if (dy < -0.5 * line.size) return block.kind === 'para' && !ENDS_SENTENCE.test(prev.text);
    if (dy > 1.5 * leading * (line.size / body)) return false;
    if (dy < 0.3 * line.size) return false;
    if (block.kind === 'para' && line.x0 > prev.x0 + 0.8 * line.size) return false; // an indented first line
    if (block.kind === 'item' && line.x0 < block.x0 + 0.3 * line.size && !/^\p{Ll}/u.test(line.text)) return false;
    const right = Math.max(block.right, line.x1);
    if (prev.x1 < right - 3 * line.size) return false; // the line before stopped short
    if (landscape && /^[\p{Lu}\p{N}]/u.test(line.text) && !/[,\-\u2010\u2011]$/.test(prev.text)) return false;
    return true;
  };

  const out: string[] = [];
  let emptyPages = 0;
  let firstHeading: { text: string; size: number } | null = null;
  let truncated = false;
  let length = 0;
  for (const [i, lines] of kept.entries()) {
    const page = pages[i] as PdfPageText;
    const landscape = page.width > page.height;
    const parts: string[] = [pageHeading(i + 1)];
    if (lines.length === 0) {
      emptyPages++;
      parts.push(EMPTY_PAGE);
    }
    // A glyph with no text starts a list item only where two or more lines on
    // the page start with one at the same place (a big bracket in a formula
    // is alone where it is).
    const glyphStarts = new Map<number, number>();
    for (const l of lines) {
      if (GLYPH_START.test(l.text)) glyphStarts.set(Math.round(l.x0), (glyphStarts.get(Math.round(l.x0)) ?? 0) + 1);
    }
    const blocks: Block[] = [];
    let block: Block | null = null;
    for (const line of lines) {
      if (isHeading(line)) {
        const dy = block ? block.last.y - line.y : 0;
        if (block?.kind === 'heading' && Math.abs(block.size - line.size) < 0.1 * line.size && dy > 0 && dy < 2.2 * line.size) {
          block.text = joinLines(block.text, line.text);
          block.last = line;
          continue;
        }
        block = { kind: 'heading', text: line.text, size: line.size, x0: line.x0, right: line.x1, last: line };
        blocks.push(block);
        continue;
      }
      const bullet = BULLET.exec(line.text);
      const listed = bullet && (!GLYPH_START.test(line.text) || (glyphStarts.get(Math.round(line.x0)) ?? 0) >= 2);
      if (bullet && listed && line.text.length > bullet[0].length) {
        block = { kind: 'item', text: line.text.slice(bullet[0].length), size: line.size, x0: line.x0, right: line.x1, last: line };
        blocks.push(block);
        continue;
      }
      if (block && block.kind !== 'heading' && continues(block, line, landscape)) {
        block.text = joinLines(block.text, line.text);
        block.right = Math.max(block.right, line.x1);
        block.last = line;
        continue;
      }
      block = { kind: 'para', text: line.text, size: line.size, x0: line.x0, right: line.x1, last: line };
      blocks.push(block);
    }
    for (const [j, b] of blocks.entries()) {
      b.text = b.text.replace(NO_TEXT, '').replace(/\s+/g, ' ').trim();
      if (!b.text) continue;
      if (b.kind === 'heading') {
        // The title: the largest heading on the first page, unless it is a numbered section ("1 Introduction").
        if (i === 0 && !/^\d+(?:\.\d+)*\.?\s/.test(b.text) && (!firstHeading || b.size > firstHeading.size)) {
          firstHeading = { text: b.text, size: b.size };
        }
        parts.push(`${'#'.repeat(level(b.size))} ${escapePdfText(b.text)}`);
      } else if (b.kind === 'item') {
        // Items next to each other make one list.
        const text = `- ${escapePdfText(b.text)}`;
        if (blocks[j - 1]?.kind === 'item' && blocks[j - 1]?.text) parts[parts.length - 1] += `\n${text}`;
        else parts.push(text);
      } else {
        parts.push(escapePdfText(b.text));
      }
    }
    const pageText = parts.join('\n\n');
    if (length + pageText.length + 2 > MAX_PDF_CHARS) {
      truncated = true;
      break;
    }
    out.push(pageText);
    length += pageText.length + 2;
  }
  return {
    title: titleOf(meta.title) || firstHeading?.text || '',
    markdown: out.join('\n\n'),
    pages: pages.length,
    emptyPages,
    truncated,
  };
}

/** A file's own title, if it is one ("Microsoft Word - notes.docx" is not). */
function titleOf(title: string | null | undefined): string {
  const t = cleanPdfText(title ?? '')
    .replace(/^Microsoft (?:Word|PowerPoint|Excel) - /i, '')
    .replace(/\.(?:docx?|pptx?|xlsx?|tex|dvi|pdf|odt|odp|key|pages)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:untitled|untitled document|presentation\d*|slide \d+|\(anonymous\))$/i.test(t) ? '' : t;
}
