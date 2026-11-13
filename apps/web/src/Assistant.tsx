// The Assistant (ADRs 0023, 0024): one assistant for the whole notebook,
// beside whatever is open (the panel) or on a page of its own. It knows where
// the learner is and what they selected; it looks things up as it answers;
// what it cites becomes cards that open a preview of the very words, and the
// changes it proposes wait here for Do it, with Open and Undo after.

import {
  type AssistantAction,
  type AssistantPhase,
  type AssistantPlace,
  citedLabels,
  isLive,
  isTerminal,
  type LookupStep,
  type Message,
  type MessageError,
  type MessageStatus,
  ulid,
  type VaultTarget,
} from '@noema/core';
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiFailure, api, watchMessage } from './api.ts';
import { Composer } from './Composer.tsx';
import { Orb } from './LivingFrame.tsx';
import { MessageView } from './MessageView.tsx';
import { getPresence, type Presence, presenceOf, pulse, setPresence } from './presence.ts';
import { keys } from './storage.ts';

/** Where the learner is, as the panel shows it: what is open (with its title) and what they selected. */
export interface AssistantWhere {
  place: AssistantPlace;
  title: string;
}

type Action =
  | { type: 'reset'; messages: Message[] }
  | { type: 'upsert'; message: Message }
  | { type: 'append'; id: string; text: string }
  | { type: 'status'; id: string; status: MessageStatus; error: MessageError | null }
  | { type: 'step'; id: string; step: LookupStep };

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
    case 'step':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, lookups: { steps: [...(m.lookups?.steps ?? []), action.step], refs: m.lookups?.refs ?? {} } }
          : m,
      );
  }
}

/** How long the frame shows a lookup just made: a lookup takes milliseconds, too quick to see. */
const LOOKED_MS = 1100;

const FIRST_ASKS = [
  'Where did I leave off?',
  'What have I asked about the most?',
  'Which side questions did I never come back to?',
  'What did my sources say that my threads never asked about?',
];
const HERE_ASKS = ['Explain what I selected', 'What have I asked about this before?', 'Make a note of this'];

const GLYPH: Record<VaultTarget['kind'], string> = { thread: '◇', source: '❡', note: '▤' };
const KIND_NAME: Record<VaultTarget['kind'], string> = { thread: 'Thread', source: 'Source', note: 'Note' };

export function AssistantChat({
  threadId,
  mode,
  where,
  selection,
  onClearSelection,
  onOpenTarget,
  onShowContext,
  onChanged,
  onActed,
  onOpenSettings,
  onExpand,
  onClose,
}: {
  threadId: string;
  /** Beside what is open, or a page of its own. */
  mode: 'panel' | 'page';
  /** What is open, sent with each question. */
  where: AssistantWhere | null;
  /** Text the learner selected in what is open. */
  selection: string | null;
  onClearSelection: () => void;
  onOpenTarget: (target: VaultTarget) => void;
  onShowContext: (messageId: string) => void;
  /** An answer ended: lists may have changed (titles). */
  onChanged: () => void;
  /** A change was done or undone: what is open may show it. */
  onActed: () => void;
  onOpenSettings: () => void;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const [messages, dispatch] = useReducer(reducer, []);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actions, setActions] = useState<AssistantAction[]>([]);
  const [phases, setPhases] = useState<Record<string, AssistantPhase>>({});
  const [typing, setTyping] = useState(false);
  const [looked, setLooked] = useState(false);
  const [preview, setPreview] = useState<VaultTarget | null>(null);
  const lookedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watchers = useRef(new Map<string, () => void>());
  const shown = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opener = useRef(onOpenTarget);
  opener.current = onOpenTarget;
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const hold = useCallback(() => {
    setLooked(true);
    clearTimeout(lookedTimer.current);
    lookedTimer.current = setTimeout(() => setLooked(false), LOOKED_MS);
  }, []);
  useEffect(() => () => clearTimeout(lookedTimer.current), []);

  // In the order proposed; a change of state keeps its place.
  const upsertAction = useCallback((a: AssistantAction) => {
    setActions((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]));
  }, []);

  const watch = useCallback(
    (id: string) => {
      if (watchers.current.has(id)) return;
      const phaseOf = (phase: AssistantPhase | undefined) =>
        setPhases((p) => {
          if (!phase) {
            const { [id]: _gone, ...rest } = p;
            return rest;
          }
          return p[id] === phase ? p : { ...p, [id]: phase };
        });
      const close = watchMessage(id, {
        snapshot: (m, phase) => {
          dispatch({ type: 'upsert', message: m });
          if (phase) phaseOf(phase);
          if (phase === 'looking' || (phase === 'thinking' && (m.lookups?.steps.length ?? 0) > 0)) hold();
        },
        delta: (text) => {
          dispatch({ type: 'append', id, text });
          pulse(Math.min(0.5, 0.12 + text.length / 60));
        },
        status: (status, error) => dispatch({ type: 'status', id, status, error }),
        phase: (phase) => {
          phaseOf(phase);
          if (phase === 'looking') pulse(0.6);
        },
        step: (step) => {
          dispatch({ type: 'step', id, step });
          pulse(0.8);
          hold();
        },
        action: (action) => {
          upsertAction(action);
          // It takes the learner somewhere: once, as it happens.
          if (action.kind === 'show' && action.open && !shown.current.has(action.id)) {
            shown.current.add(action.id);
            opener.current(action.open);
          }
        },
        end: () => {
          watchers.current.delete(id);
          phaseOf(undefined);
          // The answer as kept: citations in one form, with their quotes; the changes it proposed.
          api.thread(threadId).then(
            (d) => {
              const done = d.messages.find((m) => m.id === id);
              if (done) dispatch({ type: 'upsert', message: done });
            },
            () => {},
          );
          api.assistantActions(threadId).then((r) => setActions(r.actions), () => {});
          changed.current();
        },
      });
      watchers.current.set(id, close);
    },
    [threadId, hold, upsertAction],
  );

  useEffect(() => {
    let cancelled = false;
    const open = watchers.current;
    (async () => {
      try {
        const [detail, acts] = await Promise.all([api.thread(threadId), api.assistantActions(threadId)]);
        if (cancelled) return;
        dispatch({ type: 'reset', messages: detail.messages });
        setActions(acts.actions);
        // Shows already done are not done again on reopening.
        for (const a of acts.actions) if (a.kind === 'show') shown.current.add(a.id);
        setLoaded(true);
        for (const m of detail.messages) if (isLive(m.status)) watch(m.id);
      } catch (err) {
        if (!cancelled) setNotice(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      for (const close of open.values()) close();
      open.clear();
    };
  }, [threadId, watch]);

  // The frame shows what it is doing.
  const live = messages.find((m) => m.role === 'assistant' && isLive(m.status));
  const livePhase = live ? (phases[live.id] ?? null) : null;
  const wasLive = useRef<string | null>(null);
  useEffect(() => {
    let next: Presence;
    if (live) {
      wasLive.current = live.id;
      next = looked ? 'looking' : presenceOf(live.status, livePhase);
    } else if (wasLive.current) {
      const ended = messages.find((m) => m.id === wasLive.current);
      wasLive.current = null;
      next = ended?.status === 'done' ? 'done' : 'idle';
    } else {
      if (getPresence() === 'done' && !typing) return;
      next = typing ? 'listening' : 'idle';
    }
    setPresence(next);
  }, [live, livePhase, looked, typing, messages]);
  useEffect(() => () => setPresence('off'), []);

  // Follow the answer as it grows, unless the learner scrolled up to read.
  const lastLength = messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && lastLength >= 0) el.scrollTop = el.scrollHeight;
  }, [lastLength, actions.length]);

  const drafted = useRef('');
  const onDraft = useCallback((text: string) => {
    if (text.length > drafted.current.length) pulse(0.08);
    drafted.current = text;
    setTyping(text.trim() !== '');
  }, []);

  const send = async (content: string): Promise<boolean> => {
    const id = ulid();
    const place = where ? { ...where.place, ...(selection ? { selection: selection.slice(0, 4000) } : {}) } : undefined;
    setTyping(false);
    stick.current = true;
    try {
      const r = await api.ask(threadId, id, content, place);
      dispatch({ type: 'upsert', message: r.user });
      dispatch({ type: 'upsert', message: r.assistant });
      setNotice(null);
      onClearSelection();
      if (!isTerminal(r.assistant.status)) watch(r.assistant.id);
      return true;
    } catch (err) {
      setNotice(err instanceof ApiFailure ? err.message : 'Could not send the question.');
      return false;
    }
  };

  const act = async (a: AssistantAction, what: 'run' | 'cancel' | 'undo') => {
    upsertAction({ ...a, status: what === 'run' ? 'running' : a.status });
    try {
      const r = await api.actOn(a.id, what);
      upsertAction(r.action);
      if (what !== 'cancel') onActed();
    } catch (err) {
      upsertAction({ ...a, error: err instanceof ApiFailure ? err.message : 'It could not be done.' });
    }
  };

  const openTarget = (t: VaultTarget) => {
    setPreview(null);
    onOpenTarget(t);
  };

  const asks = where && selection ? HERE_ASKS : FIRST_ASKS;
  return (
    <section className={`assistant assistant-${mode}`} data-testid={`assistant-${mode}`} aria-label="Assistant">
      <header className="assistant-bar" data-testid="assistant-head">
        <Orb size={mode === 'page' ? 'normal' : 'small'} />
        <div className="assistant-name">
          <h1>Assistant</h1>
          {mode === 'page' && <p>One assistant for your whole notebook. It looks things up, and shows where it found them.</p>}
        </div>
        <div className="assistant-bar-actions">
          {onExpand && (
            <button type="button" className="quiet" onClick={onExpand} title="Open the Assistant on a page of its own" data-testid="assistant-expand">
              ⤢
            </button>
          )}
          {onClose && (
            <button type="button" className="quiet" onClick={onClose} title="Close the Assistant (⌘J)" aria-label="Close" data-testid="assistant-close">
              ×
            </button>
          )}
        </div>
      </header>
      <div
        className="assistant-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        }}
      >
        {loaded && messages.length === 0 && (
          <div className="assistant-hello" data-testid="assistant-hello">
            <Orb size={mode === 'page' ? 'large' : 'normal'} />
            <h2>{where ? `Ask about ${where.title ? `“${where.title}”` : 'what is open'}, or anything else.` : 'Ask about anything you have read, asked or written.'}</h2>
            <p>
              It looks through your threads, sources and notes before it answers, and shows where it found things. It can
              take you there, and propose changes you confirm.
            </p>
            <div className="assistant-asks">
              {asks.map((q) => (
                <button key={q} type="button" onClick={() => void send(q)} data-testid="assistant-ask">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="assistant-q" data-testid="message" data-role="user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="assistant-a">
              <MessageView
                message={m}
                branches={[]}
                onStop={() => void api.stop(m.id).catch(() => {})}
                onOpenSettings={onOpenSettings}
                onOpenBranch={() => {}}
                onShowContext={m.status === 'pending' ? undefined : () => onShowContext(m.id)}
                onOpenTarget={(t) => setPreview(t)}
                phase={isLive(m.status) ? (looked && m.status === 'pending' ? 'looking' : (phases[m.id] ?? null)) : undefined}
              />
              {m.status !== 'pending' && m.status !== 'streaming' && <Mentioned message={m} onPreview={setPreview} onOpen={openTarget} />}
              <ActionCards actions={actions.filter((a) => a.messageId === m.id)} onAct={act} onOpen={openTarget} />
            </div>
          ),
        )}
        {notice && (
          <p className="assistant-notice" role="status">
            {notice}
          </p>
        )}
      </div>
      {preview && <QuotePreview target={preview} onOpen={() => openTarget(preview)} onClose={() => setPreview(null)} />}
      <div className="assistant-compose">
        {where && (
          <p className="assistant-where" data-testid="assistant-where">
            <span className="assistant-where-glyph" aria-hidden>
              {GLYPH[where.place.kind]}
            </span>
            <span className="assistant-where-text">
              {where.title ? `“${where.title}”` : `This ${where.place.kind}`}
              {selection && (
                <>
                  {' · '}
                  <span className="assistant-where-sel" data-testid="assistant-selection">
                    “{selection.length > 60 ? `${selection.slice(0, 60)}…` : selection}”
                  </span>
                  <button type="button" className="quiet inline" onClick={onClearSelection} aria-label="Leave out the selection">
                    ×
                  </button>
                </>
              )}
            </span>
          </p>
        )}
        <Composer
          key={threadId}
          draftKey={keys.draft(threadId)}
          busy={Boolean(live)}
          autoFocus={mode === 'panel'}
          placeholder={selection ? 'Ask about what you selected…' : 'Ask, or tell it what to do…'}
          onSend={send}
          onStop={() => live && void api.stop(live.id).catch(() => {})}
          onDraft={onDraft}
        />
      </div>
    </section>
  );
}

/** What an answer cited, as cards: open a preview of the words, or go there. */
function Mentioned({
  message,
  onPreview,
  onOpen,
}: {
  message: Message;
  onPreview: (t: VaultTarget) => void;
  onOpen: (t: VaultTarget) => void;
}) {
  const refs = message.lookups?.refs ?? {};
  const labels = citedLabels(message.content, (l) => l in refs);
  if (labels.length === 0) return null;
  return (
    <div className="mentioned" data-testid="mentioned" aria-label="From your notebook">
      {labels.map((label) => {
        const t = refs[label] as VaultTarget;
        const words = t.quote ?? firstWords(t.excerpt ?? '');
        return (
          <div key={label} className={`mention mention-${t.kind}`} data-testid="mention" data-kind={t.kind}>
            <button type="button" className="mention-main" onClick={() => onPreview(t)} title="Preview it here">
              <span className="mention-top">
                <span className="mention-label">{label}</span>
                <span aria-hidden>{GLYPH[t.kind]}</span>
                <span className="mention-kind">{KIND_NAME[t.kind]}</span>
                <span className="mention-title">{t.title || 'Untitled'}</span>
              </span>
              {words && <span className={`mention-words${t.quote ? ' is-quote' : ''}`}>{t.quote ? `“${words}”` : words}</span>}
            </button>
            <button type="button" className="mention-open quiet" onClick={() => onOpen(t)} data-testid="mention-open" title="Go there">
              Open →
            </button>
          </div>
        );
      })}
    </div>
  );
}

function firstWords(text: string): string {
  const plain = text.replace(/^…\s*/, '').replace(/[#*_>`$]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
}

/** The very words it quoted, in the text around them, before going there. */
function QuotePreview({ target, onOpen, onClose }: { target: VaultTarget; onOpen: () => void; onClose: () => void }) {
  const text = target.excerpt ?? '';
  const at = target.quote ? text.indexOf(target.quote) : -1;
  let body: ReactNode = text;
  if (at >= 0 && target.quote) {
    body = (
      <>
        {text.slice(0, at)}
        <mark data-testid="preview-quote">{target.quote}</mark>
        {text.slice(at + target.quote.length)}
      </>
    );
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="quote-preview" role="dialog" aria-label="Preview" data-testid="quote-preview">
      <div className="quote-preview-head">
        <span aria-hidden>{GLYPH[target.kind]}</span>
        <span className="mention-kind">{KIND_NAME[target.kind]}</span>
        <strong>{target.title || 'Untitled'}</strong>
        <button type="button" className="quiet" onClick={onClose} aria-label="Close the preview">
          ×
        </button>
      </div>
      <div className="quote-preview-text">{body || <em>Nothing to preview: open it to see.</em>}</div>
      <div className="quote-preview-foot">
        <button type="button" onClick={onOpen} data-testid="preview-open">
          Open there →
        </button>
      </div>
    </div>
  );
}

const ACTION_GLYPH: Record<AssistantAction['kind'], string> = {
  show: '→',
  start_thread: '＋',
  ask_in_thread: '?',
  ask_about_passage: '↳',
  create_note: '▤',
  add_to_note: '▤',
  change_note_block: '✎',
  note_from_thread: '▤',
  rename: '✎',
  pin: '📌',
  unpin: '📌',
  merge_threads: '⤶',
  move_to_trash: '🗑',
  restore: '↺',
  add_source: '❡',
  put_in_room: '⌂',
  write_file: '⌸',
  edit_file: '✎',
  save_note_to_file: '⇣',
  note_from_file: '▤',
};

/** What a change to a file does, as lines: taken out (−) and put in (+), or the new text. */
function ActionDetail({ kind, detail }: { kind: AssistantAction['kind']; detail: string }) {
  const lines = detail.split('\n');
  const diff = kind === 'edit_file';
  return (
    <details className="action-detail" open={lines.length <= 14} data-testid="action-detail">
      <summary>{diff ? 'The change' : 'The text'}</summary>
      <pre>
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed text
          <span key={i} className={`line${diff ? (l.startsWith('- ') ? ' del' : l.startsWith('+ ') ? ' ins' : '') : ''}`}>
            {l || ' '}
          </span>
        ))}
      </pre>
    </details>
  );
}

/** The changes an answer proposed: Do it or Cancel; then Open and Undo. */
function ActionCards({
  actions,
  onAct,
  onOpen,
}: {
  actions: AssistantAction[];
  onAct: (a: AssistantAction, what: 'run' | 'cancel' | 'undo') => void;
  onOpen: (t: VaultTarget) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <ul className="action-cards" aria-label="What it proposes">
      {actions.map((a) => (
        <li key={a.id} className={`action-card is-${a.status}`} data-testid="action-card" data-kind={a.kind} data-status={a.status}>
          <span className="action-glyph" aria-hidden>
            {ACTION_GLYPH[a.kind]}
          </span>
          <span className="action-summary">{a.summary}</span>
          <span className="action-buttons">
            {a.status === 'proposed' && (
              <>
                <button type="button" onClick={() => onAct(a, 'run')} data-testid="action-run">
                  Do it
                </button>
                <button type="button" className="quiet" onClick={() => onAct(a, 'cancel')} data-testid="action-cancel">
                  Cancel
                </button>
              </>
            )}
            {a.status === 'running' && <span className="action-state">Doing it…</span>}
            {a.status === 'done' && a.kind !== 'show' && <span className="action-state">Done</span>}
            {a.status === 'cancelled' && <span className="action-state">Cancelled</span>}
            {a.status === 'undone' && <span className="action-state">Undone</span>}
            {(a.status === 'done' || a.kind === 'show') && a.open && (
              <button type="button" className="quiet" onClick={() => a.open && onOpen(a.open)} data-testid="action-open">
                Open →
              </button>
            )}
            {a.undoable && (
              <button type="button" className="quiet" onClick={() => onAct(a, 'undo')} data-testid="action-undo">
                Undo
              </button>
            )}
            {a.status === 'failed' && (
              <button type="button" className="quiet" onClick={() => onAct(a, 'run')} data-testid="action-retry">
                Try again
              </button>
            )}
          </span>
          {a.detail && a.status === 'proposed' && <ActionDetail kind={a.kind} detail={a.detail} />}
          {a.error && (a.status === 'failed' || a.status === 'done') && (
            <span className="action-error" role="alert">
              {a.error}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
