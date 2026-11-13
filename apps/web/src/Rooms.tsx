// Rooms (ADR 0026), in the sidebar: the list of rooms, each a place to drop
// threads, sources and notes on; and what is in no room yet, to drag into one.
// Any thread, source or note can be put in a room with right-click too.

import { type NoteSummary, type Room, type RoomItemRef, type Source, type Thread, threadOf } from '@noema/core';
import { createContext, type DragEvent, type FormEvent, type ReactNode, useContext, useRef, useState } from 'react';
import { type MenuItem, openMenu } from './ContextMenu.tsx';
import { type DragItem, draggableItem, droppedItem, isItemDrag } from './drag.ts';
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
  openRoom: (roomId: string) => void;
  refresh: () => Promise<void>;
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

/** A room in the list: open it, or drop something on it. */
function RoomRow({ room, active, onOpen }: { room: Room; active: boolean; onOpen: () => void }) {
  const rooms = useRooms();
  const [over, setOver] = useState(false);
  const total = room.counts.sources + room.counts.threads + room.counts.notes;
  const drop = (e: DragEvent) => {
    setOver(false);
    const item = droppedItem(e);
    if (!item) return;
    e.preventDefault();
    void rooms.add(room.id, [rooms.unit(item)]);
  };
  return (
    <li>
      <button
        type="button"
        className={`thread-link room-link${active ? ' active' : ''}${over ? ' drop-over' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
        onDragEnter={(e) => {
          if (!isItemDrag(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!isItemDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        title={`${room.counts.sources} sources · ${room.counts.threads} threads · ${room.counts.notes} notes`}
        data-testid="room-link"
        data-room-id={room.id}
      >
        <span aria-hidden>⌂ </span>
        {room.title || 'Untitled room'}
        <span className="room-count">{total}</span>
      </button>
    </li>
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
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState('');
  const [loose, setLoose] = useState(() => storage.get(keys.roomsLooseOpen) !== '0');
  const input = useRef<HTMLInputElement>(null);

  const make = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const room = await rooms.create(title.trim());
    setTitle('');
    setNaming(false);
    if (room) rooms.openRoom(room.id);
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
    list = (
      <ul className="sidebar-list" data-testid="room-list">
        {rooms.rooms.map((r) => (
          <RoomRow key={r.id} room={r} active={r.id === activeRoomId} onOpen={() => rooms.openRoom(r.id)} />
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
                      onContextMenu={(e) => openMenu(e, roomMenu(rooms, x), x.title || 'Untitled')}
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
