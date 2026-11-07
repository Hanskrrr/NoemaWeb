// Wires the store, the model and the routes into an http.Server.
// main.ts starts it; tests start it on a random port with an in-memory store.

import { createServer, type Server } from 'node:http';
import {
  AskRequest,
  CreateBranchRequest,
  CreateNoteRequest,
  CreatePinRequest,
  CreateSourceRequest,
  CreateThreadRequest,
  describeError,
  EditBlockRequest,
  EditMergeRequest,
  htmlToMarkdown,
  InsertBlockRequest,
  isLive,
  MergeNoteRequest,
  type Message,
  MoveBlockRequest,
  MoveOutRequest,
  NoemaExport,
  notebookMarkdown,
  RedraftMergeRequest,
  RegenerateRequest,
  RenameSourceRequest,
  RenameThreadRequest,
  RewriteRequest,
  SearchOpenedRequest,
  SourceThreadRequest,
  SplitOffRequest,
  SplitThreadRequest,
  StartMergeRequest,
  SuggestRequest,
  UpdateModelSettingsRequest,
  UpdateNotebookRequest,
  UpdateNoteRequest,
  UseRevisionRequest,
} from '@noema/core';
import { Generations } from './chat/generation.ts';
import { fullTranscript, MergeWriter } from './chat/merges.ts';
import { NoteWriter, Suggester } from './chat/notes.ts';
import { Headliner } from './chat/headlines.ts';
import { Titler } from './chat/titles.ts';
import type { Config } from './config.ts';
import { checkRequest, SECURITY_HEADERS } from './http/guard.ts';
import { HttpError, Router, sendError, sendJson } from './http/router.ts';
import { SseStream } from './http/sse.ts';
import { serveStatic } from './http/static.ts';
import { EXTRACTOR, FetchProblem, importPage } from './ingest/fetch.ts';
import { ProviderError } from './llm/provider.ts';
import type { ModelSettings } from './llm/settings.ts';
import type { Logger } from './log.ts';
import { type AskPair, ConflictError, InvalidError, NotFoundError, type Repo } from './store/repo.ts';

export const VERSION = '0.1.0-m4.1';

export interface AppDeps {
  repo: Repo;
  models: ModelSettings;
  config: Pick<Config, 'contextBudgetTokens' | 'maxOutputTokens' | 'webDist'>;
  log: Logger;
}

export interface App {
  server: Server;
  generations: Generations;
  titler: Titler;
  headliner: Headliner;
  notes: NoteWriter;
  suggestions: Suggester;
  merges: MergeWriter;
  /** Stop live answers (stored as interrupted) and close the server. */
  close(): Promise<void>;
}

export function createApp(deps: AppDeps): App {
  const { repo, models, log } = deps;
  const titler = new Titler({ repo, models, log });
  const headliner = new Headliner({ repo, models, log });
  const generations = new Generations({ repo, models, titler, headliner, config: deps.config, log });
  const notes = new NoteWriter({ repo, models, maxOutputTokens: deps.config.maxOutputTokens, log });
  const suggestions = new Suggester({ repo, models, maxOutputTokens: deps.config.maxOutputTokens, log });
  const merges = new MergeWriter({ repo, models, log });
  const router = new Router();

  const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

  /** The stored message, with live text and status if it is still generating. */
  const current = (m: Message): Message => {
    const live = generations.get(m.id);
    return live ? { ...m, content: live.content, status: live.status, error: live.error } : m;
  };

  router.on('GET', '/api/health', ({ res }) => {
    const view = models.view();
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      provider: view.provider,
      model: view.configured ? view.model : null,
      configured: view.configured,
    });
  });

  router.on('GET', '/api/settings/model', ({ res }) => {
    sendJson(res, 200, models.view());
  });

  // Saving checks the key with the provider first; a key that does not work is not saved.
  router.on('PUT', '/api/settings/model', async (ctx) => {
    const body = await ctx.body(UpdateModelSettingsRequest);
    try {
      const { view, available } = await models.update(body);
      repo.logEvent('settings.model_saved', null, { host: new URL(view.baseUrl).host, model: view.model });
      sendJson(ctx.res, 200, { settings: view, available });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const detail = err.kind === 'bad_request' || err.kind === 'network' ? ` (${err.message})` : '';
      throw new HttpError(422, err.kind, describeError(err.kind) + detail);
    }
  });

  router.on('DELETE', '/api/settings/model', ({ res }) => {
    const view = models.forget();
    repo.logEvent('settings.model_removed', null);
    sendJson(res, 200, { settings: view, available: [] });
  });

  router.on('GET', '/api/notebooks', ({ res }) => {
    repo.ensureDefaultNotebook();
    sendJson(res, 200, { notebooks: repo.listNotebooks() });
  });

  router.on('PATCH', '/api/notebooks/:id', async (ctx) => {
    const patch = await ctx.body(UpdateNotebookRequest);
    const nb = repo.updateNotebook(ctx.params.id as string, patch);
    if (!nb) throw notFound('notebook');
    sendJson(ctx.res, 200, nb);
  });

  router.on('GET', '/api/notebooks/:id/threads', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, { threads: repo.listThreads(params.id as string) });
  });

  router.on('POST', '/api/notebooks/:id/threads', async (ctx) => {
    const notebookId = ctx.params.id as string;
    if (!repo.getNotebook(notebookId)) throw notFound('notebook');
    const body = await ctx.body(CreateThreadRequest);
    const { thread, created } = repo.createThread(notebookId, body.id, body.title);
    sendJson(ctx.res, created ? 201 : 200, thread);
  });

  router.on('GET', '/api/threads/:id', ({ res, params }) => {
    const thread = repo.getThread(params.id as string);
    if (!thread) throw notFound('thread');
    sendJson(res, 200, {
      thread,
      messages: repo.listMessages(thread.id).map(current),
      branches: repo.branchesOf(thread.id),
      origin: repo.originOf(thread.id),
      path: repo.pathOf(thread.id),
      merges: repo.mergesInto(thread.id),
      outgoing: repo.outgoingOf(thread.id),
      ...repo.continuationOf(thread.id),
      sourceOrigin: repo.sourceOriginOf(thread.id),
      pins: repo.pinsFor(thread.id),
    });
  });

  // Pins: passages sent with every question in a thread (and its side questions) until unpinned.
  router.on('POST', '/api/threads/:id/pins', async (ctx) => {
    const body = await ctx.body(CreatePinRequest);
    const at = body.message ? { message: body.message } : { source: body.source as NonNullable<typeof body.source> };
    const { pin, created } = repo.createPin(ctx.params.id as string, body.id, at);
    sendJson(ctx.res, created ? 201 : 200, pin);
  });

  router.on('DELETE', '/api/pins/:id', ({ res, params }) => {
    if (!repo.deletePin(params.id as string)) throw notFound('pin');
    sendJson(res, 200, { ok: true });
  });

  // Merge this thread into another: a draft (the AI's summary, or the
  // exchanges as they are) the learner edits and accepts.
  router.on('POST', '/api/threads/:id/merges', async (ctx) => {
    const sourceId = ctx.params.id as string;
    const { id, into, mode } = await ctx.body(StartMergeRequest);
    const { merge, created } = repo.startMerge(id, sourceId, into, mode, () => fullTranscript(repo, sourceId));
    if (created && merge.status === 'drafting') merges.start(merge.id);
    sendJson(ctx.res, created ? 201 : 200, merge);
  });

  router.on('GET', '/api/merges/:id', ({ res, params }) => {
    const merge = repo.getMerge(params.id as string);
    if (!merge) throw notFound('merge');
    sendJson(res, 200, merge);
  });

  router.on('PATCH', '/api/merges/:id', async (ctx) => {
    const { summary } = await ctx.body(EditMergeRequest);
    sendJson(ctx.res, 200, repo.editMerge(ctx.params.id as string, summary));
  });

  router.on('POST', '/api/merges/:id/redraft', async (ctx) => {
    const { mode } = await ctx.body(RedraftMergeRequest);
    const id = ctx.params.id as string;
    const current = repo.getMerge(id);
    if (!current) throw notFound('merge');
    const merge = repo.redraftMerge(id, mode, () => fullTranscript(repo, current.sourceThreadId));
    if (merge.status === 'drafting') merges.start(merge.id);
    sendJson(ctx.res, 202, merge);
  });

  router.on('POST', '/api/merges/:id/accept', ({ res, params }) => {
    sendJson(res, 200, repo.acceptMerge(params.id as string));
  });

  router.on('POST', '/api/merges/:id/undo', ({ res, params }) => {
    sendJson(res, 200, repo.undoMerge(params.id as string));
  });

  router.on('POST', '/api/merges/:id/discard', ({ res, params }) => {
    sendJson(res, 200, repo.discardMerge(params.id as string));
  });

  const answer = (notebookId: string, threadId: string, pair: AskPair) =>
    generations.start({
      threadId,
      notebookId,
      messageId: pair.assistant.id,
      revisionId: pair.assistant.revisionId,
      question: { id: pair.user.id, content: pair.user.content, seq: pair.user.seq },
    });

  router.on('POST', '/api/threads/:id/messages', async (ctx) => {
    const thread = repo.getThread(ctx.params.id as string);
    if (!thread) throw notFound('thread');
    const body = await ctx.body(AskRequest);
    const { pair, created } = repo.createAsk(thread.id, body.id, body.content);
    if (created) answer(thread.notebookId, thread.id, pair);
    sendJson(ctx.res, created ? 201 : 200, { user: pair.user, assistant: current(pair.assistant) });
  });

  // Ask in a branch: open a side thread from a passage and ask its first question.
  router.on('POST', '/api/threads/:id/branches', async (ctx) => {
    const parent = repo.getThread(ctx.params.id as string);
    if (!parent) throw notFound('thread');
    const body = await ctx.body(CreateBranchRequest);
    const { thread, pair, created } = repo.createBranch(parent.id, body.id, body.anchor, body.question);
    if (created) answer(thread.notebookId, thread.id, pair);
    sendJson(ctx.res, created ? 201 : 200, { thread, user: pair.user, assistant: current(pair.assistant) });
  });

  // Back from a branch. Recorded so returns can be counted (prototype brief §11).
  // Rename: the learner's title is kept from now on; the AI never replaces it.
  router.on('PATCH', '/api/threads/:id', async (ctx) => {
    const thread = repo.getThread(ctx.params.id as string);
    if (!thread) throw notFound('thread');
    const { title } = await ctx.body(RenameThreadRequest);
    repo.setTitle(thread.id, title, 'user');
    repo.logEvent('thread.renamed', thread.id);
    sendJson(ctx.res, 200, repo.getThread(thread.id));
  });

  // Make a branch its own thread, or put it back.
  // New thread from here: this question and everything after it become a thread of their own.
  router.on('POST', '/api/threads/:id/split-off', async (ctx) => {
    const { id, messageId } = await ctx.body(SplitOffRequest);
    const { thread, created } = repo.splitOff(ctx.params.id as string, messageId, id);
    if (created) void titler.title(thread.id);
    sendJson(ctx.res, created ? 201 : 200, thread);
  });

  // Undo it: the questions go back where they were.
  router.on('POST', '/api/threads/:id/join-back', ({ res, params }) => {
    sendJson(res, 200, repo.joinBack(params.id as string));
  });

  router.on('POST', '/api/threads/:id/split', async (ctx) => {
    const { split } = await ctx.body(SplitThreadRequest);
    const thread = repo.setSplit(ctx.params.id as string, split);
    if (!thread) throw notFound('thread');
    sendJson(ctx.res, 200, thread);
  });

  // The map of this thread and the branches below it: exchanges in order, branches where they left.
  router.on('GET', '/api/threads/:id/map', ({ res, params }) => {
    const thread = repo.getThread(params.id as string);
    if (!thread) throw notFound('thread');
    sendJson(res, 200, repo.mapOf(thread.id));
  });

  // Rewrite a thread and its branches as a note. Idempotent on the note id.
  router.on('POST', '/api/threads/:id/notes', async (ctx) => {
    const thread = repo.getThread(ctx.params.id as string);
    if (!thread) throw notFound('thread');
    const { id } = await ctx.body(RewriteRequest);
    const { note, created } = repo.startNote(id, thread.notebookId, thread.id, thread.title || 'Untitled');
    if (created) notes.start(note.id, thread.id);
    sendJson(ctx.res, created ? 201 : 200, note);
  });

  // Sources: what the learner reads. Pasted text, or a page read from its address.
  router.on('GET', '/api/notebooks/:id/sources', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, { sources: repo.listSources(params.id as string) });
  });

  router.on('POST', '/api/notebooks/:id/sources', async (ctx) => {
    const notebookId = ctx.params.id as string;
    if (!repo.getNotebook(notebookId)) throw notFound('notebook');
    const body = await ctx.body(CreateSourceRequest);
    const existing = repo.getSource(body.id);
    if (existing) {
      if (existing.notebookId !== notebookId) throw new HttpError(409, 'conflict', 'source id already used');
      sendJson(ctx.res, 200, existing);
      return;
    }
    if (body.url !== undefined) {
      const page = await readPage(body.url);
      const { source } = repo.createSource(body.id, notebookId, {
        title: body.title || page.title || new URL(page.fetchedUrl).hostname,
        url: body.url,
        version: { content: page.markdown, origin: 'url', fetchedUrl: page.fetchedUrl, raw: page.raw, extractor: EXTRACTOR },
      });
      sendJson(ctx.res, 201, source);
      return;
    }
    const text = (body.text ?? '').replace(/\r\n?/g, '\n').trim();
    const { source } = repo.createSource(body.id, notebookId, {
      title: body.title || pastedTitle(text),
      url: null,
      version: { content: text, origin: 'paste', fetchedUrl: null, raw: null, extractor: 'pasted' },
    });
    sendJson(ctx.res, 201, source);
  });

  router.on('GET', '/api/sources/:id', ({ res, params, url }) => {
    const detail = repo.sourceDetail(params.id as string, url.searchParams.get('version') ?? undefined, EXTRACTOR);
    if (!detail) throw notFound('source');
    sendJson(res, 200, detail);
  });

  router.on('PATCH', '/api/sources/:id', async (ctx) => {
    const { title } = await ctx.body(RenameSourceRequest);
    sendJson(ctx.res, 200, repo.renameSource(ctx.params.id as string, title));
  });

  // Read it again: a new version only if its text changed; passages already asked about stay on theirs.
  router.on('POST', '/api/sources/:id/refetch', async (ctx) => {
    const source = repo.getSource(ctx.params.id as string);
    if (!source) throw notFound('source');
    if (!source.url) throw new HttpError(400, 'invalid', 'pasted text has no address to read again');
    const page = await readPage(source.url);
    sendJson(
      ctx.res,
      200,
      repo.addSourceVersion(source.id, {
        content: page.markdown,
        origin: 'url',
        fetchedUrl: page.fetchedUrl,
        raw: page.raw,
        extractor: EXTRACTOR,
      }),
    );
  });

  // Read the page again from the copy kept with it, with this Noema's reader: no network.
  // For a page read by an earlier version of the reader (formulas and tables come out better).
  router.on('POST', '/api/sources/:id/reread', ({ res, params }) => {
    const source = repo.getSource(params.id as string);
    if (!source) throw notFound('source');
    const page = repo.latestPage(source.id);
    if (!page || !page.extractor.startsWith('noema-html')) {
      throw new HttpError(400, 'invalid', 'there is no page kept with it to read again');
    }
    const read = htmlToMarkdown(page.raw, page.fetchedUrl ? { url: page.fetchedUrl } : {});
    const result = repo.addSourceVersion(source.id, {
      content: read.markdown,
      origin: page.origin,
      fetchedUrl: page.fetchedUrl,
      raw: page.raw,
      extractor: EXTRACTOR,
    });
    // The same text from the same page: it was read as well as this Noema can.
    if (!result.changed) repo.markLatestRead(source.id, EXTRACTOR);
    sendJson(res, 200, result);
  });

  router.on('DELETE', '/api/sources/:id', ({ res, params }) => {
    if (!repo.deleteSource(params.id as string)) throw notFound('source');
    sendJson(res, 200, { ok: true });
  });

  router.on('POST', '/api/sources/:id/restore', ({ res, params }) => {
    sendJson(res, 200, repo.restoreSource(params.id as string));
  });

  // Ask about a passage: a thread of its own that starts there, with its first question.
  router.on('POST', '/api/sources/:id/threads', async (ctx) => {
    const body = await ctx.body(SourceThreadRequest);
    const { thread, pair, created } = repo.createSourceThread(ctx.params.id as string, body.id, body.passage, body.question);
    if (created) answer(thread.notebookId, thread.id, pair);
    sendJson(ctx.res, created ? 201 : 200, { thread, user: pair.user, assistant: current(pair.assistant) });
  });

  router.on('GET', '/api/notebooks/:id/notes', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, {
      notes: repo.listNotes(params.id as string).map(({ content: _c, blocks: _b, refs: _r, ...rest }) => rest),
    });
  });

  // A note the learner starts from nothing. Idempotent on the note id.
  router.on('POST', '/api/notebooks/:id/notes', async (ctx) => {
    if (!repo.getNotebook(ctx.params.id as string)) throw notFound('notebook');
    const { id, title } = await ctx.body(CreateNoteRequest);
    const { note, created } = repo.createNote(id, ctx.params.id as string, title);
    sendJson(ctx.res, created ? 201 : 200, note);
  });

  router.on('GET', '/api/notes/:id', ({ res, params }) => {
    const note = repo.getNote(params.id as string);
    if (!note) throw notFound('note');
    sendJson(res, 200, note);
  });

  router.on('GET', '/api/notes/:id/history', ({ res, params }) => {
    if (!repo.getNote(params.id as string)) throw notFound('note');
    sendJson(res, 200, { revisions: repo.noteHistory(params.id as string) });
  });

  router.on('PATCH', '/api/notes/:id', async (ctx) => {
    const { title } = await ctx.body(UpdateNoteRequest);
    const note = repo.renameNote(ctx.params.id as string, title);
    if (!note) throw notFound('note');
    sendJson(ctx.res, 200, note);
  });

  // To the Trash, and back.
  router.on('DELETE', '/api/notes/:id', ({ res, params }) => {
    if (!repo.deleteNote(params.id as string)) throw notFound('note');
    sendJson(res, 200, { ok: true });
  });

  router.on('POST', '/api/notes/:id/restore', ({ res, params }) => {
    sendJson(res, 200, repo.restoreNote(params.id as string));
  });

  router.on('DELETE', '/api/threads/:id', ({ res, params }) => {
    sendJson(res, 200, { ok: true, deleted: repo.deleteThread(params.id as string) });
  });

  router.on('POST', '/api/threads/:id/restore', ({ res, params }) => {
    sendJson(res, 200, repo.restoreThread(params.id as string));
  });

  router.on('GET', '/api/notebooks/:id/trash', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, repo.trash(params.id as string));
  });

  // Blocks. Every change answers with the whole note, which is small.
  // Write a block, or ask the AI for one at this place (it arrives as a suggestion).
  router.on('POST', '/api/notes/:id/blocks', async (ctx) => {
    const noteId = ctx.params.id as string;
    const req = await ctx.body(InsertBlockRequest);
    const { block, created } = repo.insertBlock(noteId, req);
    if (created && req.ask !== undefined) suggestions.start(noteId, block.id, 'insert', req.ask);
    sendJson(ctx.res, created ? 201 : 200, repo.getNote(noteId));
  });

  router.on('PATCH', '/api/notes/:id/blocks/:block', async (ctx) => {
    const { content } = await ctx.body(EditBlockRequest);
    sendJson(ctx.res, 200, repo.editBlock(ctx.params.id as string, ctx.params.block as string, content));
  });

  router.on('DELETE', '/api/notes/:id/blocks/:block', ({ res, params }) => {
    sendJson(res, 200, repo.deleteBlock(params.id as string, params.block as string));
  });

  router.on('POST', '/api/notes/:id/blocks/:block/restore', ({ res, params }) => {
    sendJson(res, 200, repo.restoreBlock(params.id as string, params.block as string));
  });

  router.on('POST', '/api/notes/:id/blocks/:block/move', async (ctx) => {
    const { after } = await ctx.body(MoveBlockRequest);
    sendJson(ctx.res, 200, repo.moveBlock(ctx.params.id as string, ctx.params.block as string, after));
  });

  // Ask the AI for a new version of a block. It arrives as a suggestion; the block is unchanged.
  router.on('POST', '/api/notes/:id/blocks/:block/suggest', async (ctx) => {
    const noteId = ctx.params.id as string;
    const { instruction } = await ctx.body(SuggestRequest);
    const block = repo.startProposal(noteId, ctx.params.block as string, instruction);
    suggestions.start(noteId, block.id, 'rewrite', instruction);
    sendJson(ctx.res, 202, repo.getNote(noteId));
  });

  router.on('POST', '/api/notes/:id/blocks/:block/accept', ({ res, params }) => {
    sendJson(res, 200, repo.acceptProposal(params.id as string, params.block as string));
  });

  router.on('POST', '/api/notes/:id/blocks/:block/discard', ({ res, params }) => {
    sendJson(res, 200, repo.discardProposal(params.id as string, params.block as string));
  });

  // Bring another note's blocks into this one; the other note is removed.
  router.on('POST', '/api/notes/:id/merge', async (ctx) => {
    const { from, after } = await ctx.body(MergeNoteRequest);
    sendJson(ctx.res, 200, repo.mergeNote(ctx.params.id as string, from, after));
  });

  // Move a section (or everything from a block down) into a new note. Idempotent on the new note's id.
  router.on('POST', '/api/notes/:id/move-out', async (ctx) => {
    const { id, blockIds } = await ctx.body(MoveOutRequest);
    const { note, created } = repo.moveOut(ctx.params.id as string, id, blockIds);
    sendJson(ctx.res, created ? 201 : 200, note);
  });

  // Write it again from the thread as it is now; the previous version stays in the history.
  router.on('POST', '/api/notes/:id/rewrite', ({ res, params }) => {
    const note = repo.getNote(params.id as string);
    if (!note) throw notFound('note');
    if (!note.threadId) throw new HttpError(409, 'conflict', 'the thread this note came from was deleted');
    const restarted = repo.restartNote(note.id);
    if (restarted?.status === 'generating' && !notes.isWriting(note.id)) notes.start(note.id, note.threadId);
    sendJson(res, 202, restarted);
  });

  router.on('POST', '/api/threads/:id/return', ({ res, params }) => {
    const thread = repo.getThread(params.id as string);
    if (!thread) throw notFound('thread');
    repo.logEvent('branch.returned', thread.id, { to: thread.parentThreadId });
    sendJson(res, 200, { ok: true });
  });

  // Ask the same question again: a new revision of the answer, generated like any other.
  router.on('POST', '/api/messages/:id/regenerate', async (ctx) => {
    const body = await ctx.body(RegenerateRequest);
    const { message, question, created } = repo.regenerate(ctx.params.id as string, body.revisionId);
    if (created) {
      const thread = repo.getThread(message.threadId);
      if (!thread) throw notFound('thread');
      generations.start({
        threadId: thread.id,
        notebookId: thread.notebookId,
        messageId: message.id,
        revisionId: message.revisionId,
        revision: message.revision,
        question: { id: question.id, content: question.content, seq: question.seq },
      });
    }
    sendJson(ctx.res, created ? 201 : 200, { message });
  });

  router.on('GET', '/api/messages/:id/revisions', ({ res, params }) => {
    if (!repo.getMessage(params.id as string)) throw notFound('message');
    sendJson(res, 200, { revisions: repo.revisionsOf(params.id as string) });
  });

  router.on('POST', '/api/messages/:id/current', async (ctx) => {
    const body = await ctx.body(UseRevisionRequest);
    sendJson(ctx.res, 200, { message: repo.useRevision(ctx.params.id as string, body.revisionId) });
  });

  // What the model was sent for this answer, word for word when it was recorded:
  // for the revision shown (?revision=<id>), else the current one.
  router.on('GET', '/api/messages/:id/context', ({ res, params, url }) => {
    const context = repo.contextOf(params.id as string, url.searchParams.get('revision') ?? undefined);
    if (!context) throw notFound('context');
    sendJson(res, 200, context);
  });

  router.on('GET', '/api/messages/:id/events', ({ res, params }) => {
    const stored = repo.getMessage(params.id as string);
    if (!stored) throw notFound('message');
    const sse = new SseStream(res);
    // Subscribe before taking the snapshot. Both happen in this one
    // synchronous step, so no delta can fall between them.
    const unwatch = generations.watch(stored.id, {
      delta: (text) => sse.send('delta', { text }),
      status: (status, error) => sse.send('status', { status, error }),
      end: () => {
        sse.send('end', {});
        sse.close();
      },
    });
    sse.send('snapshot', { message: current(stored) });
    if (unwatch) {
      sse.onClose(unwatch);
    } else {
      // Not generating: the snapshot is the whole story.
      const latest = repo.getMessage(stored.id) ?? stored;
      if (isLive(latest.status)) log.warn('stored as live but no generation is running', { messageId: stored.id });
      sse.send('end', {});
      sse.close();
    }
  });

  router.on('POST', '/api/messages/:id/stop', ({ res, params }) => {
    const message = repo.getMessage(params.id as string);
    if (!message) throw notFound('message');
    const stopping = generations.stop(message.id);
    if (stopping) repo.logEvent('answer.stop_requested', message.id);
    sendJson(res, 202, { stopping, message: current(message) });
  });

  router.on('GET', '/api/search', ({ res, url }) => {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    sendJson(res, 200, { query: q, ...repo.search(q) });
  });

  // For the brief's measure "searches that end on the right message": which kind of hit was opened, and its rank. Never the words.
  router.on('POST', '/api/search/opened', async (ctx) => {
    const body = await ctx.body(SearchOpenedRequest);
    repo.logEvent('search.opened', null, body);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.on('GET', '/api/notebooks/:id/open-branches', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, { branches: repo.openBranches(params.id as string) });
  });

  // "Not now": a side question leaves the list of those you never came back from, until it is asked in again.
  router.on('POST', '/api/threads/:id/set-aside', ({ res, params }) => {
    const thread = repo.getThread(params.id as string);
    if (!thread) throw notFound('thread');
    if (!thread.parentThreadId) throw new HttpError(400, 'invalid', 'only a side question can be set aside');
    repo.logEvent('branch.set_aside', thread.id);
    sendJson(res, 200, { ok: true });
  });

  // The whole store as JSON: a copy that can be imported into an empty notebook.
  router.on('GET', '/api/export', ({ res }) => {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('content-disposition', `attachment; filename="noema-export-${day}.json"`);
    sendJson(res, 200, repo.exportAll());
  });

  // A notebook as one Markdown file, for reading anywhere.
  router.on('GET', '/api/notebooks/:id/export.md', ({ res, params }) => {
    const notebook = repo.readable(params.id as string);
    if (!notebook) throw notFound('notebook');
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="noema-${day}.md"`,
    });
    res.end(notebookMarkdown(notebook));
  });

  // Put an export back, into an empty store. Exports hold every request sent, so they can be large.
  router.on('POST', '/api/import', async (ctx) => {
    if (generations.size > 0) throw new HttpError(409, 'conflict', 'wait for the answers being written to finish');
    const data = await ctx.body(NoemaExport, { maxBytes: 512 * 1024 * 1024 });
    sendJson(ctx.res, 201, { ok: true, counts: repo.importAll(data) });
  });

  const server = createServer(async (req, res) => {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      checkRequest(req);
      const handled = await router.handle(req, res, url);
      if (!handled) {
        if (url.pathname.startsWith('/api/')) throw notFound('route');
        const dist = deps.config.webDist;
        const isRead = req.method === 'GET' || req.method === 'HEAD';
        if (!(dist && isRead && serveStatic(dist, url.pathname, res))) {
          throw new HttpError(
            404,
            'not_found',
            'page not found. In development open the Vite URL; otherwise run pnpm build',
          );
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
      } else if (err instanceof ConflictError) {
        sendError(res, 409, 'conflict', err.message);
      } else if (err instanceof InvalidError) {
        sendError(res, 400, 'invalid_request', err.message);
      } else if (err instanceof NotFoundError) {
        sendError(res, 404, 'not_found', err.message);
      } else {
        log.error('request failed', { method: req.method, path: url.pathname, err });
        sendError(res, 500, 'internal', 'something went wrong; see the server log');
      }
    } finally {
      if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/events')) {
        log.debug('request', {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // SSE responses stay open

  return {
    server,
    generations,
    titler,
    headliner,
    notes,
    suggestions,
    merges,
    async close() {
      await Promise.all([generations.shutdown(), notes.shutdown(), suggestions.shutdown(), merges.shutdown()]);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Read a page for a source, or a reason the learner can act on. */
async function readPage(url: string) {
  try {
    return await importPage(url);
  } catch (err) {
    if (err instanceof FetchProblem) throw new HttpError(400, 'invalid', `That address could not be read: ${err.message}.`);
    throw err;
  }
}

/** A title for pasted text: its first heading, else its first line. */
function pastedTitle(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1];
  const line = heading ?? text.split('\n').find((l) => l.trim() !== '') ?? '';
  const plain = line.replace(/[*_`$\\]/g, '').trim();
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || 'Pasted text';
}
