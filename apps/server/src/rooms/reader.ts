// Reading a room (ADR 0027): on the learner's word, the chat model writes a
// short summary of each thing in the room that has none (or one written
// before the thing changed), its key points linked to the words they came
// from; then it suggests links between the things, which wait for the
// learner to accept, change or dismiss. One reading per room at a time; its
// progress is kept here for the room to show.

import {
  briefRequest,
  type ChosenLink,
  chooseLinkRequest,
  describeError,
  gistRequest,
  type ItemLink,
  LINKS_MAX_ITEMS,
  linksRequest,
  readBrief,
  readChosenLink,
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
    const first: RoomReading = { phase: 'summaries', done: 0, total: 0, suggested: 0, error: null, current: [] };
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
    const at = this.readings.get(roomId) ?? { phase: 'summaries' as const, done: 0, total: 0, suggested: 0, error: null, current: [] };
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
        const k = key(item);
        this.set(roomId, { current: [...(this.readings.get(roomId)?.current ?? []), k] });
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
        this.set(roomId, { done: (at?.done ?? 0) + 1, current: (at?.current ?? []).filter((x) => x !== k) });
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
    // The brief: what the room adds up to, and what is still open in it (ADR 0030); with the rooms in it, each
    // by its own brief (ADR 0032). Those rooms are not read again here: each is read in itself.
    const basis = this.repo.roomBriefBasis(roomId);
    const known2 = this.repo.gists(room.members.map(key));
    const briefed = room.members.filter((x) => known2.has(key(x))).slice(0, LINKS_MAX_ITEMS);
    const doors = this.repo.roomDoorsOf(roomId).slice(0, 12);
    if (basis && briefed.length + doors.length > 0) {
      this.set(roomId, { phase: 'brief' });
      try {
        const titles = this.titles(room.notebookId);
        const holds = (c: (typeof doors)[number]['counts']) =>
          [[c.sources, 'source'], [c.threads, 'thread'], [c.notes, 'note'], [c.rooms, 'room']]
            .filter(([n]) => (n as number) > 0)
            .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
            .join(', ');
        let raw = '';
        for await (const ev of provider.stream({
          messages: briefRequest(room.title, [
            ...briefed.map((x) => ({ kind: x.kind, title: titles.get(key(x)) ?? '', gist: known2.get(key(x))?.text ?? '' })),
            ...doors.map((d) => ({
              kind: 'room' as const,
              title: d.title,
              gist: d.brief ?? `Not read yet; it holds ${holds(d.counts) || 'nothing yet'}.`,
            })),
          ]),
          maxTokens: 900,
          light: true,
          purpose: 'brief',
          signal: AbortSignal.timeout(90_000),
        })) {
          if (ev.type === 'text') raw += ev.text;
        }
        const draft = readBrief(raw, briefed.length + doors.length);
        if (draft) {
          const open = draft.open.map((o) => {
            const at = o.from ? briefed[o.from - 1] : undefined;
            const door = o.from && o.from > briefed.length ? doors[o.from - briefed.length - 1] : undefined;
            const item = at ? { kind: at.kind as 'thread' | 'source' | 'note', id: at.id } : door ? { kind: 'room' as const, id: door.id } : null;
            return { question: o.question, item };
          });
          this.repo.saveRoomBrief(roomId, basis, draft.text, open, provider.model);
        } else {
          this.log.warn('could not read the room brief', { chars: raw.length });
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) this.log.warn('the room brief could not be written', { err });
      }
    }
    this.repo.logEvent('room.read', roomId, { summaries: todo.length - failed, failed, suggested, model: provider.model });
    this.set(roomId, {
      phase: 'done',
      suggested,
      error: failed > 0 ? `${failed} of ${todo.length} could not be summarized${firstError ? `: ${firstError}` : '.'}` : null,
    });
  }

  /**
   * A line the learner drew (ADR 0029): the model reads both ends (their
   * summaries, or the start of their text) and says what the line means and
   * why, turning it around if it reads better the other way. The link stays
   * the learner's; its kind and reason are the AI's until they change them.
   */
  async chooseKind(linkId: string): Promise<ItemLink> {
    const link = this.repo.getItemLink(linkId);
    if (!link) throw new Error('no such link');
    const provider = this.models.current();
    if (!provider.configured) throw new ProviderError('not_configured', 'no model');
    const titles = this.titles(link.notebookId);
    const gists = this.repo.gists([roomKey(link.from.kind, link.from.id), roomKey(link.to.kind, link.to.id)]);
    const end = (x: RoomItemRef) => ({
      kind: x.kind as 'thread' | 'source' | 'note',
      title: titles.get(roomKey(x.kind, x.id)) ?? '',
      text: gists.get(roomKey(x.kind, x.id))?.text ?? this.repo.itemText(x)?.text ?? '',
    });
    let raw = '';
    for await (const ev of provider.stream({
      messages: chooseLinkRequest(end(link.from), end(link.to)),
      maxTokens: 300,
      light: true,
      purpose: 'link-kind',
      signal: AbortSignal.timeout(60_000),
    })) {
      if (ev.type === 'text') raw += ev.text;
    }
    const chosen: ChosenLink | null = readChosenLink(raw);
    if (!chosen) throw new Error('the kind could not be read');
    this.repo.logEvent('link.chosen', linkId, { kind: chosen.kind, flip: chosen.flip, model: provider.model });
    return this.repo.updateItemLink(linkId, { kind: chosen.kind, flip: chosen.flip, why: chosen.why || null }) as ItemLink;
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
