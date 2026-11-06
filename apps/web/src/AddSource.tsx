// Adding something to read: a web page by its address (read on this
// computer, an arXiv paper from its HTML version), or text pasted in. Text
// copied from a web page keeps its headings, lists, tables and math: the
// copied HTML is turned into Markdown here, with the same converter the
// server uses for pages.

import { htmlToMarkdown, type Source, ulid } from '@noema/core';
import { type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

/** Copied HTML worth keeping: it has structure, not only styled lines (as a code editor copies). */
const STRUCTURE = /<(p|h[1-6]|li|table|math|pre|blockquote|a|em|strong|b|i|sup|sub|code)[\s>]/i;

/** What to put in the box for a paste: Markdown from the copied HTML when it has structure, else nothing (paste as is). */
export function pastedMarkdown(html: string): string | null {
  if (!html || !STRUCTURE.test(html)) return null;
  const md = htmlToMarkdown(html).markdown.trim();
  return md === '' ? null : md;
}

export function AddSourceDialog({
  notebookId,
  onClose,
  onAdded,
}: {
  notebookId: string;
  onClose: () => void;
  onAdded: (source: Source) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept across a retry of the same input, so a reply lost on the way cannot add it twice.
  const id = useRef(ulid());
  const fresh = () => {
    id.current = ulid();
    setError(null);
  };

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const md = pastedMarkdown(e.clipboardData.getData('text/html'));
    if (md === null) return;
    e.preventDefault();
    const el = e.currentTarget;
    const next = `${el.value.slice(0, el.selectionStart)}${md}${el.value.slice(el.selectionEnd)}`;
    const caret = el.selectionStart + md.length;
    setText(next);
    fresh();
    requestAnimationFrame(() => box.current?.setSelectionRange(caret, caret));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === 'url'
          ? { id: id.current, url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) }
          : { id: id.current, text, ...(title.trim() ? { title: title.trim() } : {}) };
      onAdded(await api.addSource(notebookId, body));
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === 'url' ? url.trim() !== '' : text.trim() !== '';

  return (
    <dialog ref={ref} className="model-dialog source-dialog" onClose={onClose} aria-labelledby="add-source-title">
      <h2 id="add-source-title">Add something to read</h2>
      <div className="source-modes" role="tablist" aria-label="How to add it">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'url'}
          className={mode === 'url' ? 'active' : 'quiet'}
          onClick={() => {
            setMode('url');
            fresh();
          }}
          data-testid="source-mode-url"
        >
          A web page
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'paste'}
          className={mode === 'paste' ? 'active' : 'quiet'}
          onClick={() => {
            setMode('paste');
            fresh();
          }}
          data-testid="source-mode-paste"
        >
          Paste text
        </button>
      </div>
      <form className="model-form" onSubmit={submit}>
        {mode === 'url' ? (
          <label>
            <span>Address</span>
            <input
              type="url"
              required
              autoFocus
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                fresh();
              }}
              placeholder="https://arxiv.org/abs/1706.03762"
              spellCheck={false}
              data-testid="source-url-input"
            />
          </label>
        ) : (
          <label>
            <span>Text or Markdown</span>
            <textarea
              ref={box}
              required
              autoFocus
              rows={10}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                fresh();
              }}
              onPaste={onPaste}
              placeholder="Paste a chapter, an article, lecture notes…"
              data-testid="source-text-input"
            />
          </label>
        )}
        <label>
          <span>Title (optional)</span>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              fresh();
            }}
            placeholder={mode === 'url' ? 'Taken from the page' : 'Taken from its first heading or line'}
            data-testid="source-title-input"
          />
        </label>
        <p className="form-note">
          {mode === 'url'
            ? 'The page is read on this computer and kept, so it stays as you read it even if it changes later. For an arXiv paper, any of its links works; its HTML version is read. PDFs cannot be read yet.'
            : 'Copied from a web page, headings, lists, tables and math are kept.'}
        </p>
        {error && (
          <p className="form-error" role="alert" data-testid="source-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" disabled={busy || !ready} data-testid="source-add">
            {busy ? (mode === 'url' ? 'Reading the page…' : 'Adding…') : 'Add'}
          </button>
          <button type="button" className="quiet" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
