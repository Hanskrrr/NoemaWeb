// A room in Folders (ADR 0035), the way Finder lists a folder: the rooms inside
// it are folders that open in place, its threads, sources and notes are the
// files. A thing in more than one room shows ↗ and the rooms it is also in: the
// same thing, never a copy. A click shows it in the preview; a double-click or
// Enter opens it. Drag a row onto a folder to move it there; with ⌥ it stays
// here too. Right-click is the same menu as everywhere.

import { type Concept, type Gist, LINK_WORDS, type Room, type RoomKind, type RoomView as RoomViewData, type VaultTarget } from '@noema/core';
import { type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { openMenu } from './ContextMenu.tsx';
import {
  draggableItem,
  draggableRoom,
  draggedFrom,
  droppedItem,
  droppedRoom,
  FROM_ROOM_MIME,
  isItemDrag,
  isOutsideDrag,
  isRoomDrag,
} from './drag.ts';
import { alsoIn, DEFAULT_SORT, type FolderColumn, type FolderSort, nextSort, roomAlsoIn, sortRows, typeAhead } from './folders.ts';
import { deleteItems, useItems } from './itemMenu.ts';
import { roomMenu, useRooms } from './Rooms.tsx';
import { CONCEPT_GLYPH, type Door, day, GLYPH, holdsOf, kindName, marksOf, plural, ROOM_GLYPH, type RoomCard } from './roomText.ts';
import { keys, storage } from './storage.ts';

interface Row {
  /** Unique in the list: the way down to it and what it is ("01…/room:01…/thread:01…"). */
  id: string;
  key: string;
  folder: boolean;
  depth: number;
  /** The room it is listed in. */
  holder: string;
  /** The rooms opened to get to it, from this room down to its holder. */
  chain: string[];
  title: string;
  kind: string;
  at: string;
  open: number;
  also: Room[];
  card?: RoomCard;
  door?: Door;
  /** A concept kept in the room (ADR 0036): a folder of its things. */
  concept?: Concept;
  /** Listed under a concept: the other concepts it is under too (ADR 0037). */
  under?: Concept[];
  gist?: Gist;
  /** The view of the room it is listed in. */
  of: RoomViewData;
}

const COLUMNS: Array<{ col: FolderColumn | null; label: string; className: string }> = [
  { col: 'name', label: 'Name', className: 'folders-name' },
  { col: 'kind', label: 'Kind', className: 'folders-kind' },
  { col: null, label: 'Also in', className: 'folders-also' },
  { col: 'touched', label: 'Touched', className: 'folders-touched' },
  { col: 'open', label: 'Open', className: 'folders-open' },
];

export function RoomFolders({
  view,
  through,
  onConcept,
  onOpen,
  onOpenTarget,
  onDropHere,
  empty,
}: {
  view: RoomViewData;
  /** The rooms passed through to get here, and this one (ADR 0032). */
  through: string[];
  /** A concept opened: shown in Concepts (ADR 0036). */
  onConcept: (id: string) => void;
  onOpen: (kind: RoomKind, id: string) => void;
  onOpenTarget: (target: VaultTarget) => void;
  /** Something dropped on the list itself, not on a folder: it goes in this room. */
  onDropHere: (e: DragEvent) => void;
  empty: ReactNode;
}) {
  const rooms = useRooms();
  const items = useItems();
  const roomId = view.room.id;
  const [sort, setSort] = useState<FolderSort>(() => storage.getJson(keys.foldersSort, DEFAULT_SORT));
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [inner, setInner] = useState<Map<string, RoomViewData>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const [over, setOver] = useState<string | null>(null);
  const [overList, setOverList] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const list = useRef<HTMLDivElement>(null);

  // The rooms opened in place are read again whenever a room changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever a room changes
  useEffect(() => {
    const ids = [...inner.keys()];
    if (ids.length === 0) return;
    let live = true;
    void Promise.all(ids.map((id) => api.room(id).then((v) => [id, v] as const, () => null))).then((got) => {
      if (!live) return;
      setInner(new Map(got.flatMap((g) => (g ? [g] : []))));
    });
    return () => {
      live = false;
    };
  }, [rooms.changed, view]);

  const title = (id: string) => rooms.rooms.find((r) => r.id === id)?.title || (id === roomId ? view.room.title : 'Untitled room');

  // Which room each concept listed is part of: moved into one of its own room's concepts, a thing stays in the room.
  const conceptOf = new Map<string, string>();
  const fileRow = (v: RoomViewData, c: RoomCard, depth: number, chain: string[], prefix: string, holder: string): Row => {
    const key = `${c.kind}:${c.id}`;
    return {
      id: `${prefix}/${key}`,
      key,
      folder: false,
      depth,
      holder,
      chain,
      title: c.title,
      kind: kindName(c),
      at: c.marks.at,
      open: c.kind === 'note' ? 0 : c.marks.open,
      // In a concept, it is in the room too: not "also in" that.
      also: alsoIn(rooms.rooms, key, v.room.id),
      card: c,
      gist: v.gists[key],
      of: v,
    };
  };
  const rowsOf = (v: RoomViewData, depth: number, chain: string[], prefix: string): Row[] => {
    const holder = v.room.id;
    const cards = v.clusters.flatMap((c) => c.cards);
    const byKey = new Map(cards.map((c) => [`${c.kind}:${c.id}`, c]));
    const concepts = v.concepts.filter((c) => c.status === 'kept');
    const under = new Set(concepts.flatMap((c) => c.members as string[]));
    for (const c of concepts) conceptOf.set(c.id, holder);
    // The tree (ADR 0038): a kept concept is a folder at the top, or inside the kept concept (or topic) it is under.
    const keptIds = new Set(concepts.map((c) => c.id));
    const childrenOf = (id: string) => concepts.filter((c) => c.home?.id === id);
    const conceptRow = (c: Concept, d: number, pre: string): Row => {
      const mine = c.members.flatMap((k) => byKey.get(k) ?? []);
      const kids = childrenOf(c.id);
      const topic = mine.length === 0 && kids.length > 0;
      return {
        id: `${pre}/concept:${c.id}`,
        key: `concept:${c.id}`,
        folder: true,
        depth: d,
        holder,
        chain,
        title: c.title,
        kind: topic ? `Topic · ${kids.length}` : `Concept · ${mine.length}`,
        at: mine.reduce((at, x) => (x.marks.at > at ? x.marks.at : at), ''),
        open: mine.reduce((n, x) => n + (x.kind === 'note' ? 0 : x.marks.open), 0),
        also: c.also.flatMap((id) => rooms.rooms.find((r) => r.id === id) ?? []),
        concept: c,
        of: v,
      };
    };
    const conceptRows: Row[] = concepts.filter((c) => !c.home || !keptIds.has(c.home.id)).map((c) => conceptRow(c, depth, prefix));
    /** What is inside an opened concept: the concepts under it (themselves folders), then its things. */
    const insideConcept = (c: Concept, d: number, pre: string, seen: Set<string>): Row[] => {
      const rowsHere: Row[] = [];
      for (const k of sortRows(
        childrenOf(c.id)
          .filter((x) => !seen.has(x.id))
          .map((x) => conceptRow(x, d, pre)),
        sort,
      )) {
        rowsHere.push(k);
        if (k.concept && opened.has(k.id)) rowsHere.push(...insideConcept(k.concept, d + 1, k.id, new Set([...seen, k.concept.id])));
      }
      const things = c.members
        .flatMap((k) => byKey.get(k) ?? [])
        .map((x) => ({
          ...fileRow(v, x, d, chain, pre, c.id),
          under: concepts.filter((o) => o.id !== c.id && o.members.includes(`${x.kind}:${x.id}` as never)),
        }));
      return [...rowsHere, ...sortRows(things, sort)];
    };
    const folders: Row[] = v.doors.map((d) => {
      const total = d.counts.sources + d.counts.threads + d.counts.notes + d.counts.rooms;
      return {
        id: `${prefix}/room:${d.id}`,
        key: `room:${d.id}`,
        folder: true,
        depth,
        holder,
        chain,
        title: d.title,
        kind: `Room · ${total}`,
        at: rooms.rooms.find((r) => r.id === d.id)?.updatedAt ?? '',
        open: 0,
        also: roomAlsoIn(rooms.rooms, d.id, holder),
        door: d,
        of: v,
      };
    });
    const files: Row[] = cards.filter((c) => !under.has(`${c.kind}:${c.id}`)).map((c) => fileRow(v, c, depth, chain, prefix, holder));
    const out: Row[] = [];
    for (const r of sortRows([...conceptRows, ...folders, ...files], sort)) {
      out.push(r);
      if (r.concept && opened.has(r.id)) out.push(...insideConcept(r.concept, r.depth + 1, r.id, new Set([r.concept.id])));
      if (r.door && opened.has(r.id)) {
        const child = inner.get(r.door.id);
        // Never round in circles (a room cannot be inside itself, but be safe).
        if (child && !chain.includes(r.door.id)) out.push(...rowsOf(child, depth + 1, [...chain, r.door.id], r.id));
      }
    }
    return out;
  };
  const rows = rowsOf(view, 0, [roomId], roomId);
  const at = rows.findIndex((r) => r.id === selected);
  const current = at >= 0 ? rows[at] : undefined;

  const toggle = (row: Row, open?: boolean) => {
    if (!row.door && !row.concept) return;
    const willOpen = open ?? !opened.has(row.id);
    setOpened((s) => {
      const next = new Set(s);
      if (willOpen) next.add(row.id);
      else next.delete(row.id);
      return next;
    });
    const id = row.door?.id;
    if (id && willOpen && !inner.has(id)) {
      void api.room(id).then(
        (v) => setInner((m) => new Map(m).set(id, v)),
        () => setStatus('That room could not be opened.'),
      );
    }
  };
  const openRow = (row: Row) => {
    if (row.concept) onConcept(row.concept.id);
    else if (row.door) rooms.openRoom(row.door.id, [...through.slice(0, -1), ...row.chain]);
    else if (row.card) onOpen(row.card.kind, row.card.id);
  };
  const changeSort = (col: FolderColumn) => {
    const next = nextSort(sort, col);
    setSort(next);
    storage.setJson(keys.foldersSort, next);
  };
  const select = (row: Row | undefined) => {
    if (!row) return;
    setSelected(row.id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`)?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    const i = Math.max(0, at);
    const row = rows[i];
    if (e.key === 'ArrowDown') select(rows[Math.min(rows.length - 1, at + 1)]);
    else if (e.key === 'ArrowUp') select(rows[Math.max(0, at - 1)]);
    else if (e.key === 'Home') select(rows[0]);
    else if (e.key === 'End') select(rows[rows.length - 1]);
    else if (e.key === 'ArrowRight' && row?.folder) toggle(row, true);
    else if (e.key === 'ArrowLeft' && row) {
      if (row.folder && opened.has(row.id)) toggle(row, false);
      else select(rows.find((r) => row.id.startsWith(`${r.id}/`) && r.depth === row.depth - 1));
    } else if (e.key === 'Enter' && row) openRow(row);
    else if (e.key === ' ') setPreview((p) => !p);
    else if (e.key.length === 1 && !e.altKey) {
      // Typing jumps to the row whose name starts so, as in Finder.
      const now = Date.now();
      const text = now - typed.current.at > 900 ? e.key : typed.current.text + e.key;
      typed.current = { text, at: now };
      const found = typeAhead(
        rows.map((r) => r.title),
        text,
        text.length === 1 ? i + 1 : i,
      );
      if (found >= 0) select(rows[found]);
    } else return;
    e.preventDefault();
  };

  /** Let go on a folder: moved into it from the room it was in; with ⌥, or from elsewhere, put in it as well. */
  const dropOn = async (e: DragEvent, target: string) => {
    const item = droppedItem(e);
    const room = droppedRoom(e);
    const from = draggedFrom(e);
    // Into a concept of the room it was in (ADR 0036): it stays in the room as well.
    const keep = e.altKey || !from || from === target || conceptOf.get(target) === from;
    const concept = [...conceptOf.keys()].includes(target) ? rowsByConcept(target) : null;
    const into = concept ?? title(target);
    if (item) {
      const ref = rooms.unit(item);
      await rooms.add(target, [ref]);
      if (!keep && from) await rooms.remove(from, ref);
      setStatus(`“${item.title || 'Untitled'}” is in “${into}” now${keep && from ? `, and still in “${title(from)}”` : ''}.`);
    } else if (room) {
      if (room.id === target) return;
      const ok = await rooms.putRoom(target, room.id);
      if (!ok) {
        setStatus(`“${room.title || 'Untitled room'}” cannot go inside “${into}”: it would end up inside itself.`);
        return;
      }
      if (!keep && from) await rooms.takeRoom(from, room.id);
      setStatus(`“${room.title || 'Untitled room'}” is inside “${into}” now.`);
    }
  };
  const accepts = (e: DragEvent) => isItemDrag(e) || isRoomDrag(e);
  const rowsByConcept = (id: string) => rows.find((r) => r.concept?.id === id)?.title ?? '';

  const menuFor = (row: Row) => (e: MouseEvent) => {
    setSelected(row.id);
    const inConcept = conceptOf.has(row.holder);
    const from = inConcept ? rowsByConcept(row.holder) : title(row.holder);
    if (row.concept) {
      const c = row.concept;
      openMenu(e, [{ label: 'Show in Concepts', onSelect: () => onConcept(c.id) }], row.title || 'Untitled');
      return;
    }
    if (row.door) {
      const id = row.door.id;
      openMenu(
        e,
        [
          { label: 'Open', onSelect: () => openRow(row) },
          {
            label: `Take out of “${from}”`,
            hint: 'It stays a room, with all in it',
            onSelect: () => rooms.takeRoom(row.holder, id),
            testId: 'menu-door-take-out',
          },
        ],
        row.title || 'Untitled room',
      );
      return;
    }
    const c = row.card as RoomCard;
    const thing = { kind: c.kind, id: c.id, title: c.title };
    openMenu(
      e,
      roomMenu(rooms, thing, [
        { label: 'Open', onSelect: () => onOpen(c.kind, c.id) },
        ...(inConcept
          ? [
              {
                label: `Take out of “${from}”`,
                hint: 'It stays in the room, under no concept',
                onSelect: () => rooms.remove(row.holder, { kind: c.kind, id: c.id }),
                testId: 'menu-concept-out',
              },
            ]
          : []),
        {
          label: `Take out of “${title(row.of.room.id)}”`,
          onSelect: () => rooms.remove(row.of.room.id, { kind: c.kind, id: c.id }),
          hint: c.explicit ? (row.also.length ? 'It stays in the other rooms it is in' : undefined) : 'It came with something in this room; it stays out until you put it back.',
          testId: 'menu-take-out',
        },
      ]).concat(deleteItems(items, thing)),
      c.title || 'Untitled',
    );
  };

  return (
    <div className={`room-folders${preview ? ' with-preview' : ''}`} data-testid="room-folders">
      {/* biome-ignore lint/a11y/useSemanticElements: a tree of rows, moved through with the arrow keys */}
      <div
        ref={list}
        className={`folders-list${overList ? ' drop-over' : ''}`}
        role="tree"
        aria-label={`What is in “${view.room.title}”`}
        tabIndex={rows.length && !current ? 0 : -1}
        onKeyDown={onKey}
        onFocus={(e) => {
          if (e.target === list.current && !current) select(rows[0]);
        }}
        onDragOver={(e) => {
          if (!accepts(e) && !isOutsideDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = draggedFrom(e) === roomId ? 'none' : 'copy';
          setOverList(true);
        }}
        onDragLeave={(e) => {
          if (!list.current?.contains(e.relatedTarget as Node)) setOverList(false);
        }}
        onDrop={(e) => {
          setOverList(false);
          const from = draggedFrom(e);
          if (from === roomId) return;
          // From a room opened in place: moved up into this one.
          if (from && accepts(e)) {
            e.preventDefault();
            void dropOn(e, roomId);
            return;
          }
          onDropHere(e);
        }}
        data-testid="folders-list"
      >
        <div className="folders-head" role="presentation">
          {COLUMNS.map((c) =>
            c.col ? (
              <button
                key={c.label}
                type="button"
                className={`${c.className}${sort.by === c.col ? ' is-sorted' : ''}`}
                onClick={() => changeSort(c.col as FolderColumn)}
                aria-label={`Sort by ${c.label.toLowerCase()}`}
                data-testid={`folders-sort-${c.col}`}
              >
                {c.label}
                {sort.by === c.col && <span aria-hidden>{sort.desc ? ' ↓' : ' ↑'}</span>}
              </button>
            ) : (
              <span key={c.label} className={c.className}>
                {c.label}
              </span>
            ),
          )}
        </div>
        {rows.length === 0 && empty}
        {rows.map((r) => {
          const isOpen = opened.has(r.id);
          const glyph = r.concept ? CONCEPT_GLYPH : r.door ? ROOM_GLYPH : GLYPH[r.card?.kind ?? 'thread'];
          const kindClass = r.concept ? 'concept' : (r.card?.kind ?? 'room');
          const target = r.concept?.id ?? r.door?.id;
          const takes = (e: DragEvent) => (r.concept ? isItemDrag(e) : accepts(e));
          const drag = r.concept
            ? null
            : r.door
              ? draggableRoom({ id: r.door.id, title: r.title })
              : draggableItem({ kind: r.card?.kind ?? 'thread', id: r.card?.id ?? '', title: r.title });
          return (
            // biome-ignore lint/a11y/useSemanticElements: a row of a tree
            <div
              key={r.id}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={r.folder ? isOpen : undefined}
              aria-selected={r.id === selected}
              tabIndex={r.id === selected ? 0 : -1}
              className={`folders-row${r.folder ? ' is-folder' : ''}${r.id === selected ? ' is-selected' : ''}${over === r.id ? ' is-target' : ''} kind-${kindClass}`}
              style={{ '--depth': r.depth } as CSSProperties}
              onClick={() => setSelected(r.id)}
              onDoubleClick={() => openRow(r)}
              onContextMenu={menuFor(r)}
              draggable={drag !== null}
              onDragStart={(e) => {
                if (!drag) return;
                drag.onDragStart(e);
                e.dataTransfer.setData(FROM_ROOM_MIME, r.holder);
                e.dataTransfer.effectAllowed = 'all';
              }}
              onDragOver={(e) => {
                if (!target || !takes(e)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = e.altKey || !draggedFrom(e) ? 'copy' : 'move';
                setOver(r.id);
              }}
              onDragLeave={() => setOver((o) => (o === r.id ? null : o))}
              onDrop={(e) => {
                if (!target || !takes(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(null);
                setOverList(false);
                void dropOn(e, target);
              }}
              data-row={r.id}
              data-key={r.key}
              data-depth={r.depth}
              data-testid="folder-row"
            >
              <span className="folders-name">
                {r.folder ? (
                  <button
                    type="button"
                    className="folders-twisty"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r);
                    }}
                    tabIndex={-1}
                    aria-label={isOpen ? `Close “${r.title}”` : `Open “${r.title}” here`}
                    data-testid="folder-toggle"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="folders-twisty" aria-hidden />
                )}
                <span className={`folders-glyph kind-${kindClass}`} aria-hidden>
                  {glyph}
                </span>
                {r.also.length > 0 && (
                  <span className="folders-alias" title="Also in another room: the same thing, not a copy" data-testid="folder-alias">
                    ↗
                  </span>
                )}
                <span className="folders-title">{r.title || (r.door ? 'Untitled room' : 'Untitled')}</span>
                {r.concept?.definition && <span className="folders-def hint">{r.concept.definition}</span>}
              </span>
              <span className="folders-kind">{r.kind}</span>
              <span className="folders-also" data-testid="folder-also">
                {r.under && r.under.length > 0 && (
                  <span data-testid="folder-also-under">
                    <span className="hint">also under </span>
                    {r.under.map((x, i) => (
                      <span key={x.id}>
                        {i > 0 && ', '}
                        <button
                          type="button"
                          className="link"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            onConcept(x.id);
                          }}
                        >
                          {CONCEPT_GLYPH} {x.title}
                        </button>
                      </span>
                    ))}
                    {r.also.length > 0 && '; '}
                  </span>
                )}
                {r.also.length > 0 ? (
                  <>
                    <span className="hint">also in </span>
                    {r.also.map((x, i) => (
                      <span key={x.id}>
                        {i > 0 && ', '}
                        <button
                          type="button"
                          className="link"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            rooms.openRoom(x.id);
                          }}
                        >
                          {x.title || 'Untitled room'}
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  !r.under?.length && <span className="hint">—</span>
                )}
              </span>
              <span className="folders-touched">{day(r.at)}</span>
              <span className="folders-open">{r.open > 0 ? `${r.open} open` : ''}</span>
            </div>
          );
        })}
        {rows.some((r) => r.also.length > 0) && (
          <p className="folders-foot hint">
            ↗ is in more than one room: the same thing, not a copy. Taking it out of this room leaves it in the others.
          </p>
        )}
        {status && (
          <p className="folders-foot hint" role="status" data-testid="folders-status">
            {status}
          </p>
        )}
      </div>
      {preview && (
        <FolderPreview
          row={current}
          roomTitle={title}
          onOpen={openRow}
          onOpenRoom={(id) => rooms.openRoom(id)}
          onOpenTarget={onOpenTarget}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}

/** The thing chosen, at a glance, as Finder's preview shows a file: what the AI made of it, where it lives, its links, what is open. */
function FolderPreview({
  row,
  roomTitle,
  onOpen,
  onOpenRoom,
  onOpenTarget,
  onClose,
}: {
  row: Row | undefined;
  roomTitle: (id: string) => string;
  onOpen: (row: Row) => void;
  onOpenRoom: (id: string) => void;
  onOpenTarget: (target: VaultTarget) => void;
  onClose: () => void;
}) {
  if (!row) {
    return (
      <aside className="folders-preview is-empty" aria-label="Preview" data-testid="folder-preview">
        <p className="hint">Pick a row to see it here. Double-click or Enter opens it; Space hides this.</p>
      </aside>
    );
  }
  const homes = [row.concept || !row.card ? row.holder : row.of.room.id, ...row.also.map((r) => r.id)];
  const head = row.concept
    ? `${CONCEPT_GLYPH} Concept · ${plural(row.concept.members.length, 'thing')}`
    : row.door
    ? `${ROOM_GLYPH} Room · ${holdsOf(row.door.counts) || 'nothing in it yet'}`
    : `${GLYPH[row.card?.kind ?? 'thread']} ${row.kind}${row.card && marksOf(row.card) ? ` · ${marksOf(row.card)}` : ''}`;
  const titles = new Map(row.of.clusters.flatMap((c) => c.cards).map((c) => [`${c.kind}:${c.id}`, c.title]));
  const links = row.card
    ? row.of.itemLinks.filter(
        (l) => l.status === 'accepted' && (`${l.from.kind}:${l.from.id}` === row.key || `${l.to.kind}:${l.to.id}` === row.key),
      )
    : [];
  const open = (row.of.brief?.open ?? []).filter((o) => o.item && `${o.item.kind}:${o.item.id}` === row.key);
  const text = row.concept ? row.concept.definition : row.door ? row.door.brief : (row.gist?.text ?? null);
  return (
    <aside className="folders-preview" aria-label={`Preview of “${row.title}”`} data-testid="folder-preview">
      <div className="folders-preview-top">
        <p className="folders-preview-kind">{head}</p>
        <button type="button" className="quiet inline" onClick={onClose} aria-label="Hide the preview" title="Hide the preview (Space)">
          ×
        </button>
      </div>
      <h3 data-testid="folder-preview-title">{row.title || 'Untitled'}</h3>
      {text && (
        <div className={`folders-preview-ai${row.gist && !row.gist.fresh ? ' is-stale' : ''}`} data-testid="folder-preview-ai">
          <p className="folders-preview-label">
            {row.concept ? (row.concept.by === 'ai' ? 'AI · what it is' : 'What it is') : row.door ? 'AI · its brief' : `AI · summary${row.gist?.fresh === false ? ', older' : ''}`}
          </p>
          <p>{text}</p>
          {row.concept?.quote?.quote && (
            <button type="button" className="room-point" onClick={() => row.concept?.quote && onOpenTarget(row.concept.quote)}>
              <span aria-hidden>↗ </span>“{row.concept.quote.quote}”
            </button>
          )}
          {row.gist && row.gist.points.length > 0 && (
            <ul className="room-points">
              {row.gist.points.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                <li key={i}>
                  {p.target ? (
                    <button type="button" className="room-point" onClick={() => p.target && onOpenTarget(p.target)}>
                      <span aria-hidden>↗ </span>
                      {p.text}
                    </button>
                  ) : (
                    <span className="room-point is-unfound">{p.text}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {row.door && row.door.things.length > 0 && (
        <ul className="folders-preview-things">
          {row.door.things.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <li key={i}>
              <span aria-hidden>{t.kind === 'room' ? ROOM_GLYPH : GLYPH[t.kind]} </span>
              {t.title || 'Untitled'}
            </li>
          ))}
        </ul>
      )}
      <dl className="folders-preview-facts">
        <dt>Lives in</dt>
        <dd data-testid="folder-preview-homes">
          {homes.map((id) => (
            <button key={id} type="button" className="link" onClick={() => onOpenRoom(id)}>
              {ROOM_GLYPH} {roomTitle(id)}
            </button>
          ))}
        </dd>
        {links.length > 0 && (
          <>
            <dt>Links</dt>
            <dd>
              {links.map((l) => {
                const out = `${l.from.kind}:${l.from.id}` === row.key;
                const other = out ? `${l.to.kind}:${l.to.id}` : `${l.from.kind}:${l.from.id}`;
                const words = l.label || LINK_WORDS[l.kind];
                return (
                  <span key={l.id} className="folders-preview-link">
                    {out ? `${words} “${titles.get(other) || 'Untitled'}”` : `“${titles.get(other) || 'Untitled'}” ${words} it`}
                  </span>
                );
              })}
            </dd>
          </>
        )}
        {(open.length > 0 || row.open > 0) && (
          <>
            <dt>Still open</dt>
            <dd className="folders-preview-open">
              {open.map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                <span key={i}>{o.question}</span>
              ))}
              {row.open > 0 && <span>{plural(row.open, 'side question')} you did not come back from</span>}
            </dd>
          </>
        )}
      </dl>
      <p className="folders-preview-actions">
        <button type="button" className="primary" onClick={() => onOpen(row)} data-testid="folder-preview-open">
          {row.concept ? 'Show in Concepts' : 'Open'}
        </button>
      </p>
    </aside>
  );
}
