// Concepts (ADR 0036): when a room is read, the AI proposes the key ideas its
// things are about. A concept is a small room inside the room, with a name, a
// one-line definition, the words of the learner's own thing that define it
// (one of its summary's points, so it opens where they are), and the things
// about it. Concepts are linked by what builds on what. The learner keeps them
// (all at once, or one by one), renames, merges, splits or dismisses them.

import type { ChatMessage } from './context.ts';
import type { LinkKind } from './links.ts';

/** A thing of the room as the AI reads it for its concepts: its summary and its key points. */
export interface ConceptCandidate {
  kind: 'source' | 'thread' | 'note';
  title: string;
  gist: string;
  points: string[];
}
/** A concept the learner kept: the AI may put more things in it, but does not propose it again. */
export interface KeptConcept {
  name: string;
  definition: string;
  /** Its things, by their numbers in the list. */
  things: number[];
}
export interface ConceptDraft {
  name: string;
  definition: string;
  /** The key point that defines it: its thing's number and the point's place (0 for "a"). */
  definedBy: { thing: number; point: number } | null;
  things: number[];
}
export interface ConceptLinkDraft {
  /** Concepts by number: the kept ones first (1…K), then the new ones in the order given. */
  from: number;
  to: number;
  kind: LinkKind;
  why: string;
}
export interface ConceptsDraft {
  concepts: ConceptDraft[];
  links: ConceptLinkDraft[];
  /** Things put in concepts the learner kept. */
  place: Array<{ thing: number; concept: number }>;
}

/** At most this many concepts in a room, kept and new: a map stays readable only when small. */
export const CONCEPTS_MAX = 12;
/** A room needs at least this many things with a summary for its concepts to be worth finding. */
export const CONCEPTS_MIN_THINGS = 3;
/** How concepts link: what comes first, what is part of what, what is another way. */
export const CONCEPT_LINK_KINDS: readonly LinkKind[] = ['builds-on', 'part-of', 'contrasts-with', 'example-of', 'explains'];

export const CONCEPTS_PROMPT = [
  "You find the concepts of one room in a learner's study notebook: the key ideas that what they read, asked and wrote there is about. You get the things numbered, each with a short summary and its key points, lettered.",
  "A concept is one idea a learner would name and look up, between a single fact and the whole subject: \"gradient checkpointing\", not \"memory\", and not \"slide 3\". Never one concept for each thing.",
  'For each concept give:',
  '- "name": 1 to 5 words, as the learner would say it;',
  '- "definition": one plain sentence;',
  '- "defined_by": the key point that defines it best, as its thing\'s number and letter ("3b"), or null if none does;',
  '- "things": the numbers of the things about it. A thing can be about two concepts; leave out things about none.',
  'Then the links between concepts, read from "from" to "to": builds-on (needs the other first), part-of (is a part of the other), contrasts-with (another way to the same end, or differs in a way worth noticing), example-of, explains.',
  'If the learner kept concepts, they are numbered first; do not give them again, but put in "place" the things that belong to them and are not in them yet. New concepts are numbered after them, in the order you give them.',
  'Write in the language of the things. Never invent. Reply with one JSON object and nothing else:',
  '{"concepts": [{"name": "...", "definition": "...", "defined_by": "3b", "things": [3, 5]}], "links": [{"from": 2, "to": 1, "kind": "builds-on", "why": "one short sentence"}], "place": [{"thing": 4, "concept": 1}]}',
].join('\n');

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';
const LETTERS = 'abcdefghij';

export function conceptsRequest(
  title: string,
  things: ConceptCandidate[],
  kept: KeptConcept[],
  dismissed: string[],
  most: number,
): ChatMessage[] {
  const list = things
    .map((x, i) => {
      const points = x.points.slice(0, LETTERS.length).map((p, j) => `   ${LETTERS[j]}) ${clean(p, 160)}`);
      return [`${i + 1}. ${x.kind} “${clean(x.title, 120) || 'Untitled'}”: ${clean(x.gist, 400)}`, ...points].join('\n');
    })
    .join('\n');
  const keptPart = kept.length
    ? `\n\nConcepts the learner kept:\n${kept
        .map((c, i) => `[${i + 1}] “${clean(c.name, 80)}”: ${clean(c.definition, 200)}${c.things.length ? ` (things ${c.things.join(', ')})` : ''}`)
        .join('\n')}`
    : '';
  const notThese = dismissed.length ? `\n\nNot these, the learner dismissed them: ${dismissed.map((d) => `“${clean(d, 80)}”`).join(', ')}.` : '';
  return [
    { role: 'system', content: CONCEPTS_PROMPT },
    {
      role: 'user',
      content: `The room “${clean(title, 120) || 'Untitled'}”:\n${list}${keptPart}${notThese}\n\nGive at most ${most} new concepts${most === 0 ? ' (none: only place things in the kept ones)' : ''}.`,
    },
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
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * The concepts in the model's reply. Things are numbers in the list; a point is one its thing has; a concept with
 * no things, or with a name already used (kept, dismissed or given before), is left out, and so are links to it;
 * at most `most` new ones. Null if the reply cannot be read.
 */
export function readConcepts(
  raw: string,
  opts: { things: number; points: number[]; kept: string[]; dismissed: string[]; most: number },
): ConceptsDraft | null {
  const parsed = jsonIn(raw) as { concepts?: unknown; links?: unknown; place?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.concepts)) return null;
  const K = opts.kept.length;
  const used = new Set([...opts.kept, ...opts.dismissed].map((n) => n.toLowerCase()));
  const concepts: ConceptDraft[] = [];
  // The model's numbers for its concepts (K+1…), to ours after some are left out.
  const renumber = new Map<number, number>();
  for (let i = 1; i <= K; i++) renumber.set(i, i);
  parsed.concepts.forEach((c, i) => {
    if (concepts.length >= opts.most) return;
    const name = clean((c as { name?: unknown })?.name, 80);
    if (!name || used.has(name.toLowerCase())) return;
    const raw = (c as { things?: unknown })?.things;
    const things = [...new Set((Array.isArray(raw) ? raw : []).map(int).filter((n): n is number => n !== null && n >= 1 && n <= opts.things))];
    if (things.length === 0) return;
    const by = /^\s*(\d+)\s*([a-j])\s*$/i.exec(String((c as { defined_by?: unknown })?.defined_by ?? ''));
    let definedBy: ConceptDraft['definedBy'] = null;
    if (by) {
      const thing = Number(by[1]);
      const point = LETTERS.indexOf((by[2] as string).toLowerCase());
      if (thing >= 1 && thing <= opts.things && point < (opts.points[thing - 1] ?? 0)) definedBy = { thing, point };
    }
    used.add(name.toLowerCase());
    concepts.push({ name, definition: clean((c as { definition?: unknown })?.definition, 240), definedBy, things });
    renumber.set(K + i + 1, K + concepts.length);
  });
  const total = K + concepts.length;
  const seen = new Set<string>();
  const links: ConceptLinkDraft[] = [];
  for (const l of Array.isArray(parsed.links) ? parsed.links : []) {
    const from = renumber.get(int((l as { from?: unknown })?.from) ?? -1);
    const to = renumber.get(int((l as { to?: unknown })?.to) ?? -1);
    const kind = (l as { kind?: unknown })?.kind;
    if (!from || !to || from === to || from > total || to > total) continue;
    if (typeof kind !== 'string' || !(CONCEPT_LINK_KINDS as readonly string[]).includes(kind)) continue;
    // Between two kept concepts, the learner links them: the AI does not.
    if (from <= K && to <= K) continue;
    const pair = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    links.push({ from, to, kind: kind as LinkKind, why: clean((l as { why?: unknown }).why, 240) });
  }
  const place: ConceptsDraft['place'] = [];
  for (const p of Array.isArray(parsed.place) ? parsed.place : []) {
    const thing = int((p as { thing?: unknown })?.thing);
    const concept = int((p as { concept?: unknown })?.concept);
    if (thing === null || concept === null || thing < 1 || thing > opts.things || concept < 1 || concept > K) continue;
    if (place.some((x) => x.thing === thing && x.concept === concept)) continue;
    place.push({ thing, concept });
  }
  return { concepts, links, place };
}
