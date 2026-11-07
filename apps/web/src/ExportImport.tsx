// Export and import: a copy of everything as one JSON file (which imports
// into an empty Noema and gives the same notebook back), a Markdown file for
// reading, and importing a copy.

import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

export function ExportDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { counts } = await api.importCopy(await file.text());
      const parts = [
        `${counts.threads} thread${counts.threads === 1 ? '' : 's'}`,
        `${counts.notes} note${counts.notes === 1 ? '' : 's'}`,
        `${counts.sources} source${counts.sources === 1 ? '' : 's'}`,
      ];
      setDone(`Imported ${parts.join(', ')}.`);
    } catch (err) {
      setError(
        err instanceof ApiFailure
          ? err.status === 413
            ? 'That file is too large to import.'
            : err.message
          : 'Could not read that file.',
      );
    } finally {
      setBusy(false);
    }
  };

  // The notebook was replaced: start again from the top, with the imported notebook.
  const openImported = () => {
    window.location.hash = '#/';
    window.location.reload();
  };

  return (
    <dialog ref={ref} className="model-dialog export-dialog" onClose={onClose} aria-labelledby="export-title">
      <h2 id="export-title">Export and import</h2>
      <section className="export-option">
        <div>
          <h3>A copy of everything</h3>
          <p className="form-note">
            Every thread, every answer (asked again too), side question, note, source and the Trash, in one JSON file.
            Import it into an empty Noema to get this notebook back. Your model key is not in it.
          </p>
        </div>
        <a className="button" href={api.exportUrl} download data-testid="export-json">
          Download copy
        </a>
      </section>
      <section className="export-option">
        <div>
          <h3>For reading</h3>
          <p className="form-note">
            One Markdown file: About you, your notes, each thread with its side questions, and your sources. It opens in
            any editor; it cannot be imported.
          </p>
        </div>
        <a className="button quiet-button" href={api.markdownUrl(notebookId)} download data-testid="export-md">
          Download Markdown
        </a>
      </section>
      <section className="export-option">
        <div>
          <h3>Import a copy</h3>
          <p className="form-note">
            Only into an empty Noema: one with no threads, notes or sources yet. To keep this notebook and open another,
            run Noema with another data folder.
          </p>
        </div>
        {done ? (
          <button type="button" onClick={openImported} data-testid="import-open">
            Open it
          </button>
        ) : (
          <label className={`button quiet-button${busy ? ' disabled' : ''}`}>
            {busy ? 'Importing…' : 'Choose a file…'}
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              disabled={busy}
              onChange={(e) => void importFile(e)}
              data-testid="import-file"
            />
          </label>
        )}
      </section>
      {error && (
        <p className="form-error" role="alert" data-testid="import-error">
          {error}
        </p>
      )}
      {done && (
        <p className="form-note" role="status" data-testid="import-done">
          {done}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="quiet" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
