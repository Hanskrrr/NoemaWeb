// One thread or branch: its messages, the composer, select-to-branch, the
// origin card with Back, and the marks where branches left.

import {
  type AskedHit,
  type BranchSummary,
  type Continuation,
  type ContinuedFrom,
  createAnchor,
  isLive,
  isTerminal,
  type Merge,
  type Message,
  type MessageError,
  type MessageRevision,
  type MessageStatus,
  type NoteSummary,
  type Origin,
  type Pin,
  readableQuote,
  resolveAnchor,
  type SourceOrigin,
  type Thread,
  ulid,
} from '@noema/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiFailure, api, watchMessage } from './api.ts';
import { AskedBefore, type AskedPlace } from './AskedBefore.tsx';
import { arrive, clearFound } from './found.ts';
import { Composer } from './Composer.tsx';
import { EditableTitle } from './EditableTitle.tsx';
import { MergeCard, MergePicker, OPEN_MERGE_EVENT, OutgoingMerges } from './Merges.tsx';
import { MessageView } from './MessageView.tsx';
import { PINS_CHANGED_EVENT, PinnedList } from './Pinned.tsx';
import { Outline, type OutlineItem, scrollRangeIntoView, shortLabel } from './Outline.tsx';
import { highlight, selectionToSource, sourceToRange } from './markdown/selection.ts';
import { keys, storage } from './storage.ts';

/** A passage to scroll to and highlight when a thread opens (after cancelling a branch). */
export interface Focus {
  messageId: string;
  /** The revision the passage is in, when it was an earlier answer read again. */
  revisionId?: string | undefined;
  start: number;
  end: number;
}

/** A passage of a source being asked about, before its first question. The thread is created on the first send. */
export interface SourceDraft {
  sourceId: string;
  sourceTitle: string;
  versionId: string;
  start: number;
  end: number;
  exact: string;
  /** For a PDF: the pictures of its page(s) being kept on the server, to go to the model with the question. */
  pictures?: Promise<unknown>;
}

/** Wait for `p`, but no longer than `ms`. */
function atMost(p: Promise<unknown> | undefined, ms: number): Promise<unknown> {
  return p ? Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]) : Promise.resolve();
}

/** A branch that has a passage but no question yet. It is created on the first send. */
export interface BranchDraft {
  parentThreadId: string;
  parentTitle: string;
  messageId: string;
  /** The revision the passage is in (an earlier answer, read again, or the one in use). */
  revisionId?: string | undefined;
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
  | { type: 'status'; id: string; status: MessageStatus; error: MessageError | null }
  | { type: 'headlines'; messages: Message[] };

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
    case 'headlines': {
      const lines = new Map(action.messages.map((m) => [m.id, m.headline]));
      return state.map((m) => (lines.has(m.id) && lines.get(m.id) !== m.headline ? { ...m, headline: lines.get(m.id) ?? null } : m));
    }
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
    revisions: 1,
    content,
    status: 'pending',
    error: null,
    model: null,
    headline: null,
    createdAt: t,
    updatedAt: t,
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A message as one of its revisions: an earlier answer, read again. */
function asRevision(m: Message, v: MessageRevision): Message {
  return {
    ...m,
    revisionId: v.revisionId,
    revision: v.revision,
    content: v.content,
    status: v.status,
    error: v.error,
    model: v.model,
    headline: v.headline,
  };
}

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

function branchRange(b: BranchSummary, byId: Map<string, Message>): Range | null {
  return rangesFor([b], byId)[0] ?? null;
}

/** The catalog of a thread: each question, with the side questions and merges that start from it. */
function outlineOf(
  messages: Message[],
  branchesByMessage: Map<string, BranchSummary[]>,
  merges: Merge[],
  byId: Map<string, Message>,
): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const q of messages) {
    if (q.role !== 'user') continue;
    const answer = messages.find((a) => a.role === 'assistant' && a.replyTo === q.id);
    items.push({
      id: q.id,
      // What the exchange established, once the model has said; the question until then.
      label: shortLabel(answer?.headline ?? q.content),
      hint: answer?.headline ? `You asked: ${shortLabel(q.content, 200)}` : undefined,
      level: 1,
      kind: 'question',
      target: `[data-message-id="${q.id}"]`,
    });
    const here = [q.id, ...(answer ? [answer.id] : [])];
    for (const b of here.flatMap((id) => branchesByMessage.get(id) ?? [])) {
      items.push({
        id: `side:${b.threadId}`,
        label: `↳ ${b.title || 'Side question'}`,
        level: 2,
        kind: 'side',
        target: `[data-message-id="${b.anchor.messageId}"]`,
        go: () => scrollRangeIntoView(branchRange(b, byId)),
      });
    }
    for (const x of merges.filter((m) => m.afterMessageId !== null && here.includes(m.afterMessageId))) {
      items.push({
        id: `merge:${x.id}`,
        label: `⤶ ${x.sourceTitle || 'Merged'}`,
        level: 2,
        kind: 'merge',
        target: `[data-merge-id="${x.id}"]`,
        go: () => {
          window.dispatchEvent(new CustomEvent(OPEN_MERGE_EVENT, { detail: x.id }));
          requestAnimationFrame(() =>
            document.querySelector(`[data-merge-id="${x.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          );
        },
      });
    }
  }
  return items;
}

/** Where in an answer a merged side question's card goes: after the block holding its passage. */
function mergeAt(merge: Merge, message: Message): number | null {
  const a = merge.anchor;
  if (!a || a.messageId !== message.id || message.revisionId !== a.revisionId) return null;
  const r = resolveAnchor({ targetId: a.revisionId, quote: a, position: a }, message.content);
  return r.status === 'unresolved' ? null : r.start;
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
  onCite,
  onDeleted,
  onBackToSource,
  beside = false,
  threads,
  notes = [],
  onShowContext,
}: {
  threadId: string;
  /** Show what the model was sent for an answer (for the revision shown, when it is not the one in use). */
  onShowContext?: (messageId: string, revisionId?: string) => void;
  /** Every note: those made from this thread are named under its title. */
  notes?: NoteSummary[];
  /** Back to the passage of the source this thread was asked about. */
  onBackToSource: (origin: SourceOrigin, threadId: string) => void;
  /** Shown beside the source it was asked about (which then shows the passage itself). */
  beside?: boolean;
  /** It went to the Trash (with this many threads, side questions included). */
  onDeleted: (thread: Thread, count: number) => void;
  /** Every thread, to choose one to merge into. */
  threads: Thread[];
  onCite: (threadId: string, messageId: string) => void;
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
  const [merges, setMerges] = useState<Merge[]>([]);
  const [outgoing, setOutgoing] = useState<Merge[]>([]);
  const [continuedFrom, setContinuedFrom] = useState<ContinuedFrom | null>(null);
  const [sourceOrigin, setSourceOrigin] = useState<SourceOrigin | null>(null);
  const [continuedIn, setContinuedIn] = useState<Continuation[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The question a new thread would start from, while the learner confirms. */
  const [cutting, setCutting] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [messages, dispatch] = useReducer(reducer, []);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(() => storage.getJson<Outbox | null>(keys.outbox(threadId), null));
  const watchers = useRef(new Map<string, () => void>());
  const bottom = useRef<HTMLDivElement>(null);
  /** Answers shown as an earlier revision (read again), by message. The rest show the one in use. */
  const [viewing, setViewing] = useState<Map<string, MessageRevision>>(() => new Map());
  const revisionsCache = useRef(new Map<string, MessageRevision[]>());
  // What is on the screen: every message as the revision shown. Selections, marks and Back work on these.
  const shown = useMemo(
    () =>
      messages.map((m) => {
        const v = viewing.get(m.id);
        return v && v.revisionId !== m.revisionId ? asRevision(m, v) : m;
      }),
    [messages, viewing],
  );
  const byId = useMemo(() => new Map(shown.map((m) => [m.id, m])), [shown]);

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
          // The first answer may have given the thread its AI title, and each answer its line for the catalog.
          api.thread(threadId).then(
            (d) => {
              setThread(d.thread);
              dispatch({ type: 'headlines', messages: d.messages });
            },
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
        setMerges(detail.merges);
        setOutgoing(detail.outgoing);
        setContinuedFrom(detail.continuedFrom);
        setSourceOrigin(detail.sourceOrigin);
        setContinuedIn(detail.continuedIn);
        setPins(detail.pins);
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
  const lastStatus = messages.at(-1)?.status;

  // Follow the answer as it grows, unless the learner has scrolled up to read.
  const stick = useRef(!returningFrom && !focus && !focusMessage);
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // Once more when it ends, for the actions that appear under a finished answer.
  useEffect(() => {
    if (lastContentLength >= 0 && lastStatus && stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastContentLength, lastStatus]);

  // Pinned or unpinned from the source beside: read the pins again.
  useEffect(() => {
    const onChanged = () => {
      api.thread(threadId).then(
        (d) => setPins(d.pins),
        () => {},
      );
    };
    window.addEventListener(PINS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PINS_CHANGED_EVENT, onChanged);
  }, [threadId]);

  // Pinned passages of this thread, marked where they are (in the revision shown).
  useEffect(() => {
    if (!loaded) return;
    const ranges: Range[] = [];
    for (const p of pins) {
      const at = p.message;
      const message = at ? byId.get(at.messageId) : undefined;
      const container = at ? document.querySelector(`[data-message-id="${at.messageId}"]`) : null;
      if (!at || !message || !container || message.revisionId !== at.revisionId) continue;
      const r = resolveAnchor({ targetId: at.revisionId, quote: { exact: p.exact, prefix: '', suffix: '' }, position: at }, message.content);
      if (r.status === 'unresolved') continue;
      const range = sourceToRange(container, message.content, r.start, r.end);
      if (range) ranges.push(range);
    }
    highlight('noema-pins', ranges);
  }, [pins, byId, loaded]);
  useEffect(() => () => void highlight('noema-pins', null), []);

  // Marks where branches left, redrawn as messages render.
  useEffect(() => {
    highlight('noema-branches', loaded ? rangesFor(branches, byId) : null);
  }, [branches, byId, loaded]);
  useEffect(() => () => void highlight('noema-branches', null), []);

  // Show an answer as one of its revisions (null: the one in use).
  const revisionsOf = useCallback(async (messageId: string) => {
    const cached = revisionsCache.current.get(messageId);
    if (cached) return cached;
    const { revisions } = await api.revisions(messageId);
    revisionsCache.current.set(messageId, revisions);
    return revisions;
  }, []);
  const showRevision = useCallback(
    async (messageId: string, revisionId: string | null) => {
      const revision = revisionId ? (await revisionsOf(messageId)).find((r) => r.revisionId === revisionId) : undefined;
      setViewing((v) => {
        const next = new Map(v);
        if (revision) next.set(messageId, revision);
        else next.delete(messageId);
        return next;
      });
    },
    [revisionsOf],
  );

  // Back from a branch: scroll to the passage it left from and highlight it.
  // If the passage is in an earlier answer (asked again since), that answer is shown first.
  const returned = useRef(false);
  const showingFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || returned.current || (!returningFrom && !focus && !focusMessage)) return;
    const wanted = returningFrom
      ? branches.find((b) => b.threadId === returningFrom)?.anchor
      : focus?.revisionId
        ? { messageId: focus.messageId, revisionId: focus.revisionId }
        : undefined;
    const at = wanted ? byId.get(wanted.messageId) : undefined;
    if (wanted && at && at.revisionId !== wanted.revisionId && showingFor.current !== wanted.revisionId) {
      showingFor.current = wanted.revisionId;
      showRevision(wanted.messageId, wanted.revisionId).catch(() => {});
      return;
    }
    returned.current = true;
    if (focusMessage) {
      const article = document.querySelector(`[data-message-id="${focusMessage}"]`)?.closest('article');
      if (article) arrive(article, focusMessage);
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
  }, [loaded, returningFrom, focus, focusMessage, branches, byId, showRevision]);
  useEffect(() => () => void highlight('noema-return', null), []);
  useEffect(() => () => clearFound(), []);

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
      revisionId: message.revisionId,
      start: anchor.position.start,
      end: anchor.position.end,
      exact: anchor.quote.exact,
    });
  };

  const pinSelection = async () => {
    const message = selection ? byId.get(selection.messageId) : undefined;
    if (!selection || !message) return;
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    try {
      const pin = await api.pin(threadId, {
        id: ulid(),
        message: { messageId: message.id, revisionId: message.revisionId, start: selection.start, end: selection.end },
      });
      setPins((list) => [...list.filter((p) => p.id !== pin.id), pin]);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const unpin = async (pin: Pin) => {
    try {
      await api.unpin(pin.id);
      setPins((list) => list.filter((p) => p.id !== pin.id));
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Show a pinned passage: here, in the answer it is in (as the revision pinned), or in its own thread.
  const [showingPin, setShowingPin] = useState<Pin | null>(null);
  const showPin = (pin: Pin) => {
    const at = pin.message;
    if (!at) return;
    if (at.threadId !== threadId) {
      onCite(at.threadId, at.messageId);
      return;
    }
    const inUse = messages.find((m) => m.id === at.messageId);
    if (!inUse) return;
    setShowingPin(pin);
    showRevision(at.messageId, at.revisionId === inUse.revisionId ? null : at.revisionId).catch(() => {});
  };
  useEffect(() => {
    const at = showingPin?.message;
    if (!showingPin || !at) return;
    const message = byId.get(at.messageId);
    if (!message || message.revisionId !== at.revisionId) return;
    setShowingPin(null);
    const container = document.querySelector(`[data-message-id="${at.messageId}"]`);
    const range = container ? sourceToRange(container, message.content, at.start, at.end) : null;
    if (!range) return;
    highlight('noema-return', range);
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }, [showingPin, byId]);

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

  // Ask the same question again: a new answer, kept beside the old ones, made the one in use.
  const askAgain = async (messageId: string) => {
    try {
      const { message } = await api.regenerate(messageId, ulid());
      revisionsCache.current.delete(messageId);
      await showRevision(messageId, null);
      dispatch({ type: 'upsert', message });
      onChanged();
      if (!isTerminal(message.status)) watch(message.id);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Flip through an answer's revisions.
  const flip = async (messageId: string, n: number) => {
    const inUse = messages.find((m) => m.id === messageId);
    if (!inUse) return;
    try {
      const target = (await revisionsOf(messageId)).find((r) => r.revision === n);
      if (target) await showRevision(messageId, target.revisionId === inUse.revisionId ? null : target.revisionId);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Make the revision shown the one in use: it is then searched and sent with new questions.
  const useShown = async (messageId: string) => {
    const v = viewing.get(messageId);
    if (!v) return;
    try {
      const { message } = await api.useRevision(messageId, v.revisionId);
      dispatch({ type: 'upsert', message });
      await showRevision(messageId, null);
      onChanged();
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

  // Merging this thread into another: a draft here, a card there.
  const onMergeChange = useCallback(
    (m: Merge) => {
      setOutgoing((list) => {
        const rest = list.filter((x) => x.id !== m.id);
        return ['discarded', 'undone'].includes(m.status) ? rest : [...rest, m];
      });
      if (m.status === 'merged' || m.status === 'undone') onChanged();
    },
    [onChanged],
  );

  const startMerge = async (into: string) => {
    setPicking(false);
    try {
      const m = await api.startMerge(threadId, ulid(), into, 'summary');
      setOutgoing((list) => [...list.filter((x) => x.status === 'merged'), m]);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const undoMerged = async (m: Merge) => {
    try {
      await api.undoMerge(m.id);
      setMerges((list) => list.filter((x) => x.id !== m.id));
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Make this side question its own thread, or put it back. Reload: its path changes.
  const split = async (next: boolean) => {
    try {
      setThread(await api.splitThread(threadId, next));
      setPath((await api.thread(threadId)).path);
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const remove = async () => {
    if (!thread) return;
    try {
      const r = await api.deleteThread(threadId);
      setConfirmDelete(false);
      onDeleted(thread, r.deleted);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const restore = async () => {
    try {
      setThread(await api.restoreThread(threadId));
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // New thread from here: this question and everything after it move into a thread of their own.
  const splitOff = async (messageId: string) => {
    const id = ulid();
    try {
      await api.splitOff(threadId, id, messageId);
      setCutting(null);
      onChanged();
      onNavigate(id);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Undo it: back into the thread it came from, at the first question that moved.
  const joinBack = async () => {
    if (!continuedFrom) return;
    const first = messages[0]?.id;
    try {
      await api.joinBack(threadId);
      onChanged();
      if (first) onCite(continuedFrom.threadId, first);
      else onNavigate(continuedFrom.threadId);
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

  const byIdInUse = new Map(messages.map((m) => [m.id, m]));
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
            canMerge={messages.some((m) => m.role === 'assistant' && m.status === 'done')}
            onMerge={() => setPicking((p) => !p)}
            onDelete={thread.deletedAt ? undefined : () => setConfirmDelete((c) => !c)}
            notes={notes.filter((n) => n.threadId === threadId)}
            onOpenNote={onOpenNote}
          />
        )}
        {thread?.deletedAt && (
          <div className="in-trash" role="status" data-testid="in-trash">
            This thread is in the Trash.
            <button type="button" onClick={() => void restore()} data-testid="restore">
              Restore
            </button>
          </div>
        )}
        {confirmDelete && thread && !thread.deletedAt && (
          <DeleteConfirm
            title={thread.title}
            sides={sideQuestionsOf(threads, threadId)}
            onConfirm={() => void remove()}
            onCancel={() => setConfirmDelete(false)}
          />
        )}
        {origin && (
          <OriginCard
            parentTitle={origin.parentTitle}
            exact={origin.anchor.exact}
            path={path}
            onBack={back}
            onOpen={(id) => onNavigate(id)}
            split={Boolean(thread?.splitAt)}
            onSplit={(next) => void split(next)}
            onBackToMain={
              path.length >= 2 && path[0]
                ? () => onNavigate((path[0] as { id: string }).id, path[1]?.id ?? threadId)
                : undefined
            }
            onMergeBack={
              messages.some((m) => m.role === 'assistant' && m.status === 'done') &&
              !outgoing.some((m) => m.targetThreadId === origin.parentThreadId && m.status !== 'merged')
                ? () => void startMerge(origin.parentThreadId)
                : undefined
            }
          />
        )}
        {sourceOrigin && (
          <SourceOriginCard origin={sourceOrigin} beside={beside} onBack={() => onBackToSource(sourceOrigin, threadId)} />
        )}
        {continuedFrom && (
          <ContinuedFromCard from={continuedFrom} onOpen={(id) => onNavigate(id)} onJoinBack={() => void joinBack()} />
        )}
        <PinnedList
          pins={pins}
          threadId={threadId}
          titleOf={(id, fallback) => (id === threadId ? thread?.title : threads.find((t) => t.id === id)?.title) || fallback}
          onShow={showPin}
          onUnpin={(p) => void unpin(p)}
        />
        {picking && (
          <MergePicker
            threads={threads}
            from={threadId}
            onPick={(id) => void startMerge(id)}
            onCancel={() => setPicking(false)}
          />
        )}
        <OutgoingMerges
          merges={outgoing}
          onChange={onMergeChange}
          onOpenTarget={(id) => onNavigate(id)}
          onCite={onCite}
        />
        {loaded && messages.length === 0 && !origin && !sourceOrigin && (
          <div className="empty">
            <p className="empty-title">Ask anything you are studying.</p>
          </div>
        )}
        {merges
          .filter((x) => !x.afterMessageId || !byId.has(x.afterMessageId))
          .map((x) => (
            <MergeCard
              key={x.id}
              merge={x}
              onOpenSource={(id) => onNavigate(id)}
              onCite={onCite}
              onUndo={() => void undoMerged(x)}
            />
          ))}
        {shown.map((m) => {
          const card = (x: Merge) => (
            <MergeCard
              key={x.id}
              merge={x}
              onOpenSource={(id) => onNavigate(id)}
              onCite={onCite}
              onUndo={() => void undoMerged(x)}
            />
          );
          const mine = merges.filter((x) => x.afterMessageId === m.id);
          const inline = mine.flatMap((x) => {
            const at = mergeAt(x, m);
            return at === null ? [] : [{ key: x.id, at, node: card(x) }];
          });
          const after = mine.filter((x) => !inline.some((i) => i.key === x.id));
          const canCut = m.role === 'user' && m.seq > 0 && isTerminal(m.status) && !live;
          const inUse = byIdInUse.get(m.id);
          const canAskAgain =
            m.role === 'assistant' && !live && !thread?.deletedAt && inUse !== undefined && isTerminal(inUse.status);
          return (
            <div key={m.id} className="message-slot">
              {cutting === m.id && (
                <SplitOffConfirm
                  {...movingFrom(messages, branches, m.id)}
                  onConfirm={() => void splitOff(m.id)}
                  onCancel={() => setCutting(null)}
                />
              )}
              <MessageView
                message={m}
                branches={branchesByMessage.get(m.id) ?? []}
                onStop={() => void stop(m.id)}
                onOpenSettings={onOpenSettings}
                onOpenBranch={(id) => onNavigate(id)}
                onSplitOff={canCut && cutting !== m.id ? () => setCutting(m.id) : undefined}
                onShowContext={
                  onShowContext
                    ? () => onShowContext(m.id, viewing.has(m.id) ? m.revisionId : undefined)
                    : undefined
                }
                onAskAgain={canAskAgain ? () => void askAgain(m.id) : undefined}
                versions={
                  m.role === 'assistant' && m.revisions > 1 && inUse
                    ? {
                        n: m.revision,
                        of: m.revisions,
                        inUse: inUse.revision,
                        onShow: live ? undefined : (n: number) => void flip(m.id, n),
                        onUse: viewing.has(m.id) && !live && !thread?.deletedAt ? () => void useShown(m.id) : undefined,
                      }
                    : undefined
                }
                {...(inline.length > 0 ? { slots: inline } : {})}
              />
              {after.map(card)}
            </div>
          );
        })}
        {continuedIn.map((c) => (
          <p key={c.threadId} className="continued-in" data-testid="continued-in">
            This thread continues in{' '}
            <button type="button" className="quiet inline" onClick={() => onNavigate(c.threadId)}>
              {c.title || 'Untitled'} →
            </button>
          </p>
        ))}
        {loaded && messages.length > 0 && branches.length === 0 && !origin && !sourceOrigin && messages.length <= 2 && (
          <p className="hint">Tip: select any passage to ask about it in a side branch.</p>
        )}
        <div ref={bottom} />
      </main>
      {messages.filter((m) => m.role === 'user').length >= 3 && (
        <Outline items={outlineOf(shown, branchesByMessage, merges, byId)} label="Questions in this thread" />
      )}

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

      {!thread?.deletedAt && (
        <Composer
          key={threadId}
          draftKey={keys.draft(threadId)}
          busy={Boolean(live)}
          onSend={send}
          onStop={() => live && void stop(live.id)}
        />
      )}

      {selection && (
        <div
          className="selection-actions"
          style={{ top: Math.max(8, selection.rect.top - 44), left: selection.rect.left + selection.rect.width / 2 }}
        >
          <button
            type="button"
            className="selection-button"
            data-testid="branch-button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={branchFromSelection}
          >
            Ask in a branch
          </button>
          {!thread?.deletedAt && (
            <button
              type="button"
              className="selection-button secondary"
              data-testid="pin-button"
              title="Pin: send this passage with every question in this thread until you unpin it"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void pinSelection()}
            >
              📌 Pin
            </button>
          )}
        </div>
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
  canMerge,
  onMerge,
  onDelete,
  notes,
  onOpenNote,
}: {
  title: string;
  /** Notes made from this thread. */
  notes: NoteSummary[];
  onOpenNote: (noteId: string) => void;
  canRewrite: boolean;
  onRename: (title: string) => Promise<void>;
  onOpenMap: () => void;
  onRewrite: () => void;
  canMerge: boolean;
  onMerge: () => void;
  /** Absent for a thread already in the Trash. */
  onDelete?: (() => void) | undefined;
}) {
  // A thread that already has a note: say so before writing another one.
  const [another, setAnother] = useState(false);
  return (
    <header className="thread-head">
      <EditableTitle title={title} onRename={onRename} label="Thread title" />
      <div className="thread-actions">
        <button type="button" className="quiet" onClick={onOpenMap} data-testid="open-map">
          Map
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => (notes.length > 0 ? setAnother(true) : onRewrite())}
          disabled={!canRewrite}
          title="Rewrite this thread and its branches as a study note"
          data-testid="rewrite"
        >
          Rewrite as note
        </button>
        <button
          type="button"
          className="quiet"
          onClick={onMerge}
          disabled={!canMerge}
          title="Carry what this thread found into another thread"
          data-testid="merge-into"
        >
          Merge into…
        </button>
        {onDelete && (
          <button type="button" className="quiet faint-danger" onClick={onDelete} data-testid="thread-delete">
            Delete
          </button>
        )}
      </div>
      {notes.length > 0 && (
        <p className="thread-notes-line" data-testid="thread-notes-line">
          <span>{notes.length === 1 ? 'Note from this thread:' : 'Notes from this thread:'}</span>
          {notes.map((n) => (
            <button
              key={n.id}
              type="button"
              className="quiet inline"
              onClick={() => onOpenNote(n.id)}
              data-testid="thread-note-open"
              data-note-id={n.id}
            >
              <span aria-hidden>▤ </span>
              {n.title || 'Untitled'}
            </button>
          ))}
        </p>
      )}
      {another && notes.length > 0 && (
        <p className="thread-notes-line note-already" role="status" data-testid="note-already">
          <span>
            {notes.length === 1 ? 'This thread already has a note' : 'This thread already has notes'}, listed above. Open
            it, or
          </span>
          <button
            type="button"
            className="quiet inline"
            onClick={() => {
              setAnother(false);
              onRewrite();
            }}
            data-testid="rewrite-again"
          >
            write another
          </button>
          <button type="button" className="quiet inline" onClick={() => setAnother(false)}>
            Cancel
          </button>
        </p>
      )}
    </header>
  );
}

/** Asked before a thread goes to the Trash: what goes with it, and that it can come back. */
function DeleteConfirm({
  title,
  sides,
  onConfirm,
  onCancel,
}: {
  title: string;
  sides: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="split-off-confirm delete-confirm" data-testid="thread-delete-confirm" aria-label="Delete thread">
      <p>
        <strong>Delete “{title || 'Untitled'}”</strong>
        {sides > 0 ? ` and ${sides === 1 ? 'its side question' : `its ${sides} side questions`}` : ''}? It goes to the
        Trash, where you can restore it. Threads that became their own stay, and so do notes.
      </p>
      <div className="proposal-actions">
        <button type="button" className="danger" onClick={onConfirm} data-testid="thread-delete-yes">
          Delete
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The side questions that go to the Trash with a thread: those still its own, at any depth. */
function sideQuestionsOf(threads: Thread[], id: string): number {
  let n = 0;
  for (const t of threads) {
    if (t.parentThreadId === id && !t.splitAt) n += 1 + sideQuestionsOf(threads, t.id);
  }
  return n;
}

/** What moves with a new thread started at this question: it and every question after it, and their side questions. */
function movingFrom(messages: Message[], branches: BranchSummary[], from: string): { questions: number; sides: number } {
  const i = messages.findIndex((m) => m.id === from);
  const moving = new Set(messages.slice(i).map((m) => m.id));
  return {
    questions: messages.slice(i).filter((m) => m.role === 'user').length,
    sides: branches.filter((b) => moving.has(b.anchor.messageId)).length,
  };
}

function SplitOffConfirm({
  questions,
  sides,
  onConfirm,
  onCancel,
}: {
  questions: number;
  sides: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const what =
    questions === 1 ? 'This question and its answer' : `This question and the ${questions - 1} after it`;
  return (
    <section className="split-off-confirm" data-testid="split-off-confirm" aria-label="New thread from here">
      <p>
        <strong>{what}</strong>
        {sides > 0 ? `, with ${sides === 1 ? 'its side question' : `${sides} side questions`},` : ''} will move into
        a new thread. It starts here and won't send the earlier conversation to the model. Join back undoes it.
      </p>
      <div className="proposal-actions">
        <button type="button" onClick={onConfirm} data-testid="split-off-confirm-move">
          Move to a new thread
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** At the top of a thread split off from another: where it came from, and the way back. */
function ContinuedFromCard({
  from,
  onOpen,
  onJoinBack,
}: {
  from: ContinuedFrom;
  onOpen: (threadId: string) => void;
  onJoinBack: () => void;
}) {
  return (
    <section className="continued-from" data-testid="continued-from" aria-label="Where this thread came from">
      <span>
        Split off from{' '}
        <button type="button" className="quiet inline" onClick={() => onOpen(from.threadId)}>
          {from.title || 'Untitled'}
        </button>
      </span>
      {from.canJoinBack ? (
        <button
          type="button"
          className="quiet"
          onClick={onJoinBack}
          title="Put these questions back at the end of the thread they came from"
          data-testid="join-back"
        >
          ⤺ Join back
        </button>
      ) : (
        from.joinBackBlocked && <span className="continued-note">{from.joinBackBlocked}</span>
      )}
    </section>
  );
}

/** A thread asked about a passage of a source: the passage, and the way back to it in the text. */
function SourceOriginCard({ origin, beside, onBack }: { origin: SourceOrigin; beside: boolean; onBack: () => void }) {
  const exact = origin.passage.exact;
  const readable = readableQuote(exact, false);
  const quote = readable.length > 600 ? `${readable.slice(0, 600)}…` : readable;
  return (
    <section
      className="origin source-origin"
      data-testid="source-origin"
      data-exact={exact}
      aria-label="The passage this thread was asked about"
    >
      <div className="origin-top">
        <button
          type="button"
          className="back"
          onClick={onBack}
          title="Close this thread and go on reading, at this passage"
          data-testid="back"
        >
          {beside ? '← Back to reading' : '← Back to the text'}
        </button>
        <span className="origin-from">
          from {origin.sourceTitle || 'Untitled'}
          {origin.deleted ? ' (in the Trash)' : ''}
        </span>
      </div>
      <blockquote>{quote}</blockquote>
      {origin.latestVersionId !== origin.passage.versionId && (
        <p className="origin-note">Asked about an earlier version of this page; the text shown is that version.</p>
      )}
    </section>
  );
}

function OriginCard({
  parentTitle,
  exact,
  path,
  onBack,
  onOpen,
  split,
  onSplit,
  onMergeBack,
  onBackToMain,
}: {
  parentTitle: string;
  exact: string;
  path?: Array<{ id: string; title: string }>;
  onBack: () => void;
  onOpen?: (threadId: string) => void;
  /** Absent for a branch not yet asked. */
  split?: boolean;
  onSplit?: (split: boolean) => void;
  /** Absent until there is an answer to merge, or while a merge back is being drafted. */
  onMergeBack?: (() => void) | undefined;
  /** Two or more side questions deep: straight back to where the detours began. */
  onBackToMain?: (() => void) | undefined;
}) {
  const readable = readableQuote(exact, false);
  const quote = readable.length > 600 ? `${readable.slice(0, 600)}…` : readable;
  return (
    <section className="origin" data-testid="origin" data-exact={exact} aria-label="Where this branch started">
      <div className="origin-top">
        <button type="button" className="back" onClick={onBack} data-testid="back">
          ← Back
        </button>
        {onBackToMain && (
          <button
            type="button"
            className="quiet"
            onClick={onBackToMain}
            title="Leave every side question and go back to the passage where they began"
            data-testid="back-to-main"
          >
            ⇤ Back to the main thread
          </button>
        )}
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
      {onSplit && (
        <div className="origin-foot">
          {split ? (
            <>
              <span>Its own thread, with its own map and notes.</span>
              <button type="button" className="quiet" onClick={() => onSplit(false)} data-testid="unsplit">
                Put back as a side question
              </button>
            </>
          ) : (
            <button
              type="button"
              className="quiet"
              onClick={() => onSplit(true)}
              title="List it on its own, with its own map and notes. The AI then sees only this passage, not the conversation above."
              data-testid="split"
            >
              ↗ Make it its own thread
            </button>
          )}
          {onMergeBack && (
            <button
              type="button"
              className="quiet"
              onClick={onMergeBack}
              title="Carry what this side question found back into the thread it came from"
              data-testid="merge-back"
            >
              ⤶ Merge back into {parentTitle || 'the thread'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A new thread, or a new branch, before its first question. */
export function DraftView({
  notebookId,
  branch,
  source = null,
  onCreated,
  onCancel,
  onOpenAsked,
}: {
  notebookId: string;
  branch: BranchDraft | null;
  /** Asking about a passage of a source, instead. */
  source?: SourceDraft | null;
  onCreated: (threadId: string) => void;
  onCancel: () => void;
  /** Open an earlier exchange that already asked this. */
  onOpenAsked: (threadId: string, messageId: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  // What is typed, for the reminder that it was asked before; and the reminder showing, if any.
  const [typed, setTyped] = useState('');
  const reminder = useRef<AskedHit | null>(null);
  const place: AskedPlace = source ? 'source' : branch ? 'branch' : 'thread';
  const draftKey = source
    ? keys.draft(`source:${source.versionId}:${source.start}-${source.end}`)
    : branch
      ? keys.draft(`branch:${branch.messageId}:${branch.start}-${branch.end}`)
      : keys.draft('new');

  // Ask in the earlier thread instead: no new thread is made.
  const askThere = async (hit: AskedHit) => {
    const content = typed.trim();
    if (!content) return;
    try {
      await api.ask(hit.threadId, ulid(), content);
      storage.remove(draftKey);
      onCreated(hit.threadId);
    } catch (err) {
      setNotice(err instanceof ApiFailure ? err.message : 'Could not send the question.');
    }
  };
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
    // Asked here although a reminder was showing: counted, to learn whether reminders help.
    if (reminder.current) {
      api.askedEvent({ action: 'asked_anyway', strength: reminder.current.strength, place, by: reminder.current.by }).catch(() => {});
    }
    try {
      if (source) {
        // The page goes with the question when its picture is ready; a slow one is not waited for long.
        await atMost(source.pictures, 8000);
        await api.askAboutSource(source.sourceId, {
          id,
          passage: { versionId: source.versionId, start: source.start, end: source.end },
          question: { id: current.question, content },
        });
      } else if (branch) {
        await api.createBranch(branch.parentThreadId, {
          id,
          anchor: {
            messageId: branch.messageId,
            ...(branch.revisionId ? { revisionId: branch.revisionId } : {}),
            start: branch.start,
            end: branch.end,
          },
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
        {source ? (
          <OriginCard parentTitle={source.sourceTitle} exact={source.exact} onBack={onCancel} />
        ) : branch ? (
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
      <AskedBefore
        key={draftKey}
        notebookId={notebookId}
        text={typed}
        passage={source?.exact ?? branch?.exact}
        threadId={branch?.parentThreadId}
        place={place}
        onOpen={(hit) => onOpenAsked(hit.threadId, hit.messageId)}
        onAskThere={(hit) => void askThere(hit)}
        onShowing={(hit) => {
          reminder.current = hit;
        }}
      />
      <Composer
        key={source ? `${source.versionId}:${source.start}-${source.end}` : branch ? `${branch.messageId}:${branch.start}` : 'new'}
        draftKey={draftKey}
        busy={false}
        autoFocus
        placeholder={source || branch ? 'Ask about this passage…' : 'Ask a question…'}
        onSend={send}
        onDraft={setTyped}
      />
    </>
  );
}
