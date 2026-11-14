import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelSettings } from '../src/llm/settings.ts';
import { DeepSeekSearch, FakeSearch } from '../src/web/search.ts';
import { ProviderError } from '../src/llm/provider.ts';

// Searching the web (ADR 0031): DeepSeek's search API with the model's key, the fake one in tests, and nothing
// for other providers. Never the real service here: its fetch is a stand-in.

const log = { info() {}, warn() {}, error() {}, debug() {} } as never;

test("DeepSeek's search is asked with the words and the key, and what comes back is read with care", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        results: [
          { rerank_score: 2.1, title: ' Sublinear memory ', url: 'https://arxiv.org/abs/1604.06174', snippet: 'Recompute.', summary: 'A longer account.', site_name: 'arXiv', date: '2016-04-21T00:00:00Z', authority: 3 },
          { title: 'No address', url: 'javascript:alert(1)' },
          { title: 'Bare', url: 'https://example.org/x', snippet: 'Only a snippet.' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const search = new DeepSeekSearch({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-key' }, fake);
  const results = await search.search('activation memory', 5);
  assert.ok(seen);
  const s = seen as { url: string; init: RequestInit };
  assert.equal(s.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal((s.init.headers as Record<string, string>).authorization, 'Bearer sk-test-key');
  assert.deepEqual(JSON.parse(s.init.body as string), { query: 'activation memory', count: 5 });
  assert.deepEqual(results, [
    { title: 'Sublinear memory', url: 'https://arxiv.org/abs/1604.06174', snippet: 'Recompute.', summary: 'A longer account.', site: 'arXiv', date: '2016-04-21T00:00:00Z', score: 2.1 },
    { title: 'Bare', url: 'https://example.org/x', snippet: 'Only a snippet.', summary: 'Only a snippet.', site: null, date: null, score: null },
  ]);
  const refused = new DeepSeekSearch({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }, (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(refused.search('x', 3), (err: unknown) => err instanceof ProviderError && err.kind === 'auth');
  const broke = new DeepSeekSearch({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' }, (async () => new Response('{}', { status: 402 })) as unknown as typeof fetch);
  await assert.rejects(broke.search('x', 3), (err: unknown) => err instanceof ProviderError && err.kind === 'quota');
});

test('the web can be searched with DeepSeek (its key), the fake model in tests, and not with other providers', () => {
  const made = (env: { provider: 'fake' | 'openai-compatible'; baseUrl: string; model: string; apiKey: string }) =>
    new ModelSettings({ env, filePath: null, fake: () => ({ name: 'fake', model: 'fake', configured: true, stream: () => { throw new Error('no'); } }) as never, log });
  assert.ok(made({ provider: 'fake', baseUrl: '', model: '', apiKey: '' }).search() instanceof FakeSearch);
  assert.ok(made({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-x' }).search() instanceof DeepSeekSearch);
  assert.equal(made({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: 'sk-x' }).search(), null);
  assert.equal(made({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' }).search(), null);
});
