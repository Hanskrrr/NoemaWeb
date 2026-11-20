// Reading a room (ADR 0027): on the learner's word, the chat model writes a
// short summary of each thing in the room that has none (or one written
// before the thing changed), its key points linked to the words they came
// from; then it suggests links between the things, which wait for the
// learner to accept, change or dismiss. One reading per room at a time; its
// progress is kept here for the room to show.

import {
  becomesConcept,
  briefRequest,
  type ChosenLink,
  chooseLinkRequest,
  commonName,
  conceptLinksRequest,
  describeError,
  gistRequest,
  type ItemLink,
  LINKS_MAX_ITEMS,
  linksRequest,
  readBrief,
  readChosenLink,
  readGist,
  joinRequest,
  pieceRequest,
  readConceptLinks,
  readJoin,
  readLinks,
  readMentions,
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
    const first: RoomReading = { phase: 'summaries', done: 0, total: 0, suggested: 0, concepts: 0, error: null, current: [] };
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
    const at = this.readings.get(roomId) ?? { phase: 'summaries' as const, done: 0, total: 0, suggested: 0, concepts: 0, error: null, current: [] };
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
    // Its concepts (ADR 0036): the key ideas its things are about, suggested for the learner to keep.
    let concepts = 0;
    try {
      concepts = await this.findConcepts(roomId, room);
    } catch (err) {
      if (!(err instanceof ProviderError)) this.log.warn('the concepts could not be found', { err });
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
    this.repo.logEvent('room.read', roomId, { summaries: todo.length - failed, failed, suggested, concepts, model: provider.model });
    this.set(roomId, {
      phase: 'done',
      suggested,
      concepts,
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

  /**
   * The concepts of a room's materials (ADR 0037): every piece not read yet (or changed since) is read with the
   * concept-reading skill; what is gone from a material goes; then new names are joined to the notebook's concepts
   * (a judge, for names not known), passing ideas that now count become suggested concepts, each concept is
   * defined by its best mention, and the room's concepts get links suggested. Returns how many were suggested.
   */
  private async findConcepts(roomId: string, room: { notebookId: string; title: string; members: RoomItemRef[] }): Promise<number> {
    const notebookId = room.notebookId;
    const plans = room.members.flatMap((item) => {
      const now = this.repo.materialPieces(item);
      if (!now) return [];
      const read = this.repo.readPieces(item);
      return [{ item, now, joins: this.repo.materialJoins(item), todo: now.pieces.filter((p) => !read.has(p.hash)) }];
    });
    const total = plans.reduce((n, p) => n + p.todo.length, 0);
    this.set(roomId, { phase: 'concepts', done: 0, total, current: [] });
    this.repo.ensureConceptNames(notebookId);
    for (const p of plans) this.repo.settleMaterial(p.item, p.now);
    const known = this.repo.conceptKnownNames(notebookId);
    const provider = this.models.current();
    const queue = plans.flatMap((p) => p.todo.map((piece) => ({ plan: p, piece, n: p.now.pieces.indexOf(piece) + 1 })));
    let failed = 0;
    let stop = false;
    const worker = async () => {
      for (let job = queue.shift(); job && !stop; job = queue.shift()) {
        const { plan, piece, n } = job;
        try {
          let raw = '';
          for await (const ev of provider.stream({
            messages: pieceRequest(plan.now.text, piece.text, { n, of: plan.now.pieces.length }, known),
            maxTokens: 2200,
            light: true,
            purpose: 'concepts',
            signal: AbortSignal.timeout(120_000),
          })) {
            if (ev.type === 'text') raw += ev.text;
          }
          const mentions = readMentions(raw, piece.text);
          if (!mentions) throw new Error('the concepts of a piece could not be read');
          this.repo.savePiece(notebookId, plan.item, piece, plan.now.text, mentions, plan.joins, provider.model);
        } catch (err) {
          failed += 1;
          if (err instanceof ProviderError) {
            if (['auth', 'quota', 'not_configured'].includes(err.kind)) stop = true;
          } else {
            this.log.warn('a piece could not be read for its concepts', { err });
          }
        }
        this.set(roomId, { done: (this.readings.get(roomId)?.done ?? 0) + 1 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
    if (failed > 0) this.log.warn('pieces not read for their concepts', { failed, total });

    // New names: the same as a concept known (asked when there are concepts), the same as each other, or new.
    const passing = this.repo.unjoinedMentions(notebookId, room.members);
    const named = [...passing].map(([key, list]) => ({ key, name: commonName(list), list }));
    const groups = new Map<string, string[]>(named.map((x) => [x.key, [x.key]]));
    if (named.length > 0) {
      const titles = this.repo.conceptKnownNames(notebookId).slice(0, 200);
      const fresh = named.slice(0, 80).map((x) => x.name);
      let raw = '';
      try {
        if (titles.length > 0 || fresh.length > 1) {
          for await (const ev of provider.stream({
            messages: joinRequest(fresh, titles),
            maxTokens: 1200,
            light: true,
            purpose: 'concept-join',
            signal: AbortSignal.timeout(90_000),
          })) {
            if (ev.type === 'text') raw += ev.text;
          }
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) this.log.warn('new concept names could not be judged', { err });
      }
      const same = raw ? (readJoin(raw, fresh, titles) ?? new Map()) : new Map<string, string | null>();
      const keyOf = new Map(named.map((x) => [x.name, x.key]));
      for (const [name, to] of same) {
        if (!to) continue;
        const from = keyOf.get(name);
        if (!from) continue;
        const into = this.repo.conceptIdByTitle(notebookId, to);
        if (into) {
          this.repo.joinMentions(notebookId, groups.get(from) ?? [from], into);
          groups.delete(from);
          continue;
        }
        // The same as another new name: one group, under the other.
        const other = keyOf.get(to);
        if (other && other !== from && groups.has(other) && groups.has(from)) {
          groups.set(other, [...(groups.get(other) ?? []), ...(groups.get(from) ?? [])]);
          groups.delete(from);
        }
      }
    }
    let suggested = 0;
    for (const [key, keys] of groups) {
      const list = keys.flatMap((k) => passing.get(k) ?? []);
      if (list.length === 0 || !becomesConcept(list)) continue;
      const lead = passing.get(key) ?? list;
      this.repo.suggestConcept(notebookId, commonName(lead), keys);
      suggested += 1;
    }
    this.repo.refreshConcepts(notebookId);

    // Links among the room's concepts, when there is something new to link.
    const concepts = this.repo.roomConceptsForLinks(roomId);
    if (concepts.length >= 2 && (suggested > 0 || total > 0)) {
      try {
        let raw = '';
        for await (const ev of provider.stream({
          messages: conceptLinksRequest(room.title, concepts.map((c) => ({ name: c.title, says: c.says }))),
          maxTokens: 1500,
          light: true,
          purpose: 'concept-links',
          signal: AbortSignal.timeout(90_000),
        })) {
          if (ev.type === 'text') raw += ev.text;
        }
        const kept = new Set(concepts.flatMap((c, i) => (c.status === 'kept' ? [i + 1] : [])));
        const drafts = readConceptLinks(raw, concepts.length, kept) ?? [];
        const linked = new Set(this.repo.conceptLinks(notebookId).map((l) => [l.from, l.to].sort().join('|')));
        for (const l of drafts) {
          const from = concepts[l.from - 1]?.id;
          const to = concepts[l.to - 1]?.id;
          if (!from || !to || linked.has([from, to].sort().join('|'))) continue;
          linked.add([from, to].sort().join('|'));
          this.repo.createConceptLink({ id: ulid(), from, to, kind: l.kind, why: l.why || null }, 'ai', 'suggested');
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) this.log.warn('concept links could not be suggested', { err });
      }
    }
    return suggested;
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
