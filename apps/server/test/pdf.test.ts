import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type RefetchResponse, type SearchResponse, type Source, type SourceDetail, ulid } from '@noema/core';
import { importPage, readingAddresses } from '../src/ingest/fetch.ts';
import { MAX_PDF_BYTES, PDF_EXTRACTOR, readPdf } from '../src/ingest/pdf.ts';
import { Db } from '../src/store/db.ts';
import { Repo } from '../src/store/repo.ts';
import { api, newThread, startServer, type TestServer } from './helpers.ts';

// PDF sources (ADR 0021): a PDF given as a file or found at an address is
// read page by page into Markdown, kept with the file itself, and opened at
// a page. Fixtures are made-up decks and notes.

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const SLIDES = fixture('slides.pdf');

let s: TestServer;
let web: Server;
let base = '';
let notebookId = '';
const files = new Map<string, { type: string; body: Uint8Array }>();

before(async () => {
  s = await startServer();
  notebookId = (await newThread(s)).notebookId;
  web = createServer((req, res) => {
    const file = files.get(req.url ?? '');
    if (!file) {
      res.writeHead(404).end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': file.type }).end(file.body);
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});
after(async () => {
  await s.close();
  await new Promise((resolve) => web.close(resolve));
});

/** Send a file as the app does: its bytes, with the id and name in the address. */
async function upload(bytes: Uint8Array, query: Record<string, string>, type = 'application/pdf') {
  const res = await fetch(`${s.base}/api/notebooks/${notebookId}/sources/pdf?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-noema-client': 'web' },
    body: bytes,
  });
  return { status: res.status, json: (await res.json()) as Source & { error?: { message: string } } };
}

const detail = async (id: string) => (await api<SourceDetail>(s, 'GET', `/api/sources/${id}`)).json;

test('a PDF given as a file: read page by page, its slide titles and bullets kept, the file kept with it', async () => {
  const id = ulid();
  const r = await upload(SLIDES, { id, name: 'week5-slides.pdf' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.title, 'Week 5: Optimisation');
  assert.equal(r.json.url, null);
  const d = await detail(id);
  assert.equal(d.version.origin, 'file');
  assert.deepEqual(d.version.file, { type: 'application/pdf', name: 'week5-slides.pdf', bytes: SLIDES.byteLength });
  assert.equal(d.rereadable, false);
  const text = d.version.content;
  assert.ok(text.startsWith('## Page 1\n\n### Week 5: Optimisation'), text);
  assert.ok(text.includes('## Page 2\n\n### Gradient descent\n\n- Step against the gradient\n- The learning rate sets the step size'), text);
  assert.ok(text.includes('- Too large a rate makes the loss bounce between the walls of the valley and sometimes diverge entirely'));
  assert.ok(text.includes('## Page 3\n\n### Momentum'));

  // Sending it again changes nothing.
  const again = await upload(SLIDES, { id, name: 'week5-slides.pdf' });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, id);
  assert.equal(s.repo.listSources(notebookId).filter((x) => x.id === id).length, 1);

  // The file itself, as it was given.
  const file = await fetch(`${s.base}/api/sources/${id}/versions/${d.version.id}/file`, { headers: { 'x-noema-client': 'web' } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition') ?? '', /^inline; filename\*=UTF-8''week5-slides\.pdf$/);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), SLIDES);
  // Opened by a plain link (a GET changes nothing), so the browser's own PDF viewer shows it.
  assert.equal((await fetch(`${s.base}/api/sources/${id}/versions/${d.version.id}/file`)).status, 200);

  // Found by search, at its page.
  const found = (await api<SearchResponse>(s, 'GET', `/api/search?q=${encodeURIComponent('running average')}`)).json;
  assert.ok(found.hits.some((h) => h.sourceId === id));
  // Logged without its words or its name.
  const event = s.db.sql.prepare("SELECT data FROM event WHERE type = 'source.added' AND subject_id = ?").get(id) as { data: string };
  assert.deepEqual(JSON.parse(event.data), { origin: 'file', chars: text.length, pages: 3 });
});

test('Chinese text from a PDF: no spaces between characters, radicals read as the characters they stand for', async () => {
  const id = ulid();
  const r = await upload(fixture('notes-zh.pdf'), { id, name: '第三讲.pdf' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.title, '第三讲：注意力机制');
  const text = (await detail(id)).version.content;
  assert.ok(text.includes('学习率决定步长。如果学习率太大，损失会来回振荡'), text);
  assert.ok(text.includes('然后再做 softmax。Mixed English words'), text);
  assert.equal((await detail(id)).version.file?.name, '第三讲.pdf');
});

test('a PDF that cannot be read says why, and adds nothing', async () => {
  const before = s.repo.listSources(notebookId).length;
  const cases: Array<[Uint8Array, string]> = [
    [new TextEncoder().encode('just some text'), 'That file could not be read: it is not a PDF.'],
    [new TextEncoder().encode('%PDF-1.7\nnot really a pdf at all'), 'That file could not be read: it could not be read as a PDF.'],
    [fixture('locked.pdf'), 'That file could not be read: it is locked with a password.'],
    [
      fixture('scan.pdf'),
      'That file could not be read: it has no text to read: it may be scanned pages or pictures, which Noema cannot read.',
    ],
  ];
  for (const [bytes, message] of cases) {
    const r = await upload(bytes, { id: ulid(), name: 'x.pdf' });
    assert.equal(r.status, 400, message);
    assert.equal(r.json.error?.message, message);
  }
  assert.equal((await upload(SLIDES, { id: ulid() }, 'text/plain')).status, 415);
  assert.equal((await upload(SLIDES, { id: 'not-an-id' })).status, 400);
  assert.equal((await upload(new Uint8Array(), { id: ulid() })).status, 400);
  assert.equal(s.repo.listSources(notebookId).length, before);
  // Too large is refused before reading.
  await assert.rejects(readPdf(new Uint8Array(MAX_PDF_BYTES + 1)), /larger than 50 MB/);
});

test('when no worker thread can be started here, the PDF is read on the main thread, and that is said', async () => {
  const told: string[] = [];
  const missing = new URL('./fixtures/no-such-worker.ts', import.meta.url);
  const r = await readPdf(SLIDES, { worker: missing, onFallback: (d) => told.push(d) });
  assert.equal(r.title, 'Week 5: Optimisation');
  assert.equal(told.length, 1);
  assert.match(told[0] as string, /no-such-worker|Cannot find|MODULE_NOT_FOUND/);
});

test('why a PDF could not be read is kept for the log, not shown', async () => {
  const err = await readPdf(new TextEncoder().encode('%PDF-1.7\nnot really a pdf at all')).catch((e) => e);
  assert.equal(err.message, 'it could not be read as a PDF');
  assert.match(err.detail, /^\w+(?: \w+)?: \S/);
});

test('reading a PDF that takes too long is stopped', async () => {
  await assert.rejects(readPdf(SLIDES, { timeoutMs: 1 }), /took too long/);
});

test('a PDF at an address is read and kept like a file; read again, the same file makes no new version', async () => {
  files.set('/handouts/week5.pdf', { type: 'application/pdf', body: SLIDES });
  const id = ulid();
  const r = await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id, url: `${base}/handouts/week5.pdf` });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.title, 'Week 5: Optimisation');
  const d = await detail(id);
  assert.equal(d.version.origin, 'url');
  assert.deepEqual(d.version.file, { type: 'application/pdf', name: 'week5.pdf', bytes: SLIDES.byteLength });
  assert.ok(d.version.content.includes('### Momentum'));
  const again = (await api<RefetchResponse>(s, 'POST', `/api/sources/${id}/refetch`)).json;
  assert.equal(again.changed, false);
  // Served as something else but ending in .pdf, and starting like one: still a PDF.
  files.set('/download?f=2', { type: 'application/octet-stream', body: SLIDES });
  const odd = await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), url: `${base}/download?f=2` });
  assert.equal(odd.status, 201, JSON.stringify(odd.json));
});

test('an arXiv paper with no HTML version is read from its PDF', async () => {
  assert.deepEqual(readingAddresses('https://arxiv.org/abs/1706.03762v7'), [
    'https://arxiv.org/html/1706.03762v7',
    'https://ar5iv.labs.arxiv.org/html/1706.03762',
    'https://arxiv.org/pdf/1706.03762v7',
  ]);
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/pdf/')) return new Response(SLIDES, { headers: { 'content-type': 'application/pdf' } });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const page = await importPage('https://arxiv.org/abs/1706.03762v7', { fetch: fake });
  assert.equal(page.kind, 'pdf');
  assert.equal(page.extractor, PDF_EXTRACTOR);
  assert.equal(page.fileName, '1706.03762v7.pdf');
  assert.ok(page.markdown.startsWith('## Page 1'));
  assert.equal(asked.length, 3);
});

test('a PDF read by an earlier reader can be read again from the file kept, without the network', async () => {
  const id = ulid();
  await upload(SLIDES, { id, name: 'w.pdf' });
  // As if an earlier Noema had read it, and differently.
  s.db.sql.prepare("UPDATE source_version SET extractor = 'noema-pdf-0', content = 'old text', content_hash = 'old' WHERE source_id = ?").run(id);
  const d = await detail(id);
  assert.equal(d.rereadable, true);
  const r = (await api<RefetchResponse>(s, 'POST', `/api/sources/${id}/reread`)).json;
  assert.equal(r.changed, true);
  const now = await detail(id);
  assert.equal(now.version.seq, 2);
  assert.equal(now.version.origin, 'file');
  assert.equal(now.version.file?.name, 'w.pdf');
  assert.ok(now.version.content.includes('### Momentum'));
  assert.equal(now.rereadable, false);
  // A file has no address to fetch from.
  assert.equal((await api(s, 'POST', `/api/sources/${id}/refetch`)).status, 400);
});

test('only a version read from a PDF has a file to open', async () => {
  const id = ulid();
  const pasted = await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id, text: '# Pasted\n\nWords.' });
  const d = await detail(pasted.json.id);
  assert.equal(d.version.file, null);
  const r = await api(s, 'GET', `/api/sources/${id}/versions/${d.version.id}/file`);
  assert.equal(r.status, 404);
  assert.equal((await api(s, 'GET', `/api/sources/${id}/versions/01ARZ3NDEKTSV4RRFFQ69G5FAV/file`)).status, 404);
});

test('sources from before PDFs upgrade in place: pasted is still pasted, a page still a page', () => {
  const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'noema-upgrade-'));
  const v13 = join(dir, 'v13');
  mkdirSync(v13);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= 13)) {
    copyFileSync(join(MIGRATIONS, f), join(v13, f));
  }
  const file = join(dir, 'n.db');
  const old = new Db(file);
  old.migrate(v13);
  assert.equal(old.version, 13);
  const t = new Date().toISOString();
  const nb = ulid();
  old.sql.prepare('INSERT INTO notebook (id, title, about_me, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(nb, 'N', '', t, t);
  for (const [id, origin, url] of [
    ['01JPASTEDPASTEDPASTEDPASTE', 'paste', null],
    ['01JFETCHEDFETCHEDFETCHEDFE', 'url', 'https://example.org/a'],
  ] as const) {
    old.sql
      .prepare('INSERT INTO source (id, notebook_id, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, nb, 'Old', url, t, t);
    old.sql
      .prepare(
        `INSERT INTO source_version (id, source_id, seq, content, content_hash, origin, fetched_url, raw, extractor, created_at)
         VALUES (?, ?, 1, 'Text.', 'h', ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), id, origin, url, url ? '<p>Text.</p>' : null, url ? 'noema-html-3' : 'pasted', t);
  }
  old.close();

  const db = new Db(file);
  db.migrate();
  const repo = new Repo(db);
  const pasted = repo.sourceDetail('01JPASTEDPASTEDPASTEDPASTE');
  const fetched = repo.sourceDetail('01JFETCHEDFETCHEDFETCHEDFE');
  assert.equal(pasted?.version.origin, 'paste');
  assert.equal(pasted?.version.file, null);
  assert.equal(fetched?.version.origin, 'url');
  assert.equal(fetched?.version.file, null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
