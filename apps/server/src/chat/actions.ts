// Changes the Assistant proposes (ADR 0024). The model asks for a change with
// a tool; planAction checks it and resolves its labels and words to ids and
// offsets, and it is kept as a proposal. Nothing happens until the learner
// taps Do it: AssistantActions runs it through the same store calls as the
// app's own buttons, and keeps what it made, so it can be opened and undone.
// "show" is the exception: it only takes the learner somewhere, at once.

import {
  ACTION_KINDS,
  ActionArgs,
  type ActionKind,
  type AssistantAction,
  type Note,
  noteFile,
  pageOfHeading,
  ShowArgs,
  type Source,
  sourceHeadings,
  type ToolCall,
  ulid,
  type VaultTarget,
} from '@noema/core';
import { FileProblem, type Folders } from '../files/folders.ts';
import { HttpError } from '../http/router.ts';
import type { Logger } from '../log.ts';
import { type AskPair, ConflictError, InvalidError, NotFoundError, type Repo, type StoredAction } from '../store/repo.ts';
import type { Passage, VaultLookup } from './assistant.ts';
import { fullTranscript } from './merges.ts';

export const ACTION_TOOL_NAMES = new Set<string>(['show', ...ACTION_KINDS]);

/** What a planned change is: shown to the learner, and what it needs to run. */
export interface Plan {
  kind: ActionKind | 'show';
  summary: string;
  payload: Record<string, unknown>;
  /** Where it is (for show, where to go). */
  open: VaultTarget | null;
}

const q = (title: string) => `“${title || 'Untitled'}”`;
function short(text: string, max = 80): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
function bare<T extends VaultTarget>(t: T): T {
  const { quote: _q, excerpt: _e, ...rest } = t;
  return rest as T;
}

/** A change the model asked for, checked and resolved; or why it cannot be, told back to the model. */
export async function planAction(
  vault: VaultLookup,
  repo: Repo,
  call: ToolCall,
  folders: Folders | null = null,
): Promise<Plan | { refused: string }> {
  let raw: unknown;
  try {
    raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch {
    return { refused: 'The arguments were not valid JSON.' };
  }
  const target = (ref: number): VaultTarget | string => vault.target(String(ref)) ?? `There is no label [${ref}] in this answer.`;
  const thread = (ref: number): (VaultTarget & { kind: 'thread' }) | string => {
    const t = target(ref);
    if (typeof t === 'string') return t;
    return t.kind === 'thread' ? t : `[${ref}] is not a thread.`;
  };
  if (call.name === 'show') {
    const a = ShowArgs.safeParse(raw);
    if (!a.success) return { refused: 'Give a label number: {"ref": 3}.' };
    const t = target(a.data.ref);
    if (typeof t === 'string') return { refused: t };
    let open = bare(t);
    if (a.data.page !== undefined && t.kind === 'source') {
      const detail = repo.sourceDetail(t.sourceId, t.versionId);
      const page = sourceHeadings(detail?.version.content ?? '').find(
        (h) => h.level === 2 && pageOfHeading(h.text) === a.data.page,
      );
      if (!page) return { refused: `That source has no page ${a.data.page}.` };
      open = { ...t, at: page.start };
    }
    return { kind: 'show', summary: `Showed you ${q(t.title)}`, payload: {}, open };
  }
  if (!(ACTION_KINDS as string[]).includes(call.name)) return { refused: 'There is no such tool.' };
  const kind = call.name as ActionKind;
  const parsed = ActionArgs[kind].safeParse(raw);
  if (!parsed.success) return { refused: `The arguments do not fit: ${parsed.error.issues[0]?.message ?? 'check them'}.` };
  const args = parsed.data as Record<string, unknown>;
  const passage = (ref: number, quote: string): Passage | string => vault.passage(ref, quote);
  const where = (p: Passage): VaultTarget =>
    p.kind === 'message'
      ? { kind: 'thread', threadId: p.threadId, messageId: p.messageId, title: p.title }
      : { kind: 'source', sourceId: p.sourceId, versionId: p.versionId, at: p.start, title: p.title };

  switch (kind) {
    case 'start_thread': {
      const question = args.question as string;
      return { kind, summary: `Start a thread: “${short(question)}”`, payload: { question }, open: null };
    }
    case 'ask_in_thread': {
      const t = thread(args.ref as number);
      if (typeof t === 'string') return { refused: t };
      const question = args.question as string;
      return {
        kind,
        summary: `Ask in ${q(t.title)}: “${short(question)}”`,
        payload: { threadId: t.threadId, question },
        open: { ...bare(t), messageId: null },
      };
    }
    case 'ask_about_passage': {
      const p = passage(args.ref as number, args.quote as string);
      if (typeof p === 'string') return { refused: p };
      const question = args.question as string;
      return {
        kind,
        summary: `Ask about “${short(p.exact, 60)}” in ${q(p.title)}: “${short(question)}”`,
        payload: { passage: p, question },
        open: where(p),
      };
    }
    case 'create_note': {
      const title = args.title as string;
      return { kind, summary: `Make a note ${q(title)}`, payload: { title, content: args.content }, open: null };
    }
    case 'add_to_note':
    case 'change_note_block': {
      const t = target(args.ref as number);
      if (typeof t === 'string') return { refused: t };
      if (t.kind !== 'note') return { refused: `[${args.ref}] is not a note or a block of one.` };
      if (kind === 'change_note_block' && !t.blockId) return { refused: 'Give the label of one block of the note (open the note to see them).' };
      const note = repo.getNote(t.noteId);
      if (!note || note.deletedAt) return { refused: 'That note is not in the notebook any more.' };
      const content = args.content as string;
      return {
        kind,
        summary:
          kind === 'add_to_note'
            ? `Add to the note ${q(t.title)}: “${short(content, 60)}”`
            : `Suggest a new version of a block in ${q(t.title)}: “${short(content, 60)}”`,
        payload: { noteId: t.noteId, blockId: t.blockId, content },
        open: bare(t),
      };
    }
    case 'note_from_thread': {
      const t = thread(args.ref as number);
      if (typeof t === 'string') return { refused: t };
      return { kind, summary: `Turn ${q(t.title)} into a note`, payload: { threadId: t.threadId, title: t.title }, open: null };
    }
    case 'put_in_room': {
      const items: Array<{ kind: 'thread' | 'source' | 'note'; id: string; title: string }> = [];
      for (const ref of args.refs as number[]) {
        const t = target(ref);
        if (typeof t === 'string') return { refused: t };
        const item =
          t.kind === 'thread'
            ? { kind: 'thread' as const, id: t.threadId, title: t.title }
            : t.kind === 'note'
              ? { kind: 'note' as const, id: t.noteId, title: t.title }
              : { kind: 'source' as const, id: t.sourceId, title: t.title };
        if (!items.some((x) => x.kind === item.kind && x.id === item.id)) items.push(item);
      }
      const title = (args.room as string).trim();
      const notebookId = vault.notebook;
      const room = repo.listRooms(notebookId).find((r) => r.title.trim().toLowerCase() === title.toLowerCase()) ?? null;
      const names = items.map((x) => q(x.title)).join(', ');
      return {
        kind,
        summary: room ? `Put ${names} in the room ${q(room.title)}` : `Make the room ${q(title)} with ${names}`,
        payload: { roomId: room?.id ?? null, title: room?.title ?? title, items: items.map(({ kind: k, id }) => ({ kind: k, id })) },
        open: null,
      };
    }
    case 'rename': {
      const t = target(args.ref as number);
      if (typeof t === 'string') return { refused: t };
      const id = t.kind === 'thread' ? t.threadId : t.kind === 'note' ? t.noteId : t.sourceId;
      const to = args.title as string;
      return {
        kind,
        summary: `Rename ${q(t.title)} to ${q(to)}`,
        payload: { what: t.kind, id, from: t.title, to },
        open: { ...bare(t), title: to },
      };
    }
    case 'pin': {
      const p = passage(args.ref as number, args.quote as string);
      if (typeof p === 'string') return { refused: p };
      let threadId: string;
      let title: string;
      if (args.thread !== undefined) {
        const t = thread(args.thread as number);
        if (typeof t === 'string') return { refused: t };
        threadId = t.threadId;
        title = t.title;
      } else if (p.kind === 'message') {
        threadId = p.threadId;
        title = p.title;
      } else {
        return { refused: 'Say which thread to pin a passage of a source to (thread: its label).' };
      }
      return {
        kind,
        summary: `Pin “${short(p.exact, 60)}” to ${q(title)}`,
        payload: { threadId, passage: p },
        open: { kind: 'thread', threadId, messageId: null, title },
      };
    }
    case 'unpin': {
      const t = thread(args.thread as number);
      if (typeof t === 'string') return { refused: t };
      const words = (args.quote as string).replace(/\s+/g, ' ').trim();
      const pin = repo.pinsFor(t.threadId).find((p) => p.threadId === t.threadId && p.exact.replace(/\s+/g, ' ').includes(words));
      if (!pin) return { refused: `No passage with those words is pinned to ${q(t.title)}.` };
      const at = pin.message
        ? { message: { messageId: pin.message.messageId, revisionId: pin.message.revisionId, start: pin.message.start, end: pin.message.end } }
        : { source: { versionId: pin.source?.versionId, start: pin.source?.start, end: pin.source?.end } };
      return {
        kind,
        summary: `Unpin “${short(pin.exact, 60)}” from ${q(t.title)}`,
        payload: { threadId: t.threadId, pinId: pin.id, at },
        open: { ...bare(t), messageId: null },
      };
    }
    case 'merge_threads': {
      const from = thread(args.from as number);
      if (typeof from === 'string') return { refused: from };
      const into = thread(args.into as number);
      if (typeof into === 'string') return { refused: into };
      if (from.threadId === into.threadId) return { refused: 'A thread cannot be merged into itself.' };
      return {
        kind,
        summary: `Merge ${q(from.title)} into ${q(into.title)} (you review the summary there)`,
        payload: { from: from.threadId, into: into.threadId },
        open: { ...bare(into), messageId: null },
      };
    }
    case 'move_to_trash':
    case 'restore': {
      const t = target(args.ref as number);
      if (typeof t === 'string') return { refused: t };
      const id = t.kind === 'thread' ? t.threadId : t.kind === 'note' ? t.noteId : t.sourceId;
      return {
        kind,
        summary: kind === 'move_to_trash' ? `Move ${q(t.title)} to the Trash` : `Restore ${q(t.title)} from the Trash`,
        payload: { what: t.kind, id, title: t.title },
        open: kind === 'restore' ? bare(t) : null,
      };
    }
    case 'add_source': {
      const { url, text, title } = args as { url?: string; text?: string; title?: string };
      return {
        kind,
        summary: url ? `Add the page ${short(url, 70)} as a source` : `Add ${q(title ?? short(text ?? '', 40))} as a source`,
        payload: { url: url ?? null, text: text ?? null, title: title ?? null },
        open: null,
      };
    }
    case 'write_file':
    case 'edit_file':
    case 'save_note_to_file':
    case 'note_from_file': {
      if (!folders) return { refused: 'Files are not available here.' };
      const at = vault.filePath(args.path as string);
      if (typeof at === 'string') return { refused: at };
      if (!at.rel) return { refused: 'Give the path of a file inside the folder.' };
      const shown = `${at.folder}/${at.rel}`;
      if (kind === 'note_from_file') {
        return { kind, summary: `Make a note from “${shown}”`, payload: { folderId: at.folderId, rel: at.rel }, open: null };
      }
      if (kind === 'save_note_to_file') {
        const t = target(args.ref as number);
        if (typeof t === 'string') return { refused: t };
        if (t.kind !== 'note') return { refused: `[${args.ref}] is not a note.` };
        const rel = /\.(md|markdown)$/i.test(at.rel) ? at.rel : `${at.rel}.md`;
        const there = await folders.read(at.folderId, rel).then(
          () => true,
          () => false,
        );
        return {
          kind,
          summary: `Save the note ${q(t.title)} as “${at.folder}/${rel}”${there ? ' (it replaces the file there)' : ''}`,
          payload: { noteId: t.noteId, folderId: at.folderId, rel },
          open: null,
        };
      }
      // What is there now, to replace a part of it, or to say the file is replaced.
      let current: { text: string; hash: string } | null = null;
      try {
        const read = await folders.read(at.folderId, at.rel);
        if (read.kind !== 'text') return { refused: 'That file is not text: only text files can be written.' };
        current = { text: read.text, hash: read.hash };
      } catch (err) {
        if (kind === 'edit_file') return { refused: err instanceof Error ? err.message : 'That file cannot be read.' };
      }
      if (kind === 'edit_file') {
        const text = (current as { text: string }).text;
        const old = args.old as string;
        const first = text.indexOf(old);
        if (first < 0) return { refused: 'Those words are not in the file: open it and copy the old text exactly.' };
        if (text.indexOf(old, first + 1) >= 0) return { refused: 'That text is in the file more than once: give more of it, so it is found once.' };
        const content = text.slice(0, first) + (args.new as string) + text.slice(first + old.length);
        return {
          kind,
          summary: `Edit “${shown}”`,
          payload: { folderId: at.folderId, rel: at.rel, content, expectHash: current?.hash ?? null, detail: diffOf(old, args.new as string) },
          open: null,
        };
      }
      const content = args.content as string;
      return {
        kind,
        summary: current ? `Write a new text for “${shown}” (it replaces what is there)` : `Make the file “${shown}”`,
        payload: {
          folderId: at.folderId,
          rel: at.rel,
          content,
          expectHash: current?.hash ?? null,
          detail: content.length > 1500 ? `${content.slice(0, 1500)}\n…` : content,
        },
        open: null,
      };
    }
  }
}

/** What an edit changes, as lines taken out and put in. */
function diffOf(old: string, next: string): string {
  const cut = (t: string) => (t.length > 700 ? `${t.slice(0, 700)}…` : t);
  const lines = (prefix: string, t: string) =>
    cut(t)
      .split('\n')
      .map((l) => `${prefix} ${l}`)
      .join('\n');
  return `${lines('-', old)}\n${lines('+', next)}`;
}

/** A stored change as the learner is shown it. */
export function actionView(a: StoredAction): AssistantAction {
  const result = a.result as { open?: VaultTarget | null; undo?: unknown } | null;
  return {
    id: a.id,
    messageId: a.messageId,
    kind: a.kind as AssistantAction['kind'],
    summary: a.summary,
    detail: typeof a.payload.detail === 'string' ? a.payload.detail : null,
    status: a.status,
    error: a.error,
    open: result?.open ?? (a.payload.open as VaultTarget | null | undefined) ?? null,
    undoable: a.status === 'done' && Boolean(result?.undo),
    createdAt: a.createdAt,
  };
}

export interface ActionDeps {
  repo: Repo;
  log: Logger;
  /** Start answering a question just asked. */
  answer: (notebookId: string, threadId: string, pair: AskPair) => void;
  /** Write a note from a thread (the AI, as Rewrite as note). */
  writeNote: (noteId: string, threadId: string) => void;
  /** Draft what a merge carries. */
  draftMerge: (mergeId: string) => void;
  /** Stop an answer still being written (before what it is in goes to the Trash). */
  stopAnswer: (messageId: string) => Promise<void>;
  /** Add a source: a page read from its address, or text. */
  addSource: (notebookId: string, id: string, input: { url: string | null; text: string | null; title: string | null }) => Promise<Source>;
  /** Files of linked folders (ADR 0025). */
  folders: Folders;
  /** A note from a text file of a folder. */
  noteFromFile: (notebookId: string, id: string, folderId: string, path: string) => Promise<Note>;
}

type Undo =
  | { trash: { what: 'thread' | 'note' | 'source'; id: string } }
  | { restore: { what: 'thread' | 'note' | 'source'; id: string } }
  | { block: { noteId: string; blockId: string } }
  | { proposal: { noteId: string; blockId: string } }
  | { rename: { what: 'thread' | 'note' | 'source'; id: string; title: string } }
  | { unpin: { pinId: string } }
  | { repin: { threadId: string; at: Record<string, unknown> } }
  | { merge: { mergeId: string } }
  | { file: { backupId: string } }
  | { room: { roomId: string; made: boolean; before: Array<{ kind: 'thread' | 'source' | 'note'; id: string; state: 'in' | 'out' | 'placed' | null }> } };

/** Runs, cancels and undoes what the Assistant proposed. */
export class AssistantActions {
  private readonly deps: ActionDeps;

  constructor(deps: ActionDeps) {
    this.deps = deps;
  }

  list(threadId: string): AssistantAction[] {
    return this.deps.repo.actionsOfThread(threadId).map(actionView);
  }

  cancel(id: string): AssistantAction {
    const { repo } = this.deps;
    const a = repo.setAction(id, ['proposed'], 'cancelled') ?? repo.getAction(id);
    if (!a) throw new NotFoundError('action');
    return actionView(a);
  }

  async run(id: string): Promise<AssistantAction> {
    const { repo, log } = this.deps;
    const claimed = repo.setAction(id, ['proposed', 'failed'], 'running');
    if (!claimed) {
      const a = repo.getAction(id);
      if (!a) throw new NotFoundError('action');
      return actionView(a);
    }
    try {
      const result = await this.execute(claimed);
      return actionView(repo.setAction(id, ['running'], 'done', { result, error: null }) as StoredAction);
    } catch (err) {
      const error = plain(err);
      if (error === null) log.error('assistant action failed', { kind: claimed.kind, err });
      return actionView(repo.setAction(id, ['running'], 'failed', { error: error ?? 'It could not be done.' }) as StoredAction);
    }
  }

  async undo(id: string): Promise<AssistantAction> {
    const { repo } = this.deps;
    const a = repo.getAction(id);
    if (!a) throw new NotFoundError('action');
    const undo = (a.result as { undo?: Undo } | null)?.undo;
    if (a.status !== 'done' || !undo) throw new ConflictError('this cannot be undone');
    // A thread it started may still be answering: stop that first.
    if ('trash' in undo && undo.trash.what === 'thread') {
      for (const m of repo.listMessages(undo.trash.id)) {
        if (m.status === 'pending' || m.status === 'streaming') await this.deps.stopAnswer(m.id);
      }
    }
    try {
      await this.reverse(undo);
    } catch (err) {
      if (err instanceof FileProblem) throw new ConflictError(err.message);
      throw err;
    }
    return actionView(repo.setAction(id, ['done'], 'undone') as StoredAction);
  }

  private notebookOf(a: StoredAction): string {
    const m = this.deps.repo.getMessage(a.messageId);
    const t = m ? this.deps.repo.getThread(m.threadId) : null;
    if (!t) throw new NotFoundError('thread');
    return t.notebookId;
  }

  private async execute(a: StoredAction): Promise<{ open: VaultTarget | null; undo?: Undo }> {
    const { repo } = this.deps;
    const p = a.payload as Record<string, unknown>;
    const ask = (threadId: string, pair: AskPair) => this.deps.answer(this.notebookOf(a), threadId, pair);
    switch (a.kind as ActionKind) {
      case 'start_thread': {
        const threadId = ulid();
        repo.createThread(this.notebookOf(a), threadId, '');
        const { pair } = repo.createAsk(threadId, ulid(), p.question as string);
        ask(threadId, pair);
        return {
          open: { kind: 'thread', threadId, messageId: null, title: short(p.question as string) },
          undo: { trash: { what: 'thread', id: threadId } },
        };
      }
      case 'ask_in_thread': {
        const threadId = p.threadId as string;
        const { pair } = repo.createAsk(threadId, ulid(), p.question as string);
        ask(threadId, pair);
        return { open: { kind: 'thread', threadId, messageId: pair.assistant.id, title: repo.getThread(threadId)?.title ?? '' } };
      }
      case 'ask_about_passage': {
        const passage = p.passage as Passage;
        const id = ulid();
        const question = { id: ulid(), content: p.question as string };
        const made =
          passage.kind === 'message'
            ? repo.createBranch(
                passage.threadId,
                id,
                { messageId: passage.messageId, revisionId: passage.revisionId, start: passage.start, end: passage.end },
                question,
              )
            : repo.createSourceThread(passage.sourceId, id, { versionId: passage.versionId, start: passage.start, end: passage.end }, question);
        ask(made.thread.id, made.pair);
        return {
          open: { kind: 'thread', threadId: made.thread.id, messageId: null, title: short(question.content) },
          undo: { trash: { what: 'thread', id: made.thread.id } },
        };
      }
      case 'create_note': {
        const noteId = ulid();
        const title = p.title as string;
        repo.createNote(noteId, this.notebookOf(a), title);
        const blockId = suggestBlock(repo, noteId, null, p.content as string);
        return { open: { kind: 'note', noteId, blockId, title }, undo: { trash: { what: 'note', id: noteId } } };
      }
      case 'add_to_note': {
        const noteId = p.noteId as string;
        const note = repo.getNote(noteId);
        if (!note) throw new NotFoundError('note');
        const after = (p.blockId as string | null) ?? note.blocks.at(-1)?.id ?? null;
        const blockId = suggestBlock(repo, noteId, after, p.content as string);
        return { open: { kind: 'note', noteId, blockId, title: note.title }, undo: { block: { noteId, blockId } } };
      }
      case 'change_note_block': {
        const noteId = p.noteId as string;
        const blockId = p.blockId as string;
        repo.startProposal(noteId, blockId, 'From the Assistant');
        repo.finishProposal(blockId, p.content as string, 'ready', null);
        return {
          open: { kind: 'note', noteId, blockId, title: repo.getNote(noteId)?.title ?? '' },
          undo: { proposal: { noteId, blockId } },
        };
      }
      case 'note_from_thread': {
        const threadId = p.threadId as string;
        const thread = repo.getThread(threadId);
        if (!thread) throw new NotFoundError('thread');
        const noteId = ulid();
        const { note, created } = repo.startNote(noteId, thread.notebookId, threadId, thread.title || 'Untitled');
        if (created) this.deps.writeNote(note.id, threadId);
        return { open: { kind: 'note', noteId: note.id, blockId: null, title: note.title }, undo: { trash: { what: 'note', id: note.id } } };
      }
      case 'put_in_room': {
        const items = p.items as Array<{ kind: 'thread' | 'source' | 'note'; id: string }>;
        const existing = p.roomId ? repo.getRoom(p.roomId as string) : null;
        if (!existing) {
          const id = ulid();
          repo.createRoom(id, this.notebookOf(a), p.title as string, items, 'assistant');
          return { open: null, undo: { room: { roomId: id, made: true, before: [] } } };
        }
        const before = items.map((x) => ({ ...x, state: repo.roomItemState(existing.id, x) }));
        repo.addRoomItems(existing.id, items, 'assistant');
        return { open: null, undo: { room: { roomId: existing.id, made: false, before } } };
      }
      case 'rename': {
        const what = p.what as 'thread' | 'note' | 'source';
        rename(repo, what, p.id as string, p.to as string);
        return { open: a.payload.open as VaultTarget, undo: { rename: { what, id: p.id as string, title: p.from as string } } };
      }
      case 'pin': {
        const passage = p.passage as Passage;
        const at =
          passage.kind === 'message'
            ? { message: { messageId: passage.messageId, revisionId: passage.revisionId, start: passage.start, end: passage.end } }
            : { source: { versionId: passage.versionId, start: passage.start, end: passage.end } };
        const pinId = ulid();
        repo.createPin(p.threadId as string, pinId, at);
        return {
          open: { kind: 'thread', threadId: p.threadId as string, messageId: null, title: repo.getThread(p.threadId as string)?.title ?? '' },
          undo: { unpin: { pinId } },
        };
      }
      case 'unpin': {
        if (!repo.deletePin(p.pinId as string)) throw new InvalidError('that passage is not pinned any more');
        return {
          open: { kind: 'thread', threadId: p.threadId as string, messageId: null, title: repo.getThread(p.threadId as string)?.title ?? '' },
          undo: { repin: { threadId: p.threadId as string, at: p.at as Record<string, unknown> } },
        };
      }
      case 'merge_threads': {
        const from = p.from as string;
        const id = ulid();
        const { merge, created } = repo.startMerge(id, from, p.into as string, 'summary', () => fullTranscript(repo, from));
        if (created && merge.status === 'drafting') this.deps.draftMerge(merge.id);
        return {
          open: { kind: 'thread', threadId: p.into as string, messageId: null, title: repo.getThread(p.into as string)?.title ?? '' },
          undo: { merge: { mergeId: merge.id } },
        };
      }
      case 'move_to_trash': {
        const what = p.what as 'thread' | 'note' | 'source';
        trash(repo, what, p.id as string);
        return { open: null, undo: { restore: { what, id: p.id as string } } };
      }
      case 'restore': {
        const what = p.what as 'thread' | 'note' | 'source';
        restore(repo, what, p.id as string);
        return { open: a.payload.open as VaultTarget | null, undo: { trash: { what, id: p.id as string } } };
      }
      case 'write_file':
      case 'edit_file': {
        const folderId = p.folderId as string;
        const rel = p.rel as string;
        const backupId = await this.deps.folders.write(folderId, rel, p.content as string, { expectHash: (p.expectHash as string | null) ?? null });
        // Read again, so the source (if it was opened) shows the new text.
        const source = await this.deps.folders.open(folderId, rel).catch(() => null);
        return {
          open: source ? { kind: 'source', sourceId: source.id, versionId: source.latestVersionId, at: 0, title: source.title } : null,
          undo: { file: { backupId } },
        };
      }
      case 'save_note_to_file': {
        const note = repo.getNote(p.noteId as string);
        if (!note) throw new NotFoundError('note');
        const backupId = await this.deps.folders.write(p.folderId as string, p.rel as string, noteFile(note.title, note.blocks.map((b) => b.content)));
        return { open: { kind: 'note', noteId: note.id, blockId: null, title: note.title }, undo: { file: { backupId } } };
      }
      case 'note_from_file': {
        const note = await this.deps.noteFromFile(this.notebookOf(a), ulid(), p.folderId as string, p.rel as string);
        return { open: { kind: 'note', noteId: note.id, blockId: null, title: note.title }, undo: { trash: { what: 'note', id: note.id } } };
      }
      case 'add_source': {
        const id = ulid();
        const source = await this.deps.addSource(this.notebookOf(a), id, {
          url: p.url as string | null,
          text: p.text as string | null,
          title: p.title as string | null,
        });
        return {
          open: { kind: 'source', sourceId: source.id, versionId: source.latestVersionId, at: 0, title: source.title },
          undo: { trash: { what: 'source', id: source.id } },
        };
      }
    }
  }

  private async reverse(undo: Undo): Promise<void> {
    const { repo } = this.deps;
    if ('file' in undo) await this.deps.folders.undo(undo.file.backupId);
    else if ('trash' in undo) trash(repo, undo.trash.what, undo.trash.id);
    else if ('restore' in undo) restore(repo, undo.restore.what, undo.restore.id);
    else if ('block' in undo) repo.deleteBlock(undo.block.noteId, undo.block.blockId);
    else if ('proposal' in undo) repo.discardProposal(undo.proposal.noteId, undo.proposal.blockId);
    else if ('rename' in undo) rename(repo, undo.rename.what, undo.rename.id, undo.rename.title);
    else if ('room' in undo) {
      if (undo.room.made) repo.deleteRoom(undo.room.roomId);
      else for (const x of undo.room.before) repo.setRoomItemState(undo.room.roomId, x, x.state);
    }
    else if ('unpin' in undo) repo.deletePin(undo.unpin.pinId);
    else if ('repin' in undo) repo.createPin(undo.repin.threadId, ulid(), undo.repin.at as Parameters<Repo['createPin']>[2]);
    else if ('merge' in undo) {
      const merge = repo.getMerge(undo.merge.mergeId);
      if (merge?.status === 'merged') repo.undoMerge(merge.id);
      else if (merge && merge.status !== 'discarded' && merge.status !== 'undone') repo.discardMerge(merge.id);
    }
  }
}

/** Text from the Assistant into a note: a new block holding it as a suggestion the learner accepts. */
function suggestBlock(repo: Repo, noteId: string, after: string | null, content: string): string {
  const blockId = ulid();
  repo.insertBlock(noteId, { id: blockId, after, ask: 'From the Assistant' });
  repo.finishProposal(blockId, content, 'ready', null);
  return blockId;
}

function rename(repo: Repo, what: 'thread' | 'note' | 'source', id: string, title: string): void {
  if (what === 'thread') {
    if (!repo.getThread(id)) throw new NotFoundError('thread');
    repo.setTitle(id, title, 'user');
  } else if (what === 'note') {
    if (!repo.renameNote(id, title)) throw new NotFoundError('note');
  } else {
    repo.renameSource(id, title);
  }
}

function trash(repo: Repo, what: 'thread' | 'note' | 'source', id: string): void {
  if (what === 'thread') repo.deleteThread(id);
  else if (what === 'note') repo.deleteNote(id);
  else repo.deleteSource(id);
}

function restore(repo: Repo, what: 'thread' | 'note' | 'source', id: string): void {
  if (what === 'thread') repo.restoreThread(id);
  else if (what === 'note') repo.restoreNote(id);
  else repo.restoreSource(id);
}

/** A failure the learner can read, or null for one that is ours (logged). */
function plain(err: unknown): string | null {
  if (err instanceof HttpError || err instanceof FileProblem) return err.message;
  if (err instanceof ConflictError || err instanceof InvalidError || err instanceof NotFoundError) {
    const m = err.message;
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;
  }
  return null;
}
