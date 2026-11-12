// Threads, sources, notes and the Trash, one at a time: a rail of icons on
// the left picks which list the panel shows, and the panel follows what is
// open (a note shows Notes, a thread asked about a source shows Sources).
// Clicking the icon of the list already shown hides the panel, for more room
// to read; clicking any icon shows it again.
//
// A thread's side questions (↳) sit under it,
// in the order opened, and fold away with its caret. Threads that left a
// thread to be their own, a side question made its own thread (↗) or a
// thread split off at a question (↪), are threads of their own: listed at
// the top level, right after the thread they came from, so they stay near
// it. A group moves up as a whole when anything in it is asked in. Each side
// question shows the passage it came from: click the passage to jump to that
// exact spot, the title to open it. A source lists the threads asked about
// its passages (›), with their side questions, under it, so a paper and
// everything asked about it stay together. A note made from a thread (▤)
// sits under that thread too; the Notes list has every note, each saying
// where it came from.

import { type NoteSummary, readableQuote, type Source, type Thread, type Trash } from '@noema/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NotesIcon, SourcesIcon, ThreadsIcon, TrashIcon } from './icons.tsx';
import { sourceFamily } from './reading.ts';
import { keys, storage } from './storage.ts';

/** The thread this one came from, if any: the one it was asked from, or split off from. */
function cameFrom(t: Thread): string | null {
  return t.continuedFromId ?? t.parentThreadId ?? null;
}

/** A side question that is still its thread's (not made its own). */
const isSide = (t: Thread) => t.parentThreadId !== null && t.splitAt === null && t.continuedFromId === null;

export interface SidebarTree {
  /** Top-level threads in display order: each group's first thread, then the threads that left it. */
  roots: Thread[];
  /** Side questions under each thread, oldest first. */
  children: Map<string, Thread[]>;
}

export function tree(threads: Thread[]): SidebarTree {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const children = new Map<string, Thread[]>();
  const tops: Thread[] = [];
  for (const t of threads) {
    const parent = t.parentThreadId ? byId.get(t.parentThreadId) : undefined;
    if (isSide(t) && parent) {
      const list = children.get(parent.id) ?? [];
      list.push(t);
      children.set(parent.id, list);
    } else {
      tops.push(t);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // The top-level thread a thread is shown under (itself, if top-level).
  const topOf = (t: Thread): Thread => {
    let cur = t;
    const seen = new Set<string>();
    while (isSide(cur) && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = cur.parentThreadId ? byId.get(cur.parentThreadId) : undefined;
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  // A group: a thread that came from nowhere, and every top-level thread that came out of it, at any remove.
  const groupOf = (t: Thread): string => {
    let cur = t;
    const seen = new Set<string>();
    while (!seen.has(cur.id)) {
      seen.add(cur.id);
      const from = cameFrom(cur);
      const origin = from ? byId.get(from) : undefined;
      if (!origin) return cur.id;
      cur = topOf(origin);
    }
    return cur.id;
  };
  // Latest activity of a thread and its side questions.
  const latestIn = (t: Thread): string =>
    (children.get(t.id) ?? []).reduce((at, k) => {
      const a = latestIn(k);
      return a > at ? a : at;
    }, t.updatedAt);

  const groups = new Map<string, Thread[]>();
  for (const t of tops) {
    const g = groupOf(t);
    const list = groups.get(g) ?? [];
    list.push(t);
    groups.set(g, list);
  }
  const latest = new Map<string, string>();
  for (const [g, list] of groups) {
    latest.set(g, list.reduce((at, t) => (latestIn(t) > at ? latestIn(t) : at), ''));
    // The thread it all came from first, then the others in the order they left.
    list.sort((a, b) => (a.id === g ? -1 : b.id === g ? 1 : a.createdAt.localeCompare(b.createdAt)));
  }
  const order = [...groups.keys()].sort((a, b) => (latest.get(b) ?? '').localeCompare(latest.get(a) ?? ''));
  return { roots: order.flatMap((g) => groups.get(g) ?? []), children };
}

/** How a top-level thread came out of another, or how a side question hangs under its thread. */
function markOf(t: Thread, depth: number, byId: Map<string, Thread>): { glyph: string; label: string } | null {
  const from = (id: string | null) => byId.get(id ?? '')?.title || 'another thread';
  if (t.sourceId) return { glyph: '›', label: `Asked about “${t.sourceQuote ? readableQuote(t.sourceQuote) : 'a passage'}”` };
  if (t.continuedFromId) return { glyph: '↪', label: `Split off from “${from(t.continuedFromId)}” at a question` };
  if (t.splitAt) return { glyph: '↗', label: `A side question of “${from(t.parentThreadId)}”, made its own thread` };
  if (depth > 0) return { glyph: '↳', label: 'A side question' };
  return null;
}

export type SidebarSection = 'threads' | 'sources' | 'notes' | 'trash';
const SECTIONS: SidebarSection[] = ['threads', 'sources', 'notes', 'trash'];
const NAMES: Record<SidebarSection, string> = { threads: 'Threads', sources: 'Sources', notes: 'Notes', trash: 'Trash' };

export function Sidebar({
  threads,
  sources,
  notes,
  activeId,
  open,
  onOpen,
  onJump,
  onOpenNote,
  onNew,
  onNewNote,
  trash,
  onRestoreThread,
  onRestoreNote,
  onOpenTrashed,
  onOpenSource,
  onAddSource,
  onRestoreSource,
}: {
  threads: Thread[];
  sources: Source[];
  notes: NoteSummary[];
  activeId: string | null;
  open: boolean;
  onOpen: (threadId: string) => void;
  /** Go to the spot in the parent where this branch started. */
  onJump: (branch: Thread) => void;
  onOpenNote: (noteId: string) => void;
  onNew: () => void;
  onNewNote: () => void;
  trash: Trash;
  onRestoreThread: (threadId: string) => void;
  onRestoreNote: (noteId: string) => void;
  onOpenTrashed: (kind: 'thread' | 'note' | 'source', id: string) => void;
  onOpenSource: (sourceId: string) => void;
  onAddSource: () => void;
  onRestoreSource: (sourceId: string) => void;
}) {
  // Threads asked about a source are listed under it; the rest, here.
  const listed = new Set(sources.map((x) => x.id));
  const sourceOf = new Map(threads.map((t) => [t.id, sourceFamily(threads, t.id)?.sourceId ?? null]));
  const underSource = (threadId: string) => {
    const id = sourceOf.get(threadId);
    return id && listed.has(id) ? id : null;
  };
  const { roots, children } = tree(threads.filter((t) => underSource(t.id) === null));
  const bySource = new Map(sources.map((x) => [x.id, tree(threads.filter((t) => underSource(t.id) === x.id))]));
  for (const { children: kids } of bySource.values()) for (const [k, v] of kids) children.set(k, v);
  const byId = new Map(threads.map((t) => [t.id, t]));
  // Notes made from a thread are listed under it as well.
  const homeOf = (n: NoteSummary) => (n.threadId && byId.has(n.threadId) ? n.threadId : null);
  const notesOf = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    const home = homeOf(n);
    if (home) notesOf.set(home, [...(notesOf.get(home) ?? []), n]);
  }
  const [folded, setFolded] = useState<string[]>(() => storage.getJson<string[]>(keys.sidebarFolded, []));
  const notesBusy = notes.some((n) => n.status === 'generating');

  // Which list the open thread, source or note is in.
  const sectionOf = (id: string | null): SidebarSection | null => {
    if (!id) return null;
    if (byId.has(id)) return underSource(id) ? 'sources' : 'threads';
    if (listed.has(id)) return 'sources';
    const note = notes.find((n) => n.id === id);
    if (!note) return null;
    // A note made from a thread is shown under it, with what it was made from.
    const home = homeOf(note);
    return home ? sectionOf(home) : 'notes';
  };
  const [section, setSection] = useState<SidebarSection>(() => {
    const saved = storage.get(keys.sidebarSection) as SidebarSection | null;
    return saved && SECTIONS.includes(saved) ? saved : 'threads';
  });
  const [collapsed, setCollapsed] = useState(() => storage.get(keys.sidebarCollapsed) === '1');
  const show = (next: SidebarSection) => {
    setSection(next);
    storage.set(keys.sidebarSection, next);
  };
  const hide = (closed: boolean) => {
    setCollapsed(closed);
    storage.set(keys.sidebarCollapsed, closed ? '1' : '0');
  };
  // Opening something elsewhere (search, a link, the text) shows the list it is in;
  // opening it from a list here keeps that list.
  const wanted = sectionOf(activeId);
  const picked = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when what is open changes, not when the learner picks a list
  useEffect(() => {
    if (activeId && activeId === picked.current) return;
    picked.current = null;
    if (wanted) show(wanted);
  }, [activeId, wanted]);
  const pick = (next: SidebarSection) => {
    if (next === section && !collapsed && !open) hide(true);
    else {
      show(next);
      hide(false);
    }
  };

  const fold = (id: string, closed: boolean) => {
    const next = closed ? [...new Set([...folded, id])] : folded.filter((x) => x !== id);
    setFolded(next);
    storage.setJson(keys.sidebarFolded, next);
  };
  // The open thread or note is never hidden: the threads above it stay unfolded.
  const above = new Set<string>();
  const activeNote = notes.find((n) => n.id === activeId);
  const openThread = activeNote ? homeOf(activeNote) : activeId;
  if (activeNote && openThread) above.add(openThread);
  for (let t = openThread ? byId.get(openThread) : undefined; t && isSide(t); t = byId.get(t.parentThreadId ?? '')) {
    if (t.parentThreadId) above.add(t.parentThreadId);
  }
  const activeSource = openThread ? underSource(openThread) : null;
  if (activeSource) above.add(activeSource);

  /** What a fold hides: side questions at any depth, and notes. */
  const count = (id: string): number =>
    (children.get(id) ?? []).reduce((n, k) => n + 1 + count(k.id), notesOf.get(id)?.length ?? 0);

  const item = (t: Thread, depth: number) => {
    const kids = children.get(t.id) ?? [];
    const own = notesOf.get(t.id) ?? [];
    const active = t.id === activeId;
    const mark = markOf(t, depth, byId);
    const under = kids.length + own.length;
    const closed = under > 0 && folded.includes(t.id) && !above.has(t.id);
    return (
      <li key={t.id} className={depth > 0 ? 'branch-item' : undefined}>
        <div className="thread-row">
          {under > 0 ? (
            <button
              type="button"
              className="fold"
              onClick={() => fold(t.id, !closed)}
              aria-expanded={!closed}
              aria-label={closed ? `Show what is under ${t.title || 'this thread'}` : 'Hide what is under it'}
              title={
                closed
                  ? `Show ${count(t.id)} ${kids.length > 0 ? 'side questions and notes' : own.length === 1 ? 'note' : 'notes'}`
                  : 'Hide what is under it'
              }
              data-testid="fold"
              data-thread-id={t.id}
            >
              <span aria-hidden>{closed ? '▸' : '▾'}</span>
            </button>
          ) : (
            <span className="fold-space" aria-hidden />
          )}
          <button
            type="button"
            className={`thread-link${active ? ' active' : ''}${depth > 0 ? ' is-branch' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onOpen(t.id)}
            title={mark?.label}
            data-testid="thread-link"
            data-thread-id={t.id}
          >
            {mark && <span aria-hidden>{`${mark.glyph} `}</span>}
            {t.mergedIntoId && (
              <span className="merged-tag" title="Merged into another thread">
                <span aria-hidden>⤶ </span>
                <span className="sr-only">merged: </span>
              </span>
            )}
            {t.title || 'Untitled'}
          </button>
          {closed && (
            <span className="fold-count" title={`${count(t.id)} side questions folded away`} data-testid="fold-count">
              {count(t.id)}
            </span>
          )}
        </div>
        {((t.originQuote && isSide(t)) || t.sourceQuote) && (
          <button
            type="button"
            className="passage-link"
            onClick={() => onJump(t)}
            title={t.sourceQuote ? 'Back to this passage in the text' : 'Jump to where this side question started'}
            data-testid="passage-link"
            data-thread-id={t.id}
          >
            “{readableQuote(t.sourceQuote ?? t.originQuote ?? '')}”
          </button>
        )}
        {own.length > 0 && !closed && (
          <ul className="thread-notes" aria-label="Notes made from it">
            {own.map((n) => (
              <li key={n.id} className="branch-item">
                <button
                  type="button"
                  className={`thread-link note-link is-branch${n.id === activeId ? ' active' : ''}`}
                  aria-current={n.id === activeId ? 'page' : undefined}
                  onClick={() => onOpenNote(n.id)}
                  title="A note made from this thread"
                  data-testid="thread-note"
                  data-note-id={n.id}
                >
                  <span aria-hidden>▤ </span>
                  {n.title || 'Untitled'}
                  {n.status === 'generating' && <span className="note-busy"> · writing…</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {kids.length > 0 && !closed && <ul>{kids.map((k) => item(k, depth + 1))}</ul>}
      </li>
    );
  };

  const inTrash = trash.threads.length + trash.notes.length + trash.sources.length;

  const sourceItem = (x: Source) => {
    const own = bySource.get(x.id)?.roots ?? [];
    const closed = own.length > 0 && folded.includes(x.id) && !above.has(x.id);
    const total = own.reduce((n, t) => n + 1 + count(t.id), 0);
    return (
      <li key={x.id}>
        <div className="thread-row">
          {own.length > 0 ? (
            <button
              type="button"
              className="fold"
              onClick={() => fold(x.id, !closed)}
              aria-expanded={!closed}
              aria-label={closed ? `Show the threads about ${x.title || 'this source'}` : 'Hide the threads'}
              title={closed ? `Show ${total} threads` : 'Hide the threads'}
              data-testid="fold"
              data-source-id={x.id}
            >
              <span aria-hidden>{closed ? '▸' : '▾'}</span>
            </button>
          ) : (
            <span className="fold-space" aria-hidden />
          )}
          <button
            type="button"
            className={`thread-link source-link${x.id === activeId ? ' active' : ''}`}
            aria-current={x.id === activeId ? 'page' : undefined}
            onClick={() => onOpenSource(x.id)}
            title={x.url ?? 'Pasted text'}
            data-testid="source-link"
            data-source-id={x.id}
          >
            <span aria-hidden>❡ </span>
            {x.title || 'Untitled'}
          </button>
          {closed && (
            <span className="fold-count" title={`${total} threads folded away`} data-testid="fold-count">
              {total}
            </span>
          )}
        </div>
        {own.length > 0 && !closed && <ul>{own.map((t) => item(t, 1))}</ul>}
      </li>
    );
  };

  const counts: Record<SidebarSection, number> = {
    threads: roots.length,
    sources: sources.length,
    notes: notes.length,
    trash: inTrash,
  };
  const icons: Record<SidebarSection, ReactNode> = {
    threads: <ThreadsIcon />,
    sources: <SourcesIcon />,
    notes: <NotesIcon />,
    trash: <TrashIcon />,
  };
  const panelShown = !collapsed || open;

  const railButton = (x: SidebarSection) => {
    const current = x === section && panelShown;
    return (
      <button
        key={x}
        type="button"
        className={`rail-button${current ? ' current' : ''}${x === 'trash' && inTrash === 0 ? ' empty' : ''}`}
        onClick={() => pick(x)}
        aria-pressed={current}
        aria-controls="sidebar-panel"
        title={current ? `Hide the list of ${NAMES[x].toLowerCase()}` : `${NAMES[x]} · ${counts[x]}`}
        data-testid={`rail-${x}`}
      >
        {icons[x]}
        <span className="rail-label">{NAMES[x]}</span>
        {x === 'trash' && inTrash > 0 && (
          <span className="rail-badge" data-testid="trash-count">
            {inTrash}
          </span>
        )}
        {x === 'notes' && notesBusy && <span className="rail-dot" title="A note is being written" />}
      </button>
    );
  };

  const head = (title: string, action?: { label: string; onClick: () => void; testId: string }) => (
    <div className="panel-head">
      <h2>
        {title}
        {counts[section] > 0 && <span className="panel-count">{counts[section]}</span>}
      </h2>
      {action && (
        <button type="button" className="panel-action" onClick={action.onClick} data-testid={action.testId}>
          {action.label}
        </button>
      )}
    </div>
  );

  let panel: ReactNode;
  if (section === 'threads') {
    panel = (
      <>
        {head('Threads', { label: '+ New thread', onClick: onNew, testId: 'new-thread' })}
        {roots.length === 0 ? (
          <p className="sidebar-empty">No threads yet. Ask anything to start one.</p>
        ) : (
          <ul className="sidebar-list">{roots.map((t) => item(t, 0))}</ul>
        )}
      </>
    );
  } else if (section === 'sources') {
    panel = (
      <>
        {head('Sources', { label: '+ Add source', onClick: onAddSource, testId: 'add-source' })}
        {sources.length === 0 ? (
          <p className="sidebar-empty">
            Nothing to read yet. Add a web page, an arXiv paper or a PDF, or paste text, and ask about any passage.
          </p>
        ) : (
          <ul className="sidebar-list">{sources.map(sourceItem)}</ul>
        )}
      </>
    );
  } else if (section === 'notes') {
    panel = (
      <>
        {head('Notes', { label: '+ New note', onClick: onNewNote, testId: 'new-note' })}
        {notes.length === 0 ? (
          <p className="sidebar-empty">No notes yet. Write one, or rewrite a thread as a note.</p>
        ) : (
          <ul className="sidebar-list">
            {notes.map((n) => {
              const home = homeOf(n);
              const thread = home ? byId.get(home) : undefined;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`thread-link note-link${n.id === activeId ? ' active' : ''}`}
                    aria-current={n.id === activeId ? 'page' : undefined}
                    onClick={() => {
                      picked.current = n.id;
                      onOpenNote(n.id);
                    }}
                    data-testid="note-link"
                    data-note-id={n.id}
                  >
                    <span aria-hidden>▤ </span>
                    {n.title || 'Untitled'}
                    {n.status === 'generating' && <span className="note-busy"> · writing…</span>}
                  </button>
                  {thread && (
                    <button
                      type="button"
                      className="passage-link note-from"
                      onClick={() => onOpen(thread.id)}
                      title="Open the thread it was made from"
                      data-testid="note-from"
                    >
                      from {thread.title || 'Untitled'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  } else {
    panel = (
      <>
        {head('Trash')}
        {inTrash === 0 ? (
          <p className="sidebar-empty">The Trash is empty.</p>
        ) : (
          <>
            <p className="sidebar-empty">Restore puts it back as it was, with its side questions.</p>
            <ul className="sidebar-list">
              {trash.threads.map((t) => (
                <li key={t.threadId} className="trash-item" data-testid="trash-item" data-id={t.threadId}>
                  <button type="button" className="thread-link" onClick={() => onOpenTrashed('thread', t.threadId)}>
                    {t.title || 'Untitled'}
                    {t.sideQuestions > 0 && <span className="fold-count"> + {t.sideQuestions}</span>}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => onRestoreThread(t.threadId)}
                    data-testid="trash-restore"
                  >
                    Restore
                  </button>
                </li>
              ))}
              {trash.sources.map((x) => (
                <li key={x.sourceId} className="trash-item" data-testid="trash-item" data-id={x.sourceId}>
                  <button type="button" className="thread-link" onClick={() => onOpenTrashed('source', x.sourceId)}>
                    <span aria-hidden>❡ </span>
                    {x.title || 'Untitled'}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => onRestoreSource(x.sourceId)}
                    data-testid="trash-restore"
                  >
                    Restore
                  </button>
                </li>
              ))}
              {trash.notes.map((n) => (
                <li key={n.noteId} className="trash-item" data-testid="trash-item" data-id={n.noteId}>
                  <button type="button" className="thread-link" onClick={() => onOpenTrashed('note', n.noteId)}>
                    <span aria-hidden>▤ </span>
                    {n.title || 'Untitled'}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => onRestoreNote(n.noteId)}
                    data-testid="trash-restore"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <nav
      className={`sidebar${open ? ' open' : ''}${panelShown ? '' : ' collapsed'}`}
      aria-label="Threads, sources and notes"
      data-section={section}
    >
      <div className="rail" aria-label="Lists">
        {railButton('threads')}
        {railButton('sources')}
        {railButton('notes')}
        <span className="rail-space" />
        {railButton('trash')}
      </div>
      {panelShown && (
        <div className="sidebar-panel" id="sidebar-panel" aria-label={NAMES[section]} data-testid="sidebar-panel">
          {panel}
        </div>
      )}
    </nav>
  );
}
