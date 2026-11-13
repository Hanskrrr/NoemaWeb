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
import { type AssistantWhere, AssistantChat } from './Assistant.tsx';
import { ContextDialog } from './ContextView.tsx';
import { ExportDialog } from './ExportImport.tsx';
import { LivingFrame, Orb } from './LivingFrame.tsx';
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
  /** The Assistant beside whatever is open (ADR 0024); kept open across reloads. */
  const [docked, setDocked] = useState(() => storage.get(keys.assistantDock) === '1');
  const dock = useCallback((open: boolean) => {
    setDocked(open);
    storage.set(keys.assistantDock, open ? '1' : '0');
  }, []);
  const [dockWidth, setDockWidth] = useState(() => clampDock(Number(storage.get(keys.assistantDockWidth)) || DOCK_WIDTH));
  const resizeDock = useCallback((width: number) => {
    const w = clampDock(width);
    setDockWidth(w);
    storage.set(keys.assistantDockWidth, String(w));
  }, []);
  // The room the panel takes on the right: what is fixed there (the catalog) moves over by it.
  const dockShown = docked && route?.kind !== 'assistant';
  useEffect(() => {
    document.documentElement.style.setProperty('--dock-width', dockShown ? `${dockWidth}px` : '0px');
  }, [dockShown, dockWidth]);
  /** Text the learner selected in what is open: what "this" means to the Assistant. */
  const [selection, setSelection] = useState<string | null>(null);

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
  /** A file of a linked folder, opened as a source (read again if it changed): the lists first, then it. */
  const openFile = useCallback(
    (source: Source) => {
      void refresh();
      setJump((j) => j + 1);
      go({ kind: 'source', id: source.id });
    },
    [refresh, go],
  );
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
    // Something said to or by the Assistant: it opens beside what is open.
    if (hit.threadId && hit.threadId === assistantId) {
      setSearching(false);
      dock(true);
      return;
    }
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

  // The Assistant's thread: made the first time Noema opens.
  useEffect(() => {
    if (assistantId) return;
    let cancelled = false;
    api.assistant(notebook.id, ulid()).then(
      (t) => !cancelled && setAssistantId(t.id),
      (err: unknown) => !cancelled && setAssistantError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [assistantId, notebook.id]);

  // ⌘J (Ctrl+J) opens or closes the Assistant beside what is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        dock(!docked);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docked, dock]);

  // What the learner selects in the page (not in the Assistant) is kept until they ask, or leave.
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const el = node instanceof Element ? node : node.parentElement;
      if (!el?.closest('.main') || el.closest('.assistant')) return;
      const text = sel.toString().trim();
      if (text) setSelection(text.slice(0, 4000));
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  const placeKey = route && route.kind !== 'assistant' && route.kind !== 'new' ? `${route.kind}:${route.id}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new place drops the selection made in the last one
  useEffect(() => setSelection(null), [placeKey]);

  /** Where one of the Assistant's labels points: the message, the passage or the note itself. */
  const openTarget = useCallback(
    (t: VaultTarget) => {
      setJump((n) => n + 1);
      // Arriving there, the words it quoted are marked.
      const words = t.quote ? [t.quote.length > 48 ? t.quote.slice(0, t.quote.lastIndexOf(' ', 48) > 20 ? t.quote.lastIndexOf(' ', 48) : 48) : t.quote] : [];
      if (t.kind === 'thread' && t.messageId) expectFound(t.messageId, words);
      else if (t.kind === 'source') expectFound(`${t.versionId}:${t.at}`, words);
      else if (t.kind === 'note' && t.blockId) expectFound(t.blockId, words);
      // From the Assistant's own page, it moves beside what it opens.
      if (route?.kind === 'assistant' || (t.kind === 'thread' && t.threadId === assistantId)) dock(true);
      if (t.kind === 'thread' && t.threadId === assistantId) return;
      else if (t.kind === 'thread') go({ kind: 'thread', id: t.threadId, message: t.messageId ?? undefined });
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
    [go, sources, assistantId, dock, route],
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
    main = assistantId ? null : (
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
        notebookId={notebook.id}
        onOpenFile={openFile}
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

  // What is open, as the Assistant is told: the thread, the source (or the thread beside it), the note.
  const where: AssistantWhere | null = (() => {
    if (route?.kind === 'thread') {
      const t = threads?.find((x) => x.id === route.id);
      return { place: { kind: 'thread', id: route.id }, title: t?.title ?? '' };
    }
    if (route?.kind === 'source') {
      const x = sources.find((y) => y.id === route.id);
      return { place: { kind: 'source', id: route.id, ...(route.version ? { versionId: route.version } : {}) }, title: x?.title ?? '' };
    }
    if (route?.kind === 'note') {
      return { place: { kind: 'note', id: route.id }, title: notes.find((n) => n.id === route.id)?.title ?? '' };
    }
    return null;
  })();
  const assistantChat = (mode: 'panel' | 'page') => (
    <AssistantChat
      key={`${mode}:${assistantId}`}
      threadId={assistantId as string}
      mode={mode}
      where={mode === 'panel' ? where : null}
      selection={mode === 'panel' ? selection : null}
      onClearSelection={() => setSelection(null)}
      onOpenTarget={openTarget}
      onShowContext={(messageId) => setContextFor({ messageId })}
      onChanged={onRefresh}
      onActed={() => {
        // What is open is drawn again, to show the change (a pin, a title, the Trash).
        void refresh();
        setJump((n) => n + 1);
      }}
      onOpenSettings={() => setSettingsOpen(true)}
      {...(mode === 'panel'
        ? { onExpand: () => go({ kind: 'assistant' }), onClose: () => dock(false) }
        : { onClose: () => window.history.back() })}
    />
  );

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
          className={`assistant-open${docked || route?.kind === 'assistant' ? ' on' : ''}`}
          onClick={() => (route?.kind === 'assistant' ? undefined : dock(!docked))}
          aria-pressed={docked || route?.kind === 'assistant'}
          aria-keyshortcuts="Meta+J Control+J"
          title="The Assistant, beside whatever is open"
          data-testid="assistant-open"
        >
          <Orb size="small" />
          <span>Assistant</span>
          <kbd>{searchShortcut().replace(/K$/, 'J')}</kbd>
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
      <div className={`layout${dockShown ? ' with-dock' : ''}`}>
        <Sidebar
          threads={threads ?? []}
          sources={sources}
          notes={notes}
          activeId={activeId}
          assistantActive={route?.kind === 'assistant' || docked}
          onOpenAssistant={() => (route?.kind === 'assistant' ? undefined : dock(!docked))}
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
          notebookId={notebook.id}
          onOpenFile={openFile}
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
          {route?.kind === 'assistant' && assistantId ? assistantChat('page') : main}
        </div>
        {dockShown && assistantId && (
          <aside className="assistant-dock" data-testid="assistant-dock">
            <DockResizer width={dockWidth} onResize={resizeDock} />
            {assistantChat('panel')}
          </aside>
        )}
      </div>
    </div>
  );
}

/** The Assistant panel's width: as it opens, and the narrowest and widest it can be dragged to. */
const DOCK_WIDTH = 432;
const DOCK_MIN = 300;
function clampDock(width: number): number {
  const max = typeof window === 'undefined' ? 900 : Math.max(DOCK_MIN, Math.min(900, window.innerWidth * 0.6));
  return Math.round(Math.min(max, Math.max(DOCK_MIN, width)));
}

/** The panel's left edge: drag it (or use the arrow keys) to make the Assistant wider or narrower; double-click for the usual width. */
function DockResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a vertical splitter has no element of its own; role separator with a value is the pattern
    <div
      className="dock-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the Assistant"
      aria-valuenow={width}
      aria-valuemin={DOCK_MIN}
      tabIndex={0}
      title="Drag to resize; double-click for the usual width"
      data-testid="dock-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => onResize(window.innerWidth - ev.clientX);
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing');
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => onResize(DOCK_WIDTH)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(width + 24);
        else if (e.key === 'ArrowRight') onResize(width - 24);
        else return;
        e.preventDefault();
      }}
    />
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
