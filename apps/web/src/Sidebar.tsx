// Threads as families, then notes. Everything that came from a thread sits
// under it, in the order it was opened: its side questions (↳), the side
// questions made their own threads (↗) and the threads split off from it at
// a question (↪). A family stays together, and moves up as a whole when
// anything in it is asked in. Each side question shows the passage it came
// from: click the passage to jump to that exact spot, the title to open it.

import type { NoteSummary, Thread } from '@noema/core';

/** The thread this one came from, if any: the one it was asked from, or split off from. */
function cameFrom(t: Thread): string | null {
  return t.continuedFromId ?? t.parentThreadId ?? null;
}

export function tree(threads: Thread[]): { roots: Thread[]; children: Map<string, Thread[]> } {
  const known = new Set(threads.map((t) => t.id));
  const children = new Map<string, Thread[]>();
  const roots: Thread[] = [];
  for (const t of threads) {
    const from = cameFrom(t);
    if (from && from !== t.id && known.has(from)) {
      const list = children.get(from) ?? [];
      list.push(t);
      children.set(from, list);
    } else {
      roots.push(t);
    }
  }
  // A family's place is its latest activity anywhere in it.
  const latest = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (t: Thread): string => {
    if (seen.has(t.id)) return latest.get(t.id) ?? t.updatedAt;
    seen.add(t.id);
    let at = t.updatedAt;
    for (const k of children.get(t.id) ?? []) {
      const a = visit(k);
      if (a > at) at = a;
    }
    latest.set(t.id, at);
    return at;
  };
  for (const r of roots) visit(r);
  roots.sort((a, b) => (latest.get(b.id) ?? '').localeCompare(latest.get(a.id) ?? ''));
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { roots, children };
}

/** How a thread came out of the one above it. */
function markOf(t: Thread, depth: number): { glyph: string; label: string } | null {
  if (t.continuedFromId) return { glyph: '↪', label: 'Split off from the thread above at a question' };
  if (t.splitAt) return { glyph: '↗', label: 'A side question made its own thread' };
  if (depth > 0) return { glyph: '↳', label: 'A side question' };
  return null;
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
    const mark = markOf(t, depth);
    return (
      <li key={t.id} className={depth > 0 ? 'branch-item' : undefined} data-family-depth={depth}>
        <button
          type="button"
          className={`thread-link${active ? ' active' : ''}${depth > 0 ? ' is-branch' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => onOpen(t.id)}
          data-testid="thread-link"
          data-thread-id={t.id}
        >
          {mark && (
            <span aria-hidden title={mark.label}>
              {`${mark.glyph} `}
            </span>
          )}
          {t.mergedIntoId && (
            <span className="merged-tag" title="Merged into another thread">
              <span aria-hidden>⤶ </span>
              <span className="sr-only">merged: </span>
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
