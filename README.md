# Noema

A learning notebook for studying hard material with an AI. Ask in a normal chat; branch a side question from the exact passage that raised it; come back to exactly where you were; find any exchange again days later. Nothing is lost when a tab closes or the server restarts.

This repository is the working prototype (v0.1). The product thinking (PARADIGM, interviews, the prototype brief) lives in the `NoemaLearningNote` workspace, not here.

**Status: M3 (sources) and M4 (find again) done; M5 (context you can see, export) next.** Add something to read, a web page (an arXiv paper is read from its HTML version) or pasted text, and it opens in a reading pane with the conversation beside it: select a passage to ask about it, and Back returns to that passage in the text. Passages you asked about are marked in the text and the margin, darker where you asked more; a page read again keeps what you asked with the version you asked it about. Threads in a sidebar with titles the model writes and you can change; ask about any selected passage in a side branch that keeps its exact origin, go Back to that passage, make the branch its own thread, or merge what it found back in (nothing already said is rewritten). A thread that drifted can be cut at a question into a new thread of its own, and joined back. Search everything with ⌘K: questions, answers, side questions, notes and sources, in English or Chinese; a hit opens the exact message, note block or passage with the words marked. Noema reopens where you were and names the side questions you never came back from. Every thread has a Map of what you went through, each exchange labelled by what it established, and long threads and notes a catalog on the right; both jump to the exact spot. The sidebar shows one list at a time, threads, sources or notes, picked on a rail of icons, and follows what is open; side questions sit under their thread and fold away, and threads that became their own are listed right after the one they came from. Deleted threads, notes and sources go to the Trash, with Undo and Restore. Rewrite a thread as a study note made of blocks you edit in place, one paragraph, heading or list each: write or ask the AI anywhere (a sentence or a whole section), accept or discard its suggestions, split a note in two or merge two; citations open the exchanges they came from. Answers stream and survive reloads and crashes, with tables, math and code; the model is connected with your own key. See [the latest handoff](docs/handoffs/2026-11-06-sidebar-rail.md).

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
