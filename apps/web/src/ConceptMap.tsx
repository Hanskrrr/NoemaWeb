// A room's concepts as a map you zoom (ADR 0038): topics from far, the
// concepts in them closer, concepts inside concepts closer still. Each is a
// circle sized by the learner's work on it; a name shows once its circle is big
// enough to read, so about ten to fifteen are named at any zoom, the rest are
// dots. Scroll or pinch to zoom, drag the background to pan, double-click a
// concept to zoom into it, Esc to zoom out. Drag a concept to move it (it stays
// there) or onto another to put it under it. Choosing one lights up what it is
// linked to, and dims the rest. Everything is drawn in screen space, so names
// stay the same size at every zoom.

import { type Concept, type ConceptLink, LINK_WORDS, workWeight } from '@noema/core';
import { type DragEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bounds, fitName, fitParts, layoutConcepts, type MapOut, nameFor } from './conceptMap.ts';
import { CONCEPT_GLYPH, plural } from './roomText.ts';

/** A circle smaller than this on screen (its radius, in pixels) is a dot; smaller than DOT, not drawn. */
const NAMED = 16;
const DOT = 2.5;
const MIN_K = 0.03;
const MAX_K = 12;

type View = { k: number; tx: number; ty: number };

export function ConceptMap({
  concepts,
  links,
  selected,
  onSelect,
  saved,
  onMove,
  onPutUnder,
  over,
  onOverChange,
  acceptsThing,
  onDropThing,
}: {
  concepts: Concept[];
  links: ConceptLink[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Where the learner moved concepts, relative to what they are under. */
  saved: ReadonlyArray<{ id: string; x: number; y: number }>;
  onMove: (id: string, x: number, y: number) => void;
  onPutUnder: (id: string, parent: string) => void;
  over: string | null;
  onOverChange: (id: string | null) => void;
  acceptsThing: (e: DragEvent) => boolean;
  onDropThing: (e: DragEvent, id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [view, setView] = useState<View | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target: string | null } | null>(null);
  const [finding, setFinding] = useState('');
  const pan = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const press = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);

  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const savedKey = saved.map((s) => `${s.id}:${s.x},${s.y}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: laid out again when the concepts, their places or their work change
  const map = useMemo(() => {
    const ids = new Set(concepts.map((c) => c.id));
    return layoutConcepts(
      concepts.map((c) => ({ id: c.id, parent: c.home && ids.has(c.home.id) ? c.home.id : null, weight: workWeight(c.work) })),
      new Map(saved.map((s) => [s.id, { x: s.x, y: s.y }])),
    );
  }, [concepts.map((c) => `${c.id}>${c.home?.id ?? ''}:${workWeight(c.work)}`).join('|'), savedKey]);

  // The window's size.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 520 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** The view that shows these circles whole, with a margin. */
  const fitTo = useCallback(
    (circles: Iterable<{ x: number; y: number; r: number }>, fill = 0.86): View | null => {
      const b = bounds(circles);
      if (!b) return null;
      const w = Math.max(1, b.maxX - b.minX);
      const h = Math.max(1, b.maxY - b.minY);
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((size.w * fill) / w, (size.h * fill) / h)));
      return { k, tx: size.w / 2 - ((b.minX + b.maxX) / 2) * k, ty: size.h / 2 - ((b.minY + b.maxY) / 2) * k };
    },
    [size.w, size.h],
  );
  /** Whether the learner zoomed or panned since the map was last fitted: then a new size does not fit it again. */
  const touched = useRef(false);
  const fitAll = useCallback(() => {
    touched.current = false;
    setView(fitTo(map.values()));
  }, [fitTo, map]);
  const zoomTo = useCallback(
    (id: string) => {
      const n = map.get(id);
      if (!n) return;
      touched.current = true;
      setView(fitTo([n], 0.8));
    },
    [fitTo, map],
  );

  // Fitted when first shown, when the window changes (if not zoomed since), and when other concepts are on it.
  const shownKey = [...map.keys()].sort().join('|');
  const fittedFor = useRef('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitted again only when other concepts are shown, or the window changes
  useEffect(() => {
    if (fittedFor.current === shownKey && touched.current) return;
    fittedFor.current = shownKey;
    touched.current = false;
    setView(fitTo(map.values()));
  }, [shownKey, size.w, size.h]);

  const v = view ?? fitTo(map.values()) ?? { k: 1, tx: size.w / 2, ty: size.h / 2 };
  const toScreen = (n: { x: number; y: number }) => ({ x: n.x * v.k + v.tx, y: n.y * v.k + v.ty });

  // Zoom with the wheel or a pinch, around the pointer.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      touched.current = true;
      setView((now) => {
        const at = now ?? v;
        const k = Math.min(MAX_K, Math.max(MIN_K, at.k * factor));
        const real = k / at.k;
        return { k, tx: px - (px - at.tx) * real, ty: py - (py - at.ty) * real };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const zoomBy = (factor: number) => {
    touched.current = true;
    setView((now) => {
      const at = now ?? v;
      const k = Math.min(MAX_K, Math.max(MIN_K, at.k * factor));
      const real = k / at.k;
      return { k, tx: size.w / 2 - (size.w / 2 - at.tx) * real, ty: size.h / 2 - (size.h / 2 - at.ty) * real };
    });
  };

  // What the concept chosen is related to: what it is in and holds, what it links to, what shares its things.
  const related = useMemo(() => {
    if (!selected || !map.has(selected)) return null;
    const out = new Set<string>([selected]);
    for (let at = map.get(selected)?.parent; at; at = map.get(at)?.parent) out.add(at);
    const down = (id: string) => {
      for (const k of map.get(id)?.children ?? []) {
        out.add(k);
        down(k);
      }
    };
    down(selected);
    for (const l of links) {
      if (l.from === selected) out.add(l.to);
      if (l.to === selected) out.add(l.from);
    }
    const mine = byId.get(selected)?.members ?? [];
    for (const c of concepts) if (c.members.some((k) => mine.includes(k))) out.add(c.id);
    return out;
  }, [selected, map, links, concepts, byId]);

  // The deepest concept under a point on the screen (not the one dragged, nor what is inside it).
  const hit = (x: number, y: number, except: string | null): string | null => {
    let best: MapOut | null = null;
    const isUnder = (id: string, top: string) => {
      for (let at: string | null = id; at; at = map.get(at)?.parent ?? null) if (at === top) return true;
      return false;
    };
    for (const n of map.values()) {
      if (except && isUnder(n.id, except)) continue;
      const s = toScreen(n);
      if (Math.hypot(x - s.x, y - s.y) <= n.r * v.k && (!best || n.depth > best.depth)) best = n;
    }
    return best?.id ?? null;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onBackgroundDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, view: v, moved: false };
  };
  const onBackgroundMove = (e: PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
    if (p.moved) {
      touched.current = true;
      setView({ k: p.view.k, tx: p.view.tx + dx, ty: p.view.ty + dy });
    }
  };
  const onBackgroundUp = () => {
    const p = pan.current;
    pan.current = null;
    if (p && !p.moved) onSelect(null);
  };

  const onNodeDown = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    press.current = { id, x: e.clientX, y: e.clientY, started: false };
  };
  const onNodeMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.started && Math.abs(dx) + Math.abs(dy) < 5) return;
    p.started = true;
    const at = local(e);
    setDrag({ id: p.id, dx, dy, target: hit(at.x, at.y, p.id) });
  };
  const onNodeUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (!p.started) {
      onSelect(p.id);
      return;
    }
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.target && d.target !== map.get(p.id)?.parent) {
      onPutUnder(p.id, d.target);
      return;
    }
    // Moved: where it is now, relative to what it is under.
    const n = map.get(p.id);
    if (!n) return;
    const parent = n.parent ? map.get(n.parent) : null;
    const nx = n.x + d.dx / v.k;
    const ny = n.y + d.dy / v.k;
    onMove(p.id, nx - (parent?.x ?? 0), ny - (parent?.y ?? 0));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      const up = selected ? map.get(selected)?.parent : null;
      if (up) {
        onSelect(up);
        zoomTo(up);
      } else {
        onSelect(null);
        fitAll();
      }
    }
    if ((e.key === '+' || e.key === '=') && !e.metaKey) zoomBy(1.4);
    if (e.key === '-' && !e.metaKey) zoomBy(1 / 1.4);
  };

  // Each concept on the screen, and whether it is big enough to name.
  const drawn = [...map.values()]
    .map((n) => {
      const moving = drag && (drag.id === n.id || isInside(map, n.id, drag.id));
      const s = toScreen(n);
      return { n, x: s.x + (moving ? drag.dx : 0), y: s.y + (moving ? drag.dy : 0), sr: n.r * v.k };
    })
    .filter((d) => d.sr >= DOT && d.x + d.sr > -40 && d.y + d.sr > -40 && d.x - d.sr < size.w + 40 && d.y - d.sr < size.h + 40)
    .sort((a, b) => a.n.depth - b.n.depth);
  const at = new Map(drawn.map((d) => [d.n.id, d]));
  /** The name a circle shows at this zoom, or null: a dot. */
  const labelOf = (id: string): string | null => {
    const d = at.get(id);
    const c = byId.get(id);
    if (!d || !c || d.sr < NAMED) return null;
    return nameFor(c.title, d.sr, nameSize(d.n.children.length > 0 && c.members.length === 0, d.sr), d.n.children.length > 0);
  };
  const labels = new Map(drawn.map((d) => [d.n.id, labelOf(d.n.id)]));
  const named = (id: string) => Boolean(labels.get(id));
  /** What a link's end is drawn as at this zoom: itself if it is named, or the nearest named concept it is in. */
  const shownAs = (id: string): string | null => {
    for (let x: string | null = id; x; x = map.get(x)?.parent ?? null) if (named(x)) return x;
    return null;
  };
  const lines = new Map<string, { a: string; b: string; links: ConceptLink[] }>();
  for (const l of links) {
    const a = shownAs(l.from);
    const b = shownAs(l.to);
    if (!a || !b || a === b || isInside(map, a, b) || isInside(map, b, a)) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const line = lines.get(key) ?? { a, b, links: [] };
    line.links.push(l);
    lines.set(key, line);
  }

  const matches = finding.trim()
    ? concepts.filter((c) => c.title.toLowerCase().includes(finding.trim().toLowerCase()) || c.names.some((n) => n.toLowerCase().includes(finding.trim().toLowerCase()))).slice(0, 8)
    : [];
  const go = (id: string) => {
    onSelect(id);
    zoomTo(id);
    setFinding('');
  };
  const trail: Concept[] = [];
  for (let x = selected && map.has(selected) ? selected : null; x; x = map.get(x)?.parent ?? null) {
    const c = byId.get(x);
    if (c) trail.unshift(c);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the map takes the keyboard for zooming; its concepts are buttons
    <div
      ref={box}
      className={`concept-map${drag ? ' is-dragging' : ''}`}
      tabIndex={-1}
      onKeyDown={onKey}
      data-testid="concept-map"
      data-zoom={v.k.toFixed(3)}
    >
      <svg
        className="concept-map-svg"
        width={size.w}
        height={size.h}
        onPointerDown={onBackgroundDown}
        onPointerMove={(e) => {
          onBackgroundMove(e);
          onNodeMove(e);
        }}
        onPointerUp={() => {
          if (press.current) onNodeUp();
          else onBackgroundUp();
        }}
        role="presentation"
      >
        <defs>
          <marker id="concept-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
        {drawn.map(({ n, x, y, sr }) => {
          const c = byId.get(n.id) as Concept;
          const topic = n.children.length > 0 && c.members.length === 0;
          const dim = related && !related.has(n.id);
          const target = drag?.target === n.id || over === n.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a circle on the map that takes things dropped on it
            <g
              key={n.id}
              className={`concept-map-node depth-${Math.min(n.depth, 3)}${topic ? ' is-topic' : ''}${c.status === 'suggested' ? ' is-suggested' : ''}${
                selected === n.id ? ' is-selected' : ''
              }${dim ? ' is-dim' : ''}${target ? ' is-target' : ''}`}
              role="button"
              tabIndex={labels.get(n.id) ? 0 : -1}
              aria-label={`${topic ? 'Topic' : 'Concept'} ${c.title}`}
              onPointerDown={(e) => onNodeDown(e, n.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onSelect(n.id);
                zoomTo(n.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(n.id);
                }
              }}
              onDragOver={(e) => {
                if (!acceptsThing(e)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
                onOverChange(n.id);
              }}
              onDragLeave={() => onOverChange(null)}
              onDrop={(e) => {
                if (!acceptsThing(e)) return;
                e.preventDefault();
                e.stopPropagation();
                onOverChange(null);
                onDropThing(e, n.id);
              }}
              data-concept-id={n.id}
              data-status={c.status}
              data-depth={n.depth}
              data-holds={n.children.length}
              data-named={labels.get(n.id) ? 'yes' : 'no'}
              data-testid="concept-node"
            >
              <title>{c.title}</title>
              <circle cx={x} cy={y} r={sr} />
              {labels.get(n.id) && (
                <Label
                  c={c}
                  name={labels.get(n.id) as string}
                  x={x}
                  y={y}
                  sr={sr}
                  topic={topic}
                  kids={n.children.map((k) => byId.get(k)).filter((k): k is Concept => Boolean(k))}
                  kidsNamed={n.children.some((k) => named(k))}
                />
              )}
            </g>
          );
        })}
        {[...lines.values()].map(({ a, b, links: ls }) => {
          const p = at.get(a);
          const q = at.get(b);
          if (!p || !q) return null;
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < p.sr + q.sr + 4) return null;
          const ux = (q.x - p.x) / d;
          const uy = (q.y - p.y) / d;
          const one = ls.length === 1 ? ls[0] : null;
          const exact = one && ((one.from === a && one.to === b) || (one.from === b && one.to === a));
          // An arrow from what follows to what comes first, as in the path; drawn from the link's own ends.
          const from = exact && one && one.from === b ? q : p;
          const to = exact && one && one.from === b ? p : q;
          const fx = from === p ? ux : -ux;
          const fy = from === p ? uy : -uy;
          const x1 = from.x + fx * from.sr;
          const y1 = from.y + fy * from.sr;
          const x2 = to.x - fx * to.sr;
          const y2 = to.y - fy * to.sr;
          const suggested = ls.every((l) => l.status === 'suggested');
          const label = exact && one ? (one.kind === 'contrasts-with' ? 'contrasts' : LINK_WORDS[one.kind]) : plural(ls.length, 'link');
          return (
            <g key={`${a}|${b}`} className={`concept-map-line${exact && one ? ` kind-${one.kind}` : ' is-many'}${suggested ? ' is-suggested' : ''}`} data-testid="concept-map-line">
              <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={exact && one && one.kind !== 'contrasts-with' ? 'url(#concept-map-arrow)' : undefined} />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" data-testid="concept-map-line-label">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="concept-map-top">
        <p className="concept-map-trail" data-testid="concept-map-trail">
          <button type="button" className="quiet inline" onClick={() => (onSelect(null), fitAll())}>
            All
          </button>
          {trail.map((c) => (
            <span key={c.id}>
              {' › '}
              <button type="button" className="quiet inline" onClick={() => go(c.id)}>
                {c.title}
              </button>
            </span>
          ))}
        </p>
        <div className="concept-map-find">
          <input
            value={finding}
            onChange={(e) => setFinding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) go(matches[0].id);
              if (e.key === 'Escape') setFinding('');
              e.stopPropagation();
            }}
            placeholder="⌕ Find a concept"
            aria-label="Find a concept"
            data-testid="concept-map-find"
          />
          {matches.length > 0 && (
            <ul className="concept-map-matches">
              {matches.map((c) => (
                <li key={c.id}>
                  <button type="button" className="quiet" onClick={() => go(c.id)} data-testid="concept-map-match">
                    {CONCEPT_GLYPH} {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="concept-map-zoom">
        <button type="button" className="quiet" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" data-testid="concept-map-out">
          −
        </button>
        <button type="button" className="quiet" onClick={fitAll} aria-label="Show all" data-testid="concept-map-fit">
          ⤢
        </button>
        <button type="button" className="quiet" onClick={() => zoomBy(1.4)} aria-label="Zoom in" data-testid="concept-map-in">
          +
        </button>
      </div>
      {drag?.target && (
        <p className="concept-map-hint" data-testid="concept-map-drop-hint">
          Put “{byId.get(drag.id)?.title}” under “{byId.get(drag.target)?.title}”
        </p>
      )}
    </div>
  );
}

/** Whether `id` is inside `top` on the map (under it, at any depth). */
function isInside(map: Map<string, MapOut>, id: string, top: string): boolean {
  for (let at = map.get(id)?.parent ?? null; at; at = map.get(at)?.parent ?? null) if (at === top) return true;
  return false;
}

/** The size of a concept's name on the screen: a topic's a little bigger; both grow a little with the circle. */
const nameSize = (topic: boolean, sr: number) => (topic ? Math.min(17, 12 + sr / 40) : Math.min(15, 11 + sr / 50));

/** A concept's name in its circle, its numbers under it, and, when what is inside is too small to name, its biggest few. */
function Label({ c, name, x, y, sr, topic, kids, kidsNamed }: { c: Concept; name: string; x: number; y: number; sr: number; topic: boolean; kids: Concept[]; kidsNamed: boolean }) {
  const size = nameSize(topic, sr);
  const chars = Math.max(3, Math.floor((sr * 1.75) / (size * 0.56)));
  // A circle holding others has its name at its top, above what it holds (which sits lower).
  const top = kids.length > 0;
  const lines = name.split('\n');
  const extra = (lines.length - 1) * size * 1.1;
  const ny = top ? y - sr + size + 6 : y - (sr >= 36 ? size * 0.35 : -size * 0.35) - extra / 2;
  const counts = topic
    ? [plural(kids.length, 'concept')]
    : [c.work.questions ? plural(c.work.questions, 'question') : '', c.work.notes ? plural(c.work.notes, 'note') : '', !c.work.questions && !c.work.notes ? plural(c.materials, 'material') : ''].filter((s) => s);
  const biggest = [...kids].sort((a, b) => workWeight(b.work) - workWeight(a.work)).slice(0, 3);
  return (
    <>
      <text x={x} y={ny} textAnchor="middle" className="concept-name" style={{ fontSize: size }}>
        {lines.length === 1
          ? name
          : lines.map((l, i) => (
              <tspan key={l} x={x} dy={i === 0 ? 0 : size * 1.1}>
                {l}
              </tspan>
            ))}
      </text>
      {sr >= 36 + extra && !top && (
        <text x={x} y={ny + extra + size + 2} textAnchor="middle" className="concept-map-counts">
          {fitParts(counts, Math.floor((sr * 1.7) / (10.5 * 0.54)))}
        </text>
      )}
      {top && !kidsNamed && sr >= 80 && (
        <text x={x} y={ny + size + 3} textAnchor="middle" className="concept-map-kids">
          {fitName(`${biggest.map((k) => k.title).join(' · ')}${kids.length > biggest.length ? ' · …' : ''}`, Math.floor(chars * 0.9))}
        </text>
      )}
    </>
  );
}
