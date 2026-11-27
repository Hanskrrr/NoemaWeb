// A room by its concepts (ADRs 0036 to 0038): the key ideas its threads and
// notes discuss, as cards, topic by topic. In a topic, cards are laid out in
// lanes by what comes first (what builds on what; a kind or part of a concept
// after it), with the lines between them. A concept belongs to the notebook:
// its card says how many materials discuss it and in how many places, and its
// drawer lists each material with its places, where its words appear in the
// sources, what it is under and what is inside it. New ideas and new places
// wait in Review. When threads or notes change, the bar says so: Update reads
// only what changed. Drag a thing onto a concept to move it there (its places go
// with it; with ⌥ it stays in both), or a concept onto another, or onto a
// topic, to put it there.

import {
  type Concept,
  type ConceptLink,
  type ConceptPlace,
  type ConceptWords,
  HOW_WORDS,
  LINK_WORDS,
  type LinkKind,
  type RoomItemRef,
  type RoomKind,
  type RoomReading,
  type RoomView as RoomViewData,
  ulid,
  type VaultTarget,
  pathOrder,
  workWeight,
} from '@noema/core';
import { type DragEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { openMenu } from './ContextMenu.tsx';
import { draggableItem, draggedFrom, droppedItem, FROM_ROOM_MIME, isItemDrag, ITEM_MIME } from './drag.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { deleteItems, useItems } from './itemMenu.ts';
import { Orb } from './LivingFrame.tsx';
import { roomMenu, useRooms } from './Rooms.tsx';
import { asRead, CONCEPT_GLYPH, GLYPH, plural, type RoomCard, refOf } from './roomText.ts';
import { keys, storage } from './storage.ts';

/** Display lenses. No new data: each one chooses what a card says and whether topics start open. */
export type ConceptsLens = 'study' | 'explore' | 'audit';
const LENSES: ReadonlySet<string> = new Set(['study', 'explore', 'audit']);
const isLens = (x: unknown): x is ConceptsLens => typeof x === 'string' && LENSES.has(x);

const QUOTE_FROM: Record<VaultTarget['kind'], string> = { thread: 'your thread', source: 'your source', note: 'your note' };
const ROLE_WORD: Record<ConceptPlace['role'], string> = { defines: 'defines it', explains: 'explains it', uses: 'uses it', example: 'an example', asks: 'asks about it' };
const CONCEPT_LINK_CHOICES: LinkKind[] = ['builds-on', 'contrasts-with', 'example-of', 'explains'];
/** Cards shown in a topic before the rest fold away, the most worked with first. */
const SHOWN_IN_TOPIC = 8;
/** A concept card being dragged, to put it under another concept or in a topic. */
const CONCEPT_MIME = 'application/x-noema-concept';
const isConceptDrag = (e: DragEvent) => e.dataTransfer.types.includes(CONCEPT_MIME);

/** A topic: a concept that holds others and no thing of its own (ADR 0038). */
export const isTopic = (c: Concept, all: readonly Concept[]) => c.members.length === 0 && all.some((o) => o.home?.id === c.id);

export function RoomConcepts({
  view,
  selected,
  onSelect,
  busy,
  reading,
  onRead,
  onStop,
  onOpen,
  onOpenTarget,
  onAskAbout,
}: {
  view: RoomViewData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  busy: boolean;
  reading: RoomReading | null;
  /** Read the room with AI: summaries, links, concepts (only what changed), brief. */
  onRead: () => void;
  onStop: () => void;
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
  const [finding, setFinding] = useState('');
  /** Topics folded shut, and topics showing all their cards. Null means the room has not been touched: only its first topic is open. */
  const [closed, setClosed] = useState<ReadonlySet<string> | null>(null);
  const [moreOpen, setMoreOpen] = useState<ReadonlySet<string>>(new Set());
  const [lens, setLens] = useState<ConceptsLens>(() => {
    const saved = storage.get(keys.conceptsLens);
    return isLens(saved) ? saved : 'study';
  });
  const chooseLens = (next: string) => {
    if (!isLens(next)) return;
    setLens(next);
    storage.set(keys.conceptsLens, next);
    if (next !== 'study') setClosed(null);
  };
  const board = useRef<HTMLDivElement>(null);
  const conceptPage = useRef<HTMLDivElement>(null);

  // Native drag-and-drop may consume wheel events. Keeping the pointer in an edge zone also scrolls the page.
  useEffect(() => {
    const root = conceptPage.current;
    const page = document.scrollingElement;
    if (!root || !page) return;
    let scroller: Element | null = null;
    let pointerY: number | null = null;
    let frame = 0;
    const findScroller = () => {
      for (let el = root.parentElement; el && el !== page; el = el.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
      }
      return page;
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointerY = null;
      scroller = null;
    };
    const tick = () => {
      frame = 0;
      if (!scroller || pointerY === null) return;
      const rect = scroller === page ? null : scroller.getBoundingClientRect();
      const top = Math.max(0, rect?.top ?? 0);
      const bottom = Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight);
      const zone = Math.min(108, (bottom - top) / 3);
      const above = top + zone - pointerY;
      const below = pointerY - (bottom - zone);
      const speed = above > 0 ? -Math.ceil(24 * Math.min(1, above / zone))
        : below > 0 ? Math.ceil(24 * Math.min(1, below / zone)) : 0;
      if (!speed) return;
      const previous = scroller.scrollTop;
      scroller.scrollTop += speed;
      if (scroller.scrollTop !== previous) frame = requestAnimationFrame(tick);
    };
    const over = (event: globalThis.DragEvent) => {
      const types = event.dataTransfer?.types;
      if (!types?.includes(ITEM_MIME) && !types?.includes(CONCEPT_MIME)) return;
      const { left, right } = root.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right) {
        stop();
        return;
      }
      scroller ??= findScroller();
      pointerY = event.clientY;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const wheel = (event: WheelEvent) => {
      if (!scroller || pointerY === null || !event.deltaY || event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop += event.deltaY * unit;
    };
    const leave = (event: globalThis.DragEvent) => {
      if (event.relatedTarget === null && (event.clientY <= 0 || event.clientY >= window.innerHeight)) stop();
    };
    // A stationary drag can reach a new element without delivering another dragover.
    document.addEventListener('dragenter', over, true);
    document.addEventListener('dragover', over, true);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragend', stop, true);
    document.addEventListener('drop', stop, true);
    window.addEventListener('blur', stop);
    window.addEventListener('wheel', wheel, { passive: false });
    return () => {
      stop();
      document.removeEventListener('dragenter', over, true);
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragend', stop, true);
      document.removeEventListener('drop', stop, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('wheel', wheel);
    };
  }, []);

  const cards = new Map<string, RoomCard>(view.clusters.flatMap((c) => c.cards.map((x) => [`${x.kind}:${x.id}`, x] as const)));
  const all = view.concepts;
  const byId = new Map(all.map((c) => [c.id, c]));
  const ideas = all.filter((c) => !isTopic(c, all));
  const topics = all.filter((c) => isTopic(c, all));
  const current = (selected && byId.get(selected)) || null;
  const under = new Set(all.flatMap((c) => c.members as string[]));
  const tray = [...cards.keys()].filter((k) => !under.has(k));
  const shown = new Set(all.map((c) => c.id));
  const links = view.conceptLinks.filter((l) => shown.has(l.from) && shown.has(l.to));
  /** The other concepts that hold a thing. */
  const alsoUnder = (key: string, except: string) => all.filter((c) => c.id !== except && (c.members as string[]).includes(key));

  // Review (ADR 0038): new ideas and new places, the most worked with first; and things that connect to nothing here.
  const newIdeas = all.filter((c) => c.status === 'suggested').sort((a, b) => workWeight(b.work) - workWeight(a.work) || a.title.localeCompare(b.title));
  const newPlaces = all
    .filter((c) => c.status === 'kept')
    .flatMap((c) => [...(c.home?.status === 'suggested' ? [{ c, home: c.home, main: true }] : []), ...c.alsoUnder.filter((h) => h.status === 'suggested').map((home) => ({ c, home, main: false }))])
    .filter((x) => byId.has(x.home.id));
  const alone = [...cards.keys()].filter((k) => {
    const mine = ideas.filter((c) => (c.members as string[]).includes(k));
    if (mine.length === 0) return false;
    const others = ideas.filter((c) => !mine.includes(c) && c.members.some((m) => m !== k));
    const near = new Set(others.flatMap((c) => (c.home ? [c.id, c.home.id] : [c.id])));
    return mine.every(
      (c) =>
        c.members.every((m) => m === k) &&
        !links.some((l) => l.from === c.id || l.to === c.id) &&
        !(c.home && near.has(c.home.id)) &&
        !others.some((o) => o.home?.id === c.id),
    );
  });
  const reviewCount = newIdeas.length + newPlaces.length;

  // Topic by topic: each concept with the topic at the top of its tree; the rest, in no topic, last.
  const topOf = (c: Concept): Concept => {
    let x = c;
    const seen = new Set([c.id]);
    for (let up = x.home ? byId.get(x.home.id) : undefined; up && !seen.has(up.id); up = up.home ? byId.get(up.home.id) : undefined) {
      seen.add(up.id);
      x = up;
    }
    return x;
  };
  const sections = new Map<string, { topic: Concept | null; concepts: Concept[] }>();
  for (const c of all) {
    if (!c.home && isTopic(c, all)) {
      if (!sections.has(c.id)) sections.set(c.id, { topic: c, concepts: [] });
      continue;
    }
    const top = topOf(c);
    const topic = top.id !== c.id && isTopic(top, all) ? top : null;
    const key = topic?.id ?? '';
    const sec = sections.get(key) ?? { topic, concepts: [] };
    sec.concepts.push(c);
    sections.set(key, sec);
  }
  const weightOf = (cs: Concept[]) => cs.reduce((n, c) => n + workWeight(c.work), 0);
  const sectionList = [...sections.entries()]
    .map(([key, sec]) => ({ key, ...sec }))
    .sort((a, b) => (a.topic ? 0 : 1) - (b.topic ? 0 : 1) || weightOf(b.concepts) - weightOf(a.concepts) || (a.topic?.title ?? '').localeCompare(b.topic?.title ?? ''));
  const find = finding.trim().toLowerCase();
  const matches = (c: Concept) => c.title.toLowerCase().includes(find) || c.names.some((n) => n.toLowerCase().includes(find));
  /** The cards a topic shows: those found, or its most worked with (and the one chosen), or all of them when opened. */
  const visibleIn = (key: string, cs: Concept[]) => {
    if (find) return cs.filter(matches);
    const byWork = [...cs].sort((a, b) => workWeight(b.work) - workWeight(a.work) || a.title.localeCompare(b.title));
    if (moreOpen.has(key) || byWork.length <= SHOWN_IN_TOPIC) return byWork;
    const top = byWork.slice(0, SHOWN_IN_TOPIC);
    return byWork.filter((c) => top.includes(c) || c.id === current?.id);
  };
  const laid = sectionList.flatMap((sec) => {
    const visible = visibleIn(sec.key, sec.concepts);
    if (find && visible.length === 0 && !(sec.topic && matches(sec.topic))) return [];
    const ids = new Set(visible.map((c) => c.id));
    // What comes first: the links kept or suggested, and a kind or part of a concept after it.
    const order = pathOrder(
      visible.map((c) => c.id),
      [
        ...links.filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => ({ from: l.from, to: l.to, kind: l.kind })),
        ...visible.flatMap((c) => (c.home && c.home.how !== 'in' && ids.has(c.home.id) ? [{ from: c.id, to: c.home.id, kind: 'builds-on' as LinkKind }] : [])),
      ],
    );
    // One column: the order is kept, but nothing is folded into a third bucket by depth.
    const column = [...order.steps.flatMap((st) => [st.key, ...st.beside]), ...order.loose];
    return [{ ...sec, visible, ids, column, hidden: sec.concepts.length - visible.length }];
  });
  /** How many things the concept chosen shares with each other one. */
  const sharing = new Map<string, number>();
  if (current && current.members.length > 0) {
    for (const c of all) {
      if (c.id === current.id) continue;
      const n = c.members.filter((k) => current.members.includes(k)).length;
      if (n > 0) sharing.set(c.id, n);
    }
  }

  // The concept chosen (from Review, the drawer or Find) is brought into view.
  useEffect(() => {
    if (!selected || !board.current) return;
    board.current.querySelector(`[data-concept-id="${selected}"], [data-topic-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const run = async (what: () => Promise<unknown>, problem: string) => {
    // What the last change said goes as the next one starts; what this one says (set inside it) stays.
    setStatus(null);
    try {
      await what();
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
  /** A concept card let go on another concept, or on a topic: put under it, or in it. */
  const putUnder = (e: DragEvent, target: string) => {
    const id = e.dataTransfer.getData(CONCEPT_MIME);
    if (!id || id === target) return;
    void run(async () => {
      await api.putConceptUnder(id, target);
      setStatus(`“${byId.get(id)?.title}” is ${isTopic(byId.get(target) as Concept, all) ? 'in' : 'under'} “${byId.get(target)?.title}” now.`);
    }, 'It could not be put there.');
  };
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
  const openOf = (c: Concept) =>
    (view.brief?.open ?? [])
      .filter((o) => o.item && o.item.kind !== 'room' && c.members.includes(`${o.item.kind}:${o.item.id}` as never))
      .map((o) => o.question);

  const toRead = view.conceptsToRead;
  const things = cards.size;
  const keepAll = () => void run(() => api.keepAllConcepts(roomId), 'They could not be kept.');

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
  /** Links worth saying on a card, in words, rather than only as a line on a map. */
  const relsOf = (c: Concept) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const l of links) {
      const otherId = l.from === c.id ? l.to : l.to === c.id ? l.from : null;
      if (!otherId || seen.has(otherId)) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      // Two ordered links the other way round would make both cards say they build on each other. Say that instead.
      const symmetric = l.kind === 'contrasts-with' || l.kind === 'same-question';
      const back = !symmetric && links.some((r) => r.from === otherId && r.to === c.id);
      out.push(`${back ? 'linked both ways with' : LINK_WORDS[l.kind]} ${other.title}`);
    }
    return out.slice(0, 2);
  };
  /** A concept's card: its name, its relations, its words, where it is discussed, what is open. */
  const node = (c: Concept) => {
    const isOn = current?.id === c.id;
    const shares = sharing.get(c.id);
    const firstOpen = openOf(c)[0];
    const parent = c.home && c.home.how !== 'in' ? byId.get(c.home.id) : undefined;
    const rels = lens === 'audit' ? [] : relsOf(c);
    return (
      // biome-ignore lint/a11y/useSemanticElements: a card that takes things dropped on it, with buttons in it
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        draggable
        className={`concept-node${c.status === 'suggested' ? ' is-suggested' : ''}${isOn ? ' is-selected' : ''}${over === c.id ? ' is-target' : ''}${shares ? ' is-sharing' : ''}`}
        onClick={() => onSelect(c.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(c.id);
          }
        }}
        onDragStart={(e) => {
          // Text inside the card is part of it; only the buttons in it must not start a drag.
          if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
          e.dataTransfer.setData(CONCEPT_MIME, c.id);
          e.dataTransfer.setData('text/plain', c.title);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!accepts(e) && !isConceptDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = isConceptDrag(e) ? 'move' : e.altKey ? 'copy' : 'move';
          setOver(c.id);
        }}
        onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
        onDrop={(e) => {
          setOver(null);
          if (isConceptDrag(e)) {
            e.preventDefault();
            e.stopPropagation();
            putUnder(e, c.id);
            return;
          }
          if (!accepts(e)) return;
          e.preventDefault();
          e.stopPropagation();
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
        {parent && c.home && (
          <p className={`concept-under${c.home.status === 'suggested' ? ' is-suggested' : ''}`} data-testid="concept-under">
            {HOW_WORDS[c.home.how]} {parent.title}
            {c.home.status === 'suggested' && <span className="hint"> · suggested</span>}
          </p>
        )}
        {rels.length > 0 && (
          <p className="concept-rels" data-testid="concept-rel">
            {rels.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </p>
        )}
        {c.definition && <p className="concept-def">{c.definition}</p>}
        <p className="concept-counts">
          {c.members.length ? counts(c) : <span className="hint">Nothing under it yet</span>}
          <span className="concept-where" data-testid="concept-where">
            {c.lost ? 'no longer found in your materials' : `in ${plural(c.materials, 'material')} · ${plural(c.places, 'place')}`}
          </span>
        </p>
        {firstOpen && <p className="concept-open">? {firstOpen}</p>}
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
  /** A topic's heading: its name (chosen, it shows in the drawer), how many concepts, and Keep / Not this when suggested. */
  const topicHead = (sec: (typeof laid)[number], i: number) => {
    const t = sec.topic;
    const isClosed = (lens !== 'study' ? false : closed === null ? i > 0 : closed.has(sec.key)) && !find;
    const toggle = () =>
      setClosed((was) => {
        const base = was ?? new Set(laid.slice(1).map((s) => s.key));
        const next = new Set(base);
        if (next.has(sec.key)) next.delete(sec.key);
        else next.add(sec.key);
        return next;
      });
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: a heading a concept card can be dropped on, to put it in the topic
      <div
        className={`concepts-topic-head${t?.status === 'suggested' ? ' is-suggested' : ''}${t && over === t.id ? ' is-target' : ''}${t && current?.id === t.id ? ' is-selected' : ''}`}
        onDragOver={(e) => {
          if (!t || !isConceptDrag(e)) return;
          e.preventDefault();
          setOver(t.id);
        }}
        onDragLeave={() => setOver((o) => (o === t?.id ? null : o))}
        onDrop={(e) => {
          setOver(null);
          if (!t || !isConceptDrag(e)) return;
          e.preventDefault();
          putUnder(e, t.id);
        }}
        data-topic-id={t?.id}
        data-status={t?.status}
        data-testid="concepts-topic"
      >
        <button type="button" className="quiet inline concepts-topic-toggle" onClick={toggle} aria-expanded={!isClosed} aria-label={isClosed ? 'Show this topic' : 'Fold this topic'} data-testid="concepts-topic-toggle">
          {isClosed ? '▸' : '▾'}
        </button>
        {t ? (
          <button type="button" className="quiet inline concepts-topic-name" onClick={() => onSelect(t.id)} data-testid="concepts-topic-name">
            {CONCEPT_GLYPH} {t.title}
          </button>
        ) : (
          <span className="concepts-topic-name">In no topic</span>
        )}
        <span className="hint"> · {plural(sec.concepts.length, 'concept')}</span>
        {t?.scope && <span className="hint concepts-topic-scope"> · {t.scope}</span>}
        {t?.status === 'suggested' && (
          <span className="concepts-topic-suggest">
            <span className="hint">suggested by the AI · </span>
            <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConcept(t.id), 'It could not be kept.')} data-testid="topic-keep">
              Keep
            </button>
            <span className="hint"> · </span>
            <button type="button" className="quiet inline" onClick={() => void run(() => api.dropConcept(t.id), 'It could not be dismissed.')} data-testid="topic-not-this">
              Not this
            </button>
          </span>
        )}
      </div>
    );
  };
  const reading_ = reading?.phase === 'concepts' && reading.total > 0 ? reading : null;

  return (
    <div ref={conceptPage} className="room-concepts" data-testid="room-concepts">
      <div className="concepts-bar">
        <Orb size="small" />
        <p className="concepts-bar-text" data-testid="concepts-bar">
          {busy && reading_ ? (
            `Reading your threads and notes: ${Math.min(reading_.done, reading_.total)} of ${plural(reading_.total, 'piece')}`
          ) : all.length > 0 ? (
            <>
              <b>{plural(ideas.length, 'concept')}</b>
              {topics.length > 0 && ` in ${plural(topics.length, 'topic')}`} · your {plural(things, 'thing')}
              {reviewCount > 0 && ` · ${reviewCount} to review`}
            </>
          ) : busy ? (
            'Reading the room…'
          ) : (
            'No concepts yet'
          )}
        </p>
        <label className="concepts-lens-label">
          <span className="hint">See</span>
          <select value={lens} onChange={(e) => chooseLens(e.target.value)} aria-label="Concepts lens" data-testid="concepts-lens">
            <option value="study">Study order</option>
            <option value="explore">Explore</option>
            <option value="audit">Audit gaps</option>
          </select>
        </label>
        {busy && (
          <button type="button" className="quiet" onClick={onStop} data-testid="concepts-stop">
            Stop
          </button>
        )}
        {reviewCount > 0 && !busy && (
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
      {busy && reading_ && (
        <div className="concepts-progress" aria-hidden>
          <span style={{ width: `${Math.round((100 * reading_.done) / reading_.total)}%` }} />
        </div>
      )}
      {!busy && reading?.stopped && (
        <p className="concepts-changed" data-testid="concepts-stopped">
          Stopped. What was read is kept; Read again carries on from there.
        </p>
      )}
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
            Read with AI, and it reads every piece of your threads and notes for the ideas they discuss, with the words
            where they do, joins them across your notebook, and puts them in order: a few topics, the concepts in them.
            Sources are not read: each concept shows where its words appear in them. You keep, rename, merge or split
            them. When a thread or note changes, only what changed is read again
            {toRead.pieces > 0 && ` (this room: about ${plural(toRead.pieces + 3, 'call')} the first time)`}.
          </p>
        </div>
      ) : (
        <div className="concepts-body has-drawer">
          <div className="concepts-main">
            <div className="concepts-find">
              <input
                value={finding}
                onChange={(e) => setFinding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setFinding('');
                }}
                placeholder="⌕ Find a concept"
                aria-label="Find a concept"
                data-testid="concepts-find"
              />
              {find && (
                <span className="hint" data-testid="concepts-found">
                  {plural(laid.reduce((n, sec) => n + sec.visible.length, 0), 'concept')} found ·{' '}
                  <button type="button" className="quiet inline" onClick={() => setFinding('')}>
                    Show all
                  </button>
                </span>
              )}
            </div>
            {lens === 'audit' && (
              <p className="concepts-audit" data-testid="concepts-audit">
                To review: {plural(reviewCount, 'idea')} · not under a concept: {plural(tray.length, 'thing')} · open questions:{' '}
                {plural(all.reduce((n, c) => n + openOf(c).length, 0), 'question')}
              </p>
            )}
            <div className="concepts-map" ref={board}>
              {laid.map((sec, i) => {
                const isClosed = (lens !== 'study' ? false : closed === null ? i > 0 : closed.has(sec.key)) && !find;
                return (
                  <section key={sec.key || 'none'} className={`concepts-topic${sec.topic ? '' : ' is-loose'}`} data-testid="concepts-section">
                    {(sec.topic || laid.length > 1) && topicHead(sec, i)}
                    {!isClosed && sec.visible.length > 0 && (
                      <div className="concepts-lanes">
                        <div className="concepts-lane" data-testid="concepts-lane">
                          {sec.column.map((id) => {
                            const c = byId.get(id);
                            return c ? node(c) : null;
                          })}
                        </div>
                      </div>
                    )}
                    {!isClosed && sec.hidden > 0 && !find && (
                      <button
                        type="button"
                        className="quiet inline concepts-more"
                        onClick={() => setMoreOpen((was) => new Set([...was, sec.key]))}
                        data-testid="concepts-more"
                      >
                        ▸ {sec.hidden} more {sec.topic ? `in ${sec.topic.title}` : 'in no topic'}, less worked with
                      </button>
                    )}
                    {!isClosed && moreOpen.has(sec.key) && sec.concepts.length > SHOWN_IN_TOPIC && !find && (
                      <button
                        type="button"
                        className="quiet inline concepts-more"
                        onClick={() =>
                          setMoreOpen((was) => {
                            const next = new Set(was);
                            next.delete(sec.key);
                            return next;
                          })
                        }
                      >
                        ▾ Show the {SHOWN_IN_TOPIC} most worked with
                      </button>
                    )}
                  </section>
                );
              })}
              {find && laid.length === 0 && <p className="hint">No concept here is called that.</p>}
            </div>
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
          {!current && (
            <aside className="concepts-side" aria-label="To review" data-testid="concepts-review">
              {reviewCount + alone.length > 0 ? (
                <>
                  <p className="concepts-kicker">Review · {plural(reviewCount, 'new idea')}</p>
                  <p className="hint">The most worked with first; their cards are dashed. Choose one to see it.</p>
                  <ul className="concepts-review-list">
                    {newIdeas.map((c) => (
                      <li key={c.id} data-testid="review-idea">
                        <button type="button" className="quiet inline review-name" onClick={() => onSelect(c.id)}>
                          {CONCEPT_GLYPH} {c.title}
                        </button>
                        <span className="hint review-where">
                          {isTopic(c, all) ? 'a topic' : c.home ? `${HOW_WORDS[c.home.how]} ${byId.get(c.home.id)?.title ?? ''}` : 'in no topic'}
                          {!isTopic(c, all) && ` · ${workLine(c)}`}
                        </span>
                        <span className="review-actions">
                          <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConcept(c.id), 'It could not be kept.')} data-testid="review-keep">
                            Keep
                          </button>
                          {' · '}
                          <button type="button" className="quiet inline" onClick={() => void run(() => api.dropConcept(c.id), 'It could not be dismissed.')} data-testid="review-not-this">
                            Not this
                          </button>
                        </span>
                      </li>
                    ))}
                    {newPlaces.map(({ c, home, main }) => (
                      <li key={`${c.id}>${home.id}`} data-testid="review-place">
                        <button type="button" className="quiet inline review-name" onClick={() => onSelect(c.id)}>
                          ↳ {c.title}
                        </button>
                        <span className="hint review-where">
                          {HOW_WORDS[home.how]} {byId.get(home.id)?.title}
                          {main ? '' : ' (also)'}
                        </span>
                        <span className="review-actions">
                          <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConceptHome(c.id, home.id), 'It could not be kept.')} data-testid="review-place-keep">
                            Keep
                          </button>
                          {' · '}
                          <button type="button" className="quiet inline" onClick={() => void run(() => api.dismissConceptHome(c.id, home.id), 'It could not be dismissed.')} data-testid="review-place-not">
                            Not this
                          </button>
                        </span>
                      </li>
                    ))}
                    {alone.map((k) => (
                      <li key={k} className="review-alone" data-testid="review-alone">
                        “{cards.get(k)?.title || 'Untitled'}” shares no concept with the rest of this room.
                      </li>
                    ))}
                  </ul>
                  {reviewCount > 0 && (
                    <button type="button" className="ai-button is-strong" onClick={keepAll}>
                      <Orb size="small" />
                      Keep all
                    </button>
                  )}
                </>
              ) : (
                <p className="hint">Choose a concept to see what it is, where your materials discuss it, and what is inside it. Drag a card onto another to put it under it, or onto a topic to put it there.</p>
              )}
            </aside>
          )}
          {current && (
            <ConceptDrawer
              key={current.id}
              concept={current}
              all={all}
              others={all.filter((c) => c.id !== current.id)}
              links={links.filter((l) => l.from === current.id || l.to === current.id)}
              open={openOf(current)}
              run={run}
              say={setStatus}
              roomId={roomId}
              onOpen={onOpen}
              onOpenTarget={onOpenTarget}
              onAskAbout={onAskAbout}
              onSelect={onSelect}
              titleOf={(id) => byId.get(id)?.title ?? ''}
              chips={chips}
              drag={drag}
              thingMenu={thingMenu}
              reviewCount={reviewCount}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The learner's work on a concept, in words. */
export function workLine(c: Concept): string {
  return [
    c.work.questions ? plural(c.work.questions, 'question') : '',
    c.work.notes ? plural(c.work.notes, 'note') : '',
    `in ${plural(c.materials, 'material')}`,
  ]
    .filter((s) => s)
    .join(' · ');
}

/** The concept chosen: its words, the materials that discuss it and where, its links, and what can be done with it. */
function ConceptDrawer({
  concept: c,
  all,
  others,
  links,
  open,
  run,
  say,
  roomId,
  onOpen,
  onOpenTarget,
  onAskAbout,
  onSelect,
  titleOf,
  chips,
  drag,
  thingMenu,
  reviewCount,
}: {
  reviewCount: number;
  concept: Concept;
  all: Concept[];
  others: Concept[];
  links: ConceptLink[];
  open: string[];
  run: (what: () => Promise<unknown>, problem: string) => Promise<void>;
  say: (text: string | null) => void;
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
  const [scoping, setScoping] = useState(false);
  const [finding, setFinding] = useState(false);
  const [words, setWords] = useState<ConceptWords | null>(null);
  const suggested = c.status === 'suggested';
  const topic = isTopic(c, all);
  const byId = new Map(all.map((x) => [x.id, x]));
  // What is inside it: concepts it holds, its main place or another.
  const inside = all.filter((x) => x.home?.id === c.id || x.alsoUnder.some((h) => h.id === c.id));
  // Where it could go: not itself, nor anything inside it.
  const insideAll = new Set<string>();
  const down = (id: string) => {
    for (const x of all) if (x.home?.id === id && !insideAll.has(x.id)) {
      insideAll.add(x.id);
      down(x.id);
    }
  };
  down(c.id);
  const places = others.filter((o) => !insideAll.has(o.id) && o.id !== c.home?.id);
  // Where its words appear in the sources: plain text search, asked for when it is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when its names change
  useEffect(() => {
    let live = true;
    if (topic) return;
    void api.conceptWords(c.id).then(
      (w) => live && setWords(w),
      () => live && setWords(null),
    );
    return () => {
      live = false;
    };
  }, [c.id, c.title, c.names.join('|'), topic]);
  return (
    <aside className="concepts-drawer" aria-label={`The concept “${c.title}”`} data-testid="concept-drawer">
      <button type="button" className="quiet inline concepts-back" onClick={() => onSelect(null)} data-testid="concept-drawer-close">
        ← {reviewCount > 0 ? `Review · ${plural(reviewCount, 'new idea')}` : 'Close'}
      </button>
      <p className="concepts-kicker">
        {CONCEPT_GLYPH} {topic ? 'Topic' : 'Concept'} · {suggested ? 'suggested by the AI' : c.by === 'ai' ? 'kept' : 'yours'}
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
      <p className={`concept-home${c.home?.status === 'suggested' ? ' is-suggested' : ''}`} data-testid="concept-home">
        {c.home ? (
          <>
            {c.home.how === 'in' ? 'In' : HOW_WORDS[c.home.how].replace(/^a/, 'A')}{' '}
            <button type="button" className="quiet inline" onClick={() => c.home && onSelect(c.home.id)}>
              {CONCEPT_GLYPH} {byId.get(c.home.id)?.title ?? ''}
            </button>
            {c.home.status === 'suggested' && (
              <>
                <span className="hint"> · suggested · </span>
                <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConceptHome(c.id), 'It could not be kept.')} data-testid="concept-home-keep">
                  Keep
                </button>
                <span className="hint"> · </span>
                <button type="button" className="quiet inline" onClick={() => void run(() => api.dismissConceptHome(c.id), 'It could not be dismissed.')} data-testid="concept-home-not">
                  Not this
                </button>
              </>
            )}
          </>
        ) : (
          <span className="hint">In no topic, under no concept</span>
        )}
        {c.alsoUnder.length > 0 && (
          <span className="hint">
            {' '}
            · also under {c.alsoUnder.map((h) => `${byId.get(h.id)?.title ?? ''}${h.status === 'suggested' ? ' (suggested)' : ''}`).join(', ')}
          </span>
        )}
      </p>
      <p className="concept-put">
        <select
          value=""
          onChange={(e) => {
            const to = e.target.value;
            if (!to) return;
            void run(() => api.putConceptUnder(c.id, to === '-' ? null : to), 'It could not be put there.');
          }}
          aria-label="Put it under another concept or in a topic"
          data-testid="concept-put-under"
        >
          <option value="">Put under…</option>
          {c.home && <option value="-">Nothing: in no topic</option>}
          {places.map((o) => (
            <option key={o.id} value={o.id}>
              {isTopic(o, all) ? 'in ' : ''}
              {o.title}
            </option>
          ))}
        </select>
      </p>
      {(c.scope || scoping) &&
        (scoping ? (
          <form
            className="concept-scope-form"
            onSubmit={(e) => {
              e.preventDefault();
              const scope = String(new FormData(e.currentTarget).get('scope') ?? '').trim();
              setScoping(false);
              void run(() => api.setConceptScope(c.id, scope), 'It could not be changed.');
            }}
          >
            {/* biome-ignore lint/a11y/noAutofocus: typed into at once, after the click that opened it */}
            <input name="scope" defaultValue={c.scope ?? ''} aria-label="What it covers" autoFocus data-testid="concept-scope-input" />
            <button type="submit">Save</button>
          </form>
        ) : (
          <p className="concept-scope" data-testid="concept-scope">
            <span className="hint">Covers: </span>
            {c.scope}{' '}
            <button type="button" className="quiet inline" onClick={() => setScoping(true)} data-testid="concept-scope-edit">
              Edit
            </button>
          </p>
        ))}
      {!topic && (
        <p className="concept-work hint" data-testid="concept-work">
          Your work: {workLine(c)}
        </p>
      )}
      {inside.length > 0 && (
        <div className="concept-inside" data-testid="concept-inside">
          <p className="concepts-label">Inside · {inside.length}</p>
          <p className="concept-inside-list">
            {inside.map((x) => {
              const home = x.home?.id === c.id ? x.home : x.alsoUnder.find((h) => h.id === c.id);
              return (
                <span key={x.id} className={`concept-chip${home?.status === 'suggested' || x.status === 'suggested' ? ' is-suggested' : ''}`} data-testid="concept-inside-chip">
                  <button type="button" className="quiet inline" onClick={() => onSelect(x.id)}>
                    {CONCEPT_GLYPH} {x.title}
                  </button>
                  {home?.status === 'suggested' && (
                    <>
                      {' '}
                      <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConceptHome(x.id, c.id), 'It could not be kept.')} aria-label={`Keep “${x.title}” inside`} data-testid="concept-inside-keep">
                        ✓
                      </button>
                      <button type="button" className="quiet inline" onClick={() => void run(() => api.dismissConceptHome(x.id, c.id), 'It could not be dismissed.')} aria-label={`Not inside: “${x.title}”`}>
                        ×
                      </button>
                    </>
                  )}
                </span>
              );
            })}
          </p>
        </div>
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
                      <li key={p.id} className={`${p.target ? '' : 'is-lost'}${p.kept ? '' : ' is-found'}`} data-testid="concept-place">
                        <span className="concept-place-role">{!p.kept ? 'found for it' : p.by === 'you' ? 'you put it here' : ROLE_WORD[p.role]}</span>
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
                        {!p.kept && (
                          <button type="button" className="quiet inline" onClick={() => void run(() => api.keepConceptPlace(p.id), 'It could not be kept.')} data-testid="concept-place-keep">
                            Keep
                          </button>
                        )}
                        {(p.by === 'you' || !p.kept) && (
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
        <p className="hint">{topic ? 'A topic holds concepts: open one of them for its things.' : 'Drag things here from the tray, or from another concept, or find materials for it.'}</p>
      )}
      {words && words.sources.length > 0 && (
        <div className="concept-words" data-testid="concept-words">
          <p className="concepts-label">In your sources · words found</p>
          <ul>
            {words.sources.map((w) => (
              <li key={w.id} data-testid="concept-words-source">
                <b>{w.title || 'Untitled'}</b>
                <span className="hint"> · {plural(w.count, 'place')}</span>
                {w.places.slice(0, 3).map((p, i) => (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                    key={i}
                    type="button"
                    className="concept-words-place"
                    onClick={() => onOpenTarget(p.target)}
                    title="Open where these words are"
                    data-testid="concept-words-place"
                  >
                    {p.page !== null && <span className="hint">p. {p.page} · </span>}
                    {asRead(p.quote)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
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
        <button
          type="button"
          className="ai-button"
          disabled={finding}
          onClick={() => {
            setFinding(true);
            void run(async () => {
              const found = await api.findForConcept(c.id);
              say(
                found.inside + found.materials === 0
                  ? `Nothing more found for “${c.title}”.`
                  : `Found for “${c.title}”: ${[found.inside ? plural(found.inside, 'concept') : '', found.materials ? plural(found.materials, 'material') : ''].filter((x) => x).join(' and ')}, dashed until you keep them.`,
              );
            }, 'Nothing could be found: try again.').finally(() => setFinding(false));
          }}
          title="The AI finds the concepts that go inside it and the materials that discuss it, for you to keep"
          data-testid="concept-find"
        >
          <Orb size="small" />
          {finding ? 'Finding…' : 'Find materials'}
        </button>
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
            {CONCEPT_LINK_CHOICES.map((k) => (
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
