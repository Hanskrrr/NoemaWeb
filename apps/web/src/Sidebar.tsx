// Threads and their branches as a tree. Top-level threads are newest first;
// branches sit under the thread they were asked from, in the order opened.

import type { Thread } from '@noema/core';

function tree(threads: Thread[]): { roots: Thread[]; children: Map<string, Thread[]> } {
  const children = new Map<string, Thread[]>();
  const known = new Set(threads.map((t) => t.id));
  const roots: Thread[] = [];
  for (const t of threads) {
    if (t.parentThreadId && known.has(t.parentThreadId)) {
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
  activeId,
  open,
  onOpen,
  onNew,
}: {
  threads: Thread[];
  activeId: string | null;
  open: boolean;
  onOpen: (threadId: string) => void;
  onNew: () => void;
}) {
  const { roots, children } = tree(threads);

  const item = (t: Thread, depth: number) => {
    const kids = children.get(t.id) ?? [];
    return (
      <li key={t.id}>
        <button
          type="button"
          className={`thread-link${t.id === activeId ? ' active' : ''}${depth > 0 ? ' is-branch' : ''}`}
          aria-current={t.id === activeId ? 'page' : undefined}
          onClick={() => onOpen(t.id)}
          data-testid="thread-link"
          data-thread-id={t.id}
        >
          {depth > 0 && <span aria-hidden>↳ </span>}
          {t.title || 'Untitled'}
        </button>
        {kids.length > 0 && <ul>{kids.map((k) => item(k, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Threads">
      <button type="button" className="new-thread" onClick={onNew} data-testid="new-thread">
        + New thread
      </button>
      {roots.length === 0 ? <p className="sidebar-empty">No threads yet.</p> : <ul>{roots.map((t) => item(t, 0))}</ul>}
    </nav>
  );
}
