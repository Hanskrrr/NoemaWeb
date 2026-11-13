import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  httpError,
  isDeepSeek,
  mapUsage,
  OpenAICompatibleProvider,
  SseParser,
  wireMessages,
} from '../src/llm/openai-compatible.ts';
import type { ProviderError, StreamEvent } from '../src/llm/provider.ts';

// A stand-in for api.deepseek.com. Each test sets `behave` to script one response.
type Behave = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, hit: number) => void;
let behave: Behave = () => {};
let hits = 0;
let base = '';
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => {
    raw += c.toString();
  });
  req.on('end', () => behave(req, res, JSON.parse(raw || '{}') as Record<string, unknown>, ++hits));
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const sse = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const chunk = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const text = (t: string) => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });

function provider(overrides: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: base,
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    backoffMs: 1,
    maxBackoffMs: 5,
    ...overrides,
  });
}

async function collect(p: OpenAICompatibleProvider, signal = new AbortController().signal) {
  const events: StreamEvent[] = [];
  try {
    for await (const ev of p.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, signal }))
      events.push(ev);
    return { events, error: null as ProviderError | null };
  } catch (e) {
    return { events, error: e as ProviderError };
  }
}

const textOf = (events: StreamEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');

test('streams text, finish reason and DeepSeek cache usage', async () => {
  hits = 0;
  let seen: Record<string, unknown> = {};
  let auth = '';
  behave = (req, res, body) => {
    seen = body;
    auth = req.headers.authorization ?? '';
    sse(res);
    res.write(': keep-alive\n\n');
    chunk(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    chunk(res, text('Hello'));
    chunk(res, text(', 世界'));
    chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk(res, {
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 3, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
  };
  const { events, error } = await collect(provider());
  assert.equal(error, null);
  assert.equal(textOf(events), 'Hello, 世界');
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.deepEqual(
    events.find((e) => e.type === 'usage'),
    { type: 'usage', usage: { promptTokens: 50, completionTokens: 3, cacheHitTokens: 40, cacheMissTokens: 10 } },
  );
  assert.equal(auth, 'Bearer sk-test');
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });
  assert.equal(seen.model, 'deepseek-chat');
});

test('a 429 before any text is retried, honouring Retry-After', async () => {
  hits = 0;
  behave = (_req, res, _body, n) => {
    if (n === 1) {
      res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
      return;
    }
    sse(res);
    chunk(res, text('ok'));
    chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  };
  const { events, error } = await collect(provider());
  assert.equal(error, null);
  assert.equal(textOf(events), 'ok');
  assert.deepEqual(
    events.filter((e) => e.type === 'attempt').map((e) => (e.type === 'attempt' ? e.n : 0)),
    [1, 2],
  );
});

test('retries stop after maxAttempts and report the last error', async () => {
  hits = 0;
  behave = (_req, res) => {
    res.writeHead(503);
    res.end('Service Unavailable');
  };
  const { error } = await collect(provider({ maxAttempts: 3 }));
  assert.equal(error?.kind, 'unavailable');
  assert.equal(hits, 3);
});

test('auth, quota and bad requests are not retried', async () => {
  for (const [status, body, kind] of [
    [401, { error: { message: 'Authentication Fails' } }, 'auth'],
    [402, { error: { message: 'Insufficient Balance' } }, 'quota'],
    [400, { error: { message: 'Invalid model' } }, 'bad_request'],
  ] as const) {
    hits = 0;
    behave = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const { error } = await collect(provider());
    assert.equal(error?.kind, kind);
    assert.equal(hits, 1, `${status} was retried`);
    assert.equal(error?.message, body.error.message);
  }
});

test('a failure after text has streamed is final: no retry, no duplicated text', async () => {
  hits = 0;
  behave = (_req, res) => {
    sse(res);
    chunk(res, text('partial '));
    setTimeout(() => res.destroy(), 20);
  };
  const { events, error } = await collect(provider());
  assert.equal(error?.kind, 'network');
  assert.equal(textOf(events), 'partial ');
  assert.equal(hits, 1);
});

test('a stream that ends without finishing is an error, not a silent short answer', async () => {
  hits = 0;
  behave = (_req, res) => {
    sse(res);
    chunk(res, text('cut'));
    res.end();
  };
  const { error } = await collect(provider());
  assert.equal(error?.kind, 'network');
});

test('silence between chunks is a timeout', async () => {
  hits = 0;
  behave = (_req, res) => {
    sse(res);
    chunk(res, text('then nothing'));
  };
  const { events, error } = await collect(provider({ idleTimeoutMs: 100 }));
  assert.equal(error?.kind, 'timeout');
  assert.equal(textOf(events), 'then nothing');
});

test('no response at all is a timeout, and is retried', async () => {
  hits = 0;
  behave = () => {}; // never answers
  const { error } = await collect(provider({ headersTimeoutMs: 80, maxAttempts: 2 }));
  assert.equal(error?.kind, 'timeout');
  assert.equal(hits, 2);
});

test('stopping aborts the request and reports aborted', async () => {
  hits = 0;
  behave = (_req, res) => {
    sse(res);
    chunk(res, text('a'));
  };
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  const { error } = await collect(provider({ idleTimeoutMs: 5000 }), ctrl.signal);
  assert.equal(error?.kind, 'aborted');
});

test('a connection refused is a network error', async () => {
  const { error } = await collect(provider({ baseUrl: 'http://127.0.0.1:9', maxAttempts: 1 }));
  assert.equal(error?.kind, 'network');
});

test('no API key is reported as not configured, without a request', async () => {
  hits = 0;
  const { error } = await collect(provider({ apiKey: '' }));
  assert.equal(error?.kind, 'not_configured');
  assert.equal(hits, 0);
});

test('the SSE parser handles split chunks, CRLF and multi-line data', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a"'), []);
  assert.deepEqual(p.push(':1}\r\n\r\ndata: x\ndata: y\n'), ['{"a":1}']);
  assert.deepEqual(p.push('\n'), ['x\ny']);
  assert.deepEqual(p.push('data: tail'), []);
  assert.deepEqual(p.end(), ['tail']);
});

test('OpenAI-style cached token counts are mapped too', () => {
  assert.deepEqual(
    mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } }),
    {
      promptTokens: 100,
      completionTokens: 5,
      cacheHitTokens: 64,
      cacheMissTokens: 36,
    },
  );
});

test('error bodies become readable messages and the right kinds', () => {
  assert.equal(httpError(429, '{"error":{"code":"insufficient_quota"}}', null).kind, 'quota');
  assert.equal(httpError(400, "This model's maximum context length is 65536 tokens", null).kind, 'context_too_large');
  assert.equal(httpError(502, '<html>bad gateway</html>', null).kind, 'unavailable');
  assert.equal(httpError(429, '', '2').retryAfterMs, 2000);
});

test('lookups: tools go out with the request; reasoning and tool calls come back in pieces, put together', async () => {
  hits = 0;
  let seen: Record<string, unknown> = {};
  behave = (_req, res, body) => {
    seen = body;
    sse(res);
    chunk(res, { choices: [{ index: 0, delta: { reasoning_content: 'I should ' }, finish_reason: null }] });
    chunk(res, { choices: [{ index: 0, delta: { reasoning_content: 'search.' }, finish_reason: null }] });
    chunk(res, {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"que' } }] },
          finish_reason: null,
        },
      ],
    });
    chunk(res, {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"variance"}' } }] }, finish_reason: null }],
    });
    chunk(res, {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list', arguments: '{"what":"notes"}' } }] },
          finish_reason: null,
        },
      ],
    });
    chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    res.end('data: [DONE]\n\n');
  };
  const p = provider();
  const events: StreamEvent[] = [];
  for await (const ev of p.stream({
    messages: [{ role: 'user', content: 'What did I ask?' }],
    tools: [{ name: 'search', description: 'Search.', parameters: { type: 'object', properties: {} } }],
    toolChoice: 'auto',
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }
  assert.deepEqual(seen.tools, [
    { type: 'function', function: { name: 'search', description: 'Search.', parameters: { type: 'object', properties: {} } } },
  ]);
  assert.equal(seen.tool_choice, 'auto');
  assert.equal(
    events
      .filter((e) => e.type === 'reasoning')
      .map((e) => (e.type === 'reasoning' ? e.text : ''))
      .join(''),
    'I should search.',
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'tool_calls'),
    [
      {
        type: 'tool_calls',
        calls: [
          { id: 'call_a', name: 'search', arguments: '{"query":"variance"}' },
          { id: 'call_b', name: 'list', arguments: '{"what":"notes"}' },
        ],
      },
    ],
  );
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls' });
  assert.equal(textOf(events), '');
});

test('lookups go back as tool turns; the reasoning before them goes back to DeepSeek only', async () => {
  const messages = [
    { role: 'user' as const, content: 'Q' },
    {
      role: 'assistant' as const,
      content: '',
      reasoning: 'Search first.',
      toolCalls: [{ id: 'c1', name: 'search', arguments: '{"query":"x"}' }],
    },
    { role: 'tool' as const, toolCallId: 'c1', content: '[1] found' },
  ];
  const deepseek = wireMessages({ messages }, { reasoning: true });
  assert.deepEqual(deepseek.slice(1), [
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'Search first.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '[1] found' },
  ]);
  const other = wireMessages({ messages });
  assert.equal('reasoning_content' in (other[1] as object), false);
  assert.equal(isDeepSeek('https://api.deepseek.com/v1'), true);
  assert.equal(isDeepSeek('https://openrouter.ai/api/v1'), false);
});
