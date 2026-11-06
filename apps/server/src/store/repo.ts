// All SQL lives here. Routes and the generation loop call these methods and
// never write SQL themselves.

import type { SQLInputValue } from 'node:sqlite';
import {
  type AnchorRef,
  type BranchSummary,
  type ContextManifest,
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
  type MessageError,
  type MessageStatus,
  makeSnippet,
  type Note,
  type NoteBlock,
  type Notebook,
  type Origin,
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
    title: r.title as string,
    titleSource: ((r.title_source as string | undefined) ?? 'question') as Thread['titleSource'],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const THREAD_SELECT = `SELECT t.*, a.exact AS origin_exact,
  (SELECT m.target_thread_id FROM thread_merge m WHERE m.source_thread_id = t.id AND m.status = 'merged'
   ORDER BY m.merged_at DESC LIMIT 1) AS merged_into
  FROM thread t LEFT JOIN anchor a ON a.id = t.origin_anchor_id`;

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
         r.headline
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
        .prepare(`${THREAD_SELECT} WHERE t.notebook_id = ? ORDER BY t.updated_at DESC`)
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
    return {
      root: build(threadId, 0, true),
      path: this.pathOf(threadId).map((p) => ({ threadId: p.id, title: p.title })),
      parent: origin ? { threadId: origin.parentThreadId, title: origin.parentTitle } : null,
    };
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
      this.db.sql.prepare('SELECT * FROM note WHERE notebook_id = ? ORDER BY updated_at DESC').all(notebookId) as Row[]
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

  deleteNote(id: string): boolean {
    const result = this.db.sql.prepare('DELETE FROM note WHERE id = ?').run(id);
    if (Number(result.changes) > 0) this.logEvent('note.deleted', id);
    return Number(result.changes) > 0;
  }

  private editable(noteId: string): Note {
    const note = this.getNote(noteId);
    if (!note) throw new NotFoundError('note');
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
      if (req.ask !== undefined) {
        this.insertBlockRow(noteId, req.id, at, '', 'ai', t);
        this.db.sql
          .prepare(
            "UPDATE note_block SET proposal = '', proposal_status = 'generating', proposal_instruction = ? WHERE id = ?",
          )
          .run(req.ask, req.id);
      } else {
        this.insertBlockRow(noteId, req.id, at, req.content ?? '', 'user', t);
      }
      ids.splice(at, 0, req.id);
      this.renumber(noteId, ids);
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
      this.db.sql
        .prepare('UPDATE note_block SET content = ?, author = ?, updated_at = ? WHERE id = ?')
        .run(content, author, now(), blockId);
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
      this.db.sql
        .prepare(
          `UPDATE note_block SET content = ?, author = ?, proposal = NULL, proposal_status = NULL,
             proposal_instruction = NULL, proposal_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(text, author, now(), blockId);
      this.syncNote(noteId, 'ai', row.content === '' ? 'added an AI block' : 'accepted an AI suggestion');
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
  recoverNotes(): { failed: number; blockified: number } {
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
    return { failed: live.length, blockified: old.length };
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
    at: { messageId: string; start: number; end: number },
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
      const message = this.getMessage(at.messageId);
      if (!message || message.threadId !== parentThreadId) throw new InvalidError('that message is not in this thread');
      if (isLive(message.status)) throw new ConflictError('wait for the answer to finish before branching from it');
      let anchor: ReturnType<typeof createAnchor>;
      try {
        anchor = createAnchor(message.revisionId, message.content, at.start, at.end);
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
          message.revisionId,
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
         WHERE t.parent_thread_id = ? ORDER BY t.created_at`,
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
    return [...this.inheritedHistory(origin.parentThreadId), ...this.history(origin.parentThreadId, through + 1)];
  }

  /**
   * The finished conversation before `beforeSeq`, as question/answer pairs
   * only. A thread merged in goes in front of the first question after the
   * merge (see pendingMerges for one with no question after it yet).
   */
  history(threadId: string, beforeSeq: number): HistoryItem[] {
    const rows = this.db.sql
      .prepare(
        `SELECT u.id AS uid, u.seq AS useq, ur.content AS ucontent, a.id AS aid, ar.content AS acontent
         FROM message a
         JOIN message_revision ar ON ar.id = a.current_revision_id
         JOIN message u ON u.id = a.reply_to
         JOIN message_revision ur ON ur.id = u.current_revision_id
         WHERE a.thread_id = ? AND a.role = 'assistant' AND a.seq < ?
           AND ar.status IN ('done', 'stopped') AND ar.content <> ''
         ORDER BY a.seq`,
      )
      .all(threadId, beforeSeq) as Row[];
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
    const r = this.db.sql
      .prepare("UPDATE message_revision SET headline = ? WHERE id = ? AND status = 'done'")
      .run(headline, revisionId);
    return Number(r.changes) > 0;
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
      anchors: all('anchor'),
      notes: all('note'),
      noteBlocks: all('note_block'),
      noteRevisions: all('note_revision'),
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
