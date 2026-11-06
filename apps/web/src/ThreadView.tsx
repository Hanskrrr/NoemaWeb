// One thread or branch: its messages, the composer, select-to-branch, the
// origin card with Back, and the marks where branches left.

import {
  type BranchSummary,
  createAnchor,
  isLive,
  isTerminal,
  type Message,
  type MessageError,
  type MessageStatus,
  type Origin,
  resolveAnchor,
  type Thread,
  ulid,
} from '@noema/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiFailure, api, watchMessage } from './api.ts';
import { Composer } from './Composer.tsx';
import { MessageView } from './MessageView.tsx';
import { highlight, selectionToSource, sourceToRange } from './markdown/selection.ts';
import { keys, storage } from './storage.ts';

/** A passage to scroll to and highlight when a thread opens (after cancelling a branch). */
export interface Focus {
  messageId: string;
  start: number;
  end: number;
}

/** A branch that has a passage but no question yet. It is created on the first send. */
export interface BranchDraft {
  parentThreadId: string;
  parentTitle: string;
  messageId: string;
  start: number;
  end: number;
  exact: string;
}

// ---------------------------------------------------------------------------
// Messages state

type Action =
  | { type: 'reset'; messages: Message[] }
  | { type: 'upsert'; message: Message }
  | { type: 'append'; id: string; text: string }
  | { type: 'status'; id: string; status: MessageStatus; error: MessageError | null };

function reducer(state: Message[], action: Action): Message[] {
  switch (action.type) {
    case 'reset':
      return [...action.messages].sort((a, b) => a.seq - b.seq);
    case 'upsert': {
      const rest = state.filter((m) => m.id !== action.message.id);
      return [...rest, action.message].sort((a, b) => a.seq - b.seq);
    }
    case 'append':
      return state.map((m) => (m.id === action.id ? { ...m, content: m.content + action.text } : m));
    case 'status':
      return state.map((m) => (m.id === action.id ? { ...m, status: action.status, error: action.error } : m));
  }
}

interface Outbox {
  id: string;
  content: string;
}

function optimisticUser(threadId: string, id: string, content: string, seq: number): Message {
  const t = new Date().toISOString();
  return {
    id,
    threadId,
    role: 'user',
    seq,
    replyTo: null,
    revisionId: id,
    revision: 1,
    content,
    status: 'pending',
    error: null,
    model: null,
    createdAt: t,
    updatedAt: t,
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Highlights: where branches left (soft), and the passage Back returned to (strong)

function rangesFor(branches: BranchSummary[], byId: Map<string, Message>): Range[] {
  const ranges: Range[] = [];
  for (const b of branches) {
    const message = byId.get(b.anchor.messageId);
    const container = document.querySelector(`[data-message-id="${b.anchor.messageId}"]`);
    if (!message || !container || message.revisionId !== b.anchor.revisionId) continue;
    const r = resolveAnchor({ targetId: b.anchor.revisionId, quote: b.anchor, position: b.anchor }, message.content);
    if (r.status === 'unresolved') continue;
    const range = sourceToRange(container, message.content, r.start, r.end);
    if (range) ranges.push(range);
  }
  return ranges;
}

// ---------------------------------------------------------------------------

export function ThreadView({
  threadId,
  returningFrom,
  message: focusMessage,
  focus,
  onNavigate,
  onBranch,
  onChanged,
  onOpenSettings,
  onOpenMap,
  onOpenNote,
}: {
  threadId: string;
  returningFrom?: string | undefined;
  /** Scroll to this exact message and flash it (from the map, a note citation or search). */
  message?: string | undefined;
  focus?: Focus | null;
  onOpenMap: (threadId: string) => void;
  onOpenNote: (noteId: string) => void;
  onNavigate: (threadId: string, from?: string) => void;
  onBranch: (draft: BranchDraft) => void;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [path, setPath] = useState<Array<{ id: string; title: string }>>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [messages, dispatch] = useReducer(reducer, []);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(() => storage.getJson<Outbox | null>(keys.outbox(threadId), null));
  const watchers = useRef(new Map<string, () => void>());
  const bottom = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const watch = useCallback(
    (id: string) => {
      if (watchers.current.has(id)) return;
      const close = watchMessage(id, {
        snapshot: (m) => dispatch({ type: 'upsert', message: m }),
        delta: (text) => dispatch({ type: 'append', id, text }),
        status: (status, error) => dispatch({ type: 'status', id, status, error }),
        end: () => {
          watchers.current.delete(id);
          onChanged();
          // The first answer may have given the thread its AI title.
          api.thread(threadId).then(
            (d) => setThread(d.thread),
            () => {},
          );
        },
      });
      watchers.current.set(id, close);
    },
    [threadId, onChanged],
  );

  const deliver = useCallback(
    async (item: Outbox, seq: number) => {
      dispatch({ type: 'upsert', message: optimisticUser(threadId, item.id, item.content, seq) });
      try {
        const r = await api.ask(threadId, item.id, item.content);
        dispatch({ type: 'upsert', message: r.user });
        dispatch({ type: 'upsert', message: r.assistant });
        storage.remove(keys.outbox(threadId));
        setOutbox(null);
        setNotice(null);
        onChanged();
        if (!isTerminal(r.assistant.status)) watch(r.assistant.id);
      } catch (err) {
        // The question stays in the outbox; sending again reuses its id, so it can never be asked twice.
        dispatch({ type: 'status', id: item.id, status: 'failed', error: null });
        setNotice(err instanceof ApiFailure ? err.message : 'Could not send the question.');
      }
    },
    [threadId, watch, onChanged],
  );

  useEffect(() => {
    let cancelled = false;
    const open = watchers.current;
    (async () => {
      try {
        const detail = await api.thread(threadId);
        if (cancelled) return;
        setThread(detail.thread);
        setOrigin(detail.origin);
        setPath(detail.path);
        setBranches(detail.branches);
        dispatch({ type: 'reset', messages: detail.messages });
        setLoaded(true);
        for (const m of detail.messages) if (isLive(m.status)) watch(m.id);
        const pending = storage.getJson<Outbox | null>(keys.outbox(threadId), null);
        if (pending && !detail.messages.some((m) => m.id === pending.id)) {
          void deliver(pending, (detail.messages.at(-1)?.seq ?? -1) + 1);
        } else if (pending) {
          storage.remove(keys.outbox(threadId));
          setOutbox(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFailure && err.status === 404) setMissing(true);
        else setNotice(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
      for (const close of open.values()) close();
      open.clear();
    };
  }, [threadId, watch, deliver]);

  const live = messages.find((m) => m.role === 'assistant' && isLive(m.status));
  const lastContentLength = messages.at(-1)?.content.length ?? 0;

  // Follow the answer as it grows, unless the learner has scrolled up to read.
  const stick = useRef(!returningFrom && !focus && !focusMessage);
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (lastContentLength >= 0 && stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastContentLength]);

  // Marks where branches left, redrawn as messages render.
  useEffect(() => {
    highlight('noema-branches', loaded ? rangesFor(branches, byId) : null);
  }, [branches, byId, loaded]);
  useEffect(() => () => void highlight('noema-branches', null), []);

  // Back from a branch: scroll to the passage it left from and highlight it.
  const returned = useRef(false);
  useEffect(() => {
    if (!loaded || returned.current || (!returningFrom && !focus && !focusMessage)) return;
    returned.current = true;
    if (focusMessage) {
      const article = document.querySelector(`[data-message-id="${focusMessage}"]`)?.closest('article');
      if (!article) return;
      article.scrollIntoView({ block: 'center' });
      article.classList.add('flash');
      setTimeout(() => article.classList.remove('flash'), 2400);
      return;
    }
    let range: Range | undefined;
    if (returningFrom) {
      const branch = branches.find((b) => b.threadId === returningFrom);
      [range] = branch ? rangesFor([branch], byId) : [];
    } else if (focus) {
      const message = byId.get(focus.messageId);
      const container = document.querySelector(`[data-message-id="${focus.messageId}"]`);
      if (message && container) range = sourceToRange(container, message.content, focus.start, focus.end) ?? undefined;
    }
    if (!range) return;
    highlight('noema-return', range);
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center' });
  }, [loaded, returningFrom, focus, focusMessage, branches, byId]);
  useEffect(() => () => void highlight('noema-return', null), []);

  // Select a passage in a finished message to ask about it in a branch.
  const [selection, setSelection] = useState<{ messageId: string; start: number; end: number; rect: DOMRect } | null>(
    null,
  );
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      const container = node?.closest<HTMLElement>('[data-message-id]');
      const message = container ? byId.get(container.dataset.messageId ?? '') : undefined;
      if (!container || !message || !isTerminal(message.status) || !message.content) {
        setSelection(null);
        return;
      }
      const range = selectionToSource(container, message.content);
      setSelection(range ? { messageId: message.id, ...range, rect: sel.getRangeAt(0).getBoundingClientRect() } : null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [byId]);

  const branchFromSelection = () => {
    const message = selection ? byId.get(selection.messageId) : undefined;
    if (!selection || !message || !thread) return;
    const anchor = createAnchor(message.revisionId, message.content, selection.start, selection.end);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    onBranch({
      parentThreadId: thread.id,
      parentTitle: thread.title,
      messageId: message.id,
      start: anchor.position.start,
      end: anchor.position.end,
      exact: anchor.quote.exact,
    });
  };

  const send = (content: string) => {
    const item = { id: ulid(), content };
    storage.setJson(keys.outbox(threadId), item);
    setOutbox(item);
    void deliver(item, (messages.at(-1)?.seq ?? -1) + 1);
    return true;
  };

  const retry = () => {
    if (outbox) void deliver(outbox, (messages.filter((m) => m.id !== outbox.id).at(-1)?.seq ?? -1) + 1);
  };

  const stop = async (id: string) => {
    try {
      await api.stop(id);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const rename = async (title: string) => {
    try {
      setThread(await api.renameThread(threadId, title));
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const rewrite = async () => {
    const noteId = ulid();
    try {
      await api.rewriteAsNote(threadId, noteId);
      onChanged();
      onOpenNote(noteId);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const back = () => {
    if (!origin) return;
    void api.returnFromBranch(threadId).catch(() => {});
    onNavigate(origin.parentThreadId, threadId);
  };

  if (missing) {
    return (
      <main className="thread">
        <div className="empty">
          <p className="empty-title">This thread is not in the notebook.</p>
        </div>
      </main>
    );
  }

  const branchesByMessage = new Map<string, BranchSummary[]>();
  for (const b of branches) {
    const list = branchesByMessage.get(b.anchor.messageId) ?? [];
    list.push(b);
    branchesByMessage.set(b.anchor.messageId, list);
  }

  return (
    <>
      <main className="thread" aria-busy={!loaded}>
        {thread && (
          <ThreadHeader
            title={thread.title}
            canRewrite={messages.some((m) => m.role === 'assistant' && m.status === 'done')}
            onRename={rename}
            onOpenMap={() => onOpenMap(threadId)}
            onRewrite={() => void rewrite()}
          />
        )}
        {origin && (
          <OriginCard
            parentTitle={origin.parentTitle}
            exact={origin.anchor.exact}
            path={path}
            onBack={back}
            onOpen={(id) => onNavigate(id)}
          />
        )}
        {loaded && messages.length === 0 && !origin && (
          <div className="empty">
            <p className="empty-title">Ask anything you are studying.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            branches={branchesByMessage.get(m.id) ?? []}
            onStop={() => void stop(m.id)}
            onOpenSettings={onOpenSettings}
            onOpenBranch={(id) => onNavigate(id)}
          />
        ))}
        {loaded && messages.length > 0 && branches.length === 0 && !origin && messages.length <= 2 && (
          <p className="hint">Tip: select any passage to ask about it in a side branch.</p>
        )}
        <div ref={bottom} />
      </main>

      {notice && (
        <div className="notice" role="status" data-testid="notice">
          <span>{notice}</span>
          {outbox && (
            <button type="button" onClick={retry}>
              Send again
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <Composer
        key={threadId}
        draftKey={keys.draft(threadId)}
        busy={Boolean(live)}
        onSend={send}
        onStop={() => live && void stop(live.id)}
      />

      {selection && (
        <button
          type="button"
          className="selection-button"
          data-testid="branch-button"
          style={{ top: Math.max(8, selection.rect.top - 44), left: selection.rect.left + selection.rect.width / 2 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={branchFromSelection}
        >
          Ask in a branch
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ThreadHeader({
  title,
  canRewrite,
  onRename,
  onOpenMap,
  onRewrite,
}: {
  title: string;
  canRewrite: boolean;
  onRename: (title: string) => Promise<void>;
  onOpenMap: () => void;
  onRewrite: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const save = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title) await onRename(next);
  };

  return (
    <header className="thread-head">
      {editing ? (
        <input
          className="title-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Thread title"
          maxLength={200}
          // biome-ignore lint/a11y/noAutofocus: the field appears because the learner asked to rename
          autoFocus
          data-testid="title-input"
        />
      ) : (
        <h1>
          <button
            type="button"
            className="title-button"
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
            title="Rename"
            data-testid="rename"
          >
            {title || 'Untitled'}
            <span className="pencil" aria-hidden>
              ✎
            </span>
          </button>
        </h1>
      )}
      <div className="thread-actions">
        <button type="button" className="quiet" onClick={onOpenMap} data-testid="open-map">
          Map
        </button>
        <button
          type="button"
          className="quiet"
          onClick={onRewrite}
          disabled={!canRewrite}
          title="Rewrite this thread and its branches as a study note"
          data-testid="rewrite"
        >
          Rewrite as note
        </button>
      </div>
    </header>
  );
}

function OriginCard({
  parentTitle,
  exact,
  path,
  onBack,
  onOpen,
}: {
  parentTitle: string;
  exact: string;
  path?: Array<{ id: string; title: string }>;
  onBack: () => void;
  onOpen?: (threadId: string) => void;
}) {
  const quote = exact.length > 600 ? `${exact.slice(0, 600)}…` : exact;
  return (
    <section className="origin" data-testid="origin" data-exact={exact} aria-label="Where this branch started">
      <div className="origin-top">
        <button type="button" className="back" onClick={onBack} data-testid="back">
          ← Back
        </button>
        {path && path.length > 1 && onOpen ? (
          <nav className="crumbs" aria-label="Path">
            {path.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ' › '}
                <button type="button" className="quiet" onClick={() => onOpen(p.id)}>
                  {p.title || 'Untitled'}
                </button>
              </span>
            ))}
          </nav>
        ) : (
          <span className="origin-from">from {parentTitle || 'Untitled'}</span>
        )}
      </div>
      <blockquote>{quote}</blockquote>
    </section>
  );
}

/** A new thread, or a new branch, before its first question. */
export function DraftView({
  notebookId,
  branch,
  onCreated,
  onCancel,
}: {
  notebookId: string;
  branch: BranchDraft | null;
  onCreated: (threadId: string) => void;
  onCancel: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  // Reused across retries, so a send that reached the server but lost its reply is not repeated.
  const ids = useRef<{ thread: string; question: string; content: string } | null>(null);

  const send = async (content: string): Promise<boolean> => {
    const previous = ids.current;
    const current = {
      thread: previous?.thread ?? ulid(),
      question: previous && previous.content === content ? previous.question : ulid(),
      content,
    };
    ids.current = current;
    const id = current.thread;
    try {
      if (branch) {
        await api.createBranch(branch.parentThreadId, {
          id,
          anchor: { messageId: branch.messageId, start: branch.start, end: branch.end },
          question: { id: current.question, content },
        });
      } else {
        await api.createThread(notebookId, id);
        await api.ask(id, current.question, content);
      }
      onCreated(id);
      return true;
    } catch (err) {
      setNotice(err instanceof ApiFailure ? err.message : 'Could not send the question.');
      return false;
    }
  };

  return (
    <>
      <main className="thread">
        {branch ? (
          <OriginCard parentTitle={branch.parentTitle} exact={branch.exact} onBack={onCancel} />
        ) : (
          <div className="empty">
            <p className="empty-title">Ask anything you are studying.</p>
            <p>Answers keep streaming even if you close the tab. Select any passage later to ask about it in a branch.</p>
          </div>
        )}
      </main>
      {notice && (
        <div className="notice" role="status" data-testid="notice">
          <span>{notice}</span>
          <button type="button" className="quiet" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <Composer
        key={branch ? `${branch.messageId}:${branch.start}` : 'new'}
        draftKey={branch ? keys.draft(`branch:${branch.messageId}:${branch.start}-${branch.end}`) : keys.draft('new')}
        busy={false}
        autoFocus
        placeholder={branch ? 'Ask about this passage…' : 'Ask a question…'}
        onSend={send}
      />
    </>
  );
}
