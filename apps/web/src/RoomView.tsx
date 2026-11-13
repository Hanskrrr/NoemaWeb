// A room (ADR 0026): what is learnt about one subject, as a map. Things that
// belong together are one cluster: a source with the threads asked about it
// and the notes made from them. Each card says what was done there: questions
// asked, side questions not come back from. Lines join clusters only where
// something links them, and say how. Clusters stay where they are put: Noema
// places new ones, and you move them by dragging (or Alt+arrow keys).

import {
  type NoteSummary,
  placeClusters,
  type RoomKind,
  type RoomView as RoomViewData,
  roomLinkWords,
  type Source,
  type Thread,
  threadOf,
} from '@noema/core';
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ApiFailure, api } from './api.ts';
import { openMenu } from './ContextMenu.tsx';
import { addDropped, droppedItem, isItemDrag, isOutsideDrag, takeOutsideDrop } from './drag.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { roomMenu, useRooms } from './Rooms.tsx';

const WIDTH = 264;
const GAP = 28;
const EDGE = 24;
const STEP = 24;

type Spot = { x: number; y: number };
type Cluster = RoomViewData['clusters'][number];
type RoomCard = Cluster['cards'][number];

const GLYPH: Record<RoomKind, string> = { source: '❡', thread: '◦', note: '▤' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a card says was done there. */
function marksOf(c: RoomCard): string {
  const m = c.marks;
  const parts: string[] = [];
  if (c.kind === 'source' && m.threads) parts.push(plural(m.threads, 'thread'));
  if (c.kind !== 'note') {
    if (m.questions) parts.push(plural(m.questions, 'question'));
    if (m.sides) parts.push(plural(m.sides, 'side question'));
  } else {
    parts.push(plural(m.blocks, 'block'));
  }
  return parts.join(' · ');
}
const kindName = (c: RoomCard) => (c.kind === 'source' ? (c.file ? 'File' : 'Source') : c.kind === 'thread' ? 'Thread' : 'Note');
const day = (at: string) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

export function RoomView({
  roomId,
  notebookId,
  threads,
  sources,
  notes,
  onOpen,
  onDeleted,
}: {
  roomId: string;
  notebookId: string;
  threads: Thread[];
  sources: Source[];
  notes: NoteSummary[];
  onOpen: (kind: RoomKind, id: string) => void;
  onDeleted: () => void;
}) {
  const rooms = useRooms();
  const [view, setView] = useState<RoomViewData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [spots, setSpots] = useState<Map<string, Spot>>(new Map());
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Ticks in the picker show at once; the room catches up.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; sx: number; sy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const swallow = useRef(false);

  const load = useCallback(async () => {
    try {
      const v = await api.room(roomId);
      setView(v);
      setProblem(null);
      setSpots(
        new Map(v.clusters.flatMap((c) => (c.x !== null && c.y !== null ? [[c.key, { x: c.x, y: c.y }] as const] : []))),
      );
    } catch (err) {
      setProblem(err instanceof ApiFailure ? err.message : 'The room could not be opened.');
    }
  }, [roomId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn again whenever a room changes
  useEffect(() => {
    void load();
  }, [load, rooms.changed]);

  const headOf = (c: Cluster) => c.cards[0] as RoomCard;
  const save = (places: Array<{ cluster: Cluster; at: Spot }>) => {
    if (places.length === 0) return;
    void api
      .placeInRoom(
        roomId,
        places.map(({ cluster, at }) => ({ kind: headOf(cluster).kind, id: headOf(cluster).id, x: at.x, y: at.y })),
      )
      .catch(() => {});
  };

  // Measure the clusters; place the new ones, and keep them there.
  useLayoutEffect(() => {
    if (!view || !canvas.current) return;
    const measured = new Map<string, { w: number; h: number }>();
    for (const el of canvas.current.querySelectorAll<HTMLElement>('[data-cluster]')) {
      measured.set(el.dataset.cluster as string, { w: el.offsetWidth, h: el.offsetHeight });
    }
    const same =
      measured.size === sizes.size && [...measured].every(([k, s]) => sizes.get(k)?.w === s.w && sizes.get(k)?.h === s.h);
    if (!same) setSizes(measured);
    const unplaced = view.clusters.filter((c) => !spots.has(c.key));
    if (unplaced.length === 0) return;
    const width = canvas.current.clientWidth;
    const columns = Math.max(1, Math.floor((width - 2 * EDGE + GAP) / (WIDTH + GAP)));
    const placed = placeClusters(
      view.clusters.map((c) => ({
        key: c.key,
        w: measured.get(c.key)?.w ?? WIDTH,
        h: measured.get(c.key)?.h ?? 120,
        x: spots.get(c.key)?.x ?? null,
        y: spots.get(c.key)?.y ?? null,
      })),
      { columns, columnWidth: WIDTH, gap: GAP, left: EDGE, top: EDGE },
    );
    const next = new Map(spots);
    for (const [k, at] of placed) next.set(k, at);
    setSpots(next);
    save(unplaced.map((c) => ({ cluster: c, at: placed.get(c.key) as Spot })));
  });

  // Moving a cluster: by dragging it (a click is still a click), or Alt+arrows.
  const down = (e: PointerEvent, key: string) => {
    if (e.button !== 0) return;
    const at = spots.get(key);
    if (!at) return;
    drag.current = { key, sx: e.clientX, sy: e.clientY, x0: at.x, y0: at.y, moved: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setSpots((m) => new Map(m).set(d.key, { x: Math.max(0, d.x0 + dx), y: Math.max(0, d.y0 + dy) }));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !view) return;
    swallow.current = true;
    setTimeout(() => {
      swallow.current = false;
    }, 0);
    const cluster = view.clusters.find((c) => c.key === d.key);
    const at = spots.get(d.key);
    if (cluster && at) save([{ cluster, at }]);
  };
  const nudge = (e: KeyboardEvent, cluster: Cluster) => {
    if (!e.altKey) return;
    const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
    const at = spots.get(cluster.key);
    if (!delta || !at) return;
    e.preventDefault();
    const next = { x: Math.max(0, at.x + (delta[0] ?? 0)), y: Math.max(0, at.y + (delta[1] ?? 0)) };
    setSpots((m) => new Map(m).set(cluster.key, next));
    save([{ cluster, at: next }]);
  };

  /** Everything placed again by Noema, in the order they came in. */
  const arrange = () => {
    if (!view || !canvas.current) return;
    const width = canvas.current.clientWidth;
    const columns = Math.max(1, Math.floor((width - 2 * EDGE + GAP) / (WIDTH + GAP)));
    const placed = placeClusters(
      view.clusters.map((c) => ({ key: c.key, w: sizes.get(c.key)?.w ?? WIDTH, h: sizes.get(c.key)?.h ?? 120, x: null, y: null })),
      { columns, columnWidth: WIDTH, gap: GAP, left: EDGE, top: EDGE },
    );
    setSpots(new Map(placed));
    save(view.clusters.map((c) => ({ cluster: c, at: placed.get(c.key) as Spot })));
  };

  // Dropping: a thread, source or note from a list; files and links from outside, read as sources.
  const dropAt = (e: DragEvent): Spot => {
    const r = canvas.current?.getBoundingClientRect();
    return { x: Math.max(0, Math.round(e.clientX - (r?.left ?? 0) - 24)), y: Math.max(0, Math.round(e.clientY - (r?.top ?? 0) - 16)) };
  };
  const onDrop = (e: DragEvent) => {
    setDropOver(false);
    const at = dropAt(e);
    const item = droppedItem(e);
    if (item) {
      e.preventDefault();
      void rooms.add(roomId, [{ ...rooms.unit(item), ...at }]);
      return;
    }
    if (!isOutsideDrag(e)) return;
    e.preventDefault();
    const drop = takeOutsideDrop(e);
    if (drop.files.length + drop.links.length === 0) return;
    setStatus('Reading what you dropped…');
    void addDropped(notebookId, drop, (done, total) => setStatus(`Reading what you dropped: ${done} of ${total}…`)).then(
      async ({ added, problems }) => {
        if (added.length) {
          await rooms.add(
            roomId,
            added.map((x, i) => ({ kind: 'source' as const, id: x.id, x: at.x + i * STEP, y: at.y + i * STEP })),
          );
        }
        setStatus(
          [added.length ? `Added ${plural(added.length, 'source')} to this room.` : '', ...problems].filter(Boolean).join(' ') ||
            null,
        );
      },
    );
  };

  if (problem) {
    return (
      <div className="empty" role="alert">
        <p className="empty-title">{problem}</p>
      </div>
    );
  }
  if (!view) return <p className="hint room-loading">Opening the room…</p>;

  const room = view.room;
  const clusterOf = new Map(view.clusters.map((c) => [c.key, c]));
  const box = (key: string) => {
    const at = spots.get(key);
    const size = sizes.get(key);
    return at && size ? { ...at, ...size } : null;
  };
  let maxX = 0;
  let maxY = 0;
  for (const c of view.clusters) {
    const b = box(c.key);
    if (b) {
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
  }

  const cardButton = (c: RoomCard, head: boolean) => {
    const open = c.kind !== 'note' ? c.marks.open : 0;
    const marks = marksOf(c);
    return (
      <button
        type="button"
        className={`room-card${head ? ' is-head' : ''} kind-${c.kind}`}
        style={{ '--heat': Math.min(1, c.marks.questions / 12) } as CSSProperties}
        onClick={() => {
          if (!swallow.current) onOpen(c.kind, c.id);
        }}
        onContextMenu={(e) =>
          openMenu(
            e,
            roomMenu(rooms, { kind: c.kind, id: c.id, title: c.title }, [
              { label: 'Open', onSelect: () => onOpen(c.kind, c.id) },
              {
                label: 'Take out of this room',
                onSelect: () => rooms.remove(roomId, { kind: c.kind, id: c.id }),
                hint: c.explicit ? undefined : 'It came with something in this room; it stays out until you put it back.',
                testId: 'menu-take-out',
              },
            ]),
            c.title || 'Untitled',
          )
        }
        title={c.quote ? `Asked about “${c.quote}”` : undefined}
        data-testid="room-card"
        data-kind={c.kind}
        data-id={c.id}
      >
        {head && (
          <span className="room-card-kind">
            <span aria-hidden>{GLYPH[c.kind]} </span>
            {kindName(c)}
            <span className="room-card-day">{day(c.marks.at)}</span>
          </span>
        )}
        <span className="room-card-title">
          {!head && <span aria-hidden>{GLYPH[c.kind]} </span>}
          {c.title || 'Untitled'}
        </span>
        {(marks || open > 0) && (
          <span className="room-card-marks" data-testid="room-card-marks">
            {marks}
            {open > 0 && (
              <span className="room-open" title="Side questions you did not come back from">
                {marks ? ' · ' : ''}
                {open} open
              </span>
            )}
          </span>
        )}
      </button>
    );
  };

  // The picker: everything in the notebook, ticked if in this room.
  const members = new Set(room.members as string[]);
  const cards = new Map<string, RoomCard>(view.clusters.flatMap((c) => c.cards.map((x) => [`${x.kind}:${x.id}`, x] as const)));
  const titleOf = (key: string | null) => (key ? (cards.get(key)?.title ?? '') : '');
  const byId = new Map(threads.map((t) => [t.id, t]));
  const q = filter.trim().toLowerCase();
  const match = (title: string) => !q || title.toLowerCase().includes(q);
  const groups: Array<{ name: string; items: Array<{ kind: RoomKind; id: string; title: string }> }> = [
    { name: 'Sources', items: sources.map((x) => ({ kind: 'source' as const, id: x.id, title: x.title })) },
    {
      name: 'Threads',
      items: threads.filter((t) => threadOf(t.id, byId) === t.id).map((t) => ({ kind: 'thread' as const, id: t.id, title: t.title })),
    },
    { name: 'Notes', items: notes.map((n) => ({ kind: 'note' as const, id: n.id, title: n.title })) },
  ];

  return (
    <section className="room" aria-label={`Room: ${room.title}`} data-testid="room">
      <header className="room-head">
        <div className="room-title">
          <EditableTitle
            title={room.title}
            label="Rename this room"
            onRename={async (title) => {
              await api.renameRoom(roomId, title);
              await rooms.refresh();
            }}
            testId="room-rename"
            inputTestId="room-title-input"
          />
          <p className="room-meta" data-testid="room-meta">
            {plural(room.counts.sources, 'source')} · {plural(room.counts.threads, 'thread')} · {plural(room.counts.notes, 'note')}
          </p>
        </div>
        <div className="room-actions">
          <button
            type="button"
            className={picking ? 'active' : 'quiet'}
            onClick={() => setPicking((p) => !p)}
            aria-expanded={picking}
            data-testid="room-pick"
          >
            Choose what is in it
          </button>
          {view.clusters.length > 1 && (
            <button type="button" className="quiet" onClick={arrange} title="Place every cluster again, in the order they came in" data-testid="room-arrange">
              Arrange
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setConfirming(true)} data-testid="room-delete">
            Delete room
          </button>
        </div>
      </header>
      {confirming && (
        <div className="askbox confirm-row room-confirm" role="alert" data-testid="room-delete-confirm">
          <span>Delete “{room.title}”? What is in it stays where it is; only the room and its map go.</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void api.deleteRoom(roomId).then(onDeleted, (err: unknown) =>
                setStatus(err instanceof ApiFailure ? err.message : 'The room could not be deleted.'),
              );
            }}
            data-testid="room-delete-yes"
          >
            Delete
          </button>
          <button type="button" className="quiet" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      )}
      {picking && (
        <section className="room-picker" aria-label="Choose what is in this room" data-testid="room-picker">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a source, thread or note"
            aria-label="Find a source, thread or note"
            data-testid="room-picker-filter"
          />
          <div className="room-picker-groups">
            {groups.map((g) => {
              const shown = g.items.filter((x) => match(x.title));
              return (
                <fieldset key={g.name} className="room-picker-group">
                  <legend>
                    {g.name} <span className="room-count">{shown.length}</span>
                  </legend>
                  {shown.length === 0 && <p className="hint">None{q ? ' with those words' : ''}.</p>}
                  {shown.map((x) => {
                    const key = `${x.kind}:${x.id}`;
                    const inIt = pending.get(key) ?? members.has(key);
                    const card = cards.get(key);
                    const via = card && !card.explicit ? titleOf(card.via) : '';
                    return (
                      <label key={key} className="room-picker-row" data-testid="room-picker-row" data-kind={x.kind} data-id={x.id}>
                        <input
                          type="checkbox"
                          checked={inIt}
                          onChange={() => {
                            setPending((m) => new Map(m).set(key, !inIt));
                            const done = inIt
                              ? rooms.remove(roomId, { kind: x.kind, id: x.id })
                              : rooms.add(roomId, [{ kind: x.kind, id: x.id }]);
                            void done.finally(() =>
                              setPending((m) => {
                                const next = new Map(m);
                                next.delete(key);
                                return next;
                              }),
                            );
                          }}
                        />
                        <span className="room-picker-title">{x.title || 'Untitled'}</span>
                        {via && <span className="hint room-picker-via">with “{via}”</span>}
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
        </section>
      )}
      {status && (
        <p className="hint room-status" role="status" data-testid="room-status">
          {status}
        </p>
      )}
      <div
        ref={canvas}
        className={`room-canvas${dropOver ? ' drop-over' : ''}`}
        style={{ minWidth: maxX + 120, minHeight: Math.max(420, maxY + 160) }}
        onDragOver={(e) => {
          if (!isItemDrag(e) && !isOutsideDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropOver(true);
        }}
        onDragLeave={(e) => {
          if (!canvas.current?.contains(e.relatedTarget as Node)) setDropOver(false);
        }}
        onDrop={onDrop}
        data-testid="room-canvas"
      >
        <svg className="room-lines" aria-hidden width={maxX + 120} height={Math.max(420, maxY + 160)}>
          {view.links.map((l) => {
            const a = box(l.from);
            const b = box(l.to);
            if (!a || !b) return null;
            // From the side facing the other, to the side facing back.
            const right = b.x > a.x + a.w;
            const left = b.x + b.w < a.x;
            const p1 = right
              ? { x: a.x + a.w, y: a.y + Math.min(a.h / 2, 40) }
              : left
                ? { x: a.x, y: a.y + Math.min(a.h / 2, 40) }
                : b.y > a.y
                  ? { x: a.x + a.w / 2, y: a.y + a.h }
                  : { x: a.x + a.w / 2, y: a.y };
            const p2 = right
              ? { x: b.x, y: b.y + Math.min(b.h / 2, 40) }
              : left
                ? { x: b.x + b.w, y: b.y + Math.min(b.h / 2, 40) }
                : b.y > a.y
                  ? { x: b.x + b.w / 2, y: b.y }
                  : { x: b.x + b.w / 2, y: b.y + b.h };
            const horizontal = right || left;
            const bend = horizontal ? Math.max(40, Math.abs(p2.x - p1.x) / 2) : Math.max(30, Math.abs(p2.y - p1.y) / 2);
            const d = horizontal
              ? `M${p1.x},${p1.y} C${p1.x + (right ? bend : -bend)},${p1.y} ${p2.x + (right ? -bend : bend)},${p2.y} ${p2.x},${p2.y}`
              : `M${p1.x},${p1.y} C${p1.x},${p1.y + (b.y > a.y ? bend : -bend)} ${p2.x},${p2.y + (b.y > a.y ? -bend : bend)} ${p2.x},${p2.y}`;
            const words = l.kinds.map(roomLinkWords).join(' · ');
            return (
              <g key={`${l.from}>${l.to}`} className="room-line" data-testid="room-line">
                <path d={d} />
                <text x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 6} textAnchor="middle">
                  {words}
                </text>
              </g>
            );
          })}
        </svg>
        {view.clusters.length === 0 && (
          <div className="room-empty" data-testid="room-empty">
            <p className="empty-title">Nothing in this room yet</p>
            <p className="hint">
              Drag threads, sources and notes here from the sidebar, or drop files and links from your computer to read them
              as sources. Or choose what is in it.
            </p>
          </div>
        )}
        {view.clusters.map((c) => {
          const at = spots.get(c.key);
          const [head, ...rest] = c.cards;
          if (!head) return null;
          const lines = view.links.filter((l) => l.from === c.key || l.to === c.key);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: moved by pointer; Alt+arrows on its cards do the same
            <div
              key={c.key}
              className="room-cluster"
              data-cluster={c.key}
              style={at ? { left: at.x, top: at.y } : { left: 0, top: 0, visibility: 'hidden' }}
              onPointerDown={(e) => down(e, c.key)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => nudge(e, c)}
              data-testid="room-cluster"
              data-key={c.key}
            >
              {cardButton(head, true)}
              {rest.length > 0 && (
                <ul className="room-members">
                  {rest.map((x) => (
                    <li key={`${x.kind}:${x.id}`}>{cardButton(x, false)}</li>
                  ))}
                </ul>
              )}
              {lines.length > 0 && (
                <p className="sr-only">
                  {lines
                    .map((l) => {
                      const other = clusterOf.get(l.from === c.key ? l.to : l.from);
                      return `${l.kinds.map(roomLinkWords).join(', ')} ${other ? headOf(other).title : ''}`;
                    })
                    .join('; ')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
