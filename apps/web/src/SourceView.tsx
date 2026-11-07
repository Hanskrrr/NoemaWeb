// A source in the reading pane, with the conversation beside it. The pane
// scrolls by itself, so the place you were reading stays put while you ask:
// select a passage, "Ask about this", and the question opens on the right.
// Every passage asked about is marked in the text and in the margin (darker
// where more was asked), with its threads under it; the right-hand side lists
// where you asked most when no thread is open.

import {
  createAnchor,
  type NoteSummary,
  type Source,
  type SourceDetail,
  sourceHeadings,
  type Thread,
} from '@noema/core';
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { arrive, centre, clearFound } from './found.ts';
import { dayOf } from './hits.ts';
import { Markdown, type Slot } from './markdown/Markdown.tsx';
import { highlight, selectionToSource, sourceToRange } from './markdown/selection.ts';
import { askedPassages, headingText, hostOf, markStrength, sourceFamily } from './reading.ts';
import { DraftView, type SourceDraft } from './ThreadView.tsx';

const errorText = (err: unknown) => (err instanceof ApiFailure ? err.message : 'Something went wrong.');
const short = (text: string, max = 140) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const questionsLabel = (n: number) => (n === 1 ? '1 question' : `${n} questions`);
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, .math-display';

/** A paper is long: drawn again only when its text or what was asked in it changes, not on every selection. */
const SourceText = memo(Markdown);

export function SourceView({
  sourceId,
  version,
  at,
  focusThread,
  jump,
  arrival,
  notebookId,
  threads,
  notes,
  children,
  onOpenThread,
  onOpenNote,
  onVersion,
  onAsked,
  onChanged,
  onDeleted,
}: {
  sourceId: string;
  /** The version to show; the latest when absent. */
  version?: string | undefined;
  /** From search: the offset of the block that matched. */
  at?: number | undefined;
  /** The thread whose passage is shown: the one open beside the text, or the one just left. */
  focusThread?: string | undefined;
  /** Bumped on every jump from search, so the same place is arrived at again. */
  jump: number;
  /** Where the learner is (the URL): arriving somewhere new brings the passage into view again. */
  arrival: string;
  notebookId: string;
  /** Every thread, for live titles and to know when something new was asked here. */
  threads: Thread[];
  /** Every note: those made from threads about this source are listed with them. */
  notes: NoteSummary[];
  onOpenNote: (noteId: string) => void;
  /** The thread open beside the text. */
  children?: ReactNode;
  onOpenThread: (threadId: string) => void;
  onVersion: (versionId: string | undefined) => void;
  onAsked: (threadId: string) => void;
  onChanged: () => void;
  onDeleted: (source: Source) => void;
}) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number; rect: DOMRect } | null>(null);
  const [marks, setMarks] = useState<Array<{ key: string; top: number; height: number; strength: number; label: string }>>(
    [],
  );
  const pane = useRef<HTMLElement>(null);
  const text = useRef<HTMLDivElement>(null);

  // Reloaded when a thread of this source changes: a new question, an answer, a new title.
  const familyKey = useMemo(
    () =>
      threads
        .filter((t) => sourceFamily(threads, t.id)?.sourceId === sourceId)
        .map((t) => `${t.id}:${t.updatedAt}:${t.title}`)
        .join(','),
    [threads, sourceId],
  );

  const load = useCallback(async () => {
    try {
      const d = await api.source(sourceId, version);
      // Same version: keep the very same text, so nothing is drawn again.
      setDetail((prev) => (prev && prev.version.id === d.version.id ? { ...d, version: prev.version } : d));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 404) setMissing(true);
      else setNotice(errorText(err));
    }
  }, [sourceId, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: familyKey is the reason to load again
  useEffect(() => {
    void load();
  }, [load, familyKey]);

  const content = detail?.version.content ?? '';
  const headings = useMemo(() => sourceHeadings(content).filter((h) => h.level <= 3), [content]);
  const passages = useMemo(() => askedPassages(detail?.threads ?? [], content), [detail?.threads, content]);
  const titles = useMemo(() => new Map(threads.map((t) => [t.id, t.title])), [threads]);
  const titleOf = (id: string, fallback: string) => titles.get(id) || fallback || 'Untitled';
  // Notes made from the threads asked here (or their side questions), by the thread asked about the passage.
  const notesByRoot = useMemo(() => {
    const byRoot = new Map<string, NoteSummary[]>();
    for (const n of notes) {
      const family = n.threadId ? sourceFamily(threads, n.threadId) : null;
      if (family?.sourceId !== sourceId) continue;
      byRoot.set(family.rootId, [...(byRoot.get(family.rootId) ?? []), n]);
    }
    return byRoot;
  }, [notes, threads, sourceId]);

  const rangeOf = useCallback(
    (start: number, end: number) => (text.current ? sourceToRange(text.current, content, start, end) : null),
    [content],
  );

  // Every passage asked about, marked in the text, with a mark in the margin.
  useLayoutEffect(() => {
    highlight(
      'noema-source-asked',
      passages.map((p) => rangeOf(p.start, p.end)).filter((r): r is Range => r !== null),
    );
    const el = text.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setMarks(
        passages.flatMap((p) => {
          const rects = Array.from(rangeOf(p.start, p.end)?.getClientRects() ?? []).filter((r) => r.height > 0);
          if (rects.length === 0) return [];
          const top = Math.min(...rects.map((r) => r.top)) - box.top;
          const bottom = Math.max(...rects.map((r) => r.bottom)) - box.top;
          return [
            {
              key: String(p.start),
              top,
              height: bottom - top,
              strength: markStrength(p.questions),
              label: questionsLabel(p.questions),
            },
          ];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [passages, rangeOf]);

  // The passage of the open thread, or of the question being written.
  const here =
    draft ??
    (focusThread ? (detail?.threads.find((t) => t.threadId === focusThread)?.passage ?? null) : null);
  useLayoutEffect(() => {
    highlight('noema-source-here', here ? rangeOf(here.start, here.end) : null);
  }, [here, rangeOf]);

  useEffect(
    () => () => {
      highlight('noema-source-asked', null);
      highlight('noema-source-here', null);
      clearFound();
    },
    [],
  );

  // A new thread opened from elsewhere: any question being written is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the thread or the jump changes
  useEffect(() => setDraft(null), [focusThread, jump, at]);

  // Arriving: at the block search found, or at the passage of the thread.
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !text.current) return;
    const key = `${detail.version.id}:${arrival}:${jump}`;
    if (arrived.current === key) return;
    if (at !== undefined) {
      arrived.current = key;
      const span = Array.from(text.current.querySelectorAll<HTMLElement>('[data-s][data-e]')).find(
        (s) => !s.closest('[data-foreign]') && Number(s.dataset.e) > at,
      );
      const block = span?.closest(BLOCK) ?? span;
      if (block) arrive(block, `${detail.version.id}:${at}`, pane.current);
      return;
    }
    if (focusThread) {
      const passage = detail.threads.find((t) => t.threadId === focusThread)?.passage;
      if (!passage) return; // not loaded yet: just asked
      arrived.current = key;
      const range = rangeOf(passage.start, passage.end);
      if (range) centre(range.getBoundingClientRect(), pane.current);
    }
  }, [detail, at, focusThread, jump, arrival, rangeOf]);

  // Select a passage to ask about it.
  const readSelection = useCallback(() => {
    const el = text.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!node || !el.contains(node) || node.closest('[data-foreign]')) return null;
    const range = selectionToSource(el, content);
    return range ? { ...range, rect: sel.getRangeAt(0).getBoundingClientRect() } : null;
  }, [content]);
  useEffect(() => {
    const onChange = () => setSelection(readSelection());
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [readSelection]);

  const askAbout = () => {
    if (!selection || !detail) return;
    const anchor = createAnchor(detail.version.id, content, selection.start, selection.end);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setDraft({
      sourceId,
      sourceTitle: detail.source.title,
      versionId: detail.version.id,
      start: anchor.position.start,
      end: anchor.position.end,
      exact: anchor.quote.exact,
    });
  };

  const showPassage = (start: number, end: number) => {
    const range = rangeOf(start, end);
    if (!range) return;
    highlight('noema-source-here', range);
    centre(range.getBoundingClientRect(), pane.current);
  };

  const showHeading = (start: number) => {
    setContentsOpen(false);
    const span = Array.from(text.current?.querySelectorAll<HTMLElement>('[data-s][data-e]') ?? []).find(
      (s) => Number(s.dataset.e) > start,
    );
    const heading = span?.closest('h2, h3, h4, h5, h6') ?? span;
    if (heading && pane.current) {
      const box = pane.current.getBoundingClientRect();
      pane.current.scrollTo({ top: pane.current.scrollTop + heading.getBoundingClientRect().top - box.top - 12 });
    }
  };

  const rename = async (title: string) => {
    try {
      const source = await api.renameSource(sourceId, title);
      setDetail((d) => (d ? { ...d, source } : d));
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const readAgain = async () => {
    setBusy('Reading it again…');
    try {
      const r = await api.refetchSource(sourceId);
      onChanged();
      if (r.changed) {
        setNotice(
          `The page has changed: this is version ${r.source.versions}. What you asked stays with the version you asked it about.`,
        );
        if (version) onVersion(undefined);
        else await load();
      } else {
        setNotice('Nothing has changed since it was read.');
      }
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setConfirmDelete(false);
    try {
      await api.deleteSource(sourceId);
      onDeleted(detail.source);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const restore = async () => {
    try {
      const source = await api.restoreSource(sourceId);
      setDetail((d) => (d ? { ...d, source } : d));
      onChanged();
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  // Under each passage asked about: its threads, to open beside the text.
  const slots = useMemo<Slot[]>(
    () =>
      passages.map((p) => ({
        key: `asked:${p.start}`,
        at: p.start,
        node: (
          <ul className="branch-links source-asked" aria-label="Asked about this passage">
            {p.threads.map((t) => (
              <li key={t.threadId}>
                <button
                  type="button"
                  className={`branch-link${t.threadId === focusThread ? ' current' : ''}`}
                  onClick={() => onOpenThread(t.threadId)}
                  title={`Asked about “${short(t.passage.exact, 200)}”`}
                  data-testid="source-thread-link"
                  data-thread-id={t.threadId}
                >
                  <span aria-hidden>↳</span> {titles.get(t.threadId) || t.title || 'Untitled'}
                </button>
              </li>
            ))}
          </ul>
        ),
      })),
    [passages, focusThread, onOpenThread, titles],
  );

  if (missing) {
    return (
      <main className="thread">
        <div className="empty">
          <p className="empty-title">This source does not exist.</p>
        </div>
      </main>
    );
  }
  if (!detail) return <main className="thread" aria-busy="true" />;

  const { source, version: shown, versions } = detail;
  const latest = shown.id === source.latestVersionId;
  const count = versions.length;
  // A page that starts with its own title: shown once, in the header (still there to select and ask about).
  const first = headings[0];
  const titleInText = first?.start === 0 && first.level === 1 && headingText(first.text) === source.title;

  const right = draft ? (
    <DraftView
      key={`${draft.versionId}:${draft.start}-${draft.end}`}
      notebookId={notebookId}
      branch={null}
      source={draft}
      onCreated={(id) => {
        setDraft(null);
        onAsked(id);
      }}
      onCancel={() => setDraft(null)}
    />
  ) : (
    (children ?? (
      <main className="thread source-overview" data-testid="source-overview">
        {passages.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Select any passage to ask about it.</p>
            <p>The answer opens here, beside the text, and stays tied to the passage you asked about.</p>
          </div>
        ) : (
          <>
            <h2 className="asked-head">Where you asked</h2>
            <p className="hint asked-sub">Most questions first. Click a passage to find it in the text.</p>
            <ol className="asked-list" data-testid="asked-list">
              {passages.map((p) => (
                <li key={p.start} data-testid="asked-passage">
                  <button type="button" className="asked-quote" onClick={() => showPassage(p.start, p.end)}>
                    “{short(p.exact)}”
                  </button>
                  <span className="asked-count">{questionsLabel(p.questions)}</span>
                  <ul className="branch-links">
                    {p.threads.map((t) => (
                      <li key={t.threadId}>
                        <button
                          type="button"
                          className="branch-link"
                          onClick={() => onOpenThread(t.threadId)}
                          data-testid="asked-thread"
                        >
                          <span aria-hidden>↳</span> {titleOf(t.threadId, t.title)}
                        </button>
                      </li>
                    ))}
                    {p.threads.flatMap((t) =>
                      (notesByRoot.get(t.threadId) ?? []).map((n) => (
                        <li key={n.id}>
                          <button
                            type="button"
                            className="branch-link note-chip"
                            onClick={() => onOpenNote(n.id)}
                            title="A note made from this question"
                            data-testid="asked-note"
                            data-note-id={n.id}
                          >
                            <span aria-hidden>▤</span> {n.title || 'Untitled'}
                          </button>
                        </li>
                      )),
                    )}
                  </ul>
                </li>
              ))}
            </ol>
          </>
        )}
        {detail.elsewhere > 0 && (
          <p className="hint">
            {detail.elsewhere === 1 ? '1 more question was' : `${detail.elsewhere} more questions were`} asked about other
            versions of this page.
          </p>
        )}
      </main>
    ))
  );

  return (
    <div className="reading" data-testid="reading" data-source-id={source.id}>
      <section
        className="source-pane"
        ref={pane}
        aria-label="Source"
        onScroll={() => selection && setSelection(readSelection())}
        data-testid="source-pane"
      >
        <header className="source-head">
          <h1>
            <EditableTitle title={source.title} onRename={rename} label="Source title" testId="source-rename" />
          </h1>
          <div className="source-meta">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.url} data-testid="source-url">
                {hostOf(source.url)} ↗
              </a>
            ) : (
              <span>Pasted</span>
            )}
            <span>{dayOf(shown.createdAt)}</span>
            {count > 1 && (
              <label className="source-version">
                <span className="sr-only">Version</span>
                <select
                  value={shown.id}
                  onChange={(e) => onVersion(e.target.value === source.latestVersionId ? undefined : e.target.value)}
                  data-testid="source-version"
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.seq}
                      {v.id === source.latestVersionId ? ' (latest)' : ''} · {dayOf(v.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="thread-actions">
            {headings.length > 1 && (
              <button
                type="button"
                className="quiet"
                onClick={() => setContentsOpen((o) => !o)}
                aria-expanded={contentsOpen}
                data-testid="source-contents"
              >
                Contents
              </button>
            )}
            {source.url && !source.deletedAt && (
              <button
                type="button"
                className="quiet"
                onClick={() => void readAgain()}
                disabled={busy !== null}
                title="Read the page again. If it changed, it becomes a new version; what you asked stays with the old one."
                data-testid="source-refetch"
              >
                {busy ?? 'Read again'}
              </button>
            )}
            {!source.deletedAt && (
              <button
                type="button"
                className="quiet faint-danger"
                onClick={() => setConfirmDelete((c) => !c)}
                data-testid="source-delete"
              >
                Delete
              </button>
            )}
          </div>
          {contentsOpen && (
            <nav className="source-contents" aria-label="Contents">
              <ol>
                {headings.map((h) => (
                  <li key={h.start} className={`level-${h.level}`}>
                    <button type="button" className="quiet" onClick={() => showHeading(h.start)}>
                      {headingText(h.text)}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </header>
        {source.deletedAt && (
          <div className="in-trash" role="status" data-testid="in-trash">
            This source is in the Trash.
            <button type="button" onClick={() => void restore()} data-testid="restore">
              Restore
            </button>
          </div>
        )}
        {confirmDelete && (
          <section className="split-off-confirm delete-confirm" data-testid="source-delete-confirm" aria-label="Delete source">
            <p>
              <strong>Delete “{source.title || 'Untitled'}”?</strong> It goes to the Trash, where you can restore it.
              {source.threads > 0 &&
                (source.threads === 1
                  ? ' The thread asked about it stays.'
                  : ` The ${source.threads} threads asked about it stay.`)}
            </p>
            <div className="proposal-actions">
              <button type="button" className="danger" onClick={() => void remove()} data-testid="source-delete-yes">
                Delete
              </button>
              <button type="button" className="quiet" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          </section>
        )}
        {!latest && (
          <div className="source-older" role="status" data-testid="source-older">
            You are reading version {shown.seq} of {source.versions}, as it was on {dayOf(shown.createdAt)}. What was
            asked here was asked about this version.
            <button type="button" className="quiet" onClick={() => onVersion(undefined)} data-testid="source-latest">
              Read the latest
            </button>
          </div>
        )}
        {notice && (
          <div className="source-notice" role="status" data-testid="source-notice">
            <span>{notice}</span>
            <button type="button" className="quiet" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        <div
          className={`source-text${titleInText ? ' title-in-text' : ''}`}
          ref={text}
          data-version-id={shown.id}
          data-testid="source-text"
        >
          <div className="source-marks" aria-hidden>
            {marks.map((m) => (
              <span
                key={m.key}
                className="source-mark"
                style={{ top: m.top, height: m.height, opacity: m.strength }}
                title={m.label}
              />
            ))}
          </div>
          <SourceText source={content} slots={slots} />
        </div>
      </section>
      <div className="conversation">{right}</div>
      {selection && !source.deletedAt && (
        <button
          type="button"
          className="selection-button"
          data-testid="ask-source"
          style={{ top: Math.max(8, selection.rect.top - 44), left: selection.rect.left + selection.rect.width / 2 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAbout}
        >
          Ask about this
        </button>
      )}
    </div>
  );
}
