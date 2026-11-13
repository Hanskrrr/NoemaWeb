# How Noema works

A guide for anyone joining the project: what the pieces are, how a question travels through them, and the few ideas the rest of the code depends on. For where each file is, see [codebase.md](codebase.md); for what is built so far, [status.md](status.md); for the rules of working here, [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

## The product in a few lines

Noema is a notebook for studying hard material (a paper, a course) with an AI. What it adds to a chat:

- **Detours with a way back.** Select any passage of an answer or of what you are reading, ask a side question about it, and come back to that exact passage. Side questions can become threads of their own, be merged back, or be cut off at a question.
- **Sources beside the conversation.** A web page, an arXiv paper or pasted text sits in a reading pane; questions are tied to the passage they were asked about, in the version that was shown.
- **Finding things again.** Search lands on the exact message, note block or passage; a map of each thread; side questions you never came back from; and a reminder, before a new thread or side question is made, that the question was asked before.
- **Notes from conversations.** A thread rewritten as a study note, made of blocks you edit, whose citations open the exchange they came from.
- **Context you can see.** Under any answer, exactly what the AI was sent. Passages pinned to a thread go with every question in it. Ask again for another answer; the first is kept.
- **Your data, as files.** Export everything as JSON (it imports back into an empty Noema) or as Markdown to read.

It is a **local, single-user prototype**: one person, one computer, their own model key. The product thinking behind it (PARADIGM, interviews, the prototype brief) lives in the founder's `NoemaLearningNote` workspace; ask him for access. The scope fence in AGENTS.md lists what v0.1 deliberately leaves out.

Principles the code keeps, from that thinking:

1. **Nothing the learner did is lost.** The question is saved before the model is called; answers are saved as they stream; a crash leaves an "interrupted" answer, never a missing one.
2. **Anchors are exact or say they are not.** A passage points into one immutable text. If it cannot be found, it is shown as unresolved, never moved silently to a near match.
3. **AI and learner authorship stay distinguishable**, and the AI never changes the learner's text by itself: it suggests, the learner accepts.
4. **No judgements of the learner.** Nothing infers mastery or labels the learner from what they did.

## The pieces

```
 browser tab           this computer only (127.0.0.1)                model provider
┌─────────────┐  HTTP  ┌───────────────────────────────┐   HTTPS   ┌─────────────────┐
│ apps/web    │ ─────▶ │ apps/server                   │ ────────▶ │ DeepSeek, or    │
│ React app   │ ◀───── │ routes, generation, jobs      │ ◀──────── │ any OpenAI-     │
│             │  SSE   │ store: data/noema.db (SQLite) │ streaming │ compatible API  │
└─────────────┘        └───────────────────────────────┘           └─────────────────┘
       └── both import packages/core: ids, anchors, context, the API contract ──┘
```

- **`packages/core`** is pure TypeScript: no I/O, no Node or DOM APIs. Anything that must never be wrong lives here with tests: ids, anchors, context assembly, the HTTP contract, HTML-to-Markdown, search text.
- **`apps/server`** owns everything stateful: the SQLite store, calls to the model, streams. It uses Node's built-ins (`node:http`, `node:sqlite`, `node:test`) and runs TypeScript directly with Node's type stripping, so there is no build step.
- **`apps/web`** is a Vite + React app. It never talks to the model; it sends requests, watches streams and renders. In production the server serves its built files.

The server binds to loopback only and checks Host, Origin and a custom `x-noema-client` header on every state-changing request, because there is no login (`apps/server/src/http/guard.ts`). The model key lives in `data/settings.json` (mode 0600) or `.env`, never in the database, logs, exports or responses.

## Life of a question

1. **The tab sends it with ids it made.** `POST /api/threads/:id/messages` with a ULID for the question, generated in the browser. Sending the same request again returns the same question, so a retry after a lost reply never duplicates it.
2. **The server saves it first.** `repo.createAsk` writes the question and an empty answer (status `pending`) in one transaction, then returns both. Only then is the model called.
3. **The server assembles the context** (`packages/core/src/context.ts`): the system prompt, About you, the section of the source being read (if any), the passages pinned to the thread (and to the threads it is a side question of), the conversation the thread inherits from the thread it came from, the thread's own turns, then the question with the passage it is about. Stable parts come first so the provider's prompt cache keeps hitting; when the budget is tight, the oldest turns are dropped first. A **manifest** of what went in, and the exact messages, are stored with the model call (`model_call`), and are what "What was sent" shows.
4. **The answer streams on the server** (`apps/server/src/chat/generation.ts`). Text is flushed to SQLite every 200 ms. The provider client retries only before the first token; after that a failure is final and the partial text is kept (ADR 0003).
5. **The tab watches.** `GET /api/messages/:id/events` is a server-sent-events stream: first a snapshot of everything so far, then deltas, status changes and the end. Closing or reloading the tab stops nothing; reopening gets the snapshot again.
6. **Afterwards, small jobs.** The model writes a title for a new thread and a one-line headline for the exchange (used on the map, the catalog and in search). The search index is updated. An append-only `event` table records what the learner did (a branch returned from, a search opened), for the measures in the brief.
7. **On restart**, anything still generating is marked `interrupted`; nothing is replayed silently.

## Ideas the code depends on

**Immutable revisions.** A message's text is a revision; once finished, it never changes. **Ask again** makes a new revision of an answer and makes it the one in use (shown first, searched, sent with later questions); the learner can choose another (ADR 0017). A source's text is a version; reading the page again makes a new version only if the text changed. Everything that points at text (side questions, pins) points at one revision or version.

**Anchors** (`packages/core/src/anchor.ts`). A passage is stored the W3C way: the exact quote with some text before and after, plus UTF-16 offsets into the raw Markdown of that revision. To draw it, the stored position is used if the text there still matches, else the quote if it occurs once; otherwise it is unresolved.

**Offset-preserving Markdown** (`apps/web/src/markdown/`). Answers and sources are rendered as React elements (never raw HTML; KaTeX with `trust: false` is the only injected HTML), and every rendered character carries `data-s`/`data-e` offsets back into the raw Markdown. That is how a selection on the screen becomes an anchor, and an anchor becomes a highlight (the CSS Custom Highlight API).

**Threads and their families.** A thread can be:
- a **side question** (branch) of another thread, asked from a passage (`parent_thread_id`, `origin_anchor_id`), which inherits the conversation up to that passage;
- a side question **made its own thread** (`split_at`);
- **split off** from another at one of its questions (`continued_from`), taking the questions from there on;
- **asked about a source passage** (`source_anchor_id`).
Merging one thread into another adds a card and a summary the learner accepted; nothing already said is rewritten (ADR 0008). Deleting puts things in the Trash (`deleted_at`), with Restore (ADR 0012).

**Notes** are lists of blocks (one paragraph, heading, list, table, code or math block each), with a revision history. The AI writes a note from a thread, or suggests a change to a block, which the learner accepts or discards. Citations are plain labels in the text (`[E3]`) mapped to exact messages (ADR 0006, 0007, 0011).

**Sources** (ADR 0013). A page is fetched by the server (a browser could not, because of CORS), turned into Markdown by our own converter (`packages/core/src/html.ts`, which keeps math, footnotes and tables), and stored with the original HTML. arXiv links are read from arXiv's HTML version. A PDF (a file, or at an address) is read by pdf.js in a worker thread on the server; core's `pdf.ts` turns each page's text items into Markdown with a `## Page N` heading per page, and the file is kept with the version so it can be opened at a page in the browser's own viewer (ADR 0021). The reading pane shows a PDF as its pages: pdf.js, loaded from the server's copy, draws them in the browser with its text layer; the browser reads the same text items and maps a selection on a page to the stored text through core's item map. A question about a PDF passage goes with a picture of its page, drawn by the browser and kept on the server, and referred to in the stored request (ADR 0022).

**The Assistant** (ADR 0023). One thread per notebook of its own kind (`thread.kind = 'assistant'`), at the top of the sidebar, that answers from the whole notebook. It is not sent everything: each question carries a short labelled overview of the notebook, and the model looks the rest up with three read-only tools (`search`, `open`, `list`; `apps/server/src/chat/assistant.ts`). An answer goes in rounds (at most six, four lookups a round); each round is a model call of its own, and the last one's request, kept for What was sent, holds every lookup and what came back. Everything it is shown carries a label (`[3]`), numbered through the answer; the labels it cites are kept with the revision (`message_revision.lookups`) and become buttons that open the message, passage or note. While it works, the stream also says what it is doing (`phase`) and each lookup (`step`); the browser shows them under the answer and as a light around the window (`LivingFrame.tsx`). DeepSeek's reasoning before a lookup is sent back in the next round, as DeepSeek requires; a model that refuses lookups while thinking is asked without thinking, and one that refuses lookups answers from the overview.

**Search** (`packages/core/src/search.ts`, `store/repo.ts`). One SQLite FTS5 table over titles, messages, headlines, note blocks and source passages. Chinese and Japanese are indexed as single characters and overlapping pairs, so a two-character word matches inside a longer one. The index has a version; when it changes, it is rebuilt at start-up.

## The database

One SQLite file, `data/noema.db`, in WAL mode, with numbered migrations in `apps/server/src/store/migrations/` (the version is in `PRAGMA user_version`; never edit an applied migration, add a new one). A copy goes to `data/backups/` once a day. The JSON export is every table but `search` and `meta`, and imports into an empty store of the same version (ADR 0018).

| Table | What it holds |
| --- | --- |
| `notebook` | The notebook: title and About you |
| `thread` | Threads, with how each came to be (branch, own thread, split-off, source passage), title and where it came from, Trash; `kind` is `assistant` for the notebook's one Assistant |
| `message`, `message_revision` | Questions and answers; each answer's text, status, model and headline, per revision; an Assistant answer's lookups and where its labels point |
| `anchor` | A passage of a message revision that a side question was asked about, or that was pinned |
| `pin` | A passage pinned to a thread: of a message (through `anchor`) or of a source (through `source_anchor`) |
| `model_call` | Each call to the model: provider, model, timings, token counts, the manifest and the exact messages sent |
| `note`, `note_block`, `note_revision` | Notes, their blocks, and every saved version |
| `thread_merge` | Merges between threads: draft, accepted text, state |
| `source`, `source_version`, `source_anchor` | What the learner reads, its immutable versions with the original HTML, and passages asked about |
| `search` | The FTS5 index |
| `event` | An append-only log of what the learner did |
| `meta` | Facts about the store itself, such as the search index version |

## Tests

- **`pnpm test`** runs `node --test` over core, the server (real HTTP and a real SQLite file or in-memory store, no mocks) and the web app's pure modules.
- **`pnpm e2e`** builds the web app, starts the real server with a **fake model** (fixed answers, `apps/server/src/llm/fake.ts`) and a stand-in provider, and drives Chromium with Playwright. Markers in a question change what the fake does (`[[slow]]`, `[[fail:rate_limit]]`, `[[error-midway]]`).
- No test or CI run ever calls a real model.
