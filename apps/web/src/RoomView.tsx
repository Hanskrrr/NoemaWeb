// A room (ADR 0026): what is learnt about one subject, as a map. Things that
// belong together are one cluster: a source with the threads asked about it
// and the notes made from them. Each card says what was done there: questions
// asked, side questions not come back from. Lines join clusters only where
// something links them, and say how. Clusters stay where they are put: Noema
// places new ones, and you move them by dragging (or Alt+arrow keys).

import {
  type Curve,
  type ItemLink,
  LINK_KINDS,
  LINK_WORDS,
  type LinkKind,
  type NoteSummary,
  placeClusters,
  placeLabels,
  type RoomKind,
  type RoomView as RoomViewData,
  roomLinkWords,
  settleClusters,
  type Source,
  type Thread,
  threadOf,
  ulid,
  type VaultTarget,
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
// Columns stand far enough apart for the words of a link between them; a
// cluster that grows into the one below pushes it down (ADR 0027 addendum).
const GAP = 128;
const ROW_GAP = 48;
const SETTLE_GAP = 24;
const EDGE = 24;
const STEP = 24;

type Spot = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
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
  onOpenTarget,
  onDeleted,
}: {
  roomId: string;
  /** A key point's words, where they are in the original. */
  onOpenTarget: (target: VaultTarget) => void;
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
  // Links between cards (ADR 0027): where each card is, the link being edited, a link being drawn.
  const [cardBoxes, setCardBoxes] = useState<Map<string, Box>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ key: string; title: string } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [roomWidth, setRoomWidth] = useState(0);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; sx: number; sy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const swallow = useRef(false);

  const load = useCallback(async () => {
    try {
      const v = await api.room(roomId);
      setView(v);
      setProblem(null);
      // Where clusters are on screen wins over what the server last heard (a drag may be on its way).
      setSpots((had) => {
        const next = new Map<string, Spot>();
        for (const c of v.clusters) {
          const mine = had.get(c.key);
          if (mine) next.set(c.key, mine);
          else if (c.x !== null && c.y !== null) next.set(c.key, { x: c.x, y: c.y });
        }
        return next;
      });
    } catch (err) {
      setProblem(err instanceof ApiFailure ? err.message : 'The room could not be opened.');
    }
  }, [roomId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn again whenever a room changes
  useEffect(() => {
    void load();
  }, [load, rooms.changed]);

  // While the room is being read, it is drawn again as summaries come in.
  const reading = view?.reading ?? null;
  const busy = reading?.phase === 'summaries' || reading?.phase === 'links';
  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => void load(), 700);
    return () => window.clearTimeout(t);
  }, [busy, view, load]);
  const startReading = async () => {
    try {
      const r = await api.readRoom(roomId);
      setView((v) => (v ? { ...v, reading: r.reading } : v));
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The room could not be read.');
    }
  };

  // Drawing a link: pick the other card; Escape stops.
  useEffect(() => {
    if (!linking) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setLinking(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linking]);
  const linkTo = async (to: { kind: RoomKind; id: string }) => {
    const from = linking;
    setLinking(null);
    if (!from) return;
    const at = from.key.indexOf(':');
    try {
      const made = await api.createLink(notebookId, ulid(), { kind: from.key.slice(0, at) as RoomKind, id: from.key.slice(at + 1) }, to, 'related');
      await load();
      setEditing(made.id);
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The link could not be made.');
    }
  };
  const changeLink = async (id: string, patch: Parameters<typeof api.updateLink>[1] | 'delete') => {
    try {
      if (patch === 'delete') await api.deleteLink(id);
      else await api.updateLink(id, patch);
      await load();
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The link could not be changed.');
    }
  };

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
    // Where each card is in the room, for the links.
    const origin = canvas.current.getBoundingClientRect();
    const boxes = new Map<string, Box>();
    for (const el of canvas.current.querySelectorAll<HTMLElement>('[data-card-key]')) {
      const r = el.getBoundingClientRect();
      boxes.set(el.dataset.cardKey as string, {
        x: Math.round(r.left - origin.left),
        y: Math.round(r.top - origin.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    const moved =
      boxes.size !== cardBoxes.size ||
      [...boxes].some(([k, b]) => {
        const o = cardBoxes.get(k);
        return !o || o.x !== b.x || o.y !== b.y || o.w !== b.w || o.h !== b.h;
      });
    if (moved) setCardBoxes(boxes);
    const width = canvas.current.clientWidth;
    if (width !== roomWidth) setRoomWidth(width);
    const unplaced = view.clusters.filter((c) => !spots.has(c.key));
    if (unplaced.length > 0) {
      const columns = Math.max(1, Math.floor((width - 2 * EDGE + GAP) / (WIDTH + GAP)));
      const placed = placeClusters(
        view.clusters.map((c) => ({
          key: c.key,
          w: measured.get(c.key)?.w ?? WIDTH,
          h: measured.get(c.key)?.h ?? 120,
          x: spots.get(c.key)?.x ?? null,
          y: spots.get(c.key)?.y ?? null,
        })),
        { columns, columnWidth: WIDTH, gap: GAP, rowGap: ROW_GAP, left: EDGE, top: EDGE },
      );
      const next = new Map(spots);
      for (const [k, at] of placed) next.set(k, at);
      setSpots(next);
      save(unplaced.map((c) => ({ cluster: c, at: placed.get(c.key) as Spot })));
      return;
    }
    // Clusters that grew into each other (a summary came in) or were dropped on each other: set apart.
    if (drag.current) return;
    const settled = settleClusters(
      view.clusters.flatMap((c) => {
        const at = spots.get(c.key);
        const size = measured.get(c.key);
        return at && size ? [{ key: c.key, ...at, ...size }] : [];
      }),
      SETTLE_GAP,
    );
    if (settled.size === 0) return;
    const next = new Map(spots);
    for (const [k, at] of settled) next.set(k, at);
    setSpots(next);
    save(view.clusters.filter((c) => settled.has(c.key)).map((c) => ({ cluster: c, at: settled.get(c.key) as Spot })));
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
    // Drawn again, so a cluster dropped onto another is set apart.
    setSpots((m) => new Map(m));
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
      { columns, columnWidth: WIDTH, gap: GAP, rowGap: ROW_GAP, left: EDGE, top: EDGE },
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
    const key = `${c.kind}:${c.id}`;
    const gist = view.gists[key];
    const pickable = linking !== null && linking.key !== key;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut; its button opens the thing, the menu key works on it
      <div
        className={`room-card${head ? ' is-head' : ''} kind-${c.kind}${pickable ? ' is-target' : ''}${linking?.key === key ? ' is-linking' : ''}`}
        style={{ '--heat': Math.min(1, c.marks.questions / 12) } as CSSProperties}
        onMouseEnter={() => setFocusKey(key)}
        onMouseLeave={() => setFocusKey((k) => (k === key ? null : k))}
        onFocus={() => setFocusKey(key)}
        onContextMenu={(e) =>
          openMenu(
            e,
            roomMenu(rooms, { kind: c.kind, id: c.id, title: c.title }, [
              { label: 'Open', onSelect: () => onOpen(c.kind, c.id) },
              {
                label: 'Link to…',
                hint: 'Then pick the card it links to',
                onSelect: () => setLinking({ key, title: c.title }),
                testId: 'menu-link-to',
              },
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
        data-card-key={key}
        data-testid="room-card"
        data-kind={c.kind}
        data-id={c.id}
      >
        <button
          type="button"
          className="room-card-open"
          onClick={() => {
            if (swallow.current) return;
            if (pickable) void linkTo({ kind: c.kind, id: c.id });
            else if (!linking) onOpen(c.kind, c.id);
          }}
          title={pickable ? `Link “${linking?.title}” to this` : c.quote ? `Asked about “${c.quote}”` : undefined}
          data-testid="room-card-open"
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
        {gist && (
          <div className={`room-gist${gist.fresh ? '' : ' is-stale'}`} data-testid="room-gist">
            <p title={gist.fresh ? `Written by ${gist.model}` : 'Written before it changed: read the room again'}>
              <span className="room-gist-by">AI{gist.fresh ? '' : ', older'} · </span>
              {gist.text}
            </p>
            {gist.points.length > 0 && (
              <ul className="room-points">
                {gist.points.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                  <li key={i}>
                    {p.target ? (
                      <button
                        type="button"
                        className="room-point"
                        onClick={() => p.target && onOpenTarget(p.target)}
                        title={p.target.quote ? `“${p.target.quote}”` : 'Open where it is'}
                        data-testid="room-point"
                      >
                        <span aria-hidden>↗ </span>
                        {p.text}
                      </button>
                    ) : (
                      <span className="room-point is-unfound" title="Its words were not found in the original">
                        {p.text}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
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
          {view.clusters.length > 0 && (
            <button
              type="button"
              className={view.unread > 0 && !busy ? 'primary' : 'quiet'}
              onClick={() => void startReading()}
              disabled={busy}
              title="The AI writes each thing a short summary, its points linked to the words they come from, then suggests links between them for you to keep or dismiss. It uses your model."
              data-testid="room-read"
            >
              {busy ? 'Reading…' : view.unread > 0 ? `Read with AI · ${view.unread} new` : 'Read again'}
            </button>
          )}
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
      {reading && (
        <p className={`hint room-status${reading.phase === 'failed' ? ' is-error' : ''}`} role="status" data-testid="room-reading">
          {reading.phase === 'summaries'
            ? `Summarizing ${Math.min(reading.done + 1, reading.total)} of ${reading.total}…`
            : reading.phase === 'links'
              ? 'Looking for links between them…'
              : reading.phase === 'failed'
                ? reading.error
                : `Read. ${reading.total ? `${reading.total === 1 ? '1 summary' : `${reading.total} summaries`} written` : 'Nothing new to summarize'}; ${plural(reading.suggested, 'link')} suggested${reading.suggested ? ': dashed until you keep them' : ''}.${reading.error ? ` ${reading.error}` : ''}`}
        </p>
      )}
      {linking && (
        <p className="room-linking" role="status" data-testid="room-linking">
          Pick the card “{linking.title || 'Untitled'}” links to. Escape stops.
          <button type="button" className="quiet inline" onClick={() => setLinking(null)}>
            Stop
          </button>
        </p>
      )}
      {/* The map scrolls sideways in its own space: with the Assistant beside it, nothing goes under it. */}
      <div className="room-map" data-testid="room-map">
      <div
        ref={canvas}
        className={`room-canvas${dropOver ? ' drop-over' : ''}`}
        style={{ minWidth: maxX + EDGE, minHeight: Math.max(420, maxY + 160) }}
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
        <svg className="room-lines" aria-hidden width={maxX + EDGE} height={Math.max(420, maxY + 160)}>
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
                <text x={p1.x + (p2.x - p1.x) * 0.3} y={p1.y + (p2.y - p1.y) * 0.3 - 6} textAnchor="middle">
                  {words}
                </text>
              </g>
            );
          })}
        </svg>
        <ItemLinks
          links={view.itemLinks}
          boxes={cardBoxes}
          titles={cards}
          focus={focusKey}
          editing={editing}
          onEdit={setEditing}
          onChange={(id, patch) => void changeLink(id, patch)}
          width={maxX + EDGE}
          height={Math.max(420, maxY + 160)}
          room={roomWidth}
        />
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
      </div>
    </section>
  );
}

/** How a link reads, from its first end: its own words, or its kind's. */
const linkWords = (l: ItemLink) => l.label || LINK_WORDS[l.kind];

/**
 * Links between cards (ADR 0027): a line with an arrow from one end to the
 * other, and its words on it; a suggested one dashed until it is kept. Its
 * words open the editor: keep it, change its kind or words, turn it around,
 * dismiss or delete it.
 */
function ItemLinks({
  links,
  boxes,
  titles,
  focus,
  editing,
  onEdit,
  onChange,
  width,
  height,
  room,
}: {
  links: ItemLink[];
  boxes: Map<string, Box>;
  titles: Map<string, RoomCard>;
  focus: string | null;
  editing: string | null;
  onEdit: (id: string | null) => void;
  onChange: (id: string, patch: Parameters<typeof api.updateLink>[1] | 'delete') => void;
  width: number;
  height: number;
  /** How wide the room is on screen: a link between cards one above the other goes round the side with room. */
  room: number;
}) {
  const labelEls = useRef(new Map<string, HTMLElement>());
  const [labelSizes, setLabelSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  const drawn = links.flatMap((l) => {
    const from = `${l.from.kind}:${l.from.id}`;
    const to = `${l.to.kind}:${l.to.id}`;
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b) return [];
    // Side by side: from the facing sides. One above the other: out of a side and back in.
    const right = b.x >= a.x + a.w - 4;
    const left = b.x + b.w <= a.x + 4;
    const ay = a.y + Math.min(a.h / 2, 28);
    const by = b.y + Math.min(b.h / 2, 28);
    let curve: Curve;
    if (right || left) {
      const x1 = right ? a.x + a.w : a.x;
      const x2 = right ? b.x : b.x + b.w;
      const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
      curve = [
        { x: x1, y: ay },
        { x: x1 + bend, y: ay },
        { x: x2 - bend, y: by },
        { x: x2, y: by },
      ];
    } else {
      const outer = Math.max(a.x + a.w, b.x + b.w);
      const inner = Math.min(a.x, b.x);
      const toRight = outer + 150 <= room || inner < 150;
      const x1 = toRight ? a.x + a.w : a.x;
      const x2 = toRight ? b.x + b.w : b.x;
      const out = toRight ? outer + 76 : inner - 76;
      curve = [
        { x: x1, y: ay },
        { x: out, y: ay },
        { x: out, y: by },
        { x: x2, y: by },
      ];
    }
    const [p0, p1, p2, p3] = curve;
    const d = `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
    return [{ l, from, to, d, curve }];
  });
  const text = (l: ItemLink) => (l.status === 'suggested' ? `${linkWords(l)}?` : linkWords(l));
  // Words go on their line where they cover no card and no other words; sizes are measured once drawn.
  const spots = placeLabels(
    drawn.map((x) => ({
      id: x.l.id,
      curve: x.curve,
      ...(labelSizes.get(x.l.id) ?? { w: Math.min(116, 16 + text(x.l).length * 6.5), h: 20 }),
    })),
    [...boxes.values()],
  );
  useLayoutEffect(() => {
    const next = new Map<string, { w: number; h: number }>();
    for (const [id, el] of labelEls.current) next.set(id, { w: el.offsetWidth, h: el.offsetHeight });
    const same = next.size === labelSizes.size && [...next].every(([id, z]) => labelSizes.get(id)?.w === z.w && labelSizes.get(id)?.h === z.h);
    if (!same) setLabelSizes(next);
  });
  const mid = (id: string) => spots.get(id) ?? { x: 0, y: 0 };
  const lit = (x: { from: string; to: string; l: ItemLink }) => !focus || x.from === focus || x.to === focus || x.l.id === editing;
  const open = drawn.find((x) => x.l.id === editing);
  return (
    <>
      <svg className="item-lines" aria-hidden width={width} height={height}>
        <defs>
          <marker id="item-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1 1L9 5L1 9" />
          </marker>
        </defs>
        {drawn.map((x) => (
          <path
            key={x.l.id}
            d={x.d}
            className={`item-line is-${x.l.status}${lit(x) ? '' : ' is-faded'}`}
            markerEnd="url(#item-arrow)"
          />
        ))}
      </svg>
      {drawn.map((x) => (
        <button
          key={x.l.id}
          ref={(el) => {
            if (el) labelEls.current.set(x.l.id, el);
            else labelEls.current.delete(x.l.id);
          }}
          type="button"
          className={`link-label is-${x.l.status}${lit(x) ? '' : ' is-faded'}${x.l.id === editing ? ' is-open' : ''}`}
          style={{ left: mid(x.l.id).x, top: mid(x.l.id).y }}
          onClick={() => onEdit(x.l.id === editing ? null : x.l.id)}
          aria-expanded={x.l.id === editing}
          title={`“${titles.get(x.from)?.title ?? ''}” ${linkWords(x.l)} “${titles.get(x.to)?.title ?? ''}”${x.l.why ? ` · ${x.l.why}` : ''}`}
          data-testid="link-label"
          data-status={x.l.status}
          data-link-id={x.l.id}
        >
          {text(x.l)}
        </button>
      ))}
      {open && (
        <LinkEditor
          key={`${open.l.id}:${open.l.updatedAt}`}
          link={open.l}
          from={titles.get(open.from)?.title ?? ''}
          to={titles.get(open.to)?.title ?? ''}
          at={{ x: Math.min(Math.max(mid(open.l.id).x, 172), width - 172), y: mid(open.l.id).y }}
          onClose={() => onEdit(null)}
          onChange={(patch) => {
            if (patch === 'delete' || (typeof patch === 'object' && patch.status === 'dismissed')) onEdit(null);
            onChange(open.l.id, patch);
          }}
        />
      )}
    </>
  );
}

function LinkEditor({
  link,
  from,
  to,
  at,
  onClose,
  onChange,
}: {
  link: ItemLink;
  from: string;
  to: string;
  at: { x: number; y: number };
  onClose: () => void;
  onChange: (patch: Parameters<typeof api.updateLink>[1] | 'delete') => void;
}) {
  const [label, setLabel] = useState(link.label ?? '');
  const by = link.by === 'ai' ? 'Suggested by the AI' : link.by === 'assistant' ? 'Made by the Assistant' : 'Drawn by you';
  const saveLabel = () => {
    if ((link.label ?? '') !== label.trim()) onChange({ label: label.trim() || null });
  };
  return (
    <section
      className="link-editor"
      style={{ left: at.x, top: at.y + 18 }}
      aria-label="This link"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      data-testid="link-editor"
    >
      <p className="link-editor-says">
        “{from || 'Untitled'}” <strong>{link.label || LINK_WORDS[link.kind]}</strong> “{to || 'Untitled'}”
      </p>
      <p className="hint link-editor-by">
        {by}
        {link.status === 'suggested' ? ', not kept yet' : ''}
        {link.why ? `: ${link.why}` : '.'}
      </p>
      <div className="link-editor-row">
        <label>
          <span className="sr-only">Kind</span>
          <select
            value={link.kind}
            onChange={(e) => onChange({ kind: e.target.value as LinkKind })}
            data-testid="link-kind"
          >
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {LINK_WORDS[k]}
              </option>
            ))}
          </select>
        </label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveLabel();
          }}
          placeholder="Or your own words"
          aria-label="Your own words for this link"
          maxLength={200}
          data-testid="link-words"
        />
      </div>
      <div className="link-editor-row">
        {link.status === 'suggested' && (
          <button type="button" onClick={() => onChange({ status: 'accepted' })} data-testid="link-keep">
            Keep
          </button>
        )}
        <button type="button" className="quiet" onClick={() => onChange({ flip: true })} data-testid="link-flip">
          Turn around
        </button>
        {link.status === 'suggested' ? (
          <button type="button" className="quiet" onClick={() => onChange({ status: 'dismissed' })} data-testid="link-dismiss">
            Dismiss
          </button>
        ) : (
          <button type="button" className="quiet" onClick={() => onChange('delete')} data-testid="link-delete">
            Delete
          </button>
        )}
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
