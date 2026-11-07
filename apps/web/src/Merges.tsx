// Merging threads, like a merge commit: nothing already said is rewritten.
// The source gets a draft (the AI's summary, or the whole exchange) that the
// learner edits and accepts; the target then shows it as a card, under the
// passage a side question came from, and carries it in front of its next
// question. Undo stops carrying it.

import { type Merge, readableQuote, type Thread } from '@noema/core';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { CiteContext, Markdown } from './markdown/Markdown.tsx';
import { keys, storage } from './storage.ts';

const shortQuote = (exact: string) => {
  const q = readableQuote(exact);
  return q.length > 80 ? `${q.slice(0, 80)}…` : q;
};

function errorText(err: unknown): string {
  return err instanceof ApiFailure ? err.message : 'Something went wrong. Try again.';
}

/** Ask a merged card to open, then show it (from the catalog). */
export const OPEN_MERGE_EVENT = 'noema:open-merge';

/** The first line of a merged text, as plain words, for the closed card. */
export function mergePreview(markdown: string, max = 140): string {
  const line =
    markdown
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
          .replace(/\[E\d{1,4}\]/g, '')
          .replace(/[ \t]+([.,;:!?。，；：！？])/g, '$1')
          .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
          .trim(),
      )
      .find((l) => l !== '' && !/^(\$\$|```|~~~|\|?[-: |]+\|?$)/.test(l)) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * In the target thread: what was merged in, and from where. Closed, it is
 * one line with the start of the text; open, the whole text. Each reader's
 * choice is remembered for that card.
 */
export function MergeCard({
  merge,
  onOpenSource,
  onCite,
  onUndo,
}: {
  merge: Merge;
  onOpenSource: (threadId: string) => void;
  onCite: (threadId: string, messageId: string) => void;
  onUndo: () => void;
}) {
  const [open, setOpen] = useState(() => storage.getJson<boolean>(keys.mergeOpen(merge.id), false));
  const toggle = (next: boolean) => {
    setOpen(next);
    storage.setJson(keys.mergeOpen(merge.id), next);
  };
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === merge.id) setOpen(true);
    };
    window.addEventListener(OPEN_MERGE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MERGE_EVENT, onOpen);
  }, [merge.id]);
  const bodyId = `merge-body-${merge.id}`;

  return (
    <section
      className={`merge-card${open ? ' open' : ''}`}
      data-testid="merge-card"
      data-merge-id={merge.id}
      data-open={open ? '' : undefined}
    >
      <div className="merge-head">
        <button
          type="button"
          className="merge-toggle"
          onClick={() => toggle(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? 'Collapse' : 'Expand'}
          data-testid="merge-toggle"
        >
          <span className="merge-caret" aria-hidden>
            ▸
          </span>
          <span aria-hidden>⤶ </span>
          Merged from
        </button>{' '}
        <button type="button" className="quiet inline" onClick={() => onOpenSource(merge.sourceThreadId)}>
          {merge.sourceTitle || 'a thread'}
        </button>
        {merge.quote && (
          <>
            {' '}
            about <q>{shortQuote(merge.quote)}</q>
          </>
        )}
      </div>
      {!open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the toggle button above is the keyboard path
        // biome-ignore lint/a11y/noStaticElementInteractions: as above
        <p className="merge-preview" onClick={() => toggle(true)} data-testid="merge-preview">
          {mergePreview(merge.summary)}
        </p>
      )}
      <div id={bodyId} hidden={!open}>
        <div className="merge-body">
          <CiteContext.Provider value={{ refs: merge.refs, go: onCite }}>
            <Markdown source={merge.summary} />
          </CiteContext.Provider>
        </div>
        <p className="merge-foot">
          The AI sees this from the next question on.{' '}
          <button type="button" className="quiet inline faint" onClick={onUndo} data-testid="merge-undo">
            Undo merge
          </button>
        </p>
      </div>
    </section>
  );
}

/**
 * In the source thread: the draft being prepared, edited and accepted, or
 * the merges already done.
 */
export function OutgoingMerges({
  merges,
  onChange,
  onOpenTarget,
  onCite,
}: {
  merges: Merge[];
  onChange: (merge: Merge) => void;
  onOpenTarget: (threadId: string) => void;
  onCite: (threadId: string, messageId: string) => void;
}) {
  return (
    <>
      {merges.map((m) =>
        m.status === 'merged' ? (
          <p key={m.id} className="merge-done" data-testid="merge-done">
            ⤶ Merged into{' '}
            <button type="button" className="quiet inline" onClick={() => onOpenTarget(m.targetThreadId)}>
              {m.targetTitle || 'Untitled'}
            </button>
            .{' '}
            <button
              type="button"
              className="quiet inline faint"
              onClick={() => void api.undoMerge(m.id).then(onChange)}
              data-testid="merge-done-undo"
            >
              Undo
            </button>
          </p>
        ) : (
          <MergeDraft key={m.id} merge={m} onChange={onChange} onCite={onCite} />
        ),
      )}
    </>
  );
}

function MergeDraft({
  merge,
  onChange,
  onCite,
}: {
  merge: Merge;
  onChange: (merge: Merge) => void;
  onCite: (threadId: string, messageId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Follow the AI while it drafts.
  useEffect(() => {
    if (merge.status !== 'drafting') return;
    const t = setTimeout(() => {
      api.merge(merge.id).then(onChange, () => {});
    }, 600);
    return () => clearTimeout(t);
  }, [merge, onChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: grow with the text
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [editing]);

  const run = async (call: () => Promise<Merge>) => {
    try {
      onChange(await call());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async () => {
    if (editing === null) return;
    const text = editing.trim();
    setEditing(null);
    if (text && text !== merge.summary) await run(() => api.editMerge(merge.id, text));
  };

  const drafting = merge.status === 'drafting';
  return (
    <section className="merge-draft" data-testid="merge-draft" data-status={merge.status}>
      <p className="merge-head">
        ⤶ Merge into <strong>{merge.targetTitle || 'Untitled'}</strong>
        <span className="merge-mode">
          {merge.mode === 'full' ? ' · the whole exchange' : ' · a summary by the AI'}
        </span>
      </p>
      {merge.replaces && (
        <p className="merge-explain" data-testid="merge-replaces">
          This replaces the earlier merge of this thread there.
        </p>
      )}
      <p className="merge-explain">
        {merge.mode === 'full'
          ? 'These exchanges will go in front of the next question there.'
          : 'Check what the AI kept. This will go in front of the next question there; nothing already said changes.'}
      </p>
      {editing !== null ? (
        <div className="nblock-editor">
          <textarea
            ref={ref}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            spellCheck={false}
            aria-label="What to merge (Markdown)"
            data-testid="merge-textarea"
          />
        </div>
      ) : (
        <div className="merge-body">
          {merge.summary ? (
            <CiteContext.Provider value={{ refs: merge.refs, go: onCite }}>
              <Markdown source={merge.summary} />
            </CiteContext.Provider>
          ) : (
            drafting && <span className="thinking">Writing the summary…</span>
          )}
          {drafting && merge.summary && <span className="caret" aria-hidden />}
        </div>
      )}
      {merge.status === 'failed' && <p className="status status-bad">{merge.error}</p>}
      {error && <p className="status status-bad">{error}</p>}
      {!drafting && (
        <div className="proposal-actions">
          {editing !== null ? (
            <>
              <button type="button" onClick={() => void save()} data-testid="merge-save">
                Save
              </button>
              <button type="button" className="quiet" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {merge.status === 'draft' && (
                <button type="button" onClick={() => void run(() => api.acceptMerge(merge.id))} data-testid="merge-accept">
                  Merge
                </button>
              )}
              <button type="button" className="quiet" onClick={() => setEditing(merge.summary)} data-testid="merge-edit">
                Edit
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => void run(() => api.redraftMerge(merge.id, merge.mode === 'full' ? 'summary' : 'full'))}
                data-testid="merge-switch"
              >
                {merge.mode === 'full' ? 'Use a summary instead' : 'Use the whole exchange instead'}
              </button>
              {merge.mode === 'summary' && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => void run(() => api.redraftMerge(merge.id, 'summary'))}
                  data-testid="merge-retry"
                >
                  Try again
                </button>
              )}
              <button
                type="button"
                className="quiet"
                onClick={() => void run(() => api.discardMerge(merge.id))}
                data-testid="merge-discard"
              >
                Cancel merge
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Pick the thread to merge into: any thread but this one and the side questions below it. */
export function MergePicker({
  threads,
  from,
  onPick,
  onCancel,
}: {
  threads: Thread[];
  from: string;
  onPick: (threadId: string) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState('');
  const below = new Set<string>([from]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of threads) {
      if (t.parentThreadId && below.has(t.parentThreadId) && !below.has(t.id)) {
        below.add(t.id);
        grew = true;
      }
    }
  }
  const q = filter.trim().toLowerCase();
  const options = threads
    .filter((t) => !below.has(t.id) && (q === '' || t.title.toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30);
  return (
    <section className="askbox merge-picker" data-testid="merge-picker">
      <div className="askbox-row">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          placeholder="Merge into which thread?"
          aria-label="Find a thread"
          // biome-ignore lint/a11y/noAutofocus: opened by the learner to choose a thread
          autoFocus
        />
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ul className="merge-options">
        {options.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => onPick(t.id)} data-testid="merge-option" data-thread-id={t.id}>
              {t.parentThreadId && !t.splitAt ? '↳ ' : ''}
              {t.title || 'Untitled'}
            </button>
          </li>
        ))}
        {options.length === 0 && <li className="map-empty">No other thread to merge into.</li>}
      </ul>
    </section>
  );
}
