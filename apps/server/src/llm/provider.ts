// What the rest of the server needs from a model: a stream of text, a usage
// report, and errors with a name. Providers translate their own failures
// into ProviderError so nothing above this layer sees raw HTTP or fetch errors.

import type { ChatMessage, ErrorKind, ToolCall, ToolSpec } from '@noema/core';

export interface StreamRequest {
  messages: ChatMessage[];
  /** The pictures messages refer to (ChatMessage.images), base64; null if one is gone. */
  images?: ((ref: string) => { mediaType: string; data: string } | null) | undefined;
  /** Omitted: the provider's default. */
  maxTokens?: number | undefined;
  /** A short utility call (a title): skip the model's reasoning step where the provider allows it. */
  light?: boolean | undefined;
  /** What the call is for; the fake model answers titles differently. */
  purpose?: 'answer' | 'assistant' | 'title' | 'headline' | 'note' | 'suggest' | 'merge' | 'asked' | undefined;
  /** Lookups the model may ask for (the Assistant, ADR 0023). */
  tools?: ToolSpec[] | undefined;
  /** 'none': the tools are described, but this round must answer (the last round). */
  toolChoice?: 'auto' | 'none' | undefined;
  /** Which revision of an answer this is: 2 and up when the learner asked again. Real providers ignore it; the fake answers differently, so tests can tell revisions apart. */
  revision?: number | undefined;
  signal: AbortSignal;
}

export interface Usage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  /** DeepSeek: prompt_cache_hit_tokens. OpenAI: prompt_tokens_details.cached_tokens. */
  cacheHitTokens?: number | undefined;
  cacheMissTokens?: number | undefined;
}

export type StreamEvent =
  | { type: 'attempt'; n: number }
  | { type: 'text'; text: string }
  /** The model's reasoning before it answers (DeepSeek's reasoning_content); not shown, but sent back with tools. */
  | { type: 'reasoning'; text: string }
  /** The lookups the model asked for, complete, just before the stream finishes with reason 'tool_calls'. */
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: string | null };

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  /** False when the provider cannot work as configured (for example, no API key). */
  readonly configured: boolean;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'stopped'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'stopped'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
