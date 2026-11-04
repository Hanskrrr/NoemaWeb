// The life of an assistant message revision. Terminal states never change;
// a new answer is a new revision. "interrupted" is what the server writes at
// boot for anything it was still generating when it stopped.

import type { MessageStatus } from './contract.ts';

const NEXT: Record<MessageStatus, readonly MessageStatus[]> = {
  pending: ['streaming', 'done', 'failed', 'stopped', 'interrupted'],
  streaming: ['done', 'failed', 'stopped', 'interrupted'],
  done: [],
  failed: [],
  stopped: [],
  interrupted: [],
};

export function canTransition(from: MessageStatus, to: MessageStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: MessageStatus, to: MessageStatus): void {
  if (!canTransition(from, to)) throw new Error(`message status cannot go from ${from} to ${to}`);
}

export function isTerminal(status: MessageStatus): boolean {
  return NEXT[status].length === 0;
}

export function isLive(status: MessageStatus): boolean {
  return status === 'pending' || status === 'streaming';
}
