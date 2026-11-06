import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type ContextManifest,
  type CreateBranchResponse,
  type Note,
  type Thread,
  type ThreadDetail,
  type ThreadMap,
  ulid,
} from '@noema/core';
import { buildOutline, cleanSuggestion, markedNote } from '../src/chat/notes.ts';
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
  const b2 = await branch(b1.thread.id, b1.assistant.id, 'every question', 'Every one?');
  return { threadId, q1, b1, b2 };
}

const manifestOf = (revisionId: string) =>
  JSON.parse(s.repo.modelCallsFor(revisionId)[0]?.manifest as string) as ContextManifest;

async function aiNote(threadId: string): Promise<Note> {
  const id = ulid();
  await api<Note>(s, 'POST', `/api/threads/${threadId}/notes`, { id });
  await waitFor(() => s.repo.getNote(id)?.status === 'done', 5000);
  return s.repo.getNote(id) as Note;
}

async function blankNote(notebookId: string): Promise<Note> {
  const r = await api<Note>(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: ulid() });
  assert.equal(r.status, 201);
  return r.json;
}

const write = (noteId: string, after: string | null, content: string, id = ulid()) =>
  api<Note>(s, 'POST', `/api/notes/${noteId}/blocks`, { id, after, content });

/** Wait for a block's suggestion to finish, then return the note. */
async function settled(noteId: string, blockId: string): Promise<Note> {
  await waitFor(() => s.repo.getNote(noteId)?.blocks.find((b) => b.id === blockId)?.proposal?.status !== 'generating', 5000);
  return s.repo.getNote(noteId) as Note;
}

// Split ----------------------------------------------------------------------

test('a side question made its own thread: own map, own notes, and only its passage as context', async () => {
  const { threadId, q1, b1, b2 } = await journey();
  const r = await api<Thread>(s, 'POST', `/api/threads/${b1.thread.id}/split`, { split: true });
  assert.equal(r.status, 200);
  assert.ok(r.json.splitAt);
  assert.equal(r.json.parentThreadId, threadId, 'it still knows where it came from');

  // Its own top: no breadcrumb above it, but the origin (and Back) stay.
  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${b1.thread.id}`)).json;
  assert.deepEqual(detail.path, []);
  assert.equal(detail.origin?.anchor.exact, 'offline fake model');
  assert.deepEqual(
    (await api<ThreadDetail>(s, 'GET', `/api/threads/${b2.thread.id}`)).json.path.map((p) => p.id),
    [b1.thread.id],
  );

  // The parent's map shows it as a link only; its own map starts at it.
  const parentMap = (await api<ThreadMap>(s, 'GET', `/api/threads/${threadId}/map`)).json;
  const link = parentMap.root.exchanges[0]?.branches[0];
  assert.deepEqual([link?.threadId, link?.split, link?.exchanges.length], [b1.thread.id, true, 0]);
  const own = (await api<ThreadMap>(s, 'GET', `/api/threads/${b1.thread.id}/map`)).json;
  assert.deepEqual([own.root.split, own.path, own.parent?.threadId], [false, [], threadId]);
  assert.deepEqual(own.root.exchanges[0]?.branches.map((n) => n.threadId), [b2.thread.id]);

  // The parent's notes leave it out; its own notes start from it.
  assert.deepEqual([...buildOutline(s.repo, threadId).refs.values()].map((r) => r.messageId), [q1.assistant.id]);
  assert.deepEqual(
    [...buildOutline(s.repo, b1.thread.id).refs.values()].map((r) => r.messageId),
    [b1.assistant.id, b2.assistant.id],
  );

  // New questions send only the passage, not the parent conversation.
  const next = await ask(b1.thread.id, 'A new subject now');
  const kinds = manifestOf(next.assistant.revisionId).parts.map((p) => p.kind);
  assert.ok(!kinds.includes('inherited'), `parent conversation sent: ${kinds.join(',')}`);
  assert.ok(kinds.includes('origin'));
  // A branch below it inherits from it, and not from beyond.
  const deeper = await ask(b2.thread.id, 'Still deeper');
  const ids = manifestOf(deeper.assistant.revisionId).parts.map((p) => ('id' in p ? p.id : null));
  assert.ok(ids.includes(b1.assistant.id) && !ids.includes(q1.assistant.id));

  // Put back: a side question again.
  const back = await api<Thread>(s, 'POST', `/api/threads/${b1.thread.id}/split`, { split: false });
  assert.equal(back.json.splitAt, null);
  assert.equal((await api<ThreadMap>(s, 'GET', `/api/threads/${threadId}/map`)).json.root.exchanges[0]?.branches[0]?.split, false);
  assert.deepEqual(
    (await api<ThreadDetail>(s, 'GET', `/api/threads/${b1.thread.id}`)).json.path.map((p) => p.id),
    [threadId],
  );
  // Only a side question can be made its own thread.
  assert.equal((await api(s, 'POST', `/api/threads/${threadId}/split`, { split: true })).status, 400);
});

// Blocks ---------------------------------------------------------------------

test('the learner writes, edits, moves, deletes and restores blocks in place', async () => {
  const { threadId } = await newThread(s);
  const note = await blankNote(s.repo.getThread(threadId)?.notebookId as string);
  assert.deepEqual([note.title, note.author, note.blocks, note.threadId], ['Untitled note', 'user', [], null]);

  const a = ulid();
  const first = await write(note.id, null, 'First paragraph.', a);
  assert.equal(first.status, 201);
  assert.equal((await write(note.id, null, 'First paragraph.', a)).status, 200, 'the same block twice is added once');
  const b = ulid();
  await write(note.id, a, '## A heading', b);
  const c = ulid();
  const three = (await write(note.id, null, 'On top.', c)).json;
  assert.deepEqual(three.blocks.map((x) => x.id), [c, a, b]);
  assert.equal(three.content, 'On top.\n\nFirst paragraph.\n\n## A heading');

  const edited = (await api<Note>(s, 'PATCH', `/api/notes/${note.id}/blocks/${a}`, { content: 'First, *edited*.' })).json;
  assert.deepEqual(
    edited.blocks.map((x) => [x.content, x.author]),
    [
      ['On top.', 'user'],
      ['First, *edited*.', 'user'],
      ['## A heading', 'user'],
    ],
  );
  const moved = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${b}/move`, { after: null })).json;
  assert.deepEqual(moved.blocks.map((x) => x.id), [b, c, a]);

  const deleted = (await api<Note>(s, 'DELETE', `/api/notes/${note.id}/blocks/${c}`)).json;
  assert.deepEqual(deleted.blocks.map((x) => x.id), [b, a]);
  const restored = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${c}/restore`)).json;
  assert.deepEqual(restored.blocks.map((x) => x.id), [b, c, a], 'an undone delete comes back where it was');
  // Clearing a block deletes it.
  const cleared = (await api<Note>(s, 'PATCH', `/api/notes/${note.id}/blocks/${c}`, { content: '  ' })).json;
  assert.deepEqual(cleared.blocks.map((x) => x.id), [b, a]);

  assert.equal((await api(s, 'PATCH', `/api/notes/${note.id}/blocks/${ulid()}`, { content: 'x' })).status, 404);
  assert.equal((await write(note.id, ulid(), 'after a block that is not there')).status, 400);
  const history = (await api<{ revisions: Array<{ change: string }> }>(s, 'GET', `/api/notes/${note.id}/history`)).json;
  assert.deepEqual(history.revisions.map((r) => r.change), [
    'wrote a block',
    'wrote a block',
    'wrote a block',
    'edited a block',
    'moved a block',
    'deleted a block',
    'restored a block',
    'deleted a block',
  ]);
});

test('AI suggestions wait for the learner: replace, discard, try again, or fail without harm', async () => {
  const { threadId, q1 } = await journey();
  const note = await aiNote(threadId);
  const target = note.blocks[0]?.id as string;
  const before = note.blocks[0]?.content;

  const r = await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${target}/suggest`, { instruction: 'Simpler' });
  assert.equal(r.status, 202);
  assert.equal(r.json.blocks[0]?.proposal?.status, 'generating');
  let now = await settled(note.id, target);
  const proposal = now.blocks[0]?.proposal;
  assert.equal(proposal?.status, 'ready');
  assert.equal(proposal?.instruction, 'Simpler');
  assert.match(proposal?.text ?? '', /^Rewritten \(Simpler\): The main idea, from the first question \[E1\]/);
  assert.equal(now.blocks[0]?.content, before, 'a suggestion changes nothing by itself');

  now = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${target}/accept`)).json;
  assert.match(now.blocks[0]?.content ?? '', /^Rewritten \(Simpler\)/);
  assert.equal(now.blocks[0]?.proposal, null);
  assert.equal(now.blocks[0]?.author, 'ai');

  // Discard leaves the block as it was.
  await api(s, 'POST', `/api/notes/${note.id}/blocks/${target}/suggest`, { instruction: 'More detail' });
  await settled(note.id, target);
  now = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${target}/discard`)).json;
  assert.match(now.blocks[0]?.content ?? '', /^Rewritten \(Simpler\)/);
  assert.equal(now.blocks[0]?.proposal, null);

  // A failure is reported on the suggestion; the block is untouched.
  await api(s, 'POST', `/api/notes/${note.id}/blocks/${target}/suggest`, { instruction: '[[fail:rate_limit]] again' });
  now = await settled(note.id, target);
  assert.equal(now.blocks[0]?.proposal?.status, 'failed');
  assert.match(now.blocks[0]?.proposal?.error ?? '', /limiting requests/);
  assert.match(now.blocks[0]?.content ?? '', /^Rewritten \(Simpler\)/);
  assert.equal((await api(s, 'POST', `/api/notes/${note.id}/blocks/${target}/accept`)).status, 400);

  // One suggestion at a time per block.
  await api(s, 'POST', `/api/notes/${note.id}/blocks/${target}/suggest`, { instruction: '[[slow]] slowly' });
  assert.equal((await api(s, 'POST', `/api/notes/${note.id}/blocks/${target}/suggest`, { instruction: 'x' })).status, 409);
  await settled(note.id, target);

  // An AI suggestion on the learner's own block makes it AI-and-learner.
  const mine = ulid();
  await write(note.id, target, 'My own sentence.', mine);
  await api(s, 'POST', `/api/notes/${note.id}/blocks/${mine}/suggest`, { instruction: 'Fix' });
  await settled(note.id, mine);
  now = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${mine}/accept`)).json;
  assert.equal(now.blocks.find((b) => b.id === mine)?.author, 'ai+user');

  // Ask AI for a new block at a place: it arrives as a suggestion in an empty block.
  const asked = ulid();
  const ins = await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks`, { id: asked, after: mine, ask: 'A worked example' });
  assert.equal(ins.status, 201);
  now = await settled(note.id, asked);
  const fresh = now.blocks.find((b) => b.id === asked);
  assert.deepEqual([fresh?.content, fresh?.proposal?.text], ['', 'New block (A worked example) [E1].']);
  assert.ok(!now.content.includes('New block'), 'not part of the note until accepted');
  now = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${asked}/accept`)).json;
  assert.deepEqual(
    [now.blocks.find((b) => b.id === asked)?.content, now.blocks.find((b) => b.id === asked)?.author],
    ['New block (A worked example) [E1].', 'ai'],
  );
  // Discarding a new block's suggestion removes the block.
  const dropped = ulid();
  await api(s, 'POST', `/api/notes/${note.id}/blocks`, { id: dropped, after: null, ask: 'Something' });
  await settled(note.id, dropped);
  now = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${dropped}/discard`)).json;
  assert.ok(!now.blocks.some((b) => b.id === dropped));
  assert.equal(now.refs.E1?.messageId, q1.assistant.id);
});

test('asking the AI later keeps the note’s citation labels, and new exchanges get new ones', async () => {
  const { threadId, q1, b1, b2 } = await journey();
  const note = await aiNote(threadId);
  assert.deepEqual(Object.keys(note.refs), ['E1', 'E2', 'E3']);
  // A new side question from the first answer comes earlier in reading order than E2.
  const late = await branch(threadId, q1.assistant.id, 'fake model', 'A late side question');
  const outline = buildOutline(s.repo, threadId, note.refs);
  const byLabel = Object.fromEntries([...outline.refs.entries()].map(([l, r]) => [l, r.messageId]));
  assert.deepEqual(byLabel, {
    E1: q1.assistant.id,
    E2: b1.assistant.id,
    E3: b2.assistant.id,
    E4: late.assistant.id,
  });
  assert.match(outline.text, /\[E4\] Question:\nA late side question/);
});

test('a blank note gets AI help too, without a conversation to cite', async () => {
  const { threadId } = await newThread(s);
  const note = await blankNote(s.repo.getThread(threadId)?.notebookId as string);
  const id = ulid();
  await api(s, 'POST', `/api/notes/${note.id}/blocks`, { id, after: null, ask: 'An intro' });
  const now = await settled(note.id, id);
  assert.equal(now.blocks[0]?.proposal?.text, 'New block (An intro).');
});

test('text that holds several blocks becomes several blocks: written, edited, or accepted from the AI', async () => {
  const { threadId } = await newThread(s);
  const note = await blankNote(s.repo.getThread(threadId)?.notebookId as string);

  // Written in one box: a heading, its paragraph and a list.
  const a = ulid();
  const written = (await write(note.id, null, '# Unions\n\nA value of one of several types.\n\n- `A | B`\n- narrowed by checks', a)).json;
  assert.deepEqual(
    written.blocks.map((b) => b.content),
    ['# Unions', 'A value of one of several types.', '- `A | B`\n- narrowed by checks'],
  );
  assert.equal(written.blocks[0]?.id, a, 'the first part keeps the id that was written');
  assert.equal((await write(note.id, null, '# Unions\n\nagain', a)).json.blocks.length, 3, 'idempotent: nothing added twice');

  // An edit that adds a paragraph: the new paragraph is a block after it.
  const p = written.blocks[1]?.id as string;
  const edited = (
    await api<Note>(s, 'PATCH', `/api/notes/${note.id}/blocks/${p}`, {
      content: 'A value of one of several types.\n\n## Intersections\n\nAll of them at once.',
    })
  ).json;
  assert.deepEqual(
    edited.blocks.map((b) => b.content),
    ['# Unions', 'A value of one of several types.', '## Intersections', 'All of them at once.', '- `A | B`\n- narrowed by checks'],
  );
  assert.equal(edited.blocks[1]?.id, p);
  // A code fence with blank lines stays one block.
  const code = (
    await api<Note>(s, 'PATCH', `/api/notes/${note.id}/blocks/${p}`, { content: '```ts\nconst a = 1;\n\nconst b = 2;\n```' })
  ).json;
  assert.equal(code.blocks[1]?.content, '```ts\nconst a = 1;\n\nconst b = 2;\n```');
  assert.equal(code.blocks.length, 5);

  // The AI asked for a section: one suggestion to review, several blocks once accepted.
  const id = ulid();
  await api(s, 'POST', `/api/notes/${note.id}/blocks`, { id, after: null, ask: 'Type guards [[section]]' });
  const waiting = await settled(note.id, id);
  assert.equal(waiting.blocks.filter((b) => b.proposal).length, 1, 'one suggestion');
  assert.match(waiting.blocks[0]?.proposal?.text ?? '', /^## Type guards\n\nA first paragraph/);
  const accepted = (await api<Note>(s, 'POST', `/api/notes/${note.id}/blocks/${id}/accept`)).json;
  assert.deepEqual(
    accepted.blocks.slice(0, 3).map((b) => [b.content, b.author]),
    [
      ['## Type guards', 'ai'],
      ['A first paragraph about Type guards.', 'ai'],
      ['- one point\n- another point', 'ai'],
    ],
  );
  assert.equal(accepted.blocks[0]?.id, id);
  assert.equal(accepted.blocks[3]?.content, '# Unions', 'the rest of the note follows, unchanged');
  const history = (await api<{ revisions: Array<{ change: string }> }>(s, 'GET', `/api/notes/${note.id}/history`)).json;
  assert.equal(history.revisions.at(-1)?.change, 'added 3 AI blocks');

  // Blocks from before, holding several (an AI section accepted whole), are split at start-up, once.
  const old = ulid();
  s.db.sql
    .prepare("INSERT INTO note_block (id, note_id, pos, content, author, created_at, updated_at) VALUES (?, ?, 99, ?, 'ai', ?, ?)")
    .run(old, note.id, '## Graphs\n\nNodes and edges.\n\n$$\nA_{ij}\n\n$$', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  assert.equal(s.repo.recoverNotes().spread, 1);
  const after = s.repo.getNote(note.id) as Note;
  assert.deepEqual(
    after.blocks.slice(-3).map((b) => [b.content, b.author]),
    [
      ['## Graphs', 'ai'],
      ['Nodes and edges.', 'ai'],
      ['$$\nA_{ij}\n\n$$', 'ai'],
    ],
  );
  assert.equal(after.blocks.at(-3)?.id, old);
  assert.equal(s.repo.recoverNotes().spread, 0, 'once');
});

test('a section moves out into its own note, keeping the thread and citations', async () => {
  const { threadId } = await journey();
  const note = await aiNote(threadId);
  const ids = note.blocks.map((b) => b.id);
  const newId = ulid();
  // "## Open questions" and what is under it.
  const r = await api<Note>(s, 'POST', `/api/notes/${note.id}/move-out`, { id: newId, blockIds: ids.slice(2) });
  assert.equal(r.status, 201);
  assert.deepEqual(
    [r.json.title, r.json.threadId, r.json.blocks.map((b) => b.id), r.json.refs],
    ['Open questions', threadId, ids.slice(2), note.refs],
  );
  assert.equal((await api(s, 'POST', `/api/notes/${note.id}/move-out`, { id: newId, blockIds: ids.slice(2) })).status, 200);
  const left = s.repo.getNote(note.id) as Note;
  assert.deepEqual(left.blocks.map((b) => b.id), ids.slice(0, 2));
  assert.ok(!left.content.includes('Open questions'));
  // Not a heading first: the new note is named after the old one.
  const other = ulid();
  const part = await api<Note>(s, 'POST', `/api/notes/${note.id}/move-out`, { id: other, blockIds: [ids[1] as string] });
  assert.equal(part.json.title, `${note.title} (part)`);
  assert.equal((await api(s, 'POST', `/api/notes/${note.id}/move-out`, { id: ulid(), blockIds: [ulid()] })).status, 400);

  assert.equal((await api(s, 'DELETE', `/api/notes/${other}`)).status, 200);
  assert.equal((await api(s, 'GET', `/api/notes/${other}`)).status, 404);
});

test('notes from before blocks are split into blocks at start-up, and cut-off suggestions fail', async () => {
  const { threadId } = await newThread(s);
  const notebookId = s.repo.getThread(threadId)?.notebookId as string;
  const id = ulid();
  const t = new Date().toISOString();
  s.db.sql
    .prepare(
      `INSERT INTO note (id, notebook_id, thread_id, title, content, status, author, revision, created_at, updated_at)
       VALUES (?, ?, ?, 'Old', ?, 'done', 'ai+user', 3, ?, ?)`,
    )
    .run(id, notebookId, threadId, 'Intro.\n\n## Part\n\n| a | b |\n|---|---|\n| 1 | 2 |', t, t);
  const blank = await blankNote(notebookId);
  const block = ulid();
  await write(blank.id, null, 'Mine.', block);
  s.repo.startProposal(blank.id, block, 'never finishes');

  const out = s.repo.recoverNotes();
  assert.equal(out.blockified, 1);
  const old = s.repo.getNote(id) as Note;
  assert.deepEqual(
    old.blocks.map((b) => [b.content, b.author]),
    [
      ['Intro.', 'ai+user'],
      ['## Part', 'ai+user'],
      ['| a | b |\n|---|---|\n| 1 | 2 |', 'ai+user'],
    ],
  );
  assert.equal(old.revision, 3, 'splitting into blocks is not a new version');
  assert.equal(s.repo.recoverNotes().blockified, 0);
  const cut = s.repo.getNote(blank.id)?.blocks[0]?.proposal;
  assert.deepEqual([cut?.status, cut?.error], ['failed', 'The server stopped before this was finished.']);
});

test('the AI sees the note with the place marked, and its fences and markers are taken off', () => {
  const note = {
    blocks: [
      { id: 'a', content: 'One.', author: 'ai', proposal: null },
      { id: 'b', content: 'Two.', author: 'user', proposal: null },
      { id: 'c', content: '', author: 'ai', proposal: null },
    ],
  } as unknown as Note;
  assert.equal(markedNote(note, 'b', 'rewrite'), 'One.\n\n<<<REWRITE>>>\nTwo.\n<<<END>>>');
  assert.equal(markedNote(note, 'c', 'insert'), 'One.\n\nTwo.\n\n<<<NEW BLOCK HERE>>>');
  assert.equal(cleanSuggestion('```markdown\nA [E1, E2].\n```'), 'A [E1][E2].');
  assert.equal(cleanSuggestion('<<<REWRITE>>>\nB\n<<<END>>>'), 'B');
});
