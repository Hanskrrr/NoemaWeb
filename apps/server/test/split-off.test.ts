import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type ContextManifest,
  type CreateBranchResponse,
  type Merge,
  type Note,
  type SearchResponse,
  type Thread,
  type ThreadDetail,
  type ThreadMap,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

// "New thread from here": a thread that drifted into a second subject is cut
// at a question, and that question and everything after it become a thread
// of their own. Nothing is copied or rewritten, and joining back undoes it.

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

const detail = async (id: string) => (await api<ThreadDetail>(s, 'GET', `/api/threads/${id}`)).json;
const manifestOf = (revisionId: string) =>
  JSON.parse(s.repo.modelCallsFor(revisionId)[0]?.manifest as string) as ContextManifest;
const sentIds = (revisionId: string) => manifestOf(revisionId).parts.map((p) => ('id' in p ? p.id : null));
const splitOff = (threadId: string, messageId: string, id = ulid()) =>
  api<Thread>(s, 'POST', `/api/threads/${threadId}/split-off`, { id, messageId });
const order = (id: string) => s.repo.listMessages(id).map((m) => [m.id, m.seq]);

/** Two subjects in one thread: TypeScript (q1, q2), then machine learning (q3, q4), with a side question, a merge and a note. */
async function drifted() {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'What are the primitive types in TypeScript?');
  const q2 = await ask(threadId, 'And what is a union type?');
  const q3 = await ask(threadId, 'Switching subject: what is an ML system?');
  const side = await branch(threadId, q3.assistant.id, 'offline fake model', 'Is the model the whole system?');
  const m = await api<Merge>(s, 'POST', `/api/threads/${side.thread.id}/merges`, { id: ulid(), into: threadId, mode: 'full' });
  await api(s, 'POST', `/api/merges/${m.json.id}/accept`);
  const q4 = await ask(threadId, 'What does a feature store do?');
  const noteId = ulid();
  await api<Note>(s, 'POST', `/api/threads/${threadId}/notes`, { id: noteId });
  await waitFor(() => s.repo.getNote(noteId)?.status === 'done', 5000);
  return { threadId, q1, q2, q3, q4, side, mergeId: m.json.id, noteId };
}

test('a thread split at a question: the rest moves, with its side questions, merges, citations and search', async () => {
  const d = await drifted();
  const before = order(d.threadId);
  const r = await splitOff(d.threadId, d.q3.user.id);
  assert.equal(r.status, 201);
  const ml = r.json;
  assert.equal(ml.continuedFromId, d.threadId);
  assert.equal(ml.parentThreadId, null, 'a thread of its own, not a side question');
  assert.equal(ml.title, 'Switching subject: what is an ML system?');

  // The original ends before the cut; the new thread starts at it, same messages, same order.
  assert.deepEqual(
    s.repo.listMessages(d.threadId).map((m) => m.id),
    [d.q1.user.id, d.q1.assistant.id, d.q2.user.id, d.q2.assistant.id],
  );
  assert.deepEqual(
    s.repo.listMessages(ml.id).map((m) => [m.id, m.seq]),
    [d.q3.user.id, d.q3.assistant.id, d.q4.user.id, d.q4.assistant.id].map((id, i) => [id, i]),
  );
  // Nothing rewritten: the same revisions and text.
  assert.equal(s.repo.getMessage(d.q3.assistant.id)?.revisionId, d.q3.assistant.revisionId);

  // The side question asked from q3's answer now hangs off the new thread, at the same passage.
  const sd = await detail(d.side.thread.id);
  assert.equal(sd.thread.parentThreadId, ml.id);
  assert.equal(sd.origin?.parentThreadId, ml.id);
  assert.equal(sd.origin?.anchor.exact, 'offline fake model');
  assert.deepEqual((await detail(ml.id)).branches.map((b) => b.threadId), [d.side.thread.id]);
  assert.deepEqual((await detail(d.threadId)).branches, []);

  // The merge accepted after q3 went with it, its place renumbered.
  const merge = s.repo.getMerge(d.mergeId) as Merge;
  assert.equal(merge.targetThreadId, ml.id);
  assert.deepEqual((await detail(ml.id)).merges.map((x) => x.id), [d.mergeId]);
  assert.deepEqual((await detail(d.threadId)).merges, []);
  assert.equal(merge.afterMessageId, d.q3.assistant.id);

  // Citations to the moved exchanges name the thread they are in now; the rest are untouched.
  const note = s.repo.getNote(d.noteId) as Note;
  const byMessage = new Map(Object.values(note.refs).map((ref) => [ref.messageId, ref.threadId]));
  assert.equal(byMessage.get(d.q4.assistant.id), ml.id);
  assert.equal(byMessage.get(d.q3.assistant.id), ml.id);
  assert.equal(byMessage.get(d.q1.assistant.id), d.threadId);

  // Search: a hit in the moved part opens the new thread.
  const hits = (await api<SearchResponse>(s, 'GET', '/api/search?q=feature%20store')).json.hits;
  const q4hit = hits.find((h) => h.messageId === d.q4.user.id);
  assert.equal(q4hit?.threadId, ml.id);
  assert.deepEqual(q4hit?.path, []);

  // Each side knows the other.
  const mld = await detail(ml.id);
  assert.deepEqual(mld.continuedFrom, {
    threadId: d.threadId,
    title: s.repo.getThread(d.threadId)?.title,
    canJoinBack: true,
    joinBackBlocked: null,
  });
  assert.deepEqual((await detail(d.threadId)).continuedIn, [{ threadId: ml.id, title: s.repo.getThread(ml.id)?.title }]);
  const map = (await api<ThreadMap>(s, 'GET', `/api/threads/${ml.id}/map`)).json;
  assert.equal(map.continuedFrom?.threadId, d.threadId);
  assert.deepEqual(map.root.exchanges.map((e) => e.questionId), [d.q3.user.id, d.q4.user.id]);
  assert.deepEqual(
    (await api<ThreadMap>(s, 'GET', `/api/threads/${d.threadId}/map`)).json.continuedIn.map((c) => c.threadId),
    [ml.id],
  );
  // The model titles it from its first exchange, like any thread.
  await waitFor(() => s.repo.getThread(ml.id)?.titleSource === 'model', 3000);

  // Its own context from now on: no TypeScript in the ML thread, no ML in the TypeScript one.
  const next = await ask(ml.id, 'And model monitoring?');
  const sent = sentIds(next.assistant.revisionId);
  assert.ok(sent.includes(d.q4.assistant.id), 'its own exchanges are sent');
  assert.ok(!sent.includes(d.q1.assistant.id) && !sent.includes(d.q2.user.id), `earlier conversation sent: ${sent}`);
  const ts = await ask(d.threadId, 'Back to TypeScript: what is never?');
  const sentTs = sentIds(ts.assistant.revisionId);
  assert.ok(sentTs.includes(d.q2.assistant.id));
  assert.ok(!sentTs.includes(d.q3.assistant.id) && !sentTs.includes(d.q4.user.id), `moved part sent: ${sentTs}`);
  // The merged text stays with the part it was merged into.
  assert.ok(!manifestOf(ts.assistant.revisionId).parts.some((p) => p.kind === 'merged'));

  // Idempotent on the new thread's id.
  assert.equal((await splitOff(d.threadId, d.q3.user.id, ml.id)).status, 200);
  assert.equal(before.length, 8);
});

test('join back puts every question, side question, merge and citation back where it was', async () => {
  const d = await drifted();
  const before = order(d.threadId);
  const noteBefore = (s.repo.getNote(d.noteId) as Note).refs;
  const ml = (await splitOff(d.threadId, d.q3.user.id)).json;
  await ask(ml.id, 'One more about features'); // asked after the split, in the new thread: it comes along

  const r = await api<Thread>(s, 'POST', `/api/threads/${ml.id}/join-back`);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, d.threadId);
  const after = order(d.threadId);
  assert.deepEqual(after.slice(0, before.length), before, 'the same messages at the same places');
  assert.equal(after.length, before.length + 2);
  assert.equal(s.repo.getThread(ml.id), null, 'the split-off thread is gone');
  assert.equal(s.repo.getThread(d.side.thread.id)?.parentThreadId, d.threadId);
  const merge = s.repo.getMerge(d.mergeId) as Merge;
  assert.equal(merge.targetThreadId, d.threadId);
  assert.deepEqual((s.repo.getNote(d.noteId) as Note).refs, noteBefore);
  assert.deepEqual((await detail(d.threadId)).continuedIn, []);
  const hits = (await api<SearchResponse>(s, 'GET', '/api/search?q=feature%20store')).json.hits;
  assert.equal(hits.find((h) => h.messageId === d.q4.user.id)?.threadId, d.threadId);
});

test('join back waits while the original has new questions, and only split-off threads join back', async () => {
  const d = await drifted();
  const ml = (await splitOff(d.threadId, d.q3.user.id)).json;
  await ask(d.threadId, 'A new TypeScript question in the original');
  const blocked = (await detail(ml.id)).continuedFrom;
  assert.equal(blocked?.canJoinBack, false);
  assert.match(blocked?.joinBackBlocked ?? '', /has new questions since this was split off/);
  const r = await api<{ error: { message: string } }>(s, 'POST', `/api/threads/${ml.id}/join-back`);
  assert.equal(r.status, 409);
  assert.equal(s.repo.listMessages(ml.id).length, 4, 'nothing moved');
  assert.equal((await api(s, 'POST', `/api/threads/${d.threadId}/join-back`)).status, 400);
  assert.equal((await api(s, 'POST', `/api/threads/${ulid()}/join-back`)).status, 404);
});

test('a thread is split only at a question after the first, of its own, with no answer being written', async () => {
  const d = await drifted();
  assert.equal((await splitOff(d.threadId, d.q1.user.id)).status, 400, 'the first question: the whole thread');
  assert.equal((await splitOff(d.threadId, d.q3.assistant.id)).status, 400, 'an answer');
  assert.equal((await splitOff(d.threadId, d.side.user.id)).status, 400, 'a question of another thread');
  assert.equal((await splitOff(ulid(), d.q3.user.id)).status, 404);
  // While an answer is being written.
  const slow = await api<AskResponse>(s, 'POST', `/api/threads/${d.threadId}/messages`, {
    id: ulid(),
    content: 'Slowly please [[slow]]',
  });
  assert.equal((await splitOff(d.threadId, d.q3.user.id)).status, 409);
  await readEvents(`${s.base}/api/messages/${slow.json.assistant.id}/events`, { timeoutMs: 15000 });
  // A side question can be split too: the new thread is top-level, its own.
  const deeper = await ask(d.side.thread.id, 'A second, different side subject');
  const own = (await splitOff(d.side.thread.id, deeper.user.id)).json;
  assert.equal(own.parentThreadId, null);
  assert.deepEqual(s.repo.pathOf(own.id), []);
  assert.equal(s.repo.listMessages(d.side.thread.id).length, 2);
});
