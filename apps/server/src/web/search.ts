// Searching the web (ADR 0031). DeepSeek's own search API, with the same key
// as the model ($0.75 per 1,000 successful searches; failed and empty ones are
// not billed). Only the search words leave the computer. Tests and CI use the
// fake search, never the real one.

import { ProviderError } from '../llm/provider.ts';

export interface WebResult {
  title: string;
  url: string;
  /** A short line for people. */
  snippet: string;
  /** A longer account of the page, for the model. */
  summary: string;
  site: string | null;
  date: string | null;
  /** 0 to 3; 1.5 and above is a good match. */
  score: number | null;
}

export interface WebSearch {
  readonly name: string;
  search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** DeepSeek's search: POST {origin}/v1/tools/search with { query, count }. */
export class DeepSeekSearch implements WebSearch {
  readonly name = 'deepseek-search';
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(s: { baseUrl: string; apiKey: string }, fetchImpl: typeof fetch = fetch) {
    this.origin = new URL(s.baseUrl).origin;
    this.apiKey = s.apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]> {
    const res = await this.fetchImpl(`${this.origin}/v1/tools/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: Array.from(query).slice(0, 128).join(''), count: Math.max(1, Math.min(50, count)) }),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'the key was refused by the search');
    if (res.status === 402) throw new ProviderError('quota', 'no credit left for the search');
    if (res.status === 429) throw new ProviderError('rate_limit', 'too many searches');
    if (!res.ok) throw new ProviderError('unavailable', `the search answered ${res.status}`);
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) return [];
    return body.results
      .map((r) => r as Record<string, unknown>)
      .filter((r) => /^https?:\/\//.test(str(r.url)))
      .map((r) => ({
        title: str(r.title).trim(),
        url: str(r.url),
        snippet: str(r.snippet).trim(),
        summary: (str(r.summary) || str(r.snippet)).trim(),
        site: strOrNull(r.site_name),
        date: strOrNull(r.date),
        score: typeof r.rerank_score === 'number' ? r.rerank_score : null,
      }));
  }
}

/**
 * The search for tests: predictable pages from the words searched. "[[no-web]]" in a question finds nothing;
 * "[[fail-web]]" fails as the service would.
 */
export class FakeSearch implements WebSearch {
  readonly name = 'fake-search';
  async search(query: string, count: number): Promise<WebResult[]> {
    if (query.includes('fail-web')) throw new ProviderError('unavailable', 'fake search failure');
    if (query.includes('no-web')) return [];
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
    return Array.from({ length: Math.min(count, 3) }, (_, i) => ({
      title: `Fake page ${i + 1} on ${query}`,
      url: `https://example.org/${slug}-${i + 1}`,
      snippet: `What page ${i + 1} says about ${query}.`,
      summary: `A longer account of page ${i + 1} about ${query}.`,
      site: 'example.org',
      date: '2026-01-0' + String(i + 1) + 'T00:00:00Z',
      score: 2 - i * 0.5,
    }));
  }
}
