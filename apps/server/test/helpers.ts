import type { AddressInfo } from 'node:net';
import { ulid } from '@noema/core';
import { createApp } from '../src/app.ts';
import { FakeProvider } from '../src/llm/fake.ts';
import type { ModelProvider } from '../src/llm/provider.ts';
import { silentLogger } from '../src/log.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';

export interface TestServer {
  base: string;
  repo: Repo;
  db: Db;
  close(): Promise<void>;
}

export async function startServer(options: { provider?: ModelProvider; dbPath?: string; budget?: number } = {}) {
  const db = new Db(options.dbPath ?? ':memory:');
  db.migrate();
  const repo = new Repo(db);
  repo.interruptLive();
  const app = createApp({
    repo,
    provider: options.provider ?? new FakeProvider({ delayMs: 1 }),
    config: { contextBudgetTokens: options.budget ?? 48_000, maxOutputTokens: 1024, webDist: null },
    log: silentLogger,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  const server: TestServer = {
    base: `http://127.0.0.1:${port}`,
    repo,
    db,
    async close() {
      await app.close();
      db.close();
    },
  };
  return server;
}

export async function api<T = unknown>(
  s: TestServer,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'x-noema-client': 'web' },
): Promise<{ status: number; json: T }> {
  const res = await fetch(s.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Read an SSE stream until `end`, the stream closes, `stopAfter` events, or the timeout. */
export async function readEvents(url: string, opts: { stopAfter?: number; timeoutMs?: number } = {}): Promise<SseEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i = buf.indexOf('\n\n');
      while (i !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        if (event && data !== undefined) events.push({ event, data: JSON.parse(data) });
        if (event === 'end' || (opts.stopAfter && events.length >= opts.stopAfter)) {
          ctrl.abort();
          return events;
        }
        i = buf.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

/** Rebuild the full text a watcher would show: snapshot, then deltas. */
export function textFrom(events: SseEvent[]): string {
  let text = '';
  for (const e of events) {
    if (e.event === 'snapshot') text = (e.data as { message: { content: string } }).message.content;
    if (e.event === 'delta') text += (e.data as { text: string }).text;
  }
  return text;
}

/** The status a watcher ends on: the last status event, or the snapshot's if the answer had already finished. */
export function finalStatus(events: SseEvent[]): { status: string; error: { kind: string } | null } {
  let out: { status: string; error: { kind: string } | null } = { status: 'unknown', error: null };
  for (const e of events) {
    if (e.event === 'snapshot') {
      const m = (e.data as { message: { status: string; error: { kind: string } | null } }).message;
      out = { status: m.status, error: m.error };
    }
    if (e.event === 'status') out = e.data as typeof out;
  }
  return out;
}

export async function newThread(s: TestServer): Promise<{ notebookId: string; threadId: string }> {
  const nb = await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks');
  const notebookId = nb.json.notebooks[0]?.id as string;
  const threadId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: threadId });
  return { notebookId, threadId };
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
