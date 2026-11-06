import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { storage } from './storage.ts';

/**
 * The question box. The draft is kept per place (thread or branch draft), so
 * a reload never loses a half-written question. `onSend` returns false to
 * keep the text (for example when creating the thread failed).
 */
export function Composer({
  draftKey,
  busy,
  autoFocus = false,
  placeholder = 'Ask a question…',
  onSend,
  onStop,
}: {
  draftKey: string;
  busy: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onSend: (text: string) => boolean | Promise<boolean>;
  onStop?: () => void;
}) {
  const [text, setText] = useState(() => storage.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text) storage.set(draftKey, text);
      else storage.remove(draftKey);
    }, 150);
    return () => clearTimeout(t);
  }, [text, draftKey]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy || sending) return;
    setSending(true);
    try {
      if (await onSend(content)) {
        setText('');
        storage.remove(draftKey);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; never send while an IME is composing (Chinese, Japanese input).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={box}
        data-testid="composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        aria-label="Your question"
      />
      {busy && onStop ? (
        <button type="button" onClick={onStop} data-testid="stop-composer">
          Stop
        </button>
      ) : (
        <button type="submit" disabled={!text.trim() || sending} data-testid="send">
          {sending ? 'Sending…' : 'Ask'}
        </button>
      )}
    </form>
  );
}
