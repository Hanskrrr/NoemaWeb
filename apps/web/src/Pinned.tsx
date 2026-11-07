// Pinned passages: kept in front of the AI with every question in a thread
// (and its side questions) until unpinned. The list sits at the top of the
// thread; a passage is pinned from a selection in the thread or in the
// source beside it.

import { type Pin, readableQuote } from '@noema/core';

/** Something was pinned or unpinned from outside the thread (the source beside it): the thread reloads its pins. */
export const PINS_CHANGED_EVENT = 'noema:pins-changed';

export function pinsChanged(threadId: string): void {
  window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: threadId }));
}

const short = (text: string, max = 140) => {
  const t = readableQuote(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function PinnedList({
  pins,
  threadId,
  titleOf,
  onShow,
  onUnpin,
}: {
  pins: Pin[];
  threadId: string;
  /** A thread's title, live. */
  titleOf: (threadId: string, fallback: string) => string;
  /** Show the passage: in this thread, or where it is. */
  onShow: (pin: Pin) => void;
  /** Only for pins of this thread; those of a thread it came from are unpinned there. */
  onUnpin: (pin: Pin) => void;
}) {
  if (pins.length === 0) return null;
  return (
    <section className="pinned" data-testid="pinned" aria-label="Pinned passages">
      <p className="pinned-title">
        <span aria-hidden>📌</span> Pinned · sent with every question here
      </p>
      <ul>
        {pins.map((p) => {
          const where = p.source
            ? `in “${p.source.title || 'Untitled'}”`
            : p.message && p.message.threadId !== threadId
              ? `in “${titleOf(p.message.threadId, p.message.threadTitle) || 'Untitled'}”`
              : 'in this thread';
          const own = p.threadId === threadId;
          return (
            <li key={p.id} data-testid="pin" data-pin-id={p.id}>
              <button
                type="button"
                className="pinned-quote"
                onClick={() => onShow(p)}
                disabled={Boolean(p.source)}
                title={p.exact}
              >
                “{short(p.exact)}”
              </button>
              <span className="pinned-from">
                {where}
                {!own && ` · pinned in “${titleOf(p.threadId, '') || 'the thread this came from'}”`}
              </span>
              {own && (
                <button
                  type="button"
                  className="quiet pinned-remove"
                  onClick={() => onUnpin(p)}
                  aria-label={`Unpin “${short(p.exact, 40)}”`}
                  title="Unpin: stop sending it with questions"
                  data-testid="unpin"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
