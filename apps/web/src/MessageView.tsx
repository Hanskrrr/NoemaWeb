import { type AssistantPhase, type BranchSummary, type LookupStep, type Message, readableQuote, type VaultTarget } from '@noema/core';
import { Orb } from './LivingFrame.tsx';
import { CiteContext, Markdown, type Slot } from './markdown/Markdown.tsx';

const SETTINGS_ERRORS = new Set(['auth', 'quota', 'not_configured']);

export interface MessageActions {
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenBranch: (threadId: string) => void;
  /** On a question after the first: start a new thread from it. */
  onSplitOff?: (() => void) | undefined;
  /** On an answer: show what the model was sent for it. */
  onShowContext?: (() => void) | undefined;
  /** On a finished answer: ask the same question again for a new answer, keeping this one. */
  onAskAgain?: (() => void) | undefined;
  /** On an answer asked more than once: which one is shown, and how to see the others. */
  versions?: Versions | undefined;
  /** An Assistant answer (ADR 0023): open the place one of its labels points at. */
  onOpenTarget?: ((target: VaultTarget) => void) | undefined;
  /** An Assistant answer still being written: what it is doing. */
  phase?: AssistantPhase | null | undefined;
}

export interface Versions {
  /** The revision shown, of how many; and the one in use (shown by default, searched, sent with new questions). */
  n: number;
  of: number;
  inUse: number;
  onShow?: ((n: number) => void) | undefined;
  /** Shown when the revision on the screen is not the one in use. */
  onUse?: (() => void) | undefined;
}

export function MessageView({
  message,
  branches,
  onStop,
  onOpenSettings,
  onOpenBranch,
  onSplitOff,
  onShowContext,
  onAskAgain,
  versions,
  slots,
  onOpenTarget,
  phase,
}: { message: Message; branches: BranchSummary[]; slots?: Slot[] } & MessageActions) {
  const { role, status } = message;
  const refs = message.lookups?.refs;
  const numbered =
    onOpenTarget && refs && Object.keys(refs).length > 0 ? { refs: refs as Record<string, VaultTarget>, open: onOpenTarget } : null;
  const body =
    role === 'assistant' ? <Markdown source={message.content} {...(slots ? { slots } : {})} /> : null;
  const sent = role === 'assistant' && status !== 'pending' && onShowContext;
  const earlier = versions && versions.n !== versions.inUse ? versions : null;
  return (
    <article
      className={`message message-${role}${earlier ? ' message-earlier' : ''}`}
      data-testid="message"
      data-role={role}
      data-status={status}
    >
      {earlier && (
        <div className="earlier-note" role="note" data-testid="earlier-note">
          <span title="The answer in use is shown first, found by search, and sent with new questions.">
            An earlier answer, {earlier.n} of {earlier.of}. New questions use answer {earlier.inUse}.
          </span>
          {earlier.onUse && (
            <button type="button" onClick={earlier.onUse} data-testid="use-revision">
              Use this one
            </button>
          )}
        </div>
      )}
      {role === 'assistant' && message.lookups && message.lookups.steps.length > 0 && (
        <LookupTrail steps={message.lookups.steps} live={status === 'pending' || status === 'streaming'} />
      )}
      <div className="message-body" data-message-id={message.id}>
        {role === 'assistant' ? (
          numbered ? (
            <CiteContext.Provider value={{ refs: {}, go: () => {}, numbered }}>{body}</CiteContext.Provider>
          ) : (
            body
          )
        ) : (
          <p className="user-text">
            <span data-s={0} data-e={message.content.length}>
              {message.content}
            </span>
          </p>
        )}
        {role === 'assistant' && status === 'pending' && phase !== undefined && (
          <span className="thinking assistant-doing" data-testid="assistant-doing">
            <Orb size="small" />
            {phase === 'looking' ? 'Looking through your notebook…' : 'Thinking…'}
          </span>
        )}
        {role === 'assistant' && status === 'pending' && phase === undefined && <span className="thinking">Thinking…</span>}
        {role === 'assistant' && status === 'streaming' && <span className="caret" aria-hidden />}
      </div>
      <StatusLine message={message} onStop={onStop} onOpenSettings={onOpenSettings} />
      {(sent || onAskAgain || versions) && (
        <div className={`message-actions${versions ? ' has-versions' : ''}`}>
          {versions && <VersionSwitch versions={versions} />}
          {onAskAgain && (
            <button
              type="button"
              className="quiet"
              onClick={onAskAgain}
              title="Ask the same question again for a new answer. This one is kept, with any side questions from it."
              data-testid="ask-again"
            >
              ↻ Ask again
            </button>
          )}
          {sent && (
            <button
              type="button"
              className="quiet"
              onClick={onShowContext}
              title="See exactly what the AI was sent for this answer"
              data-testid="show-context"
            >
              What was sent
            </button>
          )}
        </div>
      )}
      {onSplitOff && (
        <div className="message-actions">
          <button
            type="button"
            className="quiet"
            onClick={onSplitOff}
            title="Move this question and everything after it into a new thread of its own"
            data-testid="split-off"
          >
            ↪ New thread from here
          </button>
        </div>
      )}
      {branches.length > 0 && (
        <ul className="branch-links" aria-label="Side questions from this message">
          {branches.map((b) => (
            <li key={b.threadId}>
              <button
                type="button"
                className="branch-link"
                onClick={() => onOpenBranch(b.threadId)}
                title={`From “${readableQuote(b.anchor.exact)}”`}
                data-testid="branch-link"
              >
                <span aria-hidden>↳</span> {b.title || 'Side question'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

const GLYPH: Record<LookupStep['tool'], string> = { search: '⌕', open: '❐', list: '≡' };

/** What the Assistant looked up for an answer, in order; the newest arrives with a small motion while it works. */
function LookupTrail({ steps, live }: { steps: LookupStep[]; live: boolean }) {
  return (
    <div className="lookup-trail" data-testid="lookup-trail" aria-label="What the Assistant looked up">
      <span>Looked up</span>
      {steps.map((step, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow, in order
          key={i}
          className={`lookup-step${live && i === steps.length - 1 ? ' lookup-step-new' : ''}`}
          title={step.label}
          data-testid="lookup-step"
        >
          <span aria-hidden>{GLYPH[step.tool]}</span>
          {step.label}
          {step.tool !== 'open' && <span className="lookup-count">· {step.found}</span>}
        </span>
      ))}
    </div>
  );
}

function VersionSwitch({ versions }: { versions: Versions }) {
  const { n, of, inUse, onShow } = versions;
  return (
    <span className="versions" data-testid="versions">
      <button
        type="button"
        className="quiet"
        onClick={() => onShow?.(n - 1)}
        disabled={!onShow || n <= 1}
        aria-label="Earlier answer"
        data-testid="earlier-answer"
      >
        ‹
      </button>
      <span className="versions-count" aria-live="polite">
        {n} / {of}
        {n === inUse && of > 1 && <span className="sr-only"> (in use)</span>}
      </span>
      <button
        type="button"
        className="quiet"
        onClick={() => onShow?.(n + 1)}
        disabled={!onShow || n >= of}
        aria-label="Later answer"
        data-testid="later-answer"
      >
        ›
      </button>
    </span>
  );
}

function StatusLine({
  message,
  onStop,
  onOpenSettings,
}: { message: Message } & Pick<MessageActions, 'onStop' | 'onOpenSettings'>) {
  const { role, status, error } = message;
  if (role === 'user') {
    if (status === 'pending') return <div className="status">Sending…</div>;
    if (status === 'failed') return <div className="status status-bad">Not sent yet.</div>;
    return null;
  }
  switch (status) {
    case 'pending':
    case 'streaming':
      return (
        <div className="status">
          <button type="button" className="quiet" onClick={onStop} data-testid="stop">
            Stop
          </button>
        </div>
      );
    case 'stopped':
      return <div className="status">Stopped. The text above is kept.</div>;
    case 'interrupted':
      return <div className="status status-warn">Interrupted: the server stopped before this answer finished.</div>;
    case 'failed':
      return (
        <div className="status status-bad" role="alert">
          {error?.message ?? 'The answer failed.'}
          {error && SETTINGS_ERRORS.has(error.kind) && (
            <button type="button" className="quiet" onClick={onOpenSettings}>
              Open model settings
            </button>
          )}
        </div>
      );
    default:
      return null;
  }
}
