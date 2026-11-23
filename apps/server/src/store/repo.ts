// All SQL lives here. Routes and the generation loop call these methods and
// never write SQL themselves.

import { createHash } from 'node:crypto';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import {
  type AnchorRef,
  type AskedCandidate,
  AssistantPlace,
  type BranchSummary,
  type ChatMessage,
  type ContextManifest,
  type Continuation,
  type ContinuedFrom,
  createAnchor,
  type ErrorKind,
  ftsQuery,
  type HistoryItem,
  headingLevel,
  isLive,
  joinBlocks,
  type MapExchange,
  type MapNode,
  type Merge,
  type MergedText,
  Lookups,
  type Message,
  type MessageContext,
  type MessageError,
  type MessageRevision,
  type MessageStatus,
  makeSnippet,
  type ImportResponse,
  type Note,
  type NoteBlock,
  type Notebook,
  type NoemaExport,
  MAX_PINS,
  type OpenBranch,
  type Origin,
  type Pin,
  type ReadableNotebook,
  bestMention,
  type Concept,
  type ConceptHow,
  type ConceptLink,
  type ConceptPlace,
  type ConceptWords,
  conceptKey,
  FIND_CONCEPTS_MAX,
  FIND_MATERIALS_MAX,
  type FindMaterial,
  type FoundDraft,
  type KnownConcept,
  ORDER_MAX,
  type OrderConcept,
  type OrderReply,
  pageAt,
  pagesOf as pageStarts,
  wordsFound,
  workWeight,
  type MaterialConcepts,
  type MentionDraft,
  type MentionRole,
  type Piece,
  pieceHashInput,
  piecesOf,
  quoteRange,
  targetAt,
  type Gist,
  type ItemLink,
  type ItemText,
  type LinkKind,
  type Room,
  type RoomGraph,
  type RoomItemRef,
  type RoomKind,
  type RoomRow,
  type RoomView,
  type Door,
  type RoomDoor,
  roomKey,
  roomMap,
  roomMembers,
  wouldLoop,
  threadOf,
  type Source,
  type SourceDetail,
  type SourceOrigin,
  type SourcePassage,
  type SourceVersion,
  sourceBlocks,
  sourceSection,
  type Trash,
  plainText,
  parseQuery,
  type SearchHit,
  searchText,
  splitBlocks,
  type Thread,
  type WebFind,
  type ThreadMap,
  ulid,
  VaultTarget,
} from '@noema/core';
import type { Db } from './db.ts';

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

/** A mention as a place of a concept (ADR 0037). */
function toPlace(m: Row): ConceptPlace {
  let target: VaultTarget | null = null;
  if (m.target) {
    const parsed = VaultTarget.safeParse(JSON.parse(m.target as string));
    if (parsed.success) target = parsed.data;
  }
  return {
    id: m.id as string,
    role: m.role as ConceptPlace['role'],
    says: (m.says as string | null) ?? null,
    quote: m.quote as string,
    target,
    by: m.made_by === 'you' ? 'you' : 'ai',
    kept: m.kept !== 0,
  };
}

/** What a brief is written from: each thing in the room as it is now, as one hash. A thing changed, added or taken out makes it older. */
function briefBasis(members: string[], bases: Map<string, string>): string {
  const parts = [...members].sort().map((k) => `${k}@${bases.get(k) ?? ''}`);
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function toWebFind(r: Row): WebFind {
  return {
    id: r.id as string,
    n: r.n as number,
    query: r.query as string,
    title: r.title as string,
    url: r.url as string,
    snippet: r.snippet as string,
    site: (r.site as string | null) ?? null,
    date: (r.date as string | null) ?? null,
    status: r.status as WebFind['status'],
    sourceId: (r.source_id as string | null) ?? null,
  };
}

function toItemLink(r: Row): ItemLink {
  return {
    id: r.id as string,
    from: { kind: r.from_kind as RoomKind, id: r.from_id as string },
    to: { kind: r.to_kind as RoomKind, id: r.to_id as string },
    kind: r.kind as LinkKind,
    label: (r.label as string | null) ?? null,
    why: (r.why as string | null) ?? null,
    by: r.made_by as ItemLink['by'],
    status: r.status as ItemLink['status'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toNotebook(r: Row): Notebook {
  return {
    id: r.id as string,
    title: r.title as string,
    aboutMe: r.about_me as string,
    assistantAsks: Number(r.assistant_asks ?? 0) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function shorten(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function toThread(r: Row): Thread {
  const exact = r.origin_exact as string | null | undefined;
  return {
    id: r.id as string,
    notebookId: r.notebook_id as string,
    parentThreadId: (r.parent_thread_id as string | null) ?? null,
    originQuote: exact ? shorten(exact, 160) : null,
    splitAt: (r.split_at as string | null | undefined) ?? null,
    mergedIntoId: (r.merged_into as string | null | undefined) ?? null,
    continuedFromId: (r.continued_from as string | null | undefined) ?? null,
    deletedAt: (r.deleted_at as string | null | undefined) ?? null,
    sourceId: (r.source_id as string | null | undefined) ?? null,
    sourceVersionId: (r.source_version_id as string | null | undefined) ?? null,
    sourceQuote: r.source_exact ? shorten(r.source_exact as string, 160) : null,
    title: r.title as string,
    titleSource: ((r.title_source as string | undefined) ?? 'question') as Thread['titleSource'],
    kind: ((r.kind as string | undefined) ?? 'chat') as Thread['kind'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const THREAD_SELECT = `SELECT t.*, a.exact AS origin_exact, sa.exact AS source_exact, sv.source_id AS source_id, sa.version_id AS source_version_id,
  (SELECT m.target_thread_id FROM thread_merge m WHERE m.source_thread_id = t.id AND m.status = 'merged'
   ORDER BY m.merged_at DESC LIMIT 1) AS merged_into
  FROM thread t LEFT JOIN anchor a ON a.id = t.origin_anchor_id
  LEFT JOIN source_anchor sa ON sa.id = t.source_anchor_id
  LEFT JOIN source_version sv ON sv.id = sa.version_id`;

function toBlock(r: Row): NoteBlock {
  const status = r.proposal_status as NonNullable<NoteBlock['proposal']>['status'] | null;
  return {
    id: r.id as string,
    content: r.content as string,
    author: r.author as NoteBlock['author'],
    proposal: status
      ? {
          status,
          text: (r.proposal as string | null) ?? '',
          instruction: (r.proposal_instruction as string | null) ?? '',
          error: (r.proposal_error as string | null) ?? null,
        }
      : null,
  };
}

function toNote(r: Row, blocks: NoteBlock[]): Note {
  return {
    id: r.id as string,
    notebookId: r.notebook_id as string,
    threadId: (r.thread_id as string | null) ?? null,
    title: r.title as string,
    content: r.content as string,
    blocks,
    refs: JSON.parse((r.refs as string | undefined) ?? '{}') as Note['refs'],
    status: r.status as Note['status'],
    error: (r.error as string | null) ?? null,
    author: r.author as Note['author'],
    revision: r.revision as number,
    deletedAt: (r.deleted_at as string | null | undefined) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** Markdown to a plain one-line gist for the map. */
export function gistOf(markdown: string, max = 140): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>#~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return shorten(plain, max);
}

function toMessage(r: Row): Message {
  const kind = r.error_kind as ErrorKind | null;
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as 'user' | 'assistant',
    seq: r.seq as number,
    replyTo: (r.reply_to as string | null) ?? null,
    revisionId: r.revision_id as string,
    revision: r.n as number,
    revisions: Number(r.revisions ?? 1),
    content: r.content as string,
    status: r.status as MessageStatus,
    error: kind ? { kind, message: (r.error_message as string | null) ?? '' } : null,
    model: (r.model as string | null) ?? null,
    headline: (r.headline as string | null | undefined) ?? null,
    lookups: lookupsOf(r.lookups),
    web: r.web ? (JSON.parse(r.web as string) as WebFind[]) : [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** A proposed change as stored: what the learner is shown, and what it needs to run. */
export interface StoredAction {
  id: string;
  messageId: string;
  revisionId: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  status: 'proposed' | 'running' | 'done' | 'cancelled' | 'failed' | 'undone';
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
}

function toAction(r: Row): StoredAction {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    revisionId: r.revision_id as string,
    kind: r.kind as string,
    summary: r.summary as string,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    status: r.status as StoredAction['status'],
    result: r.result ? (JSON.parse(r.result as string) as Record<string, unknown>) : null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** An Assistant answer's lookups as stored, or null (none, or unreadable). */
function lookupsOf(value: unknown): Lookups | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = Lookups.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const MESSAGE_SELECT = `
  SELECT m.id, m.thread_id, m.role, m.seq, m.reply_to, m.created_at,
         r.id AS revision_id, r.n, r.content, r.status, r.error_kind, r.error_message, r.model, r.updated_at,
         r.headline, r.lookups, (SELECT count(*) FROM message_revision x WHERE x.message_id = m.id) AS revisions,
         (SELECT json_group_array(json_object('id', w.id, 'n', w.n, 'query', w.query, 'title', w.title, 'url', w.url,
                   'snippet', w.snippet, 'site', w.site, 'date', w.date, 'status', w.status, 'sourceId', w.source_id))
            FROM (SELECT * FROM web_find WHERE revision_id = r.id ORDER BY n) w) AS web
  FROM message m JOIN message_revision r ON r.id = m.current_revision_id`;

export class ConflictError extends Error {
  override name = 'ConflictError';
}

export class InvalidError extends Error {
  override name = 'InvalidError';
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(what: string) {
    super(`no such ${what}`);
  }
}

function toAnchor(r: Row): AnchorRef {
  return {
    messageId: r.message_id as string,
    revisionId: r.revision_id as string,
    start: r.start_offset as number,
    end: r.end_offset as number,
    exact: r.exact as string,
    prefix: r.prefix as string,
    suffix: r.suffix as string,
  };
}

export interface AskPair {
  user: Message;
  assistant: Message;
}

export interface ModelCallStart {
  revisionId: string;
  provider: string;
  model: string;
  manifest: ContextManifest;
  /** The exact messages sent. */
  request: ChatMessage[];
}

export interface ModelCallEnd {
  attempts: number;
  firstTokenAt: string | null;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  cacheHitTokens?: number | undefined;
  cacheMissTokens?: number | undefined;
  finishReason?: string | null | undefined;
  errorKind?: ErrorKind | null | undefined;
}

/** A room and its rows, as stored (see Repo.roomSnapshot). */
/** At most this many pages found on the web are offered under an answer (ADR 0033). */
const WEB_OFFERED = 3;

export interface RoomSnapshot {
  /** Its doors both ways (ADR 0032); missing in snapshots from before rooms held rooms. */
  doors?: Array<Record<string, unknown>>;
  room: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  brief?: Record<string, unknown> | null;
}

/** A room's door to a room in it, and whether that room is a concept (ADR 0036). */
type KindDoor = Door & { concept: boolean };

export class Repo {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Notebooks ---------------------------------------------------------------

  ensureDefaultNotebook(): Notebook {
    return this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT * FROM notebook ORDER BY created_at LIMIT 1').get() as Row | undefined;
      if (row) return toNotebook(row);
      const t = now();
      const id = ulid();
      this.db.sql
        .prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'My notebook', '', t, t);
      return { id, title: 'My notebook', aboutMe: '', assistantAsks: false, createdAt: t, updatedAt: t };
    });
  }

  listNotebooks(): Notebook[] {
    return (this.db.sql.prepare('SELECT * FROM notebook ORDER BY created_at').all() as Row[]).map(toNotebook);
  }

  getNotebook(id: string): Notebook | null {
    const row = this.db.sql.prepare('SELECT * FROM notebook WHERE id = ?').get(id) as Row | undefined;
    return row ? toNotebook(row) : null;
  }

  updateNotebook(
    id: string,
    patch: { title?: string | undefined; aboutMe?: string | undefined; assistantAsks?: boolean | undefined },
  ): Notebook | null {
    const current = this.getNotebook(id);
    if (!current) return null;
    const next = { ...current, ...stripUndefined(patch), updatedAt: now() };
    this.db.sql
      .prepare('UPDATE notebook SET title = ?, about_me = ?, assistant_asks = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.aboutMe, next.assistantAsks ? 1 : 0, next.updatedAt, id);
    this.logEvent('notebook.updated', id, { fields: Object.keys(stripUndefined(patch)) });
    return next;
  }

  // Threads -----------------------------------------------------------------

  listThreads(notebookId: string): Thread[] {
    return (
      this.db.sql
        .prepare(
          `${THREAD_SELECT} WHERE t.notebook_id = ? AND t.deleted_at IS NULL AND t.kind = 'chat' ORDER BY t.updated_at DESC`,
        )
        .all(notebookId) as Row[]
    ).map(toThread);
  }

  /** The notebook's Assistant (ADR 0023): made the first time it is asked for, with this id. */
  assistantThread(notebookId: string, id: string): { thread: Thread; created: boolean } {
    return this.db.tx(() => {
      const row = this.db.sql
        .prepare(`${THREAD_SELECT} WHERE t.notebook_id = ? AND t.kind = 'assistant'`)
        .get(notebookId) as Row | undefined;
      if (row) {
        const existing = toThread(row);
        // In the Trash: it comes back (it is not a thread one throws away).
        if (existing.deletedAt) this.db.sql.prepare('UPDATE thread SET deleted_at = NULL WHERE id = ?').run(existing.id);
        return { thread: { ...existing, deletedAt: null }, created: false };
      }
      if (this.getThread(id)) throw new ConflictError('thread id already used');
      const t = now();
      this.db.sql
        .prepare(
          "INSERT INTO thread (id, notebook_id, title, title_source, kind, created_at, updated_at) VALUES (?, ?, 'Assistant', 'user', 'assistant', ?, ?)",
        )
        .run(id, notebookId, t, t);
      this.logEvent('assistant.created', id, { notebookId });
      return { thread: this.getThread(id) as Thread, created: true };
    });
  }

  /** Where the learner was when they asked the Assistant this question. */
  setPlace(messageId: string, place: AssistantPlace): void {
    this.db.sql.prepare('UPDATE message SET place = ? WHERE id = ?').run(JSON.stringify(place), messageId);
  }

  placeOf(messageId: string): AssistantPlace | null {
    const row = this.db.sql.prepare('SELECT place FROM message WHERE id = ?').get(messageId) as Row | undefined;
    if (!row?.place) return null;
    const parsed = AssistantPlace.safeParse(JSON.parse(row.place as string));
    return parsed.success ? parsed.data : null;
  }

  // The Assistant's proposed changes (ADR 0024) ----------------------------

  addAction(a: {
    id: string;
    messageId: string;
    revisionId: string;
    kind: string;
    summary: string;
    payload: unknown;
    status: 'proposed' | 'done';
    result?: unknown;
  }): StoredAction {
    const t = now();
    const seq = (
      this.db.sql.prepare('SELECT count(*) AS n FROM assistant_action WHERE message_id = ?').get(a.messageId) as { n: number }
    ).n;
    this.db.sql
      .prepare(
        `INSERT INTO assistant_action (id, message_id, revision_id, seq, kind, summary, payload, status, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.messageId, a.revisionId, seq, a.kind, a.summary, JSON.stringify(a.payload), a.status, a.result ? JSON.stringify(a.result) : null, t, t);
    this.logEvent('assistant.action', a.id, { kind: a.kind, status: a.status });
    return this.getAction(a.id) as StoredAction;
  }

  getAction(id: string): StoredAction | null {
    const r = this.db.sql.prepare('SELECT * FROM assistant_action WHERE id = ?').get(id) as Row | undefined;
    return r ? toAction(r) : null;
  }

  /** Move an action on: only from the state it is expected to be in (so a double tap does it once). */
  setAction(
    id: string,
    from: StoredAction['status'][],
    to: StoredAction['status'],
    patch: { result?: unknown; error?: string | null } = {},
  ): StoredAction | null {
    const marks = from.map(() => '?').join(', ');
    const r = this.db.sql
      .prepare(
        `UPDATE assistant_action SET status = ?, updated_at = ?,
           result = CASE WHEN ? THEN ? ELSE result END, error = CASE WHEN ? THEN ? ELSE error END
         WHERE id = ? AND status IN (${marks})`,
      )
      .run(
        to,
        now(),
        patch.result !== undefined ? 1 : 0,
        patch.result !== undefined ? JSON.stringify(patch.result) : null,
        patch.error !== undefined ? 1 : 0,
        patch.error ?? null,
        id,
        ...from,
      );
    if (Number(r.changes) === 0) return null;
    this.logEvent('assistant.action', id, { status: to });
    return this.getAction(id);
  }

  actionsOfThread(threadId: string): StoredAction[] {
    return (
      this.db.sql
        .prepare(
          `SELECT a.* FROM assistant_action a JOIN message m ON m.id = a.message_id
           WHERE m.thread_id = ? ORDER BY m.seq, a.seq`,
        )
        .all(threadId) as Row[]
    ).map(toAction);
  }

  /** Keep an Assistant answer's lookups with its revision. */
  saveLookups(revisionId: string, lookups: Lookups): void {
    this.db.sql.prepare('UPDATE message_revision SET lookups = ? WHERE id = ?').run(JSON.stringify(lookups), revisionId);
  }

  getThread(id: string): Thread | null {
    const row = this.db.sql.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return row ? toThread(row) : null;
  }

  /** Idempotent: creating the same id twice returns the first thread. */
  createThread(notebookId: string, id: string, title: string): { thread: Thread; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getThread(id);
      if (existing) {
        if (existing.notebookId !== notebookId) throw new ConflictError('thread id already used in another notebook');
        return { thread: existing, created: false };
      }
      const t = now();
      this.db.sql
        .prepare('INSERT INTO thread (id, notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, notebookId, title, t, t);
      if (title) this.index('thread', id, id, title);
      this.logEvent('thread.created', id, { notebookId });
      const thread: Thread = {
        id,
        notebookId,
        parentThreadId: null,
        originQuote: null,
        splitAt: null,
        mergedIntoId: null,
        continuedFromId: null,
        deletedAt: null,
        sourceId: null,
        sourceVersionId: null,
        sourceQuote: null,
        title,
        titleSource: 'question',
        kind: 'chat',
        createdAt: t,
        updatedAt: t,
      };
      return { thread, created: true };
    });
  }

  // Messages ----------------------------------------------------------------

  listMessages(threadId: string): Message[] {
    return (this.db.sql.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? ORDER BY m.seq`).all(threadId) as Row[]).map(
      toMessage,
    );
  }

  getMessage(id: string): Message | null {
    const row = this.db.sql.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  /**
   * Ask the same question again: a new revision of the answer, made current.
   * The old revisions stay, with the passages side questions were asked from.
   */
  regenerate(messageId: string, revisionId: string): { message: Message; question: Message; created: boolean } {
    return this.db.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new NotFoundError('message');
      if (message.role !== 'assistant') throw new InvalidError('only an answer can be asked again');
      const question = message.replyTo ? this.getMessage(message.replyTo) : null;
      if (!question) throw new InvalidError('this answer has no question');
      const known = this.db.sql.prepare('SELECT message_id FROM message_revision WHERE id = ?').get(revisionId) as
        | { message_id: string }
        | undefined;
      if (known) {
        if (known.message_id !== messageId) throw new ConflictError('that id belongs to another message');
        return { message, question, created: false };
      }
      this.notInTrash(message.threadId);
      if (message.status === 'pending' || message.status === 'streaming') {
        throw new ConflictError('it is still being answered');
      }
      const at = now();
      const { n } = this.db.sql
        .prepare('SELECT max(n) + 1 AS n FROM message_revision WHERE message_id = ?')
        .get(messageId) as { n: number };
      this.db.sql
        .prepare(
          "INSERT INTO message_revision (id, message_id, n, content, status, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', ?, ?)",
        )
        .run(revisionId, messageId, n, at, at);
      this.db.sql.prepare('UPDATE message SET current_revision_id = ? WHERE id = ?').run(revisionId, messageId);
      this.db.sql.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(at, message.threadId);
      this.logEvent('answer.regenerated', messageId, { revision: n });
      return { message: this.getMessage(messageId) as Message, question, created: true };
    });
  }

  /** Every revision of an answer, oldest first. */
  revisionsOf(messageId: string): MessageRevision[] {
    return (
      this.db.sql
        .prepare('SELECT * FROM message_revision WHERE message_id = ? ORDER BY n')
        .all(messageId) as Row[]
    ).map((r) => {
      const kind = r.error_kind as ErrorKind | null;
      return {
        revisionId: r.id as string,
        revision: r.n as number,
        content: r.content as string,
        status: r.status as MessageStatus,
        error: kind ? { kind, message: (r.error_message as string | null) ?? '' } : null,
        model: (r.model as string | null) ?? null,
        headline: (r.headline as string | null | undefined) ?? null,
        createdAt: r.created_at as string,
      };
    });
  }

  /** Make an earlier finished revision the one later questions use (and search finds). */
  useRevision(messageId: string, revisionId: string): Message {
    return this.db.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new NotFoundError('message');
      this.notInTrash(message.threadId);
      if (message.status === 'pending' || message.status === 'streaming') {
        throw new ConflictError('it is still being answered');
      }
      const row = this.db.sql
        .prepare('SELECT status, content FROM message_revision WHERE id = ? AND message_id = ?')
        .get(revisionId, messageId) as { status: string; content: string } | undefined;
      if (!row) throw new NotFoundError('revision');
      this.db.sql.prepare('UPDATE message SET current_revision_id = ? WHERE id = ?').run(revisionId, messageId);
      if (row.content) this.index('message', messageId, message.threadId, row.content);
      else this.db.sql.prepare("DELETE FROM search WHERE target_id = ? AND kind = 'message'").run(messageId);
      this.logEvent('answer.revision_chosen', messageId, { revisionId });
      return this.getMessage(messageId) as Message;
    });
  }

  findAsk(userMessageId: string): AskPair | null {
    const user = this.getMessage(userMessageId);
    if (user?.role !== 'user') return null;
    const row = this.db.sql
      .prepare(`${MESSAGE_SELECT} WHERE m.reply_to = ? AND m.role = 'assistant' ORDER BY m.seq LIMIT 1`)
      .get(userMessageId) as Row | undefined;
    return row ? { user, assistant: toMessage(row) } : null;
  }

  /**
   * Store a question and an empty pending answer in one transaction.
   * Idempotent on the user message id: the same id and text returns the
   * existing pair; the same id with different text is a conflict.
   */
  createAsk(threadId: string, userMessageId: string, content: string): { pair: AskPair; created: boolean } {
    return this.db.tx(() => {
      const existing = this.findAsk(userMessageId);
      if (existing) {
        if (existing.user.threadId !== threadId || existing.user.content !== content) {
          throw new ConflictError('message id already used for a different question');
        }
        return { pair: existing, created: false };
      }
      if (this.getMessage(userMessageId)) throw new ConflictError('message id already used');
      this.notInTrash(threadId);
      const t = now();
      const seqRow = this.db.sql
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM message WHERE thread_id = ?')
        .get(threadId) as { next: number };
      const seq = seqRow.next;
      const assistantId = ulid();
      const userRev = ulid();
      const assistantRev = ulid();
      const insertMessage = this.db.sql.prepare(
        'INSERT INTO message (id, thread_id, role, seq, reply_to, current_revision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const insertRevision = this.db.sql.prepare(
        'INSERT INTO message_revision (id, message_id, n, content, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
      );
      insertMessage.run(userMessageId, threadId, 'user', seq, null, userRev, t);
      insertRevision.run(userRev, userMessageId, content, 'done', t, t);
      insertMessage.run(assistantId, threadId, 'assistant', seq + 1, userMessageId, assistantRev, t);
      insertRevision.run(assistantRev, assistantId, '', 'pending', t, t);
      this.db.sql
        .prepare("UPDATE thread SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
        .run(t, titleFrom(content), threadId);
      const thread = this.getThread(threadId);
      if (thread && seq === 0) this.index('thread', threadId, threadId, thread.title);
      this.index('message', userMessageId, threadId, content);
      this.logEvent('message.asked', userMessageId, { threadId, chars: content.length });
      const pair = this.findAsk(userMessageId);
      if (!pair) throw new Error('ask was not stored');
      return { pair, created: true };
    });
  }

  // Titles ------------------------------------------------------------------

  titleSourceOf(threadId: string): 'question' | 'model' | 'user' | null {
    const row = this.db.sql.prepare('SELECT title_source FROM thread WHERE id = ?').get(threadId) as
      | { title_source: 'question' | 'model' | 'user' }
      | undefined;
    return row?.title_source ?? null;
  }

  /**
   * Set a title. A model-written title only replaces the first-question title,
   * never one the learner chose. Returns whether the title changed.
   */
  setTitle(threadId: string, title: string, source: 'model' | 'user'): boolean {
    return this.db.tx(() => {
      const guard = source === 'model' ? " AND title_source = 'question'" : '';
      const result = this.db.sql
        .prepare(`UPDATE thread SET title = ?, title_source = ? WHERE id = ?${guard}`)
        .run(title, source, threadId);
      if (Number(result.changes) === 0) return false;
      this.index('thread', threadId, threadId, title);
      return true;
    });
  }

  /** Threads still titled by their first question that have a finished answer, oldest first. */
  untitledThreads(limit: number): string[] {
    const rows = this.db.sql
      .prepare(
        `SELECT DISTINCT t.id, t.created_at FROM thread t
         JOIN message m ON m.thread_id = t.id AND m.role = 'assistant'
         JOIN message_revision r ON r.id = m.current_revision_id AND r.status = 'done'
         WHERE t.title_source = 'question'
         ORDER BY t.created_at LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // Split -------------------------------------------------------------------

  /**
   * Make a branch its own thread, or put it back. A thread made its own is
   * listed at the top level, has its own map and notes, and stops sending the
   * parent conversation to the model; it keeps its origin, so Back still works.
   */
  setSplit(threadId: string, split: boolean): Thread | null {
    return this.db.tx(() => {
      const thread = this.getThread(threadId);
      if (!thread) return null;
      if (!thread.parentThreadId) throw new InvalidError('only a side question can be made its own thread');
      if (Boolean(thread.splitAt) === split) return thread;
      this.db.sql.prepare('UPDATE thread SET split_at = ?, updated_at = ? WHERE id = ?').run(split ? now() : null, now(), threadId);
      this.logEvent(split ? 'thread.split' : 'thread.unsplit', threadId, { parentThreadId: thread.parentThreadId });
      return this.getThread(threadId);
    });
  }

  // Sources -------------------------------------------------------------------
  //
  // What the learner reads. The text shown is an immutable Markdown version:
  // fetching again adds a version only when the text changed, and a passage
  // asked about stays anchored to the version that was shown. A thread asked
  // about a passage is a thread of its own that starts there.

  getSource(id: string): Source | null {
    const r = this.db.sql
      .prepare(
        `SELECT s.*,
           (SELECT id FROM source_version v WHERE v.source_id = s.id ORDER BY seq DESC LIMIT 1) AS latest,
           (SELECT count(*) FROM source_version v WHERE v.source_id = s.id) AS versions,
           (SELECT count(*) FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id
              JOIN source_version v ON v.id = a.version_id
            WHERE v.source_id = s.id AND t.deleted_at IS NULL) AS threads
         FROM source s WHERE s.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r || !r.latest) return null;
    return {
      id: r.id as string,
      notebookId: r.notebook_id as string,
      title: r.title as string,
      url: (r.url as string | null) ?? null,
      latestVersionId: r.latest as string,
      versions: r.versions as number,
      threads: r.threads as number,
      deletedAt: (r.deleted_at as string | null) ?? null,
      linked: r.folder_id ? { folderId: r.folder_id as string, path: r.file_path as string } : null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listSources(notebookId: string): Source[] {
    const ids = this.db.sql
      .prepare('SELECT id FROM source WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(notebookId) as Row[];
    return ids.map((r) => this.getSource(r.id as string)).filter((x): x is Source => x !== null);
  }

  private getVersion(id: string): (SourceVersion & { hash: string }) | null {
    // Not the kept page or file itself (`raw`): a PDF can be megabytes.
    const r = this.db.sql
      .prepare(
        `SELECT id, source_id, seq, content, content_hash, origin, fetched_url, media_type, file_name, created_at,
           ${RAW_BYTES} AS raw_bytes
         FROM source_version WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    return r
      ? {
          id: r.id as string,
          sourceId: r.source_id as string,
          seq: r.seq as number,
          content: r.content as string,
          origin: originOf(r),
          fetchedUrl: (r.fetched_url as string | null) ?? null,
          file:
            r.media_type === 'application/pdf'
              ? { type: 'application/pdf', name: (r.file_name as string | null) ?? null, bytes: Number(r.raw_bytes ?? 0) }
              : null,
          createdAt: r.created_at as string,
          hash: r.content_hash as string,
        }
      : null;
  }

  /** Keep a picture of a page of a PDF version. The first one made stays (the page never changes). */
  savePageImage(
    sourceId: string,
    versionId: string,
    page: number,
    image: { mediaType: string; data: string; width: number; height: number },
  ): { created: boolean } {
    return this.db.tx(() => {
      const version = this.getVersion(versionId);
      if (!version || version.sourceId !== sourceId) throw new NotFoundError('version');
      if (!version.file) throw new InvalidError('only a PDF has pages');
      const pages = (version.content.match(/^## Page \d+$/gm) ?? []).length;
      if (page < 1 || page > pages) throw new InvalidError(`it has ${pages} pages`);
      const r = this.db.sql
        .prepare(
          `INSERT INTO source_page_image (version_id, page, media_type, data, width, height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(versionId, page, image.mediaType, image.data, image.width, image.height, now());
      return { created: Number(r.changes) > 0 };
    });
  }

  /** A picture of a page, as kept. */
  pageImage(versionId: string, page: number): { mediaType: string; data: string } | null {
    const r = this.db.sql
      .prepare('SELECT media_type, data FROM source_page_image WHERE version_id = ? AND page = ?')
      .get(versionId, page) as Row | undefined;
    return r ? { mediaType: r.media_type as string, data: r.data as string } : null;
  }

  /** Which of these pages have a picture. */
  pagesWithImages(versionId: string, pages: number[]): number[] {
    if (pages.length === 0) return [];
    const rows = this.db.sql
      .prepare(`SELECT page FROM source_page_image WHERE version_id = ? AND page IN (${pages.map(() => '?').join(', ')})`)
      .all(versionId, ...pages) as Row[];
    const have = new Set(rows.map((r) => Number(r.page)));
    return pages.filter((p) => have.has(p));
  }

  /** The file kept with a version of a source (a PDF), to open it. */
  versionFile(sourceId: string, versionId: string): { bytes: Buffer; type: string; name: string | null } | null {
    const r = this.db.sql
      .prepare('SELECT raw, media_type, file_name FROM source_version WHERE id = ? AND source_id = ?')
      .get(versionId, sourceId) as Row | undefined;
    if (!r || r.media_type !== 'application/pdf' || typeof r.raw !== 'string') return null;
    return { bytes: Buffer.from(r.raw, 'base64'), type: r.media_type, name: (r.file_name as string | null) ?? null };
  }

  /** A new source with its first version. Idempotent on the id. */
  createSource(
    id: string,
    notebookId: string,
    init: { title: string; url: string | null; version: NewSourceVersion },
  ): { source: Source; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getSource(id);
      if (existing) {
        if (existing.notebookId !== notebookId) throw new ConflictError('source id already used');
        return { source: existing, created: false };
      }
      if (!init.version.content.trim()) throw new InvalidError('there is no text to read in it');
      const t = now();
      this.db.sql
        .prepare('INSERT INTO source (id, notebook_id, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, notebookId, init.title.trim() || 'Untitled source', init.url, t, t);
      this.insertVersion(id, 1, init.version, t);
      this.indexSource(id);
      this.logEvent('source.added', id, {
        origin: init.version.origin,
        chars: init.version.content.length,
        ...(init.version.pages !== undefined ? { pages: init.version.pages } : {}),
      });
      return { source: this.getSource(id) as Source, created: true };
    });
  }

  /** Fetched again: a new version only if the text changed. */
  addSourceVersion(sourceId: string, version: NewSourceVersion): { source: Source; changed: boolean } {
    return this.db.tx(() => {
      const source = this.getSource(sourceId);
      if (!source) throw new NotFoundError('source');
      if (source.deletedAt) throw new ConflictError('this source is in the Trash: restore it first');
      const latest = this.getVersion(source.latestVersionId) as SourceVersion & { hash: string };
      if (latest.hash === contentHash(version.content) || !version.content.trim()) {
        return { source, changed: false };
      }
      const t = now();
      this.insertVersion(sourceId, latest.seq + 1, version, t);
      this.db.sql.prepare('UPDATE source SET updated_at = ? WHERE id = ?').run(t, sourceId);
      this.indexSource(sourceId);
      this.logEvent('source.refetched', sourceId, { seq: latest.seq + 1 });
      return { source: this.getSource(sourceId) as Source, changed: true };
    });
  }

  private insertVersion(sourceId: string, seq: number, v: NewSourceVersion, t: string): void {
    this.db.sql
      .prepare(
        `INSERT INTO source_version (id, source_id, seq, content, content_hash, origin, fetched_url, raw, extractor,
           media_type, file_name, file_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        sourceId,
        seq,
        v.content,
        contentHash(v.content),
        // A file given is stored as given ('paste'): see migration 014.
        v.origin === 'file' ? 'paste' : v.origin,
        v.fetchedUrl,
        v.raw,
        v.extractor,
        v.mediaType ?? null,
        v.fileName ?? null,
        v.fileHash ?? null,
        t,
      );
  }

  // Rooms (ADR 0026) --------------------------------------------------------

  /** What a room needs to know about the notebook: threads, sources, notes and pins, with counts. */
  roomGraph(notebookId: string): RoomGraph {
    const asked = new Map(
      (
        this.db.sql
          .prepare(
            `SELECT m.thread_id, count(*) AS n FROM message m JOIN thread t ON t.id = m.thread_id
             WHERE t.notebook_id = ? AND m.role = 'user' GROUP BY m.thread_id`,
          )
          .all(notebookId) as Row[]
      ).map((r) => [r.thread_id as string, Number(r.n)]),
    );
    const open = new Set(this.openBranches(notebookId, 10_000).map((b) => b.threadId));
    const blocks = new Map(
      (
        this.db.sql
          .prepare(
            `SELECT b.note_id, count(*) AS n FROM note_block b JOIN note n ON n.id = b.note_id
             WHERE n.notebook_id = ? AND b.deleted_at IS NULL GROUP BY b.note_id`,
          )
          .all(notebookId) as Row[]
      ).map((r) => [r.note_id as string, Number(r.n)]),
    );
    const pins = (
      this.db.sql
        .prepare(
          `SELECT DISTINCT p.thread_id, v.source_id FROM pin p
           JOIN source_anchor a ON a.id = p.source_anchor_id
           JOIN source_version v ON v.id = a.version_id
           JOIN thread t ON t.id = p.thread_id
           WHERE t.notebook_id = ?`,
        )
        .all(notebookId) as Row[]
    ).map((r) => ({ threadId: r.thread_id as string, sourceId: r.source_id as string }));
    return {
      threads: this.listThreads(notebookId).map((t) => ({
        id: t.id,
        title: t.title,
        parentThreadId: t.parentThreadId,
        splitAt: t.splitAt,
        continuedFromId: t.continuedFromId,
        mergedIntoId: t.mergedIntoId,
        sourceId: t.sourceId,
        sourceQuote: t.sourceQuote,
        updatedAt: t.updatedAt,
        questions: asked.get(t.id) ?? 0,
        open: open.has(t.id),
      })),
      sources: this.listSources(notebookId).map((x) => ({ id: x.id, title: x.title, updatedAt: x.updatedAt, linked: x.linked !== null })),
      notes: this.listNotes(notebookId).map((n) => ({
        id: n.id,
        title: n.title,
        threadId: n.threadId,
        cites: [...new Set(Object.values(n.refs).map((r) => r.threadId))],
        blocks: blocks.get(n.id) ?? 0,
        updatedAt: n.updatedAt,
      })),
      pins,
    };
  }

  private roomRows(roomId: string): RoomRow[] {
    return (
      this.db.sql.prepare('SELECT * FROM room_item WHERE room_id = ? ORDER BY created_at, rowid').all(roomId) as Row[]
    ).map((r) => ({
      kind: r.kind as RoomKind,
      id: r.item_id as string,
      state: r.state as RoomRow['state'],
      x: (r.x as number | null) ?? null,
      y: (r.y as number | null) ?? null,
      at: r.created_at as string,
    }));
  }

  /**
   * A concept's things (ADRs 0036, 0037): the materials whose mentions joined it, and those put in it by hand, less
   * those taken out of it; of what is still there.
   */
  private conceptMembers(id: string, rows: RoomRow[], graph: RoomGraph): string[] {
    const there = new Set<string>([
      ...graph.threads.map((t) => roomKey('thread', t.id)),
      ...graph.sources.map((x) => roomKey('source', x.id)),
      ...graph.notes.map((n) => roomKey('note', n.id)),
    ]);
    const out = new Set<string>(rows.filter((x) => x.state === 'out').map((x) => roomKey(x.kind, x.id)));
    const keys = new Set<string>();
    for (const m of this.db.sql
      .prepare('SELECT kind, item_id FROM concept_mention WHERE concept_id = ? AND kept = 1 GROUP BY kind, item_id ORDER BY min(created_at)')
      .all(id) as Row[]) {
      keys.add(roomKey(m.kind as RoomKind, m.item_id as string));
    }
    for (const x of rows) if (x.state === 'in') keys.add(roomKey(x.kind, x.id));
    return [...keys].filter((k) => there.has(k) && !out.has(k));
  }

  private toRoom(r: Row, graph: RoomGraph, doors: KindDoor[]): Room {
    const id = r.id as string;
    const concept = r.kind === 'concept';
    const members = concept ? this.conceptMembers(id, this.roomRows(id), graph) : [...roomMembers(this.roomRows(id), graph).keys()];
    // Its concepts are not rooms in it: they are part of it (ADR 0036).
    const rooms = doors.filter((d) => d.parent === id && !d.concept).map((d) => d.child);
    const counts = { sources: 0, threads: 0, notes: 0, rooms: rooms.length };
    for (const k of members) counts[k.startsWith('source:') ? 'sources' : k.startsWith('thread:') ? 'threads' : 'notes'] += 1;
    return {
      id,
      notebookId: r.notebook_id as string,
      title: r.title as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      members,
      counts,
      web: r.web === undefined ? true : Number(r.web) === 1,
      parents: doors.filter((d) => d.child === id).map((d) => d.parent),
      rooms,
      kind: concept ? 'concept' : 'room',
      status: r.status === 'suggested' ? 'suggested' : 'kept',
    };
  }

  /** Rooms in rooms (ADR 0032): every door of a notebook, as (room, the room in it), in the order they were made. */
  private doors(notebookId: string): KindDoor[] {
    return (
      this.db.sql
        .prepare(
          `SELECT d.room_id, d.child_id, c.kind FROM room_door d JOIN room r ON r.id = d.room_id JOIN room c ON c.id = d.child_id
           WHERE r.notebook_id = ? ORDER BY d.created_at, d.rowid`,
        )
        .all(notebookId) as Row[]
    ).map((r) => ({ parent: r.room_id as string, child: r.child_id as string, concept: r.kind === 'concept' }));
  }

  /**
   * What a room's brief is written from (ADR 0030): each thing in it as it is now, and (ADR 0032) the brief of each
   * room in it as it was last written. A room with no rooms in it hashes as it did before rooms could hold rooms.
   */
  private briefBasisOf(roomId: string, members: string[], bases: Map<string, string>, doors: KindDoor[]): string {
    const keys = [...members];
    const at = new Map(bases);
    const written = this.db.sql.prepare('SELECT created_at FROM room_brief WHERE room_id = ?');
    for (const d of doors) {
      // Its concepts are read with it, not briefed on their own (ADR 0036).
      if (d.parent !== roomId || d.concept) continue;
      const key = `room:${d.child}`;
      keys.push(key);
      at.set(key, ((written.get(d.child) as Row | undefined)?.created_at as string | undefined) ?? '');
    }
    return briefBasis(keys, at);
  }

  /** Put a room in another (ADR 0032), at a place on its map if given; never inside itself, at any depth. */
  putRoomIn(parentId: string, childId: string, at: { x?: number; y?: number } = {}, by: 'you' | 'assistant' = 'you'): Room {
    return this.db.tx(() => {
      const get = this.db.sql.prepare('SELECT id, notebook_id, title, kind FROM room WHERE id = ?');
      const parent = get.get(parentId) as Row | undefined;
      const child = get.get(childId) as Row | undefined;
      if (!parent || !child || parent.notebook_id !== child.notebook_id) throw new NotFoundError('room');
      if (parent.kind === 'concept') throw new InvalidError('A concept holds things, not rooms: make it a room first.');
      if (parentId === childId) throw new InvalidError('A room cannot be put inside itself.');
      if (wouldLoop(this.doors(parent.notebook_id as string), parentId, childId)) {
        throw new InvalidError(`“${parent.title as string}” is inside “${child.title as string}”, so “${child.title as string}” cannot go in it.`);
      }
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO room_door (room_id, child_id, x, y, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (room_id, child_id) DO UPDATE SET
             x = coalesce(excluded.x, room_door.x), y = coalesce(excluded.y, room_door.y), updated_at = excluded.updated_at`,
        )
        .run(parentId, childId, at.x ?? null, at.y ?? null, by, t, t);
      this.db.sql.prepare('UPDATE room SET updated_at = ? WHERE id = ?').run(t, parentId);
      this.logEvent('room.put_in', parentId, { by });
      return this.getRoom(parentId) as Room;
    });
  }

  /** Take a room out of another; it stays where else it is, and in the list. */
  takeRoomOut(parentId: string, childId: string): Room {
    const room = this.getRoom(parentId);
    if (!room) throw new NotFoundError('room');
    const r = this.db.sql.prepare('DELETE FROM room_door WHERE room_id = ? AND child_id = ?').run(parentId, childId);
    if (Number(r.changes) > 0) {
      this.db.sql.prepare('UPDATE room SET updated_at = ? WHERE id = ?').run(now(), parentId);
      this.logEvent('room.taken_out', parentId);
    }
    return this.getRoom(parentId) as Room;
  }

  /** Where the rooms in a room sit on its map. */
  placeDoors(parentId: string, places: Array<{ room: string; x: number; y: number }>): void {
    const put = this.db.sql.prepare('UPDATE room_door SET x = ?, y = ?, updated_at = ? WHERE room_id = ? AND child_id = ?');
    const t = now();
    this.db.tx(() => {
      for (const p of places) put.run(Math.round(p.x), Math.round(p.y), t, parentId, p.room);
    });
  }

  /** A door's row as it is, to put it back (the Assistant's Undo). */
  doorRow(parentId: string, childId: string): Record<string, unknown> | null {
    const r = this.db.sql.prepare('SELECT * FROM room_door WHERE room_id = ? AND child_id = ?').get(parentId, childId) as Row | undefined;
    return r ? { ...r } : null;
  }

  putDoorRow(row: Record<string, unknown>): void {
    const exists = this.db.sql.prepare('SELECT 1 FROM room WHERE id = ?');
    if (!exists.get(row.room_id as string) || !exists.get(row.child_id as string)) return;
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`INSERT OR REPLACE INTO room_door (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(cols.map((c) => row[c]) as Array<string | number | null>));
  }

  /** The rooms in a room, as doors: what each holds, a few of its things, its brief. */
  private roomDoors(roomId: string, graph: RoomGraph, doors: KindDoor[], bases: Map<string, string>): RoomDoor[] {
    const known = new Map<string, { title: string; at: string }>();
    for (const t of graph.threads) known.set(roomKey('thread', t.id), { title: t.title, at: t.updatedAt });
    for (const x of graph.sources) known.set(roomKey('source', x.id), { title: x.title, at: x.updatedAt });
    for (const n of graph.notes) known.set(roomKey('note', n.id), { title: n.title, at: n.updatedAt });
    const getRoom = this.db.sql.prepare('SELECT * FROM room WHERE id = ?');
    const getBrief = this.db.sql.prepare('SELECT * FROM room_brief WHERE room_id = ?');
    const rows = this.db.sql.prepare('SELECT * FROM room_door WHERE room_id = ? ORDER BY created_at, rowid').all(roomId) as Row[];
    return rows.flatMap((d) => {
      const child = getRoom.get(d.child_id as string) as Row | undefined;
      if (!child || child.kind === 'concept') return [];
      const id = child.id as string;
      const members = [...roomMembers(this.roomRows(id), graph).keys()];
      const inner = doors.filter((x) => x.parent === id && !x.concept).map((x) => x.child);
      const counts = { sources: 0, threads: 0, notes: 0, rooms: inner.length };
      for (const k of members) counts[k.startsWith('source:') ? 'sources' : k.startsWith('thread:') ? 'threads' : 'notes'] += 1;
      const brief = getBrief.get(id) as Row | undefined;
      const titleOf = new Map(inner.map((c) => [c, ((getRoom.get(c) as Row | undefined)?.title as string | undefined) ?? '']));
      const newest = [...members].sort((a, b) => (known.get(b)?.at ?? '').localeCompare(known.get(a)?.at ?? ''));
      const things = [
        ...inner.map((c) => ({ kind: 'room' as const, title: titleOf.get(c) ?? '' })),
        ...newest.map((k) => ({ kind: k.slice(0, k.indexOf(':')) as 'thread' | 'source' | 'note', title: known.get(k)?.title ?? '' })),
      ].slice(0, 4);
      const kinds = [...inner.map(() => 'room' as const), ...members.map((k) => k.slice(0, k.indexOf(':')) as 'thread' | 'source' | 'note')].slice(0, 24);
      return [
        {
          id,
          title: child.title as string,
          x: (d.x as number | null) ?? null,
          y: (d.y as number | null) ?? null,
          counts,
          brief: brief ? (brief.text as string) : null,
          fresh: brief ? brief.basis === this.briefBasisOf(id, members, bases, doors) : false,
          things,
          kinds,
        },
      ];
    });
  }

  /** Whether questions asked in a room may search the web (ADR 0031). */
  setRoomWeb(id: string, on: boolean): Room | null {
    const r = this.db.sql.prepare('UPDATE room SET web = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now(), id);
    return Number(r.changes) > 0 ? this.getRoom(id) : null;
  }

  /** What a search of the web found, kept for an answer (its revision) or for a room. */
  /**
   * Of the pages a search found for an answer, keep on offer only those the answer cites, in the order cited
   * (ADR 0033): the rest go. Pages already added stay.
   */
  keepCitedWebFinds(revisionId: string, cited: number[]): void {
    const keep = cited.slice(0, WEB_OFFERED);
    this.db.sql
      .prepare(
        `DELETE FROM web_find WHERE revision_id = ? AND status = 'found'${keep.length ? ` AND n NOT IN (${keep.map(() => '?').join(', ')})` : ''}`,
      )
      .run(revisionId, ...keep);
  }

  saveWebFinds(
    notebookId: string,
    at: { revisionId: string | null; roomId: string | null },
    finds: Array<{ id: string; n: number; query: string; title: string; url: string; snippet: string; summary: string; site: string | null; date: string | null; score: number | null }>,
  ): void {
    const t = now();
    const put = this.db.sql.prepare(
      `INSERT OR IGNORE INTO web_find (id, notebook_id, room_id, revision_id, n, query, title, url, snippet, summary, site, date, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.tx(() => {
      for (const f of finds) {
        put.run(f.id, notebookId, at.roomId, at.revisionId, f.n, f.query, f.title, f.url, f.snippet, f.summary, f.site, f.date, f.score, t, t);
      }
    });
  }

  webFind(id: string): (WebFind & { notebookId: string; roomId: string | null; revisionId: string | null }) | null {
    const r = this.db.sql.prepare('SELECT * FROM web_find WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return { ...toWebFind(r), notebookId: r.notebook_id as string, roomId: (r.room_id as string | null) ?? null, revisionId: (r.revision_id as string | null) ?? null };
  }

  setWebFind(id: string, status: WebFind['status'], sourceId: string | null = null): WebFind | null {
    this.db.sql.prepare('UPDATE web_find SET status = ?, source_id = coalesce(?, source_id), updated_at = ? WHERE id = ?').run(status, sourceId, now(), id);
    const f = this.webFind(id);
    if (f) this.logEvent('web.find', id, { status });
    return f;
  }

  /** Pages found for a room's open questions, not yet added or dismissed (newest first), and the URLs it already has. */
  roomWebFinds(roomId: string): WebFind[] {
    return (
      this.db.sql
        .prepare("SELECT * FROM web_find WHERE room_id = ? AND revision_id IS NULL AND status = 'found' ORDER BY created_at DESC, n")
        .all(roomId) as Row[]
    ).map(toWebFind);
  }

  /** The notebook's rooms, in the order they were made: places stay put. */
  listRooms(notebookId: string): Room[] {
    const graph = this.roomGraph(notebookId);
    const doors = this.doors(notebookId);
    return (
      this.db.sql.prepare("SELECT * FROM room WHERE notebook_id = ? AND kind = 'room' ORDER BY created_at, rowid").all(notebookId) as Row[]
    ).map((r) => this.toRoom(r, graph, doors));
  }

  getRoom(id: string): Room | null {
    const r = this.db.sql.prepare('SELECT * FROM room WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const notebookId = r.notebook_id as string;
    return this.toRoom(r, this.roomGraph(notebookId), this.doors(notebookId));
  }

  /** A room drawn: clusters of what belongs together, the lines between them, summaries and links (ADR 0027). */
  roomView(id: string): Omit<RoomView, 'reading' | 'webAvailable'> | null {
    const r = this.db.sql.prepare('SELECT * FROM room WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const notebookId = r.notebook_id as string;
    const graph = this.roomGraph(notebookId);
    const doors = this.doors(notebookId);
    const rows = this.roomRows(id);
    const { clusters, links } = roomMap(rows, graph);
    const members = [...roomMembers(rows, graph).keys()];
    const bases = this.itemBases(notebookId);
    const saved = this.gists(members);
    const gists: Record<string, Gist> = {};
    let unread = 0;
    for (const key of members) {
      const g = saved.get(key);
      const fresh = g !== undefined && g.basis === bases.get(key);
      if (!fresh) unread += 1;
      if (g) gists[key] = { text: g.text, points: g.points, model: g.model, at: g.at, fresh };
    }
    const inRoom = new Set<string>(members);
    const itemLinks = this.listItemLinks(notebookId).filter(
      (l) => l.status !== 'dismissed' && inRoom.has(roomKey(l.from.kind, l.from.id)) && inRoom.has(roomKey(l.to.kind, l.to.id)),
    );
    const b = this.db.sql.prepare('SELECT * FROM room_brief WHERE room_id = ?').get(id) as Row | undefined;
    const brief = b
      ? {
          text: b.text as string,
          open: JSON.parse(b.open as string) as NonNullable<RoomView['brief']>['open'],
          model: b.model as string,
          at: b.created_at as string,
          fresh: b.basis === this.briefBasisOf(id, members, bases, doors),
        }
      : null;
    const concepts = this.conceptsIn(id, notebookId, graph, inRoom);
    const shown = new Set(concepts.map((c) => c.id));
    return {
      room: this.toRoom(r, graph, doors),
      clusters,
      links,
      gists,
      itemLinks,
      unread,
      brief,
      webFinds: this.roomWebFinds(id),
      doors: this.roomDoors(id, graph, doors, bases),
      concepts,
      conceptLinks: this.conceptLinks(notebookId).filter((l) => shown.has(l.from) && shown.has(l.to)),
      guesses: [],
      conceptXY: (this.db.sql.prepare('SELECT concept_id, x, y FROM concept_xy WHERE room_id = ?').all(id) as Row[])
        .filter((x) => shown.has(x.concept_id as string))
        .map((x) => ({ id: x.concept_id as string, x: Number(x.x), y: Number(x.y) })),
      conceptsToRead: this.conceptsToRead(members.filter((k) => !k.startsWith('source:')), this.conceptBases(notebookId, graph, bases)),
    };
  }

  /**
   * When a material's words were last as they are, for its pieces' hashes kept between views: a thread's own
   * basis moves when a question is asked, not when its answer ends, so its messages' last change is added.
   */
  private conceptBases(notebookId: string, graph: RoomGraph, bases: Map<string, string>): Map<string, string> {
    const out = new Map(bases);
    const byId = new Map(graph.threads.map((t) => [t.id, t]));
    const rows = this.db.sql
      .prepare(
        `SELECT m.thread_id AS id, max(r.updated_at) AS at, count(*) AS n, sum(length(r.content)) AS len
         FROM message m JOIN message_revision r ON r.id = m.current_revision_id JOIN thread t ON t.id = m.thread_id
         WHERE t.notebook_id = ? GROUP BY m.thread_id`,
      )
      .all(notebookId) as Row[];
    const extra = new Map<string, string[]>();
    for (const r of rows) {
      const key = roomKey('thread', threadOf(r.id as string, byId));
      extra.set(key, [...(extra.get(key) ?? []), `${r.id}:${r.at}:${r.n}:${r.len}`]);
    }
    for (const [key, parts] of extra) out.set(key, `${out.get(key) ?? ''}|${parts.sort().join(',')}`);
    return out;
  }

  // Concepts (ADRs 0036, 0037) --------------------------------------------------
  // A concept is a room of kind 'concept' that belongs to the notebook. Its things are the materials whose
  // mentions were joined to it, and those put in it by hand, less those taken out of it. It is in every room
  // its things are in.

  private conceptRow(id: string): Row | undefined {
    return this.db.sql.prepare("SELECT * FROM room WHERE id = ? AND kind = 'concept'").get(id) as Row | undefined;
  }

  /**
   * The concepts of a room: those its things are in, the most of them first, kept before suggested; then the
   * concepts and topics they are under (ADR 0038), so the room can be read from far: a topic is in a room through
   * what it holds there.
   */
  private conceptsIn(roomId: string, notebookId: string, graph: RoomGraph, inRoom: Set<string>): Concept[] {
    const rows = this.db.sql.prepare("SELECT * FROM room WHERE notebook_id = ? AND kind = 'concept' ORDER BY created_at, rowid").all(notebookId) as Row[];
    if (rows.length === 0) return [];
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const homes = this.conceptHomeRows(notebookId);
    const mainHome = new Map<string, Row>();
    const others = new Map<string, Row[]>();
    for (const h of homes) {
      if (h.status === 'dismissed' || !byId.has(h.parent_id as string)) continue;
      if (h.main === 1 && !mainHome.has(h.child_id as string)) mainHome.set(h.child_id as string, h);
      else others.set(h.child_id as string, [...(others.get(h.child_id as string) ?? []), h]);
    }
    const holds = new Set([...mainHome.values(), ...[...others.values()].flat()].map((h) => h.parent_id as string));
    const titles = new Map<string, string>([
      ...graph.threads.map((t) => [roomKey('thread', t.id), t.title] as const),
      ...graph.sources.map((x) => [roomKey('source', x.id), x.title] as const),
      ...graph.notes.map((n) => [roomKey('note', n.id), n.title] as const),
    ]);
    const membersOf = new Map<string, string[]>();
    const memberKeys = (id: string) => {
      let m = membersOf.get(id);
      if (!m) {
        m = this.conceptMembers(id, this.roomRows(id), graph);
        membersOf.set(id, m);
      }
      return m;
    };
    // Those its things are in (or made in it), then what they are under, up to the top.
    const madeHere = new Set(
      (this.db.sql.prepare('SELECT concept_id FROM concept_shown WHERE room_id = ?').all(roomId) as Row[]).map((r) => r.concept_id as string),
    );
    const shown: string[] = [];
    const isShown = new Set<string>();
    for (const r of rows) {
      const id = r.id as string;
      if (madeHere.has(id) || memberKeys(id).some((k) => inRoom.has(k))) {
        shown.push(id);
        isShown.add(id);
      }
    }
    for (let i = 0; i < shown.length; i++) {
      const up = mainHome.get(shown[i] as string)?.parent_id as string | undefined;
      if (up && !isShown.has(up)) {
        shown.push(up);
        isShown.add(up);
      }
    }
    let rooms: Room[] | null = null;
    const homeOf = (h: Row): Concept['alsoUnder'][number] => ({
      id: h.parent_id as string,
      how: h.how as Concept['alsoUnder'][number]['how'],
      status: h.status === 'kept' ? 'kept' : 'suggested',
      by: h.made_by === 'ai' ? 'ai' : 'you',
    });
    const out: Array<Concept & { here: number }> = [];
    for (const id of shown) {
      const c = byId.get(id) as Row;
      const members = memberKeys(id);
      const here = members.filter((k) => inRoom.has(k));
      rooms ??= this.listRooms(notebookId);
      const mentions = this.db.sql.prepare('SELECT * FROM concept_mention WHERE concept_id = ? ORDER BY created_at, rowid').all(id) as Row[];
      const by = new Map<string, ConceptPlace[]>();
      for (const m of mentions) {
        const key = roomKey(m.kind as RoomKind, m.item_id as string);
        if (!titles.has(key)) continue;
        if (m.kept !== 0 && !members.includes(key)) continue;
        const list = by.get(key) ?? [];
        list.push(toPlace(m));
        by.set(key, list);
      }
      // Where it is said what it is first, then where it is discussed most; the same order every time. Materials
      // found for it, not kept yet, come last.
      const weight = (places: ConceptPlace[]) =>
        (places.some((p) => p.kept) ? 10_000 : 0) + (places.some((p) => p.kept && (p.role === 'defines' || p.role === 'explains')) ? 1000 : 0) + places.length;
      const keys = [...new Set([...members, ...[...by.keys()].filter((k) => !members.includes(k))])];
      const sources = keys
        .map((k) => ({ item: k as Concept['members'][number], title: titles.get(k) ?? '', inRoom: inRoom.has(k), places: by.get(k) ?? [] }))
        .sort((a, b) => weight(b.places) - weight(a.places) || a.title.localeCompare(b.title) || a.item.localeCompare(b.item));
      const kept = mentions.filter((m) => m.kept !== 0);
      const places = sources.reduce((n, x) => n + x.places.filter((p) => p.kept).length, 0);
      let quote: Concept['quote'] = null;
      if (c.definition_at) {
        const parsed = VaultTarget.safeParse(JSON.parse(c.definition_at as string));
        if (parsed.success) quote = parsed.data;
      }
      const names = (this.db.sql.prepare('SELECT name FROM concept_name WHERE concept_id = ? ORDER BY created_at, rowid').all(id) as Row[])
        .map((r) => r.name as string)
        .filter((n) => conceptKey(n) !== conceptKey(c.title as string));
      const main = mainHome.get(id);
      out.push({
        id,
        title: c.title as string,
        status: c.status === 'suggested' ? 'suggested' : 'kept',
        definition: (c.definition as string | null) ?? null,
        quote,
        members: here as Concept['members'],
        also: rooms.filter((r) => r.id !== roomId && r.members.some((k) => members.includes(k))).map((r) => r.id),
        by: c.made_by === 'ai' ? 'ai' : 'you',
        names: [...new Set(names)],
        materials: members.length,
        places,
        sources,
        lost: c.status === 'kept' && places === 0 && kept.length === 0 && c.made_by === 'ai' && !holds.has(id),
        scope: (c.scope as string | null) ?? null,
        home: main ? homeOf(main) : null,
        alsoUnder: (others.get(id) ?? []).map(homeOf),
        work: {
          questions: kept.filter((m) => m.role === 'asks' && m.kind === 'thread').length,
          notes: members.filter((k) => k.startsWith('note:')).length,
          materials: members.length,
        },
        here: here.length,
      });
    }
    const first = out.filter((c) => c.here > 0 || madeHere.has(c.id));
    first.sort((a, b) => b.here - a.here || (a.status === b.status ? 0 : a.status === 'kept' ? -1 : 1) || b.places - a.places);
    return [...first, ...out.filter((c) => c.here === 0 && !madeHere.has(c.id))].map(({ here: _, ...c }) => c);
  }

  /** The tree of a notebook's concepts: every home, dismissed ones too (they are not suggested again). */
  private conceptHomeRows(notebookId: string): Row[] {
    return this.db.sql.prepare('SELECT * FROM concept_home WHERE notebook_id = ? ORDER BY created_at, rowid').all(notebookId) as Row[];
  }

  // The tree of concepts (ADR 0038) ---------------------------------------------------
  // A concept's main home is where it is on the map: under another concept (a kind or a part of it) or in a topic.
  // A topic is a concept that holds others. Homes the AI suggests wait to be kept; what the learner kept, or put
  // somewhere (even at the top), the AI does not move.

  /** The concept a concept is under, then that one's, up to the top. */
  private conceptAncestors(id: string): string[] {
    const out: string[] = [];
    const up = this.db.sql.prepare("SELECT parent_id FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed'");
    for (let at = (up.get(id) as Row | undefined)?.parent_id as string | undefined; at && !out.includes(at) && at !== id; ) {
      out.push(at);
      at = (up.get(at) as Row | undefined)?.parent_id as string | undefined;
    }
    return out;
  }

  /** Whether a concept holds others (it is a topic, or a concept with concepts inside). */
  private conceptHolds(id: string): boolean {
    return Boolean(this.db.sql.prepare("SELECT 1 FROM concept_home WHERE parent_id = ? AND status <> 'dismissed'").get(id));
  }

  /**
   * A concept's main home set: by you (kept, and its place is yours from now on), or suggested by the AI (only
   * where it has none and its place is not yours, never one dismissed before, never round in a circle).
   */
  private setConceptHome(child: string, parent: string, how: ConceptHow, by: 'you' | 'ai'): boolean {
    if (child === parent) return false;
    const c = this.conceptRow(child);
    const p = this.conceptRow(parent);
    if (!c || !p || c.notebook_id !== p.notebook_id) return false;
    if (this.conceptAncestors(parent).includes(child)) return false;
    const t = now();
    if (by === 'ai') {
      if (c.placed === 1) return false;
      if (this.db.sql.prepare("SELECT 1 FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed'").get(child)) return false;
      if (this.db.sql.prepare("SELECT 1 FROM concept_home WHERE child_id = ? AND parent_id = ? AND status = 'dismissed'").get(child, parent)) return false;
      this.db.sql
        .prepare(
          `INSERT INTO concept_home (child_id, parent_id, notebook_id, how, status, made_by, main, created_at) VALUES (?, ?, ?, ?, 'suggested', 'ai', 1, ?)
           ON CONFLICT (child_id, parent_id) DO UPDATE SET main = 1, how = excluded.how`,
        )
        .run(child, parent, c.notebook_id as string, how, t);
      return true;
    }
    this.db.sql.prepare("DELETE FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed' AND parent_id <> ?").run(child, parent);
    this.db.sql
      .prepare(
        `INSERT INTO concept_home (child_id, parent_id, notebook_id, how, status, made_by, main, created_at) VALUES (?, ?, ?, ?, 'kept', 'you', 1, ?)
         ON CONFLICT (child_id, parent_id) DO UPDATE SET main = 1, how = excluded.how, status = 'kept', made_by = 'you'`,
      )
      .run(child, parent, c.notebook_id as string, how, t);
    this.db.sql.prepare('UPDATE room SET placed = 1, updated_at = ? WHERE id = ?').run(t, child);
    return true;
  }

  /**
   * A concept put under another, or in a topic, by you; or taken to the top (`parent` null). Without a how: in, for
   * a topic (a concept that holds others and no material discusses); a kind of, otherwise.
   */
  putConceptUnder(id: string, parent: string | null, how?: ConceptHow): Room | null {
    return this.db.tx(() => {
      const c = this.conceptRow(id);
      if (!c) return null;
      if (parent === null) {
        this.db.sql.prepare("UPDATE concept_home SET status = 'dismissed', main = 0 WHERE child_id = ? AND main = 1 AND made_by = 'ai'").run(id);
        this.db.sql.prepare("DELETE FROM concept_home WHERE child_id = ? AND main = 1 AND made_by = 'you'").run(id);
        this.db.sql.prepare('UPDATE room SET placed = 1, updated_at = ? WHERE id = ?').run(now(), id);
        this.logEvent('concept.to_top', id);
        return this.getRoom(id);
      }
      const p = this.conceptRow(parent);
      if (!p) throw new NotFoundError('concept');
      if (parent === id || this.conceptAncestors(parent).includes(id)) throw new InvalidError('a concept cannot go inside itself');
      const topic = this.conceptHolds(parent) && !this.db.sql.prepare('SELECT 1 FROM concept_mention WHERE concept_id = ? AND kept = 1').get(parent);
      this.setConceptHome(id, parent, how ?? (topic ? 'in' : 'kind-of'), 'you');
      this.logEvent('concept.put_under', id, { parent });
      return this.getRoom(id);
    });
  }

  /** Keep the place the AI suggested for a concept: its main one, or the one under `parent`. */
  keepConceptHome(id: string, parent?: string): boolean {
    const r = parent
      ? this.db.sql.prepare("UPDATE concept_home SET status = 'kept' WHERE child_id = ? AND parent_id = ? AND status = 'suggested'").run(id, parent)
      : this.db.sql.prepare("UPDATE concept_home SET status = 'kept' WHERE child_id = ? AND main = 1 AND status = 'suggested'").run(id);
    return Number(r.changes) > 0;
  }

  /** Not this place (its main one, or the one under `parent`): it is not suggested there again. */
  dismissConceptHome(id: string, parent?: string): boolean {
    const r = parent
      ? this.db.sql.prepare("UPDATE concept_home SET status = 'dismissed', main = 0 WHERE child_id = ? AND parent_id = ? AND status = 'suggested'").run(id, parent)
      : this.db.sql.prepare("UPDATE concept_home SET status = 'dismissed', main = 0 WHERE child_id = ? AND main = 1 AND status = 'suggested'").run(id);
    return Number(r.changes) > 0;
  }

  /**
   * Hints read from the pieces: a concept a piece says is a kind or a part of another the notebook has goes under
   * it, suggested, when it has no place yet.
   */
  applyConceptHints(notebookId: string): number {
    return this.db.tx(() => {
      let n = 0;
      for (const m of this.db.sql
        .prepare(
          `SELECT DISTINCT concept_id, under, how FROM concept_mention
           WHERE notebook_id = ? AND concept_id IS NOT NULL AND kept = 1 AND under IS NOT NULL AND how IS NOT NULL`,
        )
        .all(notebookId) as Row[]) {
        const parent = this.conceptFor(notebookId, [conceptKey(m.under as string)]);
        if (parent && this.setConceptHome(m.concept_id as string, parent, m.how as ConceptHow, 'ai')) n += 1;
      }
      return n;
    });
  }

  /** What putting a room in order needs: its concepts (not its topics), and the notebook's topics. */
  orderInput(roomId: string): { title: string; ids: string[]; concepts: OrderConcept[]; topics: string[] } | null {
    const view = this.roomView(roomId);
    if (!view) return null;
    const titles = new Map(view.concepts.map((c) => [c.id, c.title]));
    const isTopic = (c: Concept) => c.places === 0 && this.conceptHolds(c.id);
    const list = view.concepts.filter((c) => !isTopic(c)).slice(0, ORDER_MAX);
    const parentTitle = (c: Concept) => (c.home ? (titles.get(c.home.id) ?? (this.conceptRow(c.home.id)?.title as string | undefined) ?? null) : null);
    const placedByYou = new Set(
      (this.db.sql.prepare("SELECT id FROM room WHERE notebook_id = ? AND kind = 'concept' AND placed = 1").all(view.room.notebookId) as Row[]).map((r) => r.id as string),
    );
    const topics = (
      this.db.sql
        .prepare(
          `SELECT r.title FROM room r WHERE r.notebook_id = ? AND r.kind = 'concept'
             AND EXISTS (SELECT 1 FROM concept_home h WHERE h.parent_id = r.id AND h.status <> 'dismissed')
             AND NOT EXISTS (SELECT 1 FROM concept_home h WHERE h.child_id = r.id AND h.main = 1 AND h.status <> 'dismissed')
             AND NOT EXISTS (SELECT 1 FROM concept_mention m WHERE m.concept_id = r.id AND m.kept = 1)
           ORDER BY r.title`,
        )
        .all(view.room.notebookId) as Row[]
    ).map((r) => r.title as string);
    return {
      title: view.room.title,
      ids: list.map((c) => c.id),
      concepts: list.map((c) => ({
        name: c.title,
        says: [c.definition ?? '', ...c.sources.flatMap((x) => x.places.filter((p) => p.kept).map((p) => p.says ?? ''))].filter((x) => x).slice(0, 2),
        materials: c.materials,
        work: workWeight(c.work),
        home: parentTitle(c) ?? (placedByYou.has(c.id) ? 'its place, chosen by the learner' : null),
      })),
      topics,
    };
  }

  /** The order the AI suggested: new topics made (suggested), each concept put where it said, if it can go there. */
  applyOrder(notebookId: string, ids: string[], order: OrderReply): number {
    return this.db.tx(() => {
      const topicIds = new Map<string, string>();
      for (const t of order.topics) {
        const known = this.conceptFor(notebookId, [conceptKey(t.name)]);
        if (known) {
          topicIds.set(conceptKey(t.name), known);
          continue;
        }
        const id = ulid();
        const at = now();
        this.db.sql
          .prepare(
            `INSERT INTO room (id, notebook_id, title, kind, status, made_by, scope, created_at, updated_at)
             VALUES (?, ?, ?, 'concept', 'suggested', 'ai', ?, ?, ?)`,
          )
          .run(id, notebookId, t.name, t.says || null, at, at);
        this.nameConcept(id, t.name, 'ai');
        topicIds.set(conceptKey(t.name), id);
        this.logEvent('concept.topic_suggested', id);
      }
      let n = 0;
      for (const p of order.places) {
        const child = ids[p.n - 1];
        const parent = 'concept' in p.under ? ids[p.under.concept - 1] : topicIds.get(conceptKey(p.under.topic));
        if (child && parent && this.setConceptHome(child, parent, p.how, 'ai')) n += 1;
      }
      // A topic made here that nothing went into after all is not kept.
      for (const id of topicIds.values()) {
        const r = this.conceptRow(id);
        if (r?.made_by === 'ai' && r.status === 'suggested' && !this.conceptHolds(id) && !this.db.sql.prepare('SELECT 1 FROM concept_mention WHERE concept_id = ?').get(id)) {
          this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(id);
        }
      }
      return n;
    });
  }

  setConceptScope(id: string, scope: string): Room | null {
    if (!this.conceptRow(id)) return null;
    this.db.sql.prepare('UPDATE room SET scope = ?, updated_at = ? WHERE id = ?').run(scope.trim() || null, now(), id);
    return this.getRoom(id);
  }

  /** Where you moved a concept on a room's map. */
  setConceptXY(roomId: string, id: string, x: number, y: number): void {
    if (!this.conceptRow(id) || !this.db.sql.prepare('SELECT 1 FROM room WHERE id = ?').get(roomId)) throw new NotFoundError('concept');
    this.db.sql
      .prepare('INSERT INTO concept_xy (room_id, concept_id, x, y) VALUES (?, ?, ?, ?) ON CONFLICT (room_id, concept_id) DO UPDATE SET x = excluded.x, y = excluded.y')
      .run(roomId, id, x, y);
  }

  /** A place found for a concept, kept: its material is in the concept now. */
  keepConceptPlace(placeId: string): boolean {
    return this.db.tx(() => {
      const m = this.db.sql.prepare('SELECT * FROM concept_mention WHERE id = ?').get(placeId) as Row | undefined;
      if (!m) return false;
      this.db.sql.prepare('UPDATE concept_mention SET kept = 1 WHERE id = ?').run(placeId);
      if (m.concept_id) {
        this.db.sql.prepare("DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ? AND state = 'out'").run(m.concept_id as string, m.kind as string, m.item_id as string);
      }
      return true;
    });
  }

  /** The names a concept is searched by: its own and its other names. */
  private conceptSearchNames(id: string): string[] {
    const c = this.conceptRow(id);
    if (!c) return [];
    const names = (this.db.sql.prepare('SELECT name FROM concept_name WHERE concept_id = ?').all(id) as Row[]).map((r) => r.name as string);
    return [...new Set([c.title as string, ...names].map((n) => n.trim()).filter((n) => n))];
  }

  /**
   * Where a concept's words appear in the notebook's sources (ADR 0038): plain text search for its names, no model.
   * The sources with the most first; the first few places of each, with their page.
   */
  conceptWords(id: string): ConceptWords {
    const c = this.conceptRow(id);
    if (!c) throw new NotFoundError('concept');
    const names = this.conceptSearchNames(id);
    const out: ConceptWords['sources'] = [];
    for (const s of this.db.sql
      .prepare('SELECT id, title FROM source WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY title COLLATE NOCASE')
      .all(c.notebook_id as string) as Row[]) {
      const d = this.sourceDetail(s.id as string);
      if (!d) continue;
      const key = `${d.version.id}|${names.join('\u0001')}`;
      let found = this.wordsCache.get(key);
      if (!found) {
        const text = d.version.content;
        const at = wordsFound(text, names);
        const pages = at.length ? pageStarts(text) : [];
        found = {
          count: at.length,
          places: at.slice(0, 6).map((r) => {
            const from = Math.max(0, text.lastIndexOf('\n', r.start) + 1, r.start - 90);
            const to = Math.min(text.length, r.end + 90);
            const quote = text.slice(r.start, r.end);
            return {
              page: pageAt(pages, r.start),
              quote: `${from > 0 && text[from - 1] !== '\n' ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`,
              target: { kind: 'source' as const, sourceId: d.source.id, versionId: d.version.id, at: r.start, title: d.source.title, quote },
            };
          }),
        };
        if (this.wordsCache.size > 2000) this.wordsCache.clear();
        this.wordsCache.set(key, found);
      }
      if (found.count > 0) out.push({ id: d.source.id, title: d.source.title, count: found.count, places: found.places });
    }
    out.sort((a, b) => b.count - a.count);
    return { sources: out.slice(0, 12) };
  }
  private wordsCache = new Map<string, { count: number; places: ConceptWords['sources'][number]['places'] }>();

  /**
   * What filling a concept judges (ADR 0038): the notebook's other concepts that could go inside it (not it, not
   * what it is under, not what is inside it already), and the materials whose words name it, with those words.
   */
  findInput(id: string): {
    concept: { name: string; also: string[]; scope: string };
    concepts: Array<{ id: string; name: string; says: string[] }>;
    materials: Array<FindMaterial & { item: RoomItemRef; text: ItemText; offsets: number[] }>;
  } | null {
    const c = this.conceptRow(id);
    if (!c) return null;
    const notebookId = c.notebook_id as string;
    const names = this.conceptSearchNames(id);
    const ancestors = new Set(this.conceptAncestors(id));
    const inside = new Set(
      (this.db.sql.prepare("SELECT child_id FROM concept_home WHERE parent_id = ? AND status <> 'dismissed'").all(id) as Row[]).map((r) => r.child_id as string),
    );
    const concepts = (
      this.db.sql
        .prepare(
          `SELECT r.id, r.title, r.definition, (SELECT count(*) FROM concept_mention m WHERE m.concept_id = r.id AND m.kept = 1) AS n
           FROM room r WHERE r.notebook_id = ? AND r.kind = 'concept' ORDER BY n DESC, r.title`,
        )
        .all(notebookId) as Row[]
    )
      .filter((r) => r.id !== id && !ancestors.has(r.id as string) && !inside.has(r.id as string))
      .slice(0, FIND_CONCEPTS_MAX)
      .map((r) => ({ id: r.id as string, name: r.title as string, says: [(r.definition as string | null) ?? ''].filter((x) => x) }));
    // Materials already in it are not found again.
    const graph = this.roomGraph(notebookId);
    const members = new Set(this.conceptMembers(id, this.roomRows(id), graph));
    const candidates: Array<FindMaterial & { item: RoomItemRef; text: ItemText; offsets: number[]; hits: number }> = [];
    const refs: RoomItemRef[] = [
      ...graph.threads.filter((t) => !t.parentThreadId).map((t) => ({ kind: 'thread' as const, id: t.id })),
      ...graph.notes.map((n) => ({ kind: 'note' as const, id: n.id })),
      ...graph.sources.map((x) => ({ kind: 'source' as const, id: x.id })),
    ];
    for (const item of refs) {
      if (members.has(roomKey(item.kind, item.id))) continue;
      const text = this.itemText(item);
      if (!text) continue;
      const hits = wordsFound(text.text, names, 50);
      const inTitle = wordsFound(text.title, names, 1).length > 0;
      if (hits.length === 0 && !inTitle) continue;
      // Up to three stretches around its words, each a paragraph or about 500 characters, not overlapping.
      const snippets: string[] = [];
      const offsets: number[] = [];
      let last = -1;
      for (const h of hits.length ? hits : [{ start: 0, end: 0 }]) {
        if (snippets.length >= 3) break;
        if (h.start < last) continue;
        const from = Math.max(0, text.text.lastIndexOf('\n\n', h.start) + 2, h.start - 250);
        const paraEnd = text.text.indexOf('\n\n', h.end);
        const to = Math.min(text.text.length, paraEnd < 0 ? text.text.length : paraEnd, h.end + 250);
        snippets.push(text.text.slice(from, to));
        offsets.push(from);
        last = to;
      }
      candidates.push({ kind: item.kind, title: text.title, snippets, item, text, offsets, hits: hits.length + (inTitle ? 5 : 0) });
    }
    candidates.sort((a, b) => b.hits - a.hits || (a.kind === 'source' ? 1 : 0) - (b.kind === 'source' ? 1 : 0));
    const others = names.filter((n) => conceptKey(n) !== conceptKey(c.title as string));
    return {
      concept: { name: c.title as string, also: others, scope: (c.scope as string | null) ?? '' },
      concepts,
      materials: candidates.slice(0, FIND_MATERIALS_MAX).map(({ hits: _, ...m }) => m),
    };
  }

  /** What was found for a concept, saved for the learner to keep: concepts inside it, and places in materials. */
  applyFind(id: string, input: NonNullable<ReturnType<Repo['findInput']>>, found: FoundDraft): { inside: number; materials: number } {
    return this.db.tx(() => {
      const c = this.conceptRow(id);
      if (!c) return { inside: 0, materials: 0 };
      const notebookId = c.notebook_id as string;
      let inside = 0;
      for (const f of found.inside) {
        const child = input.concepts[f.c - 1];
        if (!child) continue;
        // Asked by the learner, it is more specific than a place the AI suggested before: it takes that one's place.
        const before = this.db.sql.prepare("SELECT h.* FROM concept_home h JOIN room r ON r.id = h.child_id WHERE h.child_id = ? AND h.main = 1 AND h.status = 'suggested' AND h.made_by = 'ai' AND r.placed = 0").get(child.id) as Row | undefined;
        if (before && !this.conceptAncestors(id).includes(child.id)) this.db.sql.prepare('DELETE FROM concept_home WHERE child_id = ? AND parent_id = ?').run(child.id, before.parent_id as string);
        if (this.setConceptHome(child.id, id, f.how, 'ai')) inside += 1;
        else if (!this.db.sql.prepare('SELECT 1 FROM concept_home WHERE child_id = ? AND parent_id = ?').get(child.id, id)) {
          // It has a place already: this is another, waiting to be kept.
          if (this.conceptAncestors(id).includes(child.id)) continue;
          this.db.sql
            .prepare(
              `INSERT INTO concept_home (child_id, parent_id, notebook_id, how, status, made_by, main, created_at) VALUES (?, ?, ?, ?, 'suggested', 'ai', 0, ?)`,
            )
            .run(child.id, id, notebookId, f.how, now());
          inside += 1;
        }
      }
      let materials = 0;
      const t = now();
      const put = this.db.sql.prepare(
        `INSERT INTO concept_mention (id, notebook_id, concept_id, kind, item_id, hash, piece_at, name, key, also, role, quote, says, target, made_by, kept, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, '[]', 'uses', ?, ?, ?, 'ai', 0, ?)`,
      );
      for (const f of found.materials) {
        const m = input.materials[f.m - 1];
        if (!m) continue;
        const at = (m.offsets[f.snippet] ?? 0) + f.start;
        const target = targetAt(m.text, at, f.quote);
        this.db.sql.prepare('DELETE FROM concept_mention WHERE concept_id = ? AND kind = ? AND item_id = ? AND kept = 0').run(id, m.item.kind, m.item.id);
        put.run(ulid(), notebookId, id, m.item.kind, m.item.id, c.title as string, conceptKey(c.title as string), f.quote, f.says || null, target ? JSON.stringify(target) : null, t);
        materials += 1;
      }
      this.logEvent('concept.found', id, { inside, materials });
      return { inside, materials };
    });
  }

  /** What the learner's materials say of a concept: its definition, then its places' lines (kept ones). */
  conceptSays(id: string): string[] {
    const c = this.conceptRow(id);
    if (!c) return [];
    const says = (this.db.sql.prepare('SELECT says FROM concept_mention WHERE concept_id = ? AND kept = 1 AND says IS NOT NULL ORDER BY created_at LIMIT 8').all(id) as Row[]).map(
      (r) => r.says as string,
    );
    return [...new Set([(c.definition as string | null) ?? '', ...says].filter((x) => x))].slice(0, 5);
  }

  /** The notebook's concepts with what each is under, for the skill to read pieces with (ADR 0038). */
  conceptKnownTree(notebookId: string): KnownConcept[] {
    const rows = this.db.sql
      .prepare(
        `SELECT r.id, r.title, (SELECT count(*) FROM concept_mention m WHERE m.concept_id = r.id) AS n
         FROM room r WHERE r.notebook_id = ? AND r.kind = 'concept' ORDER BY r.status = 'suggested', n DESC, r.title`,
      )
      .all(notebookId) as Row[];
    const titles = new Map(rows.map((r) => [r.id as string, r.title as string]));
    const up = new Map(
      (this.db.sql.prepare("SELECT child_id, parent_id FROM concept_home WHERE notebook_id = ? AND main = 1 AND status <> 'dismissed'").all(notebookId) as Row[]).map(
        (h) => [h.child_id as string, h.parent_id as string],
      ),
    );
    return rows.map((r) => ({ name: r.title as string, under: titles.get(up.get(r.id as string) ?? '') ?? null }));
  }

  /** Make a concept by hand: kept, holding what is given; shown in the room it was made in, even empty. */
  createConcept(notebookId: string, c: { id: string; title: string; items?: RoomItemRef[]; inRoom?: string }): Room {
    return this.db.tx(() => {
      if (this.db.sql.prepare('SELECT 1 FROM room WHERE id = ?').get(c.id)) throw new ConflictError('room id already used');
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO room (id, notebook_id, title, kind, status, made_by, created_at, updated_at)
           VALUES (?, ?, ?, 'concept', 'kept', 'you', ?, ?)`,
        )
        .run(c.id, notebookId, c.title.trim(), t, t);
      this.nameConcept(c.id, c.title, 'you');
      if (c.items?.length) this.addRoomItems(c.id, c.items);
      if (c.inRoom) this.db.sql.prepare('INSERT OR IGNORE INTO concept_shown (room_id, concept_id) VALUES (?, ?)').run(c.inRoom, c.id);
      this.logEvent('concept.created', c.id, { by: 'you', items: c.items?.length ?? 0 });
      return this.getRoom(c.id) as Room;
    });
  }

  /** A name that means a concept, kept so that mentions using it join it. */
  private nameConcept(id: string, name: string, by: 'you' | 'ai'): void {
    const key = conceptKey(name);
    if (!key) return;
    this.db.sql
      .prepare('INSERT OR IGNORE INTO concept_name (concept_id, key, name, made_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, key, name.trim(), by, now());
  }

  /**
   * Keep a suggested concept: it is the learner's now. Its things are kept with it: an update may add things that
   * mention it, never take any away.
   */
  keepConcept(id: string): Room | null {
    this.db.tx(() => {
      const r = this.db.sql.prepare("UPDATE room SET status = 'kept', updated_at = ? WHERE id = ? AND kind = 'concept' AND status = 'suggested'").run(now(), id);
      if (Number(r.changes) === 0) return;
      this.holdThings(id);
      this.logEvent('concept.kept', id);
    });
    return this.getRoom(id);
  }

  private holdThings(id: string): void {
    const c = this.conceptRow(id);
    if (!c) return;
    const graph = this.roomGraph(c.notebook_id as string);
    const t = now();
    const put = this.db.sql.prepare(
      `INSERT INTO room_item (room_id, kind, item_id, state, added_by, created_at, updated_at) VALUES (?, ?, ?, 'in', 'you', ?, ?)
       ON CONFLICT (room_id, kind, item_id) DO NOTHING`,
    );
    for (const k of this.conceptMembers(id, this.roomRows(id), graph)) {
      const at = k.indexOf(':');
      put.run(id, k.slice(0, at), k.slice(at + 1), t, t);
    }
  }

  /** Keep every concept the AI suggested among a room's, and the links it suggested between them. */
  keepAllConcepts(roomId: string): number {
    return this.db.tx(() => {
      const view = this.roomView(roomId);
      if (!view) return 0;
      const ids = view.concepts.filter((c) => c.status === 'suggested').map((c) => c.id);
      for (const id of ids) this.keepConcept(id);
      // And the places the AI suggested for them in the tree (ADR 0038).
      for (const c of view.concepts) if (c.home?.status === 'suggested') this.keepConceptHome(c.id);
      const shown = new Set(view.concepts.map((c) => c.id));
      const t = now();
      for (const l of view.conceptLinks) {
        if (l.status === 'suggested' && shown.has(l.from) && shown.has(l.to)) {
          this.db.sql.prepare("UPDATE concept_link SET status = 'accepted', updated_at = ? WHERE id = ?").run(t, l.id);
        }
      }
      this.logEvent('concept.kept_all', roomId, { n: ids.length });
      return ids.length;
    });
  }

  /**
   * A concept taken away, suggested or kept: its things stay where they are, its names are dismissed in the
   * notebook so it is not suggested again, and its mentions stay as passing ideas.
   */
  dropConcept(id: string): boolean {
    return this.db.tx(() => {
      const c = this.conceptRow(id);
      if (!c) return false;
      this.dismissNames(c.notebook_id as string, id, c.title as string);
      this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(id);
      this.logEvent('concept.dropped', id, { suggested: c.status === 'suggested' });
      return true;
    });
  }

  private dismissNames(notebookId: string, id: string, title: string): void {
    const names = (this.db.sql.prepare('SELECT key, name FROM concept_name WHERE concept_id = ?').all(id) as Row[]).map((r) => ({
      key: r.key as string,
      name: r.name as string,
    }));
    names.push({ key: conceptKey(title), name: title });
    const t = now();
    const put = this.db.sql.prepare('INSERT OR IGNORE INTO concept_dismissed (notebook_id, key, name, created_at) VALUES (?, ?, ?, ?)');
    for (const n of names) if (n.key) put.run(notebookId, n.key, n.name, t);
  }

  /**
   * A concept grown into a room of its own, inside the room it was opened from: it holds its things for good, and
   * its names are not suggested as a concept again.
   */
  conceptToRoom(id: string, inside: string | null): Room | null {
    return this.db.tx(() => {
      const c = this.conceptRow(id);
      if (!c) return null;
      this.holdThings(id);
      this.dismissNames(c.notebook_id as string, id, c.title as string);
      this.db.sql.prepare('UPDATE concept_mention SET concept_id = NULL WHERE concept_id = ?').run(id);
      this.db.sql.prepare('DELETE FROM concept_name WHERE concept_id = ?').run(id);
      this.db.sql.prepare('DELETE FROM concept_link WHERE from_id = ? OR to_id = ?').run(id, id);
      this.db.sql.prepare('DELETE FROM concept_home WHERE child_id = ? OR parent_id = ?').run(id, id);
      this.db.sql.prepare('DELETE FROM concept_xy WHERE concept_id = ?').run(id);
      this.db.sql
        .prepare("UPDATE room SET kind = 'room', status = 'kept', definition = NULL, definition_at = NULL, definition_mention = NULL, scope = NULL, placed = 0, updated_at = ? WHERE id = ?")
        .run(now(), id);
      // The room it was opened from now holds it. Nothing here exists in a room that cannot hold rooms.
      if (inside && inside !== id && this.db.sql.prepare("SELECT 1 FROM room WHERE id = ? AND kind = 'room'").get(inside)) {
        const t = now();
        this.db.sql
          .prepare('INSERT OR IGNORE INTO room_door (room_id, child_id, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(inside, id, 'you', t, t);
      }
      this.logEvent('concept.to_room', id);
      return this.getRoom(id);
    });
  }

  /** One concept merged into another: names, places, things and links go to it; the first is gone. */
  mergeConcepts(fromId: string, intoId: string): Room | null {
    return this.db.tx(() => {
      const from = this.conceptRow(fromId);
      const into = this.conceptRow(intoId);
      if (!from || !into || fromId === intoId) return null;
      if (from.notebook_id !== into.notebook_id) throw new InvalidError('the two concepts are in different notebooks');
      const t = now();
      for (const n of this.db.sql.prepare('SELECT name FROM concept_name WHERE concept_id = ?').all(fromId) as Row[]) {
        this.nameConcept(intoId, n.name as string, 'you');
      }
      this.nameConcept(intoId, from.title as string, 'you');
      this.db.sql.prepare('UPDATE concept_mention SET concept_id = ? WHERE concept_id = ?').run(intoId, fromId);
      for (const r of this.db.sql.prepare("SELECT kind, item_id FROM room_item WHERE room_id = ? AND state = 'in'").all(fromId) as Row[]) {
        this.db.sql
          .prepare(
            `INSERT INTO room_item (room_id, kind, item_id, state, added_by, created_at, updated_at) VALUES (?, ?, ?, 'in', 'you', ?, ?)
             ON CONFLICT (room_id, kind, item_id) DO UPDATE SET state = 'in', updated_at = excluded.updated_at`,
          )
          .run(intoId, r.kind as string, r.item_id as string, t, t);
      }
      this.db.sql
        .prepare('DELETE FROM concept_link WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
        .run(fromId, intoId, intoId, fromId);
      this.db.sql.prepare('UPDATE concept_link SET from_id = ? WHERE from_id = ?').run(intoId, fromId);
      this.db.sql.prepare('UPDATE concept_link SET to_id = ? WHERE to_id = ?').run(intoId, fromId);
      // In the tree: what was inside the first is inside the second; it takes the first's place if it has none.
      this.db.sql.prepare('DELETE FROM concept_home WHERE (child_id = ? AND parent_id = ?) OR (child_id = ? AND parent_id = ?)').run(fromId, intoId, intoId, fromId);
      this.db.sql.prepare('UPDATE OR IGNORE concept_home SET parent_id = ? WHERE parent_id = ?').run(intoId, fromId);
      if (!this.db.sql.prepare("SELECT 1 FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed'").get(intoId)) {
        const home = this.db.sql.prepare("SELECT * FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed'").get(fromId) as Row | undefined;
        if (home && !this.conceptAncestors(home.parent_id as string).includes(intoId) && home.parent_id !== intoId) {
          this.db.sql
            .prepare('INSERT OR IGNORE INTO concept_home (child_id, parent_id, notebook_id, how, status, made_by, main, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
            .run(intoId, home.parent_id as string, home.notebook_id as string, home.how as string, home.status as string, home.made_by as string, t);
        }
      }
      if (into.status === 'suggested' && from.status === 'kept') this.keepConcept(intoId);
      this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(fromId);
      this.db.sql.prepare('UPDATE room SET updated_at = ? WHERE id = ?').run(t, intoId);
      this.logEvent('concept.merged', intoId, { from: fromId });
      return this.getRoom(intoId);
    });
  }

  /**
   * A material moved from one concept to another: its places go with it, and the next time it is read, its
   * mentions of that idea join the concept chosen (they follow the material's earlier joins).
   */
  moveInConcepts(fromId: string, item: RoomItemRef, toId: string): Room | null {
    return this.db.tx(() => {
      const from = this.conceptRow(fromId);
      const to = this.conceptRow(toId);
      if (!from || !to || fromId === toId) return null;
      const at = this.roomItem(from.notebook_id as string, item);
      if (!at) throw new NotFoundError(item.kind);
      this.db.sql.prepare('UPDATE concept_mention SET concept_id = ? WHERE concept_id = ? AND kind = ? AND item_id = ?').run(toId, fromId, at.kind, at.id);
      this.db.sql.prepare('DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ?').run(fromId, at.kind, at.id);
      // Still in the first by a mention not moved (none should be), or by being kept there: taken out.
      const graph = this.roomGraph(from.notebook_id as string);
      if (this.conceptMembers(fromId, this.roomRows(fromId), graph).includes(roomKey(at.kind, at.id))) {
        const t = now();
        this.db.sql
          .prepare("INSERT INTO room_item (room_id, kind, item_id, state, added_by, created_at, updated_at) VALUES (?, ?, ?, 'out', 'you', ?, ?)")
          .run(fromId, at.kind, at.id, t, t);
      }
      this.db.sql.prepare("DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ? AND state = 'out'").run(toId, at.kind, at.id);
      if (to.status === 'kept') this.addRoomItems(toId, [at]);
      this.logEvent('concept.moved', toId, { from: fromId });
      return this.getRoom(toId);
    });
  }

  /** Some of a concept's materials split off into a new concept, kept, with their places. */
  splitConcept(fromId: string, c: { id: string; title: string; items: RoomItemRef[] }): Room | null {
    return this.db.tx(() => {
      const from = this.conceptRow(fromId);
      if (!from) return null;
      this.createConcept(from.notebook_id as string, { id: c.id, title: c.title });
      // It goes where the first one is.
      const home = this.db.sql.prepare("SELECT * FROM concept_home WHERE child_id = ? AND main = 1 AND status <> 'dismissed'").get(fromId) as Row | undefined;
      if (home) this.setConceptHome(c.id, home.parent_id as string, home.how as ConceptHow, 'you');
      for (const item of c.items) this.moveInConcepts(fromId, item, c.id);
      this.addRoomItems(c.id, c.items);
      return this.getRoom(c.id);
    });
  }

  /** A passage put under a concept by hand: the learner's, kept through updates (shown as not found if its words go). */
  addConceptPlace(id: string, target: VaultTarget): ConceptPlace {
    return this.db.tx(() => {
      const c = this.conceptRow(id);
      if (!c) throw new NotFoundError('concept');
      const notebookId = c.notebook_id as string;
      const item = this.materialOf(notebookId, target);
      if (!item) throw new NotFoundError(target.kind);
      const mid = ulid();
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO concept_mention (id, notebook_id, concept_id, kind, item_id, hash, piece_at, name, key, also, role, quote, says, target, made_by, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, '[]', 'uses', ?, NULL, ?, 'you', ?)`,
        )
        .run(mid, notebookId, id, item.kind, item.id, c.title as string, conceptKey(c.title as string), target.quote ?? '', JSON.stringify(target), t);
      this.db.sql.prepare("DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ? AND state = 'out'").run(id, item.kind, item.id);
      this.logEvent('concept.place_added', id, { kind: item.kind });
      return toPlace(this.db.sql.prepare('SELECT * FROM concept_mention WHERE id = ?').get(mid) as Row);
    });
  }

  removeConceptPlace(placeId: string): boolean {
    return Number(this.db.sql.prepare('DELETE FROM concept_mention WHERE id = ?').run(placeId).changes) > 0;
  }

  /** The material a place is in: a source, a note, or the thread (its side questions are its own). */
  private materialOf(notebookId: string, target: VaultTarget): RoomItemRef | null {
    if (target.kind === 'source') return { kind: 'source', id: target.sourceId };
    if (target.kind === 'note') return { kind: 'note', id: target.noteId };
    const threads = this.listThreads(notebookId);
    const byId = new Map(threads.map((t) => [t.id, t]));
    return byId.has(target.threadId) ? { kind: 'thread', id: threadOf(target.threadId, byId) } : null;
  }

  /** The concepts a material discusses, with its places for each. A side question's are its thread's. */
  materialConcepts(ref: RoomItemRef): MaterialConcepts['concepts'] {
    let item = ref;
    if (ref.kind === 'thread') {
      const t = this.getThread(ref.id);
      if (t) item = this.materialOf(t.notebookId, { kind: 'thread', threadId: t.id, messageId: null, title: '' }) ?? ref;
    }
    const rows = this.db.sql
      .prepare(
        `SELECT m.*, r.title AS concept_title, r.status AS concept_status FROM concept_mention m JOIN room r ON r.id = m.concept_id
         WHERE m.kind = ? AND m.item_id = ? AND m.kept = 1 ORDER BY r.status = 'suggested', m.created_at, m.rowid`,
      )
      .all(item.kind, item.id) as Row[];
    const out = new Map<string, MaterialConcepts['concepts'][number]>();
    for (const r of rows) {
      const id = r.concept_id as string;
      const c = out.get(id) ?? { id, title: r.concept_title as string, status: r.concept_status === 'suggested' ? 'suggested' : 'kept', places: [] };
      c.places.push(toPlace(r));
      out.set(id, c);
    }
    return [...out.values()];
  }

  /** The notebook's concepts, for picking one: kept first. */
  notebookConcepts(notebookId: string): Array<{ id: string; title: string; status: 'suggested' | 'kept' }> {
    return (
      this.db.sql
        .prepare("SELECT id, title, status FROM room WHERE notebook_id = ? AND kind = 'concept' ORDER BY status = 'suggested', title COLLATE NOCASE")
        .all(notebookId) as Row[]
    ).map((r) => ({ id: r.id as string, title: r.title as string, status: r.status === 'suggested' ? 'suggested' : 'kept' }));
  }

  conceptLinks(notebookId: string): ConceptLink[] {
    return (this.db.sql.prepare('SELECT * FROM concept_link WHERE notebook_id = ? ORDER BY created_at, rowid').all(notebookId) as Row[]).map((r) => ({
      id: r.id as string,
      from: r.from_id as string,
      to: r.to_id as string,
      kind: r.kind as LinkKind,
      why: (r.why as string | null) ?? null,
      by: r.made_by === 'ai' ? 'ai' : 'you',
      status: r.status === 'suggested' ? 'suggested' : 'accepted',
    }));
  }

  conceptLink(id: string): (ConceptLink & { notebookId: string }) | null {
    const r = this.db.sql.prepare('SELECT notebook_id FROM concept_link WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const link = this.conceptLinks(r.notebook_id as string).find((l) => l.id === id);
    return link ? { ...link, notebookId: r.notebook_id as string } : null;
  }

  createConceptLink(
    l: { id: string; from: string; to: string; kind: LinkKind; why?: string | null },
    by: 'you' | 'ai',
    status: 'suggested' | 'accepted',
  ): ConceptLink {
    const from = this.conceptRow(l.from);
    const to = this.conceptRow(l.to);
    if (!from || !to || from.notebook_id !== to.notebook_id) throw new InvalidError('both ends must be concepts of one notebook');
    if (l.from === l.to) throw new InvalidError('a concept cannot be linked to itself');
    const t = now();
    this.db.sql
      .prepare(
        `INSERT INTO concept_link (id, notebook_id, from_id, to_id, kind, why, made_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(l.id, from.notebook_id as string, l.from, l.to, l.kind, l.why ?? null, by, status, t, t);
    this.logEvent('concept.linked', l.from, { kind: l.kind, by, status });
    return this.conceptLink(l.id) as ConceptLink;
  }

  updateConceptLink(id: string, patch: { status?: 'accepted'; kind?: LinkKind }): ConceptLink | null {
    const t = now();
    if (patch.status) this.db.sql.prepare('UPDATE concept_link SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, t, id);
    if (patch.kind) this.db.sql.prepare("UPDATE concept_link SET kind = ?, made_by = 'you', updated_at = ? WHERE id = ?").run(patch.kind, t, id);
    return this.conceptLink(id);
  }

  deleteConceptLink(id: string): boolean {
    return Number(this.db.sql.prepare('DELETE FROM concept_link WHERE id = ?').run(id).changes) > 0;
  }

  // Reading concepts (ADR 0037) ----------------------------------------------------

  /** A material's text, cut into the skill's pieces, each with its hash. */
  materialPieces(item: RoomItemRef): { text: ItemText; pieces: Array<Piece & { hash: string }> } | null {
    const text = this.itemText(item);
    if (!text) return null;
    return {
      text,
      pieces: piecesOf(text).map((p) => ({ ...p, hash: createHash('sha256').update(pieceHashInput(p.text)).digest('hex').slice(0, 40) })),
    };
  }

  /** The hashes of a material's pieces already read. */
  readPieces(item: RoomItemRef): Set<string> {
    return new Set(
      (this.db.sql.prepare('SELECT hash FROM concept_piece WHERE kind = ? AND item_id = ?').all(item.kind, item.id) as Row[]).map((r) => r.hash as string),
    );
  }

  /**
   * What a room's materials need read: those never read or changed since, and their pieces not read. Pieces are
   * cut and hashed again only when a material is no longer as it was (its version, or when it was last touched).
   */
  conceptsToRead(members: string[], bases: Map<string, string>): RoomView['conceptsToRead'] {
    let materials = 0;
    let changed = 0;
    let pieces = 0;
    for (const key of members) {
      const at = key.indexOf(':');
      const item = { kind: key.slice(0, at) as RoomKind, id: key.slice(at + 1) };
      const basis = bases.get(key) ?? '';
      let hashes = this.pieceHashes.get(key);
      if (!hashes || hashes.basis !== basis) {
        hashes = { basis, list: this.materialPieces(item)?.pieces.map((p) => p.hash) ?? [] };
        this.pieceHashes.set(key, hashes);
      }
      const read = this.readPieces(item);
      const todo = hashes.list.filter((h) => !read.has(h)).length;
      const gone = [...read].some((h) => !hashes.list.includes(h));
      if (todo === 0 && !gone) continue;
      materials += 1;
      if (read.size > 0) changed += 1;
      pieces += todo;
    }
    return { materials, changed, pieces };
  }
  private pieceHashes = new Map<string, { basis: string; list: string[] }>();

  /** Before a material is read again: each name key it mentions, and the concept it joined there. */
  materialJoins(item: RoomItemRef): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const r of this.db.sql
      .prepare('SELECT key, concept_id FROM concept_mention WHERE kind = ? AND item_id = ? ORDER BY created_at')
      .all(item.kind, item.id) as Row[]) {
      if (r.concept_id || !out.has(r.key as string)) out.set(r.key as string, (r.concept_id as string | null) ?? null);
    }
    return out;
  }

  /**
   * A material as it is now: pieces no longer in it, and what was read from them, go; what was read from pieces
   * still in it is pointed at where its words are now; places put by hand are found again, or marked not found.
   */
  settleMaterial(item: RoomItemRef, now_: { text: ItemText; pieces: Array<Piece & { hash: string }> }): void {
    this.db.tx(() => {
      const current = new Map(now_.pieces.map((p) => [p.hash, p]));
      for (const r of this.db.sql.prepare('SELECT hash FROM concept_piece WHERE kind = ? AND item_id = ?').all(item.kind, item.id) as Row[]) {
        if (current.has(r.hash as string)) continue;
        this.db.sql.prepare('DELETE FROM concept_mention WHERE kind = ? AND item_id = ? AND hash = ?').run(item.kind, item.id, r.hash as string);
        this.db.sql.prepare('DELETE FROM concept_piece WHERE kind = ? AND item_id = ? AND hash = ?').run(item.kind, item.id, r.hash as string);
      }
      const move = this.db.sql.prepare('UPDATE concept_mention SET target = ? WHERE id = ?');
      for (const m of this.db.sql.prepare('SELECT * FROM concept_mention WHERE kind = ? AND item_id = ?').all(item.kind, item.id) as Row[]) {
        let target: VaultTarget | null = null;
        const piece = m.hash ? current.get(m.hash as string) : undefined;
        if (piece) target = targetAt(now_.text, piece.start + Number(m.piece_at), m.quote as string);
        else if (!m.hash) {
          const range = quoteRange(now_.text.text, m.quote as string);
          target = range ? targetAt(now_.text, range.start, m.quote as string) : null;
        }
        const json = target ? JSON.stringify(target) : null;
        if (json !== m.target) move.run(json, m.id as string);
      }
    });
  }

  /**
   * A piece read: what it mentions is kept, each joined to a concept, if it can be without asking: the concept
   * this material joined that name to before (so a move or a split sticks), or a concept with that name (or one
   * of its other names). Dismissed names stay passing ideas. Returns how many were joined.
   */
  savePiece(
    notebookId: string,
    item: RoomItemRef,
    piece: Piece & { hash: string },
    text: ItemText,
    mentions: MentionDraft[],
    joins: Map<string, string | null>,
    model: string,
  ): void {
    this.db.tx(() => {
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO concept_piece (notebook_id, kind, item_id, hash, model, read_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, item_id, hash) DO UPDATE SET model = excluded.model, read_at = excluded.read_at`,
        )
        .run(notebookId, item.kind, item.id, piece.hash, model, t);
      this.db.sql.prepare('DELETE FROM concept_mention WHERE kind = ? AND item_id = ? AND hash = ?').run(item.kind, item.id, piece.hash);
      const put = this.db.sql.prepare(
        `INSERT INTO concept_mention (id, notebook_id, concept_id, kind, item_id, hash, piece_at, name, key, also, role, quote, says, target, made_by, under, how, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?)`,
      );
      for (const m of mentions) {
        const joined = joins.has(m.key) && joins.get(m.key) && this.conceptRow(joins.get(m.key) as string) ? (joins.get(m.key) as string) : this.conceptFor(notebookId, [m.key, ...m.also.map(conceptKey)]);
        const target = targetAt(text, piece.start + m.offset, m.quote);
        put.run(
          ulid(),
          notebookId,
          joined,
          item.kind,
          item.id,
          piece.hash,
          m.offset,
          m.name,
          m.key,
          JSON.stringify(m.also),
          m.role,
          m.quote,
          m.says || null,
          target ? JSON.stringify(target) : null,
          m.under,
          m.how,
          t,
        );
        if (joined) for (const a of m.also) this.nameConcept(joined, a, 'ai');
      }
    });
  }

  /** The concept a name means in a notebook, if any. */
  conceptIdByTitle(notebookId: string, name: string): string | null {
    return this.conceptFor(notebookId, [conceptKey(name)]);
  }

  /** The concept a name (or one of its other names) means in a notebook, if any. */
  private conceptFor(notebookId: string, keys: string[]): string | null {
    const find = this.db.sql.prepare(
      `SELECT n.concept_id FROM concept_name n JOIN room r ON r.id = n.concept_id
       WHERE n.key = ? AND r.notebook_id = ? AND r.kind = 'concept' ORDER BY r.status = 'suggested' LIMIT 1`,
    );
    for (const k of keys) {
      if (!k) continue;
      const r = find.get(k, notebookId) as Row | undefined;
      if (r) return r.concept_id as string;
    }
    return null;
  }

  private dismissedKeys(notebookId: string): Set<string> {
    return new Set((this.db.sql.prepare('SELECT key FROM concept_dismissed WHERE notebook_id = ?').all(notebookId) as Row[]).map((r) => r.key as string));
  }

  /**
   * Names of concepts read before a skill that keys names: keyed now. Concepts with no name get theirs;
   * dismissed names are keyed the code's way.
   */
  ensureConceptNames(notebookId: string): void {
    this.db.tx(() => {
      for (const c of this.db.sql
        .prepare("SELECT id, title, made_by FROM room WHERE notebook_id = ? AND kind = 'concept' AND id NOT IN (SELECT concept_id FROM concept_name)")
        .all(notebookId) as Row[]) {
        this.nameConcept(c.id as string, c.title as string, c.made_by === 'ai' ? 'ai' : 'you');
      }
      for (const d of this.db.sql.prepare('SELECT key, name FROM concept_dismissed WHERE notebook_id = ?').all(notebookId) as Row[]) {
        const key = conceptKey(d.name as string);
        if (key && key !== d.key) {
          this.db.sql.prepare('DELETE FROM concept_dismissed WHERE notebook_id = ? AND key = ?').run(notebookId, d.key as string);
          this.db.sql.prepare('INSERT OR IGNORE INTO concept_dismissed (notebook_id, key, name, created_at) VALUES (?, ?, ?, ?)').run(notebookId, key, d.name as string, now());
        }
      }
    });
  }

  /** The names of a notebook's concepts, the most discussed first: sent with each piece so they are used again. */
  conceptKnownNames(notebookId: string): string[] {
    return (
      this.db.sql
        .prepare(
          `SELECT r.title, (SELECT count(*) FROM concept_mention m WHERE m.concept_id = r.id) AS n
           FROM room r WHERE r.notebook_id = ? AND r.kind = 'concept' ORDER BY r.status = 'suggested', n DESC, r.title`,
        )
        .all(notebookId) as Row[]
    ).map((r) => r.title as string);
  }

  /**
   * Passing ideas: mentions joined to no concept, by name key, across the notebook (not dismissed); `among` the
   * materials of a room, if given, decides which keys (the evidence for each key is notebook-wide).
   */
  unjoinedMentions(
    notebookId: string,
    among?: RoomItemRef[],
  ): Map<string, Array<{ id: string; name: string; also: string[]; role: MentionRole; material: string; at: string }>> {
    const dismissed = this.dismissedKeys(notebookId);
    const rows = this.db.sql
      .prepare('SELECT * FROM concept_mention WHERE notebook_id = ? AND concept_id IS NULL AND made_by = ? AND kept = 1 ORDER BY created_at, rowid')
      .all(notebookId, 'ai') as Row[];
    const wanted = among ? new Set(among.map((x) => roomKey(x.kind, x.id))) : null;
    const keys = new Set(rows.filter((r) => !wanted || wanted.has(roomKey(r.kind as RoomKind, r.item_id as string))).map((r) => r.key as string));
    const out = new Map<string, Array<{ id: string; name: string; also: string[]; role: MentionRole; material: string; at: string }>>();
    for (const r of rows) {
      const key = r.key as string;
      if (!keys.has(key) || dismissed.has(key)) continue;
      const list = out.get(key) ?? [];
      list.push({
        id: r.id as string,
        name: r.name as string,
        also: JSON.parse(r.also as string) as string[],
        role: r.role as MentionRole,
        material: roomKey(r.kind as RoomKind, r.item_id as string),
        at: r.created_at as string,
      });
      out.set(key, list);
    }
    return out;
  }

  /** The passing ideas of these keys join a concept; their names become its other names. */
  joinMentions(notebookId: string, keys: string[], conceptId: string): void {
    this.db.tx(() => {
      for (const key of keys) {
        for (const r of this.db.sql
          .prepare('SELECT DISTINCT name, also FROM concept_mention WHERE notebook_id = ? AND key = ? AND concept_id IS NULL')
          .all(notebookId, key) as Row[]) {
          this.nameConcept(conceptId, r.name as string, 'ai');
          for (const a of JSON.parse(r.also as string) as string[]) this.nameConcept(conceptId, a, 'ai');
        }
        this.db.sql.prepare('UPDATE concept_mention SET concept_id = ? WHERE notebook_id = ? AND key = ? AND concept_id IS NULL').run(conceptId, notebookId, key);
      }
    });
  }

  /** A concept the AI suggests from passing ideas that became one (ADR 0037): named as they mostly are, defined by the best. */
  suggestConcept(notebookId: string, title: string, keys: string[]): string {
    return this.db.tx(() => {
      const id = ulid();
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO room (id, notebook_id, title, kind, status, made_by, created_at, updated_at)
           VALUES (?, ?, ?, 'concept', 'suggested', 'ai', ?, ?)`,
        )
        .run(id, notebookId, title, t, t);
      this.nameConcept(id, title, 'ai');
      this.joinMentions(notebookId, keys, id);
      this.logEvent('concept.suggested', id);
      return id;
    });
  }

  /**
   * After a reading: each concept is defined by its best mention (one that defines it, then explains it); when the
   * one it was defined by is gone, the next best defines it. A suggested concept no material discusses any more,
   * and nothing holds, goes.
   */
  refreshConcepts(notebookId: string): void {
    this.db.tx(() => {
      for (const c of this.db.sql.prepare("SELECT * FROM room WHERE notebook_id = ? AND kind = 'concept'").all(notebookId) as Row[]) {
        const id = c.id as string;
        const mentions = (this.db.sql.prepare('SELECT * FROM concept_mention WHERE concept_id = ? AND kept = 1').all(id) as Row[]).map((m) => ({
          id: m.id as string,
          role: m.role as MentionRole,
          at: m.created_at as string,
          says: (m.says as string | null) ?? null,
          target: (m.target as string | null) ?? null,
        }));
        if (mentions.length === 0 && c.status === 'suggested') {
          // A topic holds concepts, not materials: it stays while it holds any.
          const held = this.db.sql.prepare("SELECT 1 FROM room_item WHERE room_id = ? AND state = 'in'").get(id) || this.conceptHolds(id);
          if (!held) {
            this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(id);
            continue;
          }
        }
        const still = mentions.some((m) => m.id === c.definition_mention);
        if (still && c.definition) continue;
        const best = bestMention(mentions.filter((m) => m.target));
        if (!best && !c.definition_mention) continue;
        this.db.sql
          .prepare('UPDATE room SET definition = ?, definition_at = ?, definition_mention = ? WHERE id = ?')
          .run(best?.says ?? (c.definition as string | null) ?? null, best?.target ?? null, best?.id ?? null, id);
      }
    });
  }

  /** The concepts of a room's materials, for linking them: names, what is said of each, and whether kept. */
  roomConceptsForLinks(roomId: string): Array<{ id: string; title: string; status: 'suggested' | 'kept'; says: string[] }> {
    const view = this.roomView(roomId);
    if (!view) return [];
    // Its concepts, not its topics: a topic holds concepts and is not linked.
    return view.concepts.filter((c) => c.members.length > 0).slice(0, 20).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      says: [c.definition ?? '', ...c.sources.flatMap((x) => x.places.map((p) => p.says ?? ''))].filter((x) => x).slice(0, 3),
    }));
  }

  /** Which summaries a room's brief is written from, as one hash: a brief from other summaries is older. */
  roomBriefBasis(id: string): string | null {
    const room = this.roomMembersOf(id);
    if (!room) return null;
    return this.briefBasisOf(
      id,
      room.members.map((x) => roomKey(x.kind, x.id)),
      this.itemBases(room.notebookId),
      this.doors(room.notebookId),
    );
  }

  /** The rooms in a room, with their briefs, for the bigger room's brief (ADR 0032). */
  roomDoorsOf(id: string): RoomDoor[] {
    const r = this.db.sql.prepare('SELECT notebook_id FROM room WHERE id = ?').get(id) as Row | undefined;
    if (!r) return [];
    const notebookId = r.notebook_id as string;
    return this.roomDoors(id, this.roomGraph(notebookId), this.doors(notebookId), this.itemBases(notebookId));
  }

  saveRoomBrief(id: string, basis: string, text: string, open: NonNullable<RoomView['brief']>['open'], model: string): void {
    this.db.sql
      .prepare(
        `INSERT INTO room_brief (room_id, text, open, basis, model, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET text = excluded.text, open = excluded.open, basis = excluded.basis, model = excluded.model, created_at = excluded.created_at`,
      )
      .run(id, text, JSON.stringify(open), basis, model, now());
  }

  /** The rooms holding a thread (or the thread a side question is part of). */
  roomsOfThread(threadId: string): Room[] {
    const t = this.getThread(threadId);
    if (!t) return [];
    const byId = new Map(this.roomGraph(t.notebookId).threads.map((x) => [x.id, x]));
    const key = roomKey('thread', threadOf(threadId, byId));
    return this.listRooms(t.notebookId).filter((r) => (r.members as string[]).includes(key));
  }

  /**
   * The room a thread is in, for its questions (ADR 0030): of the rooms holding it (or the thread a side question
   * is part of), the one whose brief was written last. Null if none has a brief.
   */
  roomOfThread(threadId: string): { title: string; brief: string; open: string[]; within?: string[] } | null {
    const ids = this.roomsOfThread(threadId).map((r) => r.id);
    if (ids.length === 0) return null;
    const row = this.db.sql
      .prepare(
        `SELECT b.room_id, b.text, b.open, r.title FROM room_brief b JOIN room r ON r.id = b.room_id
         WHERE b.room_id IN (${ids.map(() => '?').join(', ')}) ORDER BY b.created_at DESC LIMIT 1`,
      )
      .get(...ids) as Row | undefined;
    if (!row) return null;
    const open = (JSON.parse(row.open as string) as Array<{ question: string }>).map((o) => o.question);
    // The bigger rooms it is in (ADR 0032), by name.
    const within = (
      this.db.sql
        .prepare('SELECT r.title FROM room_door d JOIN room r ON r.id = d.room_id WHERE d.child_id = ? ORDER BY d.created_at, d.rowid')
        .all(row.room_id as string) as Row[]
    ).map((x) => x.title as string);
    return { title: row.title as string, brief: row.text as string, open, ...(within.length ? { within } : {}) };
  }

  /** The things in a room, as "kind:id", and its notebook. */
  roomMembersOf(id: string): { notebookId: string; title: string; members: RoomItemRef[] } | null {
    const r = this.db.sql.prepare('SELECT * FROM room WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const members = [...roomMembers(this.roomRows(id), this.roomGraph(r.notebook_id as string)).keys()].map((k) => {
      const at = k.indexOf(':');
      return { kind: k.slice(0, at) as RoomKind, id: k.slice(at + 1) };
    });
    return { notebookId: r.notebook_id as string, title: r.title as string, members };
  }

  // Summaries and links (ADR 0027) --------------------------------------------

  /** What a summary of each thing would be written from now: a source's version, when a thread (with its side questions) or a note last changed. */
  itemBases(notebookId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const x of this.listSources(notebookId)) out.set(roomKey('source', x.id), x.latestVersionId);
    const threads = this.listThreads(notebookId);
    const byId = new Map(threads.map((t) => [t.id, t]));
    for (const t of threads) {
      const key = roomKey('thread', threadOf(t.id, byId));
      if ((out.get(key) ?? '') < t.updatedAt) out.set(key, t.updatedAt);
    }
    for (const n of this.listNotes(notebookId)) out.set(roomKey('note', n.id), n.updatedAt);
    return out;
  }

  gists(keys: string[]): Map<string, { basis: string; text: string; points: Gist['points']; model: string; at: string }> {
    const out = new Map<string, { basis: string; text: string; points: Gist['points']; model: string; at: string }>();
    const get = this.db.sql.prepare('SELECT * FROM gist WHERE kind = ? AND item_id = ?');
    for (const key of keys) {
      const at = key.indexOf(':');
      const r = get.get(key.slice(0, at), key.slice(at + 1)) as Row | undefined;
      if (!r) continue;
      out.set(key, {
        basis: r.basis as string,
        text: r.text as string,
        points: JSON.parse(r.points as string) as Gist['points'],
        model: r.model as string,
        at: r.created_at as string,
      });
    }
    return out;
  }

  saveGist(item: RoomItemRef, basis: string, text: string, points: Gist['points'], model: string): void {
    this.db.sql
      .prepare(
        `INSERT INTO gist (kind, item_id, basis, text, points, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, item_id) DO UPDATE SET basis = excluded.basis, text = excluded.text, points = excluded.points,
           model = excluded.model, created_at = excluded.created_at`,
      )
      .run(item.kind, item.id, basis, text, JSON.stringify(points), model, now());
  }

  /**
   * The words of a thing, as the AI reads it for a summary, with where each
   * stretch is: a source's latest version; a thread's questions and answers,
   * its side questions after; a note's blocks. Null if it is gone.
   */
  itemText(item: RoomItemRef): ItemText | null {
    if (item.kind === 'source') {
      const d = this.sourceDetail(item.id);
      if (!d || d.source.deletedAt) return null;
      const text = d.version.content;
      return {
        kind: 'source',
        title: d.source.title,
        text,
        segments: [
          { start: 0, end: text.length, target: { kind: 'source', sourceId: d.source.id, versionId: d.version.id, at: 0, title: d.source.title } },
        ],
      };
    }
    if (item.kind === 'note') {
      const n = this.getNote(item.id);
      if (!n || n.deletedAt) return null;
      let text = '';
      const segments: ItemText['segments'] = [];
      for (const b of n.blocks) {
        if (!b.content.trim()) continue;
        if (text) text += '\n\n';
        segments.push({ start: text.length, end: text.length + b.content.length, target: { kind: 'note', noteId: n.id, blockId: b.id, title: n.title } });
        text += b.content;
      }
      return { kind: 'note', title: n.title, text, segments };
    }
    const top = this.getThread(item.id);
    if (!top || top.deletedAt) return null;
    const threads = this.listThreads(top.notebookId);
    const byId = new Map(threads.map((t) => [t.id, t]));
    const family = threads
      .filter((t) => t.id !== top.id && threadOf(t.id, byId) === top.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let text = '';
    const segments: ItemText['segments'] = [];
    // The passages of sources it was asked about, or that were pinned into it (ADR 0038): read with it, each
    // pointing at its place in the source.
    const ids = [top, ...family].map((t) => t.id);
    const marks = ids.map(() => '?').join(', ');
    for (const a of this.db.sql
      .prepare(
        `SELECT a.exact, a.start_offset, a.version_id, s.id AS source_id, s.title
         FROM source_anchor a JOIN source_version v ON v.id = a.version_id JOIN source s ON s.id = v.source_id
         WHERE s.deleted_at IS NULL AND (a.id IN (SELECT source_anchor_id FROM thread WHERE id IN (${marks}))
            OR a.id IN (SELECT source_anchor_id FROM pin WHERE thread_id IN (${marks}) AND source_anchor_id IS NOT NULL))
         ORDER BY a.created_at, a.rowid`,
      )
      .all(...ids, ...ids) as Row[]) {
      const exact = (a.exact as string).trim();
      if (!exact) continue;
      const label = `About this passage of “${a.title as string}”: `;
      if (text) text += '\n\n';
      text += label;
      segments.push({
        start: text.length,
        end: text.length + exact.length,
        target: { kind: 'source', sourceId: a.source_id as string, versionId: a.version_id as string, at: Number(a.start_offset), title: a.title as string },
      });
      text += exact;
    }
    for (const t of [top, ...family]) {
      const side = t.id !== top.id;
      for (const m of this.listMessages(t.id)) {
        const body = m.content.trim();
        if (!body) continue;
        const line = `${m.role === 'user' ? (side ? 'Side question' : 'Q') : 'A'}: ${body}`;
        if (text) text += '\n\n';
        segments.push({ start: text.length, end: text.length + line.length, target: { kind: 'thread', threadId: t.id, messageId: m.id, title: t.title } });
        text += line;
      }
    }
    return { kind: 'thread', title: top.title, text, segments };
  }

  listItemLinks(notebookId: string): ItemLink[] {
    return (
      this.db.sql.prepare('SELECT * FROM item_link WHERE notebook_id = ? ORDER BY created_at, rowid').all(notebookId) as Row[]
    ).map(toItemLink);
  }

  getItemLink(id: string): (ItemLink & { notebookId: string }) | null {
    const r = this.db.sql.prepare('SELECT * FROM item_link WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...toItemLink(r), notebookId: r.notebook_id as string } : null;
  }

  /** A link between two things, either way round, in any state. */
  linkBetween(notebookId: string, a: RoomItemRef, b: RoomItemRef): ItemLink | null {
    const r = this.db.sql
      .prepare(
        `SELECT * FROM item_link WHERE notebook_id = ? AND (
           (from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ?) OR
           (from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ?))`,
      )
      .get(notebookId, a.kind, a.id, b.kind, b.id, b.kind, b.id, a.kind, a.id) as Row | undefined;
    return r ? toItemLink(r) : null;
  }

  /** A link (a side question's end goes to its thread). Idempotent on the id. */
  createItemLink(
    id: string,
    notebookId: string,
    link: { from: RoomItemRef; to: RoomItemRef; kind: LinkKind; label?: string | null; why?: string | null },
    by: ItemLink['by'],
    status: ItemLink['status'],
  ): ItemLink {
    return this.db.tx(() => {
      const existing = this.getItemLink(id);
      if (existing) return existing;
      const from = this.roomItem(notebookId, link.from);
      const to = this.roomItem(notebookId, link.to);
      if (!from || !to) throw new InvalidError('both ends must be in this notebook');
      if (from.kind === to.kind && from.id === to.id) throw new InvalidError('a thing cannot be linked to itself');
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO item_link (id, notebook_id, from_kind, from_id, to_kind, to_id, kind, label, why, made_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, notebookId, from.kind, from.id, to.kind, to.id, link.kind, link.label?.trim() || null, link.why ?? null, by, status, t, t);
      this.logEvent('link.created', id, { by, status, kind: link.kind });
      return this.getItemLink(id) as ItemLink;
    });
  }

  updateItemLink(
    id: string,
    patch: { kind?: LinkKind; label?: string | null; status?: 'accepted' | 'dismissed'; flip?: boolean; why?: string | null },
  ): ItemLink | null {
    const l = this.getItemLink(id);
    if (!l) return null;
    const from = patch.flip ? l.to : l.from;
    const to = patch.flip ? l.from : l.to;
    // Changing a suggested link is accepting it.
    const status = patch.status ?? (l.status === 'suggested' && (patch.kind || patch.label !== undefined || patch.flip) ? 'accepted' : l.status);
    this.db.sql
      .prepare(
        `UPDATE item_link SET from_kind = ?, from_id = ?, to_kind = ?, to_id = ?, kind = ?, label = ?, why = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        from.kind,
        from.id,
        to.kind,
        to.id,
        patch.kind ?? l.kind,
        patch.label === undefined ? l.label : patch.label?.trim() || null,
        patch.why === undefined ? l.why : patch.why,
        status,
        now(),
        id,
      );
    this.logEvent('link.changed', id, { status });
    return this.getItemLink(id);
  }

  deleteItemLink(id: string): boolean {
    const r = this.db.sql.prepare('DELETE FROM item_link WHERE id = ?').run(id);
    if (Number(r.changes) > 0) this.logEvent('link.deleted', id);
    return Number(r.changes) > 0;
  }

  /** Make a room, with things in it at once. Idempotent on the id. */
  createRoom(id: string, notebookId: string, title: string, items: RoomItemRef[] = [], by: 'you' | 'assistant' = 'you'): { room: Room; created: boolean } {
    return this.db.tx(() => {
      const existing = this.db.sql.prepare('SELECT notebook_id FROM room WHERE id = ?').get(id) as Row | undefined;
      if (existing) {
        if (existing.notebook_id !== notebookId) throw new ConflictError('room id already used');
        return { room: this.getRoom(id) as Room, created: false };
      }
      const t = now();
      this.db.sql
        .prepare('INSERT INTO room (id, notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, notebookId, title.trim(), t, t);
      this.logEvent('room.created', id, { items: items.length });
      if (items.length > 0) this.addRoomItems(id, items, by);
      return { room: this.getRoom(id) as Room, created: true };
    });
  }

  renameRoom(id: string, title: string): Room | null {
    const r = this.db.sql.prepare('UPDATE room SET title = ?, updated_at = ? WHERE id = ?').run(title.trim(), now(), id);
    // A concept keeps its old name as another name: mentions using it still join it (ADR 0037).
    if (Number(r.changes) > 0 && this.conceptRow(id)) this.nameConcept(id, title, 'you');
    return Number(r.changes) > 0 ? this.getRoom(id) : null;
  }

  /** Everything a room is, as rows: to bring it back after it was deleted or merged (the Assistant's Undo). */
  roomSnapshot(id: string): RoomSnapshot | null {
    const room = this.db.sql.prepare('SELECT * FROM room WHERE id = ?').get(id) as Row | undefined;
    if (!room) return null;
    const items = this.db.sql.prepare('SELECT * FROM room_item WHERE room_id = ?').all(id) as Row[];
    const brief = this.db.sql.prepare('SELECT * FROM room_brief WHERE room_id = ?').get(id) as Row | undefined;
    const doors = this.db.sql.prepare('SELECT * FROM room_door WHERE room_id = ? OR child_id = ?').all(id, id) as Row[];
    return {
      room: { ...room },
      items: items.map((r) => ({ ...r })),
      brief: brief ? { ...brief } : null,
      doors: doors.map((r) => ({ ...r })),
    };
  }

  /** A room put back as it was in a snapshot: its title, what was in and out of it, where things were. */
  restoreRoom(snap: RoomSnapshot): Room {
    const put = (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      this.db.sql
        .prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...(cols.map((c) => row[c]) as Array<string | number | null>));
    };
    this.db.tx(() => {
      // An upsert, not a replace: replacing the row would take what hangs on it (its doors, its pages found) with it.
      const cols = Object.keys(snap.room);
      this.db.sql
        .prepare(
          `INSERT INTO room (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
           ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
        )
        .run(...(cols.map((c) => snap.room[c]) as Array<string | number | null>));
      this.db.sql.prepare('DELETE FROM room_item WHERE room_id = ?').run(snap.room.id as string);
      for (const r of snap.items) put('room_item', r);
      if (snap.brief) put('room_brief', snap.brief);
      // Its doors both ways (ADR 0032), as they were; those to a room that is gone stay gone.
      if (snap.doors) {
        this.db.sql.prepare('DELETE FROM room_door WHERE room_id = ? OR child_id = ?').run(snap.room.id as string, snap.room.id as string);
        for (const d of snap.doors) this.putDoorRow(d);
      }
    });
    this.logEvent('room.restored', snap.room.id as string);
    return this.getRoom(snap.room.id as string) as Room;
  }

  /** One room taken into another: what was put in the first is put in the second, and the first is gone. */
  mergeRooms(fromId: string, intoId: string, by: 'you' | 'assistant' = 'you'): Room {
    const from = this.getRoom(fromId);
    const into = this.getRoom(intoId);
    if (!from || !into) throw new NotFoundError('room');
    if (from.id === into.id) throw new InvalidError('a room cannot be merged into itself');
    // Two concepts: their own way (ADR 0037). A concept and a room are not merged.
    if (from.kind === 'concept' || into.kind === 'concept') {
      if (from.kind !== into.kind) throw new InvalidError('a concept merges only into a concept');
      return this.mergeConcepts(fromId, intoId) as Room;
    }
    const rows = this.db.sql.prepare("SELECT kind, item_id FROM room_item WHERE room_id = ? AND state = 'in'").all(fromId) as Row[];
    this.db.tx(() => {
      if (rows.length) this.addRoomItems(intoId, rows.map((r) => ({ kind: r.kind as RoomItemRef['kind'], id: r.item_id as string })), by);
      // Rooms in rooms (ADR 0032): the rooms in the first go in the second, and the second goes where the first was;
      // never so that a room would be inside itself.
      const doors = this.db.sql.prepare('SELECT * FROM room_door WHERE room_id = ? OR child_id = ?').all(fromId, fromId) as Row[];
      this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(fromId);
      const notebookId = from.notebookId;
      for (const d of doors) {
        const [parent, child] = d.room_id === fromId ? [intoId, d.child_id as string] : [d.room_id as string, intoId];
        if (parent === child || wouldLoop(this.doors(notebookId), parent, child)) continue;
        this.db.sql
          .prepare('INSERT OR IGNORE INTO room_door (room_id, child_id, x, y, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(parent, child, (d.x as number | null) ?? null, (d.y as number | null) ?? null, by, now(), now());
      }
    });
    this.logEvent('room.merged', intoId, { from: fromId, items: rows.length });
    return this.getRoom(intoId) as Room;
  }

  /** A link's row as it is, to put it back after a change (the Assistant's Undo). */
  itemLinkRow(id: string): Record<string, unknown> | null {
    const r = this.db.sql.prepare('SELECT * FROM item_link WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...r } : null;
  }

  putItemLinkRow(row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    this.db.sql
      .prepare(`INSERT OR REPLACE INTO item_link (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(cols.map((c) => row[c]) as Array<string | number | null>));
  }

  /** A room is taken down; what was in it stays where it is. */
  deleteRoom(id: string): boolean {
    return this.db.tx(() => {
      // A concept belongs to the notebook (ADR 0037): deleting a room leaves them.
      const r = this.db.sql.prepare('DELETE FROM room WHERE id = ?').run(id);
      if (Number(r.changes) > 0) this.logEvent('room.deleted', id);
      return Number(r.changes) > 0;
    });
  }

  /** The thread a side question is part of; anything else as it is. Null if it is not in this notebook. */
  private roomItem(notebookId: string, item: RoomItemRef): RoomItemRef | null {
    const table = item.kind === 'thread' ? 'thread' : item.kind === 'source' ? 'source' : 'note';
    const r = this.db.sql.prepare(`SELECT notebook_id FROM ${table} WHERE id = ?`).get(item.id) as Row | undefined;
    if (!r || r.notebook_id !== notebookId) return null;
    if (item.kind !== 'thread') return item;
    const threads = new Map(this.roomGraph(notebookId).threads.map((t) => [t.id, t]));
    return { kind: 'thread', id: threadOf(item.id, threads) };
  }

  /** Put things in a room (a side question goes in as its thread), at a place on its map if given. */
  addRoomItems(roomId: string, items: Array<RoomItemRef & { x?: number; y?: number }>, by: 'you' | 'assistant' = 'you'): Room {
    return this.db.tx(() => {
      const room = this.db.sql.prepare('SELECT notebook_id, kind FROM room WHERE id = ?').get(roomId) as Row | undefined;
      if (!room) throw new NotFoundError('room');
      const t = now();
      for (const item of items) {
        const at = this.roomItem(room.notebook_id as string, item);
        if (!at) throw new InvalidError(`that ${item.kind} is not in this notebook`);
        const place = item.x !== undefined && item.y !== undefined ? [item.x, item.y] : [null, null];
        this.db.sql
          .prepare(
            `INSERT INTO room_item (room_id, kind, item_id, state, x, y, added_by, created_at, updated_at)
             VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, kind, item_id) DO UPDATE SET
               state = 'in', x = coalesce(excluded.x, room_item.x), y = coalesce(excluded.y, room_item.y),
               added_by = excluded.added_by, updated_at = excluded.updated_at`,
          )
          .run(roomId, at.kind, at.id, place[0] ?? null, place[1] ?? null, by, t, t);
      }
      this.db.sql.prepare('UPDATE room SET updated_at = ? WHERE id = ?').run(t, roomId);
      this.logEvent('room.items_added', roomId, { n: items.length, by });
      return this.getRoom(roomId) as Room;
    });
  }

  /**
   * Take something out of a room. If it came with something still in the room
   * (a thread with its source), it is marked as taken out, so it does not come
   * back with it.
   */
  removeRoomItem(roomId: string, item: RoomItemRef): Room {
    return this.db.tx(() => {
      const room = this.db.sql.prepare('SELECT notebook_id, kind FROM room WHERE id = ?').get(roomId) as Row | undefined;
      if (!room) throw new NotFoundError('room');
      const at = this.roomItem(room.notebook_id as string, item);
      if (!at) throw new InvalidError(`that ${item.kind} is not in this notebook`);
      const t = now();
      this.db.sql.prepare('DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ?').run(roomId, at.kind, at.id);
      // Still in it by itself (a thing that came with another, or a material that mentions the concept): kept out.
      const graph = this.roomGraph(room.notebook_id as string);
      const still =
        room.kind === 'concept'
          ? this.conceptMembers(roomId, this.roomRows(roomId), graph).includes(roomKey(at.kind, at.id))
          : roomMembers(this.roomRows(roomId), graph).has(roomKey(at.kind, at.id));
      if (still) {
        this.db.sql
          .prepare(
            `INSERT INTO room_item (room_id, kind, item_id, state, created_at, updated_at) VALUES (?, ?, ?, 'out', ?, ?)`,
          )
          .run(roomId, at.kind, at.id, t, t);
      }
      this.db.sql.prepare('UPDATE room SET updated_at = ? WHERE id = ?').run(t, roomId);
      this.logEvent('room.item_removed', roomId);
      return this.getRoom(roomId) as Room;
    });
  }

  /** How a thing is in a room by hand: put in, taken out, only placed, or not at all. */
  roomItemState(roomId: string, item: RoomItemRef): 'in' | 'out' | 'placed' | null {
    const r = this.db.sql
      .prepare('SELECT state FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ?')
      .get(roomId, item.kind, item.id) as Row | undefined;
    return (r?.state as 'in' | 'out' | 'placed' | undefined) ?? null;
  }

  /** Put back how a thing was in a room (to undo). */
  setRoomItemState(roomId: string, item: RoomItemRef, state: 'in' | 'out' | 'placed' | null): void {
    if (state === null) {
      this.db.sql.prepare('DELETE FROM room_item WHERE room_id = ? AND kind = ? AND item_id = ?').run(roomId, item.kind, item.id);
      return;
    }
    const t = now();
    this.db.sql
      .prepare(
        `INSERT INTO room_item (room_id, kind, item_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, kind, item_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(roomId, item.kind, item.id, state, t, t);
  }

  /** Where things sit on a room's map. */
  placeRoomItems(roomId: string, places: Array<RoomItemRef & { x: number; y: number }>): void {
    this.db.tx(() => {
      if (!this.db.sql.prepare('SELECT 1 FROM room WHERE id = ?').get(roomId)) throw new NotFoundError('room');
      const t = now();
      for (const p of places) {
        this.db.sql
          .prepare(
            `INSERT INTO room_item (room_id, kind, item_id, state, x, y, created_at, updated_at)
             VALUES (?, ?, ?, 'placed', ?, ?, ?, ?)
             ON CONFLICT (room_id, kind, item_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
          )
          .run(roomId, p.kind, p.id, Math.round(p.x), Math.round(p.y), t, t);
      }
    });
  }

  // Folders on the learner's computer (ADR 0025) ----------------------------

  addFolder(notebookId: string, id: string, path: string, name: string): { id: string; name: string; path: string; created: boolean } {
    return this.db.tx(() => {
      const same = this.db.sql.prepare('SELECT * FROM folder WHERE notebook_id = ? AND path = ?').get(notebookId, path) as Row | undefined;
      if (same) return { id: same.id as string, name: same.name as string, path, created: false };
      if (this.db.sql.prepare('SELECT 1 FROM folder WHERE id = ?').get(id)) throw new ConflictError('folder id already used');
      // Names are how the Assistant and the sidebar tell folders apart: two of the same name get a number.
      const taken = new Set(
        (this.db.sql.prepare('SELECT name FROM folder WHERE notebook_id = ?').all(notebookId) as Row[]).map((r) => r.name as string),
      );
      let unique = name;
      for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
      this.db.sql
        .prepare('INSERT INTO folder (id, notebook_id, path, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, notebookId, path, unique, now());
      this.logEvent('folder.added', id);
      return { id, name: unique, path, created: true };
    });
  }

  listFolders(notebookId: string): Array<{ id: string; name: string; path: string }> {
    return (this.db.sql.prepare('SELECT id, name, path FROM folder WHERE notebook_id = ? ORDER BY name').all(notebookId) as Row[]).map(
      (r) => ({ id: r.id as string, name: r.name as string, path: r.path as string }),
    );
  }

  getFolder(id: string): { id: string; notebookId: string; name: string; path: string } | null {
    const r = this.db.sql.prepare('SELECT * FROM folder WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, notebookId: r.notebook_id as string, name: r.name as string, path: r.path as string } : null;
  }

  /** Unlink a folder: its files stay where they are, and the sources read from them stay (no longer linked). */
  removeFolder(id: string): boolean {
    const r = this.db.sql.prepare('DELETE FROM folder WHERE id = ?').run(id);
    if (Number(r.changes) > 0) this.logEvent('folder.removed', id);
    return Number(r.changes) > 0;
  }

  /** The source a file was opened as (in the Trash too), if any. */
  sourceOfFile(folderId: string, path: string): Source | null {
    const r = this.db.sql.prepare('SELECT id FROM source WHERE folder_id = ? AND file_path = ?').get(folderId, path) as Row | undefined;
    return r ? this.getSource(r.id as string) : null;
  }

  /** The files of a folder that were opened, by path. */
  openedFiles(folderId: string): Map<string, string> {
    const rows = this.db.sql
      .prepare('SELECT id, file_path FROM source WHERE folder_id = ? AND deleted_at IS NULL')
      .all(folderId) as Row[];
    return new Map(rows.map((r) => [r.file_path as string, r.id as string]));
  }

  /** A source read from a file of a linked folder. */
  createFileSource(
    id: string,
    notebookId: string,
    file: { folderId: string; path: string },
    init: { title: string; version: NewSourceVersion },
  ): Source {
    return this.db.tx(() => {
      const { source } = this.createSource(id, notebookId, { title: init.title, url: null, version: init.version });
      this.db.sql.prepare('UPDATE source SET folder_id = ?, file_path = ? WHERE id = ?').run(file.folderId, file.path, source.id);
      return this.getSource(source.id) as Source;
    });
  }

  /** The bytes' hash of the latest version read from a file. */
  latestFileHash(sourceId: string): string | null {
    const r = this.db.sql
      .prepare('SELECT file_hash FROM source_version WHERE source_id = ? ORDER BY seq DESC LIMIT 1')
      .get(sourceId) as Row | undefined;
    return (r?.file_hash as string | null | undefined) ?? null;
  }

  /** The bytes' hash a version was read from (a file of a linked folder), or null. */
  versionFileHash(versionId: string): string | null {
    const r = this.db.sql.prepare('SELECT file_hash FROM source_version WHERE id = ?').get(versionId) as Row | undefined;
    return (r?.file_hash as string | null | undefined) ?? null;
  }

  /** Note that the latest version is the file as it is now (same text, bytes read again). */
  setLatestFileHash(sourceId: string, hash: string): void {
    this.db.sql
      .prepare(
        'UPDATE source_version SET file_hash = ? WHERE id = (SELECT id FROM source_version WHERE source_id = ? ORDER BY seq DESC LIMIT 1)',
      )
      .run(hash, sourceId);
  }

  addFileBackup(b: { id: string; folderId: string; path: string; before: string | null; afterHash: string }): void {
    this.db.sql
      .prepare('INSERT INTO file_backup (id, folder_id, file_path, before, after_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.id, b.folderId, b.path, b.before, b.afterHash, now());
  }

  fileBackup(id: string): { folderId: string; path: string; before: string | null; afterHash: string } | null {
    const r = this.db.sql.prepare('SELECT * FROM file_backup WHERE id = ?').get(id) as Row | undefined;
    return r
      ? { folderId: r.folder_id as string, path: r.file_path as string, before: (r.before as string | null) ?? null, afterHash: r.after_hash as string }
      : null;
  }

  renameSource(id: string, title: string): Source {
    const r = this.db.sql.prepare('UPDATE source SET title = ? WHERE id = ?').run(title, id);
    if (Number(r.changes) === 0) throw new NotFoundError('source');
    this.indexSource(id);
    return this.getSource(id) as Source;
  }

  /** To the Trash: threads asked about it stay. */
  deleteSource(id: string): boolean {
    const r = this.db.sql.prepare('UPDATE source SET deleted_at = coalesce(deleted_at, ?) WHERE id = ?').run(now(), id);
    if (Number(r.changes) > 0) this.logEvent('source.deleted', id);
    return Number(r.changes) > 0;
  }

  restoreSource(id: string): Source {
    const r = this.db.sql.prepare('UPDATE source SET deleted_at = NULL WHERE id = ?').run(id);
    if (Number(r.changes) === 0) throw new NotFoundError('source');
    this.logEvent('source.restored', id);
    return this.getSource(id) as Source;
  }

  /** The page or file the latest version was read from, as kept, and what read it. */
  latestPage(sourceId: string): {
    raw: string;
    extractor: string;
    origin: SourceVersion['origin'];
    fetchedUrl: string | null;
    mediaType: string | null;
    fileName: string | null;
  } | null {
    const r = this.db.sql
      .prepare(
        `SELECT raw, extractor, origin, fetched_url, media_type, file_name
         FROM source_version WHERE source_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(sourceId) as Row | undefined;
    if (!r || !r.raw || !r.extractor) return null;
    return {
      raw: r.raw as string,
      extractor: r.extractor as string,
      origin: originOf(r),
      fetchedUrl: (r.fetched_url as string | null) ?? null,
      mediaType: (r.media_type as string | null) ?? null,
      fileName: (r.file_name as string | null) ?? null,
    };
  }

  /** Reading the kept page again gave the same text: record that this reader read it. */
  markLatestRead(sourceId: string, extractor: string): void {
    this.db.sql
      .prepare(
        'UPDATE source_version SET extractor = ? WHERE id = (SELECT id FROM source_version WHERE source_id = ? ORDER BY seq DESC LIMIT 1)',
      )
      .run(extractor, sourceId);
  }

  /**
   * A version of a source (the latest by default), with the threads asked
   * about its passages. `outdated` says whether a reader (by its name) is
   * older than the one this Noema has, so the latest can be read better.
   */
  sourceDetail(id: string, versionId?: string, outdated?: (extractor: string) => boolean): SourceDetail | null {
    const source = this.getSource(id);
    if (!source) return null;
    const version = this.getVersion(versionId ?? source.latestVersionId);
    if (!version || version.sourceId !== id) return null;
    const { hash: _hash, ...shown } = version;
    const versions = (
      this.db.sql
        .prepare('SELECT id, seq, created_at FROM source_version WHERE source_id = ? ORDER BY seq DESC')
        .all(id) as Row[]
    ).map((r) => ({ id: r.id as string, seq: r.seq as number, createdAt: r.created_at as string }));
    const threads = (
      this.db.sql
        .prepare(
          `WITH RECURSIVE family(root, id) AS (
             SELECT t.id, t.id FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id
              WHERE a.version_id = ? AND t.deleted_at IS NULL
             UNION
             SELECT f.root, c.id FROM thread c JOIN family f ON c.parent_thread_id = f.id OR c.continued_from = f.id
              WHERE c.deleted_at IS NULL AND c.source_anchor_id IS NULL
           )
           SELECT t.id AS thread_id, t.title, t.created_at AS thread_created_at, a.*,
             (SELECT count(*) FROM family f JOIN message m ON m.thread_id = f.id
               WHERE f.root = t.id AND m.role = 'user') AS questions
           FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id
           WHERE a.version_id = ? AND t.deleted_at IS NULL ORDER BY t.created_at`,
        )
        .all(version.id, version.id) as Row[]
    ).map((r) => ({
      threadId: r.thread_id as string,
      title: r.title as string,
      createdAt: r.thread_created_at as string,
      passage: toPassage(r),
      questions: Number(r.questions),
    }));
    const elsewhere = this.db.sql
      .prepare(
        `SELECT count(*) AS n FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id
         JOIN source_version v ON v.id = a.version_id
         WHERE v.source_id = ? AND a.version_id <> ? AND t.deleted_at IS NULL`,
      )
      .get(id, version.id) as { n: number };
    const latest = outdated
      ? (this.db.sql
          .prepare('SELECT extractor, raw IS NOT NULL AS kept FROM source_version WHERE source_id = ? ORDER BY seq DESC LIMIT 1')
          .get(id) as { extractor: string | null; kept: number } | undefined)
      : undefined;
    const rereadable = Boolean(latest?.kept && latest.extractor && outdated?.(latest.extractor));
    return { source, version: shown, versions, threads, elsewhere: elsewhere.n, rereadable };
  }

  /** A thread asked about a passage of a source, with its first question, in one step. Idempotent on the thread id. */
  createSourceThread(
    sourceId: string,
    threadId: string,
    at: { versionId: string; start: number; end: number },
    question: { id: string; content: string },
  ): { thread: Thread; pair: AskPair; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getThread(threadId);
      if (existing) {
        if (existing.sourceId !== sourceId) throw new ConflictError('thread id already used');
        const { pair, created } = this.createAsk(threadId, question.id, question.content);
        return { thread: this.getThread(threadId) as Thread, pair, created };
      }
      const source = this.getSource(sourceId);
      if (!source) throw new NotFoundError('source');
      if (source.deletedAt) throw new ConflictError('this source is in the Trash: restore it first');
      const version = this.getVersion(at.versionId);
      if (!version || version.sourceId !== sourceId) throw new InvalidError('that version is not of this source');
      let anchor: ReturnType<typeof createAnchor>;
      try {
        anchor = createAnchor(version.id, version.content, at.start, at.end);
      } catch {
        throw new InvalidError('the selected range is outside the source');
      }
      const t = now();
      const anchorId = ulid();
      this.db.sql
        .prepare(
          `INSERT INTO source_anchor (id, version_id, exact, prefix, suffix, start_offset, end_offset, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          anchorId,
          version.id,
          anchor.quote.exact,
          anchor.quote.prefix,
          anchor.quote.suffix,
          anchor.position.start,
          anchor.position.end,
          t,
        );
      this.db.sql
        .prepare(
          `INSERT INTO thread (id, notebook_id, source_anchor_id, title, created_at, updated_at)
           VALUES (?, ?, ?, '', ?, ?)`,
        )
        .run(threadId, source.notebookId, anchorId, t, t);
      this.db.sql.prepare('UPDATE source SET updated_at = ? WHERE id = ?').run(t, sourceId);
      this.logEvent('source.asked', threadId, { sourceId, versionId: version.id, chars: anchor.quote.exact.length });
      const { pair } = this.createAsk(threadId, question.id, question.content);
      return { thread: this.getThread(threadId) as Thread, pair, created: true };
    });
  }

  /** For a thread asked about a passage of a source: which source, version and passage. */
  sourceOriginOf(threadId: string): SourceOrigin | null {
    const r = this.db.sql
      .prepare(
        `SELECT a.*, v.source_id, s.title AS source_title, s.url AS source_url, s.deleted_at AS source_deleted
         FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id
         JOIN source_version v ON v.id = a.version_id JOIN source s ON s.id = v.source_id
         WHERE t.id = ?`,
      )
      .get(threadId) as Row | undefined;
    if (!r) return null;
    const source = this.getSource(r.source_id as string) as Source;
    return {
      sourceId: r.source_id as string,
      sourceTitle: r.source_title as string,
      url: (r.source_url as string | null) ?? null,
      passage: toPassage(r),
      latestVersionId: source.latestVersionId,
      deleted: r.source_deleted !== null,
    };
  }

  /**
   * What the model is told about the source a thread (or the thread it came
   * from) was asked about: its title and address, and the section around the
   * passage. Side questions and threads split off keep the reading in view.
   */
  sourceContextFor(threadId: string): {
    title: string;
    url: string | null;
    section: string;
    passage: string;
    versionId: string;
    /** For a PDF: the pages the passage is on (one, or two when it runs over). */
    pages: number[];
  } | null {
    const seen = new Set<string>();
    for (let id: string | null = threadId; id && !seen.has(id); ) {
      seen.add(id);
      const origin = this.sourceOriginOf(id);
      if (origin) {
        const version = this.getVersion(origin.passage.versionId);
        if (!version) return null;
        return {
          title: origin.sourceTitle,
          url: origin.url,
          section: sourceSection(version.content, origin.passage.start, origin.passage.end),
          passage: origin.passage.exact,
          versionId: version.id,
          pages: version.file ? pagesOf(version.content, origin.passage.start, origin.passage.end) : [],
        };
      }
      const row = this.db.sql.prepare('SELECT parent_thread_id, continued_from FROM thread WHERE id = ?').get(id) as
        | Row
        | undefined;
      id = (row?.parent_thread_id as string | null) ?? (row?.continued_from as string | null) ?? null;
    }
    return null;
  }

  /** The latest version's title and passages, as search rows. */
  private indexSource(sourceId: string): void {
    this.db.sql.prepare("DELETE FROM search WHERE thread_id = ? AND kind IN ('source', 'passage')").run(sourceId);
    const row = this.db.sql.prepare('SELECT title FROM source WHERE id = ?').get(sourceId) as Row | undefined;
    const source = this.getSource(sourceId);
    if (!row || !source) return;
    this.insertIndex('source', sourceId, sourceId, row.title as string);
    const version = this.getVersion(source.latestVersionId);
    for (const b of sourceBlocks(version?.content ?? '')) {
      this.insertIndex('passage', `${source.latestVersionId}:${b.start}`, sourceId, plainText(b.text));
    }
  }

  // Trash ---------------------------------------------------------------------
  //
  // Deleting a thread hides it, and the side questions asked from it (and
  // from them), everywhere: the sidebar, search, maps, the list of side
  // questions left open. Nothing is removed, so restoring brings it all back
  // as it was. Threads that left it to be their own (made their own thread,
  // or split off at a question) are their own: they stay. Merges stay where
  // they were merged, notes stay, and so do their citations.

  private notInTrash(threadId: string): void {
    const row = this.db.sql.prepare('SELECT deleted_at FROM thread WHERE id = ?').get(threadId) as Row | undefined;
    if (row?.deleted_at) throw new ConflictError('this thread is in the Trash: restore it first');
  }

  /** The side questions below a thread that are still its (not their own threads), not already deleted. */
  private sideQuestionsBelow(threadId: string): string[] {
    const stmt = this.db.sql.prepare(
      'SELECT id FROM thread WHERE parent_thread_id = ? AND split_at IS NULL AND deleted_at IS NULL',
    );
    const out: string[] = [];
    const walk = (id: string) => {
      for (const r of stmt.all(id) as Row[]) {
        out.push(r.id as string);
        walk(r.id as string);
      }
    };
    walk(threadId);
    return out;
  }

  /** To the Trash, with its side questions. Returns how many threads went. Idempotent. */
  deleteThread(threadId: string): number {
    return this.db.tx(() => {
      const thread = this.getThread(threadId);
      if (!thread) throw new NotFoundError('thread');
      if (thread.deletedAt) return 0;
      const along = this.sideQuestionsBelow(threadId);
      if ([threadId, ...along].some((id) => this.hasLiveAnswer(id))) throw new ConflictError('wait for the answer to finish');
      const t = now();
      this.db.sql.prepare('UPDATE thread SET deleted_at = ?, deleted_with = NULL WHERE id = ?').run(t, threadId);
      const take = this.db.sql.prepare('UPDATE thread SET deleted_at = ?, deleted_with = ? WHERE id = ?');
      for (const id of along) take.run(t, threadId, id);
      this.logEvent('thread.deleted', threadId, { sideQuestions: along.length });
      return 1 + along.length;
    });
  }

  /**
   * Back from the Trash with everything that went with it. A side question
   * whose thread is in the Trash too brings that thread back as well, so it
   * is never shown without where it came from.
   */
  restoreThread(threadId: string): Thread {
    return this.db.tx(() => {
      let row = this.db.sql
        .prepare('SELECT id, parent_thread_id, split_at, deleted_at, deleted_with FROM thread WHERE id = ?')
        .get(threadId) as Row | undefined;
      if (!row) throw new NotFoundError('thread');
      const back = this.db.sql.prepare(
        'UPDATE thread SET deleted_at = NULL, deleted_with = NULL WHERE id = ? OR deleted_with = ?',
      );
      const seen = new Set<string>();
      while (row?.deleted_at && !seen.has(row.id as string)) {
        seen.add(row.id as string);
        const batch = (row.deleted_with as string | null) ?? (row.id as string);
        back.run(batch, batch);
        this.logEvent('thread.restored', batch);
        if (!row.parent_thread_id || row.split_at) break;
        row = this.db.sql
          .prepare('SELECT id, parent_thread_id, split_at, deleted_at, deleted_with FROM thread WHERE id = ?')
          .get(row.parent_thread_id as string) as Row | undefined;
      }
      return this.getThread(threadId) as Thread;
    });
  }

  // Deleting for good (ADR 0034) --------------------------------------------
  //
  // On the learner's word, from right-click: a thread (with the side questions
  // still its own), a source or a note is removed from the notebook, whether
  // it is in the Trash or not. There is no Undo. What only pointed at it lets
  // go of it and stays: threads asked about a source stay (no longer tied to
  // its passage), threads that became their own stay (no longer under it),
  // notes made from a thread stay (their citations of it show as not found).
  // Its places in rooms, its links and its summaries go. Files on the
  // learner's computer are never touched.

  /** Delete a thread for good, with the side questions still its own (in the Trash or not). How many threads went. */
  purgeThread(threadId: string): number {
    return this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT id, kind FROM thread WHERE id = ?').get(threadId) as Row | undefined;
      if (!row) throw new NotFoundError('thread');
      if (row.kind === 'assistant') throw new InvalidError('the Assistant is not a thread to delete');
      // Its side questions, at any depth: those still its own, in the Trash or not.
      const below = this.db.sql.prepare('SELECT id FROM thread WHERE parent_thread_id = ? AND split_at IS NULL');
      const ids = [threadId];
      for (let i = 0; i < ids.length; i++) for (const r of below.all(ids[i] as string) as Row[]) ids.push(r.id as string);
      if (ids.some((id) => this.hasLiveAnswer(id))) throw new ConflictError('wait for the answer to finish');
      const list = ids.map(() => '?').join(', ');
      // Notes made from it were in its rooms with it: they stay in them, now on their own.
      const made = (
        this.db.sql.prepare(`SELECT id FROM note WHERE thread_id IN (${list}) ORDER BY created_at`).all(...ids) as Row[]
      ).map((r) => ({ kind: 'note' as const, id: r.id as string }));
      const rooms = this.db.sql
        .prepare(`SELECT DISTINCT room_id FROM room_item WHERE kind = 'thread' AND item_id IN (${list}) AND state = 'in'`)
        .all(...ids) as Row[];
      if (made.length) for (const r of rooms) this.addRoomItems(r.room_id as string, made);
      // What stays lets go of it: threads that became their own, side questions started on its words, replies.
      this.db.sql.prepare(`UPDATE thread SET parent_thread_id = NULL WHERE parent_thread_id IN (${list}) AND id NOT IN (${list})`).run(...ids, ...ids);
      this.db.sql
        .prepare(
          `UPDATE thread SET origin_anchor_id = NULL WHERE id NOT IN (${list}) AND origin_anchor_id IN (
             SELECT a.id FROM anchor a JOIN message m ON m.id = a.message_id WHERE m.thread_id IN (${list}))`,
        )
        .run(...ids, ...ids);
      this.db.sql
        .prepare(
          `UPDATE message SET reply_to = NULL WHERE thread_id NOT IN (${list}) AND reply_to IN (SELECT id FROM message WHERE thread_id IN (${list}))`,
        )
        .run(...ids, ...ids);
      this.db.sql.prepare(`DELETE FROM search WHERE (kind IN ('message', 'thread') AND thread_id IN (${list})) OR (kind = 'thread' AND target_id IN (${list}))`).run(...ids, ...ids);
      this.forgetItems('thread', ids);
      // Its messages, answers, anchors, pins, merges and the Assistant's changes in it go with it (ON DELETE CASCADE).
      this.db.sql.prepare(`DELETE FROM thread WHERE id IN (${list})`).run(...ids);
      this.logEvent('thread.purged', threadId, { sideQuestions: ids.length - 1 });
      return ids.length;
    });
  }

  /** Delete a source for good, with its versions and passages. Threads asked about it stay. */
  purgeSource(sourceId: string): void {
    this.db.tx(() => {
      if (!this.db.sql.prepare('SELECT 1 FROM source WHERE id = ?').get(sourceId)) throw new NotFoundError('source');
      // The threads asked about it were in its rooms with it: they stay in them, now on their own.
      const asked = (
        this.db.sql
          .prepare(
            `SELECT t.id FROM thread t JOIN source_anchor a ON a.id = t.source_anchor_id JOIN source_version v ON v.id = a.version_id
             WHERE v.source_id = ? ORDER BY t.created_at`,
          )
          .all(sourceId) as Row[]
      ).map((r) => ({ kind: 'thread' as const, id: r.id as string }));
      const rooms = this.db.sql.prepare("SELECT room_id FROM room_item WHERE kind = 'source' AND item_id = ? AND state = 'in'").all(sourceId) as Row[];
      if (asked.length) for (const r of rooms) this.addRoomItems(r.room_id as string, asked);
      this.db.sql
        .prepare(
          `UPDATE thread SET source_anchor_id = NULL WHERE source_anchor_id IN (
             SELECT a.id FROM source_anchor a JOIN source_version v ON v.id = a.version_id WHERE v.source_id = ?)`,
        )
        .run(sourceId);
      this.db.sql.prepare("DELETE FROM search WHERE thread_id = ? AND kind IN ('source', 'passage')").run(sourceId);
      this.db.sql.prepare("UPDATE web_find SET status = 'found', source_id = NULL WHERE source_id = ?").run(sourceId);
      this.forgetItems('source', [sourceId]);
      this.db.sql.prepare('DELETE FROM source WHERE id = ?').run(sourceId);
      this.logEvent('source.purged', sourceId);
    });
  }

  /** Delete a note for good, with its blocks and history. */
  purgeNote(noteId: string): void {
    this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT status FROM note WHERE id = ?').get(noteId) as Row | undefined;
      if (!row) throw new NotFoundError('note');
      if (row.status === 'generating') throw new ConflictError('wait for the note to finish');
      this.db.sql.prepare("DELETE FROM search WHERE thread_id = ? AND kind IN ('note', 'block')").run(noteId);
      this.forgetItems('note', [noteId]);
      this.db.sql.prepare('DELETE FROM note WHERE id = ?').run(noteId);
      this.logEvent('note.purged', noteId);
    });
  }

  /** What only points at things deleted for good: their places in rooms, their links, their summaries. */
  private forgetItems(kind: 'thread' | 'source' | 'note', ids: string[]): void {
    const list = ids.map(() => '?').join(', ');
    this.db.sql.prepare(`DELETE FROM room_item WHERE kind = ? AND item_id IN (${list})`).run(kind, ...ids);
    this.db.sql
      .prepare(`DELETE FROM item_link WHERE (from_kind = ? AND from_id IN (${list})) OR (to_kind = ? AND to_id IN (${list}))`)
      .run(kind, ...ids, kind, ...ids);
    this.db.sql.prepare(`DELETE FROM gist WHERE kind = ? AND item_id IN (${list})`).run(kind, ...ids);
    // What the concept reading read of it, and where it mentions concepts (ADR 0037).
    this.db.sql.prepare(`DELETE FROM concept_piece WHERE kind = ? AND item_id IN (${list})`).run(kind, ...ids);
    this.db.sql.prepare(`DELETE FROM concept_mention WHERE kind = ? AND item_id IN (${list})`).run(kind, ...ids);
  }

  /** What is in the Trash, last deleted first. */
  trash(notebookId: string): Trash {
    const threads = this.db.sql
      .prepare(
        `SELECT t.id, t.title, t.deleted_at, (SELECT count(*) FROM thread w WHERE w.deleted_with = t.id) AS along
         FROM thread t WHERE t.notebook_id = ? AND t.deleted_at IS NOT NULL AND t.deleted_with IS NULL
         ORDER BY t.deleted_at DESC`,
      )
      .all(notebookId) as Row[];
    const notes = this.db.sql
      .prepare('SELECT id, title, deleted_at FROM note WHERE notebook_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(notebookId) as Row[];
    const sources = this.db.sql
      .prepare(
        'SELECT id, title, deleted_at FROM source WHERE notebook_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
      )
      .all(notebookId) as Row[];
    return {
      threads: threads.map((r) => ({
        threadId: r.id as string,
        title: r.title as string,
        deletedAt: r.deleted_at as string,
        sideQuestions: r.along as number,
      })),
      notes: notes.map((r) => ({ noteId: r.id as string, title: r.title as string, deletedAt: r.deleted_at as string })),
      sources: sources.map((r) => ({
        sourceId: r.id as string,
        title: r.title as string,
        deletedAt: r.deleted_at as string,
      })),
    };
  }

  // New thread from here ------------------------------------------------------
  //
  // A thread that drifted into a second subject is cut at a question: that
  // question and everything after it move into a new thread. Nothing is
  // copied or rewritten. Messages keep their ids, revisions and anchors; only
  // the thread they belong to and their place in it change, and everything
  // that points at them by thread follows: side questions asked from them,
  // merges accepted after the cut, citations in notes and merges, the search
  // index. The new thread is its own: it does not send the earlier
  // conversation to the model. Joining back undoes it exactly.

  /** Split `threadId` at the question `messageId` into the new thread `newId`. Idempotent on newId. */
  splitOff(threadId: string, messageId: string, newId: string): { thread: Thread; created: boolean } {
    return this.db.tx(() => {
      const done = this.getThread(newId);
      if (done) {
        if (done.continuedFromId !== threadId) throw new ConflictError('thread id already used');
        return { thread: done, created: false };
      }
      const thread = this.getThread(threadId);
      if (!thread) throw new NotFoundError('thread');
      const q = this.db.sql
        .prepare('SELECT m.id, m.role, m.seq FROM message m WHERE m.id = ? AND m.thread_id = ?')
        .get(messageId, threadId) as Row | undefined;
      if (!q) throw new InvalidError('no such question in this thread');
      if (q.role !== 'user') throw new InvalidError('a thread is split at a question, not an answer');
      if ((q.seq as number) === 0) throw new InvalidError('that is the first question: the whole thread would move');
      this.notInTrash(threadId);
      if (this.hasLiveAnswer(threadId)) throw new ConflictError('wait for the answer to finish');
      const at = q.seq as number;
      const first = this.getMessage(messageId) as Message;
      const t = now();
      const title = titleFrom(first.content);
      this.db.sql
        .prepare(
          `INSERT INTO thread (id, notebook_id, title, title_source, continued_from, continued_at_seq, created_at, updated_at)
           VALUES (?, ?, ?, 'question', ?, ?, ?, ?)`,
        )
        .run(newId, thread.notebookId, title, threadId, at, t, t);
      const moved = this.moveMessages(threadId, newId, at, -at);
      // Side questions asked from the moved messages go with them.
      this.db.sql
        .prepare(
          `UPDATE thread SET parent_thread_id = ? WHERE parent_thread_id = ? AND origin_anchor_id IN (
             SELECT a.id FROM anchor a JOIN message m ON m.id = a.message_id WHERE m.thread_id = ?)`,
        )
        .run(newId, threadId, newId);
      // Merges accepted after the cut were shown, and carried, in the part that moved.
      this.db.sql
        .prepare(
          `UPDATE thread_merge SET target_thread_id = ?, after_seq = after_seq - ?
           WHERE target_thread_id = ? AND after_seq IS NOT NULL AND after_seq >= ?`,
        )
        .run(newId, at, threadId, at);
      // Threads split off earlier from the part that moved now continue from the new thread.
      this.db.sql
        .prepare(
          `UPDATE thread SET continued_from = ?, continued_at_seq = continued_at_seq - ?
           WHERE continued_from = ? AND continued_at_seq >= ? AND id <> ?`,
        )
        .run(newId, at, threadId, at, newId);
      this.repointRefs(moved, newId);
      this.index('thread', newId, newId, title);
      this.db.sql.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(t, threadId);
      this.logEvent('thread.split_off', threadId, { into: newId, atSeq: at, messages: moved.size });
      return { thread: this.getThread(newId) as Thread, created: true };
    });
  }

  /** Why a split-off thread can't join back now, or null if it can. */
  private joinBackBlocked(id: string): string | null {
    const row = this.db.sql
      .prepare(
        `SELECT t.continued_from, t.continued_at_seq, o.title AS original_title FROM thread t
         LEFT JOIN thread o ON o.id = t.continued_from WHERE t.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row?.continued_from) return 'This thread was not split off from another.';
    const original = row.continued_from as string;
    const name = `“${shorten((row.original_title as string) || 'Untitled', 60)}”`;
    const last = this.lastMessage(original);
    if (last && last.seq >= (row.continued_at_seq as number)) {
      return `${name} has new questions since this was split off. Merge it instead.`;
    }
    const linked = this.db.sql
      .prepare(
        `SELECT 1 FROM thread_merge WHERE status NOT IN ('undone', 'discarded')
           AND ((source_thread_id = ? AND target_thread_id = ?) OR (source_thread_id = ? AND target_thread_id = ?))`,
      )
      .get(id, original, original, id);
    if (linked) return `It has a merge with ${name}. Undo or cancel that first.`;
    if (this.hasLiveAnswer(id) || this.hasLiveAnswer(original)) return 'Wait for the answer to finish.';
    return null;
  }

  /** Put a split-off thread's questions back where they were, and remove it. Returns the original thread. */
  joinBack(id: string): Thread {
    return this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT continued_from, continued_at_seq FROM thread WHERE id = ?').get(id) as
        | Row
        | undefined;
      if (!row) throw new NotFoundError('thread');
      const blocked = this.joinBackBlocked(id);
      if (blocked) {
        if (!row.continued_from) throw new InvalidError(blocked);
        throw new ConflictError(blocked);
      }
      const original = row.continued_from as string;
      const at = row.continued_at_seq as number;
      const moved = this.moveMessages(id, original, 0, at);
      this.db.sql.prepare('UPDATE thread SET parent_thread_id = ? WHERE parent_thread_id = ?').run(original, id);
      this.db.sql
        .prepare(
          'UPDATE thread_merge SET target_thread_id = ?, after_seq = after_seq + ? WHERE target_thread_id = ? AND after_seq IS NOT NULL',
        )
        .run(original, at, id);
      this.db.sql.prepare('UPDATE thread_merge SET target_thread_id = ? WHERE target_thread_id = ?').run(original, id);
      this.db.sql.prepare('UPDATE thread_merge SET source_thread_id = ? WHERE source_thread_id = ?').run(original, id);
      this.db.sql.prepare('UPDATE note SET thread_id = ? WHERE thread_id = ?').run(original, id);
      this.db.sql
        .prepare('UPDATE thread SET continued_from = ?, continued_at_seq = continued_at_seq + ? WHERE continued_from = ?')
        .run(original, at, id);
      this.repointRefs(moved, original);
      this.db.sql.prepare("DELETE FROM search WHERE kind = 'thread' AND target_id = ?").run(id);
      this.db.sql.prepare('DELETE FROM thread WHERE id = ?').run(id);
      this.db.sql.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(now(), original);
      this.logEvent('thread.joined_back', original, { from: id, messages: moved.size });
      return this.getThread(original) as Thread;
    });
  }

  /** Where a thread came from and where it continues, for the thread page. */
  continuationOf(threadId: string): { continuedFrom: ContinuedFrom | null; continuedIn: Continuation[] } {
    const row = this.db.sql
      .prepare('SELECT o.id, o.title FROM thread t JOIN thread o ON o.id = t.continued_from WHERE t.id = ?')
      .get(threadId) as Row | undefined;
    const blocked = row ? this.joinBackBlocked(threadId) : null;
    return {
      continuedFrom: row
        ? { threadId: row.id as string, title: row.title as string, canJoinBack: blocked === null, joinBackBlocked: blocked }
        : null,
      continuedIn: this.continuedIn(threadId),
    };
  }

  private continuedIn(threadId: string): Continuation[] {
    return (
      this.db.sql
        .prepare(
          'SELECT id, title FROM thread WHERE continued_from = ? AND deleted_at IS NULL ORDER BY continued_at_seq, created_at',
        )
        .all(threadId) as Row[]
    ).map((r) => ({ threadId: r.id as string, title: r.title as string }));
  }

  /**
   * Move a thread's messages from seq `from` on into another thread, shifting
   * their seq by `shift`, and keep the search index in step. Returns their ids.
   */
  private moveMessages(fromThread: string, toThread: string, from: number, shift: number): Set<string> {
    const rows = this.db.sql
      .prepare(
        `SELECT m.id, r.content, r.headline, r.status FROM message m JOIN message_revision r ON r.id = m.current_revision_id
         WHERE m.thread_id = ? AND m.seq >= ?`,
      )
      .all(fromThread, from) as Row[];
    this.db.sql
      .prepare('UPDATE message SET thread_id = ?, seq = seq + ? WHERE thread_id = ? AND seq >= ?')
      .run(toThread, shift, fromThread, from);
    for (const r of rows) {
      if (r.content) {
        this.index('message', r.id as string, toThread, messageText(r.content as string, r.headline as string | null));
      }
    }
    return new Set(rows.map((r) => r.id as string));
  }

  /** Citations (in notes, their versions, and merges) to these messages now name the thread they are in. */
  private repointRefs(messages: Set<string>, threadId: string): void {
    if (messages.size === 0) return;
    for (const table of ['note', 'note_revision', 'thread_merge']) {
      const rows = this.db.sql.prepare(`SELECT id, refs FROM ${table} WHERE refs <> '{}'`).all() as Row[];
      const update = this.db.sql.prepare(`UPDATE ${table} SET refs = ? WHERE id = ?`);
      for (const r of rows) {
        const refs = JSON.parse(r.refs as string) as Record<string, { threadId: string; messageId: string }>;
        let changed = false;
        for (const ref of Object.values(refs)) {
          if (messages.has(ref.messageId) && ref.threadId !== threadId) {
            ref.threadId = threadId;
            changed = true;
          }
        }
        if (changed) update.run(JSON.stringify(refs), r.id as string);
      }
    }
  }

  private isSplit(threadId: string): boolean {
    const row = this.db.sql.prepare('SELECT split_at FROM thread WHERE id = ?').get(threadId) as Row | undefined;
    return Boolean(row?.split_at);
  }

  // Merges ------------------------------------------------------------------

  private toMerge(r: Row): Merge {
    return {
      id: r.id as string,
      sourceThreadId: r.source_thread_id as string,
      targetThreadId: r.target_thread_id as string,
      sourceTitle: (r.source_title as string | null) ?? '',
      targetTitle: (r.target_title as string | null) ?? '',
      mode: r.mode as Merge['mode'],
      summary: r.summary as string,
      refs: JSON.parse(r.refs as string) as Merge['refs'],
      status: r.status as Merge['status'],
      error: (r.error as string | null) ?? null,
      afterMessageId: (r.after_message_id as string | null) ?? null,
      quote: null,
      anchor: null,
      replaces: null,
      createdAt: r.created_at as string,
      mergedAt: (r.merged_at as string | null) ?? null,
    };
  }

  private mergeRows(where: string, ...args: SQLInputValue[]): Merge[] {
    return (
      this.db.sql
        .prepare(
          `SELECT m.*, s.title AS source_title, t.title AS target_title FROM thread_merge m
           JOIN thread s ON s.id = m.source_thread_id JOIN thread t ON t.id = m.target_thread_id
           WHERE ${where} ORDER BY m.created_at`,
        )
        .all(...args) as Row[]
    ).map((r) => {
      const m = this.toMerge(r);
      const place = this.mergePlace(m.sourceThreadId, m.targetThreadId);
      const earlier =
        m.status === 'merged' || m.status === 'undone'
          ? null
          : (this.db.sql
              .prepare(
                "SELECT id FROM thread_merge WHERE source_thread_id = ? AND target_thread_id = ? AND status = 'merged' AND id <> ?",
              )
              .get(m.sourceThreadId, m.targetThreadId, m.id) as Row | undefined);
      return { ...m, quote: place.anchor?.exact ?? null, anchor: place.anchor, replaces: (earlier?.id as string) ?? null };
    });
  }

  getMerge(id: string): Merge | null {
    return this.mergeRows('m.id = ?', id)[0] ?? null;
  }

  /** Threads merged into this one, in the order they were merged. */
  mergesInto(threadId: string): Merge[] {
    return this.mergeRows("m.target_thread_id = ? AND m.status = 'merged'", threadId).sort((a, b) =>
      (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''),
    );
  }

  /** This thread's merges into others: an open draft, and merges done. */
  outgoingOf(threadId: string): Merge[] {
    return this.mergeRows("m.source_thread_id = ? AND m.status IN ('drafting', 'draft', 'failed', 'merged')", threadId);
  }

  /** Every thread below this one, split or not. */
  private descendantsOf(threadId: string): Set<string> {
    const out = new Set<string>();
    const stmt = this.db.sql.prepare('SELECT id FROM thread WHERE parent_thread_id = ?');
    const walk = (id: string) => {
      for (const r of stmt.all(id) as Row[]) {
        const child = r.id as string;
        if (out.has(child)) continue;
        out.add(child);
        walk(child);
      }
    };
    walk(threadId);
    return out;
  }

  /**
   * Where a merge shows when reading the target. A side question (of the
   * target, or of a side question below it) shows under the message it left
   * from, with its passage; anything else shows after the target's last
   * message at the time.
   */
  private mergePlace(sourceId: string, targetId: string): { messageId: string | null; anchor: AnchorRef | null } {
    let current = sourceId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const origin = this.originOf(current);
      if (!origin) break;
      if (origin.parentThreadId === targetId) return { messageId: origin.anchor.messageId, anchor: origin.anchor };
      current = origin.parentThreadId;
    }
    return { messageId: null, anchor: null };
  }

  private lastMessage(threadId: string): { id: string; seq: number } | null {
    const r = this.db.sql
      .prepare('SELECT id, seq FROM message WHERE thread_id = ? ORDER BY seq DESC LIMIT 1')
      .get(threadId) as Row | undefined;
    return r ? { id: r.id as string, seq: r.seq as number } : null;
  }

  private hasLiveAnswer(threadId: string): boolean {
    return Boolean(
      this.db.sql
        .prepare(
          `SELECT 1 FROM message m JOIN message_revision r ON r.id = m.current_revision_id
           WHERE m.thread_id = ? AND r.status IN ('pending', 'streaming')`,
        )
        .get(threadId),
    );
  }

  /**
   * Start merging `sourceId` into `targetId`. A summary is drafted by the
   * AI (the caller starts the writer); the whole exchange is ready at once.
   * An open draft of the same source is replaced. Idempotent on the id.
   */
  startMerge(
    id: string,
    sourceId: string,
    targetId: string,
    mode: Merge['mode'],
    full: () => { text: string; refs: Merge['refs'] },
  ): { merge: Merge; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getMerge(id);
      if (existing) return { merge: existing, created: false };
      if (!this.getThread(sourceId) || !this.getThread(targetId)) throw new NotFoundError('thread');
      this.notInTrash(sourceId);
      this.notInTrash(targetId);
      if (sourceId === targetId) throw new InvalidError('a thread cannot be merged into itself');
      if (this.descendantsOf(sourceId).has(targetId)) {
        throw new InvalidError('a side question already sees the conversation it came from; merge the other way');
      }
      if (this.hasLiveAnswer(sourceId)) throw new ConflictError('wait for the answer to finish');
      this.db.sql
        .prepare(
          "UPDATE thread_merge SET status = 'discarded' WHERE source_thread_id = ? AND status IN ('drafting', 'draft', 'failed')",
        )
        .run(sourceId);
      const draft = mode === 'full' ? full() : { text: '', refs: {} };
      this.db.sql
        .prepare(
          `INSERT INTO thread_merge (id, source_thread_id, target_thread_id, mode, summary, refs, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sourceId, targetId, mode, draft.text, JSON.stringify(draft.refs), mode === 'full' ? 'draft' : 'drafting', now());
      this.logEvent('merge.started', id, { sourceId, targetId, mode });
      return { merge: this.getMerge(id) as Merge, created: true };
    });
  }

  /** Draft it again, as a summary (the AI) or as the whole exchange. */
  redraftMerge(id: string, mode: Merge['mode'], full: () => { text: string; refs: Merge['refs'] }): Merge {
    return this.db.tx(() => {
      const m = this.getMerge(id);
      if (!m) throw new NotFoundError('merge');
      if (!['draft', 'failed'].includes(m.status)) throw new ConflictError('this merge cannot be drafted again now');
      if (this.hasLiveAnswer(m.sourceThreadId)) throw new ConflictError('wait for the answer to finish');
      const draft = mode === 'full' ? full() : { text: '', refs: m.refs };
      this.db.sql
        .prepare('UPDATE thread_merge SET mode = ?, summary = ?, refs = ?, status = ?, error = NULL WHERE id = ?')
        .run(mode, draft.text, JSON.stringify(draft.refs), mode === 'full' ? 'draft' : 'drafting', id);
      return this.getMerge(id) as Merge;
    });
  }

  saveMergeDraft(id: string, text: string): void {
    this.db.sql.prepare("UPDATE thread_merge SET summary = ? WHERE id = ? AND status = 'drafting'").run(text, id);
  }

  finishMergeDraft(id: string, text: string, refs: Merge['refs'], status: 'draft' | 'failed', error: string | null): void {
    this.db.sql
      .prepare("UPDATE thread_merge SET summary = ?, refs = ?, status = ?, error = ? WHERE id = ? AND status = 'drafting'")
      .run(text, JSON.stringify(refs), status, error, id);
  }

  /** The learner's edit of the draft. */
  editMerge(id: string, summary: string): Merge {
    const m = this.getMerge(id);
    if (!m) throw new NotFoundError('merge');
    if (!['draft', 'failed'].includes(m.status)) throw new ConflictError('only a draft can be edited');
    this.db.sql.prepare("UPDATE thread_merge SET summary = ?, status = 'draft', error = NULL WHERE id = ?").run(summary, id);
    return this.getMerge(id) as Merge;
  }

  /**
   * Accept the draft. From now on it goes in front of the target's next
   * question; what the target already said is not touched.
   */
  acceptMerge(id: string): Merge {
    return this.db.tx(() => {
      const m = this.getMerge(id);
      if (!m) throw new NotFoundError('merge');
      if (m.status !== 'draft' || m.summary.trim() === '') throw new ConflictError('there is no draft to merge');
      const last = this.lastMessage(m.targetThreadId);
      const place = this.mergePlace(m.sourceThreadId, m.targetThreadId);
      const t = now();
      // Merged again: the newer version replaces the earlier one, so the target never carries both.
      this.db.sql
        .prepare(
          `UPDATE thread_merge SET status = 'undone', undone_at = ?
           WHERE source_thread_id = ? AND target_thread_id = ? AND status = 'merged' AND id <> ?`,
        )
        .run(t, m.sourceThreadId, m.targetThreadId, id);
      this.db.sql
        .prepare(
          "UPDATE thread_merge SET status = 'merged', after_seq = ?, after_message_id = ?, merged_at = ? WHERE id = ?",
        )
        .run(last?.seq ?? -1, place.messageId ?? last?.id ?? null, t, id);
      this.db.sql.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(t, m.targetThreadId);
      this.logEvent('merge.merged', id, { sourceId: m.sourceThreadId, targetId: m.targetThreadId });
      return this.getMerge(id) as Merge;
    });
  }

  /** Stop carrying it: the target's next questions no longer include it. */
  undoMerge(id: string): Merge {
    const m = this.getMerge(id);
    if (!m) throw new NotFoundError('merge');
    if (m.status !== 'merged') throw new ConflictError('only a merge can be undone');
    this.db.sql.prepare("UPDATE thread_merge SET status = 'undone', undone_at = ? WHERE id = ?").run(now(), id);
    this.logEvent('merge.undone', id);
    return this.getMerge(id) as Merge;
  }

  discardMerge(id: string): Merge {
    const m = this.getMerge(id);
    if (!m) throw new NotFoundError('merge');
    if (m.status === 'merged' || m.status === 'undone') throw new ConflictError('use undo for a merge that is done');
    this.db.sql.prepare("UPDATE thread_merge SET status = 'discarded' WHERE id = ?").run(id);
    return this.getMerge(id) as Merge;
  }

  /** At boot: drafts being written were cut off. */
  failDraftingMerges(): number {
    const r = this.db.sql
      .prepare("UPDATE thread_merge SET status = 'failed', error = ? WHERE status = 'drafting'")
      .run('The server stopped before this was finished.');
    return Number(r.changes);
  }

  /**
   * Merged texts that apply to a question at `beforeSeq`, each with the
   * seq it was merged after.
   */
  private mergedBefore(threadId: string, beforeSeq: number): Array<{ afterSeq: number; text: MergedText }> {
    return (
      this.db.sql
        .prepare(
          `SELECT m.id, m.summary, m.after_seq, s.title FROM thread_merge m JOIN thread s ON s.id = m.source_thread_id
           WHERE m.target_thread_id = ? AND m.status = 'merged' AND m.after_seq < ? ORDER BY m.after_seq, m.merged_at`,
        )
        .all(threadId, beforeSeq) as Row[]
    ).map((r) => ({
      afterSeq: r.after_seq as number,
      text: { id: r.id as string, title: (r.title as string) || 'Untitled', text: r.summary as string },
    }));
  }

  /** Merged texts with no question after them yet: they go in front of the question being asked. */
  pendingMerges(threadId: string, beforeSeq: number): MergedText[] {
    const items = this.history(threadId, beforeSeq);
    const placed = new Set(items.flatMap((h) => (h.merged ?? []).map((m) => m.id)));
    return this.mergedBefore(threadId, beforeSeq)
      .map((m) => m.text)
      .filter((m) => !placed.has(m.id));
  }

  // Map ---------------------------------------------------------------------

  /** The outermost thread above this one, stopping at a thread made its own. */
  rootOf(threadId: string): string {
    const path = this.pathOf(threadId);
    return path[0]?.id ?? threadId;
  }

  /**
   * The map of one thread and every branch below it: each exchange in order
   * with the start of its answer, and every branch hung on the message it
   * left from. A branch made its own thread appears as a link only.
   */
  mapOf(threadId: string): ThreadMap {
    const build = (id: string, depth: number, isRoot: boolean): MapNode => {
      const thread = this.getThread(id);
      const origin = this.originOf(id);
      const node = {
        threadId: id,
        title: thread?.title ?? '',
        origin: origin ? { messageId: origin.anchor.messageId, exact: shorten(origin.anchor.exact, 200) } : null,
        split: !isRoot && Boolean(thread?.splitAt),
        mergedIntoId: thread?.mergedIntoId ?? null,
      };
      if (node.split) return { ...node, exchanges: [] };
      const messages = this.listMessages(id);
      const answers = new Map(messages.filter((m) => m.role === 'assistant').map((m) => [m.replyTo, m]));
      const byMessage = new Map<string, string[]>();
      for (const b of this.branchesOf(id)) {
        const list = byMessage.get(b.anchor.messageId) ?? [];
        list.push(b.threadId);
        byMessage.set(b.anchor.messageId, list);
      }
      const kids = (messageId: string | undefined) =>
        depth < 20 && messageId ? (byMessage.get(messageId) ?? []).map((b) => build(b, depth + 1, false)) : [];
      const exchanges: MapExchange[] = messages
        .filter((m) => m.role === 'user')
        .map((q, i) => {
          const a = answers.get(q.id);
          return {
            index: i + 1,
            questionId: q.id,
            question: shorten(q.content, 200),
            answerId: a?.id ?? null,
            headline: a?.headline ?? null,
            gist: a ? gistOf(a.content) : '',
            status: a?.status ?? q.status,
            branches: [...kids(q.id), ...kids(a?.id)],
          };
        });
      return { ...node, exchanges };
    };
    const origin = this.originOf(threadId);
    const { continuedFrom } = this.continuationOf(threadId);
    return {
      root: build(threadId, 0, true),
      path: this.pathOf(threadId).map((p) => ({ threadId: p.id, title: p.title })),
      parent: origin ? { threadId: origin.parentThreadId, title: origin.parentTitle } : null,
      continuedFrom: continuedFrom ? { threadId: continuedFrom.threadId, title: continuedFrom.title } : null,
      continuedIn: this.continuedIn(threadId),
    };
  }

  // Asked before ----------------------------------------------------------------

  /**
   * Every question in the notebook that is not in the Trash, oldest first,
   * as what it asked: its words, the passage it was asked about (a thread's
   * first question), its thread's title and its exchange's headline.
   */
  askedCandidates(notebookId: string): Array<AskedCandidate & { title: string; askedAt: string }> {
    const rows = this.db.sql
      .prepare(
        `SELECT m.id, m.thread_id, m.created_at, r.content AS question, t.title, ar.headline,
                CASE WHEN m.seq = (SELECT min(seq) FROM message WHERE thread_id = t.id)
                     THEN COALESCE(a.exact, sa.exact) END AS passage
         FROM message m
         JOIN message_revision r ON r.id = m.current_revision_id
         JOIN thread t ON t.id = m.thread_id
         LEFT JOIN message am ON am.reply_to = m.id
         LEFT JOIN message_revision ar ON ar.id = am.current_revision_id
         LEFT JOIN anchor a ON a.id = t.origin_anchor_id
         LEFT JOIN source_anchor sa ON sa.id = t.source_anchor_id
         WHERE t.notebook_id = ? AND t.deleted_at IS NULL AND t.kind = 'chat' AND m.role = 'user'
         ORDER BY m.created_at, m.rowid`,
      )
      .all(notebookId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      question: r.question as string,
      passage: r.passage ? (r.passage as string).slice(0, 2000) : null,
      title: (r.title as string | null) ?? '',
      headline: (r.headline as string | null) ?? null,
      askedAt: r.created_at as string,
    }));
  }

  /** A thread and the threads it came from, as a side question or split off. */
  lineage(threadId: string): string[] {
    const out: string[] = [];
    let id: string | null = threadId;
    while (id && !out.includes(id)) {
      out.push(id);
      const t = this.db.sql.prepare('SELECT parent_thread_id, continued_from FROM thread WHERE id = ?').get(id) as
        | Row
        | undefined;
      id = ((t?.parent_thread_id ?? t?.continued_from) as string | null | undefined) ?? null;
    }
    return out;
  }

  // Pins ----------------------------------------------------------------------

  /** Pin a passage to a thread. Idempotent on the pin's id. */
  createPin(
    threadId: string,
    pinId: string,
    at:
      | { message: { messageId: string; revisionId?: string | undefined; start: number; end: number } }
      | { source: { versionId: string; start: number; end: number } },
  ): { pin: Pin; created: boolean } {
    return this.db.tx(() => {
      const existing = this.db.sql.prepare('SELECT thread_id FROM pin WHERE id = ?').get(pinId) as Row | undefined;
      if (existing) {
        if (existing.thread_id !== threadId) throw new ConflictError('that pin id is already used');
        return { pin: this.pinById(pinId) as Pin, created: false };
      }
      const thread = this.getThread(threadId);
      if (!thread) throw new NotFoundError('thread');
      this.notInTrash(threadId);
      if (this.pinsFor(threadId).length >= MAX_PINS) {
        throw new InvalidError(`at most ${MAX_PINS} passages can be pinned here: unpin one first`);
      }
      const t = now();
      let anchorId: string | null = null;
      let sourceAnchorId: string | null = null;
      if ('message' in at) {
        const message = this.getMessage(at.message.messageId);
        if (!message) throw new InvalidError('no such message');
        const revision =
          at.message.revisionId && at.message.revisionId !== message.revisionId
            ? (this.db.sql
                .prepare('SELECT id, content, status FROM message_revision WHERE id = ? AND message_id = ?')
                .get(at.message.revisionId, message.id) as { id: string; content: string; status: MessageStatus } | undefined)
            : { id: message.revisionId, content: message.content, status: message.status };
        if (!revision) throw new InvalidError('that revision is not of this message');
        if (isLive(revision.status)) throw new ConflictError('wait for the answer to finish before pinning from it');
        let anchor: ReturnType<typeof createAnchor>;
        try {
          anchor = createAnchor(revision.id, revision.content, at.message.start, at.message.end);
        } catch {
          throw new InvalidError('the selected range is outside the message');
        }
        anchorId = ulid();
        this.db.sql
          .prepare(
            `INSERT INTO anchor (id, message_id, revision_id, exact, prefix, suffix, start_offset, end_offset, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            anchorId,
            message.id,
            revision.id,
            anchor.quote.exact,
            anchor.quote.prefix,
            anchor.quote.suffix,
            anchor.position.start,
            anchor.position.end,
            t,
          );
      } else {
        const version = this.db.sql
          .prepare(
            `SELECT v.id, v.content, s.deleted_at FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?`,
          )
          .get(at.source.versionId) as Row | undefined;
        if (!version) throw new InvalidError('no such version of a source');
        if (version.deleted_at) throw new ConflictError('that source is in the Trash: restore it first');
        let anchor: ReturnType<typeof createAnchor>;
        try {
          anchor = createAnchor(version.id as string, version.content as string, at.source.start, at.source.end);
        } catch {
          throw new InvalidError('the selected range is outside the text');
        }
        sourceAnchorId = ulid();
        this.db.sql
          .prepare(
            `INSERT INTO source_anchor (id, version_id, exact, prefix, suffix, start_offset, end_offset, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceAnchorId,
            version.id as string,
            anchor.quote.exact,
            anchor.quote.prefix,
            anchor.quote.suffix,
            anchor.position.start,
            anchor.position.end,
            t,
          );
      }
      this.db.sql
        .prepare('INSERT INTO pin (id, thread_id, anchor_id, source_anchor_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(pinId, threadId, anchorId, sourceAnchorId, t);
      this.logEvent('pin.added', threadId, { kind: anchorId ? 'message' : 'source' });
      return { pin: this.pinById(pinId) as Pin, created: true };
    });
  }

  /** Unpin. Returns the thread it was pinned to, or null if there was no such pin. */
  deletePin(pinId: string): string | null {
    return this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT thread_id FROM pin WHERE id = ?').get(pinId) as Row | undefined;
      if (!row) return null;
      this.notInTrash(row.thread_id as string);
      this.db.sql.prepare('DELETE FROM pin WHERE id = ?').run(pinId);
      this.logEvent('pin.removed', row.thread_id as string);
      return row.thread_id as string;
    });
  }

  private static readonly PIN_SELECT = `
    SELECT p.id, p.thread_id, p.created_at,
           a.message_id, a.revision_id, a.exact AS a_exact, a.start_offset AS a_start, a.end_offset AS a_end,
           m.thread_id AS m_thread, mt.title AS m_title,
           sa.version_id, sa.exact AS s_exact, sa.start_offset AS s_start, sa.end_offset AS s_end,
           sv.source_id, s.title AS s_title
    FROM pin p
    LEFT JOIN anchor a ON a.id = p.anchor_id
    LEFT JOIN message m ON m.id = a.message_id
    LEFT JOIN thread mt ON mt.id = m.thread_id
    LEFT JOIN source_anchor sa ON sa.id = p.source_anchor_id
    LEFT JOIN source_version sv ON sv.id = sa.version_id
    LEFT JOIN source s ON s.id = sv.source_id`;

  private toPin(r: Row): Pin {
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      exact: (r.a_exact ?? r.s_exact) as string,
      message: r.message_id
        ? {
            threadId: r.m_thread as string,
            threadTitle: (r.m_title as string | null) ?? '',
            messageId: r.message_id as string,
            revisionId: r.revision_id as string,
            start: r.a_start as number,
            end: r.a_end as number,
          }
        : null,
      source: r.version_id
        ? {
            sourceId: r.source_id as string,
            title: (r.s_title as string | null) ?? '',
            versionId: r.version_id as string,
            start: r.s_start as number,
            end: r.s_end as number,
          }
        : null,
      createdAt: r.created_at as string,
    };
  }

  private pinById(pinId: string): Pin | null {
    const r = this.db.sql.prepare(`${Repo.PIN_SELECT} WHERE p.id = ?`).get(pinId) as Row | undefined;
    return r ? this.toPin(r) : null;
  }

  /**
   * The passages pinned where a question in this thread is asked: those of
   * the threads it is a side question of (outermost first), then its own,
   * each oldest first. A side question made its own thread starts afresh.
   */
  pinsFor(threadId: string): Pin[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let id: string | null = threadId;
    while (id && !seen.has(id)) {
      seen.add(id);
      chain.unshift(id);
      const t = this.db.sql.prepare('SELECT parent_thread_id, split_at FROM thread WHERE id = ?').get(id) as
        | Row
        | undefined;
      id = t && t.split_at === null ? ((t.parent_thread_id as string | null) ?? null) : null;
    }
    const stmt = this.db.sql.prepare(`${Repo.PIN_SELECT} WHERE p.thread_id = ? ORDER BY p.created_at, p.rowid`);
    return chain.flatMap((t) => (stmt.all(t) as Row[]).map((r) => this.toPin(r)));
  }

  // Notes -------------------------------------------------------------------

  private blocksOf(noteId: string): NoteBlock[] {
    return (
      this.db.sql
        .prepare('SELECT * FROM note_block WHERE note_id = ? AND deleted_at IS NULL ORDER BY pos, created_at')
        .all(noteId) as Row[]
    ).map(toBlock);
  }

  private blockRow(noteId: string, blockId: string): Row | null {
    return (
      (this.db.sql.prepare('SELECT * FROM note_block WHERE id = ? AND note_id = ?').get(blockId, noteId) as Row | undefined) ??
      null
    );
  }

  getNote(id: string): Note | null {
    const row = this.db.sql.prepare('SELECT * FROM note WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    // While the AI writes the whole note, the page shows the text as it comes.
    return toNote(row, row.status === 'generating' ? [] : this.blocksOf(id));
  }

  listNotes(notebookId: string): Note[] {
    return (
      this.db.sql
        .prepare('SELECT * FROM note WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
        .all(notebookId) as Row[]
    ).map((r) => toNote(r, []));
  }

  /** Start an AI note for a thread. Idempotent on the note id. */
  startNote(id: string, notebookId: string, threadId: string, title: string): { note: Note; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getNote(id);
      if (existing) {
        if (existing.threadId !== threadId) throw new ConflictError('note id already used');
        return { note: existing, created: false };
      }
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO note (id, notebook_id, thread_id, title, content, status, author, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 'generating', 'ai', 0, ?, ?)`,
        )
        .run(id, notebookId, threadId, title, t, t);
      this.logEvent('note.requested', id, { threadId });
      return { note: this.getNote(id) as Note, created: true };
    });
  }

  /** A note the learner starts from nothing. Idempotent on the note id. */
  createNote(id: string, notebookId: string, title: string): { note: Note; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getNote(id);
      if (existing) return { note: existing, created: false };
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO note (id, notebook_id, thread_id, title, title_source, content, status, author, revision, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'user', '', 'done', 'user', 0, ?, ?)`,
        )
        .run(id, notebookId, title || 'Untitled note', t, t);
      this.logEvent('note.created', id);
      return { note: this.getNote(id) as Note, created: true };
    });
  }

  /** Write it again: the current version stays in the history. */
  restartNote(id: string): Note | null {
    const result = this.db.sql
      .prepare(
        `UPDATE note SET status = 'generating', content = '', error = NULL, updated_at = ?
         WHERE id = ? AND status <> 'generating' AND thread_id IS NOT NULL`,
      )
      .run(now(), id);
    if (Number(result.changes) > 0) this.logEvent('note.rewrite_requested', id);
    return this.getNote(id);
  }

  /** The labels the writer will cite, set before it starts so they work while the note streams in. */
  setNoteRefs(id: string, refs: Note['refs']): void {
    this.db.sql.prepare("UPDATE note SET refs = ? WHERE id = ? AND status = 'generating'").run(JSON.stringify(refs), id);
  }

  /** Add labels for exchanges the note did not cite before; existing labels keep their meaning. */
  mergeNoteRefs(id: string, refs: Note['refs']): void {
    this.db.tx(() => {
      const note = this.getNote(id);
      if (!note) return;
      const merged = { ...refs, ...note.refs };
      this.db.sql.prepare('UPDATE note SET refs = ? WHERE id = ?').run(JSON.stringify(merged), id);
    });
  }

  saveNoteContent(id: string, content: string): void {
    this.db.sql
      .prepare("UPDATE note SET content = ?, updated_at = ? WHERE id = ? AND status = 'generating'")
      .run(content, now(), id);
  }

  /**
   * The writer is done (or gave up). Done: the text becomes the note's
   * blocks, replacing earlier ones (they stay in the history). `title` is the
   * model's title; it replaces the thread's title, never one the learner
   * chose. Failed: a note that already had blocks keeps them; a new one keeps
   * the text that arrived.
   */
  finishNote(id: string, content: string, status: 'done' | 'failed', error: string | null, title?: string | null): void {
    this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT * FROM note WHERE id = ?').get(id) as Row | undefined;
      if (!row || row.status !== 'generating') return;
      const named = status === 'done' && Boolean(title) && row.title_source !== 'user';
      const name = named ? (title as string) : (row.title as string);
      const hadBlocks = this.blocksOf(id).length > 0;
      const t = now();
      this.db.sql
        .prepare(
          `UPDATE note SET title = ?, title_source = CASE WHEN ? THEN 'model' ELSE title_source END,
             status = ?, error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, named ? 1 : 0, status, error, t, id);
      if (status === 'done' || !hadBlocks) {
        if (status === 'done') this.db.sql.prepare('DELETE FROM note_block WHERE note_id = ?').run(id);
        splitBlocks(content).forEach((text, i) => {
          this.insertBlockRow(id, ulid(), i, text, 'ai', t);
        });
      }
      if (status === 'done') this.syncNote(id, 'ai', 'AI wrote the note');
      else this.syncNote(id, null, null);
      this.logEvent(`note.${status}`, id, { chars: content.length });
    });
  }

  /** Rename. The AI never renames a note the learner named. */
  renameNote(id: string, title: string): Note | null {
    return this.db.tx(() => {
      const note = this.getNote(id);
      if (!note) return null;
      if (title === note.title) return note;
      this.db.sql
        .prepare("UPDATE note SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?")
        .run(title, now(), id);
      this.syncNote(id, 'user', 'renamed the note');
      return this.getNote(id);
    });
  }

  /** To the Trash: hidden from the list and from search, kept as it is. */
  deleteNote(id: string): boolean {
    return this.db.tx(() => {
      const row = this.db.sql.prepare('SELECT status, deleted_at FROM note WHERE id = ?').get(id) as Row | undefined;
      if (!row) return false;
      if (row.status === 'generating') throw new ConflictError('wait for the note to finish');
      if (!row.deleted_at) {
        this.db.sql.prepare('UPDATE note SET deleted_at = ? WHERE id = ?').run(now(), id);
        this.logEvent('note.deleted', id);
      }
      return true;
    });
  }

  /** Back from the Trash, as it was. */
  restoreNote(id: string): Note {
    return this.db.tx(() => {
      const note = this.getNote(id);
      if (!note) throw new NotFoundError('note');
      if (note.deletedAt) {
        this.db.sql.prepare('UPDATE note SET deleted_at = NULL WHERE id = ?').run(id);
        this.logEvent('note.restored', id);
      }
      return this.getNote(id) as Note;
    });
  }

  private editable(noteId: string): Note {
    const note = this.getNote(noteId);
    if (!note) throw new NotFoundError('note');
    if (note.deletedAt) throw new ConflictError('this note is in the Trash: restore it first');
    if (note.status === 'generating') throw new ConflictError('wait for the note to finish before changing it');
    return note;
  }

  private insertBlockRow(noteId: string, id: string, pos: number, content: string, author: NoteBlock['author'], t: string): void {
    this.db.sql
      .prepare(
        'INSERT INTO note_block (id, note_id, pos, content, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, noteId, pos, content, author, t, t);
  }

  /** Every block of a note in order, deleted ones included, so positions stay stable for undo. */
  private allBlockIds(noteId: string): string[] {
    return (
      this.db.sql.prepare('SELECT id FROM note_block WHERE note_id = ? ORDER BY pos, created_at').all(noteId) as Row[]
    ).map((r) => r.id as string);
  }

  /**
   * Text that holds several blocks (a heading and its paragraph, two
   * paragraphs, a whole section from the AI) becomes that many blocks: the
   * first stays in `blockId`, the rest are new blocks right after it. The
   * caller has already written the first part. Returns the new block ids.
   */
  private spreadBlock(noteId: string, blockId: string, rest: string[], author: NoteBlock['author']): string[] {
    if (rest.length === 0) return [];
    const ids = this.allBlockIds(noteId);
    const t = now();
    const fresh = rest.map((content) => {
      const id = ulid();
      this.insertBlockRow(noteId, id, 0, content, author, t);
      return id;
    });
    ids.splice(ids.indexOf(blockId) + 1, 0, ...fresh);
    this.renumber(noteId, ids);
    return fresh;
  }

  private renumber(noteId: string, ids: string[]): void {
    const stmt = this.db.sql.prepare('UPDATE note_block SET pos = ? WHERE id = ? AND note_id = ?');
    ids.forEach((id, i) => {
      stmt.run(i, id, noteId);
    });
  }

  /**
   * Add a block after `after` (null: at the top). With `content`, the
   * learner's own text; with `ask`, an empty block whose AI suggestion the
   * caller then starts. Idempotent on the block id.
   */
  insertBlock(
    noteId: string,
    req: { id: string; after: string | null; content?: string | undefined; ask?: string | undefined },
  ): { block: NoteBlock; created: boolean } {
    return this.db.tx(() => {
      this.editable(noteId);
      const existing = this.blockRow(noteId, req.id);
      if (existing) return { block: toBlock(existing), created: false };
      if (this.db.sql.prepare('SELECT 1 FROM note_block WHERE id = ?').get(req.id)) throw new ConflictError('block id already used');
      const ids = this.allBlockIds(noteId);
      if (req.after !== null && !ids.includes(req.after)) throw new InvalidError('no such block in this note');
      const at = req.after === null ? 0 : ids.indexOf(req.after) + 1;
      const t = now();
      // Two paragraphs, or a heading and its text, written in one box become blocks of their own.
      const content = req.content ?? '';
      const [first = content, ...rest] = req.ask === undefined ? splitBlocks(content) : [];
      if (req.ask !== undefined) {
        this.insertBlockRow(noteId, req.id, at, '', 'ai', t);
        this.db.sql
          .prepare(
            "UPDATE note_block SET proposal = '', proposal_status = 'generating', proposal_instruction = ? WHERE id = ?",
          )
          .run(req.ask, req.id);
      } else {
        this.insertBlockRow(noteId, req.id, at, rest.length > 0 ? first : content, 'user', t);
      }
      ids.splice(at, 0, req.id);
      this.renumber(noteId, ids);
      this.spreadBlock(noteId, req.id, rest, 'user');
      if (req.ask === undefined) this.syncNote(noteId, 'user', 'wrote a block');
      else this.logEvent('note.block_asked', noteId, { blockId: req.id });
      return { block: toBlock(this.blockRow(noteId, req.id) as Row), created: true };
    });
  }

  /** The learner's edit. Clearing a block deletes it. */
  editBlock(noteId: string, blockId: string, content: string): Note {
    return this.db.tx(() => {
      this.editable(noteId);
      const row = this.blockRow(noteId, blockId);
      if (!row || row.deleted_at) throw new NotFoundError('block');
      if (content.trim() === '') return this.deleteBlock(noteId, blockId);
      if (content === row.content) return this.getNote(noteId) as Note;
      const author = row.author === 'user' && row.content !== '' ? 'user' : row.content === '' ? 'user' : 'ai+user';
      // Two paragraphs, or a heading and its text, written in one box become blocks of their own.
      const [first = content, ...rest] = splitBlocks(content);
      this.db.sql
        .prepare('UPDATE note_block SET content = ?, author = ?, updated_at = ? WHERE id = ?')
        .run(rest.length > 0 ? first : content, author, now(), blockId);
      this.spreadBlock(noteId, blockId, rest, 'user');
      this.syncNote(noteId, 'user', 'edited a block');
      return this.getNote(noteId) as Note;
    });
  }

  deleteBlock(noteId: string, blockId: string): Note {
    return this.db.tx(() => {
      this.editable(noteId);
      const row = this.blockRow(noteId, blockId);
      if (!row) throw new NotFoundError('block');
      if (!row.deleted_at) {
        this.db.sql.prepare('UPDATE note_block SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), blockId);
        this.syncNote(noteId, 'user', 'deleted a block');
      }
      return this.getNote(noteId) as Note;
    });
  }

  /** Undo a delete: the block comes back where it was. */
  restoreBlock(noteId: string, blockId: string): Note {
    return this.db.tx(() => {
      this.editable(noteId);
      const row = this.blockRow(noteId, blockId);
      if (!row) throw new NotFoundError('block');
      if (row.deleted_at) {
        this.db.sql.prepare('UPDATE note_block SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), blockId);
        this.syncNote(noteId, 'user', 'restored a block');
      }
      return this.getNote(noteId) as Note;
    });
  }

  /** Put a block after `after` (null: at the top). */
  moveBlock(noteId: string, blockId: string, after: string | null): Note {
    return this.db.tx(() => {
      this.editable(noteId);
      const ids = this.allBlockIds(noteId);
      if (!ids.includes(blockId) || (after !== null && !ids.includes(after)) || after === blockId) {
        throw new InvalidError('no such block in this note');
      }
      ids.splice(ids.indexOf(blockId), 1);
      ids.splice(after === null ? 0 : ids.indexOf(after) + 1, 0, blockId);
      this.renumber(noteId, ids);
      this.syncNote(noteId, 'user', 'moved a block');
      return this.getNote(noteId) as Note;
    });
  }

  /** Start an AI suggestion for a block. Refused while one is being written. */
  startProposal(noteId: string, blockId: string, instruction: string): NoteBlock {
    return this.db.tx(() => {
      this.editable(noteId);
      const row = this.blockRow(noteId, blockId);
      if (!row || row.deleted_at) throw new NotFoundError('block');
      if (row.proposal_status === 'generating') throw new ConflictError('a suggestion for this block is still being written');
      this.db.sql
        .prepare(
          `UPDATE note_block SET proposal = '', proposal_status = 'generating', proposal_instruction = ?,
             proposal_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(instruction, now(), blockId);
      this.logEvent('note.suggestion_requested', noteId, { blockId });
      return toBlock(this.blockRow(noteId, blockId) as Row);
    });
  }

  saveProposal(blockId: string, text: string): void {
    this.db.sql
      .prepare("UPDATE note_block SET proposal = ? WHERE id = ? AND proposal_status = 'generating'")
      .run(text, blockId);
  }

  finishProposal(blockId: string, text: string, status: 'ready' | 'failed', error: string | null): void {
    this.db.sql
      .prepare(
        `UPDATE note_block SET proposal = ?, proposal_status = ?, proposal_error = ?, updated_at = ?
         WHERE id = ? AND proposal_status = 'generating'`,
      )
      .run(text, status, error, now(), blockId);
  }

  /** The learner takes the suggestion: it replaces the block. */
  acceptProposal(noteId: string, blockId: string): Note {
    return this.db.tx(() => {
      this.editable(noteId);
      const row = this.blockRow(noteId, blockId);
      if (!row || row.deleted_at) throw new NotFoundError('block');
      const text = ((row.proposal as string | null) ?? '').trim();
      if (row.proposal_status === 'generating') throw new ConflictError('the suggestion is still being written');
      if (!text) throw new InvalidError('there is no suggestion to accept');
      const author = row.content === '' || row.author === 'ai' ? 'ai' : 'ai+user';
      // Reviewed as one suggestion; kept as blocks, so each paragraph or heading can be edited, moved or rewritten on its own.
      const [first = text, ...rest] = splitBlocks(text);
      this.db.sql
        .prepare(
          `UPDATE note_block SET content = ?, author = ?, proposal = NULL, proposal_status = NULL,
             proposal_instruction = NULL, proposal_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(first, author, now(), blockId);
      this.spreadBlock(noteId, blockId, rest, 'ai');
      const what = rest.length > 0 ? `${rest.length + 1} AI blocks` : 'an AI block';
      this.syncNote(noteId, 'ai', row.content === '' ? `added ${what}` : 'accepted an AI suggestion');
      return this.getNote(noteId) as Note;
    });
  }

  /** The learner drops the suggestion. A block that only held a suggestion goes away. */
  discardProposal(noteId: string, blockId: string): Note {
    return this.db.tx(() => {
      const row = this.blockRow(noteId, blockId);
      if (!row) throw new NotFoundError('block');
      if (row.content === '') this.db.sql.prepare('DELETE FROM note_block WHERE id = ?').run(blockId);
      else {
        this.db.sql
          .prepare(
            `UPDATE note_block SET proposal = NULL, proposal_status = NULL, proposal_instruction = NULL,
               proposal_error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now(), blockId);
      }
      return this.getNote(noteId) as Note;
    });
  }

  /**
   * Move blocks out into a new note: a section, or everything from one block
   * down. The new note keeps the thread and the citation labels. Idempotent
   * on the new note's id.
   */
  moveOut(noteId: string, newId: string, blockIds: string[]): { note: Note; created: boolean } {
    return this.db.tx(() => {
      const done = this.getNote(newId);
      if (done) return { note: done, created: false };
      const note = this.editable(noteId);
      const live = new Map(note.blocks.map((b) => [b.id, b]));
      const moving = note.blocks.filter((b) => blockIds.includes(b.id));
      if (moving.length !== new Set(blockIds).size || blockIds.some((id) => !live.has(id))) {
        throw new InvalidError('no such block in this note');
      }
      const first = moving[0]?.content ?? '';
      const heading = headingLevel(first) !== null ? first.replace(/^\s*#+\s*/, '').replace(/[\s#]+$/, '') : '';
      const title = shorten(heading.replace(/(\*\*|__|`)(.+?)\1/g, '$2'), 200) || `${note.title} (part)`;
      const t = now();
      this.db.sql
        .prepare(
          `INSERT INTO note (id, notebook_id, thread_id, title, title_source, content, refs, status, author, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'user', '', ?, 'done', 'user', 0, ?, ?)`,
        )
        .run(newId, note.notebookId, note.threadId, title, JSON.stringify(note.refs), t, t);
      const move = this.db.sql.prepare('UPDATE note_block SET note_id = ?, pos = ?, updated_at = ? WHERE id = ?');
      moving.forEach((b, i) => {
        move.run(newId, i, t, b.id);
      });
      this.syncNote(newId, 'user', `moved here from “${note.title}”`);
      this.syncNote(noteId, 'user', `moved ${moving.length} ${moving.length === 1 ? 'block' : 'blocks'} to “${title}”`);
      this.logEvent('note.split', noteId, { into: newId, blocks: moving.length });
      return { note: this.getNote(newId) as Note, created: true };
    });
  }

  /**
   * Bring every block of another note into this one, after `after` (null: at
   * the end), then remove the other note. Its citation labels are renumbered
   * where they clash, so each still opens the exchange it did.
   */
  mergeNote(targetId: string, fromId: string, after: string | null): Note {
    return this.db.tx(() => {
      if (targetId === fromId) throw new InvalidError('a note cannot be merged into itself');
      const target = this.editable(targetId);
      const from = this.editable(fromId);
      const ids = this.allBlockIds(targetId);
      if (after !== null && !target.blocks.some((b) => b.id === after)) throw new InvalidError('no such block in this note');

      // Labels: reuse the target's label for an exchange it already cites; keep a free label; else a new number.
      const refs = { ...target.refs };
      const byMessage = new Map(Object.entries(refs).map(([label, r]) => [r.messageId, label]));
      let next = Math.max(0, ...Object.keys(refs).map((l) => Number(l.slice(1)) || 0));
      const rename = new Map<string, string>();
      for (const [label, ref] of Object.entries(from.refs)) {
        const known = byMessage.get(ref.messageId);
        let to = known;
        if (!to) {
          to = refs[label] ? `E${++next}` : label;
          refs[to] = ref;
          byMessage.set(ref.messageId, to);
        }
        if (to !== label) rename.set(label, to);
      }
      const relabel = (text: string) => text.replace(/\[(E\d{1,4})\]/g, (whole, l: string) => (rename.has(l) ? `[${rename.get(l)}]` : whole));

      const moving = from.blocks.map((b) => b.id);
      const at = after === null ? ids.length : ids.indexOf(after) + 1;
      const t = now();
      const update = this.db.sql.prepare(
        'UPDATE note_block SET note_id = ?, content = ?, proposal = ?, updated_at = ? WHERE id = ?',
      );
      for (const b of from.blocks) {
        update.run(targetId, relabel(b.content), b.proposal ? relabel(b.proposal.text) : null, t, b.id);
      }
      ids.splice(at, 0, ...moving);
      this.renumber(targetId, ids);
      this.db.sql.prepare('UPDATE note SET refs = ? WHERE id = ?').run(JSON.stringify(refs), targetId);
      this.unindexNote(fromId);
      this.syncNote(targetId, 'user', `merged “${from.title}” into this note`);
      this.db.sql.prepare('DELETE FROM note WHERE id = ?').run(fromId);
      this.logEvent('note.merged', targetId, { from: fromId, blocks: moving.length, relabelled: rename.size });
      return this.getNote(targetId) as Note;
    });
  }

  /**
   * After a change: the note's text, its author (from its blocks) and a new
   * version with what changed. `who` null: no new version (a failed write).
   */
  private syncNote(noteId: string, who: 'ai' | 'user' | null, change: string | null): void {
    const row = this.db.sql.prepare('SELECT * FROM note WHERE id = ?').get(noteId) as Row;
    const blocks = this.blocksOf(noteId).filter((b) => b.content !== '');
    const content = joinBlocks(blocks.map((b) => b.content));
    const authors = new Set(blocks.map((b) => b.author));
    const author =
      authors.size === 0 ? (row.author as string) : authors.size === 1 ? (blocks[0] as NoteBlock).author : 'ai+user';
    const t = now();
    const n = who ? (row.revision as number) + 1 : (row.revision as number);
    this.db.sql
      .prepare('UPDATE note SET content = ?, author = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(content, author, n, t, noteId);
    this.indexNote(noteId);
    if (!who || !change) return;
    this.db.sql
      .prepare(
        `INSERT INTO note_revision (id, note_id, n, title, content, refs, author, change, blocks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        noteId,
        n,
        row.title as string,
        content,
        row.refs as string,
        who,
        change,
        JSON.stringify(blocks.map((b) => ({ id: b.id, content: b.content, author: b.author }))),
        t,
      );
  }

  noteHistory(id: string): Array<{ n: number; author: string; change: string; createdAt: string; chars: number }> {
    return (
      this.db.sql
        .prepare(
          'SELECT n, author, change, created_at, length(content) AS chars FROM note_revision WHERE note_id = ? ORDER BY n',
        )
        .all(id) as Row[]
    ).map((r) => ({
      n: r.n as number,
      author: r.author as string,
      change: r.change as string,
      createdAt: r.created_at as string,
      chars: r.chars as number,
    }));
  }

  /**
   * At boot: notes and suggestions still being written were cut off, and
   * notes from before blocks existed get their blocks.
   */
  recoverNotes(): { failed: number; blockified: number; spread: number } {
    const cut = 'The server stopped before this was finished.';
    const live = this.db.sql.prepare("SELECT id, content FROM note WHERE status = 'generating'").all() as Row[];
    for (const r of live) this.finishNote(r.id as string, r.content as string, 'failed', cut);
    this.db.sql
      .prepare("UPDATE note_block SET proposal_status = 'failed', proposal_error = ? WHERE proposal_status = 'generating'")
      .run(cut);
    const old = this.db.sql
      .prepare(
        `SELECT n.id, n.content, n.author FROM note n
         WHERE n.content <> '' AND NOT EXISTS (SELECT 1 FROM note_block b WHERE b.note_id = n.id)`,
      )
      .all() as Row[];
    for (const r of old) {
      this.db.tx(() => {
        const t = now();
        splitBlocks(r.content as string).forEach((text, i) => {
          this.insertBlockRow(r.id as string, ulid(), i, text, r.author as NoteBlock['author'], t);
        });
        this.syncNote(r.id as string, null, null);
      });
    }
    // Blocks written before text was kept one paragraph, heading or list to a block: split them now (once; afterwards none holds several).
    const several = (
      this.db.sql
        .prepare(
          `SELECT b.id, b.note_id, b.content, b.author FROM note_block b JOIN note n ON n.id = b.note_id
           WHERE b.deleted_at IS NULL AND n.status <> 'generating' AND instr(b.content, char(10)) > 0
           ORDER BY b.note_id, b.pos`,
        )
        .all() as Row[]
    ).filter((r) => splitBlocks(r.content as string).length > 1);
    const spread = new Set<string>();
    for (const r of several) {
      this.db.tx(() => {
        const [first = '', ...rest] = splitBlocks(r.content as string);
        this.db.sql.prepare('UPDATE note_block SET content = ? WHERE id = ?').run(first, r.id as string);
        this.spreadBlock(r.note_id as string, r.id as string, rest, r.author as NoteBlock['author']);
        this.syncNote(r.note_id as string, null, null);
      });
      spread.add(r.note_id as string);
    }
    return { failed: live.length, blockified: old.length, spread: spread.size };
  }

  // Branches ----------------------------------------------------------------

  /**
   * Open a branch from a passage of a message in `parentThreadId` and ask its
   * first question, in one transaction. The quote is computed here from the
   * stored revision, never taken from the client. Idempotent on the branch id.
   */
  createBranch(
    parentThreadId: string,
    threadId: string,
    at: { messageId: string; revisionId?: string | undefined; start: number; end: number },
    question: { id: string; content: string },
  ): { thread: Thread; pair: AskPair; created: boolean } {
    return this.db.tx(() => {
      const existing = this.getThread(threadId);
      if (existing) {
        if (existing.parentThreadId !== parentThreadId) throw new ConflictError('thread id already used');
        const { pair, created } = this.createAsk(threadId, question.id, question.content);
        return { thread: this.getThread(threadId) as Thread, pair, created };
      }
      const parent = this.getThread(parentThreadId);
      if (!parent) throw new InvalidError('parent thread not found');
      this.notInTrash(parentThreadId);
      const message = this.getMessage(at.messageId);
      if (!message || message.threadId !== parentThreadId) throw new InvalidError('that message is not in this thread');
      // The passage is in the revision shown: the one in use, or an earlier one read again.
      const revision = at.revisionId && at.revisionId !== message.revisionId
        ? (this.db.sql
            .prepare('SELECT id, content, status FROM message_revision WHERE id = ? AND message_id = ?')
            .get(at.revisionId, message.id) as { id: string; content: string; status: MessageStatus } | undefined)
        : { id: message.revisionId, content: message.content, status: message.status };
      if (!revision) throw new InvalidError('that revision is not of this message');
      if (isLive(revision.status)) throw new ConflictError('wait for the answer to finish before branching from it');
      let anchor: ReturnType<typeof createAnchor>;
      try {
        anchor = createAnchor(revision.id, revision.content, at.start, at.end);
      } catch {
        throw new InvalidError('the selected range is outside the message');
      }
      const t = now();
      const anchorId = ulid();
      this.db.sql
        .prepare(
          `INSERT INTO anchor (id, message_id, revision_id, exact, prefix, suffix, start_offset, end_offset, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          anchorId,
          message.id,
          revision.id,
          anchor.quote.exact,
          anchor.quote.prefix,
          anchor.quote.suffix,
          anchor.position.start,
          anchor.position.end,
          t,
        );
      this.db.sql
        .prepare(
          `INSERT INTO thread (id, notebook_id, parent_thread_id, origin_anchor_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
        )
        .run(threadId, parent.notebookId, parentThreadId, anchorId, t, t);
      this.db.sql.prepare('UPDATE thread SET updated_at = ? WHERE id = ?').run(t, parentThreadId);
      this.logEvent('branch.opened', threadId, {
        parentThreadId,
        messageId: message.id,
        chars: anchor.quote.exact.length,
      });
      const { pair } = this.createAsk(threadId, question.id, question.content);
      return { thread: this.getThread(threadId) as Thread, pair, created: true };
    });
  }

  /** Branches that start in this thread's messages, oldest first. */
  branchesOf(threadId: string): BranchSummary[] {
    const rows = this.db.sql
      .prepare(
        `SELECT t.id AS thread_id, t.title, t.created_at AS thread_created_at, a.*
         FROM thread t JOIN anchor a ON a.id = t.origin_anchor_id
         WHERE t.parent_thread_id = ? AND t.deleted_at IS NULL ORDER BY t.created_at`,
      )
      .all(threadId) as Row[];
    return rows.map((r) => ({
      threadId: r.thread_id as string,
      title: r.title as string,
      createdAt: r.thread_created_at as string,
      anchor: toAnchor(r),
    }));
  }

  originOf(threadId: string): Origin | null {
    const row = this.db.sql
      .prepare(
        `SELECT p.id AS parent_id, p.title AS parent_title, a.*
         FROM thread t JOIN anchor a ON a.id = t.origin_anchor_id JOIN thread p ON p.id = t.parent_thread_id
         WHERE t.id = ?`,
      )
      .get(threadId) as Row | undefined;
    return row
      ? { parentThreadId: row.parent_id as string, parentTitle: row.parent_title as string, anchor: toAnchor(row) }
      : null;
  }

  /** Ancestors of a thread, outermost first. */
  pathOf(threadId: string): Array<{ id: string; title: string }> {
    const path: Array<{ id: string; title: string }> = [];
    let current = this.getThread(threadId);
    const seen = new Set<string>();
    // A thread made its own is the top of its own path.
    while (current?.parentThreadId && !current.splitAt && !seen.has(current.parentThreadId)) {
      seen.add(current.parentThreadId);
      const parent = this.getThread(current.parentThreadId);
      if (!parent) break;
      path.unshift({ id: parent.id, title: parent.title });
      current = parent;
    }
    return path;
  }

  /**
   * What a branch inherits: the visible conversation of every ancestor up to
   * the point where the branch left (the answer containing the passage, or
   * the question and its answer). Later messages of the parent are not
   * included: the branch was asked before they existed.
   */
  inheritedHistory(threadId: string): HistoryItem[] {
    // A branch made its own thread keeps only its passage, not the parent conversation.
    if (this.isSplit(threadId)) return [];
    const origin = this.originOf(threadId);
    if (!origin) return [];
    const at = this.getMessage(origin.anchor.messageId);
    if (!at) return this.inheritedHistory(origin.parentThreadId);
    const through = at.role === 'assistant' ? at.seq : at.seq + 1;
    // The answer the passage is in, as the revision it was asked from, even if it was asked again since.
    const pinned = { messageId: origin.anchor.messageId, revisionId: origin.anchor.revisionId };
    return [...this.inheritedHistory(origin.parentThreadId), ...this.history(origin.parentThreadId, through + 1, pinned)];
  }

  /**
   * The finished conversation before `beforeSeq`, as question/answer pairs
   * only. A thread merged in goes in front of the first question after the
   * merge (see pendingMerges for one with no question after it yet).
   */
  history(
    threadId: string,
    beforeSeq: number,
    pinned: { messageId: string; revisionId: string } | null = null,
  ): HistoryItem[] {
    // Each answer as its current revision, except a pinned one (the answer a side question was asked from).
    const rows = this.db.sql
      .prepare(
        `SELECT u.id AS uid, u.seq AS useq, ur.content AS ucontent, a.id AS aid, ar.content AS acontent
         FROM message a
         JOIN message_revision ar ON ar.id = CASE WHEN a.id = ? THEN ? ELSE a.current_revision_id END
         JOIN message u ON u.id = a.reply_to
         JOIN message_revision ur ON ur.id = u.current_revision_id
         WHERE a.thread_id = ? AND a.role = 'assistant' AND a.seq < ?
           AND ar.status IN ('done', 'stopped') AND ar.content <> ''
         ORDER BY a.seq`,
      )
      .all(pinned?.messageId ?? null, pinned?.revisionId ?? null, threadId, beforeSeq) as Row[];
    const merges = this.mergedBefore(threadId, beforeSeq);
    return rows.flatMap((r) => {
      const useq = r.useq as number;
      const here = merges.filter((m) => m.afterSeq < useq).map((m) => m.text);
      merges.splice(0, here.length);
      const user: HistoryItem = { id: r.uid as string, role: 'user', content: r.ucontent as string };
      if (here.length > 0) user.merged = here;
      return [user, { id: r.aid as string, role: 'assistant' as const, content: r.acontent as string }];
    });
  }

  /** The model's line for a finished answer. Only the current, finished revision takes it. */
  setHeadline(revisionId: string, headline: string): boolean {
    return this.db.tx(() => {
      const r = this.db.sql
        .prepare("UPDATE message_revision SET headline = ? WHERE id = ? AND status = 'done'")
        .run(headline, revisionId);
      if (Number(r.changes) === 0) return false;
      // The line is searchable with its answer (it may say in other words what the answer says).
      const m = this.db.sql
        .prepare(
          `SELECT m.id, m.thread_id, r.content FROM message_revision r JOIN message m ON m.current_revision_id = r.id
           WHERE r.id = ?`,
        )
        .get(revisionId) as Row | undefined;
      if (m) this.index('message', m.id as string, m.thread_id as string, messageText(m.content as string, headline));
      return true;
    });
  }

  /** Finished answers without a headline yet, oldest first. */
  unheadlined(limit: number): string[] {
    return (
      this.db.sql
        .prepare(
          `SELECT m.id FROM message m JOIN message_revision r ON r.id = m.current_revision_id
           WHERE m.role = 'assistant' AND r.status = 'done' AND r.content <> '' AND r.headline IS NULL
           ORDER BY m.created_at LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((row) => row.id as string);
  }

  revisionStatus(revisionId: string): MessageStatus | null {
    const row = this.db.sql.prepare('SELECT status FROM message_revision WHERE id = ?').get(revisionId) as
      | { status: MessageStatus }
      | undefined;
    return row?.status ?? null;
  }

  markStreaming(revisionId: string, model: string): void {
    this.db.sql
      .prepare(
        "UPDATE message_revision SET status = 'streaming', model = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(model, now(), revisionId);
  }

  /** Save partial text while streaming, so a crash loses at most one flush interval. */
  saveContent(revisionId: string, content: string): void {
    this.db.sql
      .prepare(
        "UPDATE message_revision SET content = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'streaming')",
      )
      .run(content, now(), revisionId);
  }

  /** Write the final text and status together. Does nothing if the revision is already terminal. */
  finishRevision(
    revisionId: string,
    content: string,
    status: 'done' | 'failed' | 'stopped' | 'interrupted',
    error: MessageError | null,
  ): boolean {
    return this.db.tx(() => {
      const result = this.db.sql
        .prepare(
          `UPDATE message_revision SET content = ?, status = ?, error_kind = ?, error_message = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'streaming')`,
        )
        .run(content, status, error?.kind ?? null, error?.message ?? null, now(), revisionId);
      if (Number(result.changes) === 0) return false;
      const msg = this.db.sql
        .prepare(
          'SELECT m.id, m.thread_id FROM message m JOIN message_revision r ON r.message_id = m.id WHERE r.id = ?',
        )
        .get(revisionId) as { id: string; thread_id: string };
      if (content) this.index('message', msg.id, msg.thread_id, content);
      this.logEvent(`answer.${status}`, msg.id, error ? { kind: error.kind } : {});
      return true;
    });
  }

  /**
   * At boot, nothing is generating. Anything still pending or streaming was
   * cut off by a crash or restart: keep its text and say so.
   */
  interruptLive(): number {
    return this.db.tx(() => {
      const live = this.db.sql
        .prepare("SELECT r.id FROM message_revision r WHERE r.status IN ('pending', 'streaming')")
        .all() as Array<{ id: string }>;
      for (const { id } of live) {
        const row = this.db.sql.prepare('SELECT content FROM message_revision WHERE id = ?').get(id) as {
          content: string;
        };
        this.finishRevision(id, row.content, 'interrupted', null);
      }
      return live.length;
    });
  }

  liveRevisionIds(): string[] {
    return (
      this.db.sql.prepare("SELECT id FROM message_revision WHERE status IN ('pending', 'streaming')").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  }

  // Model calls -------------------------------------------------------------

  startModelCall(start: ModelCallStart): string {
    const id = ulid();
    this.db.sql
      .prepare(
        'INSERT INTO model_call (id, revision_id, provider, model, started_at, manifest, request) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        start.revisionId,
        start.provider,
        start.model,
        now(),
        JSON.stringify(start.manifest),
        JSON.stringify(start.request),
      );
    return id;
  }

  endModelCall(id: string, end: ModelCallEnd): void {
    this.db.sql
      .prepare(
        `UPDATE model_call SET finished_at = ?, attempts = ?, first_token_at = ?, prompt_tokens = ?, completion_tokens = ?,
           cache_hit_tokens = ?, cache_miss_tokens = ?, finish_reason = ?, error_kind = ? WHERE id = ?`,
      )
      .run(
        now(),
        end.attempts,
        end.firstTokenAt,
        end.promptTokens ?? null,
        end.completionTokens ?? null,
        end.cacheHitTokens ?? null,
        end.cacheMissTokens ?? null,
        end.finishReason ?? null,
        end.errorKind ?? null,
        id,
      );
  }

  /** What was sent for an answer: its latest model call, with the exact messages when they were recorded. */
  contextOf(messageId: string, revisionId?: string): MessageContext | null {
    const message = this.getMessage(messageId);
    if (!message || message.role !== 'assistant') return null;
    const revision = revisionId ?? message.revisionId;
    const row = this.db.sql
      .prepare(
        `SELECT mc.* FROM model_call mc JOIN message_revision r ON r.id = mc.revision_id
         WHERE mc.revision_id = ? AND r.message_id = ? ORDER BY mc.started_at DESC, mc.rowid DESC LIMIT 1`,
      )
      .get(revision, messageId) as Row | undefined;
    if (!row) return null;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return {
      messageId,
      revisionId: revision,
      provider: row.provider as string,
      model: row.model as string,
      startedAt: row.started_at as string,
      finishReason: (row.finish_reason as string | null) ?? null,
      usage: {
        promptTokens: num(row.prompt_tokens),
        completionTokens: num(row.completion_tokens),
        cacheHitTokens: num(row.cache_hit_tokens),
        cacheMissTokens: num(row.cache_miss_tokens),
      },
      manifest: JSON.parse(row.manifest as string),
      request: row.request ? JSON.parse(row.request as string) : null,
    };
  }

  modelCallsFor(revisionId: string): Row[] {
    return this.db.sql
      .prepare('SELECT * FROM model_call WHERE revision_id = ? ORDER BY started_at')
      .all(revisionId) as Row[];
  }

  // Search ------------------------------------------------------------------
  //
  // One FTS5 table for everything. Rows: kind 'thread' (a title), 'message'
  // (a question, or an answer with its headline), 'note' (a note's title) and
  // 'block' (a block of a note). `thread_id` holds the owner: the thread, or
  // for 'note' and 'block' rows, the note.

  private index(kind: SearchKind, targetId: string, ownerId: string, text: string): void {
    this.db.sql.prepare('DELETE FROM search WHERE target_id = ? AND kind = ?').run(targetId, kind);
    this.insertIndex(kind, targetId, ownerId, text);
  }

  private insertIndex(kind: SearchKind, targetId: string, ownerId: string, text: string): void {
    const body = searchText(text);
    if (!body) return;
    this.db.sql
      .prepare('INSERT INTO search (body, kind, target_id, thread_id) VALUES (?, ?, ?, ?)')
      .run(body, kind, targetId, ownerId);
  }

  private unindexNote(noteId: string): void {
    this.db.sql.prepare("DELETE FROM search WHERE thread_id = ? AND kind IN ('note', 'block')").run(noteId);
  }

  /** A note's title and blocks, as they are now. Called on every change (syncNote). */
  private indexNote(noteId: string): void {
    this.unindexNote(noteId);
    const row = this.db.sql.prepare('SELECT title FROM note WHERE id = ?').get(noteId) as Row | undefined;
    if (!row) return;
    this.insertIndex('note', noteId, noteId, row.title as string);
    for (const b of this.blocksOf(noteId)) {
      if (b.content) this.insertIndex('block', b.id, noteId, plainText(b.content));
    }
  }

  /**
   * Build the whole index again from what is stored. At start-up when the
   * index is older than this code (SEARCH_INDEX_VERSION), so notebooks from
   * before notes or headlines were searchable find them too.
   */
  rebuildSearch(): { rows: number } {
    return this.db.tx(() => {
      this.db.sql.exec('DELETE FROM search');
      const threads = this.db.sql.prepare("SELECT id, title FROM thread WHERE title <> ''").all() as Row[];
      for (const t of threads) this.insertIndex('thread', t.id as string, t.id as string, t.title as string);
      const messages = this.db.sql
        .prepare(
          `SELECT m.id, m.thread_id, r.content, r.headline FROM message m
           JOIN message_revision r ON r.id = m.current_revision_id
           WHERE r.content <> '' AND r.status NOT IN ('pending', 'streaming')`,
        )
        .all() as Row[];
      for (const m of messages) {
        this.insertIndex(
          'message',
          m.id as string,
          m.thread_id as string,
          messageText(m.content as string, m.headline as string | null),
        );
      }
      const notes = this.db.sql.prepare('SELECT id FROM note').all() as Row[];
      for (const n of notes) this.indexNote(n.id as string);
      const sources = this.db.sql.prepare('SELECT id FROM source').all() as Row[];
      for (const r of sources) this.indexSource(r.id as string);
      this.db.sql
        .prepare("INSERT INTO meta (key, value) VALUES ('search_index', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SEARCH_INDEX_VERSION));
      const count = this.db.sql.prepare('SELECT count(*) AS n FROM search').get() as { n: number };
      return { rows: count.n };
    });
  }

  /** Rebuild the index if it was built by older code. Returns whether it did. */
  ensureSearchIndex(): boolean {
    const row = this.db.sql.prepare("SELECT value FROM meta WHERE key = 'search_index'").get() as Row | undefined;
    if (row?.value === String(SEARCH_INDEX_VERSION)) return false;
    this.rebuildSearch();
    return true;
  }

  search(query: string, limit = 30, options: { any?: boolean } = {}): { terms: string[]; hits: SearchHit[] } {
    const { terms } = parseQuery(query);
    const match = ftsQuery(query, options);
    if (!match) return { terms, hits: [] };
    const rows = this.db.sql
      .prepare('SELECT kind, target_id, thread_id FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?')
      .all(match, limit * 2) as Array<{ kind: SearchKind; target_id: string; thread_id: string }>;
    const hits: SearchHit[] = [];
    const paths = new Map<string, Array<{ threadId: string; title: string }>>();
    const pathTo = (threadId: string) => {
      let p = paths.get(threadId);
      if (!p) {
        p = this.pathOf(threadId).map((x) => ({ threadId: x.id, title: x.title }));
        paths.set(threadId, p);
      }
      return p;
    };
    const none = {
      threadId: null,
      messageId: null,
      noteId: null,
      blockId: null,
      sourceId: null,
      versionId: null,
      offset: null,
      role: null,
      headline: null,
    };
    for (const r of rows) {
      if (r.kind === 'thread' || r.kind === 'message') {
        const thread = this.getThread(r.thread_id);
        if (!thread || thread.deletedAt) continue;
        if (r.kind === 'thread') {
          hits.push({
            ...none,
            kind: 'thread',
            threadId: thread.id,
            title: thread.title,
            path: pathTo(thread.id),
            at: thread.updatedAt,
            ...snippetFields(makeSnippet(thread.title, query)),
          });
          continue;
        }
        const m = this.getMessage(r.target_id);
        if (!m || isLive(m.status)) continue;
        let s = makeSnippet(plainText(m.content), query);
        if (s.matches.length === 0 && m.headline) s = makeSnippet(m.headline, query);
        hits.push({
          ...none,
          kind: 'message',
          threadId: thread.id,
          messageId: m.id,
          role: m.role,
          title: thread.title,
          path: pathTo(thread.id),
          headline: m.role === 'assistant' ? m.headline : null,
          at: m.createdAt,
          ...snippetFields(s),
        });
      } else if (r.kind === 'source' || r.kind === 'passage') {
        const src = this.getSource(r.thread_id);
        if (!src || src.deletedAt) continue;
        const base = { ...none, sourceId: src.id, versionId: src.latestVersionId, title: src.title, path: [], at: src.updatedAt };
        if (r.kind === 'source') {
          hits.push({ ...base, kind: 'source', offset: 0, ...snippetFields(makeSnippet(src.title, query)) });
          continue;
        }
        const [versionId, at] = r.target_id.split(':');
        if (versionId !== src.latestVersionId) continue;
        const v = this.db.sql.prepare('SELECT content FROM source_version WHERE id = ?').get(versionId) as Row | undefined;
        const start = Number(at);
        const block = v ? sourceBlocks(v.content as string).find((b) => b.start === start) : undefined;
        if (!block) continue;
        hits.push({
          ...base,
          kind: 'passage',
          offset: start,
          ...snippetFields(makeSnippet(plainText(block.text), query)),
        });
      } else {
        const note = this.db.sql
          .prepare('SELECT id, title, updated_at FROM note WHERE id = ? AND deleted_at IS NULL')
          .get(r.thread_id) as Row | undefined;
        if (!note) continue;
        const base = { ...none, noteId: note.id as string, title: note.title as string, path: [], at: note.updated_at as string };
        if (r.kind === 'note') {
          hits.push({ ...base, kind: 'note', ...snippetFields(makeSnippet(note.title as string, query)) });
          continue;
        }
        const block = this.blockRow(note.id as string, r.target_id);
        if (!block || block.deleted_at !== null) continue;
        hits.push({
          ...base,
          kind: 'block',
          blockId: block.id as string,
          at: block.updated_at as string,
          ...snippetFields(makeSnippet(plainText(block.content as string), query)),
        });
      }
    }
    // A title is only worth its own line when nothing inside matched.
    const ownerOf = (h: SearchHit) => h.threadId ?? h.noteId ?? h.sourceId;
    const inside = new Set(
      hits.filter((h) => h.kind === 'message' || h.kind === 'block' || h.kind === 'passage').map(ownerOf),
    );
    return {
      terms,
      hits: hits
        .filter((h) => !((h.kind === 'thread' || h.kind === 'note' || h.kind === 'source') && inside.has(ownerOf(h))))
        .slice(0, limit),
    };
  }

  // Coming back ---------------------------------------------------------------

  /**
   * Side questions you never came back from: a side question with an answer,
   * not made its own thread and not merged back, where nothing after its last
   * exchange took you back: no Back to the passage, no later question in the
   * thread above, and not set aside. Newest first.
   */
  openBranches(notebookId: string, limit = 8): OpenBranch[] {
    const rows = this.db.sql
      .prepare(
        `SELECT t.id, t.title, t.parent_thread_id, p.title AS parent_title, a.exact AS quote, x.last_at
         FROM thread t
         JOIN thread p ON p.id = t.parent_thread_id
         LEFT JOIN anchor a ON a.id = t.origin_anchor_id
         JOIN (SELECT thread_id, max(created_at) AS last_at FROM message GROUP BY thread_id) x ON x.thread_id = t.id
         WHERE t.notebook_id = ? AND t.split_at IS NULL AND t.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM message m JOIN message_revision r ON r.id = m.current_revision_id
             WHERE m.thread_id = t.id AND m.role = 'assistant' AND r.status = 'done')
           AND NOT EXISTS (
             SELECT 1 FROM thread_merge g WHERE g.source_thread_id = t.id AND g.status = 'merged')
           AND NOT EXISTS (
             SELECT 1 FROM event e
             WHERE e.subject_id = t.id AND e.type IN ('branch.returned', 'branch.set_aside') AND e.at >= x.last_at)
           AND NOT EXISTS (
             SELECT 1 FROM message pm WHERE pm.thread_id = t.parent_thread_id AND pm.created_at > x.last_at)
         ORDER BY x.last_at DESC
         LIMIT ?`,
      )
      .all(notebookId, limit) as Row[];
    return rows.map((r) => ({
      threadId: r.id as string,
      title: r.title as string,
      parentThreadId: r.parent_thread_id as string,
      parentTitle: r.parent_title as string,
      quote: (r.quote as string | null) ?? null,
      lastAt: r.last_at as string,
    }));
  }

  // Events and export -------------------------------------------------------

  logEvent(type: string, subjectId: string | null, data: Record<string, unknown> = {}): void {
    this.db.sql
      .prepare('INSERT INTO event (id, at, type, subject_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(ulid(), now(), type, subjectId, JSON.stringify(data));
  }

  /** Everything, as plain JSON. The notebook is the learner's, not ours. */
  /** The tables an export holds: all but the search index (rebuilt from the rest) and the store's own facts. */
  private exportTables(): string[] {
    return (
      this.db.sql
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Row[]
    )
      .map((r) => r.name as string)
      .filter((name) => name !== 'meta' && name !== 'search' && !name.startsWith('search_'));
  }

  /** Everything in the store, table by table, in the order it was written. Never the model key (it is not here). */
  exportAll(): NoemaExport {
    const tables: NoemaExport['tables'] = {};
    for (const name of this.exportTables()) {
      tables[name] = this.db.sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as NoemaExport['tables'][string];
    }
    return { format: 'noema-export', version: 2, exportedAt: now(), schemaVersion: this.db.version, tables };
  }

  /** Whether the store holds nothing the learner made: no threads, notes or sources, and nothing written about them. */
  isEmpty(): boolean {
    const r = this.db.sql
      .prepare(
        // The Assistant's thread is made when Noema opens: with nothing asked in it, it is not content.
        `SELECT (SELECT count(*) FROM thread t
                  WHERE t.kind = 'chat' OR EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id))
              + (SELECT count(*) FROM note) + (SELECT count(*) FROM source) + (SELECT count(*) FROM room)
              + (SELECT count(*) FROM notebook WHERE about_me <> '') AS n,
                (SELECT count(*) FROM notebook) AS notebooks`,
      )
      .get() as { n: number; notebooks: number };
    return r.n === 0 && r.notebooks <= 1;
  }

  /**
   * Put an export back, into an empty store of the same schema version. One
   * transaction: either all of it is in, or nothing changed. Foreign keys are
   * checked at the end, every column against the table, and the search index
   * is rebuilt. Anything that was being written when it was exported is
   * marked as cut off, as after a restart.
   */
  importAll(data: NoemaExport): ImportResponse['counts'] {
    if (data.schemaVersion !== this.db.version) {
      throw new InvalidError(
        `this export is from schema version ${data.schemaVersion}; this Noema is at ${this.db.version}. Use a Noema of the same version to import it.`,
      );
    }
    const known = new Set(this.exportTables());
    for (const name of Object.keys(data.tables)) {
      if (!known.has(name)) throw new InvalidError(`the export has a table this Noema does not know: ${name}`);
    }
    try {
      return this.importTables(data, known);
    } catch (err) {
      // A row the schema refuses (a missing thread, a wrong type): nothing was kept.
      if (err instanceof Error && /constraint|datatype|cannot store/i.test(err.message)) {
        throw new InvalidError(`the export does not hold together, so nothing was imported (${err.message})`);
      }
      throw err;
    }
  }

  private importTables(data: NoemaExport, known: Set<string>): ImportResponse['counts'] {
    return this.db.tx(() => {
      if (!this.isEmpty()) throw new ConflictError('import only into an empty notebook: this one already has things in it');
      this.db.sql.exec('PRAGMA defer_foreign_keys = ON');
      for (const name of known) this.db.sql.exec(`DELETE FROM "${name}"`);
      for (const [name, rows] of Object.entries(data.tables)) {
        const columns = new Set(
          (this.db.sql.prepare(`PRAGMA table_info("${name}")`).all() as Row[]).map((c) => c.name as string),
        );
        const statements = new Map<string, StatementSync>();
        for (const row of rows) {
          const keys = Object.keys(row);
          for (const k of keys) if (!columns.has(k)) throw new InvalidError(`${name} has no column ${k}`);
          const sig = keys.join(',');
          let stmt = statements.get(sig);
          if (!stmt) {
            stmt = this.db.sql.prepare(
              `INSERT INTO "${name}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            );
            statements.set(sig, stmt);
          }
          stmt.run(...keys.map((k) => row[k] as SQLInputValue));
        }
      }
      this.interruptLive();
      this.recoverNotes();
      this.failDraftingMerges();
      this.rebuildSearch();
      this.logEvent('store.imported', null, { schemaVersion: data.schemaVersion });
      const count = (table: string) =>
        (this.db.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        notebooks: count('notebook'),
        threads: count('thread'),
        messages: count('message'),
        notes: count('note'),
        sources: count('source'),
      };
    });
  }

  /** A notebook for reading as Markdown: what is not in the Trash, answers as the ones in use. */
  readable(notebookId: string): ReadableNotebook | null {
    const nb = this.db.sql.prepare('SELECT * FROM notebook WHERE id = ?').get(notebookId) as Row | undefined;
    if (!nb) return null;
    const threadRows = this.db.sql
      .prepare(
        `SELECT t.id, t.title, t.created_at, t.parent_thread_id, t.split_at,
                a.exact AS a_exact, p.title AS parent_title,
                sa.exact AS s_exact, s.title AS source_title
         FROM thread t
         LEFT JOIN anchor a ON a.id = t.origin_anchor_id
         LEFT JOIN thread p ON p.id = t.parent_thread_id
         LEFT JOIN source_anchor sa ON sa.id = t.source_anchor_id
         LEFT JOIN source_version sv ON sv.id = sa.version_id
         LEFT JOIN source s ON s.id = sv.source_id
         WHERE t.notebook_id = ? AND t.deleted_at IS NULL
         ORDER BY t.created_at`,
      )
      .all(notebookId) as Row[];
    const turns = this.db.sql.prepare(
      `SELECT m.role, r.content FROM message m JOIN message_revision r ON r.id = m.current_revision_id
       WHERE m.thread_id = ? ORDER BY m.seq`,
    );
    const threads = threadRows.map((t) => {
      const own = t.split_at !== null;
      return {
        id: t.id as string,
        title: t.title as string,
        createdAt: t.created_at as string,
        parentId: own ? null : ((t.parent_thread_id as string | null) ?? null),
        from: t.a_exact
          ? { quote: t.a_exact as string, in: `an answer in “${(t.parent_title as string) || 'Untitled'}”` }
          : t.s_exact
            ? { quote: t.s_exact as string, in: `“${(t.source_title as string) || 'Untitled'}”` }
            : undefined,
        turns: (turns.all(t.id as string) as Row[]).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content as string,
        })),
      };
    });
    const titleOf = new Map(threads.map((t) => [t.id, t.title]));
    const questionOf = this.db.sql.prepare(
      `SELECT COALESCE(q.id, m.id) AS id, r.content FROM message m
       LEFT JOIN message q ON q.id = m.reply_to
       JOIN message_revision r ON r.id = COALESCE(q.current_revision_id, m.current_revision_id)
       WHERE m.id = ?`,
    );
    const blocks = this.db.sql.prepare(
      'SELECT content FROM note_block WHERE note_id = ? AND deleted_at IS NULL ORDER BY pos',
    );
    const notes = (
      this.db.sql
        .prepare('SELECT id, title, refs FROM note WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .all(notebookId) as Row[]
    ).map((n) => {
      let refs: Record<string, { threadId: string; messageId: string }> = {};
      try {
        refs = JSON.parse(n.refs as string);
      } catch {
        // Unreadable refs: the labels stay in the text, without the list.
      }
      return {
        title: n.title as string,
        blocks: (blocks.all(n.id as string) as Row[]).map((b) => b.content as string),
        cites: Object.entries(refs)
          .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
          .map(([label, ref]) => ({
            label,
            thread: titleOf.get(ref.threadId) ?? '',
            question: ((questionOf.get(ref.messageId) as Row | undefined)?.content as string | undefined) ?? '',
          })),
      };
    });
    const sources = (
      this.db.sql
        .prepare('SELECT title, url FROM source WHERE notebook_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .all(notebookId) as Row[]
    ).map((r) => ({ title: r.title as string, url: (r.url as string | null) ?? null }));
    return {
      title: nb.title as string,
      aboutMe: nb.about_me as string,
      exportedAt: now(),
      notes,
      threads,
      sources,
    };
  }
}

/** A version as it is stored: the Markdown shown, and what it came from. */
export interface NewSourceVersion {
  content: string;
  origin: SourceVersion['origin'];
  fetchedUrl: string | null;
  /** The original HTML or text, kept so the text can be extracted again later. */
  raw: string | null;
  /** Which converter made `content` from `raw`. */
  extractor: string;
  /** 'application/pdf' when `raw` is a PDF (base64). */
  mediaType?: string | null;
  fileName?: string | null;
  /** Pages read, for a PDF (logged with the count of characters). */
  pages?: number;
  /** For a file of a linked folder: the sha256 of its bytes as read. */
  fileHash?: string | null;
}

/** The PDF pages a passage is on: the page heading before its start, and the one before its end. */
function pagesOf(content: string, start: number, end: number): number[] {
  const pageAt = (offset: number) => {
    let page = 1;
    for (const m of content.slice(0, offset).matchAll(/^## Page (\d+)$/gm)) page = Number(m[1]);
    return page;
  };
  const first = pageAt(start);
  const last = pageAt(Math.max(start, end - 1));
  return last > first ? [first, last] : [first];
}

/** A PDF's size from its base64 in `raw`, in SQL. */
const RAW_BYTES = `CASE WHEN media_type IS NULL OR raw IS NULL THEN 0 ELSE length(raw) * 3 / 4
  - (CASE WHEN substr(raw, -2) = '==' THEN 2 WHEN substr(raw, -1) = '=' THEN 1 ELSE 0 END) END`;

/** A file the learner gave is stored as given ('paste') with its name and type: see migration 014. */
function originOf(r: Row): SourceVersion['origin'] {
  if (r.origin === 'url') return 'url';
  return r.media_type ? 'file' : 'paste';
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toPassage(r: Row): SourcePassage {
  return {
    versionId: r.version_id as string,
    start: r.start_offset as number,
    end: r.end_offset as number,
    exact: r.exact as string,
    prefix: r.prefix as string,
    suffix: r.suffix as string,
  };
}

type SearchKind = 'thread' | 'message' | 'note' | 'block' | 'source' | 'passage';

/** Raise when what goes into the index changes; the index is rebuilt at the next start. */
const SEARCH_INDEX_VERSION = 3;

/** What is indexed for a message: its text, and an answer's headline. */
function messageText(content: string, headline: string | null): string {
  return headline ? `${content}\n${headline}` : content;
}

function snippetFields(s: { text: string; matches: Array<{ start: number; end: number }> }) {
  return { snippet: s.text, matches: s.matches };
}

function titleFrom(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : line;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
