import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type AskResponse, type ChatMessage, describeSent, type MessageContext, ulid } from '@noema/core';
import { FakeProvider } from '../src/llm/fake.ts';
import type { StreamEvent, StreamRequest } from '../src/llm/provider.ts';
import { api, newThread, readEvents, startServer, type TestServer } from './helpers.ts';

// "What was sent" (M5): every answer keeps the exact messages the model got,
// and the manifest that names their parts. The milestone's test: the
// manifest matches the request.

/** The fake model, remembering what it was sent. */
class Recording extends FakeProvider {
  sent: ChatMessage[][] = [];
  override async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    this.sent.push(req.messages);
    yield* super.stream(req);
  }
}

let s: TestServer;
const model = new Recording({ delayMs: 1 });
before(async () => {
  s = await startServer({ models: { fake: () => model } });
});
after(() => s.close());

async function askAndWait(threadId: string, content: string) {
  const r = await api<AskResponse>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return r.json;
}

test('acceptance (M5): what was sent is the request the model got, word for word, part by part', async () => {
  const { notebookId, threadId } = await newThread(s);
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { aboutMe: 'I know C++ and basic calculus.' });
  const first = await askAndWait(threadId, 'What is a gradient?');
  const second = await askAndWait(threadId, 'And a Jacobian?');

  const r = await api<MessageContext>(s, 'GET', `/api/messages/${second.assistant.id}/context`);
  assert.equal(r.status, 200);
  const context = r.json;
  assert.equal(context.revisionId, second.assistant.revisionId);
  assert.equal(context.model, 'fake-model');
  // Exactly what the model was sent for that answer (not for titles or headlines).
  const answers = model.sent.filter((m) => m[0]?.content.startsWith('You are Noema'));
  assert.deepEqual(context.request, answers.at(-1));
  // The manifest names it, part by part, and the parts put together are the request.
  const parts = describeSent(context.manifest, context.request ?? []);
  assert.deepEqual(
    parts.map((p) => [p.kind, p.role]),
    [
      ['instructions', 'system'],
      ['about_me', 'system'],
      ['history', 'user'],
      ['history', 'assistant'],
      ['question', 'user'],
    ],
  );
  assert.match(parts[1]?.text ?? '', /I know C\+\+ and basic calculus\.$/);
  assert.equal(parts.at(-1)?.text, 'And a Jacobian?');
  assert.deepEqual(
    parts.map((p) => p.id ?? null),
    [null, null, first.user.id, first.assistant.id, second.user.id],
  );
});

test('what was sent: only for answers; answers from before it was recorded show the manifest alone', async () => {
  const { notebookId, threadId } = await newThread(s);
  await api(s, 'PATCH', `/api/notebooks/${notebookId}`, { aboutMe: '' });
  const asked = await askAndWait(threadId, 'What is a tensor?');
  assert.equal((await api(s, 'GET', `/api/messages/${asked.user.id}/context`)).status, 404);
  assert.equal((await api(s, 'GET', `/api/messages/${ulid()}/context`)).status, 404);
  s.db.sql.prepare('UPDATE model_call SET request = NULL WHERE revision_id = ?').run(asked.assistant.revisionId);
  const old = await api<MessageContext>(s, 'GET', `/api/messages/${asked.assistant.id}/context`);
  assert.equal(old.status, 200);
  assert.equal(old.json.request, null);
  assert.deepEqual(
    old.json.manifest.parts.map((p) => p.kind),
    ['system', 'question'],
  );
});
