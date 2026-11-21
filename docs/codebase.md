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
| `scripts/asked-check.ts` | `pnpm asked:check`: replay a notebook's questions through "asked before" and print what would have been flagged |
| `scripts/pdf-check.ts` | `pnpm pdf:check <file.pdf>`: read PDFs as Noema does and print counts, or why one cannot be read |
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
| `src/gists.ts`, `src/links.ts` | Reading a room (ADR 0027): what the AI is asked for a summary and for links, its replies read and checked (quotes found in the original, numbers and kinds it knows); the kinds of link |
| `src/rooms.ts` | Rooms (ADR 0026): what a room holds (put in, and what comes with it), its clusters and the lines between them, the marks on its cards, where new clusters go, clusters set apart when they grow into each other, where the words of a link go so they cover nothing (ADR 0027 addendum); rooms in rooms: what is inside a room at any depth, `wouldLoop`, the sidebar's `roomTree` (ADR 0032) |
| `src/path.ts` | A room as a path (ADR 0035): the order to study its things (or concepts) in, from the links kept; what stands side by side; what no link orders; circles broken at their last link |
| `src/concepts.ts` | The concept-reading skill (ADR 0037): a material cut into pieces and what their hash is taken of; where a place's words are; names made plain to compare; the skill's instructions for a piece and its reply checked (quotes word for word, roles, what it is under, at most so many); the known concepts as a tree; the judge for new names; when a name is a concept and its best mention; links between concepts; levels (ADR 0038): the order step (topics, kinds and parts) and its reply checked, what a concept covers, Find materials (what goes inside, where materials discuss it), a concept's words found in a text and on which page, the learner's work on it |
| `src/files.ts` | Files of a linked folder (ADR 0025): a file's text as a source shows it (Markdown as it is, other text as a code block), a path kept inside the folder, a note as a Markdown file |
| `src/assistant.ts` | The Assistant's tools as the model is told about them (lookups, file lookups, show, the changes, file changes included), their arguments, a proposed change as shown (`AssistantAction`), the tools and limits when it acts on its own (`ACTING_TOOLS`, `WAITING_KINDS`, ADR 0033), where the learner is (`AssistantPlace`), quotes found near a label and checked (`quotesNear`, `quoteRange`), where a label points (`VaultTarget`), the lookups kept with an answer, labels in answers (`[3]`): found, put in one form, taken out of earlier answers |
| `src/pdf.ts` | A PDF's text items, page by page, as Markdown: lines, paragraphs, headings, lists, page headings; running heads dropped; where each item landed (the map from pages to text) |
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
| `src/chat/generation.ts` | Answering a question: context, the model call, streaming to watchers, saving as it goes. For the Assistant: rounds of lookups, then the answer, and the labels it cited |
| `src/chat/prompt.ts` | The system prompt |
| `src/chat/titles.ts`, `headlines.ts` | Titles for new threads, and a one-line headline for each exchange, written by the model afterwards |
| `src/chat/notes.ts` | Rewriting a thread as a note, and AI suggestions for a block |
| `src/rooms/reader.ts` | Reading a room (ADR 0027): summaries of what needs one, a few at a time, then suggested links; its threads and notes read for concepts, piece by piece, only pieces not read before, the new names judged, concepts suggested, put in order (topics, kinds, parts) and linked (ADRs 0037, 0038); Find materials for one concept; stopping a reading; the progress the room shows; the brief, with the rooms inside by their briefs (ADRs 0030, 0032) |
| `src/files/folders.ts` | Folders on the learner's computer (ADR 0025): linking, listing, every path resolved inside the folder (links leading out refused), reading a file and opening it as a source (a new version when it changed on disk), writing with a backup, undo, finding lines in files |
| `src/chat/assistant.ts` | The Assistant's instructions and its lookups over the store (`VaultLookup`): the overview sent with each question, where the learner is and what they selected, search, open, list, the files of linked folders, the labels numbered through one answer, quotes checked against the original, passages resolved for changes |
| `src/chat/actions.ts` | The changes the Assistant makes or proposes: checked and resolved when asked for (`planAction`), run at once or on Do it through the store, cancelled, undone, all of an answer at once (`AssistantActions`, ADR 0033) |
| `src/chat/asked.ts` | "Asked before" by meaning: the chat model reads the earlier questions and says whether the new one was asked |
| `src/chat/merges.ts` | Drafting what a thread merged into another carries |
| `src/llm/provider.ts` | What the server needs from a model: a stream of text (and reasoning, and the lookups it asks for), usage, a finish reason, named errors |
| `src/llm/openai-compatible.ts` | The streaming client for DeepSeek and other OpenAI-compatible providers (retries only before the first token) |
| `src/llm/settings.ts` | Which model and key; the key saved in `data/settings.json`, checked with the provider before saving |
| `src/llm/fake.ts` | The fake model used by every test |
| `src/ingest/fetch.ts` | Reading a web page by its address (arXiv from its HTML version, its PDF only when there is none; a PDF at any address) |
| `src/ingest/pdf.ts`, `pdf-worker.ts`, `no-canvas.cjs` | Reading a PDF: pdf.js in a worker thread with a time limit (on the main thread if no worker can start), loaded without its native drawing package; the file kept as base64 |
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
| `src/Sidebar.tsx`, `icons.tsx` | The rail of icons and the lists of threads, sources, notes, files and the Trash |
| `src/Files.tsx` | Files: linked folders listed like a code editor's files; the editor for a text file; saving a note into a folder (ADR 0025) |
| `src/Rooms.tsx`, `RoomView.tsx` | Rooms (ADR 0026): the list in the sidebar with what is in no room yet, the shared room actions and right-click menu; a room's map of clusters, its picker, moving clusters; Read with AI, summaries and their points on cards, links drawn card to card and their editor, Link to… (ADR 0027); rooms in rooms (ADR 0032): the sidebar tree, doors on the map, the way in, Room here; the switch between Folders, Concepts, Path and Board, remembered per room (ADR 0035) |
| `src/RoomFolders.tsx`, `folders.ts` | A room in Folders (ADR 0035), as Finder lists a folder: rooms inside and concepts as folders opening in place (topics holding concepts, concepts holding theirs, then things: ADR 0038), things as files, "also in" for a thing in other rooms, sortable columns, the preview, moving by dragging onto a folder (⌥ keeps it in both), typing to jump |
| `src/RoomPath.tsx` | A room as a path (ADR 0035): numbered steps, side by side what contrasts, what is open in each, what is not on the path yet; concept by concept when it has concepts, topic by topic when they are in topics (ADR 0038) |
| `src/RoomConcepts.tsx` | A room by its concepts (ADRs 0036 to 0038): the bar (concepts, topics, what is to review, Stop, Keep all, Read again, + Concept), what changed since they were read and Update; Find a concept; the cards topic by topic (a heading per topic that folds, lanes by what comes first, a kind or part after its concept, the lines between cards, the most worked with first and the rest folded); Review beside them (new ideas by the learner's work, places suggested, things alone); the tray of what is under none; dragging things onto concepts and cards onto concepts or topics; and the drawer: where it is in the tree and Put under…, what it covers, the learner's work, what is inside, its names, the words that define it, each material with its places (found ones to keep), the words found in sources, its links, Find materials, Link to, Merge, Split, Make it a room, Ask about it |
| `src/conceptsHere.tsx` | Concepts from a material's side (ADR 0037): "Concepts here" under a thread's, source's or note's title, each a click away from its places there; "Under a concept…" for words selected, and the list of the notebook's concepts to put them under |
| `src/roomText.ts` | Words and marks the ways to see a room share (glyphs, counts, a card's kind and marks; quoted words shown without Markdown's marks) |
| `src/ContextMenu.tsx`, `drag.ts` | The right-click menu (one for the app); dragging things onto rooms, and files and links from outside read as sources |
| `src/ThreadView.tsx` | A thread: messages, the composer, select to ask a side question, Back, split-off, delete, drafts of new threads |
| `src/Assistant.tsx` | The Assistant, floating over what is open (folded to a bar, or open on the conversation), pinned beside it, or on its own page: questions with where the learner is, answers with their lookups, cards for what they cite, the quote preview, the changes to confirm |
| `src/itemMenu.ts` | Right-click on a thread, source or note anywhere it is listed: Move to the Trash, or Delete forever… asked first in the menu (ADR 0034) |
| `src/MessageView.tsx` `WebFinds` | Pages found on the web for an answer or a room, to add as sources (ADR 0031) |
| `src/assistantFloat.ts` | The floating Assistant's window (where it is, its size, kept inside the browser) and the questions it offers for the place (ADR 0028) |
| `src/LivingFrame.tsx`, `presence.ts` | The light around the window while the Assistant is open, and its orb; what it is doing (a small store the Assistant sets) |
| `src/MessageView.tsx`, `Composer.tsx` | One question or answer (Ask again, and the ‹ 1 / 2 › switch between answers); the box to ask in |
| `src/Pinned.tsx` | The pinned passages at the top of a thread |
| `src/PdfPages.tsx`, `pdf/pdfjs.ts`, `pdf/pageImage.ts` | A PDF as its pages (pdf.js from the server, with its text layer), selection on a page to a passage of the text; drawing a page as a picture for the model |
| `src/AskedBefore.tsx`, `asked.ts` | The reminder above the box that a question was asked before; putting together what words and the model found |
| `src/ExportImport.tsx` | Export (JSON and Markdown) and import |
| `src/SourceView.tsx`, `AddSource.tsx`, `reading.ts` | The reading pane beside the thread (for a file: where it is, Edit, Make a note, Read again), adding a source, and which threads belong to which source |
| `src/NoteView.tsx`, `RefPane.tsx`, `citations.ts` | A note of blocks; a citation's exchange beside the note |
| `src/Merges.tsx` | Merging threads: the picker, the draft, the card |
| `src/MapView.tsx`, `Outline.tsx` | The map of a thread; the catalog on the right of long threads and notes |
| `src/Search.tsx`, `found.ts`, `hits.ts` | ⌘K search, arriving at a hit with its words marked, how a hit reads |
| `src/ContextView.tsx`, `sent.ts`, `AboutYou.tsx` | What was sent for an answer (each part named in `sent.ts`, the Assistant's lookups too); About you |
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
- **How a PDF becomes Markdown:** `packages/core/src/pdf.ts` (tests build pages from made-up text items); real PDFs to try are in `apps/server/test/fixtures/` (made-up decks and notes). Bump `PDF_EXTRACTOR` in `apps/server/src/ingest/pdf.ts`, and when upgrading `pdfjs-dist`, so reading a PDF again makes a new version.
