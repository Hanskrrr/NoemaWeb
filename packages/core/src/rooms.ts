// Rooms (ADR 0026): what is learnt about one subject, set together whatever
// kind it is. A room holds what was put in it, and what comes with that: a
// source brings the threads asked about it and the notes made from them; a
// thread brings its notes. Things that belong together form one cluster on
// the room's map; lines join clusters only where something links them, and
// each line says how.

/** What can be put in a room. A side question goes in as the thread it is part of. */
export type RoomKind = 'thread' | 'source' | 'note';

/** "kind:id", the key of a thing in a room. */
export type RoomKey = `${RoomKind}:${string}`;
export const roomKey = (kind: RoomKind, id: string): RoomKey => `${kind}:${id}`;
export function parseRoomKey(key: string): { kind: RoomKind; id: string } | null {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  if (kind !== 'thread' && kind !== 'source' && kind !== 'note') return null;
  return { kind, id: key.slice(at + 1) };
}

/** A row of the room: put in by hand ('in'), come with something but taken out ('out'), or only where it sits ('placed'). */
export interface RoomRow {
  kind: RoomKind;
  id: string;
  state: 'in' | 'out' | 'placed';
  x: number | null;
  y: number | null;
  at: string;
}

/** What Noema knows about the notebook, enough to draw a room. */
export interface RoomGraph {
  threads: Array<{
    id: string;
    title: string;
    parentThreadId: string | null;
    splitAt: string | null;
    continuedFromId: string | null;
    mergedIntoId: string | null;
    sourceId: string | null;
    sourceQuote: string | null;
    updatedAt: string;
    /** Questions asked in this thread (not its side questions). */
    questions: number;
    /** A side question not come back from. */
    open: boolean;
  }>;
  sources: Array<{ id: string; title: string; updatedAt: string; linked: boolean }>;
  notes: Array<{ id: string; title: string; threadId: string | null; cites: string[]; blocks: number; updatedAt: string }>;
  /** A passage of a source kept in view in a thread. */
  pins: Array<{ threadId: string; sourceId: string }>;
}

/** What a card says about what was done there. */
export interface RoomMarks {
  /** Questions asked: in a thread and its side questions; for a source, in every thread about it. */
  questions: number;
  /** Side questions asked. */
  sides: number;
  /** Side questions not come back from. */
  open: number;
  /** For a source: the threads about it. */
  threads: number;
  /** For a note: its blocks. */
  blocks: number;
  /** Last change. */
  at: string;
}

export interface RoomCard {
  kind: RoomKind;
  id: string;
  title: string;
  /** Put in by hand; otherwise it came with `via`. */
  explicit: boolean;
  via: RoomKey | null;
  marks: RoomMarks;
  /** For a thread asked about a passage: the passage, shortened. */
  quote: string | null;
  /** For a source: a file of a linked folder. */
  file: boolean;
}

export interface RoomCluster {
  /** The key of its first card. */
  key: RoomKey;
  /** Where it sits; null until placed. */
  x: number | null;
  y: number | null;
  /** The source, thread or note it is about first, then the rest. */
  cards: RoomCard[];
}

export type RoomLinkKind = 'came-from' | 'merged-into' | 'keeps-in-view' | 'cites';
export interface RoomLink {
  from: RoomKey;
  to: RoomKey;
  kinds: RoomLinkKind[];
}

export interface RoomMap {
  clusters: RoomCluster[];
  links: RoomLink[];
  counts: { sources: number; threads: number; notes: number };
}

type GThread = RoomGraph['threads'][number];
type ThreadLinks = { id: string; parentThreadId: string | null; splitAt: string | null; continuedFromId: string | null };

/** A side question still part of its thread (not made its own, not split off). */
const isSide = (t: ThreadLinks) => t.parentThreadId !== null && t.splitAt === null && t.continuedFromId === null;

/** The thread a side question is part of, at any depth; a thread of its own is itself. */
export function threadOf(id: string, threads: Map<string, ThreadLinks>): string {
  let cur = threads.get(id);
  const seen = new Set<string>();
  while (cur && isSide(cur) && !seen.has(cur.id)) {
    seen.add(cur.id);
    const up = threads.get(cur.parentThreadId ?? '');
    if (!up) break;
    cur = up;
  }
  return cur?.id ?? id;
}

/** Everything a room holds: what was put in, and what came with it, less what was taken out. */
export function roomMembers(rows: RoomRow[], g: RoomGraph): Map<RoomKey, { explicit: boolean; via: RoomKey | null }> {
  const threads = new Map(g.threads.map((t) => [t.id, t]));
  const sources = new Set(g.sources.map((s) => s.id));
  const notes = new Map(g.notes.map((n) => [n.id, n]));
  const out = new Set(rows.filter((r) => r.state === 'out').map((r) => roomKey(r.kind, r.id)));
  const members = new Map<RoomKey, { explicit: boolean; via: RoomKey | null }>();

  // Threads of their own, each with what hangs under it.
  const tops = new Map<string, string[]>();
  for (const t of g.threads) {
    const top = threadOf(t.id, threads);
    tops.set(top, [...(tops.get(top) ?? []), t.id]);
  }
  const notesOf = new Map<string, string[]>();
  for (const n of g.notes) {
    if (!n.threadId || !threads.has(n.threadId)) continue;
    const top = threadOf(n.threadId, threads);
    notesOf.set(top, [...(notesOf.get(top) ?? []), n.id]);
  }
  const threadsAbout = new Map<string, string[]>();
  for (const top of tops.keys()) {
    const s = threads.get(top)?.sourceId;
    if (s && sources.has(s)) threadsAbout.set(s, [...(threadsAbout.get(s) ?? []), top]);
  }

  const exists = (kind: RoomKind, id: string) =>
    kind === 'thread' ? threads.has(id) : kind === 'source' ? sources.has(id) : notes.has(id);
  const put = (key: RoomKey, explicit: boolean, via: RoomKey | null) => {
    if (out.has(key) && !explicit) return false;
    const had = members.get(key);
    if (had?.explicit) return true;
    if (had && !explicit) return true;
    members.set(key, { explicit, via: explicit ? null : via });
    return true;
  };
  const bring = (top: string, via: RoomKey) => {
    for (const n of notesOf.get(top) ?? []) put(roomKey('note', n), false, via);
  };

  for (const r of rows) {
    if (r.state !== 'in') continue;
    const id = r.kind === 'thread' ? threadOf(r.id, threads) : r.id;
    if (!exists(r.kind, id)) continue;
    put(roomKey(r.kind, id), true, null);
  }
  // What comes with them, after every hand-put thing is known.
  for (const [key, m] of [...members]) {
    if (!m.explicit) continue;
    const at = parseRoomKey(key);
    if (!at) continue;
    if (at.kind === 'source') {
      for (const top of threadsAbout.get(at.id) ?? []) {
        if (put(roomKey('thread', top), false, key)) bring(top, key);
      }
    } else if (at.kind === 'thread') {
      bring(at.id, key);
    }
  }
  return members;
}

/** The room as a map: clusters of things that belong together, and the lines between them. */
export function roomMap(rows: RoomRow[], g: RoomGraph): RoomMap {
  const threads = new Map(g.threads.map((t) => [t.id, t]));
  const sourceById = new Map(g.sources.map((s) => [s.id, s]));
  const noteById = new Map(g.notes.map((n) => [n.id, n]));
  const members = roomMembers(rows, g);

  // Marks of a thread of its own: it and its side questions.
  const under = new Map<string, GThread[]>();
  for (const t of g.threads) {
    const top = threadOf(t.id, threads);
    under.set(top, [...(under.get(top) ?? []), t]);
  }
  const threadMarks = (id: string): RoomMarks => {
    const all = under.get(id) ?? [];
    const sides = all.filter((t) => t.id !== id);
    return {
      questions: all.reduce((n, t) => n + t.questions, 0),
      sides: sides.length,
      open: sides.filter((t) => t.open).length,
      threads: 0,
      blocks: 0,
      at: all.reduce((at, t) => (t.updatedAt > at ? t.updatedAt : at), ''),
    };
  };
  const topsAbout = (sourceId: string) =>
    [...under.keys()].filter((top) => threads.get(top)?.sourceId === sourceId);

  const card = (key: RoomKey): RoomCard | null => {
    const at = parseRoomKey(key);
    const m = members.get(key);
    if (!at || !m) return null;
    const base = { kind: at.kind, id: at.id, explicit: m.explicit, via: m.via };
    if (at.kind === 'thread') {
      const t = threads.get(at.id);
      if (!t) return null;
      return { ...base, title: t.title, marks: threadMarks(t.id), quote: t.sourceQuote, file: false };
    }
    if (at.kind === 'source') {
      const s = sourceById.get(at.id);
      if (!s) return null;
      const tops = topsAbout(s.id).map(threadMarks);
      const marks: RoomMarks = {
        questions: tops.reduce((n, x) => n + x.questions, 0),
        sides: tops.reduce((n, x) => n + x.sides, 0),
        open: tops.reduce((n, x) => n + x.open, 0),
        threads: tops.length,
        blocks: 0,
        at: tops.reduce((a, x) => (x.at > a ? x.at : a), s.updatedAt),
      };
      return { ...base, title: s.title, marks, quote: null, file: s.linked };
    }
    const n = noteById.get(at.id);
    if (!n) return null;
    return {
      ...base,
      title: n.title,
      marks: { questions: 0, sides: 0, open: 0, threads: 0, blocks: n.blocks, at: n.updatedAt },
      quote: null,
      file: false,
    };
  };

  // Clusters: things joined by being made from one another (a thread about a source, a note from a thread).
  const parent = new Map<RoomKey, RoomKey>();
  const find = (k: RoomKey): RoomKey => {
    let r = k;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as RoomKey;
    parent.set(k, r);
    return r;
  };
  const join = (a: RoomKey, b: RoomKey) => {
    if (!members.has(a) || !members.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const k of members.keys()) parent.set(k, k);
  for (const top of under.keys()) {
    const s = threads.get(top)?.sourceId;
    if (s) join(roomKey('source', s), roomKey('thread', top));
  }
  for (const n of g.notes) {
    if (n.threadId && threads.has(n.threadId)) join(roomKey('thread', threadOf(n.threadId, threads)), roomKey('note', n.id));
  }

  const order: Record<RoomKind, number> = { source: 0, thread: 1, note: 2 };
  const groups = new Map<RoomKey, RoomCard[]>();
  for (const k of members.keys()) {
    const c = card(k);
    if (!c) continue;
    const root = find(k);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }
  const placed = new Map(rows.filter((r) => r.x !== null && r.y !== null).map((r) => [roomKey(r.kind, r.id), r]));
  // The order things came into the room: the order of its rows.
  const rank = new Map(rows.map((r, i) => [roomKey(r.kind, r.id), i]));
  const clusters: RoomCluster[] = [...groups.values()].map((cards) => {
    cards.sort((a, b) => order[a.kind] - order[b.kind] || b.marks.at.localeCompare(a.marks.at));
    const head = cards[0] as RoomCard;
    // Where it sits: where its first card sits, or any card of it that has a place.
    const spot = cards.map((c) => placed.get(roomKey(c.kind, c.id))).find(Boolean);
    return { key: roomKey(head.kind, head.id), x: spot?.x ?? null, y: spot?.y ?? null, cards };
  });
  // In the order they came into the room.
  const first = (c: RoomCluster) =>
    Math.min(...c.cards.map((x) => rank.get(roomKey(x.kind, x.id)) ?? Number.POSITIVE_INFINITY));
  clusters.sort((a, b) => first(a) - first(b) || a.key.localeCompare(b.key));

  // Lines: links between things in different clusters.
  const clusterOf = new Map<RoomKey, RoomKey>();
  for (const c of clusters) for (const x of c.cards) clusterOf.set(roomKey(x.kind, x.id), c.key);
  const lines = new Map<string, RoomLink>();
  const link = (a: RoomKey, b: RoomKey, kind: RoomLinkKind) => {
    const ca = clusterOf.get(a);
    const cb = clusterOf.get(b);
    if (!ca || !cb || ca === cb) return;
    const id = `${ca}>${cb}`;
    const l = lines.get(id) ?? { from: ca, to: cb, kinds: [] };
    if (!l.kinds.includes(kind)) l.kinds.push(kind);
    lines.set(id, l);
  };
  for (const t of g.threads) {
    const me = roomKey('thread', threadOf(t.id, threads));
    if (t.continuedFromId && threads.has(t.continuedFromId)) {
      link(me, roomKey('thread', threadOf(t.continuedFromId, threads)), 'came-from');
    }
    if (t.splitAt && t.parentThreadId && threads.has(t.parentThreadId)) {
      link(me, roomKey('thread', threadOf(t.parentThreadId, threads)), 'came-from');
    }
    if (t.mergedIntoId && threads.has(t.mergedIntoId)) {
      link(me, roomKey('thread', threadOf(t.mergedIntoId, threads)), 'merged-into');
    }
  }
  for (const p of g.pins) {
    if (threads.has(p.threadId)) link(roomKey('thread', threadOf(p.threadId, threads)), roomKey('source', p.sourceId), 'keeps-in-view');
  }
  for (const n of g.notes) {
    for (const t of n.cites) if (threads.has(t)) link(roomKey('note', n.id), roomKey('thread', threadOf(t, threads)), 'cites');
  }

  const counts = { sources: 0, threads: 0, notes: 0 };
  for (const c of clusters) {
    for (const x of c.cards) counts[x.kind === 'source' ? 'sources' : x.kind === 'thread' ? 'threads' : 'notes'] += 1;
  }
  return { clusters, links: [...lines.values()], counts };
}

/** What a link between two clusters means, in words. */
export function roomLinkWords(kind: RoomLinkKind): string {
  switch (kind) {
    case 'came-from':
      return 'came from';
    case 'merged-into':
      return 'merged into';
    case 'keeps-in-view':
      return 'keeps a passage in view';
    case 'cites':
      return 'cites';
  }
}

/**
 * Where to put clusters that have no place yet: in columns, each into the
 * column that ends highest, below what is already there. Sizes are measured;
 * nothing placed is moved.
 */
export function placeClusters(
  sizes: Array<{ key: string; w: number; h: number; x: number | null; y: number | null }>,
  opts: { columns: number; columnWidth: number; gap: number; left: number; top: number },
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const boxes = sizes.filter((s) => s.x !== null && s.y !== null) as Array<{ key: string; w: number; h: number; x: number; y: number }>;
  const columns = Math.max(1, opts.columns);
  const colX = (i: number) => opts.left + i * (opts.columnWidth + opts.gap);
  const bottomOf = (i: number) => {
    const x0 = colX(i);
    const x1 = x0 + opts.columnWidth;
    return boxes
      .filter((b) => b.x < x1 && b.x + b.w > x0)
      .reduce((y, b) => Math.max(y, b.y + b.h + opts.gap), opts.top);
  };
  for (const s of sizes) {
    if (s.x !== null && s.y !== null) continue;
    let best = 0;
    let bestY = Number.POSITIVE_INFINITY;
    for (let i = 0; i < columns; i++) {
      const y = bottomOf(i);
      if (y < bestY) {
        bestY = y;
        best = i;
      }
    }
    const spot = { x: colX(best), y: bestY };
    out.set(s.key, spot);
    boxes.push({ key: s.key, w: s.w, h: s.h, ...spot });
  }
  return out;
}
