// Reading a room (ADR 0027): on the learner's word, the chat model writes a
// short summary of each thing in the room that has none (or one written
// before the thing changed), its key points linked to the words they came
// from; then it suggests links between the things, which wait for the
// learner to accept, change or dismiss. One reading per room at a time; its
// progress is kept here for the room to show.

import {
  describeError,
  gistRequest,
  LINKS_MAX_ITEMS,
  linksRequest,
  readGist,
  readLinks,
  type RoomItemRef,
  type RoomReading,
  roomKey,
  ulid,
} from '@noema/core';
import type { ModelSource } from '../llm/settings.ts';
import { ProviderError } from '../llm/provider.ts';
import type { Logger } from '../log.ts';
import type { Repo } from '../store/repo.ts';

/** How many summaries are written at once. */
const AT_ONCE = 3;

export class RoomReader {
  private readonly repo: Repo;
  private readonly models: ModelSource;
  private readonly log: Logger;
  private readonly readings = new Map<string, RoomReading>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(deps: { repo: Repo; models: ModelSource; log: Logger }) {
    this.repo = deps.repo;
    this.models = deps.models;
    this.log = deps.log;
  }

  status(roomId: string): RoomReading | null {
    return this.readings.get(roomId) ?? null;
  }

  /** Start reading a room (or say how the reading under way is going). */
  start(roomId: string): RoomReading {
    const now = this.readings.get(roomId);
    if (now && this.running.has(roomId)) return now;
    const first: RoomReading = { phase: 'summaries', done: 0, total: 0, suggested: 0, error: null };
    this.readings.set(roomId, first);
    const run = this.run(roomId)
      .catch((err: unknown) => {
        const message =
          err instanceof ProviderError ? describeError(err.kind) : 'The room could not be read. Try again.';
        if (!(err instanceof ProviderError)) this.log.error('room reading failed', { err });
        this.set(roomId, { phase: 'failed', error: message });
      })
      .finally(() => this.running.delete(roomId));
    this.running.set(roomId, run);
    return first;
  }

  /** For tests: wait for the reading under way. */
  async settled(roomId: string): Promise<void> {
    await this.running.get(roomId);
  }

  private set(roomId: string, patch: Partial<RoomReading>): void {
    const at = this.readings.get(roomId) ?? { phase: 'summaries', done: 0, total: 0, suggested: 0, error: null };
    this.readings.set(roomId, { ...at, ...patch });
  }

  private async run(roomId: string): Promise<void> {
    const room = this.repo.roomMembersOf(roomId);
    if (!room) throw new Error('no such room');
    const provider = this.models.current();
    if (!provider.configured) {
      this.set(roomId, { phase: 'failed', error: 'Connect a model first: Model, at the top right.' });
      return;
    }
    const bases = this.repo.itemBases(room.notebookId);
    const key = (x: RoomItemRef) => roomKey(x.kind, x.id);
    const known = this.repo.gists(room.members.map(key));
    const todo = room.members.filter((x) => known.get(key(x))?.basis !== bases.get(key(x)));
    this.set(roomId, { phase: 'summaries', total: todo.length, done: 0 });

    // Summaries, a few at a time.
    let failed = 0;
    let firstError: string | null = null;
    const queue = [...todo];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          await this.summarize(item, bases.get(key(item)) ?? '');
        } catch (err) {
          failed += 1;
          if (err instanceof ProviderError) {
            firstError ??= describeError(err.kind);
            // Not connected, out of credit, or the key is wrong: the rest would fail the same way.
            if (['auth', 'quota', 'not_configured'].includes(err.kind)) queue.length = 0;
          } else {
            this.log.warn('a summary could not be written', { err });
          }
        }
        const at = this.readings.get(roomId);
        this.set(roomId, { done: (at?.done ?? 0) + 1 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, worker));
    if (failed > 0 && failed === todo.length && firstError) {
      this.set(roomId, { phase: 'failed', error: firstError });
      return;
    }

    // Links, over every summary in the room.
    this.set(roomId, { phase: 'links' });
    const gists = this.repo.gists(room.members.map(key));
    const items = room.members.filter((x) => gists.has(key(x))).slice(0, LINKS_MAX_ITEMS);
    let suggested = 0;
    if (items.length >= 2) {
      const index = new Map(items.map((x, i) => [key(x), i + 1]));
      const linked: Array<[number, number]> = [];
      for (const l of this.repo.listItemLinks(room.notebookId)) {
        const a = index.get(key(l.from));
        const b = index.get(key(l.to));
        if (a && b) linked.push([Math.min(a, b), Math.max(a, b)]);
      }
      const titles = this.titles(room.notebookId);
      let raw = '';
      for await (const ev of provider.stream({
        messages: linksRequest(
          items.map((x) => ({ kind: x.kind, title: titles.get(key(x)) ?? '', gist: gists.get(key(x))?.text ?? '' })),
          linked,
        ),
        maxTokens: 1500,
        light: true,
        purpose: 'links',
        signal: AbortSignal.timeout(90_000),
      })) {
        if (ev.type === 'text') raw += ev.text;
      }
      const drafts = readLinks(raw, items.length);
      if (!drafts) this.log.warn('could not read the suggested links', { chars: raw.length });
      for (const d of drafts ?? []) {
        const from = items[d.from - 1] as RoomItemRef;
        const to = items[d.to - 1] as RoomItemRef;
        if (this.repo.linkBetween(room.notebookId, from, to)) continue;
        this.repo.createItemLink(ulid(), room.notebookId, { from, to, kind: d.kind, why: d.why || null }, 'ai', 'suggested');
        suggested += 1;
      }
    }
    this.repo.logEvent('room.read', roomId, { summaries: todo.length - failed, failed, suggested, model: provider.model });
    this.set(roomId, {
      phase: 'done',
      suggested,
      error: failed > 0 ? `${failed} of ${todo.length} could not be summarized${firstError ? `: ${firstError}` : '.'}` : null,
    });
  }

  private async summarize(item: RoomItemRef, basis: string): Promise<void> {
    const text = this.repo.itemText(item);
    if (!text || !text.text.trim()) return;
    const provider = this.models.current();
    let raw = '';
    for await (const ev of provider.stream({
      messages: gistRequest(text),
      maxTokens: 600,
      light: true,
      purpose: 'gist',
      signal: AbortSignal.timeout(90_000),
    })) {
      if (ev.type === 'text') raw += ev.text;
    }
    const gist = readGist(raw, text);
    if (!gist) throw new Error('the summary could not be read');
    this.repo.saveGist(item, basis, gist.text, gist.points, provider.model);
  }

  private titles(notebookId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const x of this.repo.listSources(notebookId)) out.set(roomKey('source', x.id), x.title);
    for (const x of this.repo.listThreads(notebookId)) out.set(roomKey('thread', x.id), x.title);
    for (const x of this.repo.listNotes(notebookId)) out.set(roomKey('note', x.id), x.title);
    return out;
  }
}
