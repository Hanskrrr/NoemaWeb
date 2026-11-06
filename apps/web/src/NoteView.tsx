// A note: an editable document the AI wrote from a thread on request.
// Citations jump to the exact exchange. Editing keeps every earlier version,
// and an edited AI draft is labelled as such. The chat is never changed.

import type { Note } from '@noema/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { CiteContext, Markdown } from './markdown/Markdown.tsx';

const AUTHOR: Record<Note['author'], string> = {
  ai: 'Written by AI from the thread',
  'ai+user': 'AI draft, edited by you',
  user: 'Written by you',
};

export function NoteView({
  noteId,
  onCite,
  onOpenThread,
  onChanged,
}: {
  noteId: string;
  onCite: (threadId: string, messageId: string) => void;
  onOpenThread: (threadId: string) => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
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
      setError(err instanceof ApiFailure ? err.message : String(err));
      return null;
    }
  }, [noteId, onChanged]);

  // While the note is being written, follow it as it grows.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const n = await load();
      if (!cancelled && n?.status === 'generating') timer = setTimeout(tick, 600);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const startEdit = () => {
    if (!note) return;
    setTitle(note.title);
    setContent(note.content);
    setEditing(true);
  };

  const save = async () => {
    if (!note) return;
    setSaving(true);
    try {
      setNote(await api.editNote(note.id, { title: title.trim() || note.title, content }));
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const again = async () => {
    if (!note) return;
    try {
      await api.rewriteNoteAgain(note.id);
      wasWriting.current = true;
      const tick = async () => {
        const n = await load();
        if (n?.status === 'generating') setTimeout(tick, 600);
      };
      void tick();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : String(err));
    }
  };

  if (error && !note) return <main className="thread note-page">{error}</main>;
  if (!note) return <main className="thread note-page" aria-busy />;
  const writing = note.status === 'generating';

  return (
    <main className="thread note-page" data-testid="note" data-status={note.status}>
      <header className="note-head">
        <p className="map-kicker">Note</p>
        {editing ? (
          <input
            className="title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Note title"
            data-testid="note-title-input"
          />
        ) : (
          <h1>{note.title || 'Untitled'}</h1>
        )}
        <p className="note-meta">
          <span className={`note-author author-${note.author.replace('+', '-')}`} data-testid="note-author">
            {AUTHOR[note.author]}
          </span>
          {note.revision > 0 && <span> · version {note.revision}</span>}
        </p>
        <div className="thread-actions">
          {note.threadId && (
            <button type="button" className="quiet" onClick={() => onOpenThread(note.threadId as string)}>
              ← The thread
            </button>
          )}
          {!editing && !writing && (
            <button type="button" className="quiet" onClick={startEdit} data-testid="note-edit">
              Edit
            </button>
          )}
          {!editing && !writing && note.threadId && (
            <button type="button" className="quiet" onClick={() => void again()} data-testid="note-again">
              Rewrite again
            </button>
          )}
        </div>
      </header>

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

      {editing ? (
        <div className="note-editor">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            aria-label="Note text (Markdown)"
            data-testid="note-textarea"
          />
          <div className="form-actions">
            <button type="button" onClick={() => void save()} disabled={saving} data-testid="note-save">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="quiet" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <span className="form-note">Markdown. The previous version is kept.</span>
          </div>
        </div>
      ) : (
        <article className="note-body message-assistant">
          <div className="message-body">
            <CiteContext.Provider value={{ refs: note.refs, go: onCite }}>
              <Markdown source={note.content} />
            </CiteContext.Provider>
            {writing && (
              <span className="thinking">{note.content ? <span className="caret" aria-hidden /> : 'Writing the note…'}</span>
            )}
          </div>
        </article>
      )}
    </main>
  );
}
