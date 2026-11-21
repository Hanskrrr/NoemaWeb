// The concept-reading skill (ADR 0037, replacing how ADR 0036 found concepts;
// ADR 0038 puts them in levels). The learner's threads and notes are read
// thoroughly, piece by piece: the model lists the concepts each piece
// discusses, with the exact words where it does, and what it is under when the
// piece says so. Mentions are joined across the notebook by name (and, for new
// names, by a judge). Each piece is hashed (by the server, from
// `pieceHashInput`): when a material changes, only pieces whose hash changed are
// read again. After reading, one step puts the room's concepts in order: topics,
// concepts, concepts inside concepts. Sources are not read: where a concept's
// words appear in them is found by text search (`wordsFound`).

import type { VaultTarget } from './assistant.ts';
import { quoteRange } from './assistant.ts';
import type { ChatMessage } from './context.ts';
import type { ItemText } from './gists.ts';
import type { LinkKind } from './links.ts';

/** The skill's version: part of every piece's hash, so new instructions make every piece readable again. */
export const SKILL_VERSION = 2;
/** How much of a material one call reads. */
export const PIECE_CHARS = 12_000;
/** A room shows at most this many concepts before the rest fold under "More ideas here". */
export const CONCEPTS_SHOWN = 12;
/** At most this many mentions from one piece, and places of one concept in it. */
export const MENTIONS_PER_PIECE = 10;
export const PLACES_PER_CONCEPT = 3;
/** Known concepts sent with each piece, so their names are reused. */
export const KNOWN_SENT = 120;
/** How concepts link: what comes first, what is another way, what explains what. (What is part of what is the tree.) */
export const CONCEPT_LINK_KINDS: readonly LinkKind[] = ['builds-on', 'contrasts-with', 'example-of', 'explains'];

/** How a concept is under another (ADR 0038): a kind of it, a part of it, or in a topic. */
export const CONCEPT_HOWS = ['kind-of', 'part-of', 'in'] as const;
export type ConceptHow = (typeof CONCEPT_HOWS)[number];
export const HOW_WORDS: Record<ConceptHow, string> = { 'kind-of': 'a kind of', 'part-of': 'a part of', in: 'in' };

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
  '- "under" and "how": only when the piece says the concept is a kind of, or a part of, another ("AdamW, a variant of Adam"): that concept\'s name in "under", and "kind-of" or "part-of" in "how". Otherwise leave them out.',
  'A concept discussed in several places: each place, at most three. At most 10 mentions for a piece; none if it discusses no concept.',
  '',
  'Details are not concepts. A value, a setting, a variant or a single fact about a concept ("β2 is usually 0.999", "stage 3 of ZeRO") is not a mention of its own: put it in what the piece says about that concept ("says"), with its words in "quote".',
  '',
  'Known concepts: the notebook already has the concepts listed with the piece, as a short tree (topics, the concepts in them, and concepts inside those). When the piece discusses one, use its name exactly, even if the piece calls it otherwise (put the piece\'s word in "also"). Never give a known concept a new name.',
  '',
  'Write names and sentences in the language of the piece. Never invent: everything must be in the piece. Reply with one JSON object and nothing else:',
  '{"mentions": [{"name": "...", "also": ["..."], "role": "defines", "quote": "...", "says": "...", "under": "...", "how": "kind-of"}]}',
].join('\n');

const KIND_WORD: Record<ItemText['kind'], string> = { source: 'source', thread: 'thread of questions and answers', note: 'note' };

/** A known concept, and the one it is under (its main home), if any. */
export interface KnownConcept {
  name: string;
  under?: string | null;
}

/**
 * The notebook's concepts as a short tree: each under the one it is in, indented; those under none at the top.
 * At most `max` names, the tops first, so the topics are always there.
 */
export function knownTree(known: readonly KnownConcept[], max = KNOWN_SENT): string {
  const byName = new Map(known.map((k) => [k.name, k]));
  const children = new Map<string, string[]>();
  const tops: string[] = [];
  for (const k of known) {
    const up = k.under && byName.has(k.under) && k.under !== k.name ? k.under : null;
    if (up) children.set(up, [...(children.get(up) ?? []), k.name]);
    else tops.push(k.name);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  // Breadth first, so a long branch does not crowd out the other tops.
  let level: Array<{ name: string; depth: number }> = tops.map((name) => ({ name, depth: 0 }));
  const placed = new Map<string, number>();
  const order: Array<{ name: string; depth: number }> = [];
  while (level.length > 0 && order.length < max) {
    const next: Array<{ name: string; depth: number }> = [];
    for (const n of level) {
      if (seen.has(n.name) || order.length >= max) continue;
      seen.add(n.name);
      order.push(n);
      for (const c of children.get(n.name) ?? []) next.push({ name: c, depth: n.depth + 1 });
    }
    level = next;
  }
  order.forEach((n, i) => placed.set(n.name, i));
  const write = (name: string, depth: number) => {
    if (!placed.has(name)) return;
    lines.push(`${'  '.repeat(depth)}- ${clean(name, 80)}`);
    for (const c of children.get(name) ?? []) write(c, depth + 1);
  };
  for (const t of tops) write(t, 0);
  return lines.join('\n');
}

export function pieceRequest(
  material: { kind: ItemText['kind']; title: string },
  piece: string,
  at: { n: number; of: number },
  known: readonly KnownConcept[],
): ChatMessage[] {
  const tree = knownTree(known);
  return [
    { role: 'system', content: CONCEPT_SKILL },
    {
      role: 'user',
      content: `A ${KIND_WORD[material.kind]}, “${clean(material.title, 160) || 'Untitled'}”${at.of > 1 ? `, piece ${at.n} of ${at.of}` : ''}:\n\n<<<\n${piece}\n>>>\n\nKnown concepts: ${tree ? `\n${tree}` : 'none yet.'}`,
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
  /** What the piece says it is a kind or a part of, if it says so. */
  under: string | null;
  how: Exclude<ConceptHow, 'in'> | null;
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
    const x = m as { name?: unknown; also?: unknown; role?: unknown; quote?: unknown; says?: unknown; under?: unknown; how?: unknown };
    const name = clean(x?.name, 80);
    const key = conceptKey(name);
    const role = x?.role;
    if (!key || typeof role !== 'string' || !(MENTION_ROLES as readonly string[]).includes(role)) continue;
    const said = clean(x?.quote, 600);
    const found = said ? quoteRange(piece, said) : null;
    if (!found) continue;
    // A thread's lines start "Q: ", "A: ", "Side question: ": those words are the reading's, not the message's.
    const label = /^(?:Q|A|Side question|About this passage of “[^”\n]*”): /.exec(piece.slice(found.start, found.end));
    const range = label && (found.start === 0 || piece[found.start - 1] === '\n') ? { start: found.start + label[0].length, end: found.end } : found;
    if (range.end - range.start < 2) continue;
    if ((places.get(key) ?? 0) >= PLACES_PER_CONCEPT) continue;
    if (out.some((o) => o.key === key && o.offset === range.start)) continue;
    places.set(key, (places.get(key) ?? 0) + 1);
    const also = [...new Set((Array.isArray(x?.also) ? x.also : []).map((a) => clean(a, 80)).filter((a) => a && conceptKey(a) !== key))].slice(0, 4);
    const under = clean(x?.under, 80);
    const how = x?.how === 'kind-of' || x?.how === 'part-of' ? x.how : null;
    const hasUnder = Boolean(under && how && conceptKey(under) && conceptKey(under) !== key);
    out.push({
      name,
      key,
      also,
      role: role as MentionRole,
      quote: piece.slice(range.start, range.end),
      offset: range.start,
      says: clean(x?.says, 240),
      under: hasUnder ? under : null,
      how: hasUnder ? how : null,
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
  'Suggest the links a learner would want when studying, read from "from" to "to": builds-on (needs the other first), contrasts-with (another way to the same end, or differs in a way worth noticing), example-of, explains. Not what is a kind or a part of what: that is known already. Only where the materials bear it out; fewer is better.',
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

// Putting a room in order (ADR 0038) -------------------------------------------------------

/** A room has at most this many topics, each holding at least two concepts, at most three levels under it. */
export const TOPICS_MIN = 3;
export const TOPICS_MAX = 9;
export const LEVELS_UNDER_TOPIC = 3;
/** The concepts sent to be put in order at once. */
export const ORDER_MAX = 120;

export const ORDER_PROMPT = [
  "You put the concepts of one room of a learner's study notebook in order, so the room can be read from far to near: a few topics, the concepts in them, and concepts inside concepts.",
  'You get the room\'s concepts, numbered, each with what the learner\'s materials say of it, in how many materials it is, and how much the learner worked on it. Some already have a place ("in …"): those stay where they are. You also get the topics the notebook has.',
  'For each concept without a place, say what it goes under:',
  '- a concept of the list, when it is a kind of it ("kind-of": AdamW under Adam) or a part of it ("part-of": the encoder under the transformer);',
  '- else a topic ("in"): a broad area of the room, such as "Optimization" or "Training memory". Use a topic the notebook has when one fits; a new topic needs a name of one to three words and one sentence on what it covers.',
  `Rules: ${TOPICS_MIN} to ${TOPICS_MAX} topics in a room (fewer when there are few concepts), each holding at least two concepts; at most ${LEVELS_UNDER_TOPIC} levels under a topic; a concept goes under the most specific concept that holds it; a topic is not a concept of the list renamed. With fewer than four concepts, no topics: only kind-of and part-of where they are true.`,
  'Reply with one JSON object and nothing else:',
  '{"topics": [{"name": "Optimization", "says": "How the weights are updated from the gradients."}], "places": [{"n": 3, "under": "Optimization", "how": "in"}, {"n": 5, "under": "Adam", "how": "kind-of"}]}',
].join('\n');

export interface OrderConcept {
  name: string;
  says: string[];
  materials: number;
  work: number;
  /** The concept or topic it is under already, if any: it stays there. */
  home: string | null;
}

export function orderRequest(room: { title: string }, concepts: readonly OrderConcept[], topics: readonly string[]): ChatMessage[] {
  const list = concepts
    .slice(0, ORDER_MAX)
    .map(
      (c, i) =>
        `${i + 1}. ${clean(c.name, 80)}${c.says.length ? `: ${c.says.slice(0, 2).map((s) => clean(s, 160)).join(' ')}` : ''} · ${c.materials} material${c.materials === 1 ? '' : 's'} · work ${c.work}${c.home ? ` · in ${clean(c.home, 80)}` : ''}`,
    )
    .join('\n');
  return [
    { role: 'system', content: ORDER_PROMPT },
    {
      role: 'user',
      content: `The room “${clean(room.title, 120) || 'Untitled'}”. Its concepts:\n${list}\n\nTopics the notebook has: ${topics.length ? topics.map((t) => `“${clean(t, 80)}”`).join(', ') : 'none yet'}.`,
    },
  ];
}

export interface OrderPlace {
  /** The concept (1…n) placed. */
  n: number;
  /** Where: a concept of the list (by number), or a topic (by name, known or new). */
  under: { concept: number } | { topic: string };
  how: ConceptHow;
}

export interface OrderReply {
  topics: Array<{ name: string; says: string }>;
  places: OrderPlace[];
}

/**
 * The order in the reply. A place is kept when its concept is one of the list without a place yet, and what it goes
 * under is another concept of the list (kind-of, part-of) or a topic, known or new (in). A topic named like a concept
 * of the list is that concept. No concept under itself, or under one of its own: such places are dropped. Null if
 * the reply cannot be read.
 */
export function readOrder(raw: string, concepts: readonly OrderConcept[], known: readonly string[]): OrderReply | null {
  const parsed = jsonIn(raw) as { topics?: unknown; places?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.places)) return null;
  const n = Math.min(concepts.length, ORDER_MAX);
  const byKey = new Map(concepts.slice(0, n).map((c, i) => [conceptKey(c.name), i + 1]));
  const knownByKey = new Map(known.map((k) => [conceptKey(k), k]));
  const topics = new Map<string, { name: string; says: string }>();
  for (const t of Array.isArray(parsed.topics) ? parsed.topics : []) {
    const x = t as { name?: unknown; says?: unknown };
    const name = clean(x?.name, 60);
    const key = conceptKey(name);
    if (!key || byKey.has(key) || topics.has(key)) continue;
    topics.set(key, { name: knownByKey.get(key) ?? name, says: clean(x?.says, 200) });
  }
  // Where each concept is already, and where the reply puts it: to refuse a place that would go round in a circle.
  const up = new Map<number, number>();
  concepts.slice(0, n).forEach((c, i) => {
    const at = c.home ? byKey.get(conceptKey(c.home)) : undefined;
    if (at) up.set(i + 1, at);
  });
  const circles = (from: number, to: number) => {
    for (let at: number | undefined = to, steps = 0; at !== undefined && steps <= n; at = up.get(at), steps++) if (at === from) return true;
    return false;
  };
  const places: OrderPlace[] = [];
  const placed = new Set<number>();
  for (const p of parsed.places) {
    const x = p as { n?: unknown; under?: unknown; how?: unknown };
    const i = Number(x?.n);
    if (!Number.isInteger(i) || i < 1 || i > n || placed.has(i) || concepts[i - 1]?.home) continue;
    const under = clean(typeof x?.under === 'number' ? String(x.under) : x?.under, 80);
    const asNumber = /^\d+$/.test(under) ? Number(under) : 0;
    const key = conceptKey(under);
    const concept = asNumber >= 1 && asNumber <= n ? asNumber : byKey.get(key);
    if (concept !== undefined) {
      const how = x?.how === 'part-of' ? 'part-of' : 'kind-of';
      if (concept === i || circles(i, concept)) continue;
      places.push({ n: i, under: { concept }, how });
      up.set(i, concept);
      placed.add(i);
      continue;
    }
    if (!key) continue;
    const topic = topics.get(key) ?? (knownByKey.has(key) ? { name: knownByKey.get(key) as string, says: '' } : null);
    if (!topic) continue;
    if (!topics.has(key)) topics.set(key, topic);
    places.push({ n: i, under: { topic: topic.name }, how: 'in' });
    placed.add(i);
  }
  // A new topic nothing was put in is not made.
  const used = new Set(places.flatMap((p) => ('topic' in p.under ? [conceptKey(p.under.topic)] : [])));
  return { topics: [...topics.entries()].filter(([k]) => used.has(k)).map(([, t]) => t), places };
}

// A concept's scope, and finding what belongs in it (ADR 0038) --------------------------------

export const SCOPE_PROMPT = [
  "You write what one concept of a learner's study notebook covers, in one sentence of at most 25 words, for the learner and for finding what belongs in it.",
  'Name what it includes, with two or three examples when it is broad ("Methods that update a model\'s weights from its gradients: SGD, momentum, Adam."). Plain words, in the language of the concept\'s name. Reply with the sentence only.',
].join('\n');

export function scopeRequest(concept: { name: string; also: string[]; says: string[] }): ChatMessage[] {
  return [
    { role: 'system', content: SCOPE_PROMPT },
    {
      role: 'user',
      content: `The concept “${clean(concept.name, 80)}”${concept.also.length ? `, also called ${concept.also.map((a) => `“${clean(a, 60)}”`).join(', ')}` : ''}.${
        concept.says.length ? `\nWhat the learner's materials say of it:\n${concept.says.slice(0, 5).map((s) => `- ${clean(s, 200)}`).join('\n')}` : ''
      }`,
    },
  ];
}

/** The sentence in the reply, plain: no quotes around it, one line. Empty if there is none. */
export function readScope(raw: string): string {
  return clean(raw.replace(/^["“'`\s]+|["”'`\s]+$/g, ''), 240);
}

/** At most this many candidates are judged when a concept is filled. */
export const FIND_CONCEPTS_MAX = 60;
export const FIND_MATERIALS_MAX = 40;

export const FIND_PROMPT = [
  "You decide what belongs in one concept of a learner's study notebook. You get the concept, what it covers, and candidates: other concepts of the notebook (numbered C1, C2, …), and materials (threads of questions, notes, sources; numbered M1, M2, …) with the words of them that may speak of it.",
  '- A concept belongs inside it when it is a kind of it, or a part of it ("Adam" inside "Optimizers"). Not when it is only related, and never the concept itself under another name.',
  '- A material belongs in it when its words discuss the concept, not when they only name it in passing. Give the words that show it, copied exactly from what you were given (6 to 40 words), and one short sentence of what they say of it.',
  'When unsure, leave it out. Reply with one JSON object and nothing else:',
  '{"inside": [{"c": 2, "how": "kind-of"}], "materials": [{"m": 3, "quote": "...", "says": "..."}]}',
].join('\n');

export interface FindMaterial {
  kind: ItemText['kind'];
  title: string;
  /** Stretches of its text that may speak of the concept. */
  snippets: string[];
}

export function findRequest(
  concept: { name: string; also: string[]; scope: string },
  concepts: ReadonlyArray<{ name: string; says: string[] }>,
  materials: readonly FindMaterial[],
): ChatMessage[] {
  const cs = concepts
    .slice(0, FIND_CONCEPTS_MAX)
    .map((c, i) => `C${i + 1}. ${clean(c.name, 80)}${c.says.length ? `: ${c.says.slice(0, 2).map((s) => clean(s, 160)).join(' ')}` : ''}`)
    .join('\n');
  const ms = materials
    .slice(0, FIND_MATERIALS_MAX)
    .map((m, i) => `M${i + 1}. A ${KIND_WORD[m.kind]}, “${clean(m.title, 120) || 'Untitled'}”:\n${m.snippets.map((s) => `<<<\n${s}\n>>>`).join('\n')}`)
    .join('\n\n');
  return [
    { role: 'system', content: FIND_PROMPT },
    {
      role: 'user',
      content: `The concept “${clean(concept.name, 80)}”${concept.also.length ? ` (also ${concept.also.map((a) => `“${clean(a, 60)}”`).join(', ')})` : ''}. It covers: ${clean(concept.scope, 240) || 'what its name says'}\n\nConcepts:\n${cs || 'none'}\n\nMaterials:\n${ms || 'none'}`,
    },
  ];
}

export interface FoundDraft {
  inside: Array<{ c: number; how: Exclude<ConceptHow, 'in'> }>;
  /** Each material found (1…n), its words in the snippet they are in, and what they say. */
  materials: Array<{ m: number; snippet: number; start: number; end: number; quote: string; says: string }>;
}

/** What the reply found: concepts given (C1…), materials given (M1…) whose quote is in one of their snippets word for word; each once. */
export function readFind(raw: string, concepts: number, materials: readonly FindMaterial[]): FoundDraft | null {
  const parsed = jsonIn(raw) as { inside?: unknown; materials?: unknown } | null;
  if (!parsed) return null;
  const num = (v: unknown, letter: string) => {
    const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(new RegExp(`^${letter}`, 'i'), '') : '';
    return /^\d+$/.test(t) ? Number(t) : 0;
  };
  const inside: FoundDraft['inside'] = [];
  for (const x of Array.isArray(parsed.inside) ? parsed.inside : []) {
    const o = x as { c?: unknown; how?: unknown };
    const c = num(typeof x === 'object' && x !== null ? o.c : x, 'C');
    if (c < 1 || c > Math.min(concepts, FIND_CONCEPTS_MAX) || inside.some((i) => i.c === c)) continue;
    inside.push({ c, how: o?.how === 'part-of' ? 'part-of' : 'kind-of' });
  }
  const found: FoundDraft['materials'] = [];
  const n = Math.min(materials.length, FIND_MATERIALS_MAX);
  for (const x of Array.isArray(parsed.materials) ? parsed.materials : []) {
    const o = x as { m?: unknown; quote?: unknown; says?: unknown };
    const m = num(o?.m, 'M');
    if (m < 1 || m > n || found.some((f) => f.m === m)) continue;
    const said = clean(o?.quote, 600);
    if (!said) continue;
    const snippets = materials[m - 1]?.snippets ?? [];
    for (let i = 0; i < snippets.length; i++) {
      const r = quoteRange(snippets[i] as string, said);
      if (!r) continue;
      found.push({ m, snippet: i, start: r.start, end: r.end, quote: (snippets[i] as string).slice(r.start, r.end), says: clean(o?.says, 240) });
      break;
    }
  }
  return { inside, materials: found };
}

// Words found in sources (ADR 0038) -------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a concept's names appear in a text, by plain search: each name whole (not inside a longer word), any case,
 * a plural "s" allowed; at most `max`, in order. Names shorter than two letters are not searched.
 */
export function wordsFound(text: string, names: readonly string[], max = 500): Array<{ start: number; end: number }> {
  const terms = [...new Set(names.map((n) => n.normalize('NFKC').trim()).filter((n) => Array.from(n).length >= 2))];
  if (terms.length === 0) return [];
  // Longest first, so "gradient checkpointing" wins over "gradient".
  terms.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map((t) => escapeRe(t).replace(/\s+/g, '\\s+')).join('|')})(?:e?s)?(?![\\p{L}\\p{N}])`, 'giu');
  const out: Array<{ start: number; end: number }> = [];
  for (let m = re.exec(text); m && out.length < max; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** Where each page of a PDF's text starts ("## Page 12"), in order: for `pageAt`. Empty for a text without pages. */
export function pagesOf(text: string): Array<{ at: number; page: number }> {
  const out: Array<{ at: number; page: number }> = [];
  const re = /^#{1,6}\s+Page\s+(\d+)\s*$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ at: m.index, page: Number(m[1]) });
  return out;
}

/** The page an offset is on, from `pagesOf`; null before the first page, or without pages. */
export function pageAt(pages: ReadonlyArray<{ at: number; page: number }>, at: number): number | null {
  let lo = 0;
  let hi = pages.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid] as { at: number; page: number };
    if (p.at <= at) {
      found = p.page;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// The learner's work on a concept (ADR 0038) ------------------------------------------------------

export interface ConceptWork {
  /** Its places where the learner asked about it. */
  questions: number;
  /** The notes that discuss it. */
  notes: number;
  /** The materials it is in. */
  materials: number;
}

/** What a concept's size on the map is from: a question counts three, a note two, every material one. */
export const workWeight = (w: ConceptWork) => 3 * w.questions + 2 * w.notes + w.materials;
