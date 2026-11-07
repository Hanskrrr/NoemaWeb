// The exchange a note cites ([E2]), beside the note: the question, the
// answer, and where it was asked (a passage of a source, or of another
// thread). The note stays where it is; step through its citations in the
// order they appear, or open the thread at that exchange.

import { type CiteRefs, readableQuote, type ThreadDetail } from '@noema/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';
import { exchangeOf } from './citations.ts';
import { Markdown } from './markdown/Markdown.tsx';

export function RefPane({
  label,
  refs,
  order,
  onStep,
  onOpenThread,
  onClose,
}: {
  label: string;
  refs: CiteRefs;
  /** The note's citations in the order they first appear. */
  order: string[];
  onStep: (label: string) => void;
  onOpenThread: (threadId: string, messageId: string) => void;
  onClose: () => void;
}) {
  const ref = refs[label];
  const [details, setDetails] = useState<Map<string, ThreadDetail | 'missing'>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const pane = useRef<HTMLElement>(null);
  const threadId = ref?.threadId;

  useEffect(() => {
    if (!threadId || details.has(threadId)) return;
    let cancelled = false;
    api.thread(threadId).then(
      (d) => !cancelled && setDetails((m) => new Map(m).set(threadId, d)),
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFailure && err.status === 404) setDetails((m) => new Map(m).set(threadId, 'missing'));
        else setError(err instanceof ApiFailure ? err.message : 'Could not load it.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, details]);

  // A new citation starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on every new citation
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 });
  }, [label]);

  const i = order.indexOf(label);
  const prev = i > 0 ? order[i - 1] : undefined;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : undefined;
  const detail = threadId ? details.get(threadId) : undefined;
  const exchange = ref && detail && detail !== 'missing' ? exchangeOf(detail.messages, ref.messageId) : null;
  const thread = detail && detail !== 'missing' ? detail : null;

  let body: ReactNode;
  if (!ref || detail === 'missing' || (thread && !exchange)) {
    body = <p className="hint ref-missing">This exchange is no longer there.</p>;
  } else if (!thread || !exchange) {
    body = error ? <p className="hint">{error}</p> : <p className="hint" aria-busy="true" />;
  } else {
    const where = thread.sourceOrigin
      ? { quote: thread.sourceOrigin.passage.exact, from: thread.sourceOrigin.sourceTitle || 'a source' }
      : thread.thread.originQuote && thread.origin
        ? { quote: thread.thread.originQuote, from: thread.origin.parentTitle || 'another thread' }
        : null;
    body = (
      <>
        <p className="ref-from">
          from <strong>{thread.thread.title || 'Untitled'}</strong>
          {thread.thread.deletedAt ? ' (in the Trash)' : ''}
        </p>
        {where && (
          <blockquote className="ref-passage" data-testid="ref-passage">
            “{readableQuote(where.quote).length > 400 ? `${readableQuote(where.quote).slice(0, 400)}…` : readableQuote(where.quote)}”
            <span className="ref-passage-from"> — {where.from}</span>
          </blockquote>
        )}
        {exchange.question && (
          <div className="ref-question" data-testid="ref-question">
            <Markdown source={exchange.question.content} />
          </div>
        )}
        {exchange.answer ? (
          <article className="ref-answer message-assistant" data-testid="ref-answer">
            <div className="message-body">
              <Markdown source={exchange.answer.content} />
            </div>
          </article>
        ) : (
          <p className="hint">Not answered.</p>
        )}
        <button
          type="button"
          className="quiet ref-open"
          onClick={() => onOpenThread(ref.threadId, ref.messageId)}
          data-testid="ref-open"
        >
          Open the thread at this exchange →
        </button>
      </>
    );
  }

  return (
    <aside className="ref-pane" ref={pane} aria-label={`The exchange cited as ${label}`} data-testid="ref-pane" data-label={label}>
      <header className="ref-head">
        <div className="ref-nav">
          <button
            type="button"
            className="quiet"
            onClick={() => prev && onStep(prev)}
            disabled={!prev}
            aria-label={prev ? `The citation before, ${prev}` : 'No citation before'}
            data-testid="ref-prev"
          >
            ‹
          </button>
          <span className="ref-label">{label}</span>
          {order.length > 1 && i >= 0 && (
            <span className="ref-of">
              {i + 1} of {order.length}
            </span>
          )}
          <button
            type="button"
            className="quiet"
            onClick={() => next && onStep(next)}
            disabled={!next}
            aria-label={next ? `The next citation, ${next}` : 'No citation after'}
            data-testid="ref-next"
          >
            ›
          </button>
        </div>
        <button type="button" className="quiet" onClick={onClose} aria-label="Close" data-testid="ref-close">
          ×
        </button>
      </header>
      {body}
    </aside>
  );
}
