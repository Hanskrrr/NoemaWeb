# 0003. Our own OpenAI-compatible streaming client

Date: 2026-11-04. Status: accepted.

## Context

The reliability handoff suggested the AI SDK (`ai`, `@ai-sdk/openai-compatible`). What v0.1 needs from a model client is narrow: stream chat completions from DeepSeek (or Qwen, Kimi, GLM, OpenRouter, Ollama), report usage including DeepSeek's `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, and fail in ways the learner can understand. The rules that matter are specific:

- retry only before the first token, because a retry after text has been shown would duplicate or contradict it;
- separate timeouts for "no response" and "the stream went quiet";
- every failure becomes a named kind (`auth`, `quota`, `rate_limit`, `unavailable`, `timeout`, `network`, `aborted`, `context_too_large`, `bad_request`, `not_configured`).

## Decision

`apps/server/src/llm/openai-compatible.ts` (about 300 lines) implements this over `fetch` and a small SSE parser, behind the `ModelProvider` interface in `llm/provider.ts`. The fake provider implements the same interface.

## Consequences

- The behaviour is tested against a scripted mock server: 429 with Retry-After, 5xx exhaustion, 401/402/400 without retry, a drop after the first token, a stream that ends early, idle and start timeouts, abort, connection refused, cache-usage mapping.
- One less dependency with a fast-moving major version.
- Tool calls, structured output and non-OpenAI wire formats are not supported. v0.1 needs none of them.

## How to reverse

Add an `AiSdkProvider` implementing `ModelProvider` with `streamText`, and keep the same error mapping. Nothing above the interface changes.
