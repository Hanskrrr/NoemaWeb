// The concept-reading skill (ADR 0037, replacing how ADR 0036 found concepts).
// Every material is read thoroughly, piece by piece: the model lists the
// concepts each piece discusses, with the exact words where it does. Mentions
// are joined across the notebook by name (and, for new names, by a judge), so
// one idea in a paper and in a thread is one concept. Each piece is hashed (by
// the server, from `pieceHashInput`): when a material changes, only pieces
// whose hash changed are read again.

import type { VaultTarget } from './assistant.ts';
import { quoteRange } from './assistant.ts';
import type { ChatMessage } from './context.ts';
import type { ItemText } from './gists.ts';
import type { LinkKind } from './links.ts';

/** The skill's version: part of every piece's hash, so new instructions make every piece readable again. */
export const SKILL_VERSION = 1;
/** How much of a material one call reads. */
export const PIECE_CHARS = 12_000;
/** A room shows at most this many concepts before the rest fold under "More ideas here". */
export const CONCEPTS_SHOWN = 12;
/** At most this many mentions from one piece, and places of one concept in it. */
export const MENTIONS_PER_PIECE = 10;
export const PLACES_PER_CONCEPT = 3;
/** Known concepts sent with each piece, so their names are reused. */
export const KNOWN_SENT = 120;
/** How concepts link: what comes first, what is part of what, what is another way. */
export const CONCEPT_LINK_KINDS: readonly LinkKind[] = ['builds-on', 'part-of', 'contrasts-with', 'example-of', 'explains'];

export const MENTION_ROLES = ['defines', 'explains', 'uses', 'example', 'asks'] as const;
export type MentionRole = (typeof MENTION_ROLES)[number];
/** Which mention defines a concept best: one that defines it, then one that explains it. */
export const ROLE_RANK: Record<MentionRole, number> = { defines: 0, explains: 1, example: 2, uses: 3, asks: 4 };

// Pieces ------------------------------------------------------------------------

export interface Piece {
  /** Where it is in the material's text (ItemText.text). */
  start: number;
  end: number;
  text: string;
}

/** What a piece's hash is taken of: the skill's version and its exact words. */
export const pieceHashInput = (text: string) => `noema-concept-reading/${SKILL_VERSION}\n${text}`;

type Span = { start: number; end: number };

/** A stretch cut at its blank lines, then, if one paragraph is still longer than `max`, at a space before `max`. */
function paragraphs(text: string, s: Span, max: number): Span[] {
  const out: Span[] = [];
  const re = /\n[ \t]*\n/g;
  re.lastIndex = s.start;
  let from = s.start;
  for (let m = re.exec(text); m && m.index < s.end; m = re.exec(text)) {
    out.push({ start: from, end: m.index });
    from = m.index + m[0].length;
  }
  out.push({ start: from, end: s.end });
  return out.flatMap((p) => {
    const parts: Span[] = [];
    let at = p.start;
    while (p.end - at > max) {
      const cut = text.lastIndexOf(' ', at + max);
      const end = cut > at + max / 2 ? cut : at + max;
      parts.push({ start: at, end });
      at = end;
    }
    parts.push({ start: at, end: p.end });
    return parts;
  });
}

/**
 * A material cut into pieces of at most `max` characters, the same way every time, so that a change touches as few
 * as possible. Threads and notes: their messages and blocks, in order, packed. Sources: cut where a heading starts
 * (a PDF's pages are headings), then packed. Something longer than `max` alone is cut at its paragraphs. Packing
 * from the start means a thread's new question only changes its last piece.
 */
export function piecesOf(item: ItemText, max = PIECE_CHARS): Piece[] {
  const text = item.text;
  let units: Span[];
  if (item.kind === 'source') {
    const heads: number[] = [0];
    const re = /^#{1,6}\s/gm;
    for (let m = re.exec(text); m; m = re.exec(text)) if (m.index > 0) heads.push(m.index);
    heads.push(text.length);
    units = heads.slice(0, -1).map((start, i) => ({ start, end: heads[i + 1] as number }));
  } else {
    units = item.segments.map((s) => ({ start: s.start, end: s.end }));
  }
  units = units.flatMap((u) => (u.end - u.start > max ? paragraphs(text, u, max) : [u])).filter((u) => text.slice(u.start, u.end).trim());
  const pieces: Piece[] = [];
  let start = -1;
  let end = -1;
  for (const u of units) {
    if (start >= 0 && u.end - start > max) {
      pieces.push({ start, end, text: text.slice(start, end) });
      start = -1;
    }
    if (start < 0) start = u.start;
    end = u.end;
  }
  if (start >= 0) pieces.push({ start, end, text: text.slice(start, end) });
  return pieces;
}

/** Where a place in a material's text is in Noema: the message, the block, or the source from an offset. */
export function targetAt(item: ItemText, at: number, quote: string): VaultTarget | null {
  const seg = item.segments.find((s) => at >= s.start && at < s.end);
  if (!seg) return null;
  const target: VaultTarget = { ...seg.target, quote };
  if (target.kind === 'source') return { ...target, at: (seg.target.kind === 'source' ? seg.target.at : 0) + (at - seg.start) };
  return target;
}

// Names ---------------------------------------------------------------------------

/**
 * A concept's name made plain, to find the same concept under small differences: case, spaces, hyphens, quotes,
 * a leading "the", plurals ("gradients" is "gradient"; "loss" and "analysis" stay).
 */
export function conceptKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’'"“”`´]/g, '')
    .replace(/[-_/·–—:,;.()[\]{}!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !/(ss|us|is|ics)$/.test(w) ? (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.slice(0, -1)) : w))
    .join(' ');
}

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';

function jsonIn(raw: string): unknown {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Reading a piece -----------------------------------------------------------------

export const CONCEPT_SKILL = [
  "You read one piece of a learner's study material: part of a source they read, a thread of questions they asked and the answers they got, or a note they wrote. List the concepts it discusses, with the exact words where it does.",
  '',
  'What a concept is: one idea a learner would name, look up and study on its own: a method, a mechanism, a principle, a trade-off, a phenomenon, a quantity, a named algorithm, model or system. "gradient checkpointing", "attention", "the vanishing gradient problem". Not the subject as a whole ("machine learning"), not a single fact or number, not a person, a course, a date, a page, or the material\'s own parts ("section 2", "the figure"). The test: could a learner write a paragraph defining it and give an example?',
  '',
  'Only what the piece discusses: it says something about the concept. A name in a list, or used in passing with nothing said of it, is not a mention.',
  '',
  'For each mention:',
  '- "name": its usual name in the field, in plain form: singular, lowercase except proper names and acronyms ("Adam", "ZeRO");',
  '- "also": other names this piece uses for it, such as an abbreviation;',
  '- "role": "defines" (says what it is), "explains" (how or why it works), "uses" (applies it, or relies on it), "example" (gives a case of it), "asks" (asks a question about it; in a thread, the learner\'s questions);',
  '- "quote": the words where it does that, copied exactly from the piece, one or two sentences, 6 to 40 words;',
  '- "says": what the piece says about it, in one short sentence of your own.',
  'A concept discussed in several places: each place, at most three. At most 10 mentions for a piece; none if it discusses no concept.',
  '',
  'Known concepts: the notebook already has the concepts listed with the piece. When the piece discusses one, use its name exactly, even if the piece calls it otherwise (put the piece\'s word in "also"). Never give a known concept a new name.',
  '',
  'Write names and sentences in the language of the piece. Never invent: everything must be in the piece. Reply with one JSON object and nothing else:',
  '{"mentions": [{"name": "...", "also": ["..."], "role": "defines", "quote": "...", "says": "..."}]}',
].join('\n');

const KIND_WORD: Record<ItemText['kind'], string> = { source: 'source', thread: 'thread of questions and answers', note: 'note' };

export function pieceRequest(
  material: { kind: ItemText['kind']; title: string },
  piece: string,
  at: { n: number; of: number },
  known: string[],
): ChatMessage[] {
  const names = known.slice(0, KNOWN_SENT).map((k) => `“${clean(k, 80)}”`);
  return [
    { role: 'system', content: CONCEPT_SKILL },
    {
      role: 'user',
      content: `A ${KIND_WORD[material.kind]}, “${clean(material.title, 160) || 'Untitled'}”${at.of > 1 ? `, piece ${at.n} of ${at.of}` : ''}:\n\n<<<\n${piece}\n>>>\n\nKnown concepts: ${names.length ? names.join(', ') : 'none yet'}.`,
    },
  ];
}

export interface MentionDraft {
  name: string;
  key: string;
  also: string[];
  role: MentionRole;
  /** The words, as they are in the piece, and where they start in it. */
  quote: string;
  offset: number;
  says: string;
}

/**
 * The mentions in the model's reply to a piece: only those whose quote is in the piece word for word (white space
 * aside), with a known role and a name; at most three places of one concept, ten in all; the same place once.
 * Null if the reply cannot be read.
 */
export function readMentions(raw: string, piece: string): MentionDraft[] | null {
  const parsed = jsonIn(raw) as { mentions?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.mentions)) return null;
  const out: MentionDraft[] = [];
  const places = new Map<string, number>();
  for (const m of parsed.mentions) {
    if (out.length >= MENTIONS_PER_PIECE) break;
    const x = m as { name?: unknown; also?: unknown; role?: unknown; quote?: unknown; says?: unknown };
    const name = clean(x?.name, 80);
    const key = conceptKey(name);
    const role = x?.role;
    if (!key || typeof role !== 'string' || !(MENTION_ROLES as readonly string[]).includes(role)) continue;
    const said = clean(x?.quote, 600);
    const found = said ? quoteRange(piece, said) : null;
    if (!found) continue;
    // A thread's lines start "Q: ", "A: ", "Side question: ": those words are the reading's, not the message's.
    const label = /^(?:Q|A|Side question): /.exec(piece.slice(found.start, found.end));
    const range = label && (found.start === 0 || piece[found.start - 1] === '\n') ? { start: found.start + label[0].length, end: found.end } : found;
    if (range.end - range.start < 2) continue;
    if ((places.get(key) ?? 0) >= PLACES_PER_CONCEPT) continue;
    if (out.some((o) => o.key === key && o.offset === range.start)) continue;
    places.set(key, (places.get(key) ?? 0) + 1);
    const also = [...new Set((Array.isArray(x?.also) ? x.also : []).map((a) => clean(a, 80)).filter((a) => a && conceptKey(a) !== key))].slice(0, 4);
    out.push({
      name,
      key,
      also,
      role: role as MentionRole,
      quote: piece.slice(range.start, range.end),
      offset: range.start,
      says: clean(x?.says, 240),
    });
  }
  return out;
}

// Joining new names -----------------------------------------------------------------

export const JOIN_PROMPT = [
  "You decide whether new concept names, found in a learner's materials, name concepts their notebook already has.",
  'Two names are the same concept when they name the same idea, worded otherwise ("activation checkpointing" and "gradient checkpointing", "SGD" and "stochastic gradient descent"). A part, a kind or an example of a concept is not the same concept ("Adam" is not "optimizer"). When unsure, it is new.',
  'For each new name, give the known name it is the same as, exactly as listed; or, if it is not known but is the same as another new name, that new name; or null. Reply with one JSON object and nothing else:',
  '{"same": {"<new name>": "<known name>" or null}}',
].join('\n');

export function joinRequest(fresh: string[], known: string[]): ChatMessage[] {
  return [
    { role: 'system', content: JOIN_PROMPT },
    {
      role: 'user',
      content: `Known concepts:\n${known.map((k) => `- ${clean(k, 80)}`).join('\n')}\n\nNew names:\n${fresh.map((f) => `- ${clean(f, 80)}`).join('\n')}`,
    },
  ];
}

/**
 * For each new name the model answered for: the known name it is the same as (as listed), or another new name it
 * is the same as (when it names no known one), or null. Null if the reply cannot be read.
 */
export function readJoin(raw: string, fresh: string[], known: string[]): Map<string, string | null> | null {
  const parsed = jsonIn(raw) as { same?: unknown } | null;
  if (!parsed || typeof parsed.same !== 'object' || parsed.same === null) return null;
  const byKey = new Map(known.map((k) => [conceptKey(k), k]));
  const freshByKey = new Map(fresh.map((f) => [conceptKey(f), f]));
  const out = new Map<string, string | null>();
  for (const [name, same] of Object.entries(parsed.same as Record<string, unknown>)) {
    const f = freshByKey.get(conceptKey(name));
    if (!f) continue;
    const key = typeof same === 'string' ? conceptKey(same) : '';
    const other = freshByKey.get(key);
    out.set(f, byKey.get(key) ?? (other && other !== f ? other : null));
  }
  return out;
}

// Which names are concepts --------------------------------------------------------------

/**
 * A name found in the materials becomes a suggested concept when a material defines or explains it, or two
 * materials discuss it. Used once in passing, it stays a passing idea until more materials bring it up.
 */
export function becomesConcept(mentions: ReadonlyArray<{ role: MentionRole; material: string }>): boolean {
  return mentions.some((m) => m.role === 'defines' || m.role === 'explains') || new Set(mentions.map((m) => m.material)).size >= 2;
}

/** The mention that defines a concept best: one that defines it, then explains it, …; the earliest made first. */
export function bestMention<T extends { role: MentionRole; at: string }>(mentions: readonly T[]): T | undefined {
  return [...mentions].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.at.localeCompare(b.at))[0];
}

/** The name most used among the mentions, as written the first time; ties to the earliest. */
export function commonName(mentions: ReadonlyArray<{ name: string }>): string {
  const count = new Map<string, number>();
  for (const m of mentions) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  let best = mentions[0]?.name ?? '';
  for (const [name, n] of count) if (n > (count.get(best) ?? 0)) best = name;
  return best;
}

// Links between concepts -----------------------------------------------------------------

export const CONCEPT_LINKS_PROMPT = [
  "You link the concepts of one subject in a learner's study notebook. You get them numbered, each with what the learner's materials say of it.",
  'Suggest the links a learner would want when studying, read from "from" to "to": builds-on (needs the other first), part-of (is a part of the other), contrasts-with (another way to the same end, or differs in a way worth noticing), example-of, explains. Only where the materials bear it out; fewer is better.',
  'Reply with one JSON object and nothing else: {"links": [{"from": 2, "to": 1, "kind": "builds-on", "why": "one short sentence"}]}',
].join('\n');

export const CONCEPT_LINKS_MAX = 20;

export function conceptLinksRequest(title: string, concepts: Array<{ name: string; says: string[] }>): ChatMessage[] {
  return [
    { role: 'system', content: CONCEPT_LINKS_PROMPT },
    {
      role: 'user',
      content: `The subject “${clean(title, 120) || 'Untitled'}”:\n${concepts
        .map((c, i) => `${i + 1}. ${clean(c.name, 80)}${c.says.length ? `: ${c.says.slice(0, 3).map((s) => clean(s, 200)).join(' ')}` : ''}`)
        .join('\n')}`,
    },
  ];
}

export interface ConceptLinkDraft {
  from: number;
  to: number;
  kind: LinkKind;
  why: string;
}

/** The links in the reply: between concepts given (1…n), of a kind concepts use, a pair once, none between two in `skip`. */
export function readConceptLinks(raw: string, n: number, skip: ReadonlySet<number> = new Set()): ConceptLinkDraft[] | null {
  const parsed = jsonIn(raw) as { links?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.links)) return null;
  const seen = new Set<string>();
  const out: ConceptLinkDraft[] = [];
  for (const l of parsed.links) {
    if (out.length >= CONCEPT_LINKS_MAX) break;
    const x = l as { from?: unknown; to?: unknown; kind?: unknown; why?: unknown };
    const from = Number(x?.from);
    const to = Number(x?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > n || to > n || from === to) continue;
    if (typeof x.kind !== 'string' || !(CONCEPT_LINK_KINDS as readonly string[]).includes(x.kind)) continue;
    if (skip.has(from) && skip.has(to)) continue;
    const pair = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({ from, to, kind: x.kind as LinkKind, why: clean(x.why, 240) });
  }
  return out;
}
