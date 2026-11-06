// A page title the learner renames in place: click it, type, Enter or click
// away to save, Escape to keep the old one.

import { useRef, useState } from 'react';

export function EditableTitle({
  title,
  onRename,
  label,
  testId = 'rename',
  inputTestId = 'title-input',
}: {
  title: string;
  onRename: (title: string) => Promise<void> | void;
  label: string;
  testId?: string;
  inputTestId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const cancelled = useRef(false);

  const save = async () => {
    const next = draft.trim();
    setEditing(false);
    if (cancelled.current) return;
    if (next && next !== title) await onRename(next);
  };

  if (editing) {
    return (
      <input
        className="title-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save();
          if (e.key === 'Escape') {
            cancelled.current = true;
            setEditing(false);
          }
        }}
        aria-label={label}
        maxLength={200}
        // biome-ignore lint/a11y/noAutofocus: the field appears because the learner asked to rename
        autoFocus
        data-testid={inputTestId}
      />
    );
  }
  return (
    <h1>
      <button
        type="button"
        className="title-button"
        onClick={() => {
          cancelled.current = false;
          setDraft(title);
          setEditing(true);
        }}
        title="Rename"
        data-testid={testId}
      >
        {title || 'Untitled'}
        <span className="pencil" aria-hidden>
          ✎
        </span>
      </button>
    </h1>
  );
}
