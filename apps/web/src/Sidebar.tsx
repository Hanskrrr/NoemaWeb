// Threads, sources, notes and the Trash. A thread's side questions (↳) sit under it,
// in the order opened, and fold away with its caret. Threads that left a
// thread to be their own, a side question made its own thread (↗) or a
// thread split off at a question (↪), are threads of their own: listed at
// the top level, right after the thread they came from, so they stay near
// it. A group moves up as a whole when anything in it is asked in. Each side
// question shows the passage it came from: click the passage to jump to that
// exact spot, the title to open it. A source lists the threads asked about
// its passages (›), with their side questions, under it, so a paper and
// everything asked about it stay together.

import type { NoteSummary, Source, Thread, Trash } from '@noema/core';
import { useState } from 'react';
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
  if (t.sourceId) return { glyph: '›', label: `Asked about “${t.sourceQuote ?? 'a passage'}”` };
  if (t.continuedFromId) return { glyph: '↪', label: `Split off from “${from(t.continuedFromId)}” at a question` };
  if (t.splitAt) return { glyph: '↗', label: `A side question of “${from(t.parentThreadId)}”, made its own thread` };
  if (depth > 0) return { glyph: '↳', label: 'A side question' };
  return null;
}

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
  const [folded, setFolded] = useState<string[]>(() => storage.getJson<string[]>(keys.sidebarFolded, []));
  const [trashOpen, setTrashOpen] = useState(false);

  const fold = (id: string, closed: boolean) => {
    const next = closed ? [...new Set([...folded, id])] : folded.filter((x) => x !== id);
    setFolded(next);
    storage.setJson(keys.sidebarFolded, next);
  };
  // The open thread is never hidden: the threads above it stay unfolded.
  const above = new Set<string>();
  for (let t = activeId ? byId.get(activeId) : undefined; t && isSide(t); t = byId.get(t.parentThreadId ?? '')) {
    if (t.parentThreadId) above.add(t.parentThreadId);
  }
  const activeSource = activeId ? underSource(activeId) : null;
  if (activeSource) above.add(activeSource);

  const count = (id: string): number =>
    (children.get(id) ?? []).reduce((n, k) => n + 1 + count(k.id), 0);

  const item = (t: Thread, depth: number) => {
    const kids = children.get(t.id) ?? [];
    const active = t.id === activeId;
    const mark = markOf(t, depth, byId);
    const closed = kids.length > 0 && folded.includes(t.id) && !above.has(t.id);
    return (
      <li key={t.id} className={depth > 0 ? 'branch-item' : undefined}>
        <div className="thread-row">
          {kids.length > 0 ? (
            <button
              type="button"
              className="fold"
              onClick={() => fold(t.id, !closed)}
              aria-expanded={!closed}
              aria-label={closed ? `Show the side questions of ${t.title || 'this thread'}` : `Hide the side questions`}
              title={closed ? `Show ${count(t.id)} side questions` : 'Hide the side questions'}
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
            “{t.sourceQuote ?? t.originQuote}”
          </button>
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

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Threads and notes">
      <button type="button" className="new-thread" onClick={onNew} data-testid="new-thread">
        + New thread
      </button>
      {roots.length === 0 ? <p className="sidebar-empty">No threads yet.</p> : <ul>{roots.map((t) => item(t, 0))}</ul>}
      <section className="sidebar-notes sidebar-sources" aria-label="Sources">
        <div className="sidebar-notes-head">
          <h2>Sources</h2>
          <button type="button" className="quiet" onClick={onAddSource} data-testid="add-source">
            + Add source
          </button>
        </div>
        {sources.length > 0 && <ul>{sources.map(sourceItem)}</ul>}
      </section>
      <section className="sidebar-notes" aria-label="Notes">
        <div className="sidebar-notes-head">
          <h2>Notes</h2>
          <button type="button" className="quiet" onClick={onNewNote} data-testid="new-note">
            + New note
          </button>
        </div>
        {notes.length > 0 && (
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`thread-link note-link${n.id === activeId ? ' active' : ''}`}
                  onClick={() => onOpenNote(n.id)}
                  data-testid="note-link"
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
      </section>
      {inTrash > 0 && (
        <section className="sidebar-trash" aria-label="Trash">
          <button
            type="button"
            className="quiet trash-toggle"
            onClick={() => setTrashOpen((o) => !o)}
            aria-expanded={trashOpen}
            data-testid="trash-toggle"
          >
            <span aria-hidden>{trashOpen ? '▾' : '▸'} </span>
            Trash · {inTrash}
          </button>
          {trashOpen && (
            <ul>
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
                  <button type="button" className="quiet" onClick={() => onRestoreNote(n.noteId)} data-testid="trash-restore">
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </nav>
  );
}
