// The app shell: start-up, the connect screen, the header, the sidebar of
// threads and notes, and which view fills the page (a thread, the map of a
// thread tree, or a note).
// Still to come: sources (M3) and the search UI (M4).

import { type Health, type Notebook, type NoteSummary, type Thread, ulid } from '@noema/core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { MapView } from './MapView.tsx';
import { ConnectScreen, ModelDialog } from './ModelSettings.tsx';
import { NoteView } from './NoteView.tsx';
import { useRoute } from './route.ts';
import { Sidebar } from './Sidebar.tsx';
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

  // Nothing in the URL: open the most recent thread, or a new one.
  useEffect(() => {
    if (route || !threads) return;
    const recent = threads
      .filter((t) => !t.parentThreadId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    navigate(recent ? { kind: 'thread', id: recent.id } : { kind: 'new' }, { replace: true });
  }, [route, threads, navigate]);

  const go = useCallback(
    (next: Parameters<typeof navigate>[0]) => {
      setDraft(null);
      setFocus(null);
      setSidebarOpen(false);
      navigate(next);
    },
    [navigate],
  );
  const open = useCallback((id: string, from?: string) => go({ kind: 'thread', id, from }), [go]);
  const toMessage = useCallback((id: string, message: string) => go({ kind: 'thread', id, message }), [go]);
  const openNote = useCallback((id: string) => go({ kind: 'note', id }), [go]);

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
        key={`${route.id}:${route.from ?? ''}:${route.message ?? ''}`}
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
        key={route.id}
        noteId={route.id}
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
          className="model"
          onClick={() => setSettingsOpen(true)}
          title="Model settings"
          data-testid="model-button"
        >
          {health.model ?? 'Connect a model'}
        </button>
      </header>
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
        <div className="main">{main}</div>
      </div>
    </div>
  );
}
