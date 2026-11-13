# Noema

A learning notebook for studying hard material with an AI, on your own computer.

- Ask in a normal chat. Ask a side question about any passage, and come back to exactly where you were.
- Read a web page, an arXiv paper, a PDF or pasted text beside the conversation, and ask about any passage of it.
- Link a folder on your computer and open its files (notes, slides, code) as you would in a code editor: ask about them, edit them, make notes from them and save notes into the folder.
- Find any question, answer, note or passage again with ⌘K, or ask the Assistant: one assistant for the whole notebook that looks things up before it answers and shows where it found them.
- Turn a thread into a study note you edit block by block; its citations open the exchange they came from.
- Keep what you learn about one subject together in a room: the sources, the threads asked about them and the notes, as a map that shows where you asked most and what you left open. Drag things in, or right-click.
- See exactly what the AI was sent for any answer, tell it about yourself once, pin the passages it should keep in view, and ask again for another answer without losing the first.
- Everything stays in one file on your computer, and nothing is lost when a tab closes or the server restarts.

This is a working prototype, built by a small team.

## Working on Noema

- [docs/architecture.md](docs/architecture.md): how it works, and the ideas the code depends on.
- [docs/codebase.md](docs/codebase.md): what every folder and file is for, and where to make common changes.
- [docs/status.md](docs/status.md): what is built so far, what is missing, what is next.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md): how work is done here, and the rules.

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
- **Export** in the header downloads a copy of everything as JSON, which imports into an empty Noema and gives the same notebook back, or a Markdown file to read anywhere.
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
docs              how it works, the codebase, status, decisions (adr/) and session notes (handoffs/)
```

Folder by folder: [docs/codebase.md](docs/codebase.md).
