// The Assistant (ADR 0023): one assistant for the whole notebook. It looks
// things up with three read-only tools, and everything it is shown carries a
// short label, [1], [2]…, numbered through one answer. It opens things by
// label and cites by label; the labels it cites are kept with the answer and
// become buttons that open the exact place.

import { z } from 'zod';

/** At most this many rounds of looking up; then it answers with what it has. */
export const MAX_LOOKUP_ROUNDS = 6;
/** At most this many lookups in one round; more are answered with a note to ask fewer. */
export const MAX_LOOKUPS_PER_ROUND = 4;
/** What one lookup returns is cut to this many characters. */
export const MAX_LOOKUP_CHARS = 6000;

/**
 * What an answer keeps about a label it cited: the words it quoted, checked
 * against the original (ADR 0024), and the text around them for a preview.
 */
const Cited = {
  quote: z.string().max(2000).optional(),
  excerpt: z.string().max(4000).optional(),
};

/** Where a label points. */
export const VaultTarget = z.discriminatedUnion('kind', [
  /** A message in a thread (an exchange), or the thread itself (messageId null). */
  z.object({ kind: z.literal('thread'), threadId: z.string(), messageId: z.string().nullable(), title: z.string(), ...Cited }),
  /** A source, at an offset of one version (a passage, a section, a page). */
  z.object({
    kind: z.literal('source'),
    sourceId: z.string(),
    versionId: z.string(),
    at: z.number().int().nonnegative(),
    title: z.string(),
    ...Cited,
  }),
  /** A note, or one block of it. */
  z.object({ kind: z.literal('note'), noteId: z.string(), blockId: z.string().nullable(), title: z.string(), ...Cited }),
]);
export type VaultTarget = z.infer<typeof VaultTarget>;

/** One lookup, as the learner is shown it under the answer. */
export const LookupStep = z.object({
  tool: z.enum(['search', 'open', 'list']),
  /** "Searched “variance”", "Opened “Week 4”". */
  label: z.string(),
  /** How many labelled items it brought back. */
  found: z.number().int().nonnegative(),
});
export type LookupStep = z.infer<typeof LookupStep>;

/** What an Assistant answer keeps: the lookups it made, and where each label it cites points. */
export const Lookups = z.object({
  steps: z.array(LookupStep),
  refs: z.record(z.string().regex(/^\d{1,3}$/), VaultTarget),
});
export type Lookups = z.infer<typeof Lookups>;

/** What the Assistant is doing, as the stream reports it. */
export const AssistantPhase = z.enum(['thinking', 'looking', 'writing']);
export type AssistantPhase = z.infer<typeof AssistantPhase>;

// The tools, as the model is told about them (OpenAI's function format).

export const SearchArgs = z.object({ query: z.string().trim().min(1).max(200) });
export const OpenArgs = z.object({
  ref: z.coerce.number().int().positive().max(999),
  page: z.coerce.number().int().positive().max(100_000).optional(),
});
export const ListArgs = z.object({ what: z.enum(['threads', 'sources', 'notes', 'trash']) });
export const ShowArgs = OpenArgs;
// Files of linked folders (ADR 0025): paths start with the folder's name ("Slides/week4.pdf").
const FilePath = z.string().trim().min(1).max(4096);
export const ListFilesArgs = z.object({ path: z.string().trim().max(4096).optional() });
export const FindInFilesArgs = z.object({ query: z.string().trim().min(1).max(200) });
export const OpenFileArgs = z.object({ path: FilePath, page: z.coerce.number().int().positive().max(100_000).optional() });

// Changes (ADR 0024): each is proposed to the learner, who confirms it.
const Question = z.string().trim().min(1).max(8000);
const Ref = z.coerce.number().int().positive().max(999);
const Quote = z.string().trim().min(1).max(4000);
const Title = z.string().trim().min(1).max(200);
const Text = z.string().trim().min(1).max(20_000);
export const ActionArgs = {
  start_thread: z.object({ question: Question }),
  ask_in_thread: z.object({ ref: Ref, question: Question }),
  ask_about_passage: z.object({ ref: Ref, quote: Quote, question: Question }),
  create_note: z.object({ title: Title, content: Text }),
  add_to_note: z.object({ ref: Ref, content: Text }),
  change_note_block: z.object({ ref: Ref, content: Text }),
  note_from_thread: z.object({ ref: Ref }),
  rename: z.object({ ref: Ref, title: Title }),
  pin: z.object({ ref: Ref, quote: Quote, thread: Ref.optional() }),
  unpin: z.object({ thread: Ref, quote: Quote }),
  merge_threads: z.object({ from: Ref, into: Ref }),
  move_to_trash: z.object({ ref: Ref }),
  restore: z.object({ ref: Ref }),
  add_source: z
    .object({ url: z.string().trim().url().max(2000).optional(), text: Text.optional(), title: Title.optional() })
    .refine((v) => Boolean(v.url) !== Boolean(v.text), 'give a url or a text, not both'),
  write_file: z.object({ path: FilePath, content: z.string().max(2_000_000) }),
  edit_file: z.object({ path: FilePath, old: z.string().min(1).max(200_000), new: z.string().max(200_000) }),
  save_note_to_file: z.object({ ref: Ref, path: FilePath }),
  note_from_file: z.object({ path: FilePath }),
} as const;
export type ActionKind = keyof typeof ActionArgs;
export const ACTION_KINDS = Object.keys(ActionArgs) as ActionKind[];

export type ToolName = 'search' | 'open' | 'list' | 'show' | 'list_files' | 'find_in_files' | 'open_file' | ActionKind;

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export const ASSISTANT_TOOLS: ToolSpec[] = [
  {
    name: 'search',
    description:
      "Search the learner's notebook: thread titles, their questions and the answers they got, notes, sources and the text of sources. Matches words, not meaning: try the learner's own words, a shorter query, other words or the other language if little comes back. Returns labelled results.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words to find.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'open',
    description:
      'Open what a label points at: a thread (its exchanges), a source (the part around a passage, or its outline), or a note. For a PDF, give a page to read that page. Returns the text, with labels for what is in it.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'The number of a label, [3] → 3.' },
        page: { type: 'integer', description: 'For a PDF source: the page to read.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    description: 'List every thread, source or note in the notebook, newest first, labelled; or what is in the Trash.',
    parameters: {
      type: 'object',
      properties: { what: { type: 'string', enum: ['threads', 'sources', 'notes', 'trash'] } },
      required: ['what'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List the folders on the learner\'s computer linked to the notebook (no path), or what is in one: a path starting with the folder\'s name ("Slides" or "Slides/week4").',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Empty for the folders; else a folder name and a path inside it.' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'find_in_files',
    description: 'Find lines with all these words in the text files (code, notes, Markdown) of the linked folders, and files named with them.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_file',
    description:
      'Open a file of a linked folder (text, Markdown, code, or a PDF) as a source and read it, labelled; read again if it changed on disk. For a PDF, give a page.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The folder\'s name, then the path inside it: "Slides/week4.pdf".' },
        page: { type: 'integer', description: 'For a PDF: the page to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'show',
    description:
      'Take the learner to what a label points at: the thread, the passage in its source (a PDF at a page), or the note. Use it when they ask to go somewhere or see something; it happens at once.',
    parameters: refParams({ page: { type: 'integer', description: 'For a PDF source: the page to show.' } }),
  },
  ...actionTools(),
];

function refParams(more: Record<string, unknown> = {}, required: string[] = ['ref']): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ref: { type: 'integer', description: 'The number of a label, [3] → 3.' }, ...more },
    required,
    additionalProperties: false,
  };
}

function str(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

/** The changes the Assistant can propose. None happens until the learner confirms it. */
function actionTools(): ToolSpec[] {
  const proposed = ' Proposed to the learner, who confirms it; it does not happen until they do.';
  const QUOTE = str('Words copied exactly from what the label points at: the passage meant.');
  const object = (properties: Record<string, unknown>, required: string[]) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  return [
    {
      name: 'start_thread',
      description: `Start a new thread with a question (the answer comes in that thread).${proposed}`,
      parameters: object({ question: str('The first question, in the learner\'s words where you can.') }, ['question']),
    },
    {
      name: 'ask_in_thread',
      description: `Ask a question in an existing thread, after what was said there.${proposed}`,
      parameters: refParams({ question: str('The question.') }, ['ref', 'question']),
    },
    {
      name: 'ask_about_passage',
      description: `Ask a side question about a passage: of an answer in a thread (a label of an exchange) or of a source.${proposed}`,
      parameters: refParams({ quote: QUOTE, question: str('The question about it.') }, ['ref', 'quote', 'question']),
    },
    {
      name: 'create_note',
      description: `Make a new note. Its text arrives as a suggestion the learner accepts in the note.${proposed}`,
      parameters: object({ title: str('The note\'s title.'), content: str('Markdown.') }, ['title', 'content']),
    },
    {
      name: 'add_to_note',
      description: `Add text to a note: after a block (a block's label) or at its end (the note's label). It arrives as a suggestion.${proposed}`,
      parameters: refParams({ content: str('Markdown.') }, ['ref', 'content']),
    },
    {
      name: 'change_note_block',
      description: `Suggest a new version of one block of a note (a block's label). The block is unchanged until the learner accepts it.${proposed}`,
      parameters: refParams({ content: str('The block as it should read, Markdown.') }, ['ref', 'content']),
    },
    {
      name: 'note_from_thread',
      description: `Turn a thread (and its side questions) into a study note, written by the AI.${proposed}`,
      parameters: refParams(),
    },
    {
      name: 'rename',
      description: `Rename a thread, a source or a note.${proposed}`,
      parameters: refParams({ title: str('The new title.') }, ['ref', 'title']),
    },
    {
      name: 'pin',
      description: `Pin a passage so it is sent with every question in a thread: the passage's label and its exact words, and the thread to pin it to (by default the thread it is in).${proposed}`,
      parameters: refParams({ quote: QUOTE, thread: { type: 'integer', description: 'The label of the thread to pin it to.' } }, [
        'ref',
        'quote',
      ]),
    },
    {
      name: 'unpin',
      description: `Unpin a passage from a thread: the thread's label and words of the pinned passage.${proposed}`,
      parameters: object({ thread: { type: 'integer', description: 'The label of the thread.' }, quote: QUOTE }, ['thread', 'quote']),
    },
    {
      name: 'merge_threads',
      description: `Merge what one thread found into another: the AI drafts a summary the learner edits and accepts there.${proposed}`,
      parameters: object(
        {
          from: { type: 'integer', description: 'The label of the thread to merge.' },
          into: { type: 'integer', description: 'The label of the thread to merge it into.' },
        },
        ['from', 'into'],
      ),
    },
    {
      name: 'move_to_trash',
      description: `Move a thread (with its side questions), a source or a note to the Trash, where it can be restored.${proposed}`,
      parameters: refParams(),
    },
    {
      name: 'restore',
      description: `Bring a thread, a source or a note back from the Trash (labels from list with what: trash).${proposed}`,
      parameters: refParams(),
    },
    {
      name: 'write_file',
      description: `Write a text file in a linked folder: a new file, or a whole new text for one (what it said before is kept, to undo).${proposed}`,
      parameters: object({ path: str('The folder\'s name, then the path: "Notes/summary.md".'), content: str('The whole text of the file.') }, ['path', 'content']),
    },
    {
      name: 'edit_file',
      description: `Change part of a text file in a linked folder: replace text that occurs exactly once with new text. Open it first to copy the old text exactly.${proposed}`,
      parameters: object(
        { path: str('The folder\'s name, then the path.'), old: str('The text to replace, copied exactly.'), new: str('What it becomes.') },
        ['path', 'old', 'new'],
      ),
    },
    {
      name: 'save_note_to_file',
      description: `Save a note (its label) as a Markdown file in a linked folder.${proposed}`,
      parameters: refParams({ path: str('The folder\'s name, then the path: "Notes/week4.md".') }, ['ref', 'path']),
    },
    {
      name: 'note_from_file',
      description: `Make a note from a text or Markdown file of a linked folder; its paragraphs and headings become blocks.${proposed}`,
      parameters: object({ path: str('The folder\'s name, then the path.') }, ['path']),
    },
    {
      name: 'add_source',
      description: `Add a source to read: a web page or arXiv paper by its address, or text.${proposed}`,
      parameters: object({ url: str('The address.'), text: str('Text to add instead.'), title: str('A title, if you want one.') }, []),
    },
  ];
}

/** A change the Assistant proposed, as the learner is shown it (ADR 0024). */
export const AssistantAction = z.object({
  id: z.string(),
  messageId: z.string(),
  kind: z.enum(['show', ...(Object.keys(ActionArgs) as [ActionKind, ...ActionKind[]])]),
  /** One line saying what it does, with titles. */
  summary: z.string(),
  /** What it will write, to look at before Do it (a file's new text, or what an edit changes). */
  detail: z.string().nullable(),
  status: z.enum(['proposed', 'running', 'done', 'cancelled', 'failed', 'undone']),
  error: z.string().nullable(),
  /** Where to go to see it: what it made or changed. */
  open: VaultTarget.nullable(),
  /** Done, and it can be undone. */
  undoable: z.boolean(),
  createdAt: z.string(),
});
export type AssistantAction = z.infer<typeof AssistantAction>;

/** Where the learner is when they ask the Assistant: what is open, and what they selected there. */
export const AssistantPlace = z.object({
  kind: z.enum(['thread', 'source', 'note']),
  id: z.string(),
  versionId: z.string().optional(),
  selection: z.string().max(4000).optional(),
});
export type AssistantPlace = z.infer<typeof AssistantPlace>;

/**
 * The words an answer quotes and attributes to `label`: in quotation marks
 * right before it (“…” [3], "…" [3], 「…」[3]), or a quoted paragraph (> …)
 * that ends with it or is followed by it. Candidates; checking them is the caller's.
 */
export function quotesNear(text: string, label: string): string[] {
  const out: string[] = [];
  const tag = `[${label}]`;
  const marks = /[“"「『]([^“”"「」『』\n]{3,2000})[”"」』][\s,.;:，。]{0,3}$/;
  for (let i = text.indexOf(tag); i !== -1; i = text.indexOf(tag, i + tag.length)) {
    const before = text.slice(Math.max(0, i - 2100), i);
    const m = marks.exec(before);
    if (m?.[1]) out.push(m[1].trim());
    // A quoted paragraph: the lines starting with > just before the label's line, or on it.
    const lines = text.slice(0, i).split('\n');
    const own = lines.at(-1) ?? '';
    const quoted: string[] = [];
    if (own.trimStart().startsWith('>')) quoted.unshift(own.replace(/^\s*>\s?/, ''));
    for (let k = lines.length - (own.trim() === '' || own.trimStart().startsWith('>') ? 2 : 1); k >= 0; k--) {
      const l = lines[k] ?? '';
      if (!l.trimStart().startsWith('>')) break;
      quoted.unshift(l.replace(/^\s*>\s?/, ''));
    }
    const block = quoted.join(' ').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
    if (block.length >= 3 && !out.includes(block)) out.push(block);
  }
  return out;
}

/** Text with runs of white space as one space, for comparing quotes. */
function squashed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Where a quote is in a text, or -1: the words exactly, white space aside.
 * A quote shortened with … or ... must have each piece, in order.
 * Returns the offset in `text` where it starts.
 */
export function findQuote(text: string, quote: string): number {
  return quoteRange(text, quote)?.start ?? -1;
}

/** Where a quote is in a text, start and end, white space aside (see findQuote); null if it is not there. */
export function quoteRange(text: string, quote: string): { start: number; end: number } | null {
  const pieces = quote
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map(squashed)
    .filter((p) => p.length > 0);
  if (pieces.length === 0) return null;
  // Map squashed offsets back to the text.
  const map: number[] = [];
  let flat = '';
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      if (!space && flat.length > 0) {
        flat += ' ';
        map.push(i);
      }
      space = true;
    } else {
      flat += c;
      map.push(i);
      space = false;
    }
  }
  let from = 0;
  let start = -1;
  for (const piece of pieces) {
    const at = flat.indexOf(piece, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    from = at + piece.length;
  }
  const a = map[start];
  const b = map[from - 1];
  return a === undefined || b === undefined ? null : { start: a, end: b + 1 };
}

/** The labels an answer uses ([3]), in the order they first appear, that are among `known`. */
export function citedLabels(text: string, known: (label: string) => boolean): string[] {
  const seen: string[] = [];
  for (const part of splitNumbered(text, known)) {
    if (typeof part !== 'string' && !seen.includes(part.label)) seen.push(part.label);
  }
  return seen;
}

const NUMBERED = /\[(\d{1,3})\](?!\()/g;

/**
 * The model's variants ([1, 3], [1，3], 【1】, ［1］) in the one form: [1][3].
 * Only when every number is a label it was given, so an interval such as
 * [0, 1] stays as written; code and math are left alone.
 */
export function normalizeNumbered(text: string, known: (label: string) => boolean): string {
  return outsideCode(text, (plain) =>
    plain.replace(/[[【［]\s*(\d{1,3}(?:\s*[,，、;；]\s*\d{1,3})*)\s*[\]】］](?!\()/g, (whole, inner: string) => {
      const labels = inner.split(/\s*[,，、;；]\s*/);
      return labels.every(known) ? labels.map((label) => `[${label}]`).join('') : whole;
    }),
  );
}

/** Text split into plain runs and the labels that have a target. */
export function splitNumbered(text: string, known: (label: string) => boolean): Array<string | { label: string }> {
  const out: Array<string | { label: string }> = [];
  let last = 0;
  for (const m of text.matchAll(NUMBERED)) {
    const label = m[1] as string;
    if (!known(label)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ label });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * An earlier answer as it is sent back with a later question: without its
 * labels, which meant something only in that answer.
 */
export function withoutLabels(text: string, labels: string[]): string {
  if (labels.length === 0) return text;
  const set = new Set(labels);
  return outsideCode(text, (plain) =>
    plain
      .replace(NUMBERED, (whole, label: string) => (set.has(label) ? '' : whole))
      .replace(/[ \t]+([.,;:!?。，；：！？])/g, '$1'),
  );
}

/** Apply `fn` to the text outside fenced code, inline code and math. */
function outsideCode(text: string, fn: (plain: string) => string): string {
  const pieces = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return pieces.map((piece, i) => (i % 2 === 1 ? piece : fn(piece))).join('');
}

/** A string cut to `max` characters, with a note saying so. */
export function cutLookup(text: string, max = MAX_LOOKUP_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}\n\n[… cut here: ${chars.length - max} more characters. Open a label, or search, for more.]`;
}
