// The app shell: start-up, the connect screen, the header with search, the
// sidebar of threads, sources and notes, and which view fills the page (a
// thread, the map of a thread tree, a note, or a source). A thread asked about
// a source, and its side questions, are shown beside that source.

import {
  type Health,
  type Notebook,
  type NoteSummary,
  type OpenBranch,
  type SearchHit,
  type Source,
  type SourceOrigin,
  type Thread,
  type Trash,
  ulid,
  type VaultTarget,
} from '@noema/core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AboutYouDialog } from './AboutYou.tsx';
import { AddSourceDialog } from './AddSource.tsx';
import { api } from './api.ts';
import { ContextDialog } from './ContextView.tsx';
import { ExportDialog } from './ExportImport.tsx';
import { LivingFrame } from './LivingFrame.tsx';
import { expectFound } from './found.ts';
import { MapView } from './MapView.tsx';
import { ConnectScreen, ModelDialog } from './ModelSettings.tsx';
import { NoteView } from './NoteView.tsx';
import { sourceFamily } from './reading.ts';
import { parseHash, type Route, toHash, useRoute } from './route.ts';
import { ComeBack, isTyping, SearchDialog, searchShortcut } from './Search.tsx';
import { Sidebar } from './Sidebar.tsx';
import { SourceView } from './SourceView.tsx';
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
  const [sources, setSources] = useState<Source[]>([]);
  const [trash, setTrash] = useState<Trash>({ threads: [], notes: [], sources: [] });
  const [adding, setAdding] = useState(false);
  const [contextFor, setContextFor] = useState<{ messageId: string; revisionId?: string | undefined } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /** One line at the bottom after something went to the Trash, with Undo. */
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
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
  /** The notebook's Assistant thread, once it is opened (made the first time). */
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [assistantError, setAssistantError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, n, src, tr] = await Promise.all([
        api.threads(notebook.id),
        api.notes(notebook.id),
        api.sources(notebook.id),
        api.trash(notebook.id),
      ]);
      setThreads(t.threads);
      setNotes(n.notes);
      setSources(src.sources);
      setTrash(tr);
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
      place.kind !== 'new' &&
      (place.kind === 'assistant' ||
        (place.kind === 'note'
          ? notes.some((n) => n.id === place.id)
          : place.kind === 'source'
            ? sources.some((x) => x.id === place.id)
            : threads.some((t) => t.id === place.id)));
    if (place && exists && (!recent || (last?.at ?? '') >= recent.updatedAt)) {
      navigate(place, { replace: true });
      return;
    }
    navigate(recent ? { kind: 'thread', id: recent.id } : { kind: 'new' }, { replace: true });
  }, [route, threads, notes, sources, navigate]);

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
  const openSource = useCallback((id: string) => go({ kind: 'source', id }), [go]);
  /** Open a thread just made: the lists first, so it is known whether it goes beside a source. */
  const openNew = useCallback(
    async (id: string) => {
      await refresh();
      open(id);
    },
    [refresh, open],
  );
  const backToSource = useCallback(
    (o: SourceOrigin, threadId: string) =>
      go({
        kind: 'source',
        id: o.sourceId,
        version: o.passage.versionId === o.latestVersionId ? undefined : o.passage.versionId,
        from: threadId,
      }),
    [go],
  );

  const openHit = (hit: SearchHit, terms: string[], rank: number, queryChars: number) => {
    void api.searchOpened({ kind: hit.kind, rank, queryChars }).catch(() => {});
    const target =
      hit.kind === 'passage' && hit.versionId && hit.offset !== null
        ? `${hit.versionId}:${hit.offset}`
        : (hit.messageId ?? hit.blockId);
    if (target) expectFound(target, terms);
    setJump((n) => n + 1);
    if (hit.kind === 'passage' && hit.sourceId && hit.offset !== null) {
      go({ kind: 'source', id: hit.sourceId, at: hit.offset });
    } else if (hit.kind === 'source' && hit.sourceId) {
      go({ kind: 'source', id: hit.sourceId });
    } else if (hit.kind === 'message' && hit.threadId && hit.messageId) {
      go({ kind: 'thread', id: hit.threadId, message: hit.messageId });
    } else if (hit.kind === 'thread' && hit.threadId) {
      go({ kind: 'thread', id: hit.threadId });
    } else if (hit.noteId) {
      go({ kind: 'note', id: hit.noteId, block: hit.blockId ?? undefined });
    }
  };

  const restoreThread = async (id: string) => {
    try {
      await api.restoreThread(id);
      setToast(null);
      await refresh();
      open(id);
    } catch {
      // the thread view reports problems when opened
    }
  };

  const restoreSource = async (id: string) => {
    try {
      await api.restoreSource(id);
      setToast(null);
      await refresh();
      openSource(id);
    } catch {
      // the source view reports problems when opened
    }
  };

  const restoreNote = async (id: string) => {
    try {
      await api.restoreNote(id);
      setToast(null);
      await refresh();
      openNote(id);
    } catch {
      // the note view reports problems when opened
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // The Assistant's thread: asked for when it is first opened.
  useEffect(() => {
    if (route?.kind !== 'assistant' || assistantId) return;
    let cancelled = false;
    api.assistant(notebook.id, ulid()).then(
      (t) => !cancelled && setAssistantId(t.id),
      (err: unknown) => !cancelled && setAssistantError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [route, assistantId, notebook.id]);

  /** Where one of the Assistant's labels points: the message, the passage or the note itself. */
  const openTarget = useCallback(
    (t: VaultTarget) => {
      setJump((n) => n + 1);
      if (t.kind === 'thread') go({ kind: 'thread', id: t.threadId, message: t.messageId ?? undefined });
      else if (t.kind === 'note') go({ kind: 'note', id: t.noteId, block: t.blockId ?? undefined });
      else {
        const latest = sources.find((x) => x.id === t.sourceId)?.latestVersionId;
        go({
          kind: 'source',
          id: t.sourceId,
          version: latest && latest !== t.versionId ? t.versionId : undefined,
          at: t.at > 0 ? t.at : undefined,
        });
      }
    },
    [go, sources],
  );

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

  // A thread asked about a source (or a side question of one) is shown beside it.
  const family = route?.kind === 'thread' && threads ? sourceFamily(threads, route.id) : null;
  const beside = family && sources.some((x) => x.id === family.sourceId) ? family : null;

  let main: ReactNode = null;
  let thread: ReactNode = null;
  if (route?.kind === 'thread' && threads === null) {
    // The lists are not loaded yet, so it is not known whether it goes beside a source.
  } else if (showDraft) {
    thread = (
      <DraftView
        notebookId={notebook.id}
        branch={showDraft}
        onCreated={(id) => void openNew(id)}
        onOpenAsked={(threadId, messageId) => {
          setDraft(null);
          toMessage(threadId, messageId);
        }}
        onCancel={() => {
          setFocus({
            messageId: showDraft.messageId,
            revisionId: showDraft.revisionId,
            start: showDraft.start,
            end: showDraft.end,
          });
          setDraft(null);
        }}
      />
    );
  } else if (route?.kind === 'new') {
    main = (
      <DraftView
        notebookId={notebook.id}
        branch={null}
        onCreated={(id) => void openNew(id)}
        onOpenAsked={toMessage}
        onCancel={() => {}}
      />
    );
  } else if (route?.kind === 'thread') {
    thread = (
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
        onBackToSource={backToSource}
        beside={beside !== null}
        notes={notes}
        onShowContext={(messageId: string, revisionId?: string) => setContextFor({ messageId, revisionId })}
        onDeleted={(t, count) => {
          void refresh();
          const sides = count - 1;
          setToast({
            text: `“${t.title || 'Untitled'}”${sides > 0 ? ` and ${sides === 1 ? 'its side question' : `${sides} side questions`}` : ''} moved to the Trash.`,
            undo: () => void restoreThread(t.id),
          });
          if (t.parentThreadId && !t.splitAt) open(t.parentThreadId);
          else if (t.sourceId) openSource(t.sourceId);
          else go({ kind: 'new' });
        }}
        threads={threads ?? []}
      />
    );
  } else if (route?.kind === 'assistant') {
    main = assistantId ? (
      <ThreadView
        key={`assistant:${assistantId}`}
        threadId={assistantId}
        onNavigate={open}
        onBranch={setDraft}
        onChanged={onRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMap={(id) => go({ kind: 'map', id })}
        onOpenNote={openNote}
        onCite={toMessage}
        onBackToSource={backToSource}
        notes={notes}
        onShowContext={(messageId: string, revisionId?: string) => setContextFor({ messageId, revisionId })}
        onDeleted={() => go({ kind: 'new' })}
        threads={threads ?? []}
        onOpenTarget={openTarget}
      />
    ) : (
      <main className="thread" aria-busy={!assistantError}>
        {assistantError && (
          <div className="empty" role="alert">
            <p className="empty-title">The Assistant could not be opened: {assistantError}</p>
          </div>
        )}
      </main>
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
        onRestore={onRefresh}
        openRef={route.ref}
        refIn={route.refIn}
        onRef={(label, blockId) =>
          // Which exchange is open beside the note is a view of it, not a step: replaced, not added to history.
          navigate({ kind: 'note', id: route.id, ref: label ?? undefined, refIn: label ? blockId : undefined }, { replace: true })
        }
        onDeleted={() => {
          const n = notes.find((x) => x.id === route.id);
          const id = route.id;
          onRefresh();
          setToast({ text: `“${n?.title || 'Untitled'}” moved to the Trash.`, undo: () => void restoreNote(id) });
          go({ kind: 'new' });
        }}
      />
    );
  }

  // The reading pane: the same view (so the same place in the text) whether a thread is open beside it or not.
  const reading = route?.kind === 'source' ? route : beside ? { id: beside.sourceId } : null;
  if (reading) {
    const r = route?.kind === 'source' ? route : null;
    main = (
      <SourceView
        key={reading.id}
        sourceId={reading.id}
        version={r ? r.version : beside?.versionId}
        at={r?.at}
        focusThread={r ? r.from : beside?.rootId}
        pinTo={route?.kind === 'thread' && beside ? route.id : undefined}
        jump={jump}
        arrival={route ? toHash(route) : ''}
        notebookId={notebook.id}
        threads={threads ?? []}
        notes={notes}
        onOpenNote={openNote}
        onOpenThread={open}
        onOpenMessage={toMessage}
        onVersion={(version) => go({ kind: 'source', id: reading.id, version })}
        onAsked={(id) => void openNew(id)}
        onChanged={onRefresh}
        onDeleted={(x) => {
          void refresh();
          setToast({ text: `“${x.title || 'Untitled'}” moved to the Trash.`, undo: () => void restoreSource(x.id) });
          go({ kind: 'new' });
        }}
      >
        {thread}
      </SourceView>
    );
  } else if (thread) {
    main = thread;
  }

  const activeId = showDraft || !route || route.kind === 'new' || route.kind === 'assistant' ? null : route.id;
  // Not the one already open (Noema may have reopened in it).
  const leftOpen = comeBack?.filter((b) => b.threadId !== activeId) ?? [];

  return (
    <div className="shell">
      <LivingFrame />
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
          className="quiet about-open"
          onClick={() => setAboutOpen(true)}
          title="What the AI is told about you with every question"
          data-testid="about-open"
        >
          About you
        </button>
        <button
          type="button"
          className="quiet about-open"
          onClick={() => setExportOpen(true)}
          title="Download a copy of everything, or a Markdown file to read; import a copy"
          data-testid="export-open"
        >
          Export
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
      {toast && (
        <div className="toast" role="status" data-testid="app-toast">
          {toast.text}
          <button type="button" onClick={toast.undo} data-testid="toast-undo">
            Undo
          </button>
        </div>
      )}
      {searching && (
        <SearchDialog
          notebookId={notebook.id}
          onClose={() => setSearching(false)}
          onOpen={openHit}
          onOpenThread={(id) => open(id)}
        />
      )}
      {contextFor && (
        <ContextDialog
          key={`${contextFor.messageId}:${contextFor.revisionId ?? ''}`}
          messageId={contextFor.messageId}
          revisionId={contextFor.revisionId}
          onClose={() => setContextFor(null)}
          onEditAboutMe={() => {
            setContextFor(null);
            setAboutOpen(true);
          }}
        />
      )}
      {aboutOpen && <AboutYouDialog notebookId={notebook.id} onClose={() => setAboutOpen(false)} />}
      {exportOpen && <ExportDialog notebookId={notebook.id} onClose={() => setExportOpen(false)} />}
      {adding && (
        <AddSourceDialog
          notebookId={notebook.id}
          onClose={() => setAdding(false)}
          onAdded={(x) => {
            setAdding(false);
            void refresh();
            openSource(x.id);
          }}
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
          sources={sources}
          notes={notes}
          activeId={activeId}
          assistantActive={route?.kind === 'assistant'}
          onOpenAssistant={() => go({ kind: 'assistant' })}
          open={sidebarOpen}
          onOpen={(id) => open(id)}
          onJump={(t) => {
            if (t.sourceId) {
              const latest = sources.find((x) => x.id === t.sourceId)?.latestVersionId;
              const version = t.sourceVersionId && t.sourceVersionId !== latest ? t.sourceVersionId : undefined;
              go({ kind: 'source', id: t.sourceId, version, from: t.id });
            } else if (t.parentThreadId) {
              open(t.parentThreadId, t.id);
            }
          }}
          onOpenNote={openNote}
          onNew={startNew}
          onNewNote={() => void newNote()}
          trash={trash}
          onRestoreThread={(id) => void restoreThread(id)}
          onRestoreNote={(id) => void restoreNote(id)}
          onOpenTrashed={(kind, id) => (kind === 'thread' ? open(id) : kind === 'source' ? openSource(id) : openNote(id))}
          onOpenSource={openSource}
          onAddSource={() => setAdding(true)}
          onRestoreSource={(id) => void restoreSource(id)}
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
    case 'source':
      return { kind: 'source', id: route.id, version: route.version };
    case 'new':
      return null;
    case 'assistant':
      return route;
  }
}
