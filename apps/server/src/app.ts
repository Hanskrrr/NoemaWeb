// Wires the store, the model and the routes into an http.Server.
// main.ts starts it; tests start it on a random port with an in-memory store.

import { createServer, type Server } from 'node:http';
import {
  AskRequest,
  CreateBranchRequest,
  CreateThreadRequest,
  describeError,
  isLive,
  type Message,
  RenameThreadRequest,
  RewriteRequest,
  UpdateModelSettingsRequest,
  UpdateNoteRequest,
  UpdateNotebookRequest,
} from '@noema/core';
import { Generations } from './chat/generation.ts';
import { NoteWriter } from './chat/notes.ts';
import { Titler } from './chat/titles.ts';
import type { Config } from './config.ts';
import { checkRequest, SECURITY_HEADERS } from './http/guard.ts';
import { HttpError, Router, sendError, sendJson } from './http/router.ts';
import { SseStream } from './http/sse.ts';
import { serveStatic } from './http/static.ts';
import { ProviderError } from './llm/provider.ts';
import type { ModelSettings } from './llm/settings.ts';
import type { Logger } from './log.ts';
import { type AskPair, ConflictError, InvalidError, type Repo } from './store/repo.ts';

export const VERSION = '0.1.0-m2';

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
  notes: NoteWriter;
  /** Stop live answers (stored as interrupted) and close the server. */
  close(): Promise<void>;
}

export function createApp(deps: AppDeps): App {
  const { repo, models, log } = deps;
  const titler = new Titler({ repo, models, log });
  const generations = new Generations({ repo, models, titler, config: deps.config, log });
  const notes = new NoteWriter({ repo, models, maxOutputTokens: deps.config.maxOutputTokens, log });
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
    });
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

  // The whole journey from the root thread: exchanges in order, branches where they left.
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

  router.on('GET', '/api/notebooks/:id/notes', ({ res, params }) => {
    if (!repo.getNotebook(params.id as string)) throw notFound('notebook');
    sendJson(res, 200, { notes: repo.listNotes(params.id as string).map(({ content: _c, refs: _r, ...rest }) => rest) });
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
    const patch = await ctx.body(UpdateNoteRequest);
    const note = repo.editNote(ctx.params.id as string, patch);
    if (!note) throw notFound('note');
    sendJson(ctx.res, 200, note);
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
    sendJson(res, 200, { query: q, hits: repo.search(q) });
  });

  router.on('GET', '/api/export', ({ res }) => {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('content-disposition', `attachment; filename="noema-export-${day}.json"`);
    sendJson(res, 200, repo.exportAll());
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
    notes,
    async close() {
      await Promise.all([generations.shutdown(), notes.shutdown()]);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
