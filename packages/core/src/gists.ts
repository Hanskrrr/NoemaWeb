// Reading a room (ADR 0027): the AI writes each thing in it a short summary
// whose key points link to the exact words they came from, then suggests
// links between the things, each with a kind and a reason. Summaries and
// suggested links are the AI's; the learner accepts, edits or dismisses
// links, and draws their own.

import type { ChatMessage } from './context.ts';
import type { VaultTarget } from './assistant.ts';
import { findQuote } from './assistant.ts';
import { LINK_KINDS, type LinkKind } from './links.ts';

/** The words of one thing, as the AI reads it, and where each stretch of them is in Noema. */
export interface ItemText {
  kind: 'source' | 'thread' | 'note';
  title: string;
  text: string;
  /** Stretches of `text` and what they are (a message, a block, the source from an offset). */
  segments: Array<{ start: number; end: number; target: VaultTarget }>;
}

export interface GistPoint {
  text: string;
  /** Where its quote is in the original; null if the quote was not found there. */
  target: VaultTarget | null;
}
export interface GistDraft {
  text: string;
  points: GistPoint[];
}

/** How much of a thing the AI reads for its summary. */
export const GIST_CHARS = 14_000;

export const GIST_PROMPT = [
  "You summarize one thing in a learner's study notebook, for the map of a subject they are learning: a source they read, a conversation they had with an AI (their questions and the answers), or a note.",
  'Write in the language of the thing. Plain text, no Markdown.',
  'Reply with one JSON object and nothing else:',
  '{"gist": "one or two sentences: what it is about and what it says or settles. For a conversation: what the learner asked and what they found out, and what stayed unclear if anything.",',
  ' "points": [{"point": "a key idea, a few words", "quote": "words copied exactly from the text, 4 to 25 words, where that idea is"}]}',
  'Give at most 3 points. Never invent; a quote must be in the text word for word.',
].join('\n');

const KIND_WORDS: Record<ItemText['kind'], string> = {
  source: 'A source the learner read',
  thread: 'A conversation: the learner asked, the AI answered',
  note: 'A note',
};

export function gistRequest(item: ItemText): ChatMessage[] {
  const text = item.text.length > GIST_CHARS ? `${item.text.slice(0, GIST_CHARS)}\n[… the rest is not shown]` : item.text;
  return [
    { role: 'system', content: GIST_PROMPT },
    { role: 'user', content: `${KIND_WORDS[item.kind]}: “${item.title || 'Untitled'}”\n\n<<<TEXT>>>\n${text}\n<<<END>>>` },
  ];
}

function jsonIn(raw: string): unknown {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';

/** The summary in the model's reply, its quotes found in the original; null if it cannot be read. */
export function readGist(raw: string, item: ItemText): GistDraft | null {
  const parsed = jsonIn(raw) as { gist?: unknown; points?: unknown } | null;
  if (!parsed) return null;
  const text = clean(parsed.gist, 600);
  if (!text) return null;
  const points: GistPoint[] = [];
  for (const p of Array.isArray(parsed.points) ? parsed.points.slice(0, 3) : []) {
    const point = clean((p as { point?: unknown })?.point, 160);
    if (!point) continue;
    const quote = clean((p as { quote?: unknown })?.quote, 400);
    const at = quote ? findQuote(item.text, quote) : -1;
    const seg = at >= 0 ? item.segments.find((s) => at >= s.start && at < s.end) : undefined;
    let target: VaultTarget | null = null;
    if (seg) {
      target = { ...seg.target, quote };
      // In a source, the place is the quote itself.
      if (target.kind === 'source') target = { ...target, at: (seg.target.kind === 'source' ? seg.target.at : 0) + (at - seg.start) };
    }
    points.push({ text: point, target });
  }
  return { text, points };
}

export interface LinkCandidate {
  kind: 'source' | 'thread' | 'note';
  title: string;
  gist: string;
}
export interface LinkDraft {
  from: number;
  to: number;
  kind: LinkKind;
  why: string;
}

export const LINKS_PROMPT = [
  "You help a learner see how the things in one subject of their study notebook connect. You get them numbered, each with a short summary.",
  'Suggest links where one thing really bears on another, the ones a learner would want when reviewing. Kinds, read from "from" to "to":',
  '- explains: makes the other understandable',
  '- example-of: is a case or an example of the other',
  '- builds-on: needs the other first, or takes it further',
  '- contrasts-with: differs from the other in a way worth noticing',
  '- same-question: asks the same question as the other',
  '- part-of: is a part of the other',
  '- related: bears on the other in some other way (use rarely)',
  'Do not link things only because they share a broad topic. Leave out pairs already linked.',
  'Reply with one JSON object and nothing else: {"links": [{"from": n, "to": n, "kind": "...", "why": "one short sentence"}]}',
].join('\n');

/** At most this many things are read for links at once. */
export const LINKS_MAX_ITEMS = 60;

export function linksRequest(items: LinkCandidate[], linked: Array<[number, number]>): ChatMessage[] {
  const list = items.map((x, i) => `${i + 1}. ${x.kind} “${clean(x.title, 120) || 'Untitled'}”: ${clean(x.gist, 400)}`).join('\n');
  const already = linked.length ? `\n\nAlready linked: ${linked.map(([a, b]) => `${a}–${b}`).join(', ')}.` : '';
  const most = Math.min(20, Math.max(2, Math.round(items.length * 1.5)));
  return [
    { role: 'system', content: LINKS_PROMPT },
    { role: 'user', content: `The things:\n${list}${already}\n\nSuggest at most ${most} links.` },
  ];
}

/** Links in the model's reply: numbers in the list, a kind it knows, each pair once; null if it cannot be read. */
export function readLinks(raw: string, count: number): LinkDraft[] | null {
  const parsed = jsonIn(raw) as { links?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.links)) return null;
  const seen = new Set<string>();
  const out: LinkDraft[] = [];
  for (const l of parsed.links) {
    const from = Number((l as { from?: unknown })?.from);
    const to = Number((l as { to?: unknown })?.to);
    const kind = (l as { kind?: unknown })?.kind;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) continue;
    if (from < 1 || to < 1 || from > count || to > count) continue;
    if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) continue;
    const pair = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({ from, to, kind: kind as LinkKind, why: clean((l as { why?: unknown }).why, 240) });
  }
  return out;
}
