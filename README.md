# Noema

A learning notebook for studying hard material with an AI. Ask in a normal chat; branch a side question from the exact passage that raised it; come back to exactly where you were; find any exchange again days later. Nothing is lost when a tab closes or the server restarts.

This repository is the working prototype (v0.1). The product thinking (PARADIGM, interviews, the prototype brief) lives in the `NoemaLearningNote` workspace, not here.

**Status: M2 done, plus the first notebook features.** Threads in a sidebar with titles the model writes and you can change; ask about any selected passage in a side branch that keeps its exact origin, and go Back to that passage, highlighted. The sidebar shows the passage each branch came from, and a Map shows the whole thread tree on one page; both jump to the exact spot. Rewrite a thread as an editable study note whose citations open the exchanges they came from. Answers stream and survive reloads and crashes, with tables, math and code; the model is connected with your own key. Sources and search come next. See [the latest handoff](docs/handoffs/2026-11-05-notebook-map-notes.md).

## Run it

You need Node 22.18 or newer (24 LTS is fine) and pnpm 10 (`npm install -g pnpm@10`; from Node 25 on, corepack is no longer bundled).

```sh
pnpm install
pnpm dev                  # server on :8787, web on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173. The first screen asks for a model: paste your API key (DeepSeek is preset; any OpenAI-compatible provider works) and press **Save and connect**. Noema checks the key with the provider before saving it. Change it later from the model name in the top-right corner.

Without Vite: `pnpm build && pnpm start`, then open http://127.0.0.1:8787.

## Commands

| Command                     | What it does                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm dev`                  | Server (restarts on change) and Vite (hot reload) together                                           |
| `pnpm test`                 | Unit and integration tests (`node --test`): core, server over real HTTP and SQLite, Markdown offsets |
| `pnpm e2e`                  | Builds the web app, starts test servers (a fake model and a stand-in provider), drives Chromium      |
| `pnpm typecheck`            | `tsc` for every package, the scripts and the e2e specs                                               |
| `pnpm lint` / `pnpm format` | Biome                                                                                                |
| `pnpm check`                | typecheck, lint, test                                                                                |

## Your data

- Everything is in one SQLite file, `data/noema.db` (git-ignored). The server opens it in WAL mode.
- A consistent copy goes to `data/backups/` once a day; the newest seven are kept.
- `GET /api/export` downloads everything as JSON.
- Your API key is in `data/settings.json`, readable only by your user account. It is never stored in the database, so exports and backups never contain it, and the server never sends it back to the browser.
- The server listens on 127.0.0.1 only and refuses requests addressed to any other host or sent from other sites. There is no login, so do not put it on a network.

## Tests never call a real model

`pnpm test` and `pnpm e2e` use a fake model (`NOEMA_PROVIDER=fake`) with fixed answers, and a stand-in provider for the key check, so they are free and deterministic. Markers in a question change what the fake does: `[[slow]]` streams slowly, `[[fail:rate_limit]]` (or any error kind) fails before the first token, `[[error-midway]]` drops the connection halfway. The fake never appears in the app.

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
