// The HTTP contract between apps/web and apps/server, as Zod schemas.
// The server validates every request body with these; the client parses
// every response with them, so a drift between the two fails loudly.

import { z } from 'zod';
import { isUlid } from './ids.ts';

export const Id = z.string().refine(isUlid, 'expected a ULID');

export const MessageStatus = z.enum(['pending', 'streaming', 'done', 'failed', 'interrupted', 'stopped']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const ErrorKind = z.enum([
  'auth',
  'rate_limit',
  'quota',
  'unavailable',
  'bad_request',
  'timeout',
  'network',
  'aborted',
  'context_too_large',
  'not_configured',
  'internal',
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Notebook = z.object({
  id: Id,
  title: z.string(),
  aboutMe: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notebook = z.infer<typeof Notebook>;

export const Thread = z.object({
  id: Id,
  notebookId: Id,
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const MessageError = z.object({ kind: ErrorKind, message: z.string() });
export type MessageError = z.infer<typeof MessageError>;

export const Message = z.object({
  id: Id,
  threadId: Id,
  role: z.enum(['user', 'assistant']),
  seq: z.number().int().nonnegative(),
  /** For an assistant message: the user message it answers. */
  replyTo: Id.nullable(),
  revisionId: Id,
  /** 1 for the first answer, 2+ after regenerate. Old revisions are kept. */
  revision: z.number().int().positive(),
  content: z.string(),
  status: MessageStatus,
  error: MessageError.nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const ThreadDetail = z.object({ thread: Thread, messages: z.array(Message) });
export type ThreadDetail = z.infer<typeof ThreadDetail>;

export const NotebookList = z.object({ notebooks: z.array(Notebook) });
export const ThreadList = z.object({ threads: z.array(Thread) });

export const CreateThreadRequest = z.object({ id: Id, title: z.string().max(200).default('') });
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const UpdateNotebookRequest = z
  .object({ title: z.string().min(1).max(200), aboutMe: z.string().max(4000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateNotebookRequest = z.infer<typeof UpdateNotebookRequest>;

/** The client makes the user message id, so a retried POST cannot ask twice. */
export const AskRequest = z.object({
  id: Id,
  content: z.string().trim().min(1).max(100_000),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AskResponse = z.object({ user: Message, assistant: Message });
export type AskResponse = z.infer<typeof AskResponse>;

export const StopResponse = z.object({ stopping: z.boolean(), message: Message });
export type StopResponse = z.infer<typeof StopResponse>;

export const SearchHit = z.object({
  kind: z.enum(['message', 'thread']),
  threadId: Id,
  messageId: Id.nullable(),
  title: z.string(),
  snippet: z.string(),
  matches: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({ query: z.string(), hits: z.array(SearchHit) });
export type SearchResponse = z.infer<typeof SearchResponse>;

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
});
export type Health = z.infer<typeof Health>;

// Server-sent events on GET /api/messages/:id/events.
// Every connection starts with a snapshot of everything so far, then deltas,
// so a reload or a dropped connection can never duplicate or lose text.
export const StreamSnapshot = z.object({ message: Message });
export const StreamDelta = z.object({ text: z.string() });
export const StreamStatus = z.object({ status: MessageStatus, error: MessageError.nullable() });
export type StreamSnapshot = z.infer<typeof StreamSnapshot>;
export type StreamDelta = z.infer<typeof StreamDelta>;
export type StreamStatus = z.infer<typeof StreamStatus>;
export const STREAM_EVENTS = ['snapshot', 'delta', 'status', 'end'] as const;

/** Sent on every state-changing request; the server rejects requests without it. */
export const CLIENT_HEADER = 'x-noema-client';
export const CLIENT_HEADER_VALUE = 'web';
