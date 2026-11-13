import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  type AssistantAction,
  type FileEntry,
  type Folder,
  type Message,
  type MessageContext,
  type Note,
  type Source,
  type SourceDetail,
  type Thread,
  ulid,
} from '@noema/core';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, readEvents, startServer, type TestServer } from './helpers.ts';

// Folders on the learner's computer (ADR 0025): linked by path, listed, read
// in place as sources (read again when they change), written when asked
// (with a backup to undo), notes saved into them and made from them; and the
// Assistant's file tools. Every path stays inside the folder.

let s: TestServer;
let notebookId = '';
let root = '';
let folder: Folder;

before(async () => {
  s = await startServer();
  notebookId = (await api<{ notebooks: Array<{ id: string }> }>(s, 'GET', '/api/notebooks')).json.notebooks[0]?.id as string;
  root = mkdtempSync(join(tmpdir(), 'noema-folder-'));
  mkdirSync(join(root, 'Course', 'week4'), { recursive: true });
  mkdirSync(join(root, 'Course', 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'Course', '.git'), { recursive: true });
  writeFileSync(join(root, 'Course', 'week4', 'notes.md'), '# Week 4\n\nData parallel: every worker holds a copy of the model.\n');
  writeFileSync(join(root, 'Course', 'train.py'), 'def step(batch):\n    return all_reduce(grads)\n');
  writeFileSync(join(root, 'Course', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(root, 'Course', '.hidden'), 'secret');
  writeFileSync(join(root, 'outside.txt'), 'not in the folder');
  copyFileSync(new URL('./fixtures/slides.pdf', import.meta.url), join(root, 'Course', 'week4', 'slides.pdf'));
  symlinkSync(join(root, 'outside.txt'), join(root, 'Course', 'leak.txt'));
  folder = (await api<Folder>(s, 'POST', `/api/notebooks/${notebookId}/folders`, { id: ulid(), path: join(root, 'Course') })).json;
});
after(() => s.close());

const tree = async (dir = '') =>
  (await api<{ entries: FileEntry[] }>(s, 'GET', `/api/folders/${folder.id}/tree?dir=${encodeURIComponent(dir)}`)).json.entries;
const open = (path: string) => api<{ source: Source }>(s, 'POST', `/api/folders/${folder.id}/open`, { path });
const detail = async (id: string) => (await api<SourceDetail>(s, 'GET', `/api/sources/${id}`)).json;

test('a folder is linked by its whole path; a wrong one is refused in words', async () => {
  assert.equal(folder.name, 'Course');
  assert.equal(folder.missing, false);
  for (const [path, words] of [
    ['relative/path', /whole path/],
    [join(root, 'nope'), /no folder at that path/],
    [join(root, 'outside.txt'), /a file, not a folder/],
  ] as const) {
    const r = await api<{ error: { message: string } }>(s, 'POST', `/api/notebooks/${notebookId}/folders`, { id: ulid(), path });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, words);
  }
  const list = (await api<{ folders: Folder[] }>(s, 'GET', `/api/notebooks/${notebookId}/folders`)).json.folders;
  assert.deepEqual(list.map((f) => f.name), ['Course']);
});

test('its files are listed: folders first; hidden and generated folders left out; what can be read', async () => {
  const entries = await tree();
  assert.deepEqual(
    entries.map((e) => [e.name, e.kind, e.readable]),
    [
      ['week4', 'dir', false],
      ['leak.txt', 'file', true],
      ['photo.png', 'file', false],
      ['train.py', 'file', true],
    ],
  );
  assert.deepEqual((await tree('week4')).map((e) => e.path), ['week4/notes.md', 'week4/slides.pdf']);
  assert.equal((await api(s, 'GET', `/api/folders/${folder.id}/tree?dir=..`)).status, 400);
});

test('a file opens as a source: code as a code block, Markdown as it is, a PDF page by page; read again when it changes', async () => {
  const code = (await open('train.py')).json.source;
  assert.deepEqual(code.linked, { folderId: folder.id, path: 'train.py' });
  assert.equal(code.title, 'train.py');
  assert.equal((await detail(code.id)).version.content, '```python\ndef step(batch):\n    return all_reduce(grads)\n```');
  // Unchanged: the same version.
  assert.equal((await open('train.py')).json.source.latestVersionId, code.latestVersionId);
  // Changed on disk: a new version.
  writeFileSync(join(root, 'Course', 'train.py'), 'def step(batch):\n    return mean(grads)\n');
  const again = (await open('train.py')).json.source;
  assert.equal(again.id, code.id);
  assert.notEqual(again.latestVersionId, code.latestVersionId);
  assert.equal(again.versions, 2);

  const md = (await open('week4/notes.md')).json.source;
  assert.match((await detail(md.id)).version.content, /^# Week 4\n\nData parallel/);
  const pdf = (await open('week4/slides.pdf')).json.source;
  assert.match((await detail(pdf.id)).version.content, /## Page 1/);
  assert.equal((await tree('week4')).find((e) => e.name === 'slides.pdf')?.sourceId, pdf.id);

  // Not text, outside the folder (by .. or by a link): refused.
  assert.match(((await open('photo.png')).json as unknown as { error: { message: string } }).error.message, /not text/);
  assert.equal((await open('../outside.txt')).status, 400);
  assert.match(((await open('leak.txt')).json as unknown as { error: { message: string } }).error.message, /outside the folder/);
});

test('a text file is written from Noema, unless it changed on disk since it was read', async () => {
  const src = (await open('week4/notes.md')).json.source;
  const saved = await api<{ source: Source }>(s, 'PUT', `/api/folders/${folder.id}/file`, {
    path: 'week4/notes.md',
    content: '# Week 4\n\nEdited in Noema.\n',
    versionId: src.latestVersionId,
  });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(root, 'Course', 'week4', 'notes.md'), 'utf8'), '# Week 4\n\nEdited in Noema.\n');
  assert.notEqual(saved.json.source.latestVersionId, src.latestVersionId);
  // Edited from the old version, after the file changed: refused, the file left alone.
  writeFileSync(join(root, 'Course', 'week4', 'notes.md'), '# Week 4\n\nChanged elsewhere.\n');
  const stale = await api(s, 'PUT', `/api/folders/${folder.id}/file`, {
    path: 'week4/notes.md',
    content: 'lost',
    versionId: saved.json.source.latestVersionId,
  });
  assert.equal(stale.status, 409);
  assert.equal(readFileSync(join(root, 'Course', 'week4', 'notes.md'), 'utf8'), '# Week 4\n\nChanged elsewhere.\n');

  // The editor reads the file as it is on disk, and saves against what it read.
  const raw = (await api<{ text: string; hash: string }>(s, 'GET', `/api/folders/${folder.id}/file?path=train.py`)).json;
  assert.equal(raw.text, 'def step(batch):\n    return mean(grads)\n');
  const ok = await api(s, 'PUT', `/api/folders/${folder.id}/file`, { path: 'train.py', content: raw.text, hash: raw.hash });
  assert.equal(ok.status, 200);
  const late = await api(s, 'PUT', `/api/folders/${folder.id}/file`, { path: 'train.py', content: 'x', hash: 'a'.repeat(64) });
  assert.equal(late.status, 409);
  assert.equal((await api(s, 'GET', `/api/folders/${folder.id}/file?path=week4/slides.pdf`)).status, 400);
});

test('a note is saved into the folder as Markdown, and a file becomes a note', async () => {
  const id = ulid();
  await api(s, 'POST', `/api/notebooks/${notebookId}/notes`, { id, title: 'Parallelism' });
  await api(s, 'POST', `/api/notes/${id}/blocks`, { id: ulid(), after: null, content: 'Averaged with an all-reduce.' });
  const r = await api<{ path: string }>(s, 'POST', `/api/notes/${id}/save-to-folder`, { folderId: folder.id, path: 'notes/parallelism' });
  assert.equal(r.json.path, 'notes/parallelism.md');
  assert.equal(readFileSync(join(root, 'Course', 'notes', 'parallelism.md'), 'utf8'), '# Parallelism\n\nAveraged with an all-reduce.\n');
  // Again, to the same name: refused unless asked to replace it.
  await api(s, 'PATCH', `/api/notes/${id}`, { title: 'Parallelism, again' });
  const twice = await api<{ error: { message: string } }>(s, 'POST', `/api/notes/${id}/save-to-folder`, { folderId: folder.id, path: 'notes/parallelism.md' });
  assert.equal(twice.status, 400);
  assert.match(twice.json.error.message, /already a file “notes\/parallelism\.md”/);
  await api(s, 'POST', `/api/notes/${id}/save-to-folder`, { folderId: folder.id, path: 'notes/parallelism.md', replace: true });
  assert.match(readFileSync(join(root, 'Course', 'notes', 'parallelism.md'), 'utf8'), /^# Parallelism, again\n/);
  await api(s, 'PATCH', `/api/notes/${id}`, { title: 'Parallelism' });
  await api(s, 'POST', `/api/notes/${id}/save-to-folder`, { folderId: folder.id, path: 'notes/parallelism.md', replace: true });

  const made = await api<Note>(s, 'POST', `/api/notebooks/${notebookId}/notes/from-file`, {
    id: ulid(),
    folderId: folder.id,
    path: 'notes/parallelism.md',
  });
  assert.equal(made.status, 201);
  assert.equal(made.json.title, 'Parallelism');
  // Its opening heading is the title, not a block too.
  assert.deepEqual(made.json.blocks.map((b) => b.content), ['Averaged with an all-reduce.']);
  const code = await api<Note>(s, 'POST', `/api/notebooks/${notebookId}/notes/from-file`, { id: ulid(), folderId: folder.id, path: 'train.py' });
  assert.equal(code.json.title, 'train');
  assert.match(code.json.blocks[0]?.content ?? '', /^```python\n/);
});

async function askAssistant(content: string) {
  const me = (await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json;
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${me.id}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  const tools = ((await api<MessageContext>(s, 'GET', `/api/messages/${r.json.assistant.id}/context`)).json.request ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.content);
  const actions = (await api<{ actions: AssistantAction[] }>(s, 'GET', `/api/threads/${me.id}/actions`)).json.actions.filter(
    (a) => a.messageId === r.json.assistant.id,
  );
  const answer = (await api<{ messages: Message[] }>(s, 'GET', `/api/threads/${me.id}`)).json.messages.at(-1);
  return { tools, actions, answer };
}
const call = (name: string, args: unknown) => `[[call:${name}:${JSON.stringify(args)}]]`;
const act = async (a: AssistantAction, what: 'run' | 'undo') =>
  (await api<{ action: AssistantAction }>(s, 'POST', `/api/assistant/actions/${a.id}/${what}`, {})).json.action;

test('the Assistant lists, searches and opens files; writes and edits are proposed, done on Do it, undone', async () => {
  const { tools } = await askAssistant(
    `Files [[together]] ${call('list_files', {})} ${call('list_files', { path: 'Course/week4' })} ${call('find_in_files', { query: 'all-reduce' })} ${call('open_file', { path: 'Course/week4/notes.md' })}`,
  );
  assert.equal(tools[0], 'Linked folders: 1.\n- Course/');
  assert.match(tools[1] ?? '', /^In “Course\/week4”: 2\.\n- Course\/week4\/notes\.md · \d+ B · opened before\n- Course\/week4\/slides\.pdf/);
  assert.match(tools[2] ?? '', /- Course\/notes\/parallelism\.md:3: Averaged with an all-reduce\./);
  assert.match(tools[3] ?? '', /^Course\/week4\/notes\.md, opened as a source\.\nSource “notes\.md”/);

  const w = await askAssistant(
    `Write [[together]] ${call('write_file', { path: 'Course/summary.md', content: '# Summary\n' })} ${call('edit_file', { path: 'Course/train.py', old: 'mean(grads)', new: 'all_reduce(grads) / n' })} ${call('edit_file', { path: 'Course/train.py', old: 'nowhere', new: 'x' })}`,
  );
  assert.deepEqual(
    w.actions.map((a) => [a.kind, a.summary]),
    [
      ['write_file', 'Make the file “Course/summary.md”'],
      ['edit_file', 'Edit “Course/train.py”'],
    ],
  );
  assert.equal(w.actions[1]?.detail, '- mean(grads)\n+ all_reduce(grads) / n');
  assert.match(w.tools[2] ?? '', /not in the file/);
  assert.equal(existsSync(join(root, 'Course', 'summary.md')), false, 'nothing written before Do it');

  const made = await act(w.actions[0] as AssistantAction, 'run');
  assert.equal(made.status, 'done');
  assert.equal(readFileSync(join(root, 'Course', 'summary.md'), 'utf8'), '# Summary\n');
  const edited = await act(w.actions[1] as AssistantAction, 'run');
  assert.equal(edited.status, 'done');
  assert.equal(readFileSync(join(root, 'Course', 'train.py'), 'utf8'), 'def step(batch):\n    return all_reduce(grads) / n\n');
  assert.equal(edited.open?.kind, 'source');

  await act(edited, 'undo');
  assert.equal(readFileSync(join(root, 'Course', 'train.py'), 'utf8'), 'def step(batch):\n    return mean(grads)\n');
  await act(made, 'undo');
  assert.equal(existsSync(join(root, 'Course', 'summary.md')), false);
});

test('the Assistant saves a note into a folder and makes a note from a file, on Do it', async () => {
  // Labels are numbered per answer, in the order things come up: list once to learn it,
  // then the same list (nothing changed in between) gives the same label.
  const label = /\[(\d+)\] “Parallelism”/.exec((await askAssistant('Notes [[list:notes]]')).tools[0] ?? '')?.[1];
  assert.ok(label);
  const save = await askAssistant(`Save [[list:notes]] ${call('save_note_to_file', { ref: Number(label), path: 'Course/out/p' })}`);
  assert.equal(save.actions[0]?.summary, 'Save the note “Parallelism” as “Course/out/p.md”');
  const saved = await act(save.actions[0] as AssistantAction, 'run');
  assert.equal(saved.status, 'done', saved.error ?? '');
  assert.match(readFileSync(join(root, 'Course', 'out', 'p.md'), 'utf8'), /^# Parallelism/);

  const made = await askAssistant(`Import ${call('note_from_file', { path: 'Course/week4/notes.md' })}`);
  assert.equal(made.actions[0]?.summary, 'Make a note from “Course/week4/notes.md”');
  const fromFile = await act(made.actions[0] as AssistantAction, 'run');
  assert.equal(fromFile.open?.kind, 'note');
  const noteId = fromFile.open?.kind === 'note' ? fromFile.open.noteId : '';
  assert.equal((await api<Note>(s, 'GET', `/api/notes/${noteId}`)).json.title, 'Week 4');
  // Undo puts the new note in the trash.
  await act(fromFile, 'undo');
  assert.notEqual((await api<Note>(s, 'GET', `/api/notes/${noteId}`)).json.deletedAt, null);
});

test('sources from before folders upgrade in place: none of them is a file', () => {
  const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v17 = join(dir, 'v17');
  mkdirSync(v17);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= 17)) {
    copyFileSync(join(MIGRATIONS, f), join(v17, f));
  }
  const file = join(dir, 'n.db');
  const old = new Db(file);
  old.migrate(v17);
  assert.equal(old.version, 17);
  const t = new Date().toISOString();
  const nb = ulid();
  old.sql.prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(nb, 'N', '', t, t);
  const id = '01JPASTEDPASTEDPASTEDPASTE';
  old.sql.prepare('INSERT INTO source (id, notebook_id, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, nb, 'Old', null, t, t);
  old.sql
    .prepare(
      `INSERT INTO source_version (id, source_id, seq, content, content_hash, origin, fetched_url, raw, extractor, created_at)
       VALUES (?, ?, 1, 'Text.', 'h', 'paste', NULL, NULL, 'pasted', ?)`,
    )
    .run(ulid(), id, t);
  old.close();

  const db = new Db(file);
  db.migrate();
  const repo = new Repo(db);
  assert.equal(repo.sourceDetail(id)?.source.linked, null);
  assert.equal(repo.sourceDetail(id)?.version.content, 'Text.');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
