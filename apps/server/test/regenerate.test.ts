import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type MessageResponse,
  type MessageRevisions,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Regenerate: asking the same question again makes a new revision of the
// answer. Old revisions are kept, with the passages side questions were asked
// from; later questions use the current one, which the learner can change.

let s: TestServer;
before(async () => {
  s = await startServer();
});
after(() => s.close());

async function ask(threadId: string, content: string) {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

test('asking again makes a new revision; the old one and its side question stay; later questions use the current one', async () => {
  const { threadId } = await newThread(s);
  const first = await ask(threadId, 'What is entropy?');
  const answer = first.assistant;
  // A side question from the first answer, at a passage of revision 1.
  const detail = await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`);
  const v1 = detail.json.messages.find((m) => m.id === answer.id);
  assert.ok(v1);
  const at = v1.content.indexOf('offline');
  const side = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: answer.id, start: at, end: at + 7 },
    question: { id: ulid(), content: 'Why offline?' },
  });
  assert.equal(side.status, 201);

  // Ask again: a new revision, generated, made current.
  const revisionId = ulid();
  const r = await api<MessageResponse>(s, 'POST', `/api/messages/${answer.id}/regenerate`, { revisionId });
  assert.equal(r.status, 201);
  assert.equal(r.json.message.revisionId, revisionId);
  assert.equal(r.json.message.revision, 2);
  assert.equal(r.json.message.revisions, 2);
  const events = await readEvents(`${s.base}/api/messages/${answer.id}/events`);
  assert.equal(events.at(-1)?.event, 'end');
  // The same request again changes nothing.
  const again = await api<MessageResponse>(s, 'POST', `/api/messages/${answer.id}/regenerate`, { revisionId });
  assert.equal(again.status, 200);
  assert.equal(again.json.message.revisions, 2);

  const revisions = await api<MessageRevisions>(s, 'GET', `/api/messages/${answer.id}/revisions`);
  assert.deepEqual(
    revisions.json.revisions.map((x) => [x.revision, x.status, x.revisionId === v1.revisionId]),
    [
      [1, 'done', true],
      [2, 'done', false],
    ],
  );
  assert.equal(revisions.json.revisions[0]?.content, v1.content, 'revision 1 is unchanged');
  // The side question still points at revision 1, and goes on with it: its
  // next question inherits the answer it was asked from, not the new one.
  const branchDetail = await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`);
  assert.equal(branchDetail.json.branches[0]?.anchor.revisionId, v1.revisionId);
  await readEvents(`${s.base}/api/messages/${side.json.assistant.id}/events`);
  const more = await ask(side.json.thread.id, 'Say more?');
  const moreSent = await api<{ request: { content: string }[] }>(s, 'GET', `/api/messages/${more.assistant.id}/context`);
  const moreText = moreSent.json.request.map((m) => m.content).join('\n');
  assert.ok(moreText.includes(v1.content.slice(0, 60)), 'the side question inherits revision 1');
  assert.ok(!moreText.includes('Asked again'), 'not the answer asked again');

  // The new revision is a new answer; a question after it is asked with it.
  const v2 = revisions.json.revisions[1]?.content ?? '';
  assert.match(v2, /Asked again: this is answer 2\./);
  const later = await ask(threadId, 'And in physics?');
  const sentWith = async (id: string) =>
    (await api<{ request: { role: string; content: string }[] }>(s, 'GET', `/api/messages/${id}/context`)).json.request;
  const laterRequest = (await sentWith(later.assistant.id)).map((m) => m.content).join('\n');
  assert.ok(laterRequest.includes('Asked again: this is answer 2.'), 'the later question was asked with revision 2');
  const chosen = await api<MessageResponse>(s, 'POST', `/api/messages/${answer.id}/current`, {
    revisionId: v1.revisionId,
  });
  assert.equal(chosen.json.message.revision, 1);
  assert.equal(chosen.json.message.revisions, 2);
  const third = await ask(threadId, 'And in chemistry?');
  const thirdRequest = (await sentWith(third.assistant.id)).map((m) => m.content).join('\n');
  assert.ok(!thirdRequest.includes('Asked again'), 'after choosing revision 1, later questions are asked with it');
  // What was sent is kept for each revision.
  const ofRevision = async (revision: string) =>
    (await api<{ revisionId: string }>(s, 'GET', `/api/messages/${answer.id}/context?revision=${revision}`)).json;
  assert.equal((await ofRevision(revisionId)).revisionId, revisionId);
  assert.equal((await ofRevision(v1.revisionId)).revisionId, v1.revisionId);
  const elsewhere = await api(s, 'GET', `/api/messages/${answer.id}/context?revision=${later.assistant.revisionId}`);
  assert.equal(elsewhere.status, 404, 'a revision of another message is not this one');
});

test('a side question can be asked from an earlier answer, read again', async () => {
  const { threadId } = await newThread(s);
  const first = await ask(threadId, 'What is a group?');
  const v1 = first.assistant.revisionId;
  await api(s, 'POST', `/api/messages/${first.assistant.id}/regenerate`, { revisionId: ulid() });
  await readEvents(`${s.base}/api/messages/${first.assistant.id}/events`);
  const revisions = await api<MessageRevisions>(s, 'GET', `/api/messages/${first.assistant.id}/revisions`);
  const old = revisions.json.revisions[0]?.content ?? '';
  const at = old.indexOf('offline');
  const side = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: first.assistant.id, revisionId: v1, start: at, end: at + 7 },
    question: { id: ulid(), content: 'Offline how?' },
  });
  assert.equal(side.status, 201);
  const detail = await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`);
  const anchor = detail.json.branches.find((b) => b.threadId === side.json.thread.id)?.anchor;
  assert.equal(anchor?.revisionId, v1);
  assert.equal(anchor?.exact, 'offline');
  // A revision of another message is refused.
  const wrong = await api(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: first.assistant.id, revisionId: first.user.revisionId, start: 0, end: 3 },
    question: { id: ulid(), content: 'Hm?' },
  });
  assert.equal(wrong.status, 400);
  await readEvents(`${s.base}/api/messages/${side.json.assistant.id}/events`);
});

test('search finds the revision in use', async () => {
  const { threadId } = await newThread(s);
  const first = await ask(threadId, 'What is a lattice?');
  const found = async () =>
    (await api<{ hits: { kind: string; messageId: string | null }[] }>(s, 'GET', '/api/search?q=again')).json.hits.some(
      (h) => h.kind === 'message' && h.messageId === first.assistant.id,
    );
  assert.equal(await found(), false);
  await api(s, 'POST', `/api/messages/${first.assistant.id}/regenerate`, { revisionId: ulid() });
  await readEvents(`${s.base}/api/messages/${first.assistant.id}/events`);
  assert.equal(await found(), true, 'the new answer is searchable');
  await api(s, 'POST', `/api/messages/${first.assistant.id}/current`, { revisionId: first.assistant.revisionId });
  assert.equal(await found(), false, 'back on the first answer, search finds that one');
});

test('only a finished answer can be asked again, and not in the Trash', async () => {
  const { threadId } = await newThread(s);
  const first = await ask(threadId, 'What is a prime?');
  const question = await api(s, 'POST', `/api/messages/${first.user.id}/regenerate`, { revisionId: ulid() });
  assert.equal(question.status, 400);
  const unknown = await api(s, 'POST', `/api/messages/${ulid()}/regenerate`, { revisionId: ulid() });
  assert.equal(unknown.status, 404);
  // Still answering: refused.
  const slow = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, {
    id: ulid(),
    content: 'Count slowly [[slow]]',
  });
  const busy = await api(s, 'POST', `/api/messages/${slow.json.assistant.id}/regenerate`, { revisionId: ulid() });
  assert.equal(busy.status, 409);
  await api(s, 'POST', `/api/messages/${slow.json.assistant.id}/stop`);
  await readEvents(`${s.base}/api/messages/${slow.json.assistant.id}/events`);
  // A stopped answer can be asked again.
  const afterStop = await api<MessageResponse>(s, 'POST', `/api/messages/${slow.json.assistant.id}/regenerate`, {
    revisionId: ulid(),
  });
  assert.equal(afterStop.status, 201);
  await api(s, 'POST', `/api/messages/${slow.json.assistant.id}/stop`);
  await readEvents(`${s.base}/api/messages/${slow.json.assistant.id}/events`);
  // A revision of another message cannot be chosen.
  const other = await api(s, 'POST', `/api/messages/${first.assistant.id}/current`, {
    revisionId: slow.json.assistant.revisionId,
  });
  assert.equal(other.status, 404);
  // In the Trash: refused.
  const del = await api(s, 'DELETE', `/api/threads/${threadId}`);
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const trashed = await api(s, 'POST', `/api/messages/${first.assistant.id}/regenerate`, { revisionId: ulid() });
  assert.equal(trashed.status, 409);
});
