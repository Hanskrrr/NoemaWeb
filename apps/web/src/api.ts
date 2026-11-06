// The only place the web app talks to the server. Every response is parsed
// with the shared contract, so a mismatch fails here, loudly, not deep in the UI.

import {
  ApiError,
  AskResponse,
  CLIENT_HEADER,
  CreateBranchResponse,
  type CreateBranchRequest,
  CLIENT_HEADER_VALUE,
  Health,
  type Message,
  type MessageError,
  type MessageStatus,
  ModelSettingsResponse,
  ModelSettingsView,
  Note,
  NoteHistory,
  NoteList,
  Notebook,
  NotebookList,
  SearchResponse,
  StopResponse,
  StreamDelta,
  StreamSnapshot,
  StreamStatus,
  Thread,
  ThreadDetail,
  ThreadList,
  ThreadMap,
  type UpdateModelSettingsRequest,
  type UpdateNoteRequest,
} from '@noema/core';
import { z } from 'zod';

const Ok = z.object({ ok: z.literal(true) });

export class ApiFailure extends Error {
  override name = 'ApiFailure';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<S extends z.ZodTypeAny>(
  schema: S,
  method: string,
  path: string,
  body?: unknown,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure(0, 'offline', 'Cannot reach the Noema server. Is it running?');
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    throw err.success
      ? new ApiFailure(res.status, err.data.error.code, err.data.error.message)
      : new ApiFailure(res.status, 'http_error', `HTTP ${res.status}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiFailure(res.status, 'contract', `unexpected response from ${path}`);
  return parsed.data;
}

export const api = {
  health: () => call(Health, 'GET', '/api/health'),
  notebooks: () => call(NotebookList, 'GET', '/api/notebooks'),
  updateNotebook: (id: string, patch: { title?: string; aboutMe?: string }) =>
    call(Notebook, 'PATCH', `/api/notebooks/${id}`, patch),
  threads: (notebookId: string) => call(ThreadList, 'GET', `/api/notebooks/${notebookId}/threads`),
  createThread: (notebookId: string, id: string, title = '') =>
    call(Thread, 'POST', `/api/notebooks/${notebookId}/threads`, { id, title }),
  thread: (id: string) => call(ThreadDetail, 'GET', `/api/threads/${id}`),
  ask: (threadId: string, id: string, content: string) =>
    call(AskResponse, 'POST', `/api/threads/${threadId}/messages`, { id, content }),
  stop: (messageId: string) => call(StopResponse, 'POST', `/api/messages/${messageId}/stop`, {}),
  createBranch: (parentThreadId: string, body: CreateBranchRequest) =>
    call(CreateBranchResponse, 'POST', `/api/threads/${parentThreadId}/branches`, body),
  returnFromBranch: (threadId: string) => call(Ok, 'POST', `/api/threads/${threadId}/return`, {}),
  search: (q: string) => call(SearchResponse, 'GET', `/api/search?q=${encodeURIComponent(q)}`),
  modelSettings: () => call(ModelSettingsView, 'GET', '/api/settings/model'),
  saveModelSettings: (body: UpdateModelSettingsRequest) =>
    call(ModelSettingsResponse, 'PUT', '/api/settings/model', body),
  forgetModelSettings: () => call(ModelSettingsResponse, 'DELETE', '/api/settings/model'),
  renameThread: (threadId: string, title: string) => call(Thread, 'PATCH', `/api/threads/${threadId}`, { title }),
  threadMap: (threadId: string) => call(ThreadMap, 'GET', `/api/threads/${threadId}/map`),
  rewriteAsNote: (threadId: string, noteId: string) =>
    call(Note, 'POST', `/api/threads/${threadId}/notes`, { id: noteId }),
  notes: (notebookId: string) => call(NoteList, 'GET', `/api/notebooks/${notebookId}/notes`),
  note: (noteId: string) => call(Note, 'GET', `/api/notes/${noteId}`),
  noteHistory: (noteId: string) => call(NoteHistory, 'GET', `/api/notes/${noteId}/history`),
  editNote: (noteId: string, patch: UpdateNoteRequest) => call(Note, 'PATCH', `/api/notes/${noteId}`, patch),
  rewriteNoteAgain: (noteId: string) => call(Note, 'POST', `/api/notes/${noteId}/rewrite`, {}),
};

export interface StreamHandlers {
  snapshot(message: Message): void;
  delta(text: string): void;
  status(status: MessageStatus, error: MessageError | null): void;
  end(): void;
}

/**
 * Watch an answer. Every (re)connection starts with a snapshot of all text so
 * far, so the browser's automatic reconnects can never duplicate text.
 */
export function watchMessage(messageId: string, h: StreamHandlers): () => void {
  const es = new EventSource(`/api/messages/${messageId}/events`);
  const on = <S extends z.ZodTypeAny>(name: string, schema: S, fn: (data: z.output<S>) => void) => {
    es.addEventListener(name, (ev) => {
      const parsed = schema.safeParse(JSON.parse((ev as MessageEvent<string>).data));
      if (parsed.success) fn(parsed.data);
    });
  };
  on('snapshot', StreamSnapshot, (d) => h.snapshot(d.message));
  on('delta', StreamDelta, (d) => h.delta(d.text));
  on('status', StreamStatus, (d) => h.status(d.status, d.error));
  es.addEventListener('end', () => {
    es.close();
    h.end();
  });
  return () => es.close();
}
