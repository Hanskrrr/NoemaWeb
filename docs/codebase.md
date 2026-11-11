# The codebase, folder by folder

Where things are and what each file does. How they fit together is in [architecture.md](architecture.md). Every source file starts with a comment saying what it is for; this page is the index to them.

## Top level

| Path | What it is |
| --- | --- |
| `README.md` | What Noema is, how to run it, where your data lives |
| `CONTRIBUTING.md` | Setting up, the workflow, and how the docs folders work |
| `AGENTS.md` | Rules for anyone changing the code, people and AI agents alike: scope fence, architecture rules, tests, workflow. `CLAUDE.md` imports it for Claude |
| `ideas.md` | Ideas outside the v0.1 scope fence, kept for later instead of built |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | A pnpm workspace: `packages/core`, `apps/server`, `apps/web` |
| `tsconfig.base.json`, `tsconfig.json` | Shared strict TypeScript settings; the root project type-checks `scripts/` and `e2e/` |
| `biome.json` | Lint and format rules (Biome) |
| `.env.example` | Optional settings; the app works without a `.env` |
| `.github/workflows/ci.yml` | CI on pull requests and `main`: typecheck, lint, test, e2e on Node 22 and 24 |
| `scripts/dev.ts` | `pnpm dev`: the server (restarting on change) and Vite, together |
| `data/` | **Not in git.** The notebook (`noema.db`), daily backups and the model key (`settings.json`) |

## `packages/core`: shared, pure, tested

Imported by both the server and the web app. No I/O.

| File | What it does |
| --- | --- |
| `src/contract.ts` | The HTTP API as Zod schemas: every request and response body. Change the API here first |
| `src/ids.ts` | ULIDs (sortable ids), made on whichever side creates the thing |
| `src/anchor.ts` | Passages: create an anchor from offsets, resolve it in a revision (position, then quote, else unresolved) |
| `src/context.ts` | What goes to the model and in what order (with pinned passages); the manifest; `describeSent` splits what was sent into named parts |
| `src/asked.ts` | "Asked before": whether a question being written repeats an earlier exchange, by its subject words |
| `src/readable.ts` | A notebook as one Markdown file, for reading (the Markdown export) |
| `src/blocks.ts` | Splitting a note's Markdown into blocks |
| `src/cite.ts` | `[E3]` citation labels in notes |
| `src/search.ts` | Search text for FTS5 (Chinese and Japanese as characters and pairs), queries and snippets |
| `src/html.ts` | A web page as Markdown: the article only, with math, footnotes, tables and code |
| `src/sources.ts` | A source's blocks and headings, and the section around a passage |
| `src/state.ts` | The states of an answer (`pending`, `streaming`, `done`, `failed`, `stopped`, `interrupted`) |
| `src/errors.ts` | Error kinds and the plain sentence the UI shows for each |
| `test/` | `node:test` tests for all of the above, with HTML fixtures |

## `apps/server`: the local server

| Path | What it does |
| --- | --- |
| `src/main.ts` | Entry point: reads config, opens and migrates the store, recovers anything interrupted, starts the server |
| `src/config.ts` | `NOEMA_*` settings from the environment, validated; refuses a non-loopback host |
| `src/app.ts` | Every route, wired to the store, the model and the jobs. Start here to find what an endpoint does |
| `src/http/router.ts`, `guard.ts`, `sse.ts`, `static.ts` | A small router; the Host/Origin/header guard; server-sent events; serving the built web app |
| `src/store/db.ts` | `node:sqlite` with WAL, foreign keys and migrations |
| `src/store/migrations/NNN_*.sql` | The schema, one numbered file per change; each starts with a comment saying why |
| `src/store/repo.ts` | **All SQL.** Threads, messages and their revisions, anchors, pins, notes, merges, sources, search, the Trash, export and import |
| `src/chat/generation.ts` | Answering a question: context, the model call, streaming to watchers, saving as it goes |
| `src/chat/prompt.ts` | The system prompt |
| `src/chat/titles.ts`, `headlines.ts` | Titles for new threads, and a one-line headline for each exchange, written by the model afterwards |
| `src/chat/notes.ts` | Rewriting a thread as a note, and AI suggestions for a block |
| `src/chat/merges.ts` | Drafting what a thread merged into another carries |
| `src/llm/provider.ts` | What the server needs from a model: a stream of text, usage, a finish reason, named errors |
| `src/llm/openai-compatible.ts` | The streaming client for DeepSeek and other OpenAI-compatible providers (retries only before the first token) |
| `src/llm/settings.ts` | Which model and key; the key saved in `data/settings.json`, checked with the provider before saving |
| `src/llm/fake.ts` | The fake model used by every test |
| `src/ingest/fetch.ts` | Reading a web page by its address (arXiv from its HTML version; PDFs refused with a reason) |
| `src/log.ts` | One JSON line per event on stdout; never message text or keys |
| `test/` | Tests over real HTTP and SQLite, one file per area (`chat`, `branches`, `notebook`, `sources`, `search`, `trash`, …) |

## `apps/web`: the app in the browser

React 19 and Vite, no router or state library. One stylesheet with light and dark tokens.

| File | What it does |
| --- | --- |
| `src/main.tsx`, `App.tsx` | Start-up, the connect screen, the header, which view fills the page, and the dialogs |
| `src/route.ts` | Where the learner is, in the URL hash (`#/t/<thread>`, `#/note/<id>`, `#/s/<source>`, …), so reload and Back work |
| `src/api.ts` | The only place that talks to the server; every response is checked against the contract |
| `src/storage.ts` | `localStorage` for small conveniences: drafts, the last place, folded lists |
| `src/Sidebar.tsx`, `icons.tsx` | The rail of icons and the lists of threads, sources, notes and the Trash |
| `src/ThreadView.tsx` | A thread: messages, the composer, select to ask a side question, Back, split-off, delete, drafts of new threads |
| `src/MessageView.tsx`, `Composer.tsx` | One question or answer (Ask again, and the ‹ 1 / 2 › switch between answers); the box to ask in |
| `src/Pinned.tsx` | The pinned passages at the top of a thread |
| `src/AskedBefore.tsx` | The reminder above the box that a question was asked before |
| `src/ExportImport.tsx` | Export (JSON and Markdown) and import |
| `src/SourceView.tsx`, `AddSource.tsx`, `reading.ts` | The reading pane beside the thread, adding a source, and which threads belong to which source |
| `src/NoteView.tsx`, `RefPane.tsx`, `citations.ts` | A note of blocks; a citation's exchange beside the note |
| `src/Merges.tsx` | Merging threads: the picker, the draft, the card |
| `src/MapView.tsx`, `Outline.tsx` | The map of a thread; the catalog on the right of long threads and notes |
| `src/Search.tsx`, `found.ts`, `hits.ts` | ⌘K search, arriving at a hit with its words marked, how a hit reads |
| `src/ContextView.tsx`, `AboutYou.tsx` | What was sent for an answer; About you |
| `src/ModelSettings.tsx` | Connecting a model |
| `src/EditableTitle.tsx` | Renaming in place |
| `src/markdown/` | Rendering Markdown with offsets on every character (`parse.ts`, `Markdown.tsx`) and turning a selection into offsets and back (`selection.ts`) |
| `src/styles.css` | All styles |
| `test/` | `node:test` tests for the pure modules (routes, Markdown offsets, search hits, reading, citations) |

## `e2e`: the app end to end

Playwright specs against the real server and the built app, with the fake model. `playwright.config.ts` starts the servers (one with the fake model, one with no model for the first run, and an empty one to import into; `ports.ts`); `helpers.ts` has shared steps (ask and wait for the answer, select a word, show a sidebar list). One spec per area. The brief's acceptance tests have "acceptance" in their names (`find.spec.ts`, `sources.spec.ts`; M5's are in `apps/server/test/context-view.test.ts` and `export-import.test.ts`), except the detour test, which is `branch.spec.ts`.

## `docs`

| Path | What it is |
| --- | --- |
| `architecture.md` | How it works |
| `codebase.md` | This page |
| `status.md` | What is built, milestone by milestone, and what is next |
| `adr/NNNN-*.md` | Decision records: one page per engineering decision, numbered in order (context, decision, consequences, how to reverse). Read the ones for an area before changing it |
| `handoffs/YYYY-MM-DD-topic.md` | One note per working session: what changed, what was verified and how, what was not, what is next. The newest is where to pick up |
| `push-log.md` | How each push to GitHub was made |

## Where to make common changes

- **A new API endpoint:** the request and response schemas in `packages/core/src/contract.ts` → the route in `apps/server/src/app.ts` → any SQL in `store/repo.ts` → a test in `apps/server/test/` → the call in `apps/web/src/api.ts`.
- **A schema change:** a new `apps/server/src/store/migrations/NNN_name.sql` (never edit an applied one) → `repo.ts` → a test that an older database upgrades in place.
- **What the model is sent:** `packages/core/src/context.ts` (with tests in `packages/core/test/`), called from `apps/server/src/chat/generation.ts`.
- **A new view or route:** `apps/web/src/route.ts` (with its test) → a component → `App.tsx` → an e2e spec.
- **How a web page becomes Markdown:** `packages/core/src/html.ts` with a fixture in `packages/core/test/fixtures/`; bump `EXTRACTOR` in `apps/server/src/ingest/fetch.ts` so reading a page again makes a new version.
