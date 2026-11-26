// Rooms (ADR 0026), in the sidebar: the list of rooms, each a place to drop
// threads, sources and notes on; and what is in no room yet, to drag into one.
// Any thread, source or note can be put in a room with right-click too.
// Rooms in rooms (ADR 0032): the list is a tree, a room under each room it is
// in; drag a room onto another to put it inside.

import { type NoteSummary, type Room, type RoomItemRef, type RoomNode, roomTree, type Source, type Thread, threadOf, wouldLoop } from '@noema/core';
import { type CSSProperties, createContext, type DragEvent, type FormEvent, type ReactNode, useContext, useRef, useState } from 'react';
import { type MenuItem, openMenu } from './ContextMenu.tsx';
import { type DragItem, draggableItem, draggableRoom, droppedItem, droppedRoom, isItemDrag, isRoomDrag } from './drag.ts';
import { deleteItems, useItems } from './itemMenu.ts';
import { keys, storage } from './storage.ts';

export interface RoomsApi {
  rooms: Room[];
  /** Bumped whenever a room changes, so an open room is drawn again. */
  changed: number;
  add: (roomId: string, items: Array<RoomItemRef & { x?: number; y?: number }>) => Promise<void>;
  remove: (roomId: string, item: RoomItemRef) => Promise<void>;
  create: (title: string, items?: RoomItemRef[]) => Promise<Room | null>;
  /** What goes in a room for this: a side question goes in as the thread it is part of. */
  unit: (item: { kind: DragItem['kind']; id: string }) => RoomItemRef;
  /** Open a room; through a door, with the rooms passed through to get there (ADR 0032). */
  openRoom: (roomId: string, path?: string[], newlyCreated?: boolean) => void;
  refresh: () => Promise<void>;
  /** Rooms in rooms (ADR 0032): put a room in another (false if it could not be), or take it out. */
  putRoom: (parentId: string, childId: string, at?: { x: number; y: number }) => Promise<boolean>;
  takeRoom: (parentId: string, childId: string) => Promise<void>;
}

const none: RoomsApi = {
  rooms: [],
  changed: 0,
  add: async () => {},
  remove: async () => {},
  create: async () => null,
  unit: (item) => item,
  openRoom: () => {},
  refresh: async () => {},
  putRoom: async () => false,
  takeRoom: async () => {},
};
export const RoomsContext = createContext<RoomsApi>(none);
export const useRooms = () => useContext(RoomsContext);

/** The thread a side question is part of; anything else as it is. */
export function unitOf(threads: Thread[], item: { kind: DragItem['kind']; id: string }): RoomItemRef {
  if (item.kind !== 'thread') return { kind: item.kind, id: item.id };
  return { kind: 'thread', id: threadOf(item.id, new Map(threads.map((t) => [t.id, t]))) };
}

/** Right-click on a thread, source or note: which rooms it is in, to put it in or take it out; a new room with it. */
export function roomMenu(rooms: RoomsApi, item: DragItem, before: MenuItem[] = []): MenuItem[] {
  const ref = rooms.unit(item);
  const key = `${ref.kind}:${ref.id}`;
  const out: MenuItem[] = [...before];
  if (before.length) out.push({ kind: 'separator' });
  out.push({
    kind: 'heading',
    label: item.kind === 'thread' && ref.id !== item.id ? 'Put its thread in a room' : 'Put in a room',
  });
  for (const r of rooms.rooms) {
    const inIt = r.members.includes(key as Room['members'][number]);
    out.push({
      label: r.title || 'Untitled room',
      checked: inIt,
      hint: inIt ? 'It is in this room. Pick it to take it out.' : undefined,
      onSelect: () => (inIt ? rooms.remove(r.id, ref) : rooms.add(r.id, [ref])),
      testId: 'menu-room',
    });
  }
  out.push({
    kind: 'input',
    label: 'New room with it…',
    placeholder: 'Name of the new room',
    onSubmit: async (title) => {
      await rooms.create(title, [ref]);
    },
    testId: 'menu-new-room',
  });
  return out;
}

/** Right-click on a room (ADR 0032): open it; the bigger rooms it is in, to put it in or take it out; a new one around it. */
export function roomPlaceMenu(rooms: RoomsApi, room: Room): MenuItem[] {
  const doors = rooms.rooms.flatMap((r) => r.rooms.map((child) => ({ parent: r.id, child })));
  const out: MenuItem[] = [
    { label: 'Open', onSelect: () => rooms.openRoom(room.id) },
    { kind: 'separator' },
    { kind: 'heading', label: 'Put it inside a bigger room' },
  ];
  for (const r of rooms.rooms) {
    if (r.id === room.id) continue;
    const inIt = room.parents.includes(r.id);
    // Not offered where it would end up inside itself.
    if (!inIt && wouldLoop(doors, r.id, room.id)) continue;
    out.push({
      label: r.title || 'Untitled room',
      checked: inIt,
      hint: inIt ? 'It is in this room. Pick it to take it out.' : undefined,
      onSelect: () => (inIt ? rooms.takeRoom(r.id, room.id) : rooms.putRoom(r.id, room.id).then(() => {})),
      testId: 'menu-room-in',
    });
  }
  out.push({
    kind: 'input',
    label: 'New room around it…',
    placeholder: 'Name of the bigger room',
    onSubmit: async (title) => {
      const made = await rooms.create(title);
      if (made) await rooms.putRoom(made.id, room.id);
    },
    testId: 'menu-room-around',
  });
  return out;
}

/** A room in the list: open it, drop a thing or another room on it, drag it into another; fold the rooms in it. */
function RoomRow({
  room,
  depth,
  alsoIn,
  active,
  fold,
  onOpen,
}: {
  room: Room;
  depth: number;
  /** The other rooms it is in, by name. */
  alsoIn: string[];
  active: boolean;
  /** For a room with rooms in it: whether they show, and how to fold or unfold them. */
  fold: { open: boolean; toggle: () => void } | null;
  onOpen: () => void;
}) {
  const rooms = useRooms();
  const [over, setOver] = useState(false);
  const total = room.counts.sources + room.counts.threads + room.counts.notes + room.counts.rooms;
  const accepts = (e: DragEvent) => isItemDrag(e) || isRoomDrag(e);
  const drop = (e: DragEvent) => {
    setOver(false);
    const item = droppedItem(e);
    if (item) {
      e.preventDefault();
      void rooms.add(room.id, [rooms.unit(item)]);
      return;
    }
    const inner = droppedRoom(e);
    if (inner) {
      e.preventDefault();
      if (inner.id !== room.id) void rooms.putRoom(room.id, inner.id);
    }
  };
  const counts = [
    `${room.counts.sources} sources`,
    `${room.counts.threads} threads`,
    `${room.counts.notes} notes`,
    ...(room.counts.rooms ? [`${room.counts.rooms} room${room.counts.rooms === 1 ? '' : 's'}`] : []),
  ].join(' · ');
  return (
    <li className="room-row" style={{ '--depth': depth } as CSSProperties}>
      {fold ? (
        <button
          type="button"
          className="room-fold"
          onClick={fold.toggle}
          aria-expanded={fold.open}
          aria-label={fold.open ? `Fold the rooms in ${room.title}` : `Show the rooms in ${room.title}`}
          data-testid="room-fold"
        >
          {fold.open ? '▾' : '▸'}
        </button>
      ) : (
        <span className="room-fold" aria-hidden />
      )}
      <button
        type="button"
        className={`thread-link room-link${active ? ' active' : ''}${over ? ' drop-over' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
        onContextMenu={(e) => openMenu(e, roomPlaceMenu(rooms, room), room.title || 'Untitled room')}
        {...draggableRoom(room)}
        onDragEnter={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        title={`${counts}${alsoIn.length ? `\nAlso in ${alsoIn.join(', ')}` : ''}`}
        data-testid="room-link"
        data-room-id={room.id}
        data-depth={depth}
      >
        <span aria-hidden>⌂ </span>
        {room.title || 'Untitled room'}
        {alsoIn.length > 0 && (
          <span className="room-also" aria-label={`also in ${alsoIn.join(', ')}`} data-testid="room-also">
            ⧉
          </span>
        )}
        <span className="room-count">{total}</span>
      </button>
    </li>
  );
}

/** A room and, unless folded, the rooms in it, at any depth (ADR 0032). */
function RoomBranch({
  node,
  depth,
  byId,
  activeRoomId,
  folded,
  onFold,
}: {
  node: RoomNode;
  depth: number;
  byId: Map<string, Room>;
  activeRoomId: string | null;
  folded: Set<string>;
  onFold: (id: string) => void;
}) {
  const rooms = useRooms();
  const room = byId.get(node.id);
  if (!room) return null;
  const open = !folded.has(node.id);
  return (
    <>
      <RoomRow
        room={room}
        depth={depth}
        alsoIn={node.alsoIn.map((id) => byId.get(id)?.title || 'Untitled room')}
        active={room.id === activeRoomId}
        fold={node.children.length > 0 ? { open, toggle: () => onFold(node.id) } : null}
        onOpen={() => rooms.openRoom(room.id)}
      />
      {open &&
        node.children.map((c) => (
          <RoomBranch key={c.id} node={c} depth={depth + 1} byId={byId} activeRoomId={activeRoomId} folded={folded} onFold={onFold} />
        ))}
    </>
  );
}

/** The rooms a thread, source or note lives in (ADR 0030), above it: one click back to each. */
export function RoomTrail({ threads, item }: { threads: Thread[]; item: { kind: DragItem['kind']; id: string } }) {
  const rooms = useRooms();
  const unit = unitOf(threads, item);
  const key = `${unit.kind}:${unit.id}`;
  const homes = rooms.rooms.filter((r) => (r.members as string[]).includes(key));
  if (homes.length === 0) return null;
  return (
    <nav className="room-trail" aria-label="Rooms it is in" data-testid="room-trail">
      {homes.map((r) => (
        <button key={r.id} type="button" className="room-trail-room" onClick={() => rooms.openRoom(r.id)} data-testid="room-trail-room">
          ⌂ {r.title}
        </button>
      ))}
    </nav>
  );
}

export function RoomsPanel({
  threads,
  sources,
  notes,
  activeRoomId,
  activeId,
  onOpenThread,
  onOpenSource,
  onOpenNote,
}: {
  threads: Thread[];
  sources: Source[];
  notes: NoteSummary[];
  activeRoomId: string | null;
  activeId: string | null;
  onOpenThread: (id: string) => void;
  onOpenSource: (id: string) => void;
  onOpenNote: (id: string) => void;
}) {
  const rooms = useRooms();
  const items = useItems();
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState('');
  const [loose, setLoose] = useState(() => storage.get(keys.roomsLooseOpen) !== '0');
  const [folded, setFolded] = useState(() => new Set(storage.getJson<string[]>(keys.roomsFolded, [])));
  const fold = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    storage.setJson(keys.roomsFolded, [...next]);
  };
  const input = useRef<HTMLInputElement>(null);

  const make = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const room = await rooms.create(title.trim());
    setTitle('');
    setNaming(false);
    if (room) rooms.openRoom(room.id, undefined, true);
  };

  // What is in no room: sources, threads of their own, notes.
  const placed = new Set(rooms.rooms.flatMap((r) => r.members as string[]));
  const byId = new Map(threads.map((t) => [t.id, t]));
  const tops = threads.filter((t) => threadOf(t.id, byId) === t.id);
  const unplaced: Array<DragItem & { open: () => void; glyph: string }> = [
    ...sources
      .filter((x) => !placed.has(`source:${x.id}`))
      .map((x) => ({ kind: 'source' as const, id: x.id, title: x.title, open: () => onOpenSource(x.id), glyph: x.linked ? '⌸' : '❡' })),
    ...tops
      .filter((t) => !placed.has(`thread:${t.id}`))
      .map((t) => ({ kind: 'thread' as const, id: t.id, title: t.title, open: () => onOpenThread(t.id), glyph: '◦' })),
    ...notes
      .filter((n) => !placed.has(`note:${n.id}`))
      .map((n) => ({ kind: 'note' as const, id: n.id, title: n.title, open: () => onOpenNote(n.id), glyph: '▤' })),
  ];
  const SHOWN = 60;

  let list: ReactNode;
  if (rooms.rooms.length === 0) {
    list = (
      <p className="sidebar-empty" data-testid="rooms-empty">
        A room holds what you learn about one subject, whatever kind it is: the sources, the threads asked about them, the
        notes. Make one, then drag things onto it, or right-click any thread, source or note.
      </p>
    );
  } else {
    const byId = new Map(rooms.rooms.map((r) => [r.id, r]));
    list = (
      <ul className="sidebar-list room-tree" data-testid="room-list">
        {roomTree(rooms.rooms).map((n) => (
          <RoomBranch key={n.id} node={n} depth={0} byId={byId} activeRoomId={activeRoomId} folded={folded} onFold={fold} />
        ))}
      </ul>
    );
  }

  return (
    <>
      <div className="panel-head">
        <h2>
          Rooms
          {rooms.rooms.length > 0 && <span className="panel-count">{rooms.rooms.length}</span>}
        </h2>
        <button
          type="button"
          className="panel-action"
          onClick={() => {
            setNaming((n) => !n);
            requestAnimationFrame(() => input.current?.focus());
          }}
          aria-expanded={naming}
          data-testid="new-room"
        >
          + New room
        </button>
      </div>
      {naming && (
        <form className="new-room" onSubmit={(e) => void make(e)}>
          <input
            ref={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNaming(false);
            }}
            placeholder="Machine learning systems"
            aria-label="Name of the new room"
            maxLength={200}
            data-testid="new-room-title"
          />
          <button type="submit" disabled={!title.trim()} data-testid="new-room-make">
            Make
          </button>
        </form>
      )}
      {list}
      {unplaced.length > 0 && (
        <section className="rooms-loose" aria-label="In no room yet">
          <button
            type="button"
            className="rooms-loose-head"
            onClick={() => {
              setLoose(!loose);
              storage.set(keys.roomsLooseOpen, loose ? '0' : '1');
            }}
            aria-expanded={loose}
            data-testid="rooms-loose-toggle"
          >
            <span aria-hidden>{loose ? '▾' : '▸'} </span>
            In no room yet <span className="room-count">{unplaced.length}</span>
          </button>
          {loose && (
            <>
              <p className="hint rooms-loose-hint">Drag onto a room, or right-click.</p>
              <ul className="sidebar-list" data-testid="rooms-loose">
                {unplaced.slice(0, SHOWN).map((x) => (
                  <li key={`${x.kind}:${x.id}`}>
                    <button
                      type="button"
                      className={`thread-link${x.id === activeId ? ' active' : ''}`}
                      onClick={x.open}
                      onContextMenu={(e) => openMenu(e, [...roomMenu(rooms, x), ...deleteItems(items, x)], x.title || 'Untitled')}
                      {...draggableItem(x)}
                      data-testid="loose-link"
                      data-kind={x.kind}
                      data-id={x.id}
                    >
                      <span aria-hidden>{x.glyph} </span>
                      {x.title || 'Untitled'}
                    </button>
                  </li>
                ))}
              </ul>
              {unplaced.length > SHOWN && <p className="hint rooms-loose-hint">and {unplaced.length - SHOWN} more</p>}
            </>
          )}
        </section>
      )}
    </>
  );
}
