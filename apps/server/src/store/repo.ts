// All SQL lives here. Routes and the generation loop call these methods and
// never write SQL themselves.

import {
  type ContextManifest,
  type ErrorKind,
  ftsQuery,
  type HistoryItem,
  isLive,
  type Message,
  type MessageError,
  type MessageStatus,
  makeSnippet,
  type Notebook,
  type SearchHit,
  searchText,
  type Thread,
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

function toThread(r: Row): Thread {
  return {
    id: r.id as string,
    notebookId: r.notebook_id as string,
    title: r.title as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
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
    content: r.content as string,
    status: r.status as MessageStatus,
    error: kind ? { kind, message: (r.error_message as string | null) ?? '' } : null,
    model: (r.model as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const MESSAGE_SELECT = `
  SELECT m.id, m.thread_id, m.role, m.seq, m.reply_to, m.created_at,
         r.id AS revision_id, r.n, r.content, r.status, r.error_kind, r.error_message, r.model, r.updated_at
  FROM message m JOIN message_revision r ON r.id = m.current_revision_id`;

export class ConflictError extends Error {
  override name = 'ConflictError';
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
        .prepare('SELECT * FROM thread WHERE notebook_id = ? ORDER BY updated_at DESC')
        .all(notebookId) as Row[]
    ).map(toThread);
  }

  getThread(id: string): Thread | null {
    const row = this.db.sql.prepare('SELECT * FROM thread WHERE id = ?').get(id) as Row | undefined;
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
      return { thread: { id, notebookId, title, createdAt: t, updatedAt: t }, created: true };
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

  /** The finished conversation before `beforeSeq`, as question/answer pairs only. */
  history(threadId: string, beforeSeq: number): HistoryItem[] {
    const rows = this.db.sql
      .prepare(
        `SELECT u.id AS uid, ur.content AS ucontent, a.id AS aid, ar.content AS acontent
         FROM message a
         JOIN message_revision ar ON ar.id = a.current_revision_id
         JOIN message u ON u.id = a.reply_to
         JOIN message_revision ur ON ur.id = u.current_revision_id
         WHERE a.thread_id = ? AND a.role = 'assistant' AND a.seq < ?
           AND ar.status IN ('done', 'stopped') AND ar.content <> ''
         ORDER BY a.seq`,
      )
      .all(threadId, beforeSeq) as Row[];
    return rows.flatMap((r) => [
      { id: r.uid as string, role: 'user' as const, content: r.ucontent as string },
      { id: r.aid as string, role: 'assistant' as const, content: r.acontent as string },
    ]);
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
        'INSERT INTO model_call (id, revision_id, provider, model, started_at, manifest) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, start.revisionId, start.provider, start.model, now(), JSON.stringify(start.manifest));
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

  modelCallsFor(revisionId: string): Row[] {
    return this.db.sql
      .prepare('SELECT * FROM model_call WHERE revision_id = ? ORDER BY started_at')
      .all(revisionId) as Row[];
  }

  // Search ------------------------------------------------------------------

  private index(kind: 'message' | 'thread', targetId: string, threadId: string, text: string): void {
    this.db.sql.prepare('DELETE FROM search WHERE target_id = ? AND kind = ?').run(targetId, kind);
    this.db.sql
      .prepare('INSERT INTO search (body, kind, target_id, thread_id) VALUES (?, ?, ?, ?)')
      .run(searchText(text), kind, targetId, threadId);
  }

  search(query: string, limit = 30): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db.sql
      .prepare('SELECT kind, target_id, thread_id FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?')
      .all(match, limit) as Array<{ kind: 'message' | 'thread'; target_id: string; thread_id: string }>;
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const thread = this.getThread(r.thread_id);
      if (!thread) continue;
      if (r.kind === 'thread') {
        const s = makeSnippet(thread.title, query);
        hits.push({ kind: 'thread', threadId: thread.id, messageId: null, title: thread.title, ...snippetFields(s) });
      } else {
        const m = this.getMessage(r.target_id);
        if (!m || isLive(m.status)) continue;
        const s = makeSnippet(m.content, query);
        hits.push({ kind: 'message', threadId: thread.id, messageId: m.id, title: thread.title, ...snippetFields(s) });
      }
    }
    return hits;
  }

  // Events and export -------------------------------------------------------

  logEvent(type: string, subjectId: string | null, data: Record<string, unknown> = {}): void {
    this.db.sql
      .prepare('INSERT INTO event (id, at, type, subject_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(ulid(), now(), type, subjectId, JSON.stringify(data));
  }

  /** Everything, as plain JSON. The notebook is the learner's, not ours. */
  exportAll(): Record<string, unknown> {
    const all = (table: string) => this.db.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      format: 'noema-export',
      version: 1,
      exportedAt: now(),
      schemaVersion: this.db.version,
      notebooks: all('notebook'),
      threads: all('thread'),
      messages: all('message'),
      revisions: all('message_revision'),
      modelCalls: all('model_call'),
      events: all('event'),
    };
  }
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
