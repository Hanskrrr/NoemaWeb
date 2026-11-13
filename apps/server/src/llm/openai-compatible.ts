// A streaming client for OpenAI-compatible chat completions: DeepSeek, Qwen
// (DashScope compatible mode), Kimi, GLM, OpenRouter, local Ollama, OpenAI.
//
// Rules this client keeps (see docs/adr/0003):
// - Retry only before the first token. After text has reached the learner,
//   a retry would duplicate or contradict it, so a later failure is final and
//   the partial answer is kept.
// - Two timeouts: one for the response to start, one for silence between
//   chunks. Either becomes a named "timeout" error.
// - Every failure leaves as a ProviderError with a kind the UI can explain.

import { isRetryable, type ToolCall, type ToolSpec } from '@noema/core';
import {
  type ModelProvider,
  ProviderError,
  type StreamEvent,
  type StreamRequest,
  sleep,
  type Usage,
} from './provider.ts';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  maxAttempts?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** A Retry-After longer than this is reported to the learner instead of waited out. */
  maxRetryAfterMs?: number;
}

/** Splits a text/event-stream into `data` payloads. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let nl = this.buffer.search(/\r\n|\r|\n/);
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line, out);
      nl = this.buffer.search(/\r\n|\r|\n/);
    }
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.buffer) this.line(this.buffer, out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: string[]): void {
    if (line === '') {
      if (this.data.length) out.push(this.data.join('\n'));
      this.data = [];
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
    // Comments (":keep-alive") and other fields (event, id, retry) are not used by chat completions.
  }
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChunkJson {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCallDelta[] | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string; type?: string; code?: string | number };
}

export function mapUsage(u: NonNullable<ChunkJson['usage']>): Usage {
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  const miss =
    u.prompt_cache_miss_tokens ??
    (hit !== undefined && u.prompt_tokens !== undefined ? u.prompt_tokens - hit : undefined);
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Provider-specific request fields. DeepSeek's models think before answering
 * by default; for a short utility call (a title) that only costs time, and
 * DeepSeek lets us turn it off. Other providers get nothing extra, since some
 * reject fields they do not know.
 */
export function extraBody(baseUrl: string, req: Pick<StreamRequest, 'light'>): Record<string, unknown> {
  if (req.light && isDeepSeek(baseUrl)) return { thinking: { type: 'disabled' } };
  return {};
}

/** DeepSeek's own API: it thinks by default, and wants its reasoning back between lookups. */
export function isDeepSeek(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

/** Lookups as the API takes them. */
export function wireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Pieces of tool calls, as they stream, put together by their index. */
export class ToolCallParts {
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  push(deltas: ToolCallDelta[]): void {
    for (const d of deltas) {
      const i = d.index ?? 0;
      const call = this.calls.get(i) ?? { id: '', name: '', arguments: '' };
      if (d.id) call.id = d.id;
      if (d.function?.name) call.name += d.function.name;
      if (d.function?.arguments) call.arguments += d.function.arguments;
      this.calls.set(i, call);
    }
  }

  get size(): number {
    return this.calls.size;
  }

  done(): ToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments }));
  }
}

export function httpError(status: number, body: string, retryAfter: string | null): ProviderError {
  let message = `HTTP ${status}`;
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const m = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message);
    if (m) message = m.slice(0, 300);
  } catch {
    if (body.trim()) message = body.trim().slice(0, 300);
  }
  const lower = body.toLowerCase();
  const opts = { status, retryAfterMs: parseRetryAfter(retryAfter) };
  if (status === 401 || status === 403) return new ProviderError('auth', message, opts);
  if (status === 402 || lower.includes('insufficient_quota') || lower.includes('insufficient balance')) {
    return new ProviderError('quota', message, opts);
  }
  if (status === 429) return new ProviderError('rate_limit', message, opts);
  if (status === 408) return new ProviderError('timeout', message, opts);
  if (lower.includes('context length') || lower.includes('maximum context') || lower.includes('too many tokens')) {
    return new ProviderError('context_too_large', message, opts);
  }
  if (status >= 500) return new ProviderError('unavailable', message, opts);
  return new ProviderError('bad_request', message, opts);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly headersTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryAfterMs: number;

  constructor(o: OpenAICompatibleOptions) {
    this.model = o.model;
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.url = `${this.baseUrl}/chat/completions`;
    this.apiKey = o.apiKey;
    this.fetchImpl = o.fetch ?? globalThis.fetch;
    this.maxAttempts = o.maxAttempts ?? 3;
    this.headersTimeoutMs = o.headersTimeoutMs ?? 30_000;
    this.idleTimeoutMs = o.idleTimeoutMs ?? 60_000;
    this.backoffMs = o.backoffMs ?? 500;
    this.maxBackoffMs = o.maxBackoffMs ?? 8_000;
    this.maxRetryAfterMs = o.maxRetryAfterMs ?? 20_000;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Prove the key and model work before they are saved. Lists the provider's
   * models (free on most providers); if the model is not listed, or the
   * provider has no model list, asks for a few tokens instead.
   * Throws a ProviderError; returns the model ids the provider listed.
   */
  async check(signal: AbortSignal = new AbortController().signal): Promise<{ models: string[] }> {
    if (!this.configured) throw new ProviderError('not_configured', 'no API key');
    const models = await this.listModels(signal);
    if (models?.includes(this.model)) return { models };
    let finished = false;
    for await (const ev of this.stream({
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      maxTokens: 16,
      signal,
    })) {
      if (ev.type === 'finish') finished = true;
    }
    if (!finished) throw new ProviderError('network', 'the test answer did not finish');
    return { models: models ?? [] };
  }

  /** Model ids from GET /models, or null when the provider does not offer that endpoint. */
  private async listModels(signal: AbortSignal): Promise<string[] | null> {
    const timeout = AbortSignal.timeout(this.headersTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (e) {
      if (signal.aborted) throw new ProviderError('aborted', 'stopped', { cause: e });
      if (timeout.aborted) throw new ProviderError('timeout', `no response within ${this.headersTimeoutMs} ms`);
      const msg = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      throw new ProviderError('network', msg, { cause: e });
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) return null;
    const body = await res.text().catch(() => '');
    if (!res.ok) throw httpError(res.status, body.slice(0, 4000), res.headers.get('retry-after'));
    try {
      const json = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
      const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    }
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    if (!this.configured) throw new ProviderError('not_configured', 'no API key');
    for (let attempt = 1; ; attempt++) {
      yield { type: 'attempt', n: attempt };
      let sentText = false;
      try {
        for await (const ev of this.once(req)) {
          if (ev.type === 'text') sentText = true;
          yield ev;
        }
        return;
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('internal', String(e), { cause: e });
        const waitFor = err.retryAfterMs;
        const retry =
          !sentText &&
          !req.signal.aborted &&
          attempt < this.maxAttempts &&
          isRetryable(err.kind) &&
          (waitFor === undefined || waitFor <= this.maxRetryAfterMs);
        if (!retry) throw err;
        await sleep(waitFor ?? this.backoff(attempt), req.signal);
      }
    }
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  private async *once(req: StreamRequest): AsyncIterable<StreamEvent> {
    const ctrl = new AbortController();
    let timedOut: 'start' | 'idle' | null = null;
    const onAbort = () => ctrl.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let timer = setTimeout(() => {
      timedOut = 'start';
      ctrl.abort();
    }, this.headersTimeoutMs);
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = 'idle';
        ctrl.abort();
      }, this.idleTimeoutMs);
    };
    const classify = (e: unknown): ProviderError => {
      if (e instanceof ProviderError) return e;
      if (req.signal.aborted) return new ProviderError('aborted', 'stopped', { cause: e });
      if (timedOut === 'start') return new ProviderError('timeout', `no response within ${this.headersTimeoutMs} ms`);
      if (timedOut === 'idle')
        return new ProviderError('timeout', `the stream went quiet for ${this.idleTimeoutMs} ms`);
      const msg = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      return new ProviderError('network', msg, { cause: e });
    };

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: this.model,
            messages: wireMessages(req, { reasoning: isDeepSeek(this.baseUrl) }),
            stream: true,
            stream_options: { include_usage: true },
            ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
            ...(req.tools && req.tools.length > 0
              ? { tools: wireTools(req.tools), ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}) }
              : {}),
            ...extraBody(this.baseUrl, req),
          }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw classify(e);
      }
      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 4000);
        } catch {
          // keep the status alone
        }
        throw httpError(res.status, body, res.headers.get('retry-after'));
      }
      if (!res.body) throw new ProviderError('network', 'the response had no body');

      resetIdle();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let finishReason: string | null = null;
      let done = false;
      const calls = new ToolCallParts();
      const handle = function* (payloads: string[]): Generator<StreamEvent> {
        for (const data of payloads) {
          if (data === '[DONE]') {
            done = true;
            continue;
          }
          let json: ChunkJson;
          try {
            json = JSON.parse(data) as ChunkJson;
          } catch {
            throw new ProviderError('unavailable', 'the provider sent a malformed stream chunk');
          }
          if (json.error) {
            throw httpError(Number(json.error.code) || 500, JSON.stringify({ error: json.error }), null);
          }
          const choice = json.choices?.[0];
          const reasoning = choice?.delta?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) yield { type: 'reasoning', text: reasoning };
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text.length > 0) yield { type: 'text', text };
          if (choice?.delta?.tool_calls) calls.push(choice.delta.tool_calls);
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (json.usage) yield { type: 'usage', usage: mapUsage(json.usage) };
        }
      };
      try {
        while (!done) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (e) {
            throw classify(e);
          }
          if (chunk.done) {
            yield* handle(parser.end());
            break;
          }
          resetIdle();
          yield* handle(parser.push(decoder.decode(chunk.value, { stream: true })));
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      if (!done && finishReason === null)
        throw new ProviderError('network', 'the stream ended before the answer finished');
      if (calls.size > 0) yield { type: 'tool_calls', calls: calls.done() };
      yield { type: 'finish', reason: finishReason };
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The messages as the API takes them: a question with pictures becomes a list
 * of parts, the pictures first (as data: URLs), then its text. A turn that
 * asked for lookups carries them as tool_calls, each answer is a tool turn,
 * and (for DeepSeek, `reasoning`) the reasoning before a lookup goes back.
 */
export function wireMessages(
  req: Pick<StreamRequest, 'messages' | 'images'>,
  options: { reasoning?: boolean } = {},
): unknown[] {
  return req.messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        ...(options.reasoning && m.reasoning ? { reasoning_content: m.reasoning } : {}),
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      };
    }
    const pictures = (m.images ?? [])
      .map((image) => req.images?.(image.ref))
      .filter((p): p is { mediaType: string; data: string } => p !== null && p !== undefined);
    if (pictures.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...pictures.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } })),
        { type: 'text', text: m.content },
      ],
    };
  });
}

