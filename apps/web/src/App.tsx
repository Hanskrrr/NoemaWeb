// M0 shell: one notebook, one thread, a composer, streaming answers, and
// the anchor spike (select a passage, pin it, highlight it back).
// Branches, return, the Notebook view and search UI come in later milestones.

import {
  type Anchor,
  createAnchor,
  type Health,
  isLive,
  isTerminal,
  type Message,
  type MessageError,
  type MessageStatus,
  type Notebook,
  resolveAnchor,
  type Thread,
  ulid,
} from '@noema/core';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiFailure, api, watchMessage } from './api.ts';
import { Markdown } from './markdown/Markdown.tsx';
import { highlight, selectionToSource, sourceToRange } from './markdown/selection.ts';
import { keys, storage } from './storage.ts';

// ---------------------------------------------------------------------------
// Boot

type Boot = { notebook: Notebook; thread: Thread; health: Health } | { error: string } | null;

export function App() {
  const [boot, setBoot] = useState<Boot>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await api.health();
        const { notebooks } = await api.notebooks();
        const notebook = notebooks[0];
        if (!notebook) throw new Error('no notebook');
        const { threads } = await api.threads(notebook.id);
        const thread = threads[0] ?? (await api.createThread(notebook.id, ulid()));
        if (!cancelled) setBoot({ notebook, thread, health });
      } catch (err) {
        if (!cancelled) setBoot({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (boot === null) return <div className="boot">Opening your notebook…</div>;
  if ('error' in boot) {
    return (
      <div className="boot boot-error" role="alert">
        <strong>Noema could not start.</strong>
        <span>{boot.error}</span>
      </div>
    );
  }
  return <ThreadView notebook={boot.notebook} thread={boot.thread} health={boot.health} />;
}

// ---------------------------------------------------------------------------
// Messages state

type Action =
  | { type: 'reset'; messages: Message[] }
  | { type: 'upsert'; message: Message }
  | { type: 'append'; id: string; text: string }
  | { type: 'status'; id: string; status: MessageStatus; error: MessageError | null }
  | { type: 'remove'; id: string };

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
    case 'remove':
      return state.filter((m) => m.id !== action.id);
  }
}

interface Outbox {
  id: string;
  content: string;
}

function optimisticUser(thread: Thread, id: string, content: string, seq: number): Message {
  const t = new Date().toISOString();
  return {
    id,
    threadId: thread.id,
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

// ---------------------------------------------------------------------------
// Thread

interface Pin {
  anchor: Anchor;
  messageId: string;
  pinnedAt: string;
}

function ThreadView({ notebook, thread, health }: { notebook: Notebook; thread: Thread; health: Health }) {
  const [messages, dispatch] = useReducer(reducer, []);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(() => storage.getJson<Outbox | null>(keys.outbox(thread.id), null));
  const watchers = useRef(new Map<string, () => void>());
  const bottom = useRef<HTMLDivElement>(null);

  const watch = useCallback((id: string) => {
    if (watchers.current.has(id)) return;
    const close = watchMessage(id, {
      snapshot: (m) => dispatch({ type: 'upsert', message: m }),
      delta: (text) => dispatch({ type: 'append', id, text }),
      status: (status, error) => dispatch({ type: 'status', id, status, error }),
      end: () => {
        watchers.current.delete(id);
      },
    });
    watchers.current.set(id, close);
  }, []);

  const deliver = useCallback(
    async (item: Outbox, seq: number) => {
      dispatch({ type: 'upsert', message: optimisticUser(thread, item.id, item.content, seq) });
      try {
        const r = await api.ask(thread.id, item.id, item.content);
        dispatch({ type: 'upsert', message: r.user });
        dispatch({ type: 'upsert', message: r.assistant });
        storage.remove(keys.outbox(thread.id));
        setOutbox(null);
        setNotice(null);
        if (!isTerminal(r.assistant.status)) watch(r.assistant.id);
      } catch (err) {
        // The question stays in the outbox; sending again reuses its id, so it can never be asked twice.
        dispatch({ type: 'status', id: item.id, status: 'failed', error: null });
        setNotice(err instanceof ApiFailure ? err.message : 'Could not send the question.');
      }
    },
    [thread, watch],
  );

  useEffect(() => {
    let cancelled = false;
    const open = watchers.current;
    (async () => {
      try {
        const detail = await api.thread(thread.id);
        if (cancelled) return;
        dispatch({ type: 'reset', messages: detail.messages });
        setLoaded(true);
        for (const m of detail.messages) if (isLive(m.status)) watch(m.id);
        const pending = storage.getJson<Outbox | null>(keys.outbox(thread.id), null);
        if (pending && !detail.messages.some((m) => m.id === pending.id)) {
          void deliver(pending, (detail.messages.at(-1)?.seq ?? -1) + 1);
        } else if (pending) {
          storage.remove(keys.outbox(thread.id));
          setOutbox(null);
        }
      } catch (err) {
        if (!cancelled) setNotice(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      for (const close of open.values()) close();
      open.clear();
    };
  }, [thread.id, watch, deliver]);

  const live = messages.find((m) => m.role === 'assistant' && isLive(m.status));
  const lastContentLength = messages.at(-1)?.content.length ?? 0;

  // Follow the answer as it grows, unless the learner has scrolled up to read.
  const stick = useRef(true);
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

  const send = (content: string) => {
    const item = { id: ulid(), content };
    storage.setJson(keys.outbox(thread.id), item);
    setOutbox(item);
    void deliver(item, (messages.at(-1)?.seq ?? -1) + 1);
  };

  const retry = () => {
    if (outbox) void deliver(outbox, (messages.filter((m) => m.id !== outbox.id).at(-1)?.seq ?? -1) + 1);
  };

  const stop = async (id: string) => {
    try {
      await api.stop(id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  // Anchor spike -------------------------------------------------------------
  const [pins, setPins] = useState<Pin[]>(() => storage.getJson<Pin[]>(keys.pins(thread.id), []));
  const [selection, setSelection] = useState<{ messageId: string; start: number; end: number; rect: DOMRect } | null>(
    null,
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const container = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>(
        '[data-message-id]',
      );
      const message = container ? byId.get(container.dataset.messageId ?? '') : undefined;
      if (!container || !message || !isTerminal(message.status)) {
        setSelection(null);
        return;
      }
      const range = selectionToSource(container, message.content);
      setSelection(range ? { messageId: message.id, ...range, rect: sel.getRangeAt(0).getBoundingClientRect() } : null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [byId]);

  const pin = () => {
    if (!selection) return;
    const message = byId.get(selection.messageId);
    if (!message) return;
    const anchor = createAnchor(message.revisionId, message.content, selection.start, selection.end);
    const next = [...pins, { anchor, messageId: message.id, pinnedAt: new Date().toISOString() }];
    setPins(next);
    storage.setJson(keys.pins(thread.id), next);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const show = (p: Pin) => {
    const message = byId.get(p.messageId);
    const container = document.querySelector(`[data-message-id="${p.messageId}"]`);
    if (!message || !container) return;
    const r = resolveAnchor(p.anchor, message.content);
    if (r.status === 'unresolved') {
      setNotice(`That passage could not be found (${r.reason}).`);
      return;
    }
    const range = sourceToRange(container, message.content, r.start, r.end);
    highlight('noema-pin', range);
    (range?.startContainer.parentElement ?? container).scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const unpin = (i: number) => {
    const next = pins.filter((_, j) => j !== i);
    setPins(next);
    storage.setJson(keys.pins(thread.id), next);
    highlight('noema-pin', null);
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="wordmark">Noema</span>
          <span className="notebook-title">{notebook.title}</span>
        </div>
        <span className={`model ${health.model ? '' : 'model-missing'}`} title={`provider: ${health.provider}`}>
          {health.model ?? 'no model configured'}
        </span>
      </header>

      <main className="thread" aria-busy={!loaded}>
        {loaded && messages.length === 0 && (
          <div className="empty">
            <p className="empty-title">Ask anything you are studying.</p>
            <p>Answers keep streaming even if you close the tab. Select a passage in an answer to pin it.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} onStop={() => void stop(m.id)} />
        ))}
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

      <Composer threadId={thread.id} busy={Boolean(live)} onSend={send} onStop={() => live && void stop(live.id)} />

      <aside className="pins" aria-label="Pinned passages (anchor spike)">
        <h2>Pinned passages</h2>
        <p className="pins-hint">M0 spike: select text in a message, pin it, then show it again.</p>
        {pins.length === 0 && <p className="pins-empty">Nothing pinned yet.</p>}
        <ol>
          {pins.map((p, i) => {
            const message = byId.get(p.messageId);
            const status = message ? resolveAnchor(p.anchor, message.content).status : 'unresolved';
            return (
              <li
                key={`${p.anchor.targetId}:${p.anchor.position.start}:${p.pinnedAt}`}
                data-testid="pinned"
                data-exact={p.anchor.quote.exact}
                data-start={p.anchor.position.start}
                data-end={p.anchor.position.end}
                data-status={status}
              >
                <blockquote>{p.anchor.quote.exact}</blockquote>
                <div className="pin-meta">
                  <span>
                    {p.anchor.position.start}–{p.anchor.position.end} · {status}
                  </span>
                  <button type="button" onClick={() => show(p)} data-testid="show-pin">
                    Show
                  </button>
                  <button type="button" className="quiet" onClick={() => unpin(i)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </aside>

      {selection && (
        <button
          type="button"
          className="pin-button"
          data-testid="pin"
          style={{ top: Math.max(8, selection.rect.top - 44), left: selection.rect.left + selection.rect.width / 2 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={pin}
        >
          Pin passage
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MessageView({ message, onStop }: { message: Message; onStop: () => void }) {
  const { role, status } = message;
  return (
    <article className={`message message-${role}`} data-testid="message" data-role={role} data-status={status}>
      <div className="message-body" data-message-id={message.id}>
        {role === 'assistant' ? (
          <Markdown source={message.content} />
        ) : (
          <p className="user-text">
            <span data-s={0} data-e={message.content.length}>
              {message.content}
            </span>
          </p>
        )}
        {role === 'assistant' && status === 'pending' && <span className="thinking">Thinking…</span>}
        {role === 'assistant' && status === 'streaming' && <span className="caret" aria-hidden />}
      </div>
      <MessageStatusLine message={message} onStop={onStop} />
    </article>
  );
}

function MessageStatusLine({ message, onStop }: { message: Message; onStop: () => void }) {
  const { role, status, error } = message;
  if (role === 'user') {
    if (status === 'pending') return <div className="status">Sending…</div>;
    if (status === 'failed') return <div className="status status-bad">Not sent yet.</div>;
    return null;
  }
  switch (status) {
    case 'pending':
    case 'streaming':
      return (
        <div className="status">
          <button type="button" className="quiet" onClick={onStop} data-testid="stop">
            Stop
          </button>
        </div>
      );
    case 'stopped':
      return <div className="status">Stopped. The text above is kept.</div>;
    case 'interrupted':
      return <div className="status status-warn">Interrupted: the server stopped before this answer finished.</div>;
    case 'failed':
      return (
        <div className="status status-bad" role="alert">
          {error?.message ?? 'The answer failed.'}
        </div>
      );
    default:
      return null;
  }
}

function Composer({
  threadId,
  busy,
  onSend,
  onStop,
}: {
  threadId: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState(() => storage.get(keys.draft(threadId)) ?? '');

  useEffect(() => {
    const t = setTimeout(() => {
      if (text) storage.set(keys.draft(threadId), text);
      else storage.remove(keys.draft(threadId));
    }, 150);
    return () => clearTimeout(t);
  }, [text, threadId]);

  const submit = () => {
    const content = text.trim();
    if (!content || busy) return;
    onSend(content);
    setText('');
    storage.remove(keys.draft(threadId));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; never send while an IME is composing (Chinese, Japanese input).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        data-testid="composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask a question…"
        rows={2}
        aria-label="Your question"
      />
      {busy ? (
        <button type="button" onClick={onStop} data-testid="stop-composer">
          Stop
        </button>
      ) : (
        <button type="submit" disabled={!text.trim()} data-testid="send">
          Ask
        </button>
      )}
    </form>
  );
}
