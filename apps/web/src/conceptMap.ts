// Where concepts sit on a room's map (ADR 0038): each a circle sized by the
// learner's work on it; what is under a concept (or in a topic) packed inside
// its circle; the tops packed side by side. Pure, so the same concepts always
// land in the same places, and a place the learner dragged to stays.

export interface MapIn {
  id: string;
  /** What it is under on the map, if that is on the map too. */
  parent: string | null;
  /** The learner's work on it (questions count most): its size. */
  weight: number;
}

export interface MapOut {
  id: string;
  parent: string | null;
  /** Its center and radius, in map units. */
  x: number;
  y: number;
  r: number;
  depth: number;
  children: string[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** A concept's circle with nothing inside: bigger with more of the learner's work, within bounds. */
export const leafRadius = (weight: number) => Math.min(110, 38 + 14 * Math.sqrt(Math.max(0, weight)));

type Disc = { id: string; x: number; y: number; r: number; fixed: boolean };

/**
 * Discs packed around a center without overlapping: largest first on a sunflower spiral, then pushed apart until
 * none overlap (those placed by the learner stay where they are). Returns the radius that holds them all.
 */
export function pack(discs: Disc[], gap: number, aspect = 1): number {
  if (discs.length === 0) return 0;
  const free = discs.filter((d) => !d.fixed).sort((a, b) => b.r - a.r || a.id.localeCompare(b.id));
  const mean = discs.reduce((n, d) => n + d.r, 0) / discs.length;
  const spacing = mean * 1.9 + gap;
  // Wider than tall when asked (the map's window is): spread out sideways, pulled in more from above and below.
  const wide = Math.sqrt(aspect);
  free.forEach((d, i) => {
    const dist = i === 0 && discs.length === free.length ? 0 : spacing * Math.sqrt(i + (discs.length === free.length ? 0 : 1));
    d.x = Math.cos(i * GOLDEN) * dist * wide;
    d.y = (Math.sin(i * GOLDEN) * dist) / wide;
  });
  for (let round = 0; round < 120; round++) {
    let moved = false;
    for (let i = 0; i < discs.length; i++) {
      for (let j = i + 1; j < discs.length; j++) {
        const a = discs[i] as Disc;
        const b = discs[j] as Disc;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = a.r + b.r + gap;
        if (d >= min) continue;
        if (d < 1e-6) {
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = min - d;
        const ux = dx / d;
        const uy = dy / d;
        if (a.fixed && b.fixed) continue;
        const share = a.fixed || b.fixed ? 1 : 0.5;
        if (!a.fixed) {
          a.x -= ux * push * share;
          a.y -= uy * push * share;
        }
        if (!b.fixed) {
          b.x += ux * push * share;
          b.y += uy * push * share;
        }
        moved = true;
      }
    }
    // A little pull to the middle keeps them together.
    for (const d of discs) {
      if (d.fixed) continue;
      d.x *= 1 - 0.005 / aspect;
      d.y *= 1 - 0.005 * aspect;
    }
    if (!moved && round > 4) break;
  }
  // Centered on what holds them: not on the first.
  const free2 = discs.filter((d) => !d.fixed);
  if (free2.length === discs.length) {
    const minX = Math.min(...discs.map((d) => d.x - d.r));
    const maxX = Math.max(...discs.map((d) => d.x + d.r));
    const minY = Math.min(...discs.map((d) => d.y - d.r));
    const maxY = Math.max(...discs.map((d) => d.y + d.r));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const d of discs) {
      d.x -= cx;
      d.y -= cy;
    }
  }
  return Math.max(...discs.map((d) => Math.hypot(d.x, d.y) + d.r));
}

/**
 * The map: every concept's circle. Those under another are packed inside it (a bit lower, leaving its name room at
 * the top); a concept holding others is big enough for them and for itself. `saved` are places the learner moved
 * concepts to, relative to what they are under (or to the map's middle, at the top).
 */
export function layoutConcepts(nodes: readonly MapIn[], saved: ReadonlyMap<string, { x: number; y: number }> = new Map()): Map<string, MapOut> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // What is under what, with no circles: a parent not on the map, or one that leads back round, is no parent.
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) {
    let p = n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : null;
    const seen = new Set([n.id]);
    for (let at = p; at; at = byId.get(at)?.parent ?? null) {
      if (seen.has(at)) {
        p = null;
        break;
      }
      seen.add(at);
      if (!byId.has(at)) break;
    }
    parentOf.set(n.id, p);
  }
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const p = parentOf.get(n.id);
    if (p) children.set(p, [...(children.get(p) ?? []), n.id]);
  }
  const radius = new Map<string, number>();
  const rel = new Map<string, { x: number; y: number }>();
  const size = (id: string, depth: number): number => {
    const kids = children.get(id) ?? [];
    const own = leafRadius(byId.get(id)?.weight ?? 0);
    if (kids.length === 0 || depth > 12) {
      radius.set(id, own);
      return own;
    }
    const discs: Disc[] = kids.map((k) => {
      const at = saved.get(k);
      return { id: k, x: at?.x ?? 0, y: at?.y ?? 0, r: size(k, depth + 1), fixed: Boolean(at) };
    });
    const inner = pack(discs, 12);
    // Room for its name above what is inside: what it holds sits a little lower.
    const r = Math.max(own, inner * 1.35 + 26);
    for (const d of discs) rel.set(d.id, { x: d.x, y: d.y + (d.fixed ? 0 : r * 0.16) });
    radius.set(id, r);
    return r;
  };
  const tops = nodes.filter((n) => !parentOf.get(n.id)).map((n) => n.id);
  const topDiscs: Disc[] = tops.map((id) => {
    const at = saved.get(id);
    return { id, x: at?.x ?? 0, y: at?.y ?? 0, r: size(id, 0), fixed: Boolean(at) };
  });
  pack(topDiscs, 36, 1.6);
  for (const d of topDiscs) rel.set(d.id, { x: d.x, y: d.y });
  const out = new Map<string, MapOut>();
  const place = (id: string, cx: number, cy: number, depth: number) => {
    const at = rel.get(id) ?? { x: 0, y: 0 };
    const x = cx + at.x;
    const y = cy + at.y;
    out.set(id, { id, parent: parentOf.get(id) ?? null, x, y, r: radius.get(id) ?? 30, depth, children: children.get(id) ?? [] });
    for (const k of children.get(id) ?? []) place(k, x, y, depth + 1);
  };
  for (const id of tops) place(id, 0, 0, 0);
  return out;
}

/** What holds all of them: for fitting the map to the window. */
export function bounds(circles: Iterable<{ x: number; y: number; r: number }>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const c of circles) {
    b = b
      ? { minX: Math.min(b.minX, c.x - c.r), minY: Math.min(b.minY, c.y - c.r), maxX: Math.max(b.maxX, c.x + c.r), maxY: Math.max(b.maxY, c.y + c.r) }
      : { minX: c.x - c.r, minY: c.y - c.r, maxX: c.x + c.r, maxY: c.y + c.r };
  }
  return b;
}

/**
 * A concept's name as it can be shown in a circle of `sr` pixels: whole on one line; whole on two or three lines (in a
 * circle holding nothing, broken between words or after a hyphen; the lines joined by "\n"); or cut short with "…"
 * if most of it still fits; null if it would be cut too much to read (then the circle is a dot until it is bigger). A
 * circle holding others shows its name on one line at its top, where it is narrower.
 */
export function nameFor(name: string, sr: number, size: number, holds: boolean): string | null {
  const per = (w: number) => Math.floor(Math.min(w, 190) / (size * 0.54));
  const chars = per(holds ? sr * 1.5 : sr * 2);
  const len = Array.from(name).length;
  if (chars >= len) return name;
  if (!holds) {
    for (const k of [2, 3]) {
      if (k * size * 1.1 > sr * 1.4) break;
      const lines = wrap(name, per(sr * (k === 2 ? 1.75 : 1.6)), k);
      if (lines) return lines.join('\n');
    }
  }
  if (chars < Math.max(5, Math.ceil(len * 0.7))) return null;
  return fitName(name, chars);
}

/** A name in lines of at most `chars`, broken between words or after a hyphen; null if it needs more than `most`. */
function wrap(name: string, chars: number, most: number): string[] | null {
  const words = name.split(/(?<=-)|\s+/).filter((w) => w);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (Array.from(w).length > chars) return null;
    const joined = line ? `${line}${line.endsWith('-') ? '' : ' '}${w}` : w;
    if (Array.from(joined).length <= chars) line = joined;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length <= most ? lines : null;
}

/** A name cut to what fits in a width (in characters), with "…". */
export function fitName(name: string, chars: number): string {
  const list = Array.from(name);
  if (list.length <= chars) return name;
  return chars <= 1 ? '…' : `${list.slice(0, chars - 1).join('').trimEnd()}…`;
}

/** The parts that fit in a width (in characters), joined by " · ": as many as fit, from the first. */
export function fitParts(parts: string[], chars: number): string {
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} · ${p}` : p;
    if (Array.from(next).length > chars) break;
    out = next;
  }
  return out || fitName(parts[0] ?? '', chars);
}
