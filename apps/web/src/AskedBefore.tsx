// "You asked this before": while a question is being written in a new
// thread, a side question or a question about a source, the notebook is
// checked for an earlier exchange that already asked it, so the learner can
// go there (or ask there) instead of adding another thread. It never blocks:
// asking here anyway is just sending the question.

import { type AskedHit, readableQuote } from '@noema/core';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

export type AskedPlace = 'thread' | 'branch' | 'source';

const short = (text: string, max: number) => {
  const t = readableQuote(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function AskedBefore({
  notebookId,
  text,
  passage,
  threadId,
  place,
  onOpen,
  onAskThere,
  onShowing,
}: {
  notebookId: string;
  /** What is typed so far. */
  text: string;
  /** The passage the question is about, if any. */
  passage?: string | undefined;
  /** The thread being asked from: it is never a reminder, nor the threads it came from. */
  threadId?: string | undefined;
  place: AskedPlace;
  onOpen: (hit: AskedHit) => void;
  /** Send what is typed into the earlier thread. */
  onAskThere: (hit: AskedHit) => void;
  /** The reminder on the screen, or null: so that asking anyway can be counted. */
  onShowing?: (hit: AskedHit | null) => void;
}) {
  const [hits, setHits] = useState<AskedHit[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const reported = useRef(new Set<string>());

  // Ask the notebook a moment after typing stops; a late answer to an old text is dropped.
  useEffect(() => {
    if (!text.trim() && !passage) {
      setHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api.asked(notebookId, { text, ...(passage ? { passage } : {}), ...(threadId ? { threadId } : {}) }).then(
        (r) => !stale && setHits(r.hits),
        () => !stale && setHits([]),
      );
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [notebookId, text, passage, threadId]);

  const shown = hits.filter((h) => !dismissed.has(h.messageId));
  const top = shown[0] ?? null;
  const topId = top?.messageId ?? null;
  const topStrength = top?.strength ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reported once per reminder, when the one on top changes
  useEffect(() => {
    onShowing?.(top);
    if (topId && topStrength && !reported.current.has(topId)) {
      reported.current.add(topId);
      api.askedEvent({ action: 'shown', strength: topStrength, place }).catch(() => {});
    }
  }, [topId, topStrength]);

  if (!top) return null;
  const canAsk = text.trim().length > 0;
  return (
    <aside className="asked" data-testid="asked" aria-label="Asked before">
      <p className="asked-head">{top.strength === 'same' ? 'You asked this before' : 'You asked about this before'}</p>
      <ul>
        {shown.map((h) => (
          <li key={h.messageId} data-testid="asked-hit" data-strength={h.strength}>
            <div className="asked-what">
              <span className="asked-question">
                “{h.passage ? short(h.passage, 90) : short(h.question, 120)}”
                {h.passage && <span className="asked-how"> · {short(h.question, 40)}</span>}
              </span>
              <span className="asked-where">
                in {h.threadTitle || 'Untitled'}
                {day(h.askedAt) && ` · ${day(h.askedAt)}`}
                {h.headline && ` · ${short(h.headline, 80)}`}
              </span>
            </div>
            <div className="asked-actions">
              <button
                type="button"
                onClick={() => {
                  api.askedEvent({ action: 'opened', strength: h.strength, place }).catch(() => {});
                  onOpen(h);
                }}
                data-testid="asked-open"
              >
                Open it
              </button>
              <button
                type="button"
                className="quiet"
                disabled={!canAsk}
                onClick={() => {
                  api.askedEvent({ action: 'asked_there', strength: h.strength, place }).catch(() => {});
                  onAskThere(h);
                }}
                title="Send your question in that thread, after what was already said there"
                data-testid="asked-there"
              >
                Ask there
              </button>
              <button
                type="button"
                className="quiet asked-dismiss"
                onClick={() => {
                  api.askedEvent({ action: 'dismissed', strength: h.strength, place }).catch(() => {});
                  setDismissed((s) => new Set(s).add(h.messageId));
                }}
                aria-label="Not this: hide the reminder"
                title="Not this"
                data-testid="asked-dismiss"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
