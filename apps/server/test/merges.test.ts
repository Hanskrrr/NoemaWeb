import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type ContextManifest,
  type CreateBranchResponse,
  formatMerged,
  type Merge,
  type Note,
  Thread as ThreadSchema,
  type ThreadDetail,
  type ThreadMap,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(async () => {
  await s.close();
});

async function ask(threadId: string, content: string): Promise<AskResponse> {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

async function branch(parentId: string, messageId: string, phrase: string, question: string) {
  const content = s.repo.getMessage(messageId)?.content ?? '';
  const start = content.indexOf(phrase);
  const r = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${parentId}/branches`, {
    id: ulid(),
    anchor: { messageId, start, end: start + phrase.length },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

async function journey() {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'What is backprop?');
  const b1 = await branch(threadId, q1.assistant.id, 'offline fake model', 'Why offline?');
  return { threadId, q1, b1 };
}

const start = (source: string, into: string, mode: 'summary' | 'full' = 'summary', id = ulid()) =>
  api<Merge>(s, 'POST', `/api/threads/${source}/merges`, { id, into, mode });

async function drafted(id: string): Promise<Merge> {
  await waitFor(() => s.repo.getMerge(id)?.status !== 'drafting', 5000);
  return s.repo.getMerge(id) as Merge;
}

const detail = async (id: string) => (await api<ThreadDetail>(s, 'GET', `/api/threads/${id}`)).json;
const manifestOf = (revisionId: string) =>
  JSON.parse(s.repo.modelCallsFor(revisionId)[0]?.manifest as string) as ContextManifest;

test('a side question merged back: drafted, edited, accepted, and carried from then on', async () => {
  const { threadId, q1, b1 } = await journey();
  const r = await start(b1.thread.id, threadId);
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'drafting');
  const draft = await drafted(r.json.id);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.summary, '- What the side question found [E1].\n- One more point to keep.');
  assert.deepEqual(draft.refs.E1, { threadId: b1.thread.id, messageId: b1.assistant.id });
  assert.equal(draft.quote, 'offline fake model');
  // Nothing is carried before the learner accepts.
  assert.deepEqual(s.repo.pendingMerges(threadId, Number.MAX_SAFE_INTEGER), []);

  const edited = await api<Merge>(s, 'PATCH', `/api/merges/${draft.id}`, {
    summary: 'Offline means the fake model answers the same way every time [E1].',
  });
  assert.equal(edited.json.status, 'draft');
  const merged = (await api<Merge>(s, 'POST', `/api/merges/${draft.id}/accept`)).json;
  assert.equal(merged.status, 'merged');
  // Read in the parent under the answer the side question left from.
  assert.equal(merged.afterMessageId, q1.assistant.id);
  const parent = await detail(threadId);
  assert.deepEqual(
    parent.merges.map((m) => [m.id, m.sourceThreadId, m.quote]),
    [[draft.id, b1.thread.id, 'offline fake model']],
  );
  const side = await detail(b1.thread.id);
  assert.equal(side.thread.mergedIntoId, threadId);
  assert.deepEqual(side.outgoing.map((m) => m.status), ['merged']);
  ThreadSchema.parse(side.thread);
  const map = (await api<ThreadMap>(s, 'GET', `/api/threads/${threadId}/map`)).json;
  assert.equal(map.root.exchanges[0]?.branches[0]?.mergedIntoId, threadId);

  // The next question in the parent carries it (labels taken out); earlier turns are untouched.
  const q2 = await ask(threadId, 'So what now?');
  const text = formatMerged({ id: draft.id, title: b1.thread.title, text: edited.json.summary });
  const sideTitle = s.repo.getThread(b1.thread.id)?.title as string;
  assert.match(
    s.repo.getMessage(q2.assistant.id)?.content ?? '',
    new RegExp(`^You asked: "Merged into this conversation from "${sideTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":`),
  );
  assert.ok(!text.includes('[E1]'));
  assert.deepEqual(
    manifestOf(q2.assistant.revisionId).parts.map((p) => p.kind),
    ['system', 'history', 'history', 'merged', 'question'],
  );
  // ...and stays with that question afterwards, so the earlier requests stay a prefix.
  const q3 = await ask(threadId, 'And then?');
  assert.deepEqual(
    manifestOf(q3.assistant.revisionId).parts.map((p) => p.kind),
    ['system', 'history', 'history', 'merged', 'history', 'history', 'question'],
  );
  assert.match(s.repo.getMessage(q3.assistant.id)?.content ?? '', /^You asked: "And then\?"/);
  const history = s.repo.history(threadId, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(history.find((h) => h.id === q2.user.id)?.merged?.map((m) => m.id), [draft.id]);

  // Undo: no longer carried, no longer shown.
  const undone = (await api<Merge>(s, 'POST', `/api/merges/${draft.id}/undo`)).json;
  assert.equal(undone.status, 'undone');
  assert.deepEqual((await detail(threadId)).merges, []);
  assert.equal((await detail(b1.thread.id)).thread.mergedIntoId, null);
  assert.ok(s.repo.history(threadId, Number.MAX_SAFE_INTEGER).every((h) => !h.merged));
});

test('merging the same side question again replaces the earlier merge', async () => {
  const { threadId, q1, b1 } = await journey();
  const first = await start(b1.thread.id, threadId, 'full');
  assert.equal(first.json.replaces, null);
  await api(s, 'POST', `/api/merges/${first.json.id}/accept`);
  // The card knows where the passage is, to sit right after it.
  const merged = (await detail(threadId)).merges[0];
  assert.deepEqual(
    [merged?.anchor?.messageId, merged?.anchor?.exact, typeof merged?.anchor?.start],
    [q1.assistant.id, 'offline fake model', 'number'],
  );

  await ask(b1.thread.id, 'One more side detail');
  const second = await start(b1.thread.id, threadId, 'full');
  assert.equal(second.json.replaces, first.json.id, 'the draft says what it will replace');
  await api(s, 'POST', `/api/merges/${second.json.id}/accept`);
  assert.equal(s.repo.getMerge(first.json.id)?.status, 'undone');
  assert.deepEqual(
    (await detail(threadId)).merges.map((m) => m.id),
    [second.json.id],
  );
  assert.match((await detail(threadId)).merges[0]?.summary ?? '', /One more side detail/);
  const next = await ask(threadId, 'Next');
  assert.equal(
    manifestOf(next.assistant.revisionId).parts.filter((p) => p.kind === 'merged').length,
    1,
    'only the newer version is carried',
  );
});

test('the whole exchange instead of a summary, and drafting again', async () => {
  const { threadId, b1 } = await journey();
  const r = await start(b1.thread.id, threadId, 'full');
  assert.equal(r.json.status, 'draft', 'ready at once: no AI involved');
  assert.match(r.json.summary, /^\*\*Q:\*\* Why offline\?\n\n\*\*A:\*\* You asked: /);
  assert.match(r.json.summary, /\[E1\]$/);
  assert.equal(r.json.refs.E1?.messageId, b1.assistant.id);

  const again = await api<Merge>(s, 'POST', `/api/merges/${r.json.id}/redraft`, { mode: 'summary' });
  assert.equal(again.status, 202);
  assert.equal(again.json.status, 'drafting');
  assert.equal((await api(s, 'POST', `/api/merges/${r.json.id}/accept`)).status, 409, 'not while drafting');
  const done = await drafted(r.json.id);
  assert.deepEqual([done.mode, done.status], ['summary', 'draft']);

  // Starting again replaces the open draft.
  const second = await start(b1.thread.id, threadId);
  assert.equal(s.repo.getMerge(r.json.id)?.status, 'discarded');
  await drafted(second.json.id);
  assert.equal((await api<Merge>(s, 'POST', `/api/merges/${second.json.id}/discard`)).json.status, 'discarded');
  assert.deepEqual((await detail(b1.thread.id)).outgoing, []);
});

test('a failed draft says why; the learner can still write it and merge', async () => {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'Tell me something');
  const b1 = await branch(threadId, q1.assistant.id, 'offline fake model', 'Explain [[fail-merge]] this');
  const r = await start(b1.thread.id, threadId);
  const failed = await drafted(r.json.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /limiting requests/);
  const written = await api<Merge>(s, 'PATCH', `/api/merges/${r.json.id}`, { summary: 'My own summary.' });
  assert.equal(written.json.status, 'draft');
  assert.equal((await api<Merge>(s, 'POST', `/api/merges/${r.json.id}/accept`)).json.status, 'merged');
});

test('two parallel threads: the card goes after the target’s last message', async () => {
  const a = await newThread(s);
  const b = await newThread(s);
  const qa = await ask(a.threadId, 'Thread A question');
  await ask(b.threadId, 'Thread B question');
  const r = await start(b.threadId, a.threadId, 'full');
  const merged = (await api<Merge>(s, 'POST', `/api/merges/${r.json.id}/accept`)).json;
  assert.deepEqual([merged.afterMessageId, merged.quote], [qa.assistant.id, null]);
  assert.equal(s.repo.getThread(b.threadId)?.mergedIntoId, a.threadId);
  const next = await ask(a.threadId, 'Next');
  assert.ok(manifestOf(next.assistant.revisionId).parts.some((p) => p.kind === 'merged'));
});

test('what cannot be merged', async () => {
  const { threadId, b1 } = await journey();
  assert.equal((await start(threadId, threadId)).status, 400);
  // The parent into its own side question: the side question already sees it.
  assert.equal((await start(threadId, b1.thread.id)).status, 400);
  assert.equal((await start(b1.thread.id, ulid())).status, 404);
  // Not while the source is still answering.
  await api(s, 'POST', `/api/threads/${b1.thread.id}/messages`, { id: ulid(), content: 'Slowly [[slow]]' });
  assert.equal((await start(b1.thread.id, threadId)).status, 409);
  // Nothing to undo or accept on a discarded draft.
  const { threadId: t2, b1: other } = await journey();
  const r = await start(other.thread.id, t2, 'full');
  await api(s, 'POST', `/api/merges/${r.json.id}/discard`);
  assert.equal((await api(s, 'POST', `/api/merges/${r.json.id}/accept`)).status, 409);
  assert.equal((await api(s, 'POST', `/api/merges/${r.json.id}/undo`)).status, 409);
});

test('a draft cut off by a restart is marked failed', async () => {
  const { threadId, b1 } = await journey();
  const id = ulid();
  s.repo.startMerge(id, b1.thread.id, threadId, 'summary', () => ({ text: '', refs: {} }));
  assert.equal(s.repo.failDraftingMerges(), 1);
  assert.deepEqual(
    [s.repo.getMerge(id)?.status, s.repo.getMerge(id)?.error],
    ['failed', 'The server stopped before this was finished.'],
  );
});

// Notes ------------------------------------------------------------------------

async function aiNote(threadId: string): Promise<Note> {
  const id = ulid();
  await api<Note>(s, 'POST', `/api/threads/${threadId}/notes`, { id });
  await waitFor(() => s.repo.getNote(id)?.status === 'done', 5000);
  return s.repo.getNote(id) as Note;
}

test('merging notes: blocks move over, clashing citation labels are renumbered, the other note goes', async () => {
  const one = await journey();
  const two = await journey();
  const a = await aiNote(one.threadId);
  const b = await aiNote(two.threadId);
  assert.deepEqual(Object.keys(a.refs), ['E1', 'E2']);
  assert.deepEqual(Object.keys(b.refs), ['E1', 'E2']);

  const r = await api<Note>(s, 'POST', `/api/notes/${a.id}/merge`, { from: b.id, after: a.blocks[0]?.id });
  assert.equal(r.status, 200);
  const merged = r.json;
  assert.deepEqual(
    merged.blocks.map((x) => x.id),
    [a.blocks[0]?.id, ...b.blocks.map((x) => x.id), ...a.blocks.slice(1).map((x) => x.id)],
  );
  // B's E1 and E2 point at other exchanges, so they became E3 and E4 and still open the same ones.
  assert.equal(merged.blocks[1]?.content, 'The main idea, from the first question [E3].');
  assert.deepEqual(merged.refs.E3, b.refs.E1);
  assert.deepEqual(merged.refs.E4, b.refs.E2);
  assert.deepEqual(merged.refs.E1, a.refs.E1);
  assert.equal((await api(s, 'GET', `/api/notes/${b.id}`)).status, 404);
  const history = (await api<{ revisions: Array<{ change: string }> }>(s, 'GET', `/api/notes/${a.id}/history`)).json;
  assert.equal(history.revisions.at(-1)?.change, `merged “${b.title}” into this note`);

  // Two notes of the same thread: labels for the same exchange are shared, not duplicated.
  const c = await aiNote(one.threadId);
  const both = (await api<Note>(s, 'POST', `/api/notes/${a.id}/merge`, { from: c.id })).json;
  assert.deepEqual(Object.keys(both.refs).sort(), ['E1', 'E2', 'E3', 'E4']);
  assert.equal(both.blocks.at(-4)?.content, 'The main idea, from the first question [E1].');

  assert.equal((await api(s, 'POST', `/api/notes/${a.id}/merge`, { from: a.id })).status, 400);
});
