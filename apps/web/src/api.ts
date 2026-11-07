// The only place the web app talks to the server. Every response is parsed
// with the shared contract, so a mismatch fails here, loudly, not deep in the UI.

import {
  ApiError,
  AskResponse,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type CreateBranchRequest,
  CreateBranchResponse,
  DeleteThreadResponse,
  Health,
  type InsertBlockRequest,
  Merge,
  type MergeMode,
  type Message,
  MessageContext,
  type MessageError,
  type MessageStatus,
  ModelSettingsResponse,
  ModelSettingsView,
  Note,
  Notebook,
  NotebookList,
  NoteHistory,
  NoteList,
  OpenBranchesResponse,
  RefetchResponse,
  type SearchOpenedRequest,
  SearchResponse,
  Source,
  SourceDetail,
  SourceList,
  StopResponse,
  StreamDelta,
  StreamSnapshot,
  StreamStatus,
  Thread,
  ThreadDetail,
  ThreadList,
  ThreadMap,
  Trash,
  type UpdateModelSettingsRequest,
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
  searchOpened: (body: SearchOpenedRequest) => call(Ok, 'POST', '/api/search/opened', body),
  openBranches: (notebookId: string) =>
    call(OpenBranchesResponse, 'GET', `/api/notebooks/${notebookId}/open-branches`),
  setAside: (threadId: string) => call(Ok, 'POST', `/api/threads/${threadId}/set-aside`, {}),
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
  renameNote: (noteId: string, title: string) => call(Note, 'PATCH', `/api/notes/${noteId}`, { title }),
  deleteNote: (noteId: string) => call(Ok, 'DELETE', `/api/notes/${noteId}`),
  createNote: (notebookId: string, noteId: string) => call(Note, 'POST', `/api/notebooks/${notebookId}/notes`, { id: noteId }),
  splitThread: (threadId: string, split: boolean) => call(Thread, 'POST', `/api/threads/${threadId}/split`, { split }),
  splitOff: (threadId: string, id: string, messageId: string) =>
    call(Thread, 'POST', `/api/threads/${threadId}/split-off`, { id, messageId }),
  joinBack: (threadId: string) => call(Thread, 'POST', `/api/threads/${threadId}/join-back`, {}),
  deleteThread: (threadId: string) => call(DeleteThreadResponse, 'DELETE', `/api/threads/${threadId}`),
  restoreThread: (threadId: string) => call(Thread, 'POST', `/api/threads/${threadId}/restore`, {}),
  restoreNote: (noteId: string) => call(Note, 'POST', `/api/notes/${noteId}/restore`, {}),
  trash: (notebookId: string) => call(Trash, 'GET', `/api/notebooks/${notebookId}/trash`),
  /** What the model was sent for an answer. */
  messageContext: (messageId: string) => call(MessageContext, 'GET', `/api/messages/${messageId}/context`),
  // Sources: what the learner reads.
  sources: (notebookId: string) => call(SourceList, 'GET', `/api/notebooks/${notebookId}/sources`),
  addSource: (notebookId: string, body: { id: string; title?: string; text?: string; url?: string }) =>
    call(Source, 'POST', `/api/notebooks/${notebookId}/sources`, body),
  source: (id: string, version?: string) =>
    call(SourceDetail, 'GET', `/api/sources/${id}${version ? `?version=${encodeURIComponent(version)}` : ''}`),
  renameSource: (id: string, title: string) => call(Source, 'PATCH', `/api/sources/${id}`, { title }),
  refetchSource: (id: string) => call(RefetchResponse, 'POST', `/api/sources/${id}/refetch`, {}),
  deleteSource: (id: string) => call(Ok, 'DELETE', `/api/sources/${id}`),
  restoreSource: (id: string) => call(Source, 'POST', `/api/sources/${id}/restore`, {}),
  askAboutSource: (
    sourceId: string,
    body: { id: string; passage: { versionId: string; start: number; end: number }; question: { id: string; content: string } },
  ) => call(CreateBranchResponse, 'POST', `/api/sources/${sourceId}/threads`, body),
  // Blocks: every change answers with the whole note.
  insertBlock: (noteId: string, req: InsertBlockRequest) => call(Note, 'POST', `/api/notes/${noteId}/blocks`, req),
  editBlock: (noteId: string, blockId: string, content: string) =>
    call(Note, 'PATCH', `/api/notes/${noteId}/blocks/${blockId}`, { content }),
  deleteBlock: (noteId: string, blockId: string) => call(Note, 'DELETE', `/api/notes/${noteId}/blocks/${blockId}`),
  restoreBlock: (noteId: string, blockId: string) => call(Note, 'POST', `/api/notes/${noteId}/blocks/${blockId}/restore`, {}),
  moveBlock: (noteId: string, blockId: string, after: string | null) =>
    call(Note, 'POST', `/api/notes/${noteId}/blocks/${blockId}/move`, { after }),
  suggest: (noteId: string, blockId: string, instruction: string) =>
    call(Note, 'POST', `/api/notes/${noteId}/blocks/${blockId}/suggest`, { instruction }),
  accept: (noteId: string, blockId: string) => call(Note, 'POST', `/api/notes/${noteId}/blocks/${blockId}/accept`, {}),
  discard: (noteId: string, blockId: string) => call(Note, 'POST', `/api/notes/${noteId}/blocks/${blockId}/discard`, {}),
  mergeNote: (noteId: string, from: string, after: string | null = null) =>
    call(Note, 'POST', `/api/notes/${noteId}/merge`, { from, after }),
  // Merges: a draft (AI summary or the whole exchange) the learner edits and accepts.
  startMerge: (sourceId: string, id: string, into: string, mode: MergeMode) =>
    call(Merge, 'POST', `/api/threads/${sourceId}/merges`, { id, into, mode }),
  merge: (id: string) => call(Merge, 'GET', `/api/merges/${id}`),
  editMerge: (id: string, summary: string) => call(Merge, 'PATCH', `/api/merges/${id}`, { summary }),
  redraftMerge: (id: string, mode: MergeMode) => call(Merge, 'POST', `/api/merges/${id}/redraft`, { mode }),
  acceptMerge: (id: string) => call(Merge, 'POST', `/api/merges/${id}/accept`, {}),
  undoMerge: (id: string) => call(Merge, 'POST', `/api/merges/${id}/undo`, {}),
  discardMerge: (id: string) => call(Merge, 'POST', `/api/merges/${id}/discard`, {}),
  moveOut: (noteId: string, newId: string, blockIds: string[]) =>
    call(Note, 'POST', `/api/notes/${noteId}/move-out`, { id: newId, blockIds }),
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
