import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type CreateBranchResponse,
  type ImportResponse,
  type Merge,
  type NoemaExport,
  type Note,
  type SourceDetail,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { api, newThread, readEvents, startServer, type TestServer, waitFor } from './helpers.ts';

// Acceptance (M5): export and import round-trip. A notebook with everything
// in it (answers asked again, side questions, a source, a note, a merge, the
// Trash, About you) goes out as JSON and comes back into an empty Noema the
// same, table by table.

let a: TestServer;
let b: TestServer;
before(async () => {
  a = await startServer();
  b = await startServer();
});
after(async () => {
  await a.close();
  await b.close();
});

async function ask(s: TestServer, threadId: string, content: string) {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

/** A notebook with one of everything. */
async function fill(s: TestServer) {
  const { notebookId, threadId } = await newThread(s);
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { aboutMe: 'I know basic calculus.' });
  const first = await ask(s, threadId, 'What is a gradient?');
  await ask(s, threadId, 'And a Hessian?');
  // Asked again: two revisions.
  await api(s, 'POST', `/api/messages/${first.assistant.id}/regenerate`, { revisionId: ulid() });
  await readEvents(`${s.base}/api/messages/${first.assistant.id}/events`);
  // A side question from the first revision, merged back.
  const v1 = (await api<{ revisions: Array<{ content: string }> }>(s, 'GET', `/api/messages/${first.assistant.id}/revisions`))
    .json.revisions[0]?.content;
  const at = v1?.indexOf('offline') ?? -1;
  const side = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${threadId}/branches`, {
    id: ulid(),
    anchor: { messageId: first.assistant.id, revisionId: first.assistant.revisionId, start: at, end: at + 7 },
    question: { id: ulid(), content: 'Why offline?' },
  });
  await readEvents(`${s.base}/api/messages/${side.json.assistant.id}/events`);
  const merge = await api<Merge>(s, 'POST', `/api/threads/${side.json.thread.id}/merges`, {
    id: ulid(),
    into: threadId,
    mode: 'summary',
  });
  await waitFor(() => s.repo.getMerge(merge.json.id)?.status === 'draft', 5000);
  await api(s, 'POST', `/api/merges/${merge.json.id}/accept`);
  // A source with a question about a passage.
  const text = '# Calculus\n\nThe gradient points uphill. The Hessian measures curvature.';
  const source = await api<{ id: string }>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text });
  const detail = await api<SourceDetail>(s, 'GET', `/api/sources/${source.json.id}`);
  const p = text.indexOf('points uphill');
  const about = await api<CreateBranchResponse>(s, 'POST', `/api/sources/${source.json.id}/threads`, {
    id: ulid(),
    passage: { versionId: detail.json.version.id, start: p, end: p + 13 },
    question: { id: ulid(), content: 'Why uphill?' },
  });
  await readEvents(`${s.base}/api/messages/${about.json.assistant.id}/events`);
  // A note from the thread.
  const noteId = ulid();
  await api(s, 'POST', `/api/threads/${threadId}/notes`, { id: noteId });
  await waitFor(() => s.repo.getNote(noteId)?.status === 'done', 5000);
  // A thread in the Trash.
  const gone = await newThread(s);
  await ask(s, gone.threadId, 'A question to throw away');
  await api(s, 'DELETE', `/api/threads/${gone.threadId}`);
  return { notebookId, threadId, noteId, sideId: side.json.thread.id, sourceId: source.json.id };
}

const exportOf = async (s: TestServer) => (await api<NoemaExport>(s, 'GET', '/api/export')).json;

test('acceptance (M5): export and import round-trip, table by table', async () => {
  const made = await fill(a);
  const out = await exportOf(a);
  assert.equal(out.format, 'noema-export');
  assert.equal(out.version, 2);
  for (const table of ['notebook', 'thread', 'message', 'message_revision', 'anchor', 'model_call', 'note', 'note_block']) {
    assert.ok((out.tables[table]?.length ?? 0) > 0, `${table} is exported`);
  }
  for (const table of ['thread_merge', 'source', 'source_version', 'source_anchor', 'note_revision', 'event']) {
    assert.ok((out.tables[table]?.length ?? 0) > 0, `${table} is exported`);
  }
  assert.equal('search' in out.tables, false, 'the search index is rebuilt, not exported');
  assert.equal('meta' in out.tables, false);

  // Into an empty Noema (which has made its default notebook).
  await api(b, 'GET', '/api/notebooks');
  const r = await api<ImportResponse>(b, 'POST', '/api/import', out);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.counts.notebooks, 1);
  assert.equal(r.json.counts.notes, 1);
  assert.equal(r.json.counts.sources, 1);

  // The same, table by table (the log adds one line: the import).
  const back = await exportOf(b);
  for (const [table, rows] of Object.entries(out.tables)) {
    if (table === 'event') continue;
    assert.deepEqual(back.tables[table], rows, `${table} round-trips`);
  }
  assert.deepEqual(back.tables.event?.slice(0, out.tables.event?.length), out.tables.event);

  // And it works: threads, revisions, the note, search, What was sent.
  const thread = (await api<ThreadDetail>(b, 'GET', `/api/threads/${made.threadId}`)).json;
  assert.deepEqual(thread, (await api<ThreadDetail>(a, 'GET', `/api/threads/${made.threadId}`)).json);
  assert.equal(thread.messages[1]?.revisions, 2);
  assert.equal(thread.merges.length, 1);
  const note = (await api<Note>(b, 'GET', `/api/notes/${made.noteId}`)).json;
  assert.deepEqual(note, (await api<Note>(a, 'GET', `/api/notes/${made.noteId}`)).json);
  const found = await api<{ hits: unknown[] }>(b, 'GET', '/api/search?q=gradient');
  assert.ok(found.json.hits.length > 0, 'search is rebuilt');
  assert.equal((await api(b, 'GET', `/api/messages/${thread.messages[1]?.id}/context`)).status, 200);
  const trash = await api<{ threads: unknown[] }>(b, 'GET', `/api/notebooks/${made.notebookId}/trash`);
  assert.equal(trash.json.threads.length, 1, 'the Trash comes back too');
  // And the notebook goes on: a new question in the imported thread.
  await ask(b, made.threadId, 'And a Jacobian?');

  // Now B is not empty: a second import is refused, and changes nothing.
  const again = await api(b, 'POST', '/api/import', out);
  assert.equal(again.status, 409);
});

test('an import that does not fit is refused whole', async () => {
  const c = await startServer();
  try {
    await api(c, 'GET', '/api/notebooks');
    const before = await exportOf(c);
    const out = await exportOf(a);
    const bad = (change: (x: NoemaExport) => void) => {
      const copy = structuredClone(out);
      change(copy);
      return api<{ error: { message: string } }>(c, 'POST', '/api/import', copy);
    };
    const older = await bad((x) => {
      x.schemaVersion -= 1;
    });
    assert.equal(older.status, 400);
    assert.match(older.json.error.message, /schema version/);
    assert.equal((await bad((x) => void (x.tables.secrets = []))).status, 400, 'an unknown table');
    assert.equal(
      (await bad((x) => void (x.tables.thread?.[0] && (x.tables.thread[0].evil = 'x')))).status,
      400,
      'an unknown column',
    );
    // A message whose thread is not there: the foreign keys are checked at the end, and nothing stays.
    const broken = await bad((x) => {
      x.tables.thread = [];
    });
    assert.equal(broken.status, 400, JSON.stringify(broken.json));
    assert.deepEqual((await exportOf(c)).tables.notebook, before.tables.notebook, 'nothing changed');
    assert.equal((await exportOf(c)).tables.message?.length ?? 0, 0);
    assert.equal(
      (await api(c, 'POST', '/api/import', { format: 'something-else' })).status,
      400,
      'not an export at all',
    );
  } finally {
    await c.close();
  }
});

test('the Markdown export reads the notebook in order, without the Trash', async () => {
  const nb = (await api<{ notebooks: Array<{ id: string }> }>(a, 'GET', '/api/notebooks')).json.notebooks[0];
  const res = await fetch(`${a.base}/api/notebooks/${nb?.id}/export.md`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="noema-.*\.md"/);
  const md = await res.text();
  assert.ok(md.includes('## About you\n\nI know basic calculus.'));
  assert.ok(md.includes('**You asked:** What is a gradient?'));
  assert.ok(md.includes('Asked again: this is answer 2.'), 'answers as the ones in use');
  assert.ok(md.includes('#### ↳ '), 'side questions under their thread');
  assert.ok(md.includes('> points uphill'), 'a question about a source shows its passage');
  assert.ok(md.includes('## Notes') && md.includes('## Sources'));
  assert.ok(!md.includes('A question to throw away'), 'not the Trash');
  assert.equal((await fetch(`${a.base}/api/notebooks/${ulid()}/export.md`)).status, 404);
});
