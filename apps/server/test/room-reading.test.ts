import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type AskResponse, type AssistantAction, type ItemLink, type Message, type MessageContext, type RoomView, type Source, ulid } from '@noema/core';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, readEvents, startServer, type TestServer } from './helpers.ts';

// Reading a room (ADR 0027): on the learner's word, each thing gets a short
// summary whose points link to the words they quote; then links are
// suggested between things, which the learner accepts, changes, dismisses or
// draws. All with the fake model, and made-up text.

let s: TestServer;
let notebookId = '';
const TEXT = '# Week 4\n\nEvery worker holds a full copy of the model and a shard of the batch.\n\nGradients are averaged with an all-reduce after the backward pass.';

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
  // These tests are of changes proposed for the learner's Do it (ADR 0024); acting on its own is in assistant-acts.test.ts.
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { assistantAsks: true });
});
after(() => s.close());

const room = async (id: string) => (await api<RoomView>(s, 'GET', `/api/rooms/${id}`)).json;
async function read(id: string): Promise<RoomView> {
  const r = await api<{ reading: { phase: string } }>(s, 'POST', `/api/rooms/${id}/read`, {});
  assert.equal(r.status, 202);
  let v = await room(id);
  const start = Date.now();
  while (v.reading && (v.reading.phase === 'summaries' || v.reading.phase === 'links' || v.reading.phase === 'brief')) {
    if (Date.now() - start > 5000) throw new Error('reading did not finish');
    await new Promise((r) => setTimeout(r, 20));
    v = await room(id);
  }
  return v;
}

let deck: Source;
let threadId = '';
let noteId = '';
let roomId = '';

test('reading a room: each thing gets a summary whose points link to the words they quote', async () => {
  deck = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: TEXT })).json;
  threadId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: threadId });
  const a = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: 'What does an all-reduce do?' });
  await readEvents(`${s.base}/api/messages/${a.json.assistant.id}/events`);
  noteId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id: noteId, title: 'Parallelism' });
  await api(s, 'POST', `/api/notes/${noteId}/blocks`, { id: ulid(), after: null, content: 'Data parallel keeps a copy of the model on every worker.' });

  roomId = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, {
    id: roomId,
    title: 'Parallelism',
    items: [
      { kind: 'source', id: deck.id },
      { kind: 'thread', id: threadId },
      { kind: 'note', id: noteId },
    ],
  });
  const before = await room(roomId);
  assert.equal(before.unread, 3);
  assert.deepEqual(before.gists, {});
  assert.equal(before.reading, null);

  const v = await read(roomId);
  assert.equal(v.reading?.phase, 'done');
  assert.equal(v.reading?.total, 3);
  assert.equal(v.unread, 0);
  const g = v.gists[`source:${deck.id}`];
  assert.match(g?.text ?? '', /^Fake summary of “Week 4”: Every worker holds/);
  assert.equal(g?.fresh, true);
  assert.deepEqual(
    g?.points.map((p) => [p.text, p.target?.kind === 'source' ? TEXT.slice(p.target.at, p.target.at + 12) : null]),
    [
      ['Point 1', 'Every worker'],
      ['Point 2', 'Gradients ar'],
      ['Not in the text', null],
    ],
  );
  // A thread's points open the message they quote.
  const t = v.gists[`thread:${threadId}`]?.points[0]?.target;
  assert.equal(t?.kind, 'thread');
  assert.ok(t?.kind === 'thread' && t.messageId);
  const n = v.gists[`note:${noteId}`]?.points[0]?.target;
  assert.ok(n?.kind === 'note' && n.blockId);

  // Then links between them, suggested, with why.
  assert.equal(v.reading?.suggested, 2);
  assert.deepEqual(
    v.itemLinks.map((l) => [l.from.kind, l.to.kind, l.kind, l.status, l.by]),
    [
      ['thread', 'source', 'explains', 'suggested', 'ai'],
      ['note', 'thread', 'builds-on', 'suggested', 'ai'],
    ],
  );
  assert.match(v.itemLinks[0]?.why ?? '', /^Fake: 2 bears on 1/);
});

test('read again: only what changed is summarized again; links once suggested are not suggested again', async () => {
  let v = await read(roomId);
  assert.equal(v.reading?.total, 0);
  assert.equal(v.reading?.suggested, 0);
  // A new question in the thread: its summary is out of date until read again.
  const a = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: 'And with eight GPUs?' });
  await readEvents(`${s.base}/api/messages/${a.json.assistant.id}/events`);
  v = await room(roomId);
  assert.equal(v.unread, 1);
  assert.equal(v.gists[`thread:${threadId}`]?.fresh, false);
  v = await read(roomId);
  assert.equal(v.reading?.total, 1);
  assert.equal(v.gists[`thread:${threadId}`]?.fresh, true);
  assert.equal(v.itemLinks.length, 2);
});

test('links are accepted, changed, turned around, dismissed (and stay away), deleted; or drawn by hand', async () => {
  const v = await room(roomId);
  const [first, second] = v.itemLinks as [ItemLink, ItemLink];
  const accepted = (await api<ItemLink>(s, 'PATCH', `/api/links/${first.id}`, { status: 'accepted' })).json;
  assert.equal(accepted.status, 'accepted');
  // Changing a suggestion accepts it; turning it around swaps the ends.
  const changed = (await api<ItemLink>(s, 'PATCH', `/api/links/${second.id}`, { kind: 'example-of', label: 'shows it on one GPU', flip: true })).json;
  assert.deepEqual([changed.kind, changed.label, changed.status, changed.from.kind, changed.to.kind], ['example-of', 'shows it on one GPU', 'accepted', 'thread', 'note']);
  await api(s, 'PATCH', `/api/links/${second.id}`, { status: 'dismissed' });
  assert.equal((await room(roomId)).itemLinks.length, 1);
  const again = await read(roomId);
  assert.equal(again.reading?.suggested, 0, 'a dismissed link is not suggested again');

  // Drawn by hand: accepted at once; not twice between the same two.
  const mine = await api<ItemLink>(s, 'POST', `/api/notebooks/${notebookId}/links`, {
    id: ulid(),
    from: { kind: 'note', id: noteId },
    to: { kind: 'source', id: deck.id },
    kind: 'part-of',
  });
  assert.equal(mine.status, 201);
  assert.deepEqual([mine.json.by, mine.json.status], ['you', 'accepted']);
  const twice = await api(s, 'POST', `/api/notebooks/${notebookId}/links`, {
    id: ulid(),
    from: { kind: 'source', id: deck.id },
    to: mine.json.from,
    kind: 'related',
  });
  assert.equal(twice.status, 409);
  assert.equal((await api(s, 'POST', `/api/notebooks/${notebookId}/links`, { id: ulid(), from: mine.json.from, to: mine.json.from, kind: 'related' })).status, 400);
  assert.equal((await api(s, 'DELETE', `/api/links/${mine.json.id}`)).status, 200);
  assert.equal((await room(roomId)).itemLinks.length, 1);
});

test('a line the learner draws: the AI chooses what it means and why, turning it around if it reads better so; changed by hand, the reason goes', async () => {
  const a = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Ring all-reduce\n\nEach worker sends to the next.' })).json;
  const b = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Collectives\n\nAll-reduce, all-gather, broadcast.' })).json;
  const drawn = await api<ItemLink>(s, 'POST', `/api/notebooks/${notebookId}/links`, { id: ulid(), from: { kind: 'source', id: a.id }, to: { kind: 'source', id: b.id }, kind: 'related' });
  assert.equal(drawn.status, 201);
  const chosen = await api<ItemLink>(s, 'POST', `/api/links/${drawn.json.id}/choose`, {});
  assert.equal(chosen.status, 200);
  assert.deepEqual([chosen.json.kind, chosen.json.from.id, chosen.json.by, chosen.json.status], ['builds-on', a.id, 'you', 'accepted']);
  assert.equal(chosen.json.why, 'Fake: the AI chose builds on.');
  // Changed by hand: the AI's reason no longer says it.
  const mine = await api<ItemLink>(s, 'PATCH', `/api/links/${drawn.json.id}`, { kind: 'part-of' });
  assert.deepEqual([mine.json.kind, mine.json.why], ['part-of', null]);

  // A title that asks for it: turned around.
  const c = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Flip me [[flip-link]]\n\nText.' })).json;
  const other = await api<ItemLink>(s, 'POST', `/api/notebooks/${notebookId}/links`, { id: ulid(), from: { kind: 'source', id: c.id }, to: { kind: 'source', id: b.id }, kind: 'related' });
  const flipped = (await api<ItemLink>(s, 'POST', `/api/links/${other.json.id}/choose`, {})).json;
  assert.deepEqual([flipped.kind, flipped.from.id, flipped.to.id], ['explains', b.id, c.id]);
  assert.equal((await api(s, 'POST', `/api/links/${ulid()}/choose`, {})).status, 404);

  // Without a model: said in words; the line stays as drawn.
  const noModel = await startServer({ models: { fake: () => ({ name: 'none', model: 'none', configured: false, stream: () => { throw new Error('no'); } }) } });
  try {
    const nb = (await api<{ notebooks: Array<{ id: string }> }>(noModel, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
    const x = (await api<Source>(noModel, 'POST', `/api/notebooks/${nb}/sources`, { id: ulid(), text: '# X\n\nx' })).json;
    const y = (await api<Source>(noModel, 'POST', `/api/notebooks/${nb}/sources`, { id: ulid(), text: '# Y\n\ny' })).json;
    const l = (await api<ItemLink>(noModel, 'POST', `/api/notebooks/${nb}/links`, { id: ulid(), from: { kind: 'source', id: x.id }, to: { kind: 'source', id: y.id }, kind: 'related' })).json;
    const r = await api<{ error: { message: string } }>(noModel, 'POST', `/api/links/${l.id}/choose`, {});
    assert.equal(r.status, 409);
    assert.equal((await api<ItemLink>(noModel, 'GET', `/api/links/${l.id}`)).json.kind, 'related');
  } finally {
    noModel.close();
  }
});

test("a room's brief: written after the summaries, older when a thing changes; a thread in the room is answered with it", async () => {
  const src = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Activation memory\n\nSaved activations fill memory during training.' })).json;
  const t = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: t });
  const first = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'Why is backprop memory-bound?' });
  await readEvents(`${s.base}/api/messages/${first.json.assistant.id}/events`);
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'ML systems', items: [{ kind: 'source', id: src.id }, { kind: 'thread', id: t }] });
  assert.equal((await room(id)).brief, null);
  const v = await read(id);
  assert.equal(v.reading?.phase, 'done');
  assert.deepEqual(v.reading?.current, []);
  assert.equal(v.brief?.text, 'Fake brief of “ML systems”: 2 things, read in order.');
  assert.equal(v.brief?.fresh, true);
  assert.equal(v.brief?.open.length, 1);
  assert.ok(v.brief?.open[0]?.item, 'the open question is tied to a thing in the room');

  // Asked again in the thread: the room goes with the question, as its own part.
  const next = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'And with checkpointing?' });
  await readEvents(`${s.base}/api/messages/${next.json.assistant.id}/events`);
  const sent = (await api<MessageContext>(s, 'GET', `/api/messages/${next.json.assistant.id}/context`)).json;
  assert.ok(sent.manifest.parts.some((p) => p.kind === 'room'));
  assert.match(sent.request?.[0]?.content ?? '', /## The room this conversation is in[\s\S]*room "ML systems"[\s\S]*Fake brief of “ML systems”[\s\S]*Still open in the room:\n- What is still unclear about/);

  // The thread changed: its summary is older, and so is the brief; read again, fresh.
  assert.equal((await room(id)).brief?.fresh, false);
  assert.equal((await read(id)).brief?.fresh, true);
});

test('asked in a room, the web is searched when the question needs it: shown, sent labelled, kept to add; never with the room\'s web off', async () => {
  const t = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/threads`, { id: t });
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Memory', items: [{ kind: 'thread', id: t }] });
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'Gradient checkpointing tradeoffs today [[web]]' });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const answer = (await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${t}`)).json.messages.find((m) => m.id === r.json.assistant.id) as Message;
  assert.deepEqual(answer.lookups?.steps, [{ tool: 'web', label: 'Searched the web “Gradient checkpointing tradeoffs today”', found: 3 }]);
  assert.equal(answer.web.length, 3);
  assert.deepEqual(answer.web.map((w) => [w.n, w.status, w.site]), [[1, 'found', 'example.org'], [2, 'found', 'example.org'], [3, 'found', 'example.org']]);
  const sent = (await api<MessageContext>(s, 'GET', `/api/messages/${r.json.assistant.id}/context`)).json;
  assert.ok(sent.manifest.parts.some((p) => p.kind === 'web'));
  assert.match(sent.request?.at(-1)?.content ?? '', /^## Found on the web for this question[\s\S]*\[web 1\] “Fake page 1 on Gradient checkpointing tradeoffs today” \(example\.org, 2026-01-01\)/);

  // Left: dismissed.
  const left = await api<{ find: { status: string } }>(s, 'POST', `/api/web/${answer.web[2]?.id}/dismiss`, {});
  assert.equal(left.json.find.status, 'dismissed');

  // Only the pages the answer cites stay on offer (ADR 0033).
  const some = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'Checkpointing in practice [[web]] [[web-cites:2]]' });
  await readEvents(`${s.base}/api/messages/${some.json.assistant.id}/events`);
  const cited = (await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${t}`)).json.messages.find((m) => m.id === some.json.assistant.id) as Message;
  assert.match(cited.content, /From the web: \[web 2\]\.$/);
  assert.deepEqual(cited.web.map((w) => w.n), [2]);

  // A question that needs nothing from the web: no search.
  const plain = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'What is a gradient?' });
  await readEvents(`${s.base}/api/messages/${plain.json.assistant.id}/events`);
  const quiet = (await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${t}`)).json.messages.find((m) => m.id === plain.json.assistant.id) as Message;
  assert.deepEqual([quiet.web.length, quiet.lookups], [0, null]);

  // The room's web off: no search, whatever the question.
  assert.equal((await api<{ web: boolean }>(s, 'PUT', `/api/rooms/${id}/web`, { on: false })).json.web, false);
  const off = await api<AskResponse>(s, 'POST', `/api/threads/${t}/messages`, { id: ulid(), content: 'Newest papers on this [[web]]' });
  await readEvents(`${s.base}/api/messages/${off.json.assistant.id}/events`);
  const none = (await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${t}`)).json.messages.find((m) => m.id === off.json.assistant.id) as Message;
  assert.equal(none.web.length, 0);
  assert.equal((await room(id)).webAvailable, true);
});

test('pages for what is still open in a room: one search for each open question, new pages only; dismissed ones go', async () => {
  const src = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Recomputation\n\nKeep some activations, recompute the rest.' })).json;
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Recompute', items: [{ kind: 'source', id: src.id }] });
  assert.equal((await api(s, 'POST', `/api/rooms/${id}/find-sources`, {})).status, 409, 'nothing open before it is read');
  await read(id);
  const found = await api<{ finds: Array<{ id: string; query: string; url: string }> }>(s, 'POST', `/api/rooms/${id}/find-sources`, {});
  assert.equal(found.status, 200);
  assert.equal(found.json.finds.length, 3);
  assert.match(found.json.finds[0]?.query ?? '', /^What is still unclear about/);
  // Asked again: the same pages are not found twice.
  assert.equal((await api<{ finds: unknown[] }>(s, 'POST', `/api/rooms/${id}/find-sources`, {})).json.finds.length, 3);
  await api(s, 'POST', `/api/web/${found.json.finds[0]?.id}/dismiss`, {});
  assert.equal((await room(id)).webFinds.length, 2);
  assert.equal((await api(s, 'POST', `/api/web/${ulid()}/add`, {})).status, 404);
});

test('reading fails in words: without a model, or when the model fails', async () => {
  const noModel = await startServer({ models: { fake: () => ({ name: 'none', model: 'none', configured: false, stream: () => { throw new Error('no'); } }) } });
  try {
    const nb = (await api<{ notebooks: Array<{ id: string }> }>(noModel, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
    const src = (await api<Source>(noModel, 'POST', `/api/notebooks/${nb}/sources`, { id: ulid(), text: TEXT })).json;
    const id = ulid();
    await api(noModel, 'POST', `/api/notebooks/${nb}/rooms`, { id, title: 'R', items: [{ kind: 'source', id: src.id }] });
    await api(noModel, 'POST', `/api/rooms/${id}/read`, {});
    let v = (await api<RoomView>(noModel, 'GET', `/api/rooms/${id}`)).json;
    for (let i = 0; i < 50 && v.reading?.phase !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      v = (await api<RoomView>(noModel, 'GET', `/api/rooms/${id}`)).json;
    }
    assert.equal(v.reading?.phase, 'failed');
    assert.match(v.reading?.error ?? '', /Connect a model first/);
  } finally {
    noModel.close();
  }

  const bad = (await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Broken\n\nThis one [[fail-gist]] cannot be read.' })).json;
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/rooms`, { id, title: 'Broken', items: [{ kind: 'source', id: bad.id }] });
  const v = await read(id);
  assert.equal(v.reading?.phase, 'failed');
  assert.match(v.reading?.error ?? '', /unavailable/);
  assert.equal(v.unread, 1);
});

test('the summaries and links travel with the notebook export', async () => {
  const ex = (await api<{ tables: Record<string, unknown[]> }>(s, 'GET', '/api/export')).json;
  assert.ok((ex.tables.gist ?? []).length >= 3);
  assert.ok((ex.tables.item_link ?? []).length >= 1);
});

test('the Assistant knows the room it is asked in, links two things in it, and takes one out, each on Do it, with Undo', async () => {
  const me = (await api<{ id: string }>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json;
  const ask = async (content: string) => {
    const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${me.id}/messages`, {
      id: ulid(),
      content,
      place: { kind: 'room', id: roomId },
    });
    await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
    const request = (await api<{ request: Array<{ role: string; content: string }> | null }>(s, 'GET', `/api/messages/${r.json.assistant.id}/context`)).json.request ?? [];
    const actions = (await api<{ actions: AssistantAction[] }>(s, 'GET', `/api/threads/${me.id}/actions`)).json.actions.filter((a) => a.messageId === r.json.assistant.id);
    return { request, actions };
  };
  const first = await ask('What is in here?');
  const question = first.request.findLast((m) => m.role === 'user')?.content ?? '';
  assert.match(question, /They are in the room “Parallelism” \(1 sources, 1 threads, 1 notes\)/);
  assert.match(question, /- \[(\d+)\] Source “Week 4”: Fake summary of “Week 4”/);
  assert.match(question, /Links between them:\n- \[\d+\] explains \[\d+\]/);
  const source = /\[(\d+)\] Source “Week 4”/.exec(question)?.[1];
  const note = /\[(\d+)\] Note “Parallelism”/.exec(question)?.[1];
  assert.ok(source && note);

  const linked = await ask(`Link them [[call:link:{"from":${note},"to":${source},"kind":"part-of","words":"sums it up"}]]`);
  assert.equal(linked.actions[0]?.summary, 'Link “Parallelism” → “Week 4”: sums it up');
  const done = await act(linked.actions[0] as AssistantAction, 'run');
  assert.equal(done.status, 'done');
  let mine = (await room(roomId)).itemLinks.find((l) => l.by === 'assistant');
  assert.deepEqual([mine?.kind, mine?.label, mine?.status], ['part-of', 'sums it up', 'accepted']);
  await act(done, 'undo');
  mine = (await room(roomId)).itemLinks.find((l) => l.by === 'assistant');
  assert.equal(mine, undefined);

  const out = await ask(`Out [[call:take_out_of_room:{"refs":[${note}],"room":"parallelism"}]]`);
  assert.equal(out.actions[0]?.summary, 'Take “Parallelism” out of the room “Parallelism”');
  const taken = await act(out.actions[0] as AssistantAction, 'run');
  assert.equal((await room(roomId)).room.counts.notes, 0);
  await act(taken, 'undo');
  assert.equal((await room(roomId)).room.counts.notes, 1);
});

const act = async (a: AssistantAction, what: 'run' | 'undo') =>
  (await api<{ action: AssistantAction }>(s, 'POST', `/api/assistant/actions/${a.id}/${what}`, {})).json.action;

test('a notebook from before reading rooms upgrades in place, with no summaries or links', () => {
  const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v19 = join(dir, 'v19');
  mkdirSync(v19);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= 19)) {
    copyFileSync(join(MIGRATIONS, f), join(v19, f));
  }
  const file = join(dir, 'n.db');
  const old = new Db(file);
  old.migrate(v19);
  assert.equal(old.version, 19);
  const t = new Date().toISOString();
  const nb = ulid();
  old.sql.prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(nb, 'N', '', t, t);
  old.sql.prepare('INSERT INTO room (id, notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(ulid(), nb, 'Before', t, t);
  old.close();
  const db = new Db(file);
  db.migrate();
  const repo = new Repo(db);
  const r = repo.listRooms(nb)[0];
  assert.equal(r?.title, 'Before');
  assert.deepEqual(repo.listItemLinks(nb), []);
  assert.equal(repo.roomView(r?.id ?? '')?.unread, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
