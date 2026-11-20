// A room by its concepts (ADRs 0036, 0037): the key ideas its materials
// discuss, read from every piece of them, as nodes laid out by what comes
// first. A concept belongs to the notebook: it says how many materials discuss
// it and in how many places, and its drawer lists each material with its places
// (what it does there, what it says, the words, which open where they are).
// Things under several concepts say so, and choosing a concept lights up those
// it shares things with. Suggested concepts are dashed: Keep, Not this, Keep
// all. When materials change, the bar says so: Update reads only what changed.
// Drag a thing onto a concept to move it there (its places go with it); with ⌥
// it stays in both.

import {
  CONCEPTS_SHOWN,
  type Concept,
  type ConceptLink,
  type ConceptPlace,
  LINK_WORDS,
  type LinkKind,
  pathOrder,
  type RoomItemRef,
  type RoomKind,
  type RoomView as RoomViewData,
  ulid,
  type VaultTarget,
} from '@noema/core';
import { type DragEvent, type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { openMenu } from './ContextMenu.tsx';
import { draggableItem, draggedFrom, droppedItem, FROM_ROOM_MIME, isItemDrag } from './drag.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { deleteItems, useItems } from './itemMenu.ts';
import { Orb } from './LivingFrame.tsx';
import { roomMenu, useRooms } from './Rooms.tsx';
import { asRead, CONCEPT_GLYPH, GLYPH, plural, type RoomCard, refOf } from './roomText.ts';

const LANES = ['Start here', 'Builds on it', 'Goes further'];
const QUOTE_FROM: Record<VaultTarget['kind'], string> = { thread: 'your thread', source: 'your source', note: 'your note' };
const ROLE_WORD: Record<ConceptPlace['role'], string> = { defines: 'defines it', explains: 'explains it', uses: 'uses it', example: 'an example', asks: 'asks about it' };
type Box = { x: number; y: number; w: number; h: number };

export function RoomConcepts({
  view,
  selected,
  onSelect,
  busy,
  onRead,
  onOpen,
  onOpenTarget,
  onAskAbout,
}: {
  view: RoomViewData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  busy: boolean;
  /** Read the room with AI: summaries, links, concepts (only what changed), brief. */
  onRead: () => void;
  onOpen: (kind: RoomKind, id: string) => void;
  onOpenTarget: (target: VaultTarget) => void;
  /** Start a question in the room about something. */
  onAskAbout: (text: string) => void;
}) {
  const rooms = useRooms();
  const items = useItems();
  const roomId = view.room.id;
  const [over, setOver] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const map = useRef<HTMLDivElement>(null);

  const cards = new Map<string, RoomCard>(view.clusters.flatMap((c) => c.cards.map((x) => [`${x.kind}:${x.id}`, x] as const)));
  const all = view.concepts;
  // Kept ones always; suggested ones, the most present first, up to a readable number. The rest fold away.
  const kept = all.filter((c) => c.status === 'kept');
  const room = Math.max(0, CONCEPTS_SHOWN - kept.length);
  const suggestedAll = all.filter((c) => c.status === 'suggested');
  const concepts = [...kept, ...suggestedAll.slice(0, room)];
  const more = suggestedAll.slice(room);
  const byId = new Map(all.map((c) => [c.id, c]));
  const shown = new Set(concepts.map((c) => c.id));
  const current = (selected && byId.get(selected)) || concepts[0] || null;
  const suggested = suggestedAll.length;
  const under = new Set(concepts.flatMap((c) => c.members as string[]));
  const tray = [...cards.keys()].filter((k) => !under.has(k));
  const links = view.conceptLinks.filter((l) => shown.has(l.from) && shown.has(l.to));
  /** The other concepts shown that hold a thing. */
  const alsoUnder = (key: string, except: string) => concepts.filter((c) => c.id !== except && (c.members as string[]).includes(key));
  /** How many things the concept chosen shares with each other one. */
  const sharing = new Map<string, number>();
  if (current) {
    for (const c of concepts) {
      if (c.id === current.id) continue;
      const n = c.members.filter((k) => current.members.includes(k)).length;
      if (n > 0) sharing.set(c.id, n);
    }
  }

  // Laid out by what comes first: the lanes are the path's depths (ADR 0035), the third holds all that go further.
  const path = pathOrder(
    concepts.map((c) => c.id),
    links.map((l) => ({ from: l.from, to: l.to, kind: l.kind })),
  );
  const lanes: string[][] = [[], [], []];
  for (const s of path.steps) for (const id of [s.key, ...s.beside]) lanes[Math.min(2, s.level)]?.push(id);
  for (const id of path.loose) lanes[0]?.push(id);
  const laneCount = lanes[2]?.length ? 3 : lanes[1]?.length ? 2 : 1;

  // Where each concept is, for the lines between them.
  useLayoutEffect(() => {
    if (!map.current) return;
    const origin = map.current.getBoundingClientRect();
    const next = new Map<string, Box>();
    for (const el of map.current.querySelectorAll<HTMLElement>('[data-concept-id]')) {
      const r = el.getBoundingClientRect();
      next.set(el.dataset.conceptId as string, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    }
    const same =
      next.size === boxes.size &&
      [...next].every(([k, b]) => {
        const o = boxes.get(k);
        return o && Math.abs(o.x - b.x) < 1 && Math.abs(o.y - b.y) < 1 && Math.abs(o.w - b.w) < 1 && Math.abs(o.h - b.h) < 1;
      });
    if (!same) setBoxes(next);
  });

  const run = async (what: () => Promise<unknown>, problem: string) => {
    try {
      await what();
      setStatus(null);
      await rooms.refresh();
    } catch (err) {
      setStatus(err instanceof ApiFailure ? err.message : problem);
    }
  };
  /**
   * A thing let go on a concept: moved there, with its places, from the concept it was dragged out of; with ⌥, or
   * from elsewhere, put in it as well (and in the room, if it was not).
   */
  const dropOn = async (e: DragEvent, target: string) => {
    const item = droppedItem(e);
    if (!item) return;
    const from = draggedFrom(e);
    const ref = rooms.unit(item);
    const fromConcept = from && byId.has(from) && from !== target ? from : null;
    const name = byId.get(target)?.title ?? '';
    await run(async () => {
      if (!cards.has(`${ref.kind}:${ref.id}`)) await api.addToRoom(roomId, [ref]);
      if (fromConcept && !e.altKey) await api.moveInConcepts(fromConcept, ref, target);
      else await api.addToRoom(target, [ref]);
    }, 'It could not be put there.');
    setStatus(`“${item.title || 'Untitled'}” is under “${name}” now${fromConcept && e.altKey ? ', and still under the other' : ''}.`);
  };
  const accepts = (e: DragEvent) => isItemDrag(e);
  const thingMenu = (ref: RoomItemRef, title: string, concept: Concept | null) => (e: MouseEvent) => {
    const thing = { kind: ref.kind, id: ref.id, title };
    openMenu(
      e,
      roomMenu(rooms, thing, [
        { label: 'Open', onSelect: () => onOpen(ref.kind, ref.id) },
        ...(concept ? [{ label: `Take out of “${concept.title}”`, onSelect: () => rooms.remove(concept.id, ref), testId: 'menu-concept-out' }] : []),
        ...(cards.has(`${ref.kind}:${ref.id}`)
          ? [{ label: 'Take out of this room', onSelect: () => rooms.remove(roomId, ref), testId: 'menu-take-out' }]
          : []),
      ]).concat(deleteItems(items, thing)),
      title || 'Untitled',
    );
  };
  const drag = (ref: RoomItemRef, title: string, from: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      draggableItem({ kind: ref.kind, id: ref.id, title }).onDragStart(e);
      e.dataTransfer.setData(FROM_ROOM_MIME, from);
      e.dataTransfer.effectAllowed = 'all';
    },
  });
  const chips = (key: string, except: string) => {
    const others = alsoUnder(key, except);
    if (others.length === 0) return null;
    return (
      <span className="concepts-also" data-testid="also-under">
        also under{' '}
        {others.map((o, i) => (
          <span key={o.id}>
            {i > 0 && ', '}
            <button type="button" className="quiet inline" onClick={() => onSelect(o.id)}>
              {CONCEPT_GLYPH} {o.title}
            </button>
          </span>
        ))}
      </span>
    );
  };

  const counts = (c: Concept) => {
    const n: Record<RoomKind, number> = { thread: 0, source: 0, note: 0 };
    for (const k of c.members) n[refOf(k).kind] += 1;
    return (['thread', 'source', 'note'] as const)
      .filter((k) => n[k] > 0)
      .map((k) => (
        <span key={k} className={`concept-count kind-${k}`}>
          {GLYPH[k]} {n[k]}
        </span>
      ));
  };
  const openOf = (c: Concept) =>
    (view.brief?.open ?? [])
      .filter((o) => o.item && o.item.kind !== 'room' && c.members.includes(`${o.item.kind}:${o.item.id}` as never))
      .map((o) => o.question);

  const node = (c: Concept) => {
    const isOn = current?.id === c.id;
    const shares = sharing.get(c.id);
    const open = openOf(c);
    return (
      // biome-ignore lint/a11y/useSemanticElements: a node that takes things dropped on it, with buttons in it
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        className={`concept-node${c.status === 'suggested' ? ' is-suggested' : ''}${isOn ? ' is-selected' : ''}${over === c.id ? ' is-target' : ''}${shares ? ' is-sharing' : ''}`}
        onClick={() => onSelect(c.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(c.id);
          }
        }}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
          setOver(c.id);
        }}
        onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
        onDrop={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          setOver(null);
          void dropOn(e, c.id);
        }}
        data-concept-id={c.id}
        data-status={c.status}
        data-testid="concept-node"
      >
        {shares && (
          <span className="concept-shares" data-testid="concept-shares">
            shares {shares}
          </span>
        )}
        <p className="concept-name">
          <span className="concept-glyph" aria-hidden>
            {CONCEPT_GLYPH}
          </span>{' '}
          {c.title}
        </p>
        {c.definition && <p className="concept-def">{c.definition}</p>}
        <p className="concept-counts">
          {c.members.length ? counts(c) : <span className="hint">Nothing under it yet</span>}
          <span className="concept-where" data-testid="concept-where">
            {c.lost ? 'no longer found in your materials' : `in ${plural(c.materials, 'material')} · ${plural(c.places, 'place')}`}
          </span>
        </p>
        {open[0] && <p className="concept-open">? {open[0]}</p>}
        {c.status === 'suggested' && (
          <p className="concept-suggest">
            <span>Suggested by the AI ·</span>
            <button
              type="button"
              className="quiet inline"
              onClick={(e) => {
                e.stopPropagation();
                void run(() => api.keepConcept(c.id), 'It could not be kept.');
              }}
              data-testid="concept-keep"
            >
              Keep
            </button>
            <span>·</span>
            <button
              type="button"
              className="quiet inline"
              onClick={(e) => {
                e.stopPropagation();
                void run(() => api.dropConcept(c.id), 'It could not be dismissed.');
              }}
              data-testid="concept-not-this"
            >
              Not this
            </button>
          </p>
        )}
      </div>
    );
  };

  // The lines: from what comes first to what follows; side by side, dashed. Suggested ones fainter.
  const lines = links.flatMap((l) => {
    const a = boxes.get(l.to);
    const b = boxes.get(l.from);
    if (!a || !b) return [];
    const across = Math.abs(a.x - b.x) > 20;
    let d: string;
    let mid: { x: number; y: number };
    if (across) {
      const right = b.x > a.x;
      const p1 = { x: right ? a.x + a.w : a.x, y: a.y + Math.min(a.h / 2, 34) };
      const p2 = { x: right ? b.x : b.x + b.w, y: b.y + Math.min(b.h / 2, 34) };
      const bend = Math.max(30, Math.abs(p2.x - p1.x) / 2) * (right ? 1 : -1);
      d = `M${p1.x},${p1.y} C${p1.x + bend},${p1.y} ${p2.x - bend},${p2.y} ${p2.x},${p2.y}`;
      mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    } else {
      const down = b.y > a.y;
      const p1 = { x: a.x + a.w * 0.62, y: down ? a.y + a.h : a.y };
      const p2 = { x: b.x + b.w * 0.62, y: down ? b.y : b.y + b.h };
      d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
      mid = { x: p1.x, y: (p1.y + p2.y) / 2 };
    }
    return [{ l, d, mid }];
  });

  const toRead = view.conceptsToRead;
  const things = cards.size;
  const keepAll = () => void run(() => api.keepAllConcepts(roomId), 'They could not be kept.');

  return (
    <div className="room-concepts" data-testid="room-concepts">
      <div className="concepts-bar">
        <Orb size="small" />
        <p className="concepts-bar-text" data-testid="concepts-bar">
          {all.length > 0 ? (
            <>
              <b>{plural(all.length, 'concept')}</b> in your {plural(things, 'thing')}
              {suggested > 0 && ` · ${suggested} suggested`}
            </>
          ) : busy ? (
            'Reading the room…'
          ) : (
            'No concepts yet'
          )}
        </p>
        {suggested > 0 && (
          <button type="button" className="ai-button is-strong" onClick={keepAll} data-testid="concepts-keep-all">
            <Orb size="small" />
            Keep all
          </button>
        )}
        <button type="button" className="ai-button" onClick={onRead} disabled={busy} data-testid="concepts-read">
          <Orb size="small" />
          {busy ? 'Reading…' : all.length === 0 ? 'Find the concepts' : toRead.materials > 0 ? 'Update' : 'Read again'}
        </button>
        {naming ? (
          <form
            className="concepts-new"
            onSubmit={(e) => {
              e.preventDefault();
              const title = String(new FormData(e.currentTarget).get('title') ?? '').trim();
              setNaming(false);
              if (!title) return;
              const id = ulid();
              void run(async () => {
                await api.createConcept(roomId, id, title);
                onSelect(id);
              }, 'The concept could not be made.');
            }}
          >
            {/* biome-ignore lint/a11y/noAutofocus: typed into at once, after the click that opened it */}
            <input name="title" placeholder="Name of the concept" aria-label="Name of the new concept" autoFocus onBlur={() => setNaming(false)} data-testid="concept-new-title" />
          </form>
        ) : (
          <button type="button" className="quiet" onClick={() => setNaming(true)} data-testid="concept-new">
            + Concept
          </button>
        )}
      </div>
      {all.length > 0 && toRead.materials > 0 && !busy && (
        <p className="concepts-changed" data-testid="concepts-changed">
          {toRead.changed > 0
            ? `${plural(toRead.changed, 'material')} changed since its concepts were read`
            : `${plural(toRead.materials, 'material')} not read for concepts yet`}
          {toRead.changed > 0 && toRead.materials > toRead.changed && `, ${toRead.materials - toRead.changed} not read yet`}
          {' · '}
          <button type="button" className="quiet inline" onClick={onRead} data-testid="concepts-update">
            Update
          </button>
          <span className="hint"> · about {plural(toRead.pieces + 2, 'call')}, only what changed</span>
        </p>
      )}
      {status && (
        <p className="hint room-status" role="status" data-testid="concepts-status">
          {status}
        </p>
      )}
      {all.length === 0 ? (
        <div className="concepts-empty" data-testid="concepts-empty">
          <p className="empty-title">What is this room about?</p>
          <p className="hint">
            Read with AI, and it reads every piece of your threads, sources and notes for the ideas they discuss, with the
            words where they do, and joins them across your notebook: the same idea in a paper and in a thread is one
            concept. You keep them, rename, merge or split them. When a material changes, only what changed is read again
            {toRead.pieces > 0 && ` (this room: about ${plural(toRead.pieces + 2, 'call')} the first time)`}.
          </p>
        </div>
      ) : (
        <div className="concepts-body">
          <div className="concepts-map" ref={map}>
            <svg className="concepts-lines" aria-hidden>
              <defs>
                <marker id="concept-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" />
                </marker>
              </defs>
              {lines.map(({ l, d }) => (
                <path
                  key={l.id}
                  d={d}
                  className={`concept-line kind-${l.kind}${l.status === 'suggested' ? ' is-suggested' : ''}`}
                  markerEnd={l.kind === 'contrasts-with' ? undefined : 'url(#concept-arrow)'}
                />
              ))}
            </svg>
            {lines.map(({ l, mid }) => (
              <span
                key={l.id}
                className={`concept-line-label kind-${l.kind}${l.status === 'suggested' ? ' is-suggested' : ''}`}
                style={{ left: mid.x, top: mid.y }}
                title={l.why ?? undefined}
                data-testid="concept-line-label"
              >
                {l.kind === 'contrasts-with' ? 'contrasts' : LINK_WORDS[l.kind]}
              </span>
            ))}
            <div className="concepts-lanes" style={{ gridTemplateColumns: `repeat(${laneCount}, minmax(0, 1fr))` }}>
              {lanes.slice(0, laneCount).map((lane, i) => (
                <div key={LANES[i]} className="concepts-lane" data-testid="concepts-lane">
                  <p className="concepts-lanehead">{laneCount === 1 ? 'Not in an order yet' : LANES[i]}</p>
                  {lane.map((id) => {
                    const c = byId.get(id);
                    return c ? node(c) : null;
                  })}
                </div>
              ))}
            </div>
            {more.length > 0 && (
              <div className="concepts-more" data-testid="concepts-more">
                <button type="button" className="quiet inline" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen}>
                  {moreOpen ? '▾' : '▸'} More ideas here · {more.length}
                </button>
                {moreOpen && (
                  <ul className="concepts-more-list">
                    {more.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="quiet inline" onClick={() => onSelect(c.id)}>
                          {CONCEPT_GLYPH} {c.title}
                        </button>
                        <span className="hint">
                          {' '}
                          · {plural(c.materials, 'material')} ·{' '}
                        </span>
                        <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConcept(c.id), 'It could not be kept.')}>
                          Keep
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a place to drop a thing to take it out of its concept */}
            <div
              className={`concepts-tray${over === 'tray' ? ' is-target' : ''}`}
              onDragOver={(e) => {
                const from = draggedFrom(e);
                if (!accepts(e) || !from || !byId.has(from)) return;
                e.preventDefault();
                setOver('tray');
              }}
              onDragLeave={() => setOver((o) => (o === 'tray' ? null : o))}
              onDrop={(e) => {
                setOver(null);
                const from = draggedFrom(e);
                const item = droppedItem(e);
                if (!item || !from || !byId.has(from)) return;
                e.preventDefault();
                void rooms.remove(from, rooms.unit(item));
              }}
              data-testid="concepts-tray"
            >
              <p className="concepts-lanehead">Not under a concept yet · {tray.length}</p>
              {tray.length === 0 ? (
                <p className="hint">Everything here is under a concept.</p>
              ) : (
                <ul className="concepts-things">
                  {tray.map((k) => {
                    const card = cards.get(k) as RoomCard;
                    const ref = { kind: card.kind, id: card.id };
                    return (
                      <li
                        key={k}
                        className={`concepts-thing kind-${card.kind}`}
                        {...drag(ref, card.title, roomId)}
                        onContextMenu={thingMenu(ref, card.title, null)}
                        data-key={k}
                        data-testid="tray-item"
                      >
                        <button type="button" className="concepts-thing-open" onClick={() => onOpen(card.kind, card.id)}>
                          <span className="concepts-thing-glyph" aria-hidden>
                            {GLYPH[card.kind]}
                          </span>{' '}
                          {card.title || 'Untitled'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          {current && (
            <ConceptDrawer
              key={current.id}
              concept={current}
              others={concepts.filter((c) => c.id !== current.id)}
              links={links.filter((l) => l.from === current.id || l.to === current.id)}
              open={openOf(current)}
              run={run}
              roomId={roomId}
              onOpen={onOpen}
              onOpenTarget={onOpenTarget}
              onAskAbout={onAskAbout}
              onSelect={onSelect}
              titleOf={(id) => byId.get(id)?.title ?? ''}
              chips={chips}
              drag={drag}
              thingMenu={thingMenu}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The concept chosen: its words, the materials that discuss it and where, its links, and what can be done with it. */
function ConceptDrawer({
  concept: c,
  others,
  links,
  open,
  run,
  roomId,
  onOpen,
  onOpenTarget,
  onAskAbout,
  onSelect,
  titleOf,
  chips,
  drag,
  thingMenu,
}: {
  concept: Concept;
  others: Concept[];
  links: ConceptLink[];
  open: string[];
  run: (what: () => Promise<unknown>, problem: string) => Promise<void>;
  roomId: string;
  onOpen: (kind: RoomKind, id: string) => void;
  onOpenTarget: (target: VaultTarget) => void;
  onAskAbout: (text: string) => void;
  onSelect: (id: string | null) => void;
  titleOf: (id: string) => string;
  chips: (key: string, except: string) => ReactNode;
  drag: (ref: RoomItemRef, title: string, from: string) => { draggable: boolean; onDragStart: (e: DragEvent) => void };
  thingMenu: (ref: RoomItemRef, title: string, concept: Concept | null) => (e: MouseEvent) => void;
}) {
  const [doing, setDoing] = useState<'merge' | 'split' | 'remove' | 'link' | null>(null);
  const [split, setSplit] = useState<Set<string>>(new Set());
  const [splitName, setSplitName] = useState('');
  const [linkTo, setLinkTo] = useState<{ to: string; kind: LinkKind }>({ to: others[0]?.id ?? '', kind: 'builds-on' });
  const suggested = c.status === 'suggested';
  return (
    <aside className="concepts-drawer" aria-label={`The concept “${c.title}”`} data-testid="concept-drawer">
      <p className="concepts-kicker">
        {CONCEPT_GLYPH} Concept · {suggested ? 'suggested by the AI' : c.by === 'ai' ? 'kept' : 'yours'}
      </p>
      <EditableTitle
        title={c.title}
        label="Rename this concept"
        onRename={(title) => run(() => api.renameRoom(c.id, title), 'It could not be renamed.')}
        testId="concept-rename"
        inputTestId="concept-title-input"
      />
      {c.names.length > 0 && (
        <p className="concept-names hint" data-testid="concept-names">
          Also called {c.names.map((n) => `“${n}”`).join(', ')}
        </p>
      )}
      {c.quote?.quote && (
        <blockquote className="concept-quote" data-testid="concept-quote">
          <p>“{asRead(c.quote.quote)}”</p>
          <footer>
            — {QUOTE_FROM[c.quote.kind]} “{c.quote.title || 'Untitled'}” ·{' '}
            <button type="button" className="quiet inline" onClick={() => c.quote && onOpenTarget(c.quote)} data-testid="concept-quote-open">
              open the words
            </button>
          </footer>
        </blockquote>
      )}
      {c.definition && <p className="concept-def">{c.definition}</p>}
      <p className="concepts-label" data-testid="concept-sources-label">
        {c.lost ? 'No longer found in your materials' : `In ${plural(c.materials, 'material')} · ${plural(c.places, 'place')}`}
      </p>
      {c.sources.length ? (
        <ul className="concept-sources">
          {c.sources.map((x) => {
            const ref = refOf(x.item) as RoomItemRef;
            return (
              <li key={x.item} className={`concept-source kind-${ref.kind}`} data-key={x.item} data-testid="concept-source">
                {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut; its buttons do the same */}
                <div className="concept-source-head" {...drag(ref, x.title, c.id)} onContextMenu={thingMenu(ref, x.title, c)}>
                  <button type="button" className="concepts-thing-open" onClick={() => onOpen(ref.kind, ref.id)}>
                    <span className="concepts-thing-glyph" aria-hidden>
                      {GLYPH[ref.kind]}
                    </span>{' '}
                    {x.title || 'Untitled'}
                  </button>
                  {!x.inRoom && <span className="hint">in another room</span>}
                  <button
                    type="button"
                    className="quiet inline concepts-thing-out"
                    onClick={() => void run(() => api.removeFromRoom(c.id, ref), 'It could not be taken out.')}
                    title={`Take out of “${c.title}”; it stays where it is`}
                    aria-label={`Take “${x.title}” out of “${c.title}”`}
                    data-testid="concept-thing-out"
                  >
                    ×
                  </button>
                </div>
                {chips(x.item, c.id)}
                {x.places.length > 0 ? (
                  <ul className="concept-places">
                    {x.places.map((p) => (
                      <li key={p.id} className={p.target ? '' : 'is-lost'} data-testid="concept-place">
                        <span className="concept-place-role">{p.by === 'you' ? 'you put it here' : ROLE_WORD[p.role]}</span>
                        {p.says && <span className="concept-place-says"> · {p.says}</span>}
                        <button
                          type="button"
                          className="concept-place-quote"
                          disabled={!p.target}
                          onClick={() => p.target && onOpenTarget(p.target)}
                          title={p.target ? 'Open where these words are' : 'These words are no longer in it'}
                          data-testid="concept-place-open"
                        >
                          “{asRead(p.quote)}”{!p.target && <span className="hint"> (not found)</span>}
                        </button>
                        {p.by === 'you' && (
                          <button
                            type="button"
                            className="quiet inline"
                            aria-label="Remove this place"
                            onClick={() => void run(() => api.removeConceptPlace(p.id), 'It could not be removed.')}
                          >
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint concept-places-none">Put here by you, or kept with it: no words found for it in this one.</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hint">Drag things here from the tray, or from another concept.</p>
      )}
      {open.length > 0 && (
        <ul className="concept-open-list">
          {open.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <li key={i}>? {q}</li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <>
          <p className="concepts-label">Links</p>
          <ul className="concept-links">
            {links.map((l) => (
              <li key={l.id} className={l.status === 'suggested' ? 'is-suggested' : ''} data-testid="concept-link">
                <span>
                  {l.from === c.id ? `${LINK_WORDS[l.kind]} ` : `“${titleOf(l.from)}” ${LINK_WORDS[l.kind]} `}
                  <button type="button" className="quiet inline" onClick={() => onSelect(l.from === c.id ? l.to : l.from)}>
                    {l.from === c.id ? `“${titleOf(l.to)}”` : 'it'}
                  </button>
                  {l.status === 'suggested' && <span className="hint"> · suggested</span>}
                </span>
                {l.status === 'suggested' && (
                  <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConceptLink(l.id), 'It could not be kept.')}>
                    Keep
                  </button>
                )}
                <button type="button" className="quiet inline" aria-label="Remove this link" onClick={() => void run(() => api.deleteConceptLink(l.id), 'It could not be removed.')}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="hint concepts-hint">Drag a thing onto another concept to move it, with its places; with ⌥ to keep it in both. Select words in a thread, source or note to put them under a concept.</p>
      <div className="concept-actions">
        {suggested && (
          <button type="button" className="primary" onClick={() => void run(() => api.keepConcept(c.id), 'It could not be kept.')} data-testid="drawer-keep">
            Keep
          </button>
        )}
        {others.length > 0 && (
          <button type="button" className={doing === 'link' ? 'active' : 'quiet'} onClick={() => setDoing((d) => (d === 'link' ? null : 'link'))} data-testid="concept-link-to">
            Link to…
          </button>
        )}
        {others.length > 0 && (
          <button type="button" className={doing === 'merge' ? 'active' : 'quiet'} onClick={() => setDoing((d) => (d === 'merge' ? null : 'merge'))} data-testid="concept-merge">
            Merge into…
          </button>
        )}
        {c.sources.length > 1 && (
          <button type="button" className={doing === 'split' ? 'active' : 'quiet'} onClick={() => setDoing((d) => (d === 'split' ? null : 'split'))} data-testid="concept-split">
            Split…
          </button>
        )}
        <button
          type="button"
          className="quiet"
          onClick={() => void run(() => api.conceptToRoom(c.id, roomId), 'It could not be made a room.')}
          title="A room of its own, inside this one"
          data-testid="concept-to-room"
        >
          Make it a room
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => (suggested ? void run(() => api.dropConcept(c.id), 'It could not be dismissed.') : setDoing('remove'))}
          data-testid="concept-remove"
        >
          {suggested ? 'Not this' : 'Remove'}
        </button>
      </div>
      {doing === 'remove' && (
        <div className="askbox confirm-row" role="alert" data-testid="concept-remove-confirm">
          <span>Remove “{c.title}”? Its things stay where they are, and it is not suggested again.</span>
          <button type="button" onClick={() => void run(() => api.dropConcept(c.id), 'It could not be removed.')} data-testid="concept-remove-yes">
            Remove
          </button>
          <button type="button" className="quiet" onClick={() => setDoing(null)}>
            Keep it
          </button>
        </div>
      )}
      {doing === 'link' && (
        <form
          className="concept-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!linkTo.to) return;
            setDoing(null);
            void run(() => api.createConceptLink(roomId, ulid(), c.id, linkTo.to, linkTo.kind), 'It could not be linked.');
          }}
        >
          <span>“{c.title}”</span>
          <select value={linkTo.kind} onChange={(e) => setLinkTo((x) => ({ ...x, kind: e.target.value as LinkKind }))} aria-label="How it links" data-testid="concept-link-kind">
            {(['builds-on', 'part-of', 'contrasts-with', 'example-of', 'explains'] as const).map((k) => (
              <option key={k} value={k}>
                {LINK_WORDS[k]}
              </option>
            ))}
          </select>
          <select value={linkTo.to} onChange={(e) => setLinkTo((x) => ({ ...x, to: e.target.value }))} aria-label="The other concept" data-testid="concept-link-other">
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
          <button type="submit" data-testid="concept-link-save">
            Link
          </button>
        </form>
      )}
      {doing === 'merge' && (
        <div className="concept-form" data-testid="concept-merge-pick">
          <span>Merge “{c.title}” into:</span>
          {others.map((o) => (
            <button
              key={o.id}
              type="button"
              className="quiet"
              onClick={() =>
                void run(async () => {
                  await api.mergeRoom(c.id, o.id);
                  onSelect(o.id);
                }, 'They could not be merged.')
              }
              data-testid="concept-merge-into"
            >
              {CONCEPT_GLYPH} {o.title}
            </button>
          ))}
        </div>
      )}
      {doing === 'split' && (
        <form
          className="concept-form is-split"
          onSubmit={(e) => {
            e.preventDefault();
            const title = splitName.trim();
            const moving = [...split];
            if (!title || moving.length === 0 || moving.length === c.sources.length) return;
            const id = ulid();
            setDoing(null);
            void run(async () => {
              await api.splitConcept(
                c.id,
                id,
                title,
                moving.map((k) => refOf(k) as RoomItemRef),
              );
              onSelect(id);
            }, 'It could not be split.');
          }}
          data-testid="concept-split-form"
        >
          <span>Tick the materials that go to the new concept, with their places:</span>
          {c.sources.map((x) => (
            <label key={x.item} className="concept-split-row">
              <input
                type="checkbox"
                checked={split.has(x.item)}
                onChange={() =>
                  setSplit((s) => {
                    const next = new Set(s);
                    if (next.has(x.item)) next.delete(x.item);
                    else next.add(x.item);
                    return next;
                  })
                }
                data-testid="concept-split-pick"
              />
              {x.title || 'Untitled'}
            </label>
          ))}
          <input value={splitName} onChange={(e) => setSplitName(e.target.value)} placeholder="Name of the new concept" aria-label="Name of the new concept" data-testid="concept-split-title" />
          <button type="submit" disabled={!splitName.trim() || split.size === 0 || split.size === c.sources.length} data-testid="concept-split-save">
            Split
          </button>
        </form>
      )}
      <button type="button" className="ai-button concept-ask" onClick={() => onAskAbout(`About “${c.title}”: `)} data-testid="concept-ask">
        <Orb size="small" />
        Ask about this concept
      </button>
    </aside>
  );
}
