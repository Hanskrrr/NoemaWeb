# Noema

A learning notebook for studying hard material with an AI. Ask in a normal chat; branch a side question from the exact passage that raised it; come back to exactly where you were; find any exchange again days later. Nothing is lost when a tab closes or the server restarts.

This repository is the working prototype (v0.1). The product thinking (PARADIGM, interviews, the prototype brief) lives in the `NoemaLearningNote` workspace, not here.

**Status: M0 done, most of M1 done.** One notebook, one thread, streaming answers that survive reloads and crashes, stop, named errors, search and export APIs, and the anchor spike (select a passage in a rendered answer and get exact raw offsets). Branches, sources and the Notebook view come next. See [the latest handoff](docs/handoffs/2026-11-04-m0.md).

## Run it

You need Node 22.18 or newer (24 LTS is fine) and pnpm 10 (`corepack enable` gives you the pinned version).

```sh
pnpm install
cp .env.example .env      # optional: the default is the offline fake model
pnpm dev                  # server on :8787, web on http://127.0.0.1:5173
```

To use a real model, set these in `.env` (DeepSeek works from Hong Kong; any OpenAI-compatible endpoint works):

```sh
NOEMA_PROVIDER=openai-compatible
NOEMA_LLM_BASE_URL=https://api.deepseek.com
NOEMA_LLM_API_KEY=sk-...
NOEMA_LLM_MODEL=deepseek-chat
```

Without Vite: `pnpm build && pnpm start`, then open http://127.0.0.1:8787.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Server (restarts on change) and Vite (hot reload) together |
| `pnpm test` | Unit and integration tests (`node --test`): core, server over real HTTP and SQLite, Markdown offsets |
| `pnpm e2e` | Builds the web app, starts the server with the fake model, drives Chromium with Playwright |
| `pnpm typecheck` | `tsc` for every package, the scripts and the e2e specs |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm check` | typecheck, lint, test |

## Your data

- Everything is in one SQLite file, `data/noema.db` (git-ignored). The server opens it in WAL mode.
- A consistent copy goes to `data/backups/` once a day; the newest seven are kept.
- `GET /api/export` downloads everything as JSON.
- The server listens on 127.0.0.1 only and refuses requests addressed to any other host or sent from other sites. There is no login, so do not put it on a network.

## The fake model

`NOEMA_PROVIDER=fake` answers every question with the same Markdown (text, math, a list, Chinese, code), so tests can check exact text. Markers in a question change what it does: `[[slow]]` streams slowly, `[[fail:rate_limit]]` (or any error kind) fails before the first token, `[[error-midway]]` drops the connection halfway.

## Layout

```
packages/core     pure TypeScript, no I/O: ids, anchors, search text, context assembly, the API contract (Zod)
apps/server       node:http + node:sqlite: store, model clients, generation, SSE, routes
apps/web          Vite + React: the shell, the offset-preserving Markdown renderer, selection -> anchor
e2e               Playwright specs, always against the fake model
docs/adr          engineering decisions, one page each
docs/handoffs     one note per build session
```

Rules for working in this repo, for people and agents: [AGENTS.md](AGENTS.md).
