// About you: a few lines the learner writes once (background, course, how
// they like things explained), sent with every question in the notebook.

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

export const MAX_ABOUT_ME = 4000;

export function AboutYouDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.notebooks().then(
      ({ notebooks }) => !cancelled && setText(notebooks.find((n) => n.id === notebookId)?.aboutMe ?? ''),
      () => !cancelled && setText(''),
    );
    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (text === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateNotebook(notebookId, { aboutMe: text.trim() });
      ref.current?.close();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not save it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="model-dialog about-dialog" onClose={onClose} aria-labelledby="about-title">
      <h2 id="about-title">About you</h2>
      <p className="form-note">
        A few lines sent with every question in this notebook, so answers fit you: what you already know, what you are
        studying, how you like things explained. You can see it under any answer, in <em>What was sent</em>.
      </p>
      <form className="model-form" onSubmit={save}>
        <label>
          <span className="sr-only">About you</span>
          <textarea
            rows={7}
            maxLength={MAX_ABOUT_ME}
            value={text ?? ''}
            disabled={text === null}
            onChange={(e) => setText(e.target.value)}
            placeholder={'I know C++ and basic calculus; I am taking a course on machine learning.\nExplain with code and small worked examples.'}
            data-testid="about-input"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" disabled={busy || text === null} data-testid="about-save">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="quiet" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </button>
          {text !== null && <span className="form-count">{text.length.toLocaleString()} / 4,000</span>}
        </div>
      </form>
    </dialog>
  );
}
