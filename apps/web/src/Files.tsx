// Folders on this computer (ADR 0025), like the file list of a code editor:
// link a folder by its path, open its folders, click a file to read it as a
// source (asked about, cited and searched like any other). Noema reads the
// files in place; it writes into the folder only when asked: a file edited
// here, a note saved into it.

import { type FileEntry, type Folder, isMarkdownFile, type Note, type Source, ulid } from '@noema/core';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { keys, storage } from './storage.ts';

function errorText(err: unknown): string {
  return err instanceof ApiFailure ? err.message : 'Something went wrong. Try again.';
}

const keyOf = (folderId: string, dir: string) => `${folderId}:${dir}`;
type Listing = FileEntry[] | 'loading' | { error: string };

/** A glyph for what a file is: Markdown, a PDF, code or other text; nothing readable. */
function fileGlyph(name: string, readable: boolean): string {
  if (!readable) return '·';
  if (isMarkdownFile(name)) return '¶';
  if (/\.pdf$/i.test(name)) return '▤';
  if (/\.(txt|csv|tsv|log|rst|tex|bib)$/i.test(name) || !/\./.test(name)) return '≡';
  return '‹›';
}

export function FilesPanel({
  notebookId,
  activeSourceId,
  onOpened,
}: {
  notebookId: string;
  /** The source open now: its file is marked. */
  activeSourceId: string | null;
  /** A file was opened as a source. */
  onOpened: (source: Source) => void;
}) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [path, setPath] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string[]>(() => storage.getJson<string[]>(keys.filesOpen, []));
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [fileError, setFileError] = useState<{ key: string; message: string } | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const pathInput = useRef<HTMLInputElement>(null);

  const list = useCallback(async (folderId: string, dir: string) => {
    const key = keyOf(folderId, dir);
    setListings((m) => new Map(m).set(key, m.get(key) ?? 'loading'));
    try {
      const { entries } = await api.folderTree(folderId, dir);
      setListings((m) => new Map(m).set(key, entries));
    } catch (err) {
      setListings((m) => new Map(m).set(key, { error: errorText(err) }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.folders(notebookId);
      setFolders(r.folders);
      setProblem(null);
      // A folder linked for the first time shows its files.
      for (const f of r.folders) if (!f.missing) void list(f.id, '');
    } catch (err) {
      setProblem(errorText(err));
    }
  }, [notebookId, list]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: what was open is listed again once, when the panel is shown
  useEffect(() => {
    void load().then(() => {
      for (const key of opened) {
        const at = key.indexOf(':');
        if (at > 0 && key.slice(at + 1)) void list(key.slice(0, at), key.slice(at + 1));
      }
    });
  }, [load]);

  useEffect(() => {
    if (linking) pathInput.current?.focus();
  }, [linking]);

  const setOpen = (key: string, open: boolean) => {
    const next = open ? [...new Set([...opened, key])] : opened.filter((k) => k !== key);
    setOpened(next);
    storage.setJson(keys.filesOpen, next);
  };
  const isOpen = (folderId: string, dir: string) =>
    dir === '' ? !opened.includes(`${keyOf(folderId, '')}closed`) : opened.includes(keyOf(folderId, dir));
  const toggle = (folderId: string, dir: string) => {
    const open = isOpen(folderId, dir);
    if (dir === '') setOpen(`${keyOf(folderId, '')}closed`, open);
    else setOpen(keyOf(folderId, dir), !open);
    if (!open) void list(folderId, dir);
  };

  const link = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setLinkError(null);
    try {
      const f = await api.linkFolder(notebookId, ulid(), path.trim());
      setPath('');
      setLinking(false);
      setFolders((fs) => [...(fs ?? []).filter((x) => x.id !== f.id), f]);
      void list(f.id, '');
    } catch (err) {
      setLinkError(errorText(err));
    }
  };

  const unlink = async (f: Folder) => {
    setUnlinking(null);
    try {
      await api.unlinkFolder(f.id);
      setFolders((fs) => (fs ?? []).filter((x) => x.id !== f.id));
    } catch (err) {
      setProblem(errorText(err));
    }
  };

  // Listed again: what is open of this folder.
  const reload = (f: Folder) => {
    void list(f.id, '');
    for (const key of opened) if (key.startsWith(`${f.id}:`) && !key.endsWith('closed')) void list(f.id, key.slice(f.id.length + 1));
  };

  const openFile = async (f: Folder, e: FileEntry) => {
    const key = keyOf(f.id, e.path);
    setBusy(key);
    setFileError(null);
    try {
      const source = await api.openFile(f.id, e.path);
      // It is a source now: marked in the list.
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      setListings((m) => {
        const got = m.get(keyOf(f.id, dir));
        if (!Array.isArray(got)) return m;
        return new Map(m).set(
          keyOf(f.id, dir),
          got.map((x) => (x.path === e.path ? { ...x, sourceId: source.id } : x)),
        );
      });
      onOpened(source);
    } catch (err) {
      setFileError({ key, message: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const rows = (f: Folder, dir: string, depth: number): ReactNode => {
    const got = listings.get(keyOf(f.id, dir));
    const pad = { paddingLeft: `${0.35 + depth * 0.85}rem` };
    if (!got || got === 'loading') {
      return (
        <li className="file-note" style={pad}>
          Listing…
        </li>
      );
    }
    if (!Array.isArray(got)) {
      return (
        <li className="file-note is-error" style={pad} role="alert">
          {got.error}
        </li>
      );
    }
    if (got.length === 0) {
      return (
        <li className="file-note" style={pad}>
          Empty
        </li>
      );
    }
    return got.map((e) => {
      const key = keyOf(f.id, e.path);
      if (e.kind === 'dir') {
        const open = isOpen(f.id, e.path);
        return (
          <li key={key}>
            <button
              type="button"
              className="file-row is-dir"
              style={pad}
              onClick={() => toggle(f.id, e.path)}
              aria-expanded={open}
              data-testid="file-dir"
              data-path={e.path}
            >
              <span className="file-caret" aria-hidden>
                {open ? '▾' : '▸'}
              </span>
              <span className="file-name">{e.name}</span>
            </button>
            {open && <ul className="file-list">{rows(f, e.path, depth + 1)}</ul>}
          </li>
        );
      }
      const active = e.sourceId !== null && e.sourceId === activeSourceId;
      return (
        <li key={key}>
          <button
            type="button"
            className={`file-row${active ? ' active' : ''}${e.readable ? '' : ' unreadable'}${e.sourceId ? ' is-source' : ''}`}
            style={pad}
            onClick={() => void openFile(f, e)}
            disabled={!e.readable || busy === key}
            aria-current={active ? 'page' : undefined}
            title={
              e.readable
                ? `${e.path}${e.sourceId ? ' · opened as a source' : ''}`
                : `${e.path}: not text (a picture, an archive or a program?), so it cannot be read here`
            }
            data-testid="file-link"
            data-path={e.path}
          >
            <span className="file-caret file-glyph" aria-hidden>
              {fileGlyph(e.name, e.readable)}
            </span>
            <span className="file-name">{e.name}</span>
            {busy === key && <span className="file-busy"> · opening…</span>}
          </button>
          {fileError?.key === key && (
            <p className="file-note is-error" style={pad} role="alert">
              {fileError.message}
            </p>
          )}
        </li>
      );
    });
  };

  return (
    <>
      <div className="panel-head">
        <h2>
          Files
          {folders && folders.length > 0 && <span className="panel-count">{folders.length}</span>}
        </h2>
        <button
          type="button"
          className="panel-action"
          onClick={() => setLinking((l) => !l)}
          aria-expanded={linking}
          data-testid="link-folder"
        >
          + Link a folder
        </button>
      </div>
      {linking && (
        <form className="link-folder" onSubmit={(e) => void link(e)} data-testid="link-folder-form">
          <label>
            <span>The folder’s path on this computer</span>
            <input
              ref={pathInput}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/Courses/Machine Learning"
              spellCheck={false}
              autoComplete="off"
              data-testid="link-folder-path"
            />
          </label>
          <p className="hint">
            In Finder, select the folder and press ⌥⌘C to copy its path. Noema reads the files where they are; it writes there
            only when you ask.
          </p>
          {linkError && (
            <p className="file-note is-error" role="alert" data-testid="link-folder-error">
              {linkError}
            </p>
          )}
          <div className="link-folder-buttons">
            <button type="submit" disabled={!path.trim()} data-testid="link-folder-submit">
              Link
            </button>
            <button type="button" className="quiet" onClick={() => setLinking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {problem && (
        <p className="file-note is-error" role="alert">
          {problem}
        </p>
      )}
      {folders && folders.length === 0 && !linking && (
        <p className="sidebar-empty">
          No folders yet. Link a folder of course files, code or notes: open any file to read it as a source and ask about
          it, edit text files, and save notes into the folder.
        </p>
      )}
      {folders && folders.length > 0 && (
        <ul className="file-list file-folders" aria-label="Linked folders" data-testid="file-folders">
          {folders.map((f) => {
            const open = isOpen(f.id, '');
            return (
              <li key={f.id} className="file-folder" data-testid="file-folder" data-folder-id={f.id}>
                <div className="file-folder-row">
                  <button
                    type="button"
                    className="file-row is-folder"
                    onClick={() => toggle(f.id, '')}
                    aria-expanded={open}
                    title={f.path}
                    disabled={f.missing}
                    data-testid="file-folder-toggle"
                  >
                    <span className="file-caret" aria-hidden>
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="file-name">{f.name}</span>
                  </button>
                  <button
                    type="button"
                    className="file-tool"
                    onClick={() => reload(f)}
                    title="List the files again (after changes on disk)"
                    aria-label={`List the files of ${f.name} again`}
                    data-testid="file-folder-reload"
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    className="file-tool"
                    onClick={() => setUnlinking(unlinking === f.id ? null : f.id)}
                    title="Unlink this folder"
                    aria-label={`Unlink ${f.name}`}
                    data-testid="file-folder-unlink"
                  >
                    ×
                  </button>
                </div>
                {unlinking === f.id && (
                  <div className="file-confirm" data-testid="file-unlink-confirm">
                    <span>Unlink “{f.name}”? Its files stay as they are; those opened stay as sources.</span>
                    <span className="file-confirm-buttons">
                      <button type="button" onClick={() => void unlink(f)} data-testid="file-unlink-yes">
                        Unlink
                      </button>
                      <button type="button" className="quiet" onClick={() => setUnlinking(null)}>
                        Keep
                      </button>
                    </span>
                  </div>
                )}
                {f.missing ? (
                  <p className="file-note is-error">Not found at {f.path}. Was it moved or renamed?</p>
                ) : (
                  open && <ul className="file-list">{rows(f, '', 1)}</ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** A file name from a note's title: what a file name cannot hold taken out. */
export function noteFileName(title: string): string {
  const base = (title || 'Untitled').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || 'Untitled'}.md`;
}

/** Save a note into a linked folder, as a Markdown file. */
export function SaveNoteToFolder({
  notebookId,
  note,
  onClose,
  onOpenFile,
}: {
  notebookId: string;
  note: Note;
  onClose: () => void;
  /** Open the file just written, as a source. */
  onOpenFile: (source: Source) => void;
}) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folderId, setFolderId] = useState('');
  const [path, setPath] = useState(() => noteFileName(note.title));
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [saved, setSaved] = useState<{ folderId: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.folders(notebookId).then(
      (r) => {
        const usable = r.folders.filter((f) => !f.missing);
        setFolders(usable);
        setFolderId((id) => id || usable[0]?.id || '');
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [notebookId]);

  const save = async (replace: boolean) => {
    if (!folderId || !path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveNoteToFolder(note.id, folderId, path.trim(), replace);
      setSaved({ folderId, path: r.path });
      setExists(false);
    } catch (err) {
      const message = errorText(err);
      setExists(/already a file/.test(message));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (!saved) return;
    try {
      onOpenFile(await api.openFile(saved.folderId, saved.path));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const folderName = folders?.find((f) => f.id === (saved?.folderId ?? folderId))?.name ?? '';
  return (
    <section className="askbox save-to-folder" aria-label="Save to a folder" data-testid="save-to-folder">
      {folders && folders.length === 0 ? (
        <div className="askbox-row confirm-row">
          <span>No folder is linked yet: link one in Files, in the sidebar, then save the note there.</span>
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      ) : saved ? (
        <div className="askbox-row confirm-row" role="status" data-testid="save-to-folder-done">
          <span>
            Saved as <code>{`${folderName}/${saved.path}`}</code>. Saving again writes the note as it is then.
          </span>
          <button type="button" className="quiet" onClick={() => void open()} data-testid="save-to-folder-open">
            Open the file →
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <form
          className="save-to-folder-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <p className="merge-explain">Save this note into a linked folder, as a Markdown file: its title, then its blocks.</p>
          <div className="askbox-row">
            <label className="save-to-folder-field">
              <span className="sr-only">Folder</span>
              <select
                value={folderId}
                onChange={(e) => {
                  setFolderId(e.target.value);
                  setExists(false);
                }}
                data-testid="save-to-folder-folder"
              >
                {(folders ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}/
                  </option>
                ))}
              </select>
            </label>
            <label className="save-to-folder-field grow">
              <span className="sr-only">File name, inside the folder</span>
              <input
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setExists(false);
                }}
                spellCheck={false}
                data-testid="save-to-folder-path"
              />
            </label>
            <button type="submit" disabled={busy || !folderId || !path.trim()} data-testid="save-to-folder-save">
              Save
            </button>
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
          </div>
          {error && (
            <p className="file-note is-error" role="alert" data-testid="save-to-folder-error">
              {error}
              {exists && (
                <button type="button" className="quiet inline" onClick={() => void save(true)} data-testid="save-to-folder-replace">
                  Replace it
                </button>
              )}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

/**
 * A text file of a linked folder, edited in place: the text as it is on disk;
 * saved against what was read, so a change made elsewhere in between is never
 * overwritten.
 */
export function FileEditor({
  folderId,
  path,
  onSaved,
  onCancel,
}: {
  folderId: string;
  path: string;
  onSaved: (source: Source) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<{ text: string; hash: string } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const read = useCallback(async () => {
    try {
      const f = await api.fileText(folderId, path);
      setFile(f);
      setText(f.text);
      setStale(false);
      setError(null);
      requestAnimationFrame(() => area.current?.focus());
    } catch (err) {
      setError(errorText(err));
    }
  }, [folderId, path]);

  useEffect(() => {
    void read();
  }, [read]);

  const save = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const source = await api.saveFile(folderId, path, text, file.hash);
      onSaved(source);
    } catch (err) {
      setStale(err instanceof ApiFailure && err.status === 409);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const changed = file !== null && text !== file.text;
  const lines = text.split('\n').length;
  return (
    <section className="file-editor" aria-label={`Edit ${path}`} data-testid="file-editor">
      <div className="file-editor-bar">
        <span className="file-editor-path">
          {path}
          {changed && <span className="file-editor-dot" title="Not saved yet"> ●</span>}
        </span>
        <span className="file-editor-buttons">
          <span className="hint">
            {lines} {lines === 1 ? 'line' : 'lines'} · ⌘S saves
          </span>
          <button type="button" onClick={() => void save()} disabled={!changed || busy} data-testid="file-editor-save">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="quiet" onClick={onCancel} data-testid="file-editor-cancel">
            {changed ? 'Discard' : 'Close'}
          </button>
        </span>
      </div>
      {error && (
        <p className="file-note is-error" role="alert" data-testid="file-editor-error">
          {error}
          {stale && (
            <>
              {' '}
              Your text is kept here: copy what you need, then{' '}
              <button type="button" className="quiet inline" onClick={() => void read()} data-testid="file-editor-reread">
                read the file again
              </button>
              .
            </>
          )}
        </p>
      )}
      {file ? (
        <textarea
          ref={area}
          className={`file-editor-text${isMarkdownFile(path) ? '' : ' is-code'}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Escape' && !changed) {
              onCancel();
            }
          }}
          spellCheck={isMarkdownFile(path)}
          aria-label={`The text of ${path}`}
          data-testid="file-editor-text"
        />
      ) : (
        !error && <p className="hint">Reading the file…</p>
      )}
    </section>
  );
}
