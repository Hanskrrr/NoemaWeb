// A room (ADR 0026): what is learnt about one subject, as a map. Things that
// belong together are one cluster: a source with the threads asked about it
// and the notes made from them. Each card says what was done there: questions
// asked, side questions not come back from. Lines join clusters only where
// something links them, and say how. Clusters stay where they are put: Noema
// places new ones, and you move them by dragging (or Alt+arrow keys).
// Rooms in rooms (ADR 0032): a room inside this one is a door, showing what it
// holds and its brief; it opens that room, and a card dropped on it goes in.

import {
  type Curve,
  type ItemLink,
  LINK_KINDS,
  type Concept,
  LINK_WORDS,
  type LinkKind,
  type NoteSummary,
  type OpenBranch,
  type Room,
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
  wouldLoop,
} from '@noema/core';
import {
  type CSSProperties,
  type DragEvent,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ApiFailure, api } from './api.ts';
import { openMenu } from './ContextMenu.tsx';
import { deleteItems, useItems } from './itemMenu.ts';
import { addDropped, droppedItem, droppedRoom, isItemDrag, isOutsideDrag, isRoomDrag, takeOutsideDrop } from './drag.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { Orb } from './LivingFrame.tsx';
import { WebFinds } from './MessageView.tsx';
import { isTopic, RoomConcepts } from './RoomConcepts.tsx';
import { RoomFolders } from './RoomFolders.tsx';
import { type PathNode, RoomPath } from './RoomPath.tsx';
import { roomMenu, useRooms } from './Rooms.tsx';
import { boardParents, boardTopicGroups, type BoardPreferences, type CardSize, linkCardKey, resizeCard } from './roomBoard.ts';
import { CONCEPT_GLYPH, type Door, day, GLYPH, holdsOf, kindName, marksOf, plural, type RoomCard, refOf } from './roomText.ts';
import { keys, storage } from './storage.ts';

const WIDTH = 264;
// Columns stand far enough apart for the words of a link between them; a
// cluster that grows into the one below pushes it down (ADR 0027 addendum).
const GAP = 128;
const ROW_GAP = 48;
const SETTLE_GAP = 24;
const EDGE = 24;
const STEP = 24;
const TOPIC_TOP = 62;
const TOPIC_GAP = 60;

type Spot = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
type Cluster = RoomViewData['clusters'][number];
/** A door's place on the map is kept by "room:id", beside the clusters' "kind:id". */
const doorKey = (id: string) => `room:${id}`;
const isDoorKey = (key: string) => key.startsWith('room:');

/** The ways to see a room (ADR 0035), one question each; each room opens in the way it was last seen. */
export type RoomMode = 'overview' | 'folders' | 'concepts' | 'path' | 'board';
const MODES: Array<{ mode: RoomMode; label: string; glyph: string; title: string }> = [
  { mode: 'overview', label: 'Overview', glyph: '◫', title: 'Resume a question and find the room’s topics' },
  { mode: 'folders', label: 'Folders', glyph: '☰', title: 'As a list, like Finder: rooms inside are folders, things are files' },
  { mode: 'concepts', label: 'Concepts', glyph: '◎', title: 'As the key ideas it is about, each holding its things (ADR 0036)' },
  { mode: 'path', label: 'Path', glyph: '→', title: 'As an order to study in, from the links you kept' },
  { mode: 'board', label: 'Board', glyph: '▦', title: 'As a map you arrange: clusters, doors and the lines between them' },
];
const isMode = (m: unknown): m is RoomMode => MODES.some((x) => x.mode === m);
function modeOf(roomId: string): RoomMode {
  const mine = storage.getJson<Record<string, string>>(keys.roomViews, {})[roomId];
  if (isMode(mine)) return mine;
  const last = storage.get(keys.roomViewLast);
  return isMode(last) ? last : 'overview';
}
function rememberMode(roomId: string, mode: RoomMode) {
  const all = storage.getJson<Record<string, string>>(keys.roomViews, {});
  storage.setJson(keys.roomViews, { ...all, [roomId]: mode });
  storage.set(keys.roomViewLast, mode);
}

export function RoomView({
  roomId,
  newlyCreated,
  onNewRoomHintConsumed,
  path,
  notebookId,
  threads,
  sources,
  notes,
  onOpen,
  onOpenTarget,
  onAddSource,
  onDeleted,
}: {
  roomId: string;
  newlyCreated: boolean;
  onNewRoomHintConsumed: () => void;
  /** The rooms passed through to get here, by their doors (ADR 0032). */
  path: string[];
  /** Add a source, which goes in this room (ADR 0030). */
  onAddSource: () => void;
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
  const items = useItems();
  const [view, setView] = useState<RoomViewData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [spots, setSpots] = useState<Map<string, Spot>>(new Map());
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  const [board, setBoard] = useState<BoardPreferences>(() => storage.getJson(keys.roomBoard(roomId), {}) ?? {});
  const density = board.density ?? 'normal';
  const [goal, setGoal] = useState(() => storage.get(keys.roomGoal(roomId)) ?? '');
  const [editingGoal, setEditingGoal] = useState(false);
  const [openBranches, setOpenBranches] = useState<OpenBranch[]>([]);
  const [boardFocus, setBoardFocus] = useState<string | null>(null);
  const [topicJump, setTopicJump] = useState<string | null>(null);
  const [allLinks, setAllLinks] = useState(false);
  const [nesting, setNesting] = useState<string | null>(null);
  const [nestDrop, setNestDrop] = useState<{ child: string; parent: string } | null>(null);
  const [nestDrag, setNestDrag] = useState<{ target: string | null; preview: { key: string; x: number; y: number } | null } | null>(null);
  const [dragSpot, setDragSpot] = useState<{ key: string; at: Spot } | null>(null);
  const [resizing, setResizing] = useState<{ key: string; size: CardSize } | null>(null);
  const [picking, setPicking] = useState(false);
  const [offerPicker, setOfferPicker] = useState(newlyCreated);
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Ticks in the picker show at once; the room catches up. A tick stays until the room says the same (a slower
  // room no longer makes it flick back), or for a few seconds if the change did not go through.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const roomMembers = view?.room.members;
  useEffect(() => {
    if (!newlyCreated) return;
    setOfferPicker(true);
    onNewRoomHintConsumed();
  }, [newlyCreated, onNewRoomHintConsumed]);
  useEffect(() => {
    const inRoom = new Set<string>(roomMembers ?? []);
    setPending((m) => {
      if (m.size === 0) return m;
      const next = new Map([...m].filter(([k, v]) => inRoom.has(k) !== v));
      return next.size === m.size ? m : next;
    });
  }, [roomMembers]);
  // Links between cards (ADR 0027): where each card is, the link being edited, a link being drawn.
  const [cardBoxes, setCardBoxes] = useState<Map<string, Box>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ key: string; title: string } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [roomWidth, setRoomWidth] = useState(0);
  const canvas = useRef<HTMLDivElement>(null);
  /** Each visible control starts one gesture. Coordinates do not depend on later React renders. */
  const gesture = useRef<{
    cardKey: string;
    clusterKey: string;
    sx: number;
    sy: number;
    x0: number;
    y0: number;
    mode: 'connect' | 'lift' | 'resize';
    started: boolean;
    moveGroup: boolean;
    preview: boolean;
    pointerId: number;
    last: Spot;
    size: CardSize;
    nextSize: CardSize;
    over: string | null;
    overDoor: string | null;
  } | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: string; x: number; y: number; over: string | null; overDoor: string | null } | null>(null);
  // Rooms in rooms (ADR 0032): putting a room in this one; a card just put in a room inside.
  const [puttingRoom, setPuttingRoom] = useState(false);
  const [putInto, setPutInto] = useState<{ ref: { kind: RoomKind; id: string }; title: string; door: string } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mode, setMode] = useState<RoomMode>(() => modeOf(roomId));
  useEffect(() => storage.setJson(keys.roomBoard(roomId), board), [board, roomId]);
  useLayoutEffect(() => {
    if (mode !== 'board' || !topicJump || !view) return;
    const heading = [...(canvas.current?.querySelectorAll<HTMLElement>('[data-board-topic]') ?? [])].find((el) => el.dataset.boardTopic === topicJump);
    heading?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setTopicJump(null);
  }, [mode, topicJump, view]);
  useEffect(() => {
    if (mode !== 'overview') return;
    let active = true;
    void api.openBranches(notebookId).then(({ branches }) => {
      if (active) setOpenBranches(branches);
    }, () => {});
    return () => { active = false; };
  }, [mode, notebookId]);
  // The concept chosen in Concepts (ADR 0036); a question started about one, waiting in the bar at the foot.
  const [conceptOn, setConceptOn] = useState<string | null>(null);
  const [askSeed, setAskSeed] = useState<{ text: string; n: number } | null>(null);
  const show = (m: RoomMode) => {
    setMode(m);
    rememberMode(roomId, m);
  };
  const swallow = useRef(false);

  const load = useCallback(async () => {
    try {
      const v = await api.room(roomId);
      setView(v);
      setProblem(null);
      // Where clusters are on screen wins over what the server last heard (a drag may be on its way).
      setSpots((had) => {
        const next = new Map<string, Spot>();
        const keep = (key: string, x: number | null, y: number | null) => {
          const mine = had.get(key);
          if (mine) next.set(key, mine);
          else if (x !== null && y !== null) next.set(key, { x, y });
        };
        for (const c of v.clusters) keep(c.key, c.x, c.y);
        for (const d of v.doors) keep(doorKey(d.id), d.x, d.y);
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
  const busy = reading?.phase === 'summaries' || reading?.phase === 'links' || reading?.phase === 'concepts' || reading?.phase === 'brief';
  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => void load(), 700);
    return () => window.clearTimeout(t);
  }, [busy, load]);
  const startReading = async () => {
    try {
      const r = await api.readRoom(roomId);
      setView((v) => (v ? { ...v, reading: r.reading } : v));
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The room could not be read.');
    }
  };
  /** Stop the reading (ADR 0038): what was read is kept, the next reading carries on. */
  const stopReading = async () => {
    try {
      await api.stopReading(roomId);
      await load();
    } catch {
      setStatus('The reading could not be stopped.');
    }
  };

  // Escape also closes a link editor opened by dragging, when focus is still on the card.
  useEffect(() => {
    if (!linking && !nesting && !editing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinking(null);
        setNesting(null);
        setEditing(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linking, nesting, editing]);
  const linkTo = async (to: { kind: RoomKind; id: string }) => {
    const from = linking;
    setLinking(null);
    if (from) await connect(from.key, `${to.kind}:${to.id}`);
  };
  /** A line drawn from one card to another: made at once, then the AI says what it means (ADR 0029). */
  const connect = async (fromKey: string, toKey: string) => {
    setBoardFocus(fromKey);
    const same = view?.itemLinks.find((l) => {
      const a = linkCardKey(l.from);
      const b = linkCardKey(l.to);
      return (a === fromKey && b === toKey) || (a === toKey && b === fromKey);
    });
    if (same) {
      setStatus('Those two are linked already: here is that link.');
      if (same.status === 'suggested') setReviewing(true);
      else setEditing(same.id);
      return;
    }
    let made: ItemLink;
    try {
      made = await api.createLink(notebookId, ulid(), refOf(fromKey), refOf(toKey), 'related');
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The link could not be made.');
      return;
    }
    setStatus(null);
    setChoosing(made.id);
    setEditing(made.id);
    await load();
    try {
      await api.chooseLink(made.id);
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : 'The AI could not choose this time. Pick the kind yourself.');
    } finally {
      setChoosing(null);
      await load();
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
  /** Where clusters (by their first card) and doors were put, told to the server. */
  const save = (places: Array<{ key: string; at: Spot }>) => {
    const items = places.filter((p) => !isDoorKey(p.key)).map(({ key, at }) => ({ ...refOf(key), x: at.x, y: at.y }));
    const doors = places.filter((p) => isDoorKey(p.key)).map(({ key, at }) => ({ room: key.slice('room:'.length), x: at.x, y: at.y }));
    if (items.length) void api.placeInRoom(roomId, items).catch(() => {});
    if (doors.length) void api.placeDoors(roomId, doors).catch(() => {});
  };
  const concepts = view?.concepts ?? [];
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const topicOf = (c: Concept): Concept | null => {
    let at: Concept | undefined = c;
    for (let i = 0; at?.home && i < 20; i++) at = conceptById.get(at.home.id);
    return at && at.id !== c.id && isTopic(at, concepts) ? at : null;
  };
  const topicsByCard = new Map<string, Array<{ id: string; title: string }>>();
  for (const concept of concepts) {
    if (concept.status !== 'kept') continue;
    const topic = topicOf(concept);
    if (topic?.status !== 'kept') continue;
    for (const key of concept.members) {
      const topics = topicsByCard.get(key) ?? [];
      if (!topics.some((t) => t.id === topic.id)) topicsByCard.set(key, [...topics, topic]);
    }
  }
  const parents = boardParents(view?.clusters ?? [], board);
  const containing = new Set(parents.values());
  const canNestCard = (child: string, parent: string) =>
    child !== parent && !parents.has(parent) && parents.get(child) !== parent && !containing.has(child);
  const clusters = (view?.clusters ?? []).flatMap((cluster) => {
    const cards = cluster.cards.filter((card) => !parents.has(linkCardKey(card)));
    return cards.length ? [{ ...cluster, key: linkCardKey(cards[0] as RoomCard) as Cluster['key'], cards }] : [];
  });
  const doors = (view?.doors ?? []).map((d) => doorKey(d.id));
  const blocks = [...doors, ...clusters.map((c) => c.key)];
  const topicLayout = board.mode !== 'free';
  const boardSize = (key: string) => (resizing?.key === key ? resizing.size : board.sizes?.[key]);
  const topicGroups = boardTopicGroups(clusters, doors, topicsByCard, board.order ?? []);
  const topicSpots = new Map<string, Spot>();
  let topicX = EDGE;
  const topicColumns = topicGroups.map((group) => {
    const width = Math.max(WIDTH, ...group.keys.map((key) => boardSize(key)?.w ?? sizes.get(key)?.w ?? WIDTH));
    let y = TOPIC_TOP;
    for (const key of group.keys) {
      topicSpots.set(key, { x: topicX, y });
      y += (sizes.get(key)?.h ?? 120) + ROW_GAP / 2;
    }
    const column = { ...group, x: topicX, width };
    topicX += width + TOPIC_GAP;
    return column;
  });
  const boardSpot = (key: string) => dragSpot?.key === key ? dragSpot.at : (topicLayout ? topicSpots : spots).get(key);
  const reorder = (key: string, y: number) => {
    const group = topicGroups.find((g) => g.keys.includes(key));
    if (!group) return;
    const next = group.keys.filter((k) => k !== key);
    const before = next.findIndex((k) => y < (topicSpots.get(k)?.y ?? 0) + (sizes.get(k)?.h ?? 120) / 2);
    next.splice(before < 0 ? next.length : before, 0, key);
    setBoard((state) => ({
      ...state,
      order: [...topicGroups.filter((g) => g !== group).flatMap((g) => g.keys), ...next],
    }));
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
    if (topicLayout) return;
    const all = blocks;
    const unplaced = all.filter((k) => !spots.has(k));
    if (unplaced.length > 0) {
      const columns = Math.max(1, Math.floor((width - 2 * EDGE + GAP) / (WIDTH + GAP)));
      const placed = placeClusters(
        all.map((k) => ({
          key: k,
          w: measured.get(k)?.w ?? WIDTH,
          h: measured.get(k)?.h ?? 120,
          x: spots.get(k)?.x ?? null,
          y: spots.get(k)?.y ?? null,
        })),
        { columns, columnWidth: WIDTH, gap: GAP, rowGap: ROW_GAP, left: EDGE, top: EDGE },
      );
      const next = new Map(spots);
      for (const [k, at] of placed) next.set(k, at);
      setSpots(next);
      save(unplaced.map((k) => ({ key: k, at: placed.get(k) as Spot })));
      return;
    }
    // Clusters that grew into each other (a summary came in) or were dropped on each other: set apart.
    if (gesture.current?.started) return;
    const settled = settleClusters(
      all.flatMap((k) => {
        const at = spots.get(k);
        const size = measured.get(k);
        return at && size ? [{ key: k, ...at, ...size }] : [];
      }),
      SETTLE_GAP,
    );
    if (settled.size === 0) return;
    const next = new Map(spots);
    for (const [k, at] of settled) next.set(k, at);
    setSpots(next);
    save([...settled].map(([key, at]) => ({ key, at })));
  });

  // The grip, port and resize corner are distinct targets. A door still moves by its surface.
  const down = (e: PointerEvent<HTMLDivElement>, key: string) => {
    if (e.button !== 0 || linking || nesting || gesture.current) return;
    const target = e.target as HTMLElement;
    const control = target.closest<HTMLElement>('[data-board-gesture]');
    const kind = control?.dataset.boardGesture;
    const mode = kind === 'connect' || kind === 'lift' || kind === 'resize' ? kind : isDoorKey(key) ? 'lift' : null;
    if (!mode) return;
    const at = boardSpot(key);
    if (!at) return;
    const cardKey = target.closest<HTMLElement>('[data-card-key]')?.dataset.cardKey ?? key;
    const moveGroup = cardKey === key;
    // A preview lets us target another member of the same source/conversation group.
    const preview = !isDoorKey(key) && (!moveGroup || (clusters.find((c) => c.key === key)?.cards.length ?? 0) > 1);
    const size = boardSize(key) ?? { w: sizes.get(key)?.w ?? WIDTH, h: cardBoxes.get(key)?.h ?? 120 };
    gesture.current = {
      cardKey, clusterKey: key, sx: e.clientX, sy: e.clientY, x0: at.x, y0: at.y,
      mode, started: false, moveGroup, preview, pointerId: e.pointerId, last: at, size, nextSize: size, over: null, overDoor: null,
    };
    (control ?? target).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.started) {
      if (Math.hypot(dx, dy) < 4) return;
      g.started = true;
      if (g.mode === 'lift' && g.moveGroup) setLifted(g.clusterKey);
    }
    if (g.mode === 'lift') {
      g.last = { x: topicLayout ? g.x0 : Math.max(0, g.x0 + dx), y: Math.max(topicLayout ? TOPIC_TOP : 0, g.y0 + dy) };
      if (g.moveGroup && !g.preview) setDragSpot({ key: g.clusterKey, at: g.last });
      if (!isDoorKey(g.cardKey)) {
        const hits = document.elementsFromPoint(e.clientX, e.clientY);
        const under = hits.flatMap((el) => {
          const card = el.closest<HTMLElement>('[data-card-key]')?.dataset.cardKey;
          const group = el.closest<HTMLElement>('[data-nest-parent]')?.dataset.nestParent;
          return [card, group].filter((key): key is string => !!key);
        }).find((key) => canNestCard(g.cardKey, key));
        g.over = under ?? null;
        const origin = canvas.current?.getBoundingClientRect();
        setNestDrag({
          target: g.over,
          preview: g.preview && origin ? { key: g.cardKey, x: e.clientX - origin.left + 12, y: e.clientY - origin.top + 12 } : null,
        });
      }
      return;
    }
    if (g.mode === 'resize') {
      g.nextSize = resizeCard(g.size.w + dx, g.size.h + dy);
      setResizing({ key: g.clusterKey, size: g.nextSize });
      return;
    }
    const origin = canvas.current?.getBoundingClientRect();
    if (!origin) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const hit = under?.closest<HTMLElement>('[data-card-key]')?.dataset.cardKey ?? null;
    g.over = hit && hit !== g.cardKey ? hit : null;
    // Over a door: let go, and the thing goes in that room (ADR 0032).
    g.overDoor = g.over ? null : (under?.closest<HTMLElement>('[data-door-id]')?.dataset.doorId ?? null);
    setConnecting({ from: g.cardKey, x: e.clientX - origin.left, y: e.clientY - origin.top, over: g.over, overDoor: g.overDoor });
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (!g.started) return;
    swallow.current = true;
    setTimeout(() => {
      swallow.current = false;
    }, 0);
    if (g.mode === 'lift') {
      setLifted(null);
      setDragSpot(null);
      setNestDrag(null);
      if (g.over) {
        setNestDrop({ child: g.cardKey, parent: g.over });
        return;
      }
      if (!g.moveGroup) return;
      if (topicLayout) reorder(g.clusterKey, g.last.y + (sizes.get(g.clusterKey)?.h ?? 120) / 2);
      else {
        setSpots((m) => new Map(m).set(g.clusterKey, g.last));
        save([{ key: g.clusterKey, at: g.last }]);
      }
      return;
    }
    if (g.mode === 'resize') {
      setBoard((state) => ({ ...state, sizes: { ...state.sizes, [g.clusterKey]: g.nextSize } }));
      setResizing(null);
      return;
    }
    setConnecting(null);
    if (g.over) void connect(g.cardKey, g.over);
    else if (g.overDoor) void putInDoor(g.cardKey, g.overDoor);
  };
  /** A card drawn onto a door goes in that room too; it stays here until taken out (ADR 0032). */
  const putInDoor = async (cardKey: string, doorId: string) => {
    const ref = refOf(cardKey);
    const card = view?.clusters.flatMap((c) => c.cards).find((c) => c.kind === ref.kind && c.id === ref.id);
    const door = view?.doors.find((d) => d.id === doorId);
    await rooms.add(doorId, [ref]);
    setPutInto({ ref, title: card?.title ?? '', door: door?.title ?? '' });
  };
  const cancel = () => {
    gesture.current = null;
    setLifted(null);
    setConnecting(null);
    setDragSpot(null);
    setNestDrag(null);
    setResizing(null);
  };
  const nudge = (e: KeyboardEvent, key: string) => {
    if (!e.altKey) return;
    const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
    const at = boardSpot(key);
    if (!delta || !at) return;
    e.preventDefault();
    if (topicLayout) {
      if (delta[1] === 0) return;
      const group = topicGroups.find(({ keys }) => keys.includes(key));
      const other = group?.keys[(group.keys.indexOf(key)) + Math.sign(delta[1] ?? 0)];
      if (other) {
        const y = topicSpots.get(other)?.y ?? 0;
        reorder(key, y + ((delta[1] ?? 0) > 0 ? (sizes.get(other)?.h ?? 120) : 0));
      }
      return;
    }
    const next = { x: Math.max(0, at.x + (delta[0] ?? 0)), y: Math.max(0, at.y + (delta[1] ?? 0)) };
    setSpots((m) => new Map(m).set(key, next));
    save([{ key, at: next }]);
  };

  /** Everything placed again by Noema, in the order they came in. */
  const arrange = () => {
    if (!view || !canvas.current) return;
    const width = canvas.current.clientWidth;
    const columns = Math.max(1, Math.floor((width - 2 * EDGE + GAP) / (WIDTH + GAP)));
    const all = blocks;
    const placed = placeClusters(
      all.map((k) => ({ key: k, w: sizes.get(k)?.w ?? WIDTH, h: sizes.get(k)?.h ?? 120, x: null, y: null })),
      { columns, columnWidth: WIDTH, gap: GAP, rowGap: ROW_GAP, left: EDGE, top: EDGE },
    );
    setSpots(new Map(placed));
    save(all.map((k) => ({ key: k, at: placed.get(k) as Spot })));
  };

  // Dropping: a thread, source or note from a list; files and links from outside, read as sources.
  const dropAt = (e: DragEvent): Spot => {
    const r = canvas.current?.getBoundingClientRect();
    return { x: Math.max(0, Math.round(e.clientX - (r?.left ?? 0) - 24)), y: Math.max(0, Math.round(e.clientY - (r?.top ?? 0) - 16)) };
  };
  // In Folders there is no map: Noema places what is dropped when the Board is next seen.
  const onDrop = (e: DragEvent) => {
    setDropOver(false);
    const at = canvas.current && !topicLayout ? dropAt(e) : undefined;
    const item = droppedItem(e);
    if (item) {
      e.preventDefault();
      void rooms.add(roomId, [{ ...rooms.unit(item), ...at }]);
      return;
    }
    // A room from the sidebar: it goes in this one, as a door where it was let go (ADR 0032).
    const inner = droppedRoom(e);
    if (inner) {
      e.preventDefault();
      if (inner.id === roomId) setStatus('A room cannot be put inside itself.');
      else void rooms.putRoom(roomId, inner.id, at);
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
            added.map((x, i) => ({ kind: 'source' as const, id: x.id, ...(at ? { x: at.x + i * STEP, y: at.y + i * STEP } : {}) })),
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
  const clusterOf = new Map(clusters.map((c) => [c.key, c]));
  const cards = new Map<string, RoomCard>(view.clusters.flatMap((c) => c.cards.map((x) => [linkCardKey(x), x] as const)));
  const titleOf = (key: string | null) => (key ? (cards.get(key)?.title ?? '') : '');
  const children = new Map<string, RoomCard[]>();
  for (const [child, parent] of parents) {
    const card = cards.get(child);
    if (card) children.set(parent, [...(children.get(parent) ?? []), card]);
  }
  const nestIn = (child: string, parent: string) => {
    if (!cards.has(child) || !cards.has(parent)) return;
    if (!canNestCard(child, parent)) {
      setStatus('Keep one level of cards. Choose a parent card on the Board.');
      return;
    }
    setNesting(null);
    setBoard((state) => ({
      ...state,
      parents: { ...state.parents, [child]: parent },
      collapsed: { ...state.collapsed, [parent]: false },
    }));
    setStatus(`“${titleOf(child)}” is inside “${titleOf(parent)}”.`);
  };
  const unnest = (child: string) => {
    setBoard((state) => {
      const next = { ...state.parents };
      delete next[child];
      return { ...state, parents: next };
    });
    setStatus(`“${titleOf(child)}” is back on the Board.`);
  };
  const box = (key: string) => {
    const at = boardSpot(key);
    const size = sizes.get(key);
    return at && size ? { ...at, ...size } : null;
  };
  let maxX = topicLayout ? Math.max(0, topicX - TOPIC_GAP) : 0;
  let maxY = 0;
  for (const k of blocks) {
    const b = box(k);
    if (b) {
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
  }
  const doorBoxes = view.doors.flatMap((d) => box(doorKey(d.id)) ?? []);
  const titleOfRoom = (id: string) => rooms.rooms.find((r) => r.id === id)?.title || 'Untitled room';
  const through = [...path, roomId];

  /** Right-click on a thing, in any view of the room. */
  const cardMenu = (c: RoomCard) => (e: MouseEvent) =>
    openMenu(
      e,
      roomMenu(rooms, { kind: c.kind, id: c.id, title: c.title }, [
        { label: 'Open', onSelect: () => onOpen(c.kind, c.id) },
        ...(mode === 'board'
          ? [
              {
                label: 'Link to…',
                hint: 'Then pick the card it links to',
                onSelect: () => setLinking({ key: `${c.kind}:${c.id}`, title: c.title }),
                testId: 'menu-link-to',
              },
              {
                label: parents.has(linkCardKey(c)) ? 'Take out of parent card' : 'Place inside another card…',
                onSelect: () => {
                  const key = linkCardKey(c);
                  if (parents.has(key)) unnest(key);
                  else {
                    setLinking(null);
                    setNesting(key);
                  }
                },
                testId: parents.has(linkCardKey(c)) ? 'room-nest-remove' : 'room-nest-start',
              },
            ]
          : []),
        {
          label: 'Take out of this room',
          onSelect: () => rooms.remove(roomId, { kind: c.kind, id: c.id }),
          hint: c.explicit ? undefined : 'It came with something in this room; it stays out until you put it back.',
          testId: 'menu-take-out',
        },
      ]).concat(deleteItems(items, { kind: c.kind, id: c.id, title: c.title })),
      c.title || 'Untitled',
    );

  const cardButton = (c: RoomCard, head: boolean, nested = false) => {
    const open = c.kind !== 'note' ? c.marks.open : 0;
    const marks = marksOf(c);
    const key = `${c.kind}:${c.id}`;
    const gist = view.gists[key];
    const pickable = linking !== null && linking.key !== key;
    const canContain = nesting !== null && canNestCard(nesting, key);
    const cardSize = head ? boardSize(key) : undefined;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut; its button opens the thing, the menu key works on it
      <div
        className={`room-card${head ? ' is-head' : ''} kind-${c.kind}${pickable || canContain || connecting?.over === key || nestDrag?.target === key ? ' is-target' : ''}${linking?.key === key || connecting?.from === key ? ' is-linking' : ''}${reading?.current.includes(key) ? ' is-reading' : ''}${boardFocus === key ? ' is-focused' : ''}`}
        style={{ '--heat': Math.min(1, c.marks.questions / 12), height: cardSize?.h } as CSSProperties}
        onMouseEnter={() => setFocusKey(key)}
        onMouseLeave={() => setFocusKey((k) => (k === key ? null : k))}
        onFocus={() => setFocusKey(key)}
        onContextMenu={(e) => {
          e.stopPropagation();
          cardMenu(c)(e);
        }}
        data-card-key={key}
        data-testid="room-card"
        data-kind={c.kind}
        data-id={c.id}
      >
        <div className="room-card-tools">
          <button type="button" className="room-card-tool room-move-handle" data-board-gesture="lift" data-testid="room-move-handle"
            aria-label="Move card" title={head ? 'Drag to move, or drop onto a card to place inside it' : 'Drag onto another card to place inside it'}>
            <span aria-hidden>⠿</span>
          </button>
          <button type="button" className="room-card-tool" data-testid="room-focus-card" aria-label={`Show links for ${c.title || 'this card'}`}
            title="Focus this card’s links" aria-pressed={boardFocus === key}
            onClick={() => { setBoardFocus((current) => current === key ? null : key); setEditing(null); }}>
            <span aria-hidden>◎</span>
          </button>
          <button type="button" className="room-card-tool room-link-port" data-board-gesture="connect" data-testid="room-link-port"
            aria-label="Connect card" title="Drag to connect, or click and choose a card"
            onClick={() => {
              if (swallow.current || nesting) return;
              if (pickable) void linkTo(c);
              else setLinking(linking ? null : { key, title: c.title });
            }}>
            <span aria-hidden>○</span>
          </button>
        </div>
        <div className="room-card-body">
        <button
          type="button"
          className="room-card-open"
          onClick={() => {
            if (swallow.current) return;
            if (nesting) {
              if (canContain) nestIn(nesting, key);
            } else if (pickable) void linkTo({ kind: c.kind, id: c.id });
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
          {density === 'normal' && (marks || open > 0) && (
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
        {density === 'normal' && gist && !nested && (
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
        {head && (
          <button type="button" className="room-card-tool room-resize-handle" data-board-gesture="resize" data-testid="room-resize-handle"
            aria-label="Resize card" title="Drag to resize, or use the arrow keys"
            onKeyDown={(e) => {
              const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key];
              if (!delta || e.altKey) return;
              e.preventDefault();
              const w = cardSize?.w ?? sizes.get(key)?.w ?? WIDTH;
              const h = cardSize?.h ?? cardBoxes.get(key)?.h ?? 120;
              const size = resizeCard(w + (delta[0] ?? 0), h + (delta[1] ?? 0));
              setBoard((state) => ({ ...state, sizes: { ...state.sizes, [key]: size } }));
            }}>
            <span aria-hidden>◢</span>
          </button>
        )}
      </div>
    );
  };
  const renderBoardCard = (card: RoomCard, head: boolean) => {
    const key = linkCardKey(card);
    const contained = children.get(key);
    if (!contained?.length) return cardButton(card, head);
    const collapsed = board.collapsed?.[key] === true;
    const childKeys = new Set(contained.map(linkCardKey));
    const external = view.itemLinks.filter((link) => {
      if (link.status !== 'accepted') return false;
      const from = linkCardKey(link.from);
      const to = linkCardKey(link.to);
      return from !== key && to !== key && childKeys.has(from) !== childKeys.has(to);
    }).length;
    return (
      <div className="room-parent-card" data-nest-parent={key} style={{ '--k': `var(--k-${card.kind})` } as CSSProperties}>
        {cardButton(card, head)}
        <button type="button" className="quiet room-nest-toggle" aria-expanded={!collapsed} data-testid="room-nest-toggle"
          onClick={() => setBoard((state) => ({ ...state, collapsed: { ...state.collapsed, [key]: !collapsed } }))}>
          {collapsed ? '▸' : '▾'} {plural(contained.length, 'nested card')}{collapsed && external > 0 ? ` · ${plural(external, 'outside link')}` : ''}
        </button>
        {!collapsed && (
          <ul className="room-contained" data-testid="room-contained">
            {contained.map((child) => <li key={child.id}>{cardButton(child, false, true)}</li>)}
          </ul>
        )}
      </div>
    );
  };

  // The picker: everything in the notebook, ticked if in this room.
  const members = new Set(room.members as string[]);
  // Suggested links wait in Review; only kept ones are drawn (ADR 0029).
  const suggested = view.itemLinks.filter((l) => l.status === 'suggested');
  const kept = view.itemLinks.filter((l) => l.status === 'accepted');
  // With concepts kept (ADR 0036), Path goes concept by concept.
  // The path, with concepts (ADR 0038): the kept concepts, topic by topic; a topic holds them, it is not a step.
  const keptConcepts = view.concepts.filter((c) => c.status === 'kept' && !isTopic(c, view.concepts));
  const pathGroups: Array<{ topic: Concept | null; concepts: Concept[] }> = [];
  for (const c of keptConcepts) {
    const t = topicOf(c);
    const g = pathGroups.find((x) => x.topic?.id === (t?.id ?? undefined) || (!x.topic && !t));
    if (g) g.concepts.push(c);
    else pathGroups.push({ topic: t, concepts: [c] });
  }
  pathGroups.sort((a, b) => (a.topic ? 0 : 1) - (b.topic ? 0 : 1));
  const underConcept = new Set(keptConcepts.flatMap((c) => c.members as string[]));
  const looseOfConcepts = [...cards.values()].filter((c) => !underConcept.has(`${c.kind}:${c.id}`));
  const byId = new Map(threads.map((t) => [t.id, t]));
  const openBranch = openBranches.find((branch) => members.has(`thread:${threadOf(branch.threadId, byId)}`));
  const recentThread = threads
    .filter((thread) => members.has(`thread:${thread.id}`))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const overviewTopics = concepts.filter((concept) => concept.status === 'kept' && isTopic(concept, concepts));
  const focused = boardFocus && (parents.get(boardFocus) && board.collapsed?.[parents.get(boardFocus) as string] ? parents.get(boardFocus) : boardFocus);
  const focusCluster = clusters.find((group) => group.cards.some((card) => linkCardKey(card) === (parents.get(focused ?? '') ?? focused)));
  const boardLinks = kept.filter((link) => {
    const from = linkCardKey(link.from);
    const to = linkCardKey(link.to);
    if (parents.get(from) === to && link.kind === 'part-of') return false;
    return allLinks || from === focused || to === focused || link.id === editing || link.id === choosing;
  });
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
  const welcomePicker = offerPicker && room.members.length === 0;
  const pickerButton = (
    <button type="button" className={welcomePicker ? 'primary' : picking ? 'active' : 'quiet'}
      onClick={() => {
        setOfferPicker(false);
        setPicking((open) => !open);
      }}
      aria-expanded={picking} data-testid="room-pick">
      Choose what is in it
    </button>
  );

  return (
    <section className="room" aria-label={`Room: ${room.title}`} data-testid="room">
      <header className="room-head">
        <div className="room-title">
          <RoomWhere room={room} path={path} />
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
            {room.counts.rooms > 0 && ` · ${plural(room.counts.rooms, 'room')} inside`}
            {view.concepts.some((c) => c.status === 'kept') && ` · ${plural(view.concepts.filter((c) => c.status === 'kept').length, 'concept')}`}
          </p>
        </div>
        <div className="room-actions">
          {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons, styled as a switch */}
          <div
            className="room-modes"
            // biome-ignore lint/a11y/useSemanticElements: a group of buttons, styled as a switch
            role="group"
            aria-label="How to see this room"
            data-testid="room-modes"
          >
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={mode === m.mode ? 'is-on' : ''}
                aria-pressed={mode === m.mode}
                onClick={() => show(m.mode)}
                title={m.title}
                data-testid={`room-mode-${m.mode}`}
              >
                <span aria-hidden>{m.glyph} </span>
                {m.label}
              </button>
            ))}
          </div>
          {!welcomePicker && pickerButton}
          {mode === 'board' && !topicLayout && blocks.length > 1 && (
            <button type="button" className="quiet" onClick={arrange} title="Place every cluster again, in the order they came in" data-testid="room-arrange">
              Arrange
            </button>
          )}
          {rooms.rooms.length > 1 && (
            <button type="button" className="quiet" onClick={() => setMerging((m) => !m)} aria-expanded={merging} data-testid="room-merge">
              Merge into…
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setConfirming(true)} data-testid="room-delete">
            Delete room
          </button>
        </div>
      </header>
      {merging && (
        <div className="askbox confirm-row room-confirm" data-testid="room-merge-pick">
          <span>Merge “{room.title}” into:</span>
          {rooms.rooms
            .filter((r) => r.id !== roomId)
            .map((r) => (
              <button
                key={r.id}
                type="button"
                className="quiet"
                onClick={() => {
                  setMerging(false);
                  void api.mergeRoom(roomId, r.id).then(
                    async () => {
                      await rooms.refresh();
                      rooms.openRoom(r.id);
                    },
                    (err: unknown) => setStatus(err instanceof ApiFailure ? err.message : 'The rooms could not be merged.'),
                  );
                }}
                data-testid="room-merge-into"
              >
                ⌂ {r.title}
              </button>
            ))}
          <span className="hint">What is put in this room goes there, and this room goes.</span>
          <button type="button" className="quiet" onClick={() => setMerging(false)}>
            Cancel
          </button>
        </div>
      )}
      {confirming && (
        <div className="askbox confirm-row room-confirm" role="alert" data-testid="room-delete-confirm">
          <span>
            Delete “{room.title}”? What is in it stays where it is; only the room and its map go.
            {room.rooms.length > 0 && ` The ${room.rooms.length === 1 ? 'room in it stays a room' : `${room.rooms.length} rooms in it stay rooms`}.`}
          </span>
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
      {welcomePicker && (
        <section className="room-picker-welcome room-overview-section room-resume" data-testid="room-picker-welcome">
          <div>
            <h2>Add materials to this room</h2>
            <p className="hint">Choose existing sources, conversations or notes to study together.</p>
          </div>
          <div className="room-overview-row">
            {pickerButton}
            <button type="button" className="quiet" onClick={() => setOfferPicker(false)}>Skip for now</button>
          </div>
        </section>
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
                              window.setTimeout(
                                () =>
                                  setPending((m) => {
                                    if (!m.has(key)) return m;
                                    const next = new Map(m);
                                    next.delete(key);
                                    return next;
                                  }),
                                4000,
                              ),
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
      {mode === 'overview' && (
        <div className="room-overview" data-testid="room-overview">
          <section className="room-overview-section">
            <h2>Learning goal</h2>
            {editingGoal ? (
              <form className="room-goal-form" onSubmit={(event) => {
                event.preventDefault();
                const text = String(new FormData(event.currentTarget).get('goal') ?? '').trim();
                setGoal(text);
                if (text) storage.set(keys.roomGoal(roomId), text);
                else storage.remove(keys.roomGoal(roomId));
                setEditingGoal(false);
              }}>
                <input aria-label="Learning goal" name="goal" defaultValue={goal} maxLength={200} />
                <button type="submit" className="quiet">Save</button>
                <button type="button" className="quiet" onClick={() => setEditingGoal(false)}>Cancel</button>
              </form>
            ) : (
              <div className="room-overview-row">
                {goal && <p data-testid="room-learning-goal">{goal}</p>}
                <button type="button" className="quiet" onClick={() => setEditingGoal(true)}>{goal ? 'Edit goal' : 'Set a goal'}</button>
              </div>
            )}
          </section>
          <section className="room-overview-section room-resume">
            <h2>Pick up where you left off</h2>
            {openBranch || recentThread ? (
              <div className="room-overview-row">
                <div>
                  <p>{openBranch?.title || recentThread?.title || 'Untitled thread'}</p>
                  {openBranch?.quote && <p className="hint">“{openBranch.quote.slice(0, 180)}”</p>}
                </div>
                <button type="button" className="primary" data-testid="room-resume"
                  onClick={() => {
                    const id = openBranch?.threadId ?? recentThread?.id;
                    if (id) onOpen('thread', id);
                  }}>
                  {openBranch ? 'Continue side question' : 'Continue conversation'}
                </button>
              </div>
            ) : <p className="hint">Start with a question below.</p>}
          </section>
          {overviewTopics.length > 0 && (
            <section className="room-overview-section">
              <h2>Topics</h2>
              <div className="room-overview-topics">
                {overviewTopics.map((topic) => (
                  <button key={topic.id} type="button" className="quiet" onClick={() => {
                    if (topicGroups.some((group) => group.id === topic.id)) {
                      setBoard((state) => ({ ...state, mode: 'topics' }));
                      setTopicJump(topic.id);
                      show('board');
                    } else {
                      setConceptOn(topic.id);
                      show('concepts');
                    }
                  }}>{topic.title} <span aria-hidden>↗</span></button>
                ))}
              </div>
            </section>
          )}
          <div className="room-overview-row">
            <button type="button" className="quiet" onClick={() => show('board')}>Open Board</button>
            {concepts.some((concept) => concept.status === 'suggested' || concept.home?.status === 'suggested') && (
              <button type="button" className="quiet" onClick={() => { setConceptOn(null); show('concepts'); }}>Review concepts</button>
            )}
          </div>
        </div>
      )}
      {putInto && (
        <p className="hint room-status room-put-into" role="status" data-testid="room-put-into">
          “{putInto.title || 'Untitled'}” is in “{putInto.door}” now, and still here.
          <button
            type="button"
            className="quiet inline"
            onClick={() => {
              const ref = putInto.ref;
              setPutInto(null);
              void rooms.remove(roomId, ref);
            }}
            data-testid="room-put-into-move"
          >
            Take it out of “{room.title}”
          </button>
          <button type="button" className="quiet inline" onClick={() => setPutInto(null)} aria-label="Close">
            ×
          </button>
        </p>
      )}
      {(view.clusters.length > 0 || view.doors.length > 0) && (
        <RoomBrief
          view={view}
          busy={busy}
          suggested={suggested.length + view.webFinds.length}
          onFindSources={async () => {
            await api.findSources(roomId);
            await load();
            setReviewing(true);
          }}
          reviewing={reviewing}
          onRead={() => void startReading()}
          onStop={() => void stopReading()}
          onReview={() => setReviewing((r) => !r)}
          onOpen={(item) => (item.kind === 'room' ? rooms.openRoom(item.id, through) : onOpen(item.kind, item.id))}
          titles={cards}
          compact={mode === 'board' && density === 'compact'}
        />
      )}
      {linking && (
        <p className="room-linking" role="status" data-testid="room-linking">
          Pick the card “{linking.title || 'Untitled'}” links to. Escape stops.
          <button type="button" className="quiet inline" onClick={() => setLinking(null)}>
            Stop
          </button>
        </p>
      )}
      {nesting && (
        <p className="room-linking" role="status" data-testid="room-nesting">
          Choose the card that should contain “{titleOf(nesting)}”.
          <button type="button" className="quiet inline" onClick={() => setNesting(null)}>Cancel</button>
        </p>
      )}
      {reviewing && suggested.length > 0 && (
        <ReviewLinks
          links={suggested}
          titles={cards}
          onChange={(id, patch) => void changeLink(id, patch)}
          onKeepAll={() => void Promise.all(suggested.map((l) => api.updateLink(l.id, { status: 'accepted' }))).then(load, load)}
          onClose={() => setReviewing(false)}
        />
      )}
      {reviewing && view.webFinds.length > 0 && (
        <div className="room-review room-review-web" data-testid="room-review-web">
          <WebFinds key={view.webFinds.map((f) => f.id).join()} finds={view.webFinds} title="Sources for what is still open" onAdded={() => void rooms.refresh()} />
        </div>
      )}
      {mode === 'folders' && (
        <RoomFolders
          view={view}
          through={through}
          onConcept={(id) => {
            setConceptOn(id);
            show('concepts');
          }}
          onOpen={onOpen}
          onOpenTarget={onOpenTarget}
          onDropHere={onDrop}
          empty={
            <div className="room-empty" data-testid="room-empty">
              <p className="empty-title">Nothing in this room yet</p>
              <p className="hint">
                Drag threads, sources and notes here from the sidebar, or drop files and links from your computer to read
                them as sources. Or choose what is in it.
              </p>
            </div>
          }
        />
      )}
      {mode === 'concepts' && (
        <RoomConcepts
          view={view}
          selected={conceptOn}
          onSelect={setConceptOn}
          busy={busy}
          reading={reading}
          onRead={() => void startReading()}
          onStop={() => void stopReading()}
          onOpen={onOpen}
          onOpenTarget={onOpenTarget}
          onAskAbout={(text) => setAskSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))}
        />
      )}
      {mode === 'path' && keptConcepts.length > 0 && (
        <div className="room-path-topics" data-testid="room-path-topics">
          {pathGroups.map((g) => (
            <section key={g.topic?.id ?? 'none'} className="path-topic" data-testid="path-topic">
              {pathGroups.length > 1 || g.topic ? (
                <h3 className="path-topic-title">
                  {g.topic ? (
                    <button
                      type="button"
                      className="quiet inline"
                      onClick={() => {
                        setConceptOn(g.topic?.id ?? null);
                        show('concepts');
                      }}
                    >
                      {CONCEPT_GLYPH} {g.topic.title}
                    </button>
                  ) : (
                    'Not in a topic'
                  )}
                </h3>
              ) : null}
              <RoomPath
                nodes={g.concepts.map(
                  (c): PathNode => ({
                    key: c.id,
                    title: c.title,
                    glyph: CONCEPT_GLYPH,
                    kind: 'concept',
                    text: c.definition,
                    open: (view.brief?.open ?? []).filter((o) => o.item && c.members.includes(`${o.item.kind}:${o.item.id}` as never)).map((o) => o.question),
                    sides: 0,
                    onOpen: () => {
                      setConceptOn(c.id);
                      show('concepts');
                    },
                    things: c.members.flatMap((k) => {
                      const card = cards.get(k);
                      return card ? [{ key: k, glyph: GLYPH[card.kind], kind: card.kind, title: card.title, onOpen: () => onOpen(card.kind, card.id) }] : [];
                    }),
                  }),
                )}
                links={view.conceptLinks.filter((l) => l.status === 'accepted').map((l) => ({ from: l.from, to: l.to, kind: l.kind }))}
                empty={null}
                compact={pathGroups.length > 1}
              />
            </section>
          ))}
          {looseOfConcepts.length > 0 && (
            <p className="path-loose" data-testid="path-unplaced">
              <span className="hint">Under no concept yet:</span>
              {looseOfConcepts.map((c) => (
                <button key={`${c.kind}:${c.id}`} type="button" className="path-chip" onClick={() => onOpen(c.kind, c.id)} onContextMenu={cardMenu(c)}>
                  <span aria-hidden>{GLYPH[c.kind]} </span>
                  {c.title || 'Untitled'}
                </button>
              ))}
            </p>
          )}
        </div>
      )}
      {mode === 'path' && keptConcepts.length === 0 && (
        <RoomPath
          nodes={[...cards.values()].map(
            (c): PathNode => ({
              key: `${c.kind}:${c.id}`,
              title: c.title,
              glyph: GLYPH[c.kind],
              kind: c.kind,
              text: view.gists[`${c.kind}:${c.id}`]?.text ?? null,
              open: (view.brief?.open ?? []).filter((o) => o.item?.kind === c.kind && o.item.id === c.id).map((o) => o.question),
              sides: c.kind === 'note' ? 0 : c.marks.open,
              onOpen: () => onOpen(c.kind, c.id),
              onMenu: cardMenu(c),
            }),
          )}
          links={kept.map((l) => ({ from: `${l.from.kind}:${l.from.id}`, to: `${l.to.kind}:${l.to.id}`, kind: l.kind }))}
          empty={
            <div className="room-empty" data-testid="room-empty">
              <p className="empty-title">Nothing in this room yet</p>
              <p className="hint">Put threads, sources and notes in it; the links you keep between them make the path.</p>
            </div>
          }
        />
      )}
      {mode === 'board' && blocks.length > 0 && (
        <div className="room-legend" data-testid="room-legend">
          <div className="room-board-options">
            <button type="button" className="quiet" aria-pressed={topicLayout} data-testid="room-board-topics"
              onClick={() => setBoard((state) => ({ ...state, mode: 'topics' }))}>By topic</button>
            <button type="button" className="quiet" aria-pressed={!topicLayout} data-testid="room-board-free"
              onClick={() => setBoard((state) => ({ ...state, mode: 'free' }))}>Free layout</button>
            <button type="button" className="quiet" aria-pressed={allLinks} data-testid="room-board-all-links"
              onClick={() => setAllLinks((shown) => !shown)}>Show all links</button>
            <button type="button" className="quiet" aria-pressed={density === 'compact'} data-testid="board-density"
              title="Titles and links only: no summaries, no counts, no words on the lines"
              onClick={() => setBoard((state) => ({ ...state, density: (state.density ?? 'normal') === 'compact' ? 'normal' : 'compact' }))}>Compact</button>
          </div>
          {LINK_KINDS.filter((k) => boardLinks.some((l) => l.kind === k)).map((k) => (
            <span key={k} className={`legend-kind kind-${k}`}>
              {LINK_WORDS[k]}
            </span>
          ))}
        </div>
      )}
      {/* The map scrolls sideways in its own space: with the Assistant beside it, nothing goes under it. */}
      {mode === 'board' && (
      <div className="room-map" data-testid="room-map">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a surface things are dropped on */}
      <div
        ref={canvas}
        className={`room-canvas${dropOver ? ' drop-over' : ''}`}
        style={{ minWidth: maxX + EDGE, minHeight: Math.max(420, maxY + 160) }}
        // biome-ignore lint/a11y/noStaticElementInteractions: a surface things are dropped on
        onDragOver={(e) => {
          if (!isItemDrag(e) && !isOutsideDrag(e) && !isRoomDrag(e)) return;
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
        {topicLayout && topicColumns.map(({ id, title, x, width }) => (
          <div key={id} className="room-board-topic" data-testid="room-board-topic" data-board-topic={id}
            style={{ left: x, width }}>
            <h2>{title}</h2>
          </div>
        ))}
        <svg className="room-lines" aria-hidden width={maxX + EDGE} height={Math.max(420, maxY + 160)}>
          {view.links.map((l) => {
            if (!allLinks && l.from !== focusCluster?.key && l.to !== focusCluster?.key) return null;
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
                {density === 'normal' && (
                  <text x={p1.x + (p2.x - p1.x) * 0.3} y={p1.y + (p2.y - p1.y) * 0.3 - 6} textAnchor="middle">
                    {words}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {connecting && cardBoxes.get(connecting.from) && (
          <svg className="connect-line" aria-hidden width={maxX + EDGE} height={Math.max(420, maxY + 160)}>
            {(() => {
              const a = cardBoxes.get(connecting.from) as Box;
              const t = connecting.over ? cardBoxes.get(connecting.over) : connecting.overDoor ? box(doorKey(connecting.overDoor)) : null;
              const x1 = connecting.x >= a.x + a.w / 2 ? a.x + a.w : a.x;
              const y1 = a.y + Math.min(a.h / 2, 28);
              const x2 = t ? (t.x > x1 ? t.x : t.x + t.w) : connecting.x;
              const y2 = t ? t.y + Math.min(t.h / 2, 28) : connecting.y;
              const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (x2 >= x1 ? 1 : -1);
              return <path d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`} />;
            })()}
          </svg>
        )}
        <ItemLinks
          links={boardLinks}
          choosing={choosing}
          boxes={cardBoxes}
          titles={cards}
          focus={allLinks ? focusKey : focused ?? null}
          editing={editing}
          onEdit={setEditing}
          onChange={(id, patch) => void changeLink(id, patch)}
          width={maxX + EDGE}
          height={Math.max(420, maxY + 160)}
          room={roomWidth}
          others={doorBoxes}
        />
        {nestDrag?.preview && (
          <div className="room-card-drag-preview" aria-hidden
            style={{ left: nestDrag.preview.x, top: nestDrag.preview.y }}>
            {titleOf(nestDrag.preview.key)}
          </div>
        )}
        {view.doors.map((d) => {
          const k = doorKey(d.id);
          const at = boardSpot(k);
          const also = (rooms.rooms.find((r) => r.id === d.id)?.parents ?? []).filter((p) => p !== roomId).map(titleOfRoom);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: moved by pointer; Alt+arrows on its button do the same
            <div
              key={k}
              className={`room-cluster room-door-place${lifted === k ? ' is-lifted' : ''}`}
              data-cluster={k}
              style={at ? { left: at.x, top: at.y } : { left: 0, top: 0, visibility: 'hidden' }}
              onPointerDown={(e) => down(e, k)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={cancel}
              onKeyDown={(e) => nudge(e, k)}
              data-testid="room-door-place"
            >
              <DoorCard
                door={d}
                also={also}
                target={connecting?.overDoor === d.id}
                onOpen={() => {
                  if (!swallow.current) rooms.openRoom(d.id, through);
                }}
                onMenu={(e) =>
                  openMenu(
                    e,
                    [
                      { label: 'Open', onSelect: () => rooms.openRoom(d.id, through) },
                      {
                        label: 'Take out of this room',
                        hint: 'It stays a room, with all in it',
                        onSelect: () => rooms.takeRoom(roomId, d.id),
                        testId: 'menu-door-take-out',
                      },
                    ],
                    d.title || 'Untitled room',
                  )
                }
              />
            </div>
          );
        })}
        {view.clusters.length === 0 && view.doors.length === 0 && (
          <div className="room-empty" data-testid="room-empty">
            <p className="empty-title">Nothing in this room yet</p>
            <p className="hint">
              Drag threads, sources and notes here from the sidebar, or drop files and links from your computer to read them
              as sources. Or choose what is in it.
            </p>
          </div>
        )}
        {clusters.map((c) => {
          const at = boardSpot(c.key);
          const size = boardSize(c.key);
          const [head, ...rest] = c.cards;
          if (!head) return null;
          const lines = view.links.filter((l) => l.from === c.key || l.to === c.key);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: moved by pointer; Alt+arrows on its cards do the same
            <div
              key={c.key}
              className={`room-cluster${lifted === c.key ? ' is-lifted' : ''}`}
              data-cluster={c.key}
              style={at ? { left: at.x, top: at.y, width: size?.w } : { left: 0, top: 0, visibility: 'hidden', width: size?.w }}
              onPointerDown={(e) => down(e, c.key)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={cancel}
              onKeyDown={(e) => nudge(e, c.key)}
              data-testid="room-cluster"
              data-key={c.key}
            >
              {renderBoardCard(head, true)}
              {(topicsByCard.get(linkCardKey(head))?.length ?? 0) > 1 && (
                <p className="hint room-board-also">
                  Also in {topicsByCard.get(linkCardKey(head))?.slice(1).map((topic) => topic.title).join(', ')}
                </p>
              )}
              {rest.length > 0 && (
                <ul className="room-members">
                  {rest.map((x) => (
                    <li key={`${x.kind}:${x.id}`}>{renderBoardCard(x, false)}</li>
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
      )}
      {nestDrop && (
        <NestCardDialog child={titleOf(nestDrop.child)} parent={titleOf(nestDrop.parent)}
          onDone={(confirmed) => {
            if (confirmed) nestIn(nestDrop.child, nestDrop.parent);
            setNestDrop(null);
          }} />
      )}
      <CreateHere
        title={room.title}
        puttingRoom={puttingRoom}
        onRoom={() => setPuttingRoom((p) => !p)}
        roomPanel={
          puttingRoom ? (
            <RoomHere
              room={room}
              onPut={async (childId) => {
                if (await rooms.putRoom(roomId, childId)) setPuttingRoom(false);
              }}
              onMake={async (title) => {
                const made = await rooms.create(title);
                if (made && (await rooms.putRoom(roomId, made.id))) setPuttingRoom(false);
              }}
              onClose={() => setPuttingRoom(false)}
            />
          ) : null
        }
        web={view.webAvailable ? room.web : null}
        onToggleWeb={async () => {
          await api.setRoomWeb(roomId, !room.web);
          await rooms.refresh();
        }}
        onAsk={async (question) => {
          const threadId = ulid();
          await api.createThread(notebookId, threadId);
          // In the room before the question, so its first answer knows the room.
          await api.addToRoom(roomId, [{ kind: 'thread', id: threadId }]);
          await api.ask(threadId, ulid(), question);
          await rooms.refresh();
          onOpen('thread', threadId);
        }}
        onNote={async () => {
          const noteId = ulid();
          await api.createNote(notebookId, noteId);
          await api.addToRoom(roomId, [{ kind: 'note', id: noteId }]);
          await rooms.refresh();
          onOpen('note', noteId);
        }}
        onSource={onAddSource}
        seed={askSeed}
      />
    </section>
  );
}

function NestCardDialog({ child, parent, onDone }: { child: string; parent: string; onDone: (confirmed: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog ref={ref} className="model-dialog" aria-labelledby="room-nest-title" data-testid="room-nest-dialog"
      onClose={(event) => onDone(event.currentTarget.returnValue === 'place')}>
      <h2 id="room-nest-title">Place card inside</h2>
      <p className="form-note">Put “{child || 'Untitled'}” inside “{parent || 'Untitled'}” on this Board?</p>
      <form method="dialog" className="room-overview-row">
        <button type="submit" className="quiet" value="cancel">Cancel</button>
        <button type="submit" className="primary" value="place">Place inside</button>
      </form>
    </dialog>
  );
}

/**
 * The room's brief (ADR 0030): what it adds up to, what is still open and what waits for review.
 * If it has not been read yet, it shows the reading action and its progress.
 */
function RoomBrief({
  view,
  busy,
  suggested,
  onFindSources,
  reviewing,
  onRead,
  onStop,
  onReview,
  onOpen,
  titles,
  compact = false,
}: {
  view: RoomViewData;
  busy: boolean;
  suggested: number;
  onFindSources: () => Promise<void>;
  reviewing: boolean;
  onRead: () => void;
  onStop: () => void;
  onReview: () => void;
  onOpen: (item: { kind: RoomKind | 'room'; id: string }) => void;
  titles: Map<string, RoomCard>;
  compact?: boolean;
}) {
  const { brief, reading, unread } = view;
  const [finding, setFinding] = useState<string | null>(null);
  const things = view.clusters.reduce((n, c) => n + c.cards.length, 0);
  // Reading for concepts (ADRs 0037, 0038): one call a piece of a thread or note not read yet, then one for new
  // names, one to put them in order and one for links.
  const pieces = view.conceptsToRead.pieces;
  const doors = view.doors.length;
  const held = [...(things ? [plural(things, 'thing')] : []), ...(doors ? [plural(doors, 'room')] : [])].join(' · ');
  const titleOfItem = (item: { kind: RoomKind | 'room'; id: string }) =>
    item.kind === 'room' ? (view.doors.find((d) => d.id === item.id)?.title ?? '') : (titles.get(`${item.kind}:${item.id}`)?.title ?? '');
  const status = !reading
    ? null
    : reading.phase === 'summaries'
      ? `Summarizing ${Math.min(reading.done + 1, reading.total)} of ${reading.total}…`
      : reading.phase === 'links'
        ? 'Looking for links between them…'
        : reading.phase === 'concepts'
          ? reading.total > 0
            ? `Reading your threads and notes for concepts: ${Math.min(reading.done, reading.total)} of ${plural(reading.total, 'piece')}…`
            : 'Putting the concepts in order…'
          : reading.phase === 'brief'
          ? 'Writing the brief: what the room adds up to…'
          : reading.phase === 'failed'
            ? reading.error
            : reading.stopped
              ? 'Stopped. What was read is kept; Read again carries on from there.'
              : `Read. ${reading.total ? `${reading.total === 1 ? '1 summary' : `${reading.total} summaries`} written` : 'Nothing new to summarize'}; ${plural(reading.suggested, 'link')} suggested${reading.suggested ? ': in Review, to keep or dismiss' : ''}.${reading.concepts ? ` ${plural(reading.concepts, 'concept')} suggested: in Concepts.` : ''}${reading.error ? ` ${reading.error}` : ''}`;
  const progress =
    reading && busy
      ? reading.phase === 'summaries' && reading.total > 0
        ? (reading.done / reading.total) * 0.7
        : reading.phase === 'links'
          ? 0.75
          : reading.phase === 'concepts'
            ? 0.76 + (reading.total > 0 ? (0.16 * Math.min(reading.done, reading.total)) / reading.total : 0.12)
            : 0.94
      : null;
  const readButton = (
    <>
      <button type="button" className={`ai-button${unread > 0 || !brief ? ' is-strong' : ''}${busy ? ' is-busy' : ''}`} onClick={onRead} disabled={busy} data-testid="room-read">
        <Orb size="small" />
        {busy ? 'Reading…' : unread > 0 ? `Read with AI · ${unread} new` : 'Read again'}
      </button>
      {busy && (
        <button type="button" className="quiet" onClick={onStop} title="What was read is kept; the next reading carries on" data-testid="room-read-stop">
          Stop
        </button>
      )}
    </>
  );
  return (
    <section className={`room-brief${busy ? ' is-reading' : ''}${brief ? '' : ' is-empty'}`} aria-label="What the AI made of this room" data-testid="room-brief">
      <div className="room-brief-main">
        <div className="room-brief-head">
          <Orb size="normal" />
          <div>
            <p className="room-brief-label">
              {brief ? `AI · read ${day(brief.at)} · ${held}${brief.fresh ? '' : ' · older: things changed since'}` : 'AI · not read yet'}
            </p>
            <h2>{brief ? 'What this room adds up to' : 'Read this room'}</h2>
          </div>
        </div>
        {compact ? (
          <p className="room-brief-text hint">Titles and links only. Turn Compact off to read the summary.</p>
        ) : brief ? (
          <p className={`room-brief-text${brief.fresh ? '' : ' is-stale'}`} data-testid="room-brief-text">
            {brief.text}
          </p>
        ) : (
          <p className="room-brief-text is-invite">
            The AI writes each thing here a short summary, its points linked to the words they come from; then it
            suggests links between them, and writes the room a brief: what it adds up to, and what is still open.
            {doors > 0 && ' The rooms in it go in by their own briefs: read them first for a fuller one.'} It uses your
            model: about {unread + 2 + (pieces > 0 ? pieces + 3 : 0)} calls{pieces > 0 && `, ${pieces} of them reading its threads and notes for concepts`}.
          </p>
        )}
        {status && (
          <p className={`hint room-status${reading?.phase === 'failed' ? ' is-error' : ''}`} role="status" data-testid="room-reading">
            {status}
          </p>
        )}
        {progress !== null && (
          <div className="room-brief-progress" aria-hidden>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      {!compact && brief && brief.open.length > 0 && (
        <div className="room-brief-col" data-testid="room-open">
          <p className="room-brief-label">Still open</p>
          <ul>
            {brief.open.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              <li key={i}>
                {o.item ? (
                  <button
                    type="button"
                    className="room-open-q"
                    onClick={() => o.item && onOpen(o.item)}
                    title={`Open “${titleOfItem(o.item)}”`}
                    data-testid="room-open-q"
                  >
                    {o.question} <span aria-hidden>↗</span>
                  </button>
                ) : (
                  <span>{o.question}</span>
                )}
              </li>
            ))}
          </ul>
          {view.webAvailable && (
            <button
              type="button"
              className="ai-button room-find-sources"
              disabled={finding === 'busy'}
              onClick={() => {
                setFinding('busy');
                onFindSources().then(
                  () => setFinding(null),
                  (err: unknown) => setFinding(err instanceof ApiFailure ? err.message : 'The web could not be searched.'),
                );
              }}
              title="One search of the web for each open question; what it finds waits in Review"
              data-testid="room-find-sources"
            >
              <Orb size="small" />
              {finding === 'busy' ? 'Searching the web…' : 'Find sources for these'}
            </button>
          )}
          {finding && finding !== 'busy' && (
            <p className="hint is-error" role="alert">
              {finding}
            </p>
          )}
        </div>
      )}
      <div className="room-brief-col room-brief-actions">
        {suggested > 0 && (
          <>
            <p className="room-brief-label">To review</p>
            <p className="room-brief-count">
              {suggested - view.webFinds.length > 0 && <>⟷ {plural(suggested - view.webFinds.length, 'link')} suggested</>}
              {suggested - view.webFinds.length > 0 && view.webFinds.length > 0 && <br />}
              {view.webFinds.length > 0 && <>❡ {plural(view.webFinds.length, 'source')} from the web</>}
            </p>
            <button type="button" className={`ai-button is-strong${reviewing ? ' is-on' : ''}`} onClick={onReview} aria-expanded={reviewing} data-testid="room-review-open">
              <Orb size="small" />
              Review {suggested}
            </button>
          </>
        )}
        {readButton}
      </div>
    </section>
  );
}

/** Making things in the room (ADR 0030): a question starts a thread here; a note or a source goes in it. */
function CreateHere({
  title,
  puttingRoom,
  onRoom,
  roomPanel,
  web,
  onToggleWeb,
  onAsk,
  onNote,
  onSource,
  seed,
}: {
  title: string;
  /** A question started elsewhere in the room (Ask about this concept, ADR 0036), to finish and send. */
  seed?: { text: string; n: number } | null;
  /** Putting a room in this one (ADR 0032): whether its panel is open, how to open it, and the panel. */
  puttingRoom: boolean;
  onRoom: () => void;
  roomPanel: ReactNode;
  /** Whether its questions may search the web; null when the web cannot be searched with this model. */
  web: boolean | null;
  onToggleWeb: () => Promise<void>;
  onAsk: (question: string) => Promise<void>;
  onNote: () => Promise<void>;
  onSource: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new seed, once
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    const el = box.current;
    if (el) {
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [seed?.n]);
  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (err) {
      setProblem(err instanceof ApiFailure ? err.message : 'It could not be made.');
      setBusy(false);
    }
  };
  const ask = () => {
    const q = text.trim();
    if (q && !busy) void run(() => onAsk(q));
  };
  return (
    <div className="room-create" data-testid="room-create">
      {problem && (
        <p className="hint is-error" role="alert">
          {problem}
        </p>
      )}
      {roomPanel}
      <div className="room-create-bar">
        <button type="button" className="quiet" onClick={() => void run(onNote)} disabled={busy} data-testid="room-note-here">
          ▤ Note here
        </button>
        <button type="button" className="quiet" onClick={onSource} disabled={busy} data-testid="room-source-here">
          ❡ Source here
        </button>
        <button
          type="button"
          className={puttingRoom ? 'active' : 'quiet'}
          onClick={onRoom}
          aria-expanded={puttingRoom}
          title="Put a smaller room inside this one, or make one"
          data-testid="room-room-here"
        >
          ⌂ Room here
        </button>
        {web !== null && (
          <button
            type="button"
            className={`room-web-toggle${web ? ' is-on' : ''}`}
            onClick={() => void onToggleWeb()}
            aria-pressed={web}
            title={web ? 'Questions asked here may search the web (DeepSeek search). Click to stop.' : 'Questions asked here do not search the web. Click to let them.'}
            data-testid="room-web"
          >
            ◎ Web {web ? 'on' : 'off'}
          </button>
        )}
        <textarea
          ref={box}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder={`Ask in “${title}”: a new thread here, answered with what this room holds…`}
          aria-label={`Ask in the room “${title}”`}
          data-testid="room-ask"
        />
        <button type="button" className="primary" onClick={ask} disabled={busy || !text.trim()} data-testid="room-ask-send">
          Ask
        </button>
      </div>
    </div>
  );
}

const DOOR_GLYPH: Record<'thread' | 'source' | 'note' | 'room', string> = { ...GLYPH, room: '⌂' };
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/**
 * The way into this room (ADR 0032), above its name: the rooms passed through to get here, each one click back;
 * opened another way, the rooms it is in.
 */
function RoomWhere({ room, path }: { room: Room; path: string[] }) {
  const rooms = useRooms();
  const byId = new Map(rooms.rooms.map((r) => [r.id, r]));
  // The way you came, while it still holds: each room inside the one before it.
  const chain = [...path, room.id];
  const holds = chain.every((id, i) => i === 0 || (byId.get(id)?.parents ?? (id === room.id ? room.parents : [])).includes(chain[i - 1] as string));
  const title = (id: string) => byId.get(id)?.title || 'Untitled room';
  if (path.length > 0 && holds) {
    return (
      <nav className="room-path" aria-label="The way you came in" data-testid="room-path">
        {path.map((id, i) => (
          <Fragment key={id}>
            <button type="button" className="room-trail-room" onClick={() => rooms.openRoom(id, path.slice(0, i))} data-testid="room-path-room">
              ⌂ {title(id)}
            </button>
            <span className="room-path-sep" aria-hidden>
              ›
            </span>
          </Fragment>
        ))}
      </nav>
    );
  }
  if (room.parents.length === 0) return null;
  return (
    <nav className="room-path" aria-label="The rooms it is in" data-testid="room-path">
      <span className="hint">Inside</span>
      {room.parents.map((id) => (
        <button key={id} type="button" className="room-trail-room" onClick={() => rooms.openRoom(id)} data-testid="room-path-room">
          ⌂ {title(id)}
        </button>
      ))}
    </nav>
  );
}

/**
 * A room inside this one (ADR 0032), as a door: its name, a picture of what it holds (a tile for each thing, in
 * its colour), a few of its things, its brief if it was read. It opens the room; a card drawn onto it goes in.
 */
function DoorCard({
  door,
  also,
  target,
  onOpen,
  onMenu,
}: {
  door: Door;
  also: string[];
  target: boolean;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const c = door.counts;
  const holds = holdsOf(c);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut; its button opens the room
    <div className={`room-door${target ? ' is-target' : ''}`} onContextMenu={onMenu} data-door-id={door.id} data-testid="room-door">
      <button type="button" className="room-door-open" onClick={onOpen} title={`Open the room “${door.title}”`} data-testid="room-door-open">
        <span className="room-card-kind">
          <span aria-hidden>⌂ </span>Room inside
        </span>
        <span className="room-card-title">{door.title || 'Untitled room'}</span>
        {door.kinds.length > 0 && (
          <span className="room-door-picture" aria-hidden>
            {door.kinds.map((k, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed picture
              <i key={i} className={`room-door-tile is-${k}`} />
            ))}
          </span>
        )}
        <span className="room-card-marks">{holds || 'Nothing in it yet'}</span>
      </button>
      {door.brief ? (
        <p className={`room-door-brief${door.fresh ? '' : ' is-stale'}`} data-testid="room-door-brief">
          <span className="room-gist-by">AI{door.fresh ? '' : ', older'} · </span>
          {cut(door.brief, 240)}
        </p>
      ) : (
        door.things.length > 0 && (
          <ul className="room-door-things">
            {door.things.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              <li key={i}>
                <span aria-hidden>{DOOR_GLYPH[t.kind]} </span>
                {t.title || 'Untitled'}
              </li>
            ))}
          </ul>
        )
      )}
      {also.length > 0 && <p className="hint room-door-also">Also in {also.join(', ')}</p>}
    </div>
  );
}

/** Putting a room in this one (ADR 0032): a room there is (none that would end up inside itself), or a new one. */
function RoomHere({
  room,
  onPut,
  onMake,
  onClose,
}: {
  room: Room;
  onPut: (childId: string) => Promise<void>;
  onMake: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const rooms = useRooms();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const doors = rooms.rooms.flatMap((r) => r.rooms.map((child) => ({ parent: r.id, child })));
  const can = rooms.rooms.filter((r) => r.id !== room.id && !room.rooms.includes(r.id) && !wouldLoop(doors, room.id, r.id));
  const run = (what: Promise<void>) => {
    setBusy(true);
    void what.finally(() => setBusy(false));
  };
  return (
    <div className="room-here" data-testid="room-here">
      <p className="room-here-head">
        Put a room inside “{room.title}”: a smaller part of its subject. It shows here as a door; what is in it stays in it.
      </p>
      <div className="room-here-rooms">
        {can.map((r) => (
          <button key={r.id} type="button" className="room-trail-room" onClick={() => run(onPut(r.id))} disabled={busy} data-testid="room-here-pick">
            ⌂ {r.title || 'Untitled room'}
          </button>
        ))}
        {can.length === 0 && <span className="hint">No other room can go in it.</span>}
      </div>
      <form
        className="room-here-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && !busy) run(onMake(title.trim()));
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Or a new room inside it"
          aria-label="Name of a new room inside this one"
          maxLength={200}
          data-testid="room-here-new"
        />
        <button type="submit" disabled={busy || !title.trim()} data-testid="room-here-make">
          Make
        </button>
        <button type="button" className="quiet" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}

/** How a link reads, from its first end: its own words, or its kind's. */
const linkWords = (l: ItemLink) => l.label || LINK_WORDS[l.kind];

/**
 * Links between cards (ADRs 0027, 0029): kept links, each a line in its
 * kind's colour with an arrow from one end to the other. Its words show for
 * the card in focus (a dot in its colour otherwise), and open the editor:
 * change its kind or words, turn it around, delete it. A line the AI is still
 * choosing the meaning of glows.
 */
function ItemLinks({
  links,
  choosing,
  boxes,
  titles,
  focus,
  editing,
  onEdit,
  onChange,
  width,
  height,
  room,
  others,
}: {
  links: ItemLink[];
  /** The link whose kind the AI is choosing. */
  choosing: string | null;
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
  /** Other things on the map words must not cover: the doors (ADR 0032). */
  others: Box[];
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
  const text = (l: ItemLink) => (l.id === choosing ? 'AI is choosing…' : linkWords(l));
  const lit = (x: { from: string; to: string; l: ItemLink }) => !focus || x.from === focus || x.to === focus || x.l.id === editing;
  // Words show for the card in focus, the link open, the one being chosen; a dot otherwise.
  const worded = (x: { from: string; to: string; l: ItemLink }) =>
    x.l.id === editing || x.l.id === choosing || (focus !== null && (x.from === focus || x.to === focus));
  // Words go on their line where they cover no card and no other words; sizes are measured once drawn.
  const spots = placeLabels(
    drawn.map((x) => ({
      id: x.l.id,
      curve: x.curve,
      ...(worded(x) ? (labelSizes.get(x.l.id) ?? { w: Math.min(116, 16 + text(x.l).length * 6.5), h: 20 }) : { w: 12, h: 12 }),
    })),
    [...boxes.values(), ...others],
  );
  useLayoutEffect(() => {
    const next = new Map<string, { w: number; h: number }>();
    for (const [id, el] of labelEls.current) if (!el.classList.contains('is-dot')) next.set(id, { w: el.offsetWidth, h: el.offsetHeight });
    const same = [...next].every(([id, z]) => labelSizes.get(id)?.w === z.w && labelSizes.get(id)?.h === z.h);
    if (!same) setLabelSizes(next);
  });
  const mid = (id: string) => spots.get(id) ?? { x: 0, y: 0 };
  const open = drawn.find((x) => x.l.id === editing);
  return (
    <>
      <svg className="item-lines" aria-hidden width={width} height={height}>
        <defs>
          {LINK_KINDS.map((k) => (
            <marker key={k} id={`item-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className={`kind-${k}`} d="M1 1L9 5L1 9" />
            </marker>
          ))}
        </defs>
        {drawn.map((x) => (
          <path
            key={x.l.id}
            d={x.d}
            className={`item-line kind-${x.l.kind}${lit(x) ? '' : ' is-faded'}${x.l.id === choosing ? ' is-choosing' : ''}`}
            markerEnd={`url(#item-arrow-${x.l.kind})`}
            data-testid="item-line"
            data-kind={x.l.kind}
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
          className={`link-label kind-${x.l.kind}${worded(x) ? '' : ' is-dot'}${lit(x) ? '' : ' is-faded'}${x.l.id === editing ? ' is-open' : ''}${x.l.id === choosing ? ' is-choosing' : ''}`}
          style={{ left: mid(x.l.id).x, top: mid(x.l.id).y }}
          onClick={() => onEdit(x.l.id === editing ? null : x.l.id)}
          aria-expanded={x.l.id === editing}
          aria-label={worded(x) ? undefined : linkWords(x.l)}
          title={`“${titles.get(x.from)?.title ?? ''}” ${linkWords(x.l)} “${titles.get(x.to)?.title ?? ''}”${x.l.why ? ` · ${x.l.why}` : ''}`}
          data-testid="link-label"
          data-status={x.l.status}
          data-kind={x.l.kind}
          data-link-id={x.l.id}
        >
          {worded(x) ? text(x.l) : ''}
        </button>
      ))}
      {open && (
        <LinkEditor
          key={`${open.l.id}:${open.l.updatedAt}`}
          link={open.l}
          choosing={open.l.id === choosing}
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
  choosing,
  from,
  to,
  at,
  onClose,
  onChange,
}: {
  link: ItemLink;
  choosing: boolean;
  from: string;
  to: string;
  at: { x: number; y: number };
  onClose: () => void;
  onChange: (patch: Parameters<typeof api.updateLink>[1] | 'delete') => void;
}) {
  const [label, setLabel] = useState(link.label ?? '');
  const by = link.by === 'ai' ? 'Suggested by the AI' : link.by === 'assistant' ? 'Made by the Assistant' : link.why ? 'Drawn by you; the AI chose what it means' : 'Drawn by you';
  const saveLabel = () => {
    if ((link.label ?? '') !== label.trim()) onChange({ label: label.trim() || null });
  };
  return (
    <section
      className="link-editor"
      style={{ left: at.x, top: at.y + 18 }}
      aria-label="This link"
      data-testid="link-editor"
    >
      <p className="link-editor-says">
        “{from || 'Untitled'}” <strong>{link.label || LINK_WORDS[link.kind]}</strong> “{to || 'Untitled'}”
      </p>
      {choosing ? (
        <p className="hint link-editor-by is-choosing" data-testid="link-choosing">
          <Orb size="small" /> The AI is reading both and choosing what this line means…
        </p>
      ) : (
        <p className="hint link-editor-by" data-testid="link-by">
          {by}
          {link.status === 'suggested' ? ', not kept yet' : ''}
          {link.why ? `: ${link.why}` : '.'}
        </p>
      )}
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

/** What the AI suggested (ADR 0029): each link with its reason, to keep, change, turn around or dismiss. */
function ReviewLinks({
  links,
  titles,
  onChange,
  onKeepAll,
  onClose,
}: {
  links: ItemLink[];
  titles: Map<string, RoomCard>;
  onChange: (id: string, patch: Parameters<typeof api.updateLink>[1]) => void;
  onKeepAll: () => void;
  onClose: () => void;
}) {
  const title = (r: { kind: RoomKind; id: string }) => titles.get(`${r.kind}:${r.id}`)?.title || 'Untitled';
  return (
    <section className="room-review" aria-label="Links the AI suggested" data-testid="room-review">
      <header className="room-review-head">
        <Orb size="small" />
        <strong>Suggested by the AI</strong>
        <span className="hint">Keep what is right; dismissed ones are not suggested again.</span>
        <button type="button" className="quiet" onClick={onKeepAll} data-testid="review-keep-all">
          Keep all
        </button>
        <button type="button" className="quiet" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <ul>
        {links.map((l) => (
          <li key={l.id} className="review-row" data-testid="review-row" data-link-id={l.id}>
            <p className="review-says">
              “{title(l.from)}” <span className={`legend-kind kind-${l.kind}`}>{linkWords(l)}</span> “{title(l.to)}”
            </p>
            {l.why && <p className="hint review-why">{l.why}</p>}
            <div className="review-actions">
              <button type="button" onClick={() => onChange(l.id, { status: 'accepted' })} data-testid="link-keep">
                Keep
              </button>
              <label>
                <span className="sr-only">Kind</span>
                <select value={l.kind} onChange={(e) => onChange(l.id, { kind: e.target.value as LinkKind })} data-testid="link-kind">
                  {LINK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {LINK_WORDS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="quiet" onClick={() => onChange(l.id, { flip: true })} data-testid="link-flip">
                Turn around
              </button>
              <button type="button" className="quiet" onClick={() => onChange(l.id, { status: 'dismissed' })} data-testid="link-dismiss">
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
