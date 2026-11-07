// What was sent for an answer, word for word: the instructions, what the AI
// knows about you, what you are reading, the passages you pinned, the
// conversation it was given, and the question as it went out. Read from the record kept with every answer.

import { describeSent, type MessageContext, type SentPart } from '@noema/core';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

const KIND_LABELS: Record<SentPart['kind'], string> = {
  instructions: 'Instructions to the AI',
  about_me: 'About you',
  source: 'What you are reading',
  pinned: 'Passages you pinned',
  inherited: 'From the thread this came from',
  history: 'Earlier in this thread',
  question: 'Your question',
};

/** What a part is, in a few words. */
export function partLabel(p: SentPart): string {
  if (p.kind === 'inherited' || p.kind === 'history') {
    const turn = p.role === 'user' ? 'your question' : 'the answer';
    return `${KIND_LABELS[p.kind]} · ${turn}${p.merged > 0 ? ', with a merged thread' : ''}`;
  }
  if (p.kind === 'question') {
    const extras = [p.withPassage ? 'the passage it is about' : '', p.merged > 0 ? 'a merged thread' : ''].filter(Boolean);
    return extras.length > 0 ? `${KIND_LABELS.question}, with ${extras.join(' and ')}` : KIND_LABELS.question;
  }
  return KIND_LABELS[p.kind];
}

const tokens = (n: number) => `about ${n.toLocaleString()} tokens`;
const OPEN_BY_DEFAULT = new Set<SentPart['kind']>(['about_me', 'source', 'pinned', 'question']);

export function ContextDialog({
  messageId,
  revisionId,
  onClose,
  onEditAboutMe,
}: {
  messageId: string;
  /** The revision shown, when it is not the one in use. */
  revisionId?: string | undefined;
  onClose: () => void;
  onEditAboutMe: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [context, setContext] = useState<MessageContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.messageContext(messageId, revisionId).then(
      (c) => !cancelled && setContext(c),
      (err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiFailure && err.status === 404
            ? 'Nothing was sent for this answer: the AI was not asked.'
            : err instanceof ApiFailure
              ? err.message
              : 'Could not load it.',
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [messageId, revisionId]);

  const parts = context?.request ? describeSent(context.manifest, context.request) : null;
  const left = context?.manifest.omitted.length ?? 0;
  const usage = context?.usage;

  return (
    <dialog
      ref={ref}
      className="model-dialog context-dialog"
      onClose={onClose}
      aria-labelledby="context-title"
      data-testid="context-dialog"
    >
      <div className="context-top">
        <h2 id="context-title">What was sent</h2>
        <button type="button" className="quiet" onClick={() => ref.current?.close()} aria-label="Close">
          ×
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!context && !error && <p className="hint" aria-busy="true" />}
      {context && (
        <>
          <p className="context-meta" data-testid="context-meta">
            To {context.model}, {new Date(context.startedAt).toLocaleString()}: {tokens(context.manifest.estimatedTokens)}{' '}
            of the {context.manifest.budgetTokens.toLocaleString()} allowed
            {usage?.promptTokens != null &&
              `; the provider counted ${usage.promptTokens.toLocaleString()}${
                usage.cacheHitTokens ? `, ${usage.cacheHitTokens.toLocaleString()} of them read from its cache` : ''
              }`}
            .
          </p>
          {left > 0 && (
            <p className="context-note" data-testid="context-omitted">
              {left === 1 ? 'One older message was' : `${left} older messages were`} left out to fit.
            </p>
          )}
          {parts ? (
            <>
              {!parts.some((p) => p.kind === 'about_me') && (
                <p className="context-note">
                  Nothing about you was sent.{' '}
                  <button type="button" className="quiet inline" onClick={onEditAboutMe} data-testid="context-about-write">
                    Write About you
                  </button>{' '}
                  so answers fit you.
                </p>
              )}
              <ol className="context-parts" data-testid="context-parts">
                {parts.map((p, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed record, in order
                    key={i}
                    className={`context-part kind-${p.kind} role-${p.role}`}
                    data-testid="context-part"
                    data-kind={p.kind}
                  >
                    <details open={OPEN_BY_DEFAULT.has(p.kind)}>
                      <summary>
                        <span className="context-kind">{partLabel(p)}</span>
                        <span className="context-tokens">{tokens(p.tokens)}</span>
                      </summary>
                      <pre className="context-text">{p.text.replace(/^\n+/, '')}</pre>
                      {p.kind === 'about_me' && (
                        <button
                          type="button"
                          className="quiet inline"
                          onClick={onEditAboutMe}
                          data-testid="context-about-edit"
                        >
                          Change what it says about you
                        </button>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <p className="context-note">
                The exact words were not recorded for answers from before this version of Noema. It included:
              </p>
              <ul className="context-old">
                {context.manifest.parts.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed record, in order
                  <li key={i}>
                    {p.kind.replace('_', ' ')}
                    {p.role ? ` (${p.role === 'user' ? 'question' : 'answer'})` : ''}: {tokens(p.tokens)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
