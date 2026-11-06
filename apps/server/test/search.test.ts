import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type Note,
  type OpenBranchesResponse,
  type SearchResponse,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Finding things again (M4): one search over threads, questions, answers
// (with their headlines) and notes, each hit saying exactly where it is; and
// the side questions you never came back from.

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

const search = async (q: string) =>
  (await api<SearchResponse>(s, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).json;

async function blankNote(notebookId: string, title?: string): Promise<Note> {
  const r = await api<Note>(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: ulid(), title: title ?? '' });
  return r.json;
}

const write = async (noteId: string, after: string | null, content: string, id = ulid()) => {
  await api<Note>(s, 'POST', `/api/notes/${noteId}/blocks`, { id, after, content });
  return id;
};

test('a word inside a side question finds that exact answer, and says where it is', async () => {
  const { threadId } = await newThread(s);
  const q1 = await ask(threadId, 'Tell me about attention');
  const b1 = await branch(threadId, q1.assistant.id, 'offline fake model', 'Why is the variance quokka-sized?');
  const b2 = await branch(b1.thread.id, b1.assistant.id, 'every question', 'And deeper wombat?');

  const r = await search('wombat');
  assert.deepEqual(r.terms, ['wombat']);
  const q = r.hits.find((h) => h.messageId === b2.user.id);
  assert.ok(q, 'the question in the side question of the side question');
  assert.equal(q.kind, 'message');
  assert.equal(q.role, 'user');
  assert.equal(q.threadId, b2.thread.id);
  assert.deepEqual(
    q.path.map((p) => p.threadId),
    [threadId, b1.thread.id],
    'the threads above it, top first',
  );
  assert.ok(q.snippet.includes('wombat'));
  assert.equal(q.snippet.slice(q.matches[0]?.start, q.matches[0]?.end).toLowerCase(), 'wombat');
  // The answer's headline ("In short: …" from the fake) carries the question's words too.
  const a = r.hits.find((h) => h.messageId === b2.assistant.id);
  assert.equal(a?.role, 'assistant');
  assert.equal(a?.headline, 'In short: And deeper wombat');
});

test("an answer's headline is searchable, and its snippet comes from the line when the text doesn't match", async () => {
  const { threadId } = await newThread(s);
  const q = await ask(threadId, 'Plain question');
  const before = await search('Lagrangian');
  assert.ok(!before.hits.some((h) => h.messageId === q.assistant.id));
  assert.ok(s.repo.setHeadline(q.assistant.revisionId, 'The Lagrangian sets up the dual problem'));
  const hit = (await search('Lagrangian')).hits.find((h) => h.messageId === q.assistant.id);
  assert.ok(hit);
  assert.equal(hit.snippet, 'The Lagrangian sets up the dual problem');
  assert.deepEqual(hit.matches, [{ start: 4, end: 14 }]);
  // The answer text itself is still found.
  assert.ok((await search('机器学习')).hits.some((h) => h.messageId === q.assistant.id));
});

test('notes: titles and blocks are found as they are now, never as they were', async () => {
  const { notebookId } = await newThread(s);
  const note = await blankNote(notebookId, 'Platypus notes');
  const a = await write(note.id, null, '## Echidna\n\nThe **echidna** lays eggs [E1].');
  const b = await write(note.id, a, 'Second block about numbats.');

  let r = await search('echidna');
  assert.deepEqual(
    r.hits.map((h) => [h.kind, h.noteId, h.blockId]),
    [['block', note.id, a]],
  );
  assert.equal(r.hits[0]?.title, 'Platypus notes');
  assert.equal(r.hits[0]?.snippet, 'Echidna The echidna lays eggs.', 'no Markdown marks or citation labels');
  assert.deepEqual(r.hits[0]?.path, []);
  assert.equal((await search('E1')).hits.length, 0, 'citation labels are not words');

  // The title alone is a hit only when nothing inside matches.
  r = await search('platypus');
  assert.deepEqual(r.hits.map((h) => [h.kind, h.noteId, h.blockId]), [['note', note.id, null]]);

  // Edit: the old word goes, the new one comes.
  await api(s, 'PATCH', `/api/notes/${note.id}/blocks/${b}`, { content: 'Second block about quolls.' });
  assert.equal((await search('numbats')).hits.length, 0);
  assert.deepEqual((await search('quolls')).hits.map((h) => h.blockId), [b]);

  // Delete and restore.
  await api(s, 'DELETE', `/api/notes/${note.id}/blocks/${b}`);
  assert.equal((await search('quolls')).hits.length, 0);
  await api(s, 'POST', `/api/notes/${note.id}/blocks/${b}/restore`);
  assert.deepEqual((await search('quolls')).hits.map((h) => h.blockId), [b]);

  // Move a block out: it is found in the new note.
  const moved = ulid();
  await api(s, 'POST', `/api/notes/${note.id}/move-out`, { id: moved, blockIds: [b] });
  assert.deepEqual((await search('quolls')).hits.map((h) => [h.noteId, h.blockId]), [[moved, b]]);

  // Merge it back: one hit per block, in the note it is in now.
  await api(s, 'POST', `/api/notes/${note.id}/merge`, { from: moved, after: null });
  assert.deepEqual((await search('quolls')).hits.map((h) => [h.noteId, h.blockId]), [[note.id, b]]);
  assert.equal((await search('platypus')).hits.length, 1);

  // Rename and delete the note.
  await api(s, 'PATCH', `/api/notes/${note.id}`, { title: 'Monotremes' });
  assert.equal((await search('platypus')).hits.length, 0);
  assert.deepEqual((await search('monotremes')).hits.map((h) => h.kind), ['note']);
  await api(s, 'DELETE', `/api/notes/${note.id}`);
  assert.equal((await search('echidna')).hits.length + (await search('monotremes')).hits.length, 0);
});

test('a thread title is a hit of its own only when nothing in the thread matched', async () => {
  const { threadId } = await newThread(s);
  await ask(threadId, 'Something about kakapo');
  await api(s, 'PATCH', `/api/threads/${threadId}`, { title: 'Takahe and kakapo' });
  const kakapo = await search('kakapo');
  assert.ok(kakapo.hits.every((h) => h.kind === 'message'), 'the question matched, so no separate title line');
  assert.deepEqual((await search('takahe')).hits.map((h) => [h.kind, h.threadId]), [['thread', threadId]]);
});

test('the index is rebuilt at start-up when it was built by older code, notes and headlines included', async () => {
  const { threadId, notebookId } = await newThread(s);
  const q = await ask(threadId, 'About the tuatara');
  s.repo.setHeadline(q.assistant.revisionId, 'Tuatara are not lizards');
  const note = await blankNote(notebookId);
  const block = await write(note.id, null, 'A block about the kiwi.');

  // As a notebook from before notes were searchable: messages only, and no version mark.
  s.db.sql.exec("DELETE FROM search WHERE kind IN ('note', 'block')");
  s.db.sql.exec("DELETE FROM meta WHERE key = 'search_index'");
  assert.equal((await search('kiwi')).hits.length, 0);

  assert.equal(s.repo.ensureSearchIndex(), true);
  assert.deepEqual((await search('kiwi')).hits.map((h) => h.blockId), [block]);
  assert.ok((await search('lizards')).hits.some((h) => h.messageId === q.assistant.id));
  assert.ok((await search('tuatara')).hits.some((h) => h.messageId === q.user.id));
  assert.equal(s.repo.ensureSearchIndex(), false, 'only once');
});

test('opening a hit is logged with its kind and rank, never its words', async () => {
  const r = await api(s, 'POST', '/api/search/opened', { kind: 'block', rank: 2, queryChars: 7 });
  assert.equal(r.status, 200);
  const row = s.db.sql
    .prepare("SELECT data FROM event WHERE type = 'search.opened' ORDER BY rowid DESC LIMIT 1")
    .get() as { data: string };
  assert.deepEqual(JSON.parse(row.data), { kind: 'block', rank: 2, queryChars: 7 });
  assert.equal((await api(s, 'POST', '/api/search/opened', { kind: 'block', rank: 2, query: 'secret' })).status, 400);
});

// Coming back ----------------------------------------------------------------

test('side questions you never came back from: until Back, a later question above, a merge or "not now"', async () => {
  const { threadId, notebookId } = await newThread(s);
  const open = async () =>
    (await api<OpenBranchesResponse>(s, 'GET', `/api/notebooks/${notebookId}/open-branches`)).json.branches.filter(
      (b) => b.parentThreadId === threadId,
    );
  const q1 = await ask(threadId, 'Main question');
  const b1 = await branch(threadId, q1.assistant.id, 'offline fake model', 'First side question');
  const b2 = await branch(threadId, q1.assistant.id, 'every question', 'Second side question');

  let list = await open();
  assert.deepEqual(list.map((b) => b.threadId), [b2.thread.id, b1.thread.id], 'newest first');
  assert.deepEqual([list[1]?.quote, list[1]?.parentTitle], ['offline fake model', s.repo.getThread(threadId)?.title]);

  // Back to the passage: no longer open.
  await api(s, 'POST', `/api/threads/${b1.thread.id}/return`);
  assert.deepEqual((await open()).map((b) => b.threadId), [b2.thread.id]);
  // Asking in it again opens it again.
  await ask(b1.thread.id, 'One more thing');
  assert.deepEqual((await open()).map((b) => b.threadId), [b1.thread.id, b2.thread.id]);

  // "Not now".
  assert.equal((await api(s, 'POST', `/api/threads/${b2.thread.id}/set-aside`)).status, 200);
  assert.deepEqual((await open()).map((b) => b.threadId), [b1.thread.id]);
  assert.equal((await api(s, 'POST', `/api/threads/${threadId}/set-aside`)).status, 400, 'only side questions');

  // A later question in the thread above means you went back.
  await ask(threadId, 'Back in the main thread');
  assert.deepEqual(await open(), []);

  // A side question merged back, or made its own thread, is not left open.
  const b3 = await branch(threadId, q1.assistant.id, 'exact text', 'Third side question');
  const b4 = await branch(threadId, q1.assistant.id, 'Inline math', 'Fourth side question');
  assert.deepEqual((await open()).map((b) => b.threadId), [b4.thread.id, b3.thread.id]);
  await api(s, 'POST', `/api/threads/${b4.thread.id}/split`, { split: true });
  const m = await api<{ id: string }>(s, 'POST', `/api/threads/${b3.thread.id}/merges`, {
    id: ulid(),
    into: threadId,
    mode: 'full',
  });
  await api(s, 'POST', `/api/merges/${m.json.id}/accept`);
  assert.deepEqual(await open(), []);
});
