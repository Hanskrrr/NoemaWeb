// All SQL lives here. Routes and the generation loop call these methods and
// never write SQL themselves.

import { createHash } from 'node:crypto';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import {
  type AnchorRef,
  type AskedCandidate,
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
  type ThreadMap,
  ulid,
} from '@noema/core';
import type { Db } from './db.ts';

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function toNotebook(r: Row): Notebook {
  return {
    id: r.id as string,
    title: r.title as string,
    aboutMe: r.about_me as string,
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
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const MESSAGE_SELECT = `
  SELECT m.id, m.thread_id, m.role, m.seq, m.reply_to, m.created_at,
         r.id AS revision_id, r.n, r.content, r.status, r.error_kind, r.error_message, r.model, r.updated_at,
         r.headline, (SELECT count(*) FROM message_revision x WHERE x.message_id = m.id) AS revisions
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
      return { id, title: 'My notebook', aboutMe: '', createdAt: t, updatedAt: t };
    });
  }

  listNotebooks(): Notebook[] {
    return (this.db.sql.prepare('SELECT * FROM notebook ORDER BY created_at').all() as Row[]).map(toNotebook);
  }

  getNotebook(id: string): Notebook | null {
    const row = this.db.sql.prepare('SELECT * FROM notebook WHERE id = ?').get(id) as Row | undefined;
    return row ? toNotebook(row) : null;
  }

  updateNotebook(id: string, patch: { title?: string | undefined; aboutMe?: string | undefined }): Notebook | null {
    const current = this.getNotebook(id);
    if (!current) return null;
    const next = { ...current, ...stripUndefined(patch), updatedAt: now() };
    this.db.sql
      .prepare('UPDATE notebook SET title = ?, about_me = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.aboutMe, next.updatedAt, id);
    this.logEvent('notebook.updated', id, { fields: Object.keys(stripUndefined(patch)) });
    return next;
  }

  // Threads -----------------------------------------------------------------

  listThreads(notebookId: string): Thread[] {
    return (
      this.db.sql
        .prepare(`${THREAD_SELECT} WHERE t.notebook_id = ? AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`)
        .all(notebookId) as Row[]
    ).map(toThread);
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
           media_type, file_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        t,
      );
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
  sourceContextFor(threadId: string): { title: string; url: string | null; section: string; passage: string } | null {
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
         WHERE t.notebook_id = ? AND t.deleted_at IS NULL AND m.role = 'user'
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
        splitBlocks(content).forEach((text, i) => this.insertBlockRow(id, ulid(), i, text, 'ai', t));
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
    ids.forEach((id, i) => stmt.run(i, id, noteId));
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
      moving.forEach((b, i) => move.run(newId, i, t, b.id));
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
        splitBlocks(r.content as string).forEach((text, i) =>
          this.insertBlockRow(r.id as string, ulid(), i, text, r.author as NoteBlock['author'], t),
        );
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

  search(query: string, limit = 30): { terms: string[]; hits: SearchHit[] } {
    const { terms } = parseQuery(query);
    const match = ftsQuery(query);
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
        `SELECT (SELECT count(*) FROM thread) + (SELECT count(*) FROM note) + (SELECT count(*) FROM source)
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
