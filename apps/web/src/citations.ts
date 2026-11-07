// A note's citations: the order they appear in, and the exchange each points at. Pure, tested in Node.

import { type Message, type Note, splitCitations } from '@noema/core';

/** The labels a note cites, in the order they first appear. */
export function citationOrder(content: string, refs: Note['refs']): string[] {
  const seen: string[] = [];
  for (const part of splitCitations(content, (label) => label in refs)) {
    if (typeof part !== 'string' && !seen.includes(part.label)) seen.push(part.label);
  }
  return seen;
}

export interface Exchange {
  question: Message | null;
  answer: Message | null;
}

/** The exchange a cited message belongs to: an answer and the question it replies to, or a question and its answer. */
export function exchangeOf(messages: Message[], messageId: string): Exchange | null {
  const m = messages.find((x) => x.id === messageId);
  if (!m) return null;
  if (m.role === 'assistant') {
    return { question: messages.find((x) => x.id === m.replyTo) ?? null, answer: m };
  }
  return { question: m, answer: messages.find((x) => x.role === 'assistant' && x.replyTo === m.id) ?? null };
}

