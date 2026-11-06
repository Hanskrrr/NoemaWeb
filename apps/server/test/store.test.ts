import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ulid } from '@noema/core';
import { Db, dailyBackup } from '../src/store/db.ts';
import { ConflictError, Repo } from '../src/store/repo.ts';

function fresh(path = ':memory:') {
  const db = new Db(path);
  db.migrate();
  return { db, repo: new Repo(db) };
}

test('migrations apply once and record the schema version', () => {
  const { db } = fresh();
  const migrations = readdirSync(new URL('../src/store/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql'));
  assert.equal(db.version, migrations.length);
  assert.equal(db.migrate(), 0);
  db.close();
});

test('a file database runs in WAL mode with foreign keys on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noema-'));
  const { db } = fresh(join(dir, 'n.db'));
  assert.equal((db.sql.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.sql.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a failed transaction leaves nothing behind', () => {
  const { db, repo } = fresh();
  const nb = repo.ensureDefaultNotebook();
  assert.throws(() =>
    db.tx(() => {
      repo.createThread(nb.id, ulid(), 'half-made');
      throw new Error('boom');
    }),
  );
  assert.equal(repo.listThreads(nb.id).length, 0);
  db.close();
});

test('asking is idempotent on the message id, and a reused id with new text is a conflict', () => {
  const { db, repo } = fresh();
  const nb = repo.ensureDefaultNotebook();
  const { thread } = repo.createThread(nb.id, ulid(), '');
  const id = ulid();
  const first = repo.createAsk(thread.id, id, 'What is entropy?');
  const again = repo.createAsk(thread.id, id, 'What is entropy?');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.pair.assistant.id, first.pair.assistant.id);
  assert.throws(() => repo.createAsk(thread.id, id, 'Something else'), ConflictError);
  assert.equal(repo.listMessages(thread.id).length, 2);
  assert.equal(repo.getThread(thread.id)?.title, 'What is entropy?');
  db.close();
});

test('answers still generating at boot are marked interrupted, keeping their text', () => {
  const { db, repo } = fresh();
  const nb = repo.ensureDefaultNotebook();
  const { thread } = repo.createThread(nb.id, ulid(), '');
  const { pair } = repo.createAsk(thread.id, ulid(), 'Explain eigenvalues');
  repo.markStreaming(pair.assistant.revisionId, 'm');
  repo.saveContent(pair.assistant.revisionId, 'An eigenvalue is');
  assert.equal(repo.interruptLive(), 1);
  const after = repo.getMessage(pair.assistant.id);
  assert.equal(after?.status, 'interrupted');
  assert.equal(after?.content, 'An eigenvalue is');
  // Terminal revisions never change again.
  assert.equal(repo.finishRevision(pair.assistant.revisionId, 'changed', 'done', null), false);
  assert.equal(repo.getMessage(pair.assistant.id)?.content, 'An eigenvalue is');
  db.close();
});

test('history only includes finished question-and-answer pairs', () => {
  const { db, repo } = fresh();
  const nb = repo.ensureDefaultNotebook();
  const { thread } = repo.createThread(nb.id, ulid(), '');
  const a = repo.createAsk(thread.id, ulid(), 'Q1').pair;
  repo.finishRevision(a.assistant.revisionId, 'A1', 'done', null);
  const b = repo.createAsk(thread.id, ulid(), 'Q2').pair;
  repo.finishRevision(b.assistant.revisionId, '', 'failed', { kind: 'network', message: 'x' });
  const c = repo.createAsk(thread.id, ulid(), 'Q3').pair;
  assert.deepEqual(
    repo.history(thread.id, c.user.seq).map((h) => h.content),
    ['Q1', 'A1'],
  );
  db.close();
});

test('search finds Chinese words of one or two characters, and English prefixes', () => {
  const { db, repo } = fresh();
  const nb = repo.ensureDefaultNotebook();
  const { thread } = repo.createThread(nb.id, ulid(), '');
  const { pair } = repo.createAsk(thread.id, ulid(), '梯度下降为什么有效？');
  repo.finishRevision(
    pair.assistant.revisionId,
    '因为沿着负梯度方向，损失函数下降最快。Gradient descent works.',
    'done',
    null,
  );
  const ids = (q: string) => repo.search(q).hits.map((h) => h.messageId);
  assert.ok(ids('梯度').includes(pair.user.id));
  assert.ok(ids('梯度').includes(pair.assistant.id));
  assert.ok(ids('损').includes(pair.assistant.id));
  assert.ok(ids('gradi').includes(pair.assistant.id));
  assert.deepEqual(ids('量子'), []);
  const hit = repo.search('损失函数').hits.find((h) => h.messageId === pair.assistant.id);
  assert.ok(hit?.snippet.includes('损失函数'));
  db.close();
});

test('daily backups are consistent copies, one per day, newest seven kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noema-'));
  const { db, repo } = fresh(join(dir, 'n.db'));
  repo.ensureDefaultNotebook();
  const backups = join(dir, 'backups');
  for (let d = 1; d <= 9; d++) dailyBackup(db, backups, 7, new Date(Date.UTC(2026, 10, d)));
  assert.equal(dailyBackup(db, backups, 7, new Date(Date.UTC(2026, 10, 9))), null);
  const files = readdirSync(backups).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'noema-2026-11-03.db');
  const copy = new Db(join(backups, files[6] as string));
  assert.equal(new Repo(copy).listNotebooks().length, 1);
  copy.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('export contains every table', () => {
  const { db, repo } = fresh();
  repo.ensureDefaultNotebook();
  const out = repo.exportAll();
  for (const key of ['notebooks', 'threads', 'messages', 'revisions', 'modelCalls', 'events'])
    assert.ok(key in out, key);
  db.close();
});
