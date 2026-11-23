// The Assistant (ADRs 0023, 0024, 0028): one assistant for the whole notebook,
// floating over whatever is open (folded to a bar, or open on the
// conversation), pinned beside it, or on a page of its own. It knows where
// the learner is and what they selected; it looks things up as it answers;
// what it cites becomes cards that open a preview of the very words (one card
// a thing, the first few shown). It makes changes itself, each with Open and
// Undo, and Undo all (ADR 0033); asked to ask first, they wait for Do it.

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
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiFailure, api, watchMessage } from './api.ts';
import { asksFor } from './assistantFloat.ts';
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
  layout = 'pinned',
  folded = false,
  onFold,
  onPin,
  onFloat,
  onGrab,
  asksFirst = false,
  onAsksFirst,
}: {
  threadId: string;
  /** With what is open (floating or pinned beside it), or a page of its own. */
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
  /** As a panel: floating over what is open, or pinned beside it. */
  layout?: 'float' | 'pinned';
  /** Floating, folded to a bar: the conversation is out of sight. */
  folded?: boolean;
  onFold?: (folded: boolean) => void;
  onPin?: () => void;
  onFloat?: () => void;
  /** Floating: a pointer pressed on its header, to move it. */
  onGrab?: (e: ReactPointerEvent<HTMLElement>) => void;
  /** It proposes changes for Do it, instead of making them itself (ADR 0033); and how to switch. */
  asksFirst?: boolean;
  onAsksFirst?: (asks: boolean) => void;
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
  // Changes it makes as it answers (ADR 0033): what is open is drawn again, once for a burst of them.
  const acted = useRef(onActed);
  acted.current = onActed;
  const actedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actedSoon = useCallback(() => {
    clearTimeout(actedTimer.current);
    actedTimer.current = setTimeout(() => acted.current(), 300);
  }, []);
  useEffect(() => () => clearTimeout(actedTimer.current), []);

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
          if (action.status === 'done' && action.kind !== 'show') actedSoon();
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
    [threadId, hold, upsertAction, actedSoon],
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
  }, [lastLength]);

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
      // Folded to a bar: asking opens it on the conversation.
      if (folded) onFold?.(false);
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

  /** Do all the changes of an answer that wait, or Undo all it made (ADR 0033). */
  const actAll = async (messageId: string, what: 'run' | 'undo') => {
    try {
      const r = what === 'run' ? await api.runAllActions(messageId) : await api.undoAllActions(messageId);
      for (const a of r.actions) upsertAction(a);
      onActed();
      const kept = 'kept' in r ? Number(r.kept) : 0;
      setNotice(kept > 0 ? `${kept === 1 ? 'One change' : `${kept} changes`} could not be undone any more: what it changed was changed again since.` : null);
    } catch (err) {
      setNotice(err instanceof ApiFailure ? err.message : 'It could not be done.');
    }
  };

  const openTarget = (t: VaultTarget) => {
    setPreview(null);
    onOpenTarget(t);
  };

  const asks = asksFor(mode === 'panel' && where ? where.place.kind : null, Boolean(where && selection));
  const floating = mode === 'panel' && layout === 'float';
  const lastAsked = [...messages].reverse().find((m) => m.role === 'user');
  const doing = !live ? null : looked || livePhase === 'looking' ? 'Looking things up…' : live.status === 'streaming' ? 'Writing…' : 'Thinking…';
  return (
    <section
      className={`assistant assistant-${mode}${floating && folded ? ' is-folded' : ''}`}
      data-testid={`assistant-${mode}`}
      aria-label="Assistant"
    >
      <header
        className={`assistant-bar${floating ? ' is-handle' : ''}`}
        data-testid="assistant-head"
        onPointerDown={floating ? onGrab : undefined}
        title={floating ? 'Drag to move' : undefined}
      >
        <Orb size={mode === 'page' ? 'normal' : 'small'} />
        <div className="assistant-name">
          <h1>Assistant</h1>
          {mode === 'page' && <p>One assistant for your whole notebook. It looks things up, and shows where it found them.</p>}
          {floating && doing && folded && (
            <p className="assistant-doing" data-testid="assistant-doing">
              {doing}
            </p>
          )}
        </div>
        <div className="assistant-bar-actions">
          {onAsksFirst && (
            <button
              type="button"
              className={`quiet assistant-acts${asksFirst ? '' : ' is-on'}`}
              onClick={() => onAsksFirst(!asksFirst)}
              aria-pressed={!asksFirst}
              title={
                asksFirst
                  ? 'It proposes changes and waits for your Do it. Click to let it make them itself, each with Undo.'
                  : 'It makes the changes you ask for itself, in as many steps as it takes, each with Undo. Click to have it ask first.'
              }
              data-testid="assistant-acts"
            >
              {asksFirst ? 'Asks first' : 'Acts itself'}
            </button>
          )}
          {floating && onFold && (
            <button
              type="button"
              className="quiet"
              onClick={() => onFold(!folded)}
              title={folded ? 'Open the conversation' : 'Fold to a bar'}
              aria-label={folded ? 'Open the conversation' : 'Fold to a bar'}
              aria-expanded={!folded}
              data-testid="assistant-fold"
            >
              {folded ? '⌃' : '⌄'}
            </button>
          )}
          {floating && onPin && (
            <button type="button" className="quiet" onClick={onPin} title="Pin beside what is open" aria-label="Pin beside what is open" data-testid="assistant-pin">
              ⇥
            </button>
          )}
          {mode === 'panel' && layout === 'pinned' && onFloat && (
            <button type="button" className="quiet" onClick={onFloat} title="Float over what is open" aria-label="Float over what is open" data-testid="assistant-float">
              ⧉
            </button>
          )}
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
        {loaded && messages.length === 0 && !(floating && folded) && (
          <div className="assistant-hello" data-testid="assistant-hello">
            <Orb size={mode === 'page' ? 'large' : 'normal'} />
            <h2>{where ? `Ask about ${where.title ? `“${where.title}”` : 'what is open'}, or anything else.` : 'Ask about anything you have read, asked or written.'}</h2>
            <p>
              It looks through your threads, sources and notes before it answers, and shows where it found things. It can
              take you there, and {asksFirst ? 'propose changes you confirm' : 'make the changes you ask for, each with Undo'}.
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
              <ActionCards
                actions={actions.filter((a) => a.messageId === m.id)}
                onAct={act}
                onAll={(what) => void actAll(m.id, what)}
                onOpen={openTarget}
              />
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
      {floating && folded && (
        <div className="assistant-glance" data-testid="assistant-glance">
          {lastAsked && (
            <button type="button" className="assistant-last" onClick={() => onFold?.(false)} data-testid="assistant-last">
              <span className="assistant-last-label">{doing ?? 'Last asked'}</span>
              <span className="assistant-last-q">“{lastAsked.content.length > 90 ? `${lastAsked.content.slice(0, 90)}…` : lastAsked.content}”</span>
              <span className="assistant-last-show" aria-hidden>
                ⌃
              </span>
            </button>
          )}
          <div className="assistant-asks is-bar">
            {asks.map((q) => (
              <button key={q} type="button" onClick={() => void send(q)} data-testid="assistant-ask">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="assistant-compose">
        {where && (
          <p className="assistant-where" data-testid="assistant-where">
            <span className="assistant-where-glyph" aria-hidden>
              {where.place.kind === 'room' ? '⌂' : GLYPH[where.place.kind]}
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
          placeholder={
            selection
              ? 'Ask about what you selected…'
              : floating && where?.title
                ? `Ask about “${where.title.length > 40 ? `${where.title.slice(0, 40)}…` : where.title}”, or anything…`
                : 'Ask, or tell it what to do…'
          }
          onSend={send}
          onStop={() => live && void api.stop(live.id).catch(() => {})}
          onDraft={onDraft}
        />
      </div>
    </section>
  );
}

/** One thread, source or note, however many of its places an answer cites. */
function thingOf(t: VaultTarget): string {
  return t.kind === 'thread' ? `t:${t.threadId}` : t.kind === 'source' ? `s:${t.sourceId}` : `n:${t.noteId}`;
}

/** At most this many cards under an answer until the learner asks for more (ADR 0033). */
const MENTIONS_SHOWN = 3;

/**
 * What an answer cited, as cards: open a preview of the words, or go there. One card a thing, whichever of its places
 * were cited (ADR 0033); the first few, and the rest on asking.
 */
function Mentioned({
  message,
  onPreview,
  onOpen,
}: {
  message: Message;
  onPreview: (t: VaultTarget) => void;
  onOpen: (t: VaultTarget) => void;
}) {
  const [all, setAll] = useState(false);
  const refs = message.lookups?.refs ?? {};
  const groups: Array<{ key: string; labels: string[]; targets: VaultTarget[] }> = [];
  for (const label of citedLabels(message.content, (l) => l in refs)) {
    const t = refs[label] as VaultTarget;
    const g = groups.find((x) => x.key === thingOf(t));
    if (g) {
      g.labels.push(label);
      g.targets.push(t);
    } else groups.push({ key: thingOf(t), labels: [label], targets: [t] });
  }
  if (groups.length === 0) return null;
  const shown = all ? groups : groups.slice(0, MENTIONS_SHOWN);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a labelled group of mentions
    <div
      className="mentioned"
      data-testid="mentioned"
      aria-label="From your notebook"
    >
      {shown.map(({ key, labels, targets }) => {
        // The words shown: a quote of it if the answer has one, else the first place cited.
        const t = targets.find((x) => x.quote) ?? (targets[0] as VaultTarget);
        const words = t.quote ?? firstWords(t.excerpt ?? '');
        const label = labels.join(' ');
        return (
          <div key={key} className={`mention mention-${t.kind}`} data-testid="mention" data-kind={t.kind}>
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
      {groups.length > MENTIONS_SHOWN && (
        <button type="button" className="quiet mention-more" onClick={() => setAll((a) => !a)} aria-expanded={all} data-testid="mention-more">
          {all ? 'Show fewer' : `${groups.length - MENTIONS_SHOWN} more from your notebook`}
        </button>
      )}
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
  take_out_of_room: '⌂',
  link: '⟷',
  rename_room: '⌂',
  delete_room: '⌂',
  merge_rooms: '⌂',
  put_room_in: '⌂',
  take_room_out: '⌂',
  change_link: '⟷',
  unlink: '⟷',
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

/** More changes than this, and the list folds to those that need the learner (ADR 0033). */
const ACTIONS_SHOWN = 4;

/**
 * The changes of an answer (ADR 0033): those it made, with Open and Undo, and Undo all; those waiting for the
 * learner, with Do it or Cancel, and Do all. A long list folds to what needs the learner.
 */
function ActionCards({
  actions,
  onAct,
  onAll,
  onOpen,
}: {
  actions: AssistantAction[];
  onAct: (a: AssistantAction, what: 'run' | 'cancel' | 'undo') => void;
  onAll: (what: 'run' | 'undo') => void;
  onOpen: (t: VaultTarget) => void;
}) {
  const [all, setAll] = useState(false);
  if (actions.length === 0) return null;
  const changes = actions.filter((a) => a.kind !== 'show');
  const done = changes.filter((a) => a.status === 'done').length;
  const waiting = changes.filter((a) => a.status === 'proposed').length;
  const undoable = changes.filter((a) => a.undoable).length;
  const folds = actions.length > ACTIONS_SHOWN && !all;
  const needs = (a: AssistantAction) => a.status === 'proposed' || a.status === 'running' || a.status === 'failed';
  const shown = folds ? actions.filter(needs) : actions;
  const said = [
    ...(done ? [`Did ${done === 1 ? 'one thing' : `${done} things`}`] : []),
    ...(waiting ? [`${waiting === 1 ? 'one waits' : `${waiting} wait`} for you`] : []),
  ].join(' · ');
  return (
    <div className="action-group" data-testid="action-group">
      {(changes.length > 1 || folds) && (
        <div className="action-head" data-testid="action-head">
          <span className="action-head-said">{said || `${changes.length} changes`}</span>
          {waiting > 1 && (
            <button type="button" onClick={() => onAll('run')} data-testid="action-run-all">
              Do all
            </button>
          )}
          {undoable > 1 && (
            <button type="button" className="quiet" onClick={() => onAll('undo')} data-testid="action-undo-all">
              Undo all
            </button>
          )}
          {actions.length > ACTIONS_SHOWN && (
            <button type="button" className="quiet" onClick={() => setAll((x) => !x)} aria-expanded={all} data-testid="action-show-all">
              {all ? 'Fold' : 'Show each'}
            </button>
          )}
        </div>
      )}
      {shown.length > 0 && (
    <ul className="action-cards" aria-label="What it changed">
      {shown.map((a) => (
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
      )}
    </div>
  );
}
