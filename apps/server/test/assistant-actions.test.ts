import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AssistantAction,
  type Message,
  type MessageContext,
  type Note,
  type Source,
  type Thread,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { api, readEvents, type SseEvent, startServer, type TestServer } from './helpers.ts';

// Changes the Assistant proposes (ADR 0024): nothing happens until the
// learner runs one; then it is done through the same store calls as the
// app's buttons, can be opened, and undone. Show takes the learner somewhere
// at once. Quotes are checked against the original; where the learner is
// goes with the question. The fake model calls what [[call:…]] says.

interface World {
  s: TestServer;
  notebookId: string;
  chatId: string;
  noteId: string;
  source: Source;
  assistantId: string;
}

// A fresh notebook for each test, so labels are known: [1] the source, [2] the note, [3] the thread.
async function world(): Promise<World> {
  const s = await startServer();
  const notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
  const chatId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: chatId });
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${chatId}/messages`, {
    id: ulid(),
    content: 'What is the variance of a sum?',
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const source = (
    await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, {
      id: ulid(),
      text: '# Week 4: Parallelism\n\nEach worker holds a copy of the model and a shard of the batch.',
    })
  ).json;
  const noteId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: noteId, title: 'Variance notes' });
  await api(s, 'POST', `/api/notes/${noteId}/blocks`, { id: ulid(), after: null, content: 'Variances add for independent terms.' });
  const assistantId = (await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json.id;
  return { s, notebookId, chatId, noteId, source, assistantId };
}

async function ask(w: World, content: string, place?: unknown) {
  const r = await api<{ assistant: { id: string } }>(w.s, 'POST', `/api/threads/${w.assistantId}/messages`, {
    id: ulid(),
    content,
    ...(place ? { place } : {}),
  });
  const events: SseEvent[] = await readEvents(`${w.s.base}/api/messages/${r.json.assistant.id}/events`);
  const detail = (await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.assistantId}`)).json;
  const answer = detail.messages.find((m) => m.id === r.json.assistant.id) as Message;
  const actions = (await api<{ actions: AssistantAction[] }>(w.s, 'GET', `/api/threads/${w.assistantId}/actions`)).json.actions.filter(
    (a) => a.messageId === answer.id,
  );
  return { answer, events, actions };
}

const call = (name: string, args: unknown) => `[[call:${name}:${JSON.stringify(args)}]]`;
const run = async (w: World, a: AssistantAction, what: 'run' | 'cancel' | 'undo' = 'run') =>
  api<{ action: AssistantAction }>(w.s, 'POST', `/api/assistant/actions/${a.id}/${what}`, {});
const threads = async (w: World) =>
  (await api<{ threads: Thread[] }>(w.s, 'GET', `/api/notebooks/${w.notebookId}/threads`)).json.threads;
const toolResults = async (w: World, messageId: string) =>
  ((await api<MessageContext>(w.s, 'GET', `/api/messages/${messageId}/context`)).json.request ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);

test('a change is proposed, not done: the learner runs it, opens what it made, and can undo it', async () => {
  const w = await world();
  try {
    const before = (await threads(w)).length;
    const { events, actions, answer } = await ask(w, `Start one for me ${call('start_thread', { question: 'What is all-reduce?' })}`);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.status, 'proposed');
    assert.equal(actions[0]?.summary, 'Start a thread: “What is all-reduce?”');
    assert.ok(events.some((e) => e.event === 'action'), 'proposed as the answer is written');
    assert.match((await toolResults(w, answer.id))[0] ?? '', /^Proposed to the learner; it happens only when they tap Do it/);
    assert.equal((await threads(w)).length, before, 'nothing made yet');

    const done = (await run(w, actions[0] as AssistantAction)).json.action;
    assert.equal(done.status, 'done');
    assert.equal(done.undoable, true);
    assert.equal(done.open?.kind, 'thread');
    const made = done.open?.kind === 'thread' ? done.open.threadId : '';
    const detail = (await api<ThreadDetail>(w.s, 'GET', `/api/threads/${made}`)).json;
    assert.equal(detail.messages[0]?.content, 'What is all-reduce?');
    // A second tap does nothing more.
    assert.equal((await run(w, done)).json.action.status, 'done');
    assert.equal((await threads(w)).length, before + 1);
    const undoRes = await run(w, done, 'undo');
    const undone = undoRes.json.action;
    assert.equal(undoRes.status, 200, JSON.stringify(undoRes.json));
    assert.equal(undone.status, 'undone');
    assert.ok((await api<ThreadDetail>(w.s, 'GET', `/api/threads/${made}`)).json.thread.deletedAt);
    assert.equal((await run(w, undone, 'undo')).status, 409);
  } finally {
    w.s.close();
  }
});

test('cancelled stays cancelled; a refused change is told to the model and not proposed', async () => {
  const w = await world();
  try {
    const { actions, answer } = await ask(
      w,
      `Do things ${call('pin', { ref: 1, quote: 'shard of the batch' })} ${call('rename', { ref: 42, title: 'X' })} ${call('ask_about_passage', { ref: 1, quote: 'not in it at all', question: 'Q' })}`,
    );
    assert.equal(actions.length, 0);
    assert.deepEqual(await toolResults(w, answer.id), [
      'Say which thread to pin a passage of a source to (thread: its label).',
      'There is no label [42] in this answer.',
      'Those words are not in “Week 4: Parallelism”: copy them exactly from what you opened.',
    ]);
    const second = await ask(w, `Rename it ${call('rename', { ref: 3, title: 'Sums of variances' })}`);
    const cancelled = (await run(w, second.actions[0] as AssistantAction, 'cancel')).json.action;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await run(w, cancelled)).json.action.status, 'cancelled');
    assert.equal((await threads(w)).find((t) => t.id === w.chatId)?.title !== 'Sums of variances', true);
  } finally {
    w.s.close();
  }
});

test('threads: a side question on a passage of a source, asking in a thread, renaming; pins and unpins', async () => {
  const w = await world();
  try {
    const { actions } = await ask(
      w,
      `All of it [[together]] ${call('ask_about_passage', { ref: 1, quote: 'a shard of\nthe batch', question: 'Why a shard?' })} ${call('ask_in_thread', { ref: 3, question: 'And for a difference?' })} ${call('rename', { ref: 3, title: 'Sums of variances' })} ${call('pin', { ref: 1, quote: 'shard of the batch', thread: 3 })}`,
    );
    assert.deepEqual(
      actions.map((a) => a.kind),
      ['ask_about_passage', 'ask_in_thread', 'rename', 'pin'],
    );
    const [side, follow, rename, pin] = await Promise.all(actions.map(async (a) => (await run(w, a)).json.action));
    assert.ok([side, follow, rename, pin].every((a) => a?.status === 'done'));
    const sideId = side?.open?.kind === 'thread' ? side.open.threadId : '';
    const sideDetail = (await api<ThreadDetail>(w.s, 'GET', `/api/threads/${sideId}`)).json;
    assert.equal(sideDetail.sourceOrigin?.passage.exact, 'a shard of the batch');
    const chat = (await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.chatId}`)).json;
    assert.equal(chat.thread.title, 'Sums of variances');
    assert.deepEqual(
      chat.messages.filter((m) => m.role === 'user').map((m) => m.content),
      ['What is the variance of a sum?', 'And for a difference?'],
    );
    assert.equal(follow?.undoable, false);
    assert.deepEqual(chat.pins.map((p) => p.exact), ['shard of the batch']);

    // Unpin it, then put it back by undoing.
    const un = await ask(w, `Unpin ${call('unpin', { thread: 3, quote: 'shard' })}`);
    const unpinned = (await run(w, un.actions[0] as AssistantAction)).json.action;
    assert.equal((await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.chatId}`)).json.pins.length, 0);
    await run(w, unpinned, 'undo');
    assert.equal((await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.chatId}`)).json.pins.length, 1);
    // Undo the rename: the old title is back.
    await run(w, rename as AssistantAction, 'undo');
    assert.notEqual((await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.chatId}`)).json.thread.title, 'Sums of variances');
  } finally {
    w.s.close();
  }
});

test('notes: written into the note as suggestions to accept; a thread turned into a note', async () => {
  const w = await world();
  try {
    // [4] is the block of the note, once it is opened.
    const { actions } = await ask(
      w,
      `Notes [[together]] [[open:2]] ${call('create_note', { title: 'All-reduce', content: '# All-reduce\n\nEvery worker ends with the sum.' })} ${call('add_to_note', { ref: 2, content: 'Covariances add a cross term.' })} ${call('note_from_thread', { ref: 3 })}`,
    );
    assert.deepEqual(
      actions.map((a) => a.kind),
      ['create_note', 'add_to_note', 'note_from_thread'],
    );
    const [made, added, fromThread] = await Promise.all(actions.map(async (a) => (await run(w, a)).json.action));
    const madeId = made?.open?.kind === 'note' ? made.open.noteId : '';
    const note = (await api<Note>(w.s, 'GET', `/api/notes/${madeId}`)).json;
    assert.equal(note.title, 'All-reduce');
    assert.equal(note.blocks[0]?.proposal?.status, 'ready');
    assert.equal(note.blocks[0]?.proposal?.text, '# All-reduce\n\nEvery worker ends with the sum.');
    const variance = (await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json;
    assert.deepEqual(
      variance.blocks.map((b) => [b.content, b.proposal?.text ?? null]),
      [
        ['Variances add for independent terms.', null],
        ['', 'Covariances add a cross term.'],
      ],
    );
    await run(w, added as AssistantAction, 'undo');
    assert.equal((await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.blocks.length, 1);
    assert.equal(fromThread?.open?.kind, 'note');

  } finally {
    w.s.close();
  }
});

test('organize and sources: merge, Trash and back, add a source; show takes the learner there at once', async () => {
  const w = await world();
  try {
    const other = ulid();
    await api(w.s, 'POST', `/api/notebooks/${w.notebookId}/threads`, { id: other });
    const r = await api<{ assistant: { id: string } }>(w.s, 'POST', `/api/threads/${other}/messages`, { id: ulid(), content: 'Covariance?' });
    await readEvents(`${w.s.base}/api/messages/${r.json.assistant.id}/events`);
    // Threads newest first: [3] Covariance, [4] the variance thread.
    const { actions } = await ask(
      w,
      `Tidy [[together]] ${call('merge_threads', { from: 3, into: 4 })} ${call('move_to_trash', { ref: 2 })} ${call('add_source', { text: '# Week 5\n\nAdam keeps moving averages.' })} ${call('show', { ref: 1 })}`,
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.status]),
      [
        ['merge_threads', 'proposed'],
        ['move_to_trash', 'proposed'],
        ['add_source', 'proposed'],
        ['show', 'done'],
      ],
    );
    assert.equal(actions[3]?.open?.kind, 'source');
    const merged = (await run(w, actions[0] as AssistantAction)).json.action;
    assert.equal(merged.status, 'done');
    const trashed = (await run(w, actions[1] as AssistantAction)).json.action;
    assert.ok((await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.deletedAt);
    const added = (await run(w, actions[2] as AssistantAction)).json.action;
    assert.equal(added.open?.title, 'Week 5');

    // From the Trash, by its label in the list of what is there.
    await run(w, trashed, 'undo');
    assert.equal((await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.deletedAt, null);
    await api(w.s, 'DELETE', `/api/notes/${w.noteId}`);
    // Labels now: [1] Week 5, [2] Week 4, [3] and [4] the threads; the Trash lists the note as [5].
    const back = await ask(w, `Bring it back [[list:trash]] ${call('restore', { ref: 5 })}`);
    assert.match((await toolResults(w, back.answer.id))[0] ?? '', /^In the Trash: 1\. They can be restored\.\n\[5\] Note “Variance notes”/);
    await run(w, back.actions[0] as AssistantAction);
    assert.equal((await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.deletedAt, null);
  } finally {
    w.s.close();
  }
});

test('a quote is kept only if the words are there; the preview has the text around it', async () => {
  const w = await world();
  try {
    const good = await ask(w, 'Quote it [[quote:a shard of the batch|1]]');
    const ref = good.answer.lookups?.refs['1'];
    assert.equal(ref?.kind, 'source');
    assert.equal(ref?.quote, 'a shard of the batch');
    assert.equal(ref?.kind === 'source' ? ref.at : -1, w.source.id ? (await sourceText(w)).indexOf('a shard') : -1);
    assert.match(ref?.excerpt ?? '', /Each worker holds a copy of the model and a shard of the batch\./);
    const bad = await ask(w, 'Quote it [[quote:a shard of the bath|1]]');
    assert.equal(bad.answer.lookups?.refs['1']?.quote, undefined);
  } finally {
    w.s.close();
  }
});

test('a new version of one block of a note, as a suggestion; the block is unchanged until accepted', async () => {
  const w = await world();
  try {
    // Opening the note [2] labels its block [4].
    const { actions } = await ask(w, `Better [[open:2]] ${call('change_note_block', { ref: 4, content: 'Variances of independent terms add.' })}`);
    const changed = (await run(w, actions[0] as AssistantAction)).json.action;
    assert.equal(changed.status, 'done');
    const block = (await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.blocks[0];
    assert.equal(block?.content, 'Variances add for independent terms.');
    assert.equal(block?.proposal?.text, 'Variances of independent terms add.');
    await run(w, changed, 'undo');
    assert.equal((await api<Note>(w.s, 'GET', `/api/notes/${w.noteId}`)).json.blocks[0]?.proposal, null);
  } finally {
    w.s.close();
  }
});

async function sourceText(w: World): Promise<string> {
  return (await api<{ version: { content: string } }>(w.s, 'GET', `/api/sources/${w.source.id}`)).json.version.content;
}

test('where the learner is, and what they selected, goes with the question', async () => {
  const w = await world();
  try {
    const { answer } = await ask(w, 'What does this mean?', {
      kind: 'source',
      id: w.source.id,
      selection: 'a shard of the batch',
    });
    const question = ((await api<MessageContext>(w.s, 'GET', `/api/messages/${answer.id}/context`)).json.request ?? []).find(
      (m) => m.role === 'user',
    );
    assert.match(question?.content ?? '', /## Where the learner is\n\[1\] They are reading the source “Week 4: Parallelism”\.\nThey selected this \[4\]:\n> a shard of the batch\n\nWhat does this mean\?$/);
  } finally {
    w.s.close();
  }
});
