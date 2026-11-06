// Threads and their branches as a tree, then notes. Top-level threads are
// newest first; branches sit under the thread they were asked from, in the
// order opened. A branch made its own thread is listed at the top level.
// Each branch shows the passage it came from: click the passage to jump to
// that exact spot, click the title to open the branch.

import type { NoteSummary, Thread } from '@noema/core';

function tree(threads: Thread[]): { roots: Thread[]; children: Map<string, Thread[]> } {
  const children = new Map<string, Thread[]>();
  const known = new Set(threads.map((t) => t.id));
  const roots: Thread[] = [];
  for (const t of threads) {
    if (t.parentThreadId && !t.splitAt && known.has(t.parentThreadId)) {
      const list = children.get(t.parentThreadId) ?? [];
      list.push(t);
      children.set(t.parentThreadId, list);
    } else {
      roots.push(t);
    }
  }
  roots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { roots, children };
}

export function Sidebar({
  threads,
  notes,
  activeId,
  open,
  onOpen,
  onJump,
  onOpenNote,
  onNew,
  onNewNote,
}: {
  threads: Thread[];
  notes: NoteSummary[];
  activeId: string | null;
  open: boolean;
  onOpen: (threadId: string) => void;
  /** Go to the spot in the parent where this branch started. */
  onJump: (branch: Thread) => void;
  onOpenNote: (noteId: string) => void;
  onNew: () => void;
  onNewNote: () => void;
}) {
  const { roots, children } = tree(threads);

  const item = (t: Thread, depth: number) => {
    const kids = children.get(t.id) ?? [];
    const active = t.id === activeId;
    return (
      <li key={t.id} className={depth > 0 ? 'branch-item' : undefined}>
        <button
          type="button"
          className={`thread-link${active ? ' active' : ''}${depth > 0 ? ' is-branch' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => onOpen(t.id)}
          data-testid="thread-link"
          data-thread-id={t.id}
        >
          {t.mergedIntoId ? (
            <span title="Merged into another thread">
              <span aria-hidden>⤶ </span>
              <span className="sr-only">merged: </span>
            </span>
          ) : (
            depth > 0 && <span aria-hidden>↳ </span>
          )}
          {depth === 0 && t.splitAt && (
            <span aria-hidden title="Made its own thread from a side question">
              ↗{' '}
            </span>
          )}
          {t.title || 'Untitled'}
        </button>
        {t.originQuote && t.parentThreadId && (
          <button
            type="button"
            className="passage-link"
            onClick={() => onJump(t)}
            title="Jump to where this side question started"
            data-testid="passage-link"
            data-thread-id={t.id}
          >
            “{t.originQuote}”
          </button>
        )}
        {kids.length > 0 && <ul>{kids.map((k) => item(k, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Threads and notes">
      <button type="button" className="new-thread" onClick={onNew} data-testid="new-thread">
        + New thread
      </button>
      {roots.length === 0 ? <p className="sidebar-empty">No threads yet.</p> : <ul>{roots.map((t) => item(t, 0))}</ul>}
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
    </nav>
  );
}
