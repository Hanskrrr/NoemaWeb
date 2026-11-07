import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  type AskResponse,
  type ContextManifest,
  type CreateBranchResponse,
  type RefetchResponse,
  type SearchResponse,
  type Source,
  type SourceDetail,
  type Thread,
  type ThreadDetail,
  type Trash,
  ulid,
} from '@noema/core';
import { EXTRACTOR, importPage, readingAddresses } from '../src/ingest/fetch.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Sources (M3): what the learner reads, pasted or read from an address, kept
// as immutable versions; a thread asked about a passage starts there, and
// the model reads the section around it.

let s: TestServer;
let web: Server;
let base = '';
/** What the little web server answers, by path. */
const pages = new Map<string, { type: string; body: string; status?: number }>();

before(async () => {
  s = await startServer();
  web = createServer((req, res) => {
    const page = pages.get(req.url ?? '');
    if (!page) {
      res.writeHead(404).end('not here');
      return;
    }
    res.writeHead(page.status ?? 200, { 'content-type': page.type }).end(page.body);
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
});
after(async () => {
  await s.close();
  await new Promise((resolve) => web.close(resolve));
});

const blog = readFileSync(new URL('../../../packages/core/test/fixtures/blog.html', import.meta.url), 'utf8');

const PASTED = [
  '# Attention notes',
  'Some opening words.',
  '## 3.2.1 Scaled Dot-Product Attention',
  'We suspect that for large values of $d_k$, the dot products grow large in magnitude.',
  'To counteract this effect, we scale the dot products by $1/\\sqrt{d_k}$.',
  '## 3.2.2 Multi-Head Attention',
  'Instead of a single attention function, we project the queries several times.',
].join('\n\n');

async function addSource(notebookId: string, body: Record<string, unknown>) {
  return api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), ...body });
}

async function askAbout(sourceId: string, versionId: string, text: string, phrase: string, question: string) {
  const start = text.indexOf(phrase);
  const r = await api<{ thread: Thread; user: AskResponse['user']; assistant: AskResponse['assistant'] }>(
    s,
    'POST',
    `/api/sources/${sourceId}/threads`,
    { id: ulid(), passage: { versionId, start, end: start + phrase.length }, question: { id: ulid(), content: question } },
  );
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r;
}

const detail = async (id: string, version?: string) =>
  (await api<SourceDetail>(s, 'GET', `/api/sources/${id}${version ? `?version=${version}` : ''}`)).json;
const manifestOf = (revisionId: string) =>
  JSON.parse(s.repo.modelCallsFor(revisionId)[0]?.manifest as string) as ContextManifest;

test('pasted text: a source with a title from its heading; a question about a passage starts a thread there', async () => {
  const { notebookId } = await newThread(s);
  const r = await addSource(notebookId, { text: PASTED });
  assert.equal(r.status, 201);
  const src = r.json;
  assert.equal(src.title, 'Attention notes');
  assert.equal(src.url, null);
  const d = await detail(src.id);
  assert.equal(d.version.content, PASTED);
  assert.equal(d.version.origin, 'paste');

  const asked = await askAbout(src.id, d.version.id, PASTED, 'the dot products grow large', 'Why do they grow?');
  assert.equal(asked.status, 201);
  const thread = asked.json.thread;
  assert.equal(thread.sourceId, src.id);
  assert.equal(thread.sourceQuote, 'the dot products grow large');
  assert.equal(thread.parentThreadId, null);

  // The source lists it at its passage; the thread knows where it came from.
  const after = await detail(src.id);
  assert.deepEqual(
    after.threads.map((t) => [t.threadId, t.passage.exact, t.passage.versionId]),
    [[thread.id, 'the dot products grow large', d.version.id]],
  );
  assert.equal(after.source.threads, 1);
  const td = (await api<ThreadDetail>(s, 'GET', `/api/threads/${thread.id}`)).json;
  assert.equal(td.sourceOrigin?.sourceId, src.id);
  assert.equal(td.sourceOrigin?.passage.exact, 'the dot products grow large');
  assert.equal(td.sourceOrigin?.latestVersionId, d.version.id);

  // The model got the source (the section around the passage) and the passage with the question.
  assert.deepEqual(
    manifestOf(asked.json.assistant.revisionId).parts.map((p) => p.kind),
    ['system', 'source', 'origin', 'question'],
  );
  const section = s.repo.sourceContextFor(thread.id)?.section ?? '';
  assert.ok(section.startsWith('## 3.2.1 Scaled Dot-Product Attention') && section.includes('To counteract'));
  assert.ok(!section.includes('Multi-Head'), 'only the section around the passage');
  // A second question keeps the passage and the reading.
  const again = await api<AskResponse>(s, 'POST', `/api/threads/${thread.id}/messages`, { id: ulid(), content: 'And then?' });
  await readEvents(`${s.base}/api/messages/${again.json.assistant.id}/events`);
  assert.deepEqual(
    manifestOf(again.json.assistant.revisionId).parts.map((p) => p.kind),
    ['system', 'source', 'history', 'history', 'origin', 'question'],
  );
  // A side question of that thread still has the reading in view.
  const answer = s.repo.getMessage(asked.json.assistant.id)?.content ?? '';
  const at = answer.indexOf('offline fake model');
  const side = await api<CreateBranchResponse>(s, 'POST', `/api/threads/${thread.id}/branches`, {
    id: ulid(),
    anchor: { messageId: asked.json.assistant.id, start: at, end: at + 18 },
    question: { id: ulid(), content: 'Side?' },
  });
  await readEvents(`${s.base}/api/messages/${side.json.assistant.id}/events`);
  assert.ok(manifestOf(side.json.assistant.revisionId).parts.some((p) => p.kind === 'source'));
  // The passage counts every question asked about it: two in the thread, one in its side question.
  assert.equal(thread.sourceVersionId, d.version.id);
  assert.deepEqual((await detail(src.id)).threads.map((t) => t.questions), [3]);

  // The same request twice is answered once.
  const twice = await api(s, 'POST', `/api/sources/${src.id}/threads`, {
    id: thread.id,
    passage: { versionId: d.version.id, start: 0, end: 5 },
    question: { id: asked.json.user.id, content: 'Why do they grow?' },
  });
  assert.equal(twice.status, 200);
  // A range outside the text, or another source's version, is refused.
  const bad = await api(s, 'POST', `/api/sources/${src.id}/threads`, {
    id: ulid(),
    passage: { versionId: d.version.id, start: 5, end: 999_999 },
    question: { id: ulid(), content: 'x' },
  });
  assert.equal(bad.status, 400);
});

test('search finds a passage of a source, and says where it starts', async () => {
  const { notebookId } = await newThread(s);
  const src = (await addSource(notebookId, { text: '# Okapi field notes\n\nThe okapi is related to the giraffe.' })).json;
  const hits = (await api<SearchResponse>(s, 'GET', '/api/search?q=giraffe')).json.hits.filter((h) => h.sourceId === src.id);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, 'passage');
  assert.equal(hits[0]?.versionId, src.latestVersionId);
  assert.equal(hits[0]?.offset, '# Okapi field notes\n\n'.length);
  assert.equal(hits[0]?.title, 'Okapi field notes');
  // The title is its own hit only when nothing inside matched.
  await api(s, 'PATCH', `/api/sources/${src.id}`, { title: 'Mammals of the Congo' });
  const title = (await api<SearchResponse>(s, 'GET', '/api/search?q=congo')).json.hits.filter((h) => h.sourceId === src.id);
  assert.deepEqual(title.map((h) => [h.kind, h.title]), [['source', 'Mammals of the Congo']]);
  // Rebuilt from scratch, the same.
  s.db.sql.exec("DELETE FROM meta WHERE key = 'search_index'");
  s.repo.ensureSearchIndex();
  assert.equal((await api<SearchResponse>(s, 'GET', '/api/search?q=giraffe')).json.hits.filter((h) => h.sourceId === src.id).length, 1);
});

test('a page read by an earlier reader is read again from the copy kept, without the network', async () => {
  const { notebookId } = await newThread(s);
  const table =
    '<article><h1>Norms</h1><p>A table of lengths.</p><table><tr><th>Vector</th><th>Length</th></tr>' +
    '<tr><td>Velocity</td><td><math alttext="E=\\tfrac{1}{2}\\|v\\|^{2}" display="inline"><mi>E</mi></math></td></tr></table></article>';
  pages.set('/norms', { type: 'text/html', body: table });
  const src = (await addSource(notebookId, { url: `${base}/norms` })).json;
  const v1 = await detail(src.id);
  assert.equal(v1.rereadable, false, 'read by this reader');
  assert.ok(v1.version.content.includes('\\Vert v\\Vert ^{2}'), 'a norm in a cell is written \\Vert');
  // As if an earlier Noema had read it, into something else; then the page goes away.
  s.db.sql
    .prepare("UPDATE source_version SET extractor = 'noema-html-1', content = 'old reading', content_hash = 'old' WHERE id = ?")
    .run(v1.version.id);
  pages.delete('/norms');
  assert.equal((await detail(src.id)).rereadable, true);
  const r = await api<RefetchResponse>(s, 'POST', `/api/sources/${src.id}/reread`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.changed, true);
  const v2 = await detail(src.id);
  assert.equal(v2.version.seq, 2);
  assert.equal(v2.rereadable, false);
  assert.ok(v2.version.content.includes('\\Vert v\\Vert ^{2}'));
  // Again: nothing changes, and it stays quiet.
  const same = await api<RefetchResponse>(s, 'POST', `/api/sources/${src.id}/reread`);
  assert.equal(same.json.changed, false);
  // Pasted text has no page kept.
  const pasted = (await addSource(notebookId, { text: '# Plain\n\nJust text.' })).json;
  assert.equal((await detail(pasted.id)).rereadable, false);
  assert.equal((await api(s, 'POST', `/api/sources/${pasted.id}/reread`)).status, 400);
});

test('a page read from its address: the article as Markdown, kept with the HTML; read again makes a version only when changed', async () => {
  const { notebookId } = await newThread(s);
  pages.set('/post', { type: 'text/html; charset=utf-8', body: blog });
  const r = await addSource(notebookId, { url: `${base}/post` });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const src = r.json;
  assert.equal(src.title, 'Why scale by √d?');
  assert.equal(src.url, `${base}/post`);
  const v1 = await detail(src.id);
  assert.equal(v1.version.origin, 'url');
  assert.equal(v1.version.fetchedUrl, `${base}/post`);
  assert.ok(v1.version.content.includes('## A quick check'));
  assert.ok(!v1.version.content.includes('cookies'));
  const raw = s.db.sql.prepare('SELECT raw, extractor FROM source_version WHERE id = ?').get(v1.version.id) as {
    raw: string;
    extractor: string;
  };
  assert.equal(raw.raw, blog);
  assert.equal(raw.extractor, EXTRACTOR);

  // A question about it, then the page changes.
  const asked = await askAbout(src.id, v1.version.id, v1.version.content, 'Softmax saturates', 'Why?');
  const same = (await api<RefetchResponse>(s, 'POST', `/api/sources/${src.id}/refetch`)).json;
  assert.equal(same.changed, false);
  assert.equal(same.source.versions, 1);
  pages.set('/post', { type: 'text/html', body: blog.replace('Softmax saturates', 'The softmax function saturates') });
  const changed = (await api<RefetchResponse>(s, 'POST', `/api/sources/${src.id}/refetch`)).json;
  assert.equal(changed.changed, true);
  assert.equal(changed.source.versions, 2);
  // The latest is shown; the earlier question stays on the version it was asked about.
  const v2 = await detail(src.id);
  assert.notEqual(v2.version.id, v1.version.id);
  assert.ok(v2.version.content.includes('The softmax function saturates'));
  assert.deepEqual(v2.threads, []);
  assert.equal(v2.elsewhere, 1);
  assert.deepEqual(v2.versions.map((v) => v.seq), [2, 1]);
  assert.deepEqual((await detail(src.id, v1.version.id)).threads.map((t) => t.threadId), [asked.json.thread.id]);
  const origin = (await api<ThreadDetail>(s, 'GET', `/api/threads/${asked.json.thread.id}`)).json.sourceOrigin;
  assert.equal(origin?.passage.versionId, v1.version.id);
  assert.equal(origin?.latestVersionId, v2.version.id);
  // Search follows the latest version.
  assert.ok(
    (await api<SearchResponse>(s, 'GET', '/api/search?q=function%20saturates')).json.hits.some((h) => h.sourceId === src.id),
  );

  // Plain text and Markdown are taken as they are.
  pages.set('/notes.md', { type: 'text/markdown', body: '# Markdown notes\n\nAlready *Markdown*.' });
  const md = (await addSource(notebookId, { url: `${base}/notes.md` })).json;
  assert.equal(md.title, 'Markdown notes');
  assert.equal((await detail(md.id)).version.content, '# Markdown notes\n\nAlready *Markdown*.');
});

test('addresses that cannot be read say why; pasted text cannot be read again', async () => {
  const { notebookId } = await newThread(s);
  pages.set('/paper.pdf', { type: 'application/pdf', body: '%PDF-1.4' });
  pages.set('/image', { type: 'image/png', body: 'PNG' });
  const reasons: Array<[string, RegExp]> = [
    [`${base}/paper.pdf`, /is a PDF, which Noema cannot read yet/],
    [`${base}/missing`, /answered 404/],
    [`${base}/image`, /not a page or text \(image\/png\)/],
    ['ftp://example.com/x', /only http and https/],
    ['http://127.0.0.1:1/', /could not be reached/],
  ];
  for (const [url, reason] of reasons) {
    const r = await api<{ error: { message: string } }>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), url });
    assert.equal(r.status, 400, url);
    assert.match(r.json.error.message, reason, url);
  }
  assert.equal((await addSource(notebookId, { text: '   ' })).status, 400);
  assert.equal((await addSource(notebookId, { text: 'x', url: `${base}/post` })).status, 400);
  const pasted = (await addSource(notebookId, { text: 'Just a line.' })).json;
  assert.equal(pasted.title, 'Just a line.');
  assert.equal((await api(s, 'POST', `/api/sources/${pasted.id}/refetch`)).status, 400);
});

test('an arXiv paper is read from its HTML version, falling back to ar5iv', async () => {
  assert.deepEqual(readingAddresses('https://arxiv.org/abs/1706.03762'), [
    'https://arxiv.org/html/1706.03762',
    'https://ar5iv.labs.arxiv.org/html/1706.03762',
  ]);
  assert.deepEqual(readingAddresses('https://arxiv.org/pdf/2310.06825v2.pdf'), [
    'https://arxiv.org/html/2310.06825v2',
    'https://ar5iv.labs.arxiv.org/html/2310.06825',
  ]);
  assert.deepEqual(readingAddresses('https://example.com/a'), ['https://example.com/a']);
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith('https://arxiv.org/html/')) return new Response('nope', { status: 404 });
    const html = readFileSync(new URL('../../../packages/core/test/fixtures/arxiv-latexml.html', import.meta.url), 'utf8');
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  const page = await importPage('https://arxiv.org/abs/1706.03762', { fetch: fake });
  assert.deepEqual(asked, ['https://arxiv.org/html/1706.03762', 'https://ar5iv.labs.arxiv.org/html/1706.03762']);
  assert.equal(page.title, 'Attention Is All You Need');
  assert.ok(page.markdown.includes('\\tag{1}'));
});

test('a source in the Trash: gone from the list and search, nothing new asked about it, restored as it was', async () => {
  const { notebookId } = await newThread(s);
  const src = (await addSource(notebookId, { text: '# Tapir notes\n\nTapirs have a short trunk.' })).json;
  const d = await detail(src.id);
  const asked = await askAbout(src.id, d.version.id, d.version.content, 'short trunk', 'Why a trunk?');
  assert.equal((await api(s, 'DELETE', `/api/sources/${src.id}`)).status, 200);
  const list = (await api<{ sources: Source[] }>(s, 'GET', `/api/notebooks/${notebookId}/sources`)).json.sources;
  assert.ok(!list.some((x) => x.id === src.id));
  assert.ok((await api<Trash>(s, 'GET', `/api/notebooks/${notebookId}/trash`)).json.sources.some((x) => x.sourceId === src.id));
  assert.equal((await api<SearchResponse>(s, 'GET', '/api/search?q=tapirs')).json.hits.filter((h) => h.sourceId === src.id).length, 0);
  const again = await api(s, 'POST', `/api/sources/${src.id}/threads`, {
    id: ulid(),
    passage: { versionId: d.version.id, start: 0, end: 5 },
    question: { id: ulid(), content: 'More?' },
  });
  assert.equal(again.status, 409);
  // The thread asked about it stays, and says its source is in the Trash.
  assert.equal((await api<ThreadDetail>(s, 'GET', `/api/threads/${asked.json.thread.id}`)).json.sourceOrigin?.deleted, true);
  assert.equal((await api<Source>(s, 'POST', `/api/sources/${src.id}/restore`)).json.deletedAt, null);
  assert.equal((await api<SearchResponse>(s, 'GET', '/api/search?q=tapirs')).json.hits.filter((h) => h.sourceId === src.id).length, 1);
});
