// A note: a document of blocks (paragraphs, headings, lists, tables,
// formulas, code) the learner edits in place, like cells in a notebook.
// Click a block to edit it; hover between blocks to write a new one or ask
// the AI for one. The AI never changes the note by itself: what it writes
// arrives as a suggestion under the block, to replace, discard or try again.
// Citations ([E3]) open the exchange they came from beside the note, which
// stays where it is. Every change is kept as a version on the server.

import { headingLevel, type Note, type NoteBlock, type NoteSummary, plainText, sectionOf, ulid } from '@noema/core';
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { citationOrder } from './citations.ts';
import { EditableTitle } from './EditableTitle.tsx';
import { arrive, clearFound } from './found.ts';
import { Outline, type OutlineItem, shortLabel } from './Outline.tsx';
import { CiteContext, Markdown } from './markdown/Markdown.tsx';
import { RefPane } from './RefPane.tsx';

const AUTHOR: Record<Note['author'], string> = {
  ai: 'Written by AI from the thread',
  'ai+user': 'Written by AI and you',
  user: 'Written by you',
};

const BLOCK_AUTHOR: Record<NoteBlock['author'], string> = {
  ai: 'Written by AI',
  'ai+user': 'AI, edited by you',
  user: 'Written by you',
};

const QUICK = ['Simpler', 'More detail', 'Add an example', 'Shorter'];

type Editing = { id: string; draft: string; after: string | null; isNew: boolean };
type Toast = { text: string; action?: { label: string; run: () => void; testId: string } };

/** The catalog of a note: its headings, by level. */
function headingsOf(blocks: NoteBlock[]): OutlineItem[] {
  return blocks.flatMap((b) => {
    const level = headingLevel(b.content);
    if (level === null) return [];
    return [
      {
        id: b.id,
        label: shortLabel(b.content.replace(/^\s*#+\s*/, '').replace(/[\s#]+$/, '').replace(/(\*\*|__|`)(.+?)\1/g, '$2')),
        level: Math.min(3, level) as 1 | 2 | 3,
        kind: 'heading' as const,
        target: `[data-block-id="${b.id}"]`,
      },
    ];
  });
}

/** A block's first sentence (or first words), as plain text, for the catalog. */
function blockLabel(content: string): string {
  const text = plainText(content)
    .replace(/\|/g, ' ')
    .replace(/^\s*\$\$\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = /^(.{4,60}?(?:[。！？!?]|\.(?=\s|$)))/.exec(text)?.[1];
  return shortLabel(sentence ?? text, 60);
}

/**
 * The catalog of a note: its headings, when it has at least two; otherwise,
 * once the note is long enough to need one, every block by its first words
 * (a note written by hand often has no headings).
 */
function catalogOf(blocks: NoteBlock[]): OutlineItem[] {
  const written = blocks.filter((b) => b.content.trim() !== '');
  const headings = headingsOf(written);
  if (headings.length >= 2) return headings;
  if (written.length < 4) return [];
  return written.map((b) => {
    const isHeading = headingLevel(b.content) !== null;
    return {
      id: b.id,
      label: blockLabel(b.content) || '…',
      level: headings.length > 0 && !isHeading ? 2 : 1,
      kind: 'heading' as const,
      target: `[data-block-id="${b.id}"]`,
    };
  });
}

/** The AI is writing the note, or a suggestion in it. */
const busy = (n: Note | null) =>
  n !== null && (n.status === 'generating' || n.blocks.some((b) => b.proposal?.status === 'generating'));

function errorText(err: unknown): string {
  return err instanceof ApiFailure ? err.message : 'Something went wrong. Try again.';
}

export function NoteView({
  noteId,
  onRestore,
  block: soughtBlock,
  onCite,
  onOpenThread,
  onOpenNote,
  notes,
  onChanged,
  onDeleted,
  openRef,
  refIn,
  onRef,
}: {
  noteId: string;
  /** The citation whose exchange is open beside the note ([E2]). */
  openRef?: string | undefined;
  /** The block it was cited in: brought back into view when coming back to the note. */
  refIn?: string | undefined;
  /** Open the exchange of a citation beside the note (null: close it), cited in this block. */
  onRef: (label: string | null, blockId?: string) => void;
  /** Bring it back from the Trash. */
  onRestore?: (() => void) | undefined;
  /** Open at this block (from search): scrolled to, flashed, the words searched for marked. */
  block?: string | undefined;
  /** The notebook's notes, to choose one to merge in. */
  notes: NoteSummary[];
  onCite: (threadId: string, messageId: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenNote: (noteId: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [asking, setAsking] = useState<{ after: string | null } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [merging, setMerging] = useState<{ from: NoteSummary | null } | null>(null);
  const wasWriting = useRef(false);

  const load = useCallback(async () => {
    try {
      const n = await api.note(noteId);
      setNote(n);
      if (n.status === 'generating') wasWriting.current = true;
      else if (wasWriting.current) {
        wasWriting.current = false;
        onChanged();
      }
      return n;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, [noteId, onChanged]);

  // Follow the note while the AI writes it, or writes a suggestion.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const n = await load();
      if (!cancelled && busy(n)) timer = setTimeout(poll, 600);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, tick]);
  const follow = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Run a change; the server answers with the whole note. */
  const change = async (run: () => Promise<Note>, after?: (n: Note) => void) => {
    try {
      const n = await run();
      setNote(n);
      setError(null);
      after?.(n);
      onChanged();
      if (busy(n)) follow();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Opened at one block: go there once it is on the page.
  const sought = useRef(false);
  useEffect(() => {
    if (!soughtBlock || sought.current || !note) return;
    const el = document.querySelector(`[data-block-id="${soughtBlock}"]`);
    if (!el) return;
    sought.current = true;
    arrive(el, soughtBlock);
  }, [soughtBlock, note]);
  useEffect(() => () => clearFound(), []);

  // Coming back to the note (from the thread a citation opened): the block it was cited in.
  const returned = useRef(false);
  useEffect(() => {
    if (soughtBlock || !refIn || returned.current || !note) return;
    const el = document.querySelector(`[data-block-id="${refIn}"]`);
    if (!el) return;
    returned.current = true;
    el.scrollIntoView({ block: 'center' });
  }, [soughtBlock, refIn, note]);
  // The pane narrows the note: keep the citation just clicked in view.
  useLayoutEffect(() => {
    if (!openRef) return;
    const scope = refIn ? document.querySelector(`[data-block-id="${refIn}"]`) : document;
    scope?.querySelector(`[data-testid=cite][data-label="${openRef}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [openRef, refIn]);

  if (error && !note) return <main className="thread note-page">{error}</main>;
  if (!note) return <main className="thread note-page" aria-busy />;
  const writing = note.status === 'generating';
  const trashed = note.deletedAt !== null;
  const blocks = note.blocks;
  const catalog = catalogOf(blocks);
  const cited = openRef && openRef in note.refs ? openRef : undefined;
  const cites = {
    refs: note.refs,
    go: onCite,
    open: (label: string, button: HTMLElement) =>
      label === cited
        ? onRef(null)
        : onRef(label, button.closest('[data-block-id]')?.getAttribute('data-block-id') ?? undefined),
    current: cited,
  };

  const save = async (e: Editing) => {
    setEditing(null);
    const text = e.draft;
    if (e.isNew) {
      if (text.trim() === '') return;
      await change(() => api.insertBlock(note.id, { id: e.id, after: e.after, content: text }));
    } else {
      const before = blocks.find((b) => b.id === e.id)?.content;
      if (text === before) return;
      await change(() => api.editBlock(note.id, e.id, text));
    }
  };

  const remove = (block: NoteBlock) =>
    change(
      () => api.deleteBlock(note.id, block.id),
      () =>
        setToast({
          text: 'Block deleted.',
          action: {
            label: 'Undo',
            testId: 'undo',
            run: () => void change(() => api.restoreBlock(note.id, block.id)),
          },
        }),
    );

  const move = (block: NoteBlock, dir: -1 | 1) => {
    const i = blocks.findIndex((b) => b.id === block.id);
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    // Up: after the block two above (or at the top). Down: after the next one.
    const after = dir === -1 ? (blocks[i - 2]?.id ?? null) : (blocks[j]?.id as string);
    void change(() => api.moveBlock(note.id, block.id, after));
  };

  /** A section (a heading and what is under it), or this block and everything below it, into a new note. */
  const moveOut = (block: NoteBlock, what: 'section' | 'below') => {
    const i = blocks.findIndex((b) => b.id === block.id);
    const ids =
      what === 'section'
        ? sectionOf(
            blocks.map((b) => b.content),
            i,
          ).map((k) => blocks[k]?.id as string)
        : blocks.slice(i).map((b) => b.id);
    const newId = ulid();
    void (async () => {
      try {
        const created = await api.moveOut(note.id, newId, ids);
        setNote(await api.note(note.id));
        onChanged();
        setToast({
          text: `Moved ${ids.length} ${ids.length === 1 ? 'block' : 'blocks'} to “${created.title}”.`,
          action: { label: 'Open', testId: 'open-moved', run: () => onOpenNote(created.id) },
        });
      } catch (err) {
        setError(errorText(err));
      }
    })();
  };

  const suggest = (block: NoteBlock, instruction: string) => {
    setMenu(null);
    void change(() => api.suggest(note.id, block.id, instruction));
  };

  const ask = (after: string | null, instruction: string) => {
    setAsking(null);
    void change(() => api.insertBlock(note.id, { id: ulid(), after, ask: instruction }));
  };

  const mergeIn = (from: NoteSummary) =>
    change(
      () => api.mergeNote(note.id, from.id),
      () => {
        setMerging(null);
        setToast({ text: `Merged “${from.title}” into this note.` });
      },
    );

  const startWriting = (after: string | null) => {
    setAsking(null);
    setEditing({ id: ulid(), draft: '', after, isNew: true });
  };

  // The gap above each block, and one at the end, where new blocks go.
  const gap = (after: string | null, last = false) => {
    if (writing || trashed) return null;
    const newHere = editing?.isNew && editing.after === after ? editing : null;
    const askingHere = asking && asking.after === after;
    return (
      <>
        {newHere && (
          <BlockEditor
            key={newHere.id}
            editing={newHere}
            onChange={(draft) => setEditing({ ...newHere, draft })}
            onSave={() => void save(newHere)}
            onCancel={() => setEditing(null)}
          />
        )}
        {askingHere ? (
          <AskBox
            placeholder={note.threadId ? 'What should go here? e.g. a worked example, a summary of E3–E5' : 'What should go here?'}
            onSend={(text) => ask(after, text)}
            onCancel={() => setAsking(null)}
          />
        ) : (
          !newHere && (
            <div className={`gap${last ? ' gap-last' : ''}`} data-testid={last ? 'gap-end' : 'gap'}>
              <button type="button" className="quiet" onClick={() => startWriting(after)} data-testid="gap-write">
                + Write
              </button>
              <button type="button" className="quiet" onClick={() => setAsking({ after })} data-testid="gap-ask">
                ✦ Ask AI
              </button>
            </div>
          )
        )}
      </>
    );
  };

  return (
    <div className={`note-layout${cited ? ' with-ref' : ''}`}>
      <main className="thread note-page" data-testid="note" data-status={note.status}>
        <header className="note-head">
          <p className="map-kicker">Note</p>
          <EditableTitle
            title={note.title}
            onRename={(title) => change(() => api.renameNote(note.id, title))}
            label="Note title"
            testId="note-rename"
            inputTestId="note-title-input"
          />
          <p className="note-meta">
            <span className={`note-author author-${note.author.replace('+', '-')}`} data-testid="note-author">
              {AUTHOR[note.author]}
            </span>
            {note.revision > 0 && <span> · version {note.revision}</span>}
            {note.threadId && (
              <>
                {' · '}
                <button type="button" className="quiet inline" onClick={() => onOpenThread(note.threadId as string)}>
                  open the thread
                </button>
              </>
            )}
            {' · '}
            <button
              type="button"
              className="quiet inline"
              onClick={() => setMerging(merging ? null : { from: null })}
              data-testid="note-merge"
            >
              merge a note in
            </button>
            {' · '}
            {confirmDelete ? (
              <span className="confirm">
                {note.threadId ? 'Delete this note? The thread stays.' : 'Delete this note?'}
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void api.deleteNote(note.id).then(onDeleted, (err: unknown) => setError(errorText(err)))
                  }
                  data-testid="note-delete-confirm"
                >
                  Delete
                </button>
                <button type="button" className="quiet" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="quiet inline faint" onClick={() => setConfirmDelete(true)} data-testid="note-delete">
                delete
              </button>
            )}
          </p>
          <p className="note-legend">
            <span className="legend-label">Who wrote each block:</span>
            <span className="legend-ai">AI</span>
            <span className="legend-mixed">AI, edited by you</span>
            <span className="legend-user">you</span>
          </p>
        </header>

        {merging && (
          <section className="askbox merge-picker" data-testid="note-merge-picker">
            {merging.from ? (
              <div className="askbox-row confirm-row">
                <span>
                  Move all blocks of “{merging.from.title}” to the end of this note, and remove “{merging.from.title}”?
                </span>
                <button
                  type="button"
                  onClick={() => merging.from && void mergeIn(merging.from)}
                  data-testid="note-merge-confirm"
                >
                  Merge
                </button>
                <button type="button" className="quiet" onClick={() => setMerging(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <p className="merge-explain">Bring which note into this one? Its citations keep working.</p>
                <ul className="merge-options">
                  {notes
                    .filter((n) => n.id !== note.id && n.status !== 'generating')
                    .map((n) => (
                      <li key={n.id}>
                        <button type="button" onClick={() => setMerging({ from: n })} data-testid="note-merge-option">
                          {n.title || 'Untitled'}
                        </button>
                      </li>
                    ))}
                  {notes.filter((n) => n.id !== note.id).length === 0 && <li className="map-empty">No other note.</li>}
                </ul>
              </>
            )}
          </section>
        )}
        {error && (
          <p className="status status-bad" role="alert">
            {error}
          </p>
        )}
        {note.status === 'failed' && (
          <p className="status status-bad" role="alert">
            {note.error ?? 'The note could not be written.'}
          </p>
        )}

        {trashed && (
          <div className="in-trash" role="status" data-testid="in-trash">
            This note is in the Trash.
            <button
              type="button"
              onClick={() =>
                void api.restoreNote(note.id).then((n) => {
                  setNote(n);
                  onRestore?.();
                }, (err: unknown) => setError(errorText(err)))
              }
              data-testid="restore"
            >
              Restore
            </button>
          </div>
        )}
        <CiteContext.Provider value={cites}>
          {trashed ? (
            <article className="note-body message-assistant">
              <div className="message-body">
                <Markdown source={note.content} />
              </div>
            </article>
          ) : writing ? (
            <article className="note-body message-assistant">
              <div className="message-body">
                <Markdown source={note.content} />
                <span className="thinking">
                  {note.content ? <span className="caret" aria-hidden /> : 'Writing the note…'}
                </span>
              </div>
            </article>
          ) : (
            <div className="blocks" data-testid="blocks">
              {blocks.length === 0 && !editing && !asking && (
                <p className="blocks-empty">An empty note. Write the first block, or ask the AI for one.</p>
              )}
              {blocks.map((block, i) => (
                <div key={block.id} className="block-slot">
                  {gap(i === 0 ? null : (blocks[i - 1]?.id as string))}
                  <BlockView
                    block={block}
                    first={i === 0}
                    last={i === blocks.length - 1}
                    editing={editing && !editing.isNew && editing.id === block.id ? editing : null}
                    menuOpen={menu === block.id}
                    hasThread={note.threadId !== null}
                    onEdit={() => {
                      setAsking(null);
                      setEditing({ id: block.id, draft: block.content, after: null, isNew: false });
                    }}
                    onDraft={(draft) => setEditing((e) => (e ? { ...e, draft } : e))}
                    onSave={() => editing && void save(editing)}
                    onCancel={() => setEditing(null)}
                    onMenu={(open) => setMenu(open ? block.id : null)}
                    onSuggest={(text) => suggest(block, text)}
                    onAccept={() => void change(() => api.accept(note.id, block.id))}
                    onDiscard={() => void change(() => api.discard(note.id, block.id))}
                    onRetry={() => block.proposal && suggest(block, block.proposal.instruction)}
                    onMove={(dir) => move(block, dir)}
                    onMoveOut={(what) => moveOut(block, what)}
                    onDelete={() => void remove(block)}
                  />
                </div>
              ))}
              {gap(blocks.at(-1)?.id ?? null, true)}
            </div>
          )}
        </CiteContext.Provider>

        {!writing && !cited && catalog.length > 0 && <Outline items={catalog} label="Catalog of this note" />}

        {toast && (
          <div className="toast" role="status" data-testid="toast">
            {toast.text}
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
                data-testid={toast.action.testId}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </main>
      {cited && (
        <RefPane
          label={cited}
          refs={note.refs}
          order={citationOrder(note.content, note.refs)}
          onStep={(label) => onRef(label, refIn)}
          onOpenThread={onCite}
          onClose={() => onRef(null)}
        />
      )}
    </div>
  );
}

function BlockView({
  block,
  first,
  last,
  editing,
  menuOpen,
  hasThread,
  onEdit,
  onDraft,
  onSave,
  onCancel,
  onMenu,
  onSuggest,
  onAccept,
  onDiscard,
  onRetry,
  onMove,
  onMoveOut,
  onDelete,
}: {
  block: NoteBlock;
  first: boolean;
  last: boolean;
  editing: Editing | null;
  menuOpen: boolean;
  hasThread: boolean;
  onEdit: () => void;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onMenu: (open: boolean) => void;
  onSuggest: (instruction: string) => void;
  onAccept: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onMove: (dir: -1 | 1) => void;
  onMoveOut: (what: 'section' | 'below') => void;
  onDelete: () => void;
}) {
  const isNewAi = block.content === '';
  const heading = headingLevel(block.content) !== null;
  const generating = block.proposal?.status === 'generating';

  // Click to edit, unless the click was on a citation or link, or ended a text selection.
  const click = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onEdit();
  };

  return (
    <div
      className={`nblock${editing ? ' editing' : ''}${menuOpen ? ' menu-open' : ''}`}
      data-author={block.author}
      data-testid="block"
      data-block-id={block.id}
    >
      {!isNewAi &&
        (editing ? (
          <BlockEditor editing={editing} onChange={onDraft} onSave={onSave} onCancel={onCancel} />
        ) : (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the Edit button in the toolbar is the keyboard path
          // biome-ignore lint/a11y/noStaticElementInteractions: as above
          <div className="nblock-body" onClick={click} title={BLOCK_AUTHOR[block.author]}>
            <Markdown source={block.content} />
          </div>
        ))}
      {!isNewAi && !editing && (
        <div className="nblock-tools" role="toolbar" aria-label="Block">
          <button type="button" onClick={onEdit} title="Edit" data-testid="block-edit">
            Edit
          </button>
          <button
            type="button"
            onClick={() => onMenu(!menuOpen)}
            disabled={generating}
            title="Ask the AI for a new version of this block"
            data-testid="block-ai"
          >
            ✦ AI
          </button>
          <button type="button" onClick={() => onMove(-1)} disabled={first} title="Move up" data-testid="block-up">
            ↑
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={last} title="Move down" data-testid="block-down">
            ↓
          </button>
          {heading && (
            <button
              type="button"
              onClick={() => onMoveOut('section')}
              title="Move this heading and what is under it to a new note"
              data-testid="block-move-out"
            >
              Section → new note
            </button>
          )}
          <button
            type="button"
            onClick={() => onMoveOut('below')}
            title="Move this block and everything below it to a new note"
            data-testid="block-split"
          >
            Split here
          </button>
          <button type="button" onClick={onDelete} title="Delete" data-testid="block-delete">
            Delete
          </button>
        </div>
      )}
      {menuOpen && (
        <AskBox
          quick={hasThread ? [...QUICK, 'Check it against the conversation'] : QUICK}
          placeholder="Or say what to change…"
          onSend={onSuggest}
          onCancel={() => onMenu(false)}
        />
      )}
      {block.proposal && (
        <section className="proposal" data-testid="proposal" data-status={block.proposal.status}>
          <p className="proposal-head">
            ✦ AI suggestion · <q>{block.proposal.instruction}</q>
          </p>
          {block.proposal.text && (
            <div className="proposal-body">
              <Markdown source={block.proposal.text} />
            </div>
          )}
          {generating && <span className="thinking">{block.proposal.text ? <span className="caret" /> : 'Writing…'}</span>}
          {block.proposal.status === 'failed' && <p className="status status-bad">{block.proposal.error}</p>}
          {!generating && (
            <div className="proposal-actions">
              {block.proposal.status === 'ready' && (
                <button type="button" onClick={onAccept} data-testid="proposal-accept">
                  {isNewAi ? 'Add to note' : 'Replace'}
                </button>
              )}
              <button type="button" className="quiet" onClick={onDiscard} data-testid="proposal-discard">
                Discard
              </button>
              <button type="button" className="quiet" onClick={onRetry} data-testid="proposal-retry">
                Try again
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** A block being written or edited: raw Markdown, growing with its text. */
function BlockEditor({
  editing,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Editing;
  onChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grow whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [editing.draft]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      cancelled.current = true;
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ref.current?.blur();
    }
  };

  return (
    <div className="nblock-editor">
      <textarea
        ref={ref}
        value={editing.draft}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!cancelled.current) onSave();
        }}
        onKeyDown={key}
        spellCheck={false}
        aria-label="Block text (Markdown)"
        placeholder="Write in Markdown. $math$ and [E3] citations work."
        data-testid="block-textarea"
      />
      <p className="nblock-hint">Click away or ⌘/Ctrl+Enter to save · Esc to cancel</p>
    </div>
  );
}

/** A short instruction for the AI, with optional one-click choices. */
function AskBox({
  quick = [],
  placeholder,
  onSend,
  onCancel,
}: {
  quick?: string[];
  placeholder: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <form
      className="askbox"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
      data-testid="askbox"
    >
      {quick.length > 0 && (
        <div className="askbox-quick">
          {quick.map((q) => (
            <button key={q} type="button" onClick={() => onSend(q)} data-testid="ask-quick">
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="askbox-row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          placeholder={placeholder}
          aria-label="Instruction for the AI"
          maxLength={1000}
          // biome-ignore lint/a11y/noAutofocus: opened by the learner to type an instruction
          autoFocus
          data-testid="ask-input"
        />
        <button type="submit" disabled={!text.trim()} data-testid="ask-send">
          Ask
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
