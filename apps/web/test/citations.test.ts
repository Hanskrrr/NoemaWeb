import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@noema/core';
import { citationOrder, exchangeOf } from '../src/citations.ts';

const id = (n: number) => `01JC00000000000000000000${String(n).padStart(2, '0')}`;
const message = (n: number, role: Message['role'], replyTo: number | null): Message => ({
  id: id(n),
  threadId: id(90),
  role,
  seq: n,
  replyTo: replyTo === null ? null : id(replyTo),
  revisionId: id(50 + n),
  revision: 1,
  revisions: 1,
  content: `m${n}`,
  status: 'done',
  error: null,
  model: null,
  headline: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
});

test('a note’s citations in the order they first appear, known labels only', () => {
  const refs = {
    E1: { threadId: id(1), messageId: id(2) },
    E2: { threadId: id(1), messageId: id(3) },
    E3: { threadId: id(1), messageId: id(4) },
  };
  assert.deepEqual(citationOrder('Then [E3], first [E1]; [E3] again, [E9] unknown, and [E2][E1].', refs), ['E3', 'E1', 'E2']);
  assert.deepEqual(citationOrder('No citations.', refs), []);
});

test('the exchange of a cited message: an answer with its question, or a question with its answer', () => {
  const messages = [message(1, 'user', null), message(2, 'assistant', 1), message(3, 'user', null)];
  assert.deepEqual(exchangeOf(messages, id(2)), { question: messages[0], answer: messages[1] });
  assert.deepEqual(exchangeOf(messages, id(1)), { question: messages[0], answer: messages[1] });
  assert.deepEqual(exchangeOf(messages, id(3)), { question: messages[2], answer: null });
  assert.equal(exchangeOf(messages, id(9)), null);
});
