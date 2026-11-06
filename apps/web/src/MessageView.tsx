import type { BranchSummary, Message } from '@noema/core';
import { Markdown } from './markdown/Markdown.tsx';

const SETTINGS_ERRORS = new Set(['auth', 'quota', 'not_configured']);

export interface MessageActions {
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenBranch: (threadId: string) => void;
}

export function MessageView({
  message,
  branches,
  onStop,
  onOpenSettings,
  onOpenBranch,
}: { message: Message; branches: BranchSummary[] } & MessageActions) {
  const { role, status } = message;
  return (
    <article className={`message message-${role}`} data-testid="message" data-role={role} data-status={status}>
      <div className="message-body" data-message-id={message.id}>
        {role === 'assistant' ? (
          <Markdown source={message.content} />
        ) : (
          <p className="user-text">
            <span data-s={0} data-e={message.content.length}>
              {message.content}
            </span>
          </p>
        )}
        {role === 'assistant' && status === 'pending' && <span className="thinking">Thinking…</span>}
        {role === 'assistant' && status === 'streaming' && <span className="caret" aria-hidden />}
      </div>
      <StatusLine message={message} onStop={onStop} onOpenSettings={onOpenSettings} />
      {branches.length > 0 && (
        <ul className="branch-links" aria-label="Side questions from this message">
          {branches.map((b) => (
            <li key={b.threadId}>
              <button
                type="button"
                className="branch-link"
                onClick={() => onOpenBranch(b.threadId)}
                title={`From “${b.anchor.exact}”`}
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
