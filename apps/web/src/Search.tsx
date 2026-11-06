// Find again: one box over every thread, side question, answer and note.
// ⌘K (Ctrl+K on Windows and Linux) or "/" opens it from anywhere. Each hit
// says where it is; Enter opens the exact message or note block, with the
// words marked there. With nothing typed, it lists the side questions you
// never came back from.

import type { OpenBranch, SearchHit } from '@noema/core';
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { dayOf, kindOf, snippetParts, whereOf, whereParts } from './hits.ts';

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export function searchShortcut(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl K';
}

/** Whether a key press belongs to something being typed in (so "/" is a character, not a shortcut). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const short = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const hitKey = (h: SearchHit) => `${h.kind}:${h.messageId ?? h.blockId ?? h.threadId ?? h.noteId}`;

export function SearchDialog({
  notebookId,
  onClose,
  onOpen,
  onOpenThread,
}: {
  notebookId: string;
  onClose: () => void;
  /** Open a hit; `terms` are the words to mark there, `rank` its place in the list. */
  onOpen: (hit: SearchHit, terms: string[], rank: number, queryChars: number) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; terms: string[]; hits: SearchHit[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [left, setLeft] = useState<OpenBranch[] | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    api.openBranches(notebookId).then(
      (r) => setLeft(r.branches),
      () => setLeft([]),
    );
  }, [notebookId]);

  // Search a moment after the last key; only the answer to the latest query counts.
  const q = query.trim();
  useEffect(() => {
    if (q === '') {
      setResult(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.search(q).then(
        (r) => {
          if (cancelled) return;
          setResult({ query: q, terms: r.terms, hits: r.hits });
          setActive(0);
          setFailed(false);
        },
        () => !cancelled && setFailed(true),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const hits = q !== '' && result ? result.hits : [];
  const current = result?.query === q;

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the highlighted hit
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (i: number) => {
    const hit = hits[i];
    if (hit && result) onOpen(hit, result.terms, i, result.query.length);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter while an input method is composing (Chinese, Japanese) picks a word, not a hit.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  };

  const setAside = (threadId: string) => {
    setLeft((l) => l?.filter((b) => b.threadId !== threadId) ?? null);
    void api.setAside(threadId).catch(() => {});
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it from the keyboard
    <dialog
      ref={ref}
      className="search-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      aria-label="Search"
      data-testid="search"
    >
      <div className="search-box">
        <span className="search-glyph" aria-hidden>
          ⌕
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search your questions, answers and notes"
          aria-label="Search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="search-hits"
          aria-activedescendant={hits.length > 0 ? `search-hit-${active}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the learner opened search to type
          autoFocus
          data-testid="search-input"
        />
        <kbd>esc</kbd>
      </div>

      {q === '' ? (
        <LeftOpen branches={left} onOpen={onOpenThread} onSetAside={setAside} />
      ) : failed ? (
        <p className="search-note">Search is not reachable right now. Try again.</p>
      ) : current && hits.length === 0 ? (
        <p className="search-note" data-testid="search-empty">
          Nothing found for “{short(q, 40)}”.
        </p>
      ) : (
        <ul id="search-hits" ref={list} role="listbox" className="search-hits" aria-label="Results">
          {hits.map((h, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the search box's arrows and Enter are the keyboard path
            <li
              key={hitKey(h)}
              id={`search-hit-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="search-hit"
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => choose(i)}
              data-testid="search-hit"
              data-kind={h.kind}
            >
              {/* Where it is; the part nearest the hit stays readable when the line is short of room. */}
              <span className="hit-where crumbs-line" title={whereOf(h)}>
                {whereParts(h).map((part, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed path
                  <Fragment key={k}>
                    {k > 0 && (
                      <span className="crumb-sep" aria-hidden>
                        ›
                      </span>
                    )}
                    <span className="crumb">{part}</span>
                  </Fragment>
                ))}
              </span>
              <span className="hit-text">
                {snippetParts(h.snippet, h.matches).map((p, k) =>
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed snippet
                  p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>,
                )}
              </span>
              <span className="hit-meta">
                <span className="hit-kind">
                  {kindOf(h)}
                  {h.headline ? ` · ${h.headline}` : ''}
                </span>
                <span className="hit-day">{dayOf(h.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="search-foot" aria-hidden>
        ↑ ↓ to move · Enter to open · Esc to close
      </p>
    </dialog>
  );
}

/** The side questions you never came back from: a way back to each, and "Not now" to take one off the list. */
function LeftOpen({
  branches,
  onOpen,
  onSetAside,
}: {
  branches: OpenBranch[] | null;
  onOpen: (threadId: string) => void;
  onSetAside: (threadId: string) => void;
}) {
  if (branches === null) return null;
  if (branches.length === 0) {
    return (
      <p className="search-note">
        Find any question, answer or note again, side questions included.
      </p>
    );
  }
  return (
    <section className="left-open" data-testid="left-open">
      <h2>Side questions you never came back from</h2>
      <ul>
        {branches.map((b) => (
          <li key={b.threadId}>
            <button
              type="button"
              className="left-open-link"
              onClick={() => onOpen(b.threadId)}
              data-testid="left-open-item"
              data-thread-id={b.threadId}
            >
              <span className="hit-where">↳ {b.title || 'Side question'}</span>
              <span className="hit-meta">
                <span className="hit-kind">
                  {b.quote ? <>from “{short(b.quote)}” in </> : 'in '}
                  {b.parentTitle || 'Untitled'}
                </span>
                <span className="hit-day">{dayOf(b.lastAt)}</span>
              </span>
            </button>
            <button
              type="button"
              className="quiet faint"
              onClick={() => onSetAside(b.threadId)}
              title="Take it off this list. Asking in it again brings it back."
              data-testid="left-open-aside"
            >
              Not now
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * When Noema is opened fresh: one quiet line naming the side questions left
 * open, as links. Hidden once one is opened or it is closed; the full list
 * stays in search.
 */
export function ComeBack({
  branches,
  onOpen,
  onHide,
  onSearch,
}: {
  branches: OpenBranch[];
  onOpen: (threadId: string) => void;
  onHide: () => void;
  onSearch: () => void;
}) {
  const shown = branches.slice(0, 3);
  const more = branches.length - shown.length;
  return (
    <aside className="come-back" data-testid="come-back" aria-label="Side questions left open">
      <span className="come-back-label">Left open:</span>
      {shown.map((b) => (
        <button
          key={b.threadId}
          type="button"
          className="quiet inline"
          onClick={() => onOpen(b.threadId)}
          title={b.quote ? `From “${b.quote}” in ${b.parentTitle || 'Untitled'}` : undefined}
          data-testid="come-back-item"
          data-thread-id={b.threadId}
        >
          ↳ {short(b.title || 'Side question', 40)}
        </button>
      ))}
      {more > 0 && (
        <button type="button" className="quiet inline faint" onClick={onSearch}>
          +{more} more
        </button>
      )}
      <button type="button" className="quiet come-back-hide" onClick={onHide} aria-label="Hide" data-testid="come-back-hide">
        ×
      </button>
    </aside>
  );
}
