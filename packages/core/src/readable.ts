// A notebook as one Markdown file, for reading anywhere: About you, the
// notes, every thread with its side questions, and the sources. Not for
// importing (the JSON export is): answers are as they are in use, and the
// Trash is left out.

export interface ReadableThread {
  id: string;
  title: string;
  createdAt: string;
  /** The thread it is a side question of (still its own, not made its own thread). */
  parentId: string | null;
  /** Where it was asked from: a passage of an answer or of a source. */
  from?: { quote: string; in: string } | undefined;
  /** Questions and answers in order: answers as the revision in use. */
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ReadableNote {
  title: string;
  /** Each block's Markdown, in order. */
  blocks: string[];
  /** Citation labels, with what they cite. */
  cites: Array<{ label: string; thread: string; question: string }>;
}

export interface ReadableSource {
  title: string;
  url: string | null;
}

export interface ReadableNotebook {
  title: string;
  aboutMe: string;
  exportedAt: string;
  notes: ReadableNote[];
  threads: ReadableThread[];
  sources: ReadableSource[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Move every ATX heading down `by` levels (at most to level 6), so text
 * written with its own headings sits under the export's. Code fences and
 * $$ math blocks are left alone.
 */
export function demoteHeadings(markdown: string, by: number): string {
  let fence: string | null = null;
  let math = false;
  return markdown
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length) fence = null;
        return line;
      }
      if (f) {
        fence = f[1] ?? null;
        return line;
      }
      if (line.trim() === '$$') {
        math = !math;
        return line;
      }
      if (math) return line;
      const h = /^( {0,3})(#{1,6})(?=\s|$)/.exec(line);
      if (!h) return line;
      const level = Math.min(6, (h[2]?.length ?? 1) + by);
      return `${h[1]}${'#'.repeat(level)}${line.slice(h[0].length)}`;
    })
    .join('\n');
}

const oneLine = (text: string, max = 160) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const quoteBlock = (text: string) =>
  text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');

/** Threads in reading order: each main thread, then its side questions under it, oldest first. */
function inOrder(threads: ReadableThread[]): Array<{ thread: ReadableThread; depth: number }> {
  const byParent = new Map<string | null, ReadableThread[]>();
  const ids = new Set(threads.map((t) => t.id));
  for (const t of threads) {
    const key = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: Array<{ thread: ReadableThread; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of byParent.get(parent) ?? []) {
      out.push({ thread: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function notebookMarkdown(nb: ReadableNotebook): string {
  const out: string[] = [];
  out.push(`# ${nb.title || 'Notebook'}`);
  out.push(`Exported from Noema on ${nb.exportedAt.slice(0, 10)}. Answers are the ones in use; the Trash is not included.`);

  if (nb.aboutMe.trim()) {
    out.push('## About you');
    out.push(nb.aboutMe.trim());
  }

  if (nb.notes.length > 0) {
    out.push('## Notes');
    for (const note of nb.notes) {
      out.push(`### ${oneLine(note.title || 'Untitled note', 200)}`);
      for (const block of note.blocks) if (block.trim()) out.push(demoteHeadings(block.trim(), 3));
      if (note.cites.length > 0) {
        out.push(
          note.cites
            .map((c) => `- [${c.label}] ${c.thread ? `*${oneLine(c.thread, 120)}*: ` : ''}${oneLine(c.question)}`)
            .join('\n'),
        );
      }
    }
  }

  const threads = inOrder(nb.threads);
  if (threads.length > 0) {
    out.push('## Threads');
    const titles = new Map(nb.threads.map((t) => [t.id, t.title]));
    for (const { thread, depth } of threads) {
      const title = oneLine(thread.title || 'Untitled', 200);
      out.push(depth === 0 ? `### ${title}` : `#### ${'↳ '.repeat(depth)}${title}`);
      if (thread.parentId && depth > 0) {
        out.push(`*A side question of “${oneLine(titles.get(thread.parentId) || 'Untitled', 120)}”.*`);
      }
      if (thread.from) out.push(`Asked about this passage of ${thread.from.in}:\n\n${quoteBlock(thread.from.quote.trim())}`);
      for (const turn of thread.turns) {
        if (turn.role === 'user') out.push(`**You asked:** ${turn.content.trim()}`);
        else if (turn.content.trim()) out.push(demoteHeadings(turn.content.trim(), 4));
      }
    }
  }

  if (nb.sources.length > 0) {
    out.push('## Sources');
    out.push(
      nb.sources.map((s) => `- ${s.url ? `[${oneLine(s.title, 200)}](${s.url})` : oneLine(s.title, 200)}`).join('\n'),
    );
  }

  return `${out.join('\n\n')}\n`;
}
