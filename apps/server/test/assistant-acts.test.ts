import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AssistantAction,
  MAX_NEW_ANSWERS,
  type Message,
  type MessageContext,
  type Note,
  type Room,
  type Source,
  type Thread,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { api, readEvents, type SseEvent, startServer, type TestServer } from './helpers.ts';

// The Assistant acts on its own (ADR 0033): a change is done when it makes it,
// each with Undo, and it goes on in rounds with what it is told back (a label
// for what a change made), so a request of many steps is done in one answer.
// The same change twice is done once. Files on the learner's computer, and
// answers past the first few it starts, still wait for Do it. Undo all and
// Do all act on a whole answer. Asking first is a setting of the notebook.
// The fake model calls what [[call:…]] says, one a round ([[together]]: all
// at once); $made is the label of what the last change made.

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
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${chatId}/messages`, { id: ulid(), content: 'What is the variance of a sum?' });
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

async function ask(w: World, content: string) {
  const r = await api<{ assistant: { id: string } }>(w.s, 'POST', `/api/threads/${w.assistantId}/messages`, { id: ulid(), content });
  const events: SseEvent[] = await readEvents(`${w.s.base}/api/messages/${r.json.assistant.id}/events`);
  const detail = (await api<ThreadDetail>(w.s, 'GET', `/api/threads/${w.assistantId}`)).json;
  const answer = detail.messages.find((m) => m.id === r.json.assistant.id) as Message;
  const actions = (await api<{ actions: AssistantAction[] }>(w.s, 'GET', `/api/threads/${w.assistantId}/actions`)).json.actions.filter(
    (a) => a.messageId === answer.id,
  );
  const tools = ((await api<MessageContext>(w.s, 'GET', `/api/messages/${answer.id}/context`)).json.request ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);
  return { answer, events, actions, tools };
}

const call = (name: string, args: unknown) => `[[call:${name}:${JSON.stringify(args)}]]`;
const rooms = async (w: World) => (await api<{ rooms: Room[] }>(w.s, 'GET', `/api/notebooks/${w.notebookId}/rooms`)).json.rooms;
const threads = async (w: World) => (await api<{ threads: Thread[] }>(w.s, 'GET', `/api/notebooks/${w.notebookId}/threads`)).json.threads;

test('a change is done when the Assistant makes it, told back to it, and can be undone', async () => {
  const w = await world();
  try {
    const { actions, tools, events } = await ask(w, `Put them together ${call('put_in_room', { refs: [1, 2], room: 'Statistics' })}`);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.status, 'done', 'done, not waiting');
    assert.equal(actions[0]?.undoable, true);
    assert.equal(tools[0], 'Done: Make the room “Statistics” with “Week 4: Parallelism”, “Variance notes”.');
    assert.deepEqual(
      events.filter((e) => e.event === 'action').map((e) => (e.data as { action: AssistantAction }).action.status),
      ['proposed', 'done'],
      'the watcher sees it made, then done',
    );
    const room = (await rooms(w)).find((r) => r.title === 'Statistics');
    assert.equal(room?.members.length, 2);
    const undone = (await api<{ action: AssistantAction }>(w.s, 'POST', `/api/assistant/actions/${actions[0]?.id}/undo`, {})).json.action;
    assert.equal(undone.status, 'undone');
    assert.ok(!(await rooms(w)).some((r) => r.title === 'Statistics'));
  } finally {
    w.s.close();
  }
});

test('many steps in one answer: what a change made gets a label, and the next step uses it', async () => {
  const w = await world();
  try {
    const { actions, tools } = await ask(
      w,
      `Make a note and file it ${call('create_note', { title: 'Parallelism, short', content: 'Each worker has a shard.' })} ${call('put_in_room', { refs: ['$made', 1], room: 'Systems' })} ${call('link', { from: '$made', to: 1, kind: 'explains' })}`,
    );
    assert.deepEqual(
      actions.map((a) => [a.kind, a.status]),
      [
        ['create_note', 'done'],
        ['put_in_room', 'done'],
        ['link', 'done'],
      ],
    );
    assert.match(tools[0] ?? '', /^Done: Make a note “Parallelism, short”\. What it made is \[(\d+)\]: use that label to go on with it\.$/);
    const made = /\[(\d+)\]/.exec(tools[0] ?? '')?.[1];
    const room = (await rooms(w)).find((r) => r.title === 'Systems') as Room;
    const note = actions[0]?.open?.kind === 'note' ? actions[0].open.noteId : '';
    assert.ok(note && room.members.includes(`note:${note}`), `the note made (label [${made}]) is in the room`);
    assert.ok(room.members.includes(`source:${w.source.id}`));
    // The note is the learner's to accept: its text arrived as a suggestion in it.
    const detail = (await api<Note>(w.s, 'GET', `/api/notes/${note}`)).json;
    assert.equal(detail.title, 'Parallelism, short');
  } finally {
    w.s.close();
  }
});

test('more than four changes at once; the same change twice is done once', async () => {
  const w = await world();
  try {
    const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    const calls = titles.map((t) => call('put_in_room', { refs: [1], room: t })).join(' ');
    const { actions, tools } = await ask(w, `File it everywhere [[together]] ${calls} ${call('put_in_room', { refs: [1], room: 'One' })}`);
    assert.equal(actions.length, 6);
    assert.ok(actions.every((a) => a.status === 'done'));
    assert.equal(tools.at(-1), 'Already done in this answer: Put “Week 4: Parallelism” in the room “One”. Do not ask for it again.');
    const names = (await rooms(w)).map((r) => r.title);
    for (const t of titles) assert.ok(names.includes(t), t);
  } finally {
    w.s.close();
  }
});

test(`questions it asks: at most ${MAX_NEW_ANSWERS} on its own in one answer, the rest wait; Do all and Undo all`, async () => {
  const w = await world();
  try {
    const before = (await threads(w)).length;
    const asks = Array.from({ length: MAX_NEW_ANSWERS + 1 }, (_, i) => call('start_thread', { question: `Question ${i + 1}?` })).join(' ');
    const { answer, actions, tools } = await ask(w, `Ask these ${asks}`);
    assert.deepEqual(
      actions.map((a) => a.status),
      [...Array.from({ length: MAX_NEW_ANSWERS }, () => 'done'), 'proposed'],
    );
    assert.match(tools.at(-1) ?? '', /^Waiting for the learner to tap Do it under your answer \(it starts another answer, and you started 3 already\): Start a thread/);
    assert.equal((await threads(w)).length, before + MAX_NEW_ANSWERS);

    // Do all: what waits is done.
    const all = (await api<{ actions: AssistantAction[] }>(w.s, 'POST', `/api/messages/${answer.id}/actions/run-all`, {})).json.actions;
    assert.ok(all.every((a) => a.status === 'done'));
    assert.equal((await threads(w)).length, before + MAX_NEW_ANSWERS + 1);

    // Undo all: every change of the answer, newest first.
    const undone = (await api<{ actions: AssistantAction[]; kept: number }>(w.s, 'POST', `/api/messages/${answer.id}/actions/undo-all`, {})).json;
    assert.equal(undone.kept, 0);
    assert.ok(undone.actions.every((a) => a.status === 'undone'));
    assert.equal((await threads(w)).length, before);
  } finally {
    w.s.close();
  }
});

test('asking first is a setting of the notebook: then changes wait for Do it, and the tools say so', async () => {
  const w = await world();
  try {
    const set = await api<{ assistantAsks: boolean }>(w.s, 'PATCH', `/api/notebooks/${w.notebookId}`, { assistantAsks: true });
    assert.equal(set.json.assistantAsks, true);
    const { actions, answer } = await ask(w, `Rename it ${call('rename', { ref: 3, title: 'Sums of variances' })}`);
    assert.equal(actions[0]?.status, 'proposed');
    const sent = (await api<MessageContext>(w.s, 'GET', `/api/messages/${answer.id}/context`)).json;
    assert.match(sent.request?.[0]?.content ?? '', /A change you propose waits under your answer until the learner taps Do it/);
    await api(w.s, 'PATCH', `/api/notebooks/${w.notebookId}`, { assistantAsks: false });
    const again = await ask(w, `Rename it ${call('rename', { ref: 3, title: 'Sums of variances' })}`);
    assert.equal(again.actions[0]?.status, 'done');
    assert.equal((await threads(w)).find((t) => t.id === w.chatId)?.title, 'Sums of variances');
  } finally {
    w.s.close();
  }
});
