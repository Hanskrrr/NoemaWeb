// The only place the web app talks to the server. Every response is parsed
// with the shared contract, so a mismatch fails here, loudly, not deep in the UI.

import {
  ApiError,
  type AskedEventRequest,
  AskedMeaningResponse,
  type AskedRequest,
  AskedResponse,
  AskResponse,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type CreateBranchRequest,
  CreateBranchResponse,
  type CreatePinRequest,
  DeleteThreadResponse,
  Health,
  ImportResponse,
  type InsertBlockRequest,
  Merge,
  type MergeMode,
  type Message,
  MessageContext,
  type MessageError,
  MessageResponse,
  MessageRevisions,
  type MessageStatus,
  ModelSettingsResponse,
  ModelSettingsView,
  Note,
  Notebook,
  NotebookList,
  NoteHistory,
  NoteList,
  OpenBranchesResponse,
  PageImageResponse,
  Pin,
  RefetchResponse,
  type SearchOpenedRequest,
  SearchResponse,
  Source,
  SourceDetail,
  SourceList,
  StopResponse,
  type AssistantAction,
  AssistantActionList,
  type AssistantPhase,
  type AssistantPlace,
  type LookupStep,
  StreamAction,
  StreamDelta,
  StreamPhase,
  StreamSnapshot,
  StreamStatus,
  StreamStep,
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

/** A body that is already JSON text (a large file read from disk), sent as it is. */
class RawJson {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A file sent as its bytes, with its media type. */
class RawFile {
  readonly blob: Blob;
  readonly type: string;
  constructor(blob: Blob, type: string) {
    this.blob = blob;
    this.type = type;
  }
}

function contentType(body: unknown): Record<string, string> {
  if (body === undefined) return {};
  return { 'content-type': body instanceof RawFile ? body.type : 'application/json' };
}

function bodyOf(body: unknown): BodyInit | undefined {
  if (body instanceof RawFile) return body.blob;
  if (body instanceof RawJson) return body.text;
  return body !== undefined ? JSON.stringify(body) : undefined;
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
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...contentType(body) },
      body: bodyOf(body),
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
  /** The notebook's Assistant: made the first time, with this id. */
  assistant: (notebookId: string, id: string) => call(Thread, 'POST', `/api/notebooks/${notebookId}/assistant`, { id }),
  ask: (threadId: string, id: string, content: string, place?: AssistantPlace) =>
    call(AskResponse, 'POST', `/api/threads/${threadId}/messages`, { id, content, ...(place ? { place } : {}) }),
  /** The Assistant's proposed changes in its thread; doing, cancelling or undoing one (ADR 0024). */
  assistantActions: (threadId: string) => call(AssistantActionList, 'GET', `/api/threads/${threadId}/actions`),
  actOn: (actionId: string, what: 'run' | 'cancel' | 'undo') =>
    call(StreamAction, 'POST', `/api/assistant/actions/${actionId}/${what}`, {}),
  stop: (messageId: string) => call(StopResponse, 'POST', `/api/messages/${messageId}/stop`, {}),
  createBranch: (parentThreadId: string, body: CreateBranchRequest) =>
    call(CreateBranchResponse, 'POST', `/api/threads/${parentThreadId}/branches`, body),
  returnFromBranch: (threadId: string) => call(Ok, 'POST', `/api/threads/${threadId}/return`, {}),
  search: (q: string) => call(SearchResponse, 'GET', `/api/search?q=${encodeURIComponent(q)}`),
  searchOpened: (body: SearchOpenedRequest) => call(Ok, 'POST', '/api/search/opened', body),
  /** Earlier exchanges that already asked what is being typed. */
  asked: (notebookId: string, body: AskedRequest) =>
    call(AskedResponse, 'POST', `/api/notebooks/${notebookId}/asked`, body),
  /** The same, read for meaning by the model: slower, asked once typing pauses. */
  askedMeaning: (notebookId: string, body: AskedRequest) =>
    call(AskedMeaningResponse, 'POST', `/api/notebooks/${notebookId}/asked/meaning`, body),
  askedEvent: (body: z.input<typeof AskedEventRequest>) => call(Ok, 'POST', '/api/asked/events', body),
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
  messageContext: (messageId: string, revisionId?: string) =>
    call(
      MessageContext,
      'GET',
      `/api/messages/${messageId}/context${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ''}`,
    ),
  /** The whole store as JSON, and one notebook as Markdown: plain links, the server names the files. */
  exportUrl: '/api/export',
  markdownUrl: (notebookId: string) => `/api/notebooks/${notebookId}/export.md`,
  /** Put a JSON export back, into an empty store. `text` is the file as read. */
  importCopy: (text: string) => call(ImportResponse, 'POST', '/api/import', new RawJson(text)),
  /** Pin a passage to a thread: sent with every question there until unpinned. */
  pin: (threadId: string, body: CreatePinRequest) => call(Pin, 'POST', `/api/threads/${threadId}/pins`, body),
  unpin: (pinId: string) => call(Ok, 'DELETE', `/api/pins/${pinId}`),
  /** Ask the same question again: a new revision of the answer, made the one in use. Idempotent on its id. */
  regenerate: (messageId: string, revisionId: string) =>
    call(MessageResponse, 'POST', `/api/messages/${messageId}/regenerate`, { revisionId }),
  revisions: (messageId: string) => call(MessageRevisions, 'GET', `/api/messages/${messageId}/revisions`),
  /** Make one revision of an answer the one in use: shown, searched, and sent with later questions. */
  useRevision: (messageId: string, revisionId: string) =>
    call(MessageResponse, 'POST', `/api/messages/${messageId}/current`, { revisionId }),
  // Sources: what the learner reads.
  sources: (notebookId: string) => call(SourceList, 'GET', `/api/notebooks/${notebookId}/sources`),
  addSource: (notebookId: string, body: { id: string; title?: string; text?: string; url?: string }) =>
    call(Source, 'POST', `/api/notebooks/${notebookId}/sources`, body),
  /** A PDF from this computer: read page by page on the server, the file kept with it. */
  addPdf: (notebookId: string, file: Blob, query: { id: string; name?: string; title?: string }) =>
    call(
      Source,
      'POST',
      `/api/notebooks/${notebookId}/sources/pdf?${new URLSearchParams(query)}`,
      new RawFile(file, 'application/pdf'),
    ),
  /** Keep a picture of a PDF page on the server: it goes to the model with questions about that page. */
  putPageImage: (sourceId: string, versionId: string, page: number, image: Blob, width: number, height: number) =>
    call(
      PageImageResponse,
      'PUT',
      `/api/sources/${sourceId}/versions/${versionId}/pages/${page}/image?width=${width}&height=${height}`,
      new RawFile(image, image.type || 'image/jpeg'),
    ),
  /** A picture sent with a question, by the reference What was sent names it with. */
  pageImageUrl: (ref: string) => {
    const m = /^source-page:([0-9A-Z]{26}):(\d+)$/.exec(ref);
    return m ? `/api/page-images/${m[1]}/${m[2]}` : null;
  },
  /** The file kept with a version (a PDF), for a link: the browser's viewer opens it, at a page if given. */
  sourceFileUrl: (sourceId: string, versionId: string, page?: number) =>
    `/api/sources/${sourceId}/versions/${versionId}/file${page ? `#page=${page}` : ''}`,
  source: (id: string, version?: string) =>
    call(SourceDetail, 'GET', `/api/sources/${id}${version ? `?version=${encodeURIComponent(version)}` : ''}`),
  renameSource: (id: string, title: string) => call(Source, 'PATCH', `/api/sources/${id}`, { title }),
  refetchSource: (id: string) => call(RefetchResponse, 'POST', `/api/sources/${id}/refetch`, {}),
  /** Read the page again from the copy kept with it, with this Noema's reader (no network). */
  rereadSource: (id: string) => call(RefetchResponse, 'POST', `/api/sources/${id}/reread`, {}),
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
  /** With what the Assistant is doing when the watcher connects, if it is the Assistant. */
  snapshot(message: Message, phase?: AssistantPhase): void;
  delta(text: string): void;
  status(status: MessageStatus, error: MessageError | null): void;
  /** The Assistant: what it is doing now. */
  phase?(phase: AssistantPhase): void;
  /** The Assistant: a lookup it just made. */
  step?(step: LookupStep): void;
  /** The Assistant: a change it proposed, or a place it took the learner to. */
  action?(action: AssistantAction): void;
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
  on('snapshot', StreamSnapshot, (d) => h.snapshot(d.message, d.phase));
  on('delta', StreamDelta, (d) => h.delta(d.text));
  on('status', StreamStatus, (d) => h.status(d.status, d.error));
  on('phase', StreamPhase, (d) => h.phase?.(d.phase));
  on('step', StreamStep, (d) => h.step?.(d.step));
  on('action', StreamAction, (d) => h.action?.(d.action));
  es.addEventListener('end', () => {
    es.close();
    h.end();
  });
  return () => es.close();
}
