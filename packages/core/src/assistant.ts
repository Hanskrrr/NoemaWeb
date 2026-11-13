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

/** Where a label points. */
export const VaultTarget = z.discriminatedUnion('kind', [
  /** A message in a thread (an exchange), or the thread itself (messageId null). */
  z.object({ kind: z.literal('thread'), threadId: z.string(), messageId: z.string().nullable(), title: z.string() }),
  /** A source, at an offset of one version (a passage, a section, a page). */
  z.object({
    kind: z.literal('source'),
    sourceId: z.string(),
    versionId: z.string(),
    at: z.number().int().nonnegative(),
    title: z.string(),
  }),
  /** A note, or one block of it. */
  z.object({ kind: z.literal('note'), noteId: z.string(), blockId: z.string().nullable(), title: z.string() }),
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
export const ListArgs = z.object({ what: z.enum(['threads', 'sources', 'notes']) });

export type ToolName = 'search' | 'open' | 'list';

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
    description: 'List every thread, source or note in the notebook, newest first, labelled.',
    parameters: {
      type: 'object',
      properties: { what: { type: 'string', enum: ['threads', 'sources', 'notes'] } },
      required: ['what'],
      additionalProperties: false,
    },
  },
];

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
