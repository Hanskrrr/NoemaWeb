// A note is a list of blocks: paragraphs, headings, lists, tables, quotes,
// fenced code and display math, each edited on its own. This splits Markdown
// into those blocks. Blank lines separate blocks, except inside code fences
// and $$ math; a list keeps going across blank lines while the next line is
// another item or indented under one; a heading is always a block of its own.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

function isMathToggle(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('$$')) return false;
  // $$x$$ on one line opens and closes.
  return !(t.length > 4 && t.endsWith('$$'));
}

export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let blankBefore = false;
  let fence: { char: string; length: number } | null = null;
  let math = false;

  const flush = () => {
    while (current.length > 0 && (current[current.length - 1] as string).trim() === '') current.pop();
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };
  const isList = () => current.length > 0 && LIST_ITEM.test(current[0] as string);

  for (const line of lines) {
    if (fence || math) {
      current.push(line);
      if (fence) {
        const m = FENCE.exec(line);
        const marker = m?.[1];
        if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null;
      } else if (line.trim().endsWith('$$')) {
        math = false;
      }
      continue;
    }

    if (line.trim() === '') {
      blankBefore = current.length > 0;
      if (current.length > 0) current.push(line);
      continue;
    }

    if (blankBefore) {
      const continuesList = isList() && (LIST_ITEM.test(line) || /^\s{2,}\S/.test(line));
      if (!continuesList) flush();
      blankBefore = false;
    }

    if (HEADING.test(line)) {
      flush();
      blocks.push(line.trimEnd());
      continue;
    }

    const open = FENCE.exec(line)?.[1];
    if (open) fence = { char: open[0] as string, length: open.length };
    else if (isMathToggle(line)) math = true;
    current.push(line);
  }
  flush();
  return blocks;
}

/** Blocks back into one document. */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks
    .map((b) => b.replace(/^(?:[ \t]*\n)+/, '').trimEnd()) // keep leading indentation: it can be code
    .filter((b) => b !== '')
    .join('\n\n');
}

/** The heading level of a block that is a heading, else null. */
export function headingLevel(block: string): number | null {
  const m = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(block);
  return m && !block.includes('\n') ? (m[1] as string).length : null;
}

/**
 * The block indexes of a section: a heading and everything under it, up to
 * the next heading of the same or a higher level.
 */
export function sectionOf(blocks: readonly string[], index: number): number[] {
  const level = headingLevel(blocks[index] ?? '');
  if (level === null) return [index];
  const out = [index];
  for (let i = index + 1; i < blocks.length; i++) {
    const l = headingLevel(blocks[i] as string);
    if (l !== null && l <= level) break;
    out.push(i);
  }
  return out;
}
