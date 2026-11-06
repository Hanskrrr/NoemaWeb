// The app shell: start-up, the connect screen, the header with search, the
// sidebar of threads and notes, and which view fills the page (a thread, the
// map of a thread tree, or a note).
// Still to come: sources (M3).

import { type Health, type Notebook, type NoteSummary, type OpenBranch, type SearchHit, type Thread, ulid } from '@noema/core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { expectFound } from './found.ts';
import { MapView } from './MapView.tsx';
import { ConnectScreen, ModelDialog } from './ModelSettings.tsx';
import { NoteView } from './NoteView.tsx';
import { parseHash, type Route, toHash, useRoute } from './route.ts';
import { ComeBack, isTyping, SearchDialog, searchShortcut } from './Search.tsx';
import { Sidebar } from './Sidebar.tsx';
import { keys, storage } from './storage.ts';
import { type BranchDraft, DraftView, type Focus, ThreadView } from './ThreadView.tsx';

type Boot = { notebook: Notebook; health: Health } | { error: string } | null;

export function App() {
  const [boot, setBoot] = useState<Boot>(null);

  // Runs at start, and again after a model is connected.
  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const health = await api.health();
      const { notebooks } = await api.notebooks();
      const notebook = notebooks[0];
      if (!notebook) throw new Error('no notebook');
      if (!isCancelled()) setBoot({ notebook, health });
    } catch (err) {
      if (!isCancelled()) setBoot({ error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (boot === null) return <div className="boot">Opening your notebook…</div>;
  if ('error' in boot) {
    return (
      <div className="boot boot-error" role="alert">
        <strong>Noema could not start.</strong>
        <span>{boot.error}</span>
      </div>
    );
  }
  if (!boot.health.configured) return <ConnectScreen onConnected={() => void load()} />;
  return (
    <NotebookView
      notebook={boot.notebook}
      health={boot.health}
      onHealthChange={(health) => setBoot({ ...boot, health })}
    />
  );
}

function NotebookView({
  notebook,
  health,
  onHealthChange,
}: {
  notebook: Notebook;
  health: Health;
  onHealthChange: (health: Health) => void;
}) {
  const [route, navigate] = useRoute();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [draft, setDraft] = useState<BranchDraft | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  /** Bumped on every jump from search, so the same place opened twice is arrived at again. */
  const [jump, setJump] = useState(0);
  /** Opened fresh (nothing in the URL): the side questions left open, until hidden or one is opened. */
  const [comeBack, setComeBack] = useState<OpenBranch[] | null>(null);
  const [freshStart] = useState(() => route === null);

  const refresh = useCallback(async () => {
    try {
      const [t, n] = await Promise.all([api.threads(notebook.id), api.notes(notebook.id)]);
      setThreads(t.threads);
      setNotes(n.notes);
    } catch {
      // keep the lists we have; the views report connection problems
    }
  }, [notebook.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Remember the place (not the exact message) for the next time Noema opens.
  useEffect(() => {
    const place = placeOf(route);
    if (place) storage.setJson(keys.lastPlace, { hash: toHash(place), at: new Date().toISOString() });
  }, [route]);

  // Nothing in the URL: open where you left off. That is the last place open
  // in this browser, unless a thread has had something newer since (asked in
  // another tab, say); then that thread. With nothing at all, a new thread.
  useEffect(() => {
    if (route || !threads) return;
    const recent = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const last = storage.getJson<{ hash?: string; at?: string } | null>(keys.lastPlace, null);
    const place = last?.hash ? parseHash(last.hash) : null;
    const exists =
      place !== null &&
      (place.kind === 'note' ? notes.some((n) => n.id === place.id) : threads.some((t) => t.id === place.id));
    if (place && exists && (!recent || (last?.at ?? '') >= recent.updatedAt)) {
      navigate(place, { replace: true });
      return;
    }
    navigate(recent ? { kind: 'thread', id: recent.id } : { kind: 'new' }, { replace: true });
  }, [route, threads, notes, navigate]);

  useEffect(() => {
    if (!freshStart) return;
    api.openBranches(notebook.id).then(
      (r) => setComeBack(r.branches.length > 0 ? r.branches : null),
      () => {},
    );
  }, [freshStart, notebook.id]);

  // ⌘K or Ctrl+K anywhere, or "/" when not typing, opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = useCallback(
    (next: Parameters<typeof navigate>[0]) => {
      setDraft(null);
      setFocus(null);
      setSidebarOpen(false);
      setSearching(false);
      setComeBack(null);
      navigate(next);
    },
    [navigate],
  );
  const open = useCallback((id: string, from?: string) => go({ kind: 'thread', id, from }), [go]);
  const toMessage = useCallback((id: string, message: string) => go({ kind: 'thread', id, message }), [go]);
  const openNote = useCallback((id: string) => go({ kind: 'note', id }), [go]);

  const openHit = (hit: SearchHit, terms: string[], rank: number, queryChars: number) => {
    void api.searchOpened({ kind: hit.kind, rank, queryChars }).catch(() => {});
    const target = hit.messageId ?? hit.blockId;
    if (target) expectFound(target, terms);
    setJump((n) => n + 1);
    if (hit.kind === 'message' && hit.threadId && hit.messageId) {
      go({ kind: 'thread', id: hit.threadId, message: hit.messageId });
    } else if (hit.kind === 'thread' && hit.threadId) {
      go({ kind: 'thread', id: hit.threadId });
    } else if (hit.noteId) {
      go({ kind: 'note', id: hit.noteId, block: hit.blockId ?? undefined });
    }
  };

  const startNew = () => go({ kind: 'new' });
  const newNote = async () => {
    const id = ulid();
    try {
      await api.createNote(notebook.id, id);
    } catch {
      return; // the server is unreachable; the views already say so
    }
    await refresh();
    openNote(id);
  };

  const onRefresh = useCallback(() => void refresh(), [refresh]);
  const showDraft = draft && route?.kind === 'thread' && route.id === draft.parentThreadId ? draft : null;

  let main: ReactNode = null;
  if (showDraft) {
    main = (
      <DraftView
        notebookId={notebook.id}
        branch={showDraft}
        onCreated={(id) => {
          void refresh();
          open(id);
        }}
        onCancel={() => {
          setFocus({ messageId: showDraft.messageId, start: showDraft.start, end: showDraft.end });
          setDraft(null);
        }}
      />
    );
  } else if (route?.kind === 'new') {
    main = (
      <DraftView
        notebookId={notebook.id}
        branch={null}
        onCreated={(id) => {
          void refresh();
          open(id);
        }}
        onCancel={() => {}}
      />
    );
  } else if (route?.kind === 'thread') {
    main = (
      <ThreadView
        key={`${route.id}:${route.from ?? ''}:${route.message ?? ''}:${jump}`}
        threadId={route.id}
        returningFrom={route.from}
        message={route.message}
        focus={focus}
        onNavigate={open}
        onBranch={setDraft}
        onChanged={onRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMap={(id) => go({ kind: 'map', id })}
        onOpenNote={openNote}
        onCite={toMessage}
        threads={threads ?? []}
      />
    );
  } else if (route?.kind === 'map') {
    main = (
      <MapView
        key={route.id}
        threadId={route.id}
        toMessage={toMessage}
        toPassage={(parent, branch) => open(parent, branch)}
        toThread={(id) => open(id)}
        toMap={(id) => go({ kind: 'map', id })}
      />
    );
  } else if (route?.kind === 'note') {
    main = (
      <NoteView
        key={`${route.id}:${route.block ?? ''}:${jump}`}
        noteId={route.id}
        block={route.block}
        onCite={toMessage}
        onOpenThread={(id) => open(id)}
        onOpenNote={openNote}
        notes={notes}
        onChanged={onRefresh}
        onDeleted={() => {
          onRefresh();
          go({ kind: 'new' });
        }}
      />
    );
  }

  const activeId = showDraft || !route || route.kind === 'new' ? null : route.id;
  // Not the one already open (Noema may have reopened in it).
  const leftOpen = comeBack?.filter((b) => b.threadId !== activeId) ?? [];

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <button
            type="button"
            className="sidebar-toggle quiet"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-expanded={sidebarOpen}
            aria-label="Threads"
            data-testid="threads-toggle"
          >
            ☰
          </button>
          <span className="wordmark">Noema</span>
          <span className="notebook-title">{notebook.title}</span>
        </div>
        <button
          type="button"
          className="search-open"
          onClick={() => setSearching(true)}
          aria-keyshortcuts="Meta+K Control+K /"
          data-testid="search-open"
        >
          <span className="search-glyph" aria-hidden>
            ⌕
          </span>
          <span className="search-open-label">Search</span>
          <kbd>{searchShortcut()}</kbd>
        </button>
        <button
          type="button"
          className="model"
          onClick={() => setSettingsOpen(true)}
          title="Model settings"
          data-testid="model-button"
        >
          {health.model ?? 'Connect a model'}
        </button>
      </header>
      {searching && (
        <SearchDialog
          notebookId={notebook.id}
          onClose={() => setSearching(false)}
          onOpen={openHit}
          onOpenThread={(id) => open(id)}
        />
      )}
      {settingsOpen && (
        <ModelDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            api.health().then(onHealthChange, () => {});
          }}
        />
      )}
      <div className="layout">
        <Sidebar
          threads={threads ?? []}
          notes={notes}
          activeId={activeId}
          open={sidebarOpen}
          onOpen={(id) => open(id)}
          onJump={(branch) => branch.parentThreadId && open(branch.parentThreadId, branch.id)}
          onOpenNote={openNote}
          onNew={startNew}
          onNewNote={() => void newNote()}
        />
        <div className="main">
          {leftOpen.length > 0 && (
            <ComeBack
              branches={leftOpen}
              onOpen={(id) => open(id)}
              onHide={() => setComeBack(null)}
              onSearch={() => setSearching(true)}
            />
          )}
          {main}
        </div>
      </div>
    </div>
  );
}

/** The place a route is in, without the exact message or block it was opened at. */
function placeOf(route: Route | null): Route | null {
  if (!route) return null;
  switch (route.kind) {
    case 'thread':
      return { kind: 'thread', id: route.id };
    case 'note':
      return { kind: 'note', id: route.id };
    case 'map':
      return route;
    case 'new':
      return null;
  }
}
