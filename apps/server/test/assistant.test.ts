import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type Message,
  type MessageContext,
  type Source,
  type SourceDetail,
  type Thread,
  type ThreadDetail,
  ulid,
} from '@noema/core';
import { ASSISTANT_PROMPT } from '../src/chat/assistant.ts';
import { api, newThread, readEvents, type SseEvent, startServer, type TestServer } from './helpers.ts';

// The Assistant (ADR 0023): one thread per notebook that looks things up
// across the notebook with read-only tools, in rounds, and cites what it
// found with labels that open the exact place. Played by the fake model,
// which looks up what the question's markers say.

let s: TestServer;
let notebookId = '';
let chatId = '';
let source: SourceDetail;

before(async () => {
  s = await startServer();
  const t = await newThread(s);
  notebookId = t.notebookId;
  chatId = t.threadId;
  await ask(chatId, 'What is the variance of a sum?');
  const pasted = (
    await api<Source>(s, 'POST', `/api/notebooks/${notebookId}/sources`, {
      id: ulid(),
      text: '# Week 4: Parallelism\n\n## Data parallel\n\nEach worker holds a copy of the model and a shard of the batch.\n\n## Pipeline parallel\n\nStages of the model on different devices.',
    })
  ).json;
  source = (await api<SourceDetail>(s, 'GET', `/api/sources/${pasted.id}`)).json;
});
after(() => s.close());

async function ask(threadId: string, content: string): Promise<{ id: string; events: SseEvent[] }> {
  const r = await api<{ assistant: { id: string } }>(s, 'POST', `/api/threads/${threadId}/messages`, { id: ulid(), content });
  const events = await readEvents(`${s.base}/api/messages/${r.json.assistant.id}/events`);
  return { id: r.json.assistant.id, events };
}

async function assistant(): Promise<Thread> {
  return (await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() })).json;
}

async function answerOf(threadId: string, id: string): Promise<Message> {
  const detail = (await api<ThreadDetail>(s, 'GET', `/api/threads/${threadId}`)).json;
  return detail.messages.find((m) => m.id === id) as Message;
}

const contextOf = async (id: string) => (await api<MessageContext>(s, 'GET', `/api/messages/${id}/context`)).json;

test('one Assistant per notebook: made once, kept apart from the threads', async () => {
  const first = await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() });
  assert.ok(first.status === 201 || first.status === 200);
  assert.equal(first.json.kind, 'assistant');
  assert.equal(first.json.title, 'Assistant');
  const again = await api<Thread>(s, 'POST', `/api/notebooks/${notebookId}/assistant`, { id: ulid() });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, first.json.id);
  const threads = (await api<{ threads: Thread[] }>(s, 'GET', `/api/notebooks/${notebookId}/threads`)).json.threads;
  assert.ok(threads.every((t) => t.kind === 'chat'));
  assert.ok(!threads.some((t) => t.id === first.json.id));
});

test('it looks things up in rounds, says what it is doing, and cites what it found', async () => {
  const me = await assistant();
  // [1] is the newest source in the overview.
  const { id, events } = await ask(me.id, 'What did Week 4 say? [[search:variance]] [[open:1]]');
  const kinds = events.map((e) => e.event);
  // The phase it is in when the watcher connects comes with the snapshot; then each change.
  const snapshot = (events[0]?.data as { phase?: string }).phase;
  const phases = [
    ...(snapshot ? [snapshot] : []),
    ...events.filter((e) => e.event === 'phase').map((e) => (e.data as { phase: string }).phase),
  ];
  assert.ok(phases.join(',').endsWith('looking,thinking,looking,thinking,writing'), phases.join(','));
  assert.deepEqual(
    events.filter((e) => e.event === 'step').map((e) => (e.data as { step: { label: string } }).step.label),
    ['Searched “variance”', 'Opened “Week 4: Parallelism”'],
  );
  assert.ok(kinds.indexOf('step') < kinds.indexOf('delta'), 'lookups come before the answer');

  const answer = await answerOf(me.id, id);
  assert.equal(answer.status, 'done');
  assert.match(answer.content, /I looked 2 times\. The first thing I found is here \[(\d+)\]\./);
  const cited = /found is here \[(\d+)\]/.exec(answer.content)?.[1] as string;
  assert.deepEqual(answer.lookups?.steps.map((x) => [x.tool, x.found]), [
    ['search', answer.lookups?.steps[0]?.found],
    ['open', 1],
  ]);
  assert.ok((answer.lookups?.steps[0]?.found ?? 0) >= 1, 'the search found the earlier question');
  // The label it cited points at the source's outline; one it was never given stays text.
  const target = answer.lookups?.refs[cited];
  assert.equal(target?.kind, 'source');
  assert.equal(target?.kind === 'source' ? target.sourceId : '', source.source.id);
  assert.ok(answer.content.includes('[99]'));
  assert.equal(answer.lookups?.refs['99'], undefined);

  // What was sent: the Assistant's instructions, the question with the overview, then each lookup and what came back.
  const context = await contextOf(id);
  assert.equal(context.request?.[0]?.content.startsWith(ASSISTANT_PROMPT), true);
  const question = context.request?.find((m) => m.role === 'user');
  assert.match(question?.content ?? '', /^## The notebook now/);
  assert.match(question?.content ?? '', /\[1\] “Week 4: Parallelism”/);
  assert.match(question?.content ?? '', /What did Week 4 say\?/);
  const tools = context.request?.filter((m) => m.role === 'tool') ?? [];
  assert.equal(tools.length, 2);
  assert.match(tools[0]?.content ?? '', /^Search for “variance”: \d+ found\.\n\[\d+\] The learner asked, in “/);
  assert.match(tools[1]?.content ?? '', /^Source “Week 4: Parallelism”\nOutline:\n\[\d+\] Week 4: Parallelism/);
  const turns = context.request?.filter((m) => m.role === 'assistant' && m.toolCalls) ?? [];
  assert.deepEqual(turns.map((t) => t.reasoning), ['I should look this up.', 'I should look this up.']);
  assert.deepEqual(
    context.manifest.parts.map((p) => p.kind).filter((k) => k === 'overview' || k === 'lookup'),
    ['overview', 'lookup', 'lookup'],
  );
  // Three model calls: two that looked things up, one that answered.
  const calls = s.db.sql
    .prepare('SELECT count(*) AS n FROM model_call mc JOIN message_revision r ON r.id = mc.revision_id WHERE r.message_id = ?')
    .get(id) as { n: number };
  assert.equal(calls.n, 3);
});

test('earlier answers go back without their labels; citations come out in one form', async () => {
  const me = await assistant();
  const first = await ask(me.id, 'Where is the source? [[open:1]] [[cite:1, 2]]');
  const answer = await answerOf(me.id, first.id);
  // [1, 2] became [1][2]: both labels were given (the source and its outline).
  assert.match(answer.content, /See also \[1\]\[2\]\./);
  assert.ok(answer.lookups?.refs['1'] && answer.lookups?.refs['2']);

  const second = await ask(me.id, 'And then?');
  const sent = (await contextOf(second.id)).request ?? [];
  const earlier = sent.find((m) => m.role === 'assistant' && m.content.includes('See also'));
  assert.ok(earlier, 'the earlier answer is in the history');
  assert.doesNotMatch(earlier?.content ?? '', /\[1\]|\[2\]/);
  assert.match(earlier?.content ?? '', /See also\./);
  assert.match(earlier?.content ?? '', /\[99\]/);
  // Without lookups it answers from the overview, and keeps nothing to look up.
  assert.equal((await answerOf(me.id, second.id)).lookups?.steps.length ?? 0, 0);
});

test('a page of a PDF, a note, a list; labels it was never given, and wrong arguments, are told back', async () => {
  const me = await assistant();
  const { id } = await ask(me.id, 'Show me [[open:1:3]] [[list:notes]] [[open:77]] [[list:everything]]');
  const tools = (await contextOf(id)).request?.filter((m) => m.role === 'tool').map((m) => m.content) ?? [];
  assert.deepEqual(tools, [
    'It is not a PDF: it has no pages. Open it without a page.',
    'Notes: 0.\nNone yet.',
    'There is no label [77] in this answer. Use a label you were given.',
    'Say what to list: threads, sources, notes or trash.',
  ]);
  const answer = await answerOf(me.id, id);
  assert.deepEqual(
    answer.lookups?.steps.map((x) => x.label),
    ['A lookup that could not be done', 'Listed the notes', 'A lookup that could not be done', 'A lookup that could not be done'],
  );
});

test('at most four lookups a round and six rounds; then it answers', async () => {
  const me = await assistant();
  const many = await ask(me.id, 'Look [[together]] [[search:a]] [[search:b]] [[search:c]] [[search:d]] [[search:e]]');
  const tools = (await contextOf(many.id)).request?.filter((m) => m.role === 'tool').map((m) => m.content) ?? [];
  assert.equal(tools.length, 5);
  assert.equal(tools[4], 'Not looked up: at most 4 lookups at once.');
  assert.equal((await answerOf(me.id, many.id)).lookups?.steps.length, 4);

  const markers = Array.from({ length: 8 }, (_, i) => `[[search:w${i}]]`).join(' ');
  const long = await ask(me.id, `Keep looking ${markers}`);
  const answer = await answerOf(me.id, long.id);
  assert.equal(answer.status, 'done');
  assert.equal(answer.lookups?.steps.length, 6);
  assert.match(answer.content, /I looked 6 times/);
});

test('its own thread is not material, and it is never "asked before"', async () => {
  const me = await assistant();
  await ask(me.id, 'Tell me about zebrafish please');
  const { id } = await ask(me.id, 'Again [[search:zebrafish]]');
  const tools = (await contextOf(id)).request?.filter((m) => m.role === 'tool').map((m) => m.content) ?? [];
  assert.match(tools[0] ?? '', /^Search for “zebrafish”: nothing found\./);
  const asked = await api<{ hits: unknown[] }>(s, 'POST', `/api/notebooks/${notebookId}/asked`, {
    text: 'Tell me about zebrafish please',
  });
  assert.deepEqual(asked.json.hits, []);
});

test('a model that refuses lookups while thinking is asked without thinking; one that refuses them, from the overview', async () => {
  const fresh = await startServer();
  try {
    const nb = (await api<{ notebooks: Array<{ id: string }> }>(fresh, 'GET', '/api/notebooks')).json.notebooks[0]?.id;
    const me = (await api<Thread>(fresh, 'POST', `/api/notebooks/${nb}/assistant`, { id: ulid() })).json;
    const send = async (content: string) => {
      const r = await api<{ assistant: { id: string } }>(fresh, 'POST', `/api/threads/${me.id}/messages`, { id: ulid(), content });
      await readEvents(`${fresh.base}/api/messages/${r.json.assistant.id}/events`);
      return (await api<ThreadDetail>(fresh, 'GET', `/api/threads/${me.id}`)).json.messages.find(
        (m) => m.id === r.json.assistant.id,
      ) as Message;
    };
    const a = await send('Hello [[no-thinking-tools]] [[list:sources]]');
    assert.equal(a.status, 'done');
    assert.deepEqual(a.lookups?.steps.map((x) => x.label), ['Listed the sources']);
    const refused = fresh.db.sql.prepare("SELECT count(*) AS n FROM model_call WHERE error_kind = 'bad_request'").get() as {
      n: number;
    };
    assert.equal(refused.n, 1);

    const b = await send('Hello [[no-tools]] [[list:sources]]');
    assert.equal(b.status, 'done');
    assert.equal(b.lookups, null);
    assert.match(b.content, /I looked 0 times/);
  } finally {
    fresh.close();
  }
});

test('a side question can be asked from an Assistant answer, as from any answer', async () => {
  const me = await assistant();
  const { id } = await ask(me.id, 'Explain [[open:1]]');
  const answer = await answerOf(me.id, id);
  const start = answer.content.indexOf('I looked');
  const branch = await api<{ thread: Thread }>(s, 'POST', `/api/threads/${me.id}/branches`, {
    id: ulid(),
    anchor: { messageId: id, start, end: start + 8 },
    question: { id: ulid(), content: 'Why?' },
  });
  assert.equal(branch.status, 201);
  assert.equal(branch.json.thread.kind, 'chat');
  void chatId;
});
