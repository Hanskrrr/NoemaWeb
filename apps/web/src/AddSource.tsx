// Adding something to read: a web page by its address (read on this
// computer, an arXiv paper from its HTML version), a PDF from this computer
// (or dropped on the dialog), or text pasted in. Text copied from a web page
// keeps its headings, lists, tables and math: the copied HTML is turned into
// Markdown here, with the same converter the server uses for pages.

import { htmlToMarkdown, type Source, ulid } from '@noema/core';
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

/** Copied HTML worth keeping: it has structure, not only styled lines (as a code editor copies). */
const STRUCTURE = /<(p|h[1-6]|li|table|math|pre|blockquote|a|em|strong|b|i|sup|sub|code)[\s>]/i;

/** A file the dialog takes as a PDF. */
export function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

const MB = 1_000_000;
/** The server reads PDFs up to this size. */
const MAX_PDF_MB = 50;

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
  const [mode, setMode] = useState<'url' | 'pdf' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);
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

  const choose = (f: File | null | undefined) => {
    if (!f) return;
    setMode('pdf');
    fresh();
    if (!isPdfFile(f)) {
      setFile(null);
      setError(`“${f.name}” is not a PDF. Noema reads PDFs, web pages and pasted text.`);
      return;
    }
    if (f.size > MAX_PDF_MB * MB) {
      setFile(null);
      setError(`“${f.name}” is larger than ${MAX_PDF_MB} MB, which is as large as Noema reads.`);
      return;
    }
    setFile(f);
  };

  // A PDF dropped anywhere on the dialog.
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropping(false);
    if (!busy) choose(e.dataTransfer.files[0]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const named = title.trim() ? { title: title.trim() } : {};
      if (mode === 'pdf') {
        if (!file) return;
        onAdded(await api.addPdf(notebookId, file, { id: id.current, name: file.name, ...named }));
        return;
      }
      const body = mode === 'url' ? { id: id.current, url: url.trim(), ...named } : { id: id.current, text, ...named };
      onAdded(await api.addSource(notebookId, body));
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === 'url' ? url.trim() !== '' : mode === 'pdf' ? file !== null : text.trim() !== '';

  return (
    <dialog
      ref={ref}
      className={`model-dialog source-dialog${dropping ? ' dropping' : ''}`}
      onClose={onClose}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={onDrop}
      aria-labelledby="add-source-title"
    >
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
          aria-selected={mode === 'pdf'}
          className={mode === 'pdf' ? 'active' : 'quiet'}
          onClick={() => {
            setMode('pdf');
            fresh();
          }}
          data-testid="source-mode-pdf"
        >
          A PDF
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
        {mode === 'pdf' ? (
          <label className="pdf-pick" data-testid="source-pdf-pick">
            <span>File</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => choose(e.target.files?.[0])}
              data-testid="source-pdf-input"
            />
            <span className="pdf-chosen" aria-live="polite">
              {file
                ? `${file.name}, ${(file.size / MB).toFixed(file.size < MB ? 2 : 1)} MB`
                : 'Choose a PDF, or drop one on this window.'}
            </span>
          </label>
        ) : mode === 'url' ? (
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
            placeholder={
              mode === 'url' ? 'Taken from the page' : mode === 'pdf' ? 'Taken from the PDF' : 'Taken from its first heading or line'
            }
            data-testid="source-title-input"
          />
        </label>
        <p className="form-note">
          {mode === 'url'
            ? 'The page is read on this computer and kept, so it stays as you read it even if it changes later. For an arXiv paper, any of its links works; its HTML version is read. A link to a PDF works too.'
            : mode === 'pdf'
              ? 'Read on this computer, page by page, and kept with the file, so you can open the PDF at the page you are reading. Formulas come out as plain characters and pictures are not read; a scanned PDF has no text to read.'
              : 'Copied from a web page, headings, lists, tables and math are kept.'}
        </p>
        {error && (
          <p className="form-error" role="alert" data-testid="source-error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" disabled={busy || !ready} data-testid="source-add">
            {busy ? (mode === 'url' ? 'Reading the page…' : mode === 'pdf' ? 'Reading the PDF…' : 'Adding…') : 'Add'}
          </button>
          <button type="button" className="quiet" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
