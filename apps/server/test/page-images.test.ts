import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { type MessageContext, type Source, type SourceDetail, type ThreadDetail, ulid } from '@noema/core';
import { wireMessages } from '../src/llm/openai-compatible.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// Questions about a passage of a PDF go with a picture of its page (ADR
// 0022): the browser draws the page and keeps it on the server; the model
// is sent it with every question about the passage, by reference in What
// was sent. A model that refuses pictures is asked with text only.

const SLIDES = new Uint8Array(readFileSync(new URL('./fixtures/slides.pdf', import.meta.url)));
/** Enough of a JPEG for the server: it checks the start and keeps the bytes. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4, 0xff, 0xd9]);

let s: TestServer;
let notebookId = '';
before(async () => {
  s = await startServer();
  notebookId = (await newThread(s)).notebookId;
});
after(() => s.close());

async function addSlides(): Promise<SourceDetail> {
  const id = ulid();
  const res = await fetch(`${s.base}/api/notebooks/${notebookId}/sources/pdf?id=${id}&name=w5.pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-noema-client': 'web' },
    body: SLIDES,
  });
  assert.equal(res.status, 201);
  return (await api<SourceDetail>(s, 'GET', `/api/sources/${((await res.json()) as Source).id}`)).json;
}

async function putImage(d: SourceDetail, page: number, body: Uint8Array, type = 'image/jpeg') {
  const res = await fetch(`${s.base}/api/sources/${d.source.id}/versions/${d.version.id}/pages/${page}/image?width=1600&height=900`, {
    method: 'PUT',
    headers: { 'content-type': type, 'x-noema-client': 'web' },
    body,
  });
  return { status: res.status, json: (await res.json()) as { created?: boolean; error?: { message: string } } };
}

async function askAbout(d: SourceDetail, phrase: string, question: string) {
  const start = d.version.content.indexOf(phrase);
  const r = await api<{ thread: { id: string }; assistant: { id: string } }>(s, 'POST', `/api/sources/${d.source.id}/threads`, {
    id: ulid(),
    passage: { versionId: d.version.id, start, end: start + phrase.length },
    question: { id: ulid(), content: question },
  });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

async function askIn(threadId: string, question: string) {
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content: question });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json.assistant.id;
}

const lastAnswer = async (threadId: string) =>
  (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json.messages.at(-1)?.content ?? '';

test('a question about a PDF passage goes with a picture of its page, every time, named in What was sent', async () => {
  const d = await addSlides();
  assert.equal((await putImage(d, 2, JPEG)).status, 201);
  // Kept once: the page never changes.
  assert.deepEqual((await putImage(d, 2, JPEG)).json, { ok: true, created: false });

  const asked = await askAbout(d, 'The learning rate sets the step size', 'Why does the rate matter?');
  assert.match(await lastAnswer(asked.thread.id), /^I can see Page 2 of “Week 5: Optimisation”\./);
  const context = (await api<MessageContext>(s, 'GET', `/api/messages/${asked.assistant.id}/context`)).json;
  const question = context.request?.at(-1);
  assert.deepEqual(question?.images, [{ ref: `source-page:${d.version.id}:2`, label: 'Page 2 of “Week 5: Optimisation”' }]);
  assert.ok(context.manifest.parts.some((p) => p.kind === 'image' && p.ref === `source-page:${d.version.id}:2`));
  // The request kept for What was sent names the picture; it does not hold it.
  const stored = s.db.sql.prepare('SELECT request FROM model_call ORDER BY rowid DESC LIMIT 1').get() as { request: string };
  assert.ok(!stored.request.includes('base64') && stored.request.length < 20_000);

  // The next question in the thread is about the same passage: the page goes again.
  await askIn(asked.thread.id, 'And if it is too small?');
  assert.match(await lastAnswer(asked.thread.id), /^I can see Page 2/);

  // The picture as kept, for What was sent.
  const res = await fetch(`${s.base}/api/page-images/${d.version.id}/2`);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG);

  // A page with no picture yet: text only.
  const plain = await askAbout(d, 'running average of past gradients', 'What is averaged?');
  assert.doesNotMatch(await lastAnswer(plain.thread.id), /I can see/);
});

test('a model that refuses pictures is asked again with text only, and from then on', async () => {
  const d = await addSlides();
  await putImage(d, 3, JPEG);
  const asked = await askAbout(d, 'Heavy ball', 'What is a heavy ball? [[no-pictures]]');
  const thread = (await api<ThreadDetail>(s, 'GET', `/api/threads/${asked.thread.id}`)).json;
  const answer = thread.messages.at(-1);
  assert.equal(answer?.status, 'done');
  assert.doesNotMatch(answer?.content ?? '', /I can see/);
  const context = (await api<MessageContext>(s, 'GET', `/api/messages/${asked.assistant.id}/context`)).json;
  assert.equal(context.request?.at(-1)?.images, undefined);
  // Remembered: the next question is not tried with the picture.
  await askIn(asked.thread.id, 'Tell me more');
  assert.doesNotMatch(await lastAnswer(asked.thread.id), /I can see/);
});

test('page pictures are checked: a picture of what it says, of a page that exists, of a PDF', async () => {
  const d = await addSlides();
  assert.equal((await putImage(d, 1, JPEG, 'image/gif')).status, 415);
  assert.equal((await putImage(d, 1, new TextEncoder().encode('not a picture'))).status, 400);
  assert.equal((await putImage(d, 9, JPEG)).status, 400);
  assert.equal((await putImage(d, 0, JPEG)).status, 400);
  const pasted = (
    await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, { id: ulid(), text: '# Pasted\n\nWords.' })
  ).json;
  const p = (await api<SourceDetail>(s, 'GET', `/api/sources/${pasted.id}`)).json;
  assert.equal((await putImage(p, 1, JPEG)).status, 400);
  assert.equal((await fetch(`${s.base}/api/page-images/${d.version.id}/1`)).status, 404);
});

test('pdf.js files for the browser come from the server, and nothing else does', async () => {
  const ok = await fetch(`${s.base}/api/pdfjs/cmaps/UniGB-UCS2-H.bcmap`);
  assert.equal(ok.status, 200);
  assert.ok((await ok.arrayBuffer()).byteLength > 100);
  assert.equal((await fetch(`${s.base}/api/pdfjs/wasm/openjpeg_nowasm_fallback.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${s.base}/api/pdfjs/build/pdf.min.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${s.base}/api/pdfjs/build/pdf.worker.min.mjs`)).status, 200);
  for (const path of [
    '/api/pdfjs/wasm/quickjs-eval.js',
    '/api/pdfjs/build/pdf.mjs',
    '/api/pdfjs/build/pdf.sandbox.min.mjs',
    '/api/pdfjs/build/pdf.mjs.map',
    '/api/pdfjs/cmaps/..%2Fpackage.json',
    '/api/pdfjs/cmaps/.hidden',
    '/api/pdfjs/cmaps/missing.bcmap',
  ]) {
    assert.equal((await fetch(`${s.base}${path}`)).status, 404, path);
  }
});

test('a question with pictures goes to the API as parts: the pictures, then the text', () => {
  const wire = wireMessages({
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Q', images: [{ ref: 'a', label: 'Page 1' }, { ref: 'gone', label: 'Page 2' }] },
    ],
    images: (ref) => (ref === 'a' ? { mediaType: 'image/jpeg', data: 'QUJD' } : null),
  });
  assert.deepEqual(wire, [
    { role: 'system', content: 'S' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        { type: 'text', text: 'Q' },
      ],
    },
  ]);
});
