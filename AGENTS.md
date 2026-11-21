# Working in this repository

Rules for anyone changing this code, human or agent. CLAUDE.md imports this file.

## What this is

The v0.1 prototype of Noema, a local, single-user learning notebook. Product scope: PARADIGM §0 and the prototype brief in the `NoemaLearningNote` workspace (`docs/handoffs/2026-10-17-prototype-brief.md`), plus the 2026-11-04 architecture and reliability handoffs there. This repo links to those; it does not copy them.

Read first: [docs/architecture.md](docs/architecture.md) (how it works), [docs/codebase.md](docs/codebase.md) (where things are), [docs/status.md](docs/status.md) (what is built), and the newest file in `docs/handoffs/`.

## Commands

- `pnpm dev`, `pnpm test`, `pnpm e2e`, `pnpm typecheck`, `pnpm lint`, `pnpm check` (see README).
- Node runs the TypeScript directly (type stripping). There is no build step for `packages/core` or `apps/server`.

## Scope fence (prototype brief §4, binding for v0.1)

Don't build these, even where older docs describe them:

- Accounts, sync, multiple devices, a mobile layout.
- OCR of scanned PDFs, or formulas read as LaTeX. Reading a PDF's text, showing its pages and sending a picture of the page with a question are built: the founder asked for them for M6 (ADRs 0021, 0022).
- Embeddings, semantic search, concept extraction, knowledge graphs, mastery states. (Exceptions the founder made: the chat model judges whether a question was asked before, ADR 0020; the Assistant looks things up across the notebook over keyword search, ADR 0023, and proposes changes the learner confirms one by one, ADR 0024, and since ADR 0033 makes them itself, in rounds, each with Undo (files on the computer still confirmed; "Asks first" puts it back); rooms, which set threads, sources and notes together by subject, ADR 0026; reading a room, where the AI summarizes what is in it (each point linked to the words it quotes) and suggests links between things that the learner keeps, changes or dismisses, ADR 0027; links drawn by the learner whose meaning the AI chooses, and the Assistant's power over rooms and links (each still confirmed), ADR 0029; a room's brief (what it adds up to, what is still open), sent with the questions of threads in it, ADR 0030; searching the web when asking in a room (DeepSeek's search, with the room's web on) and offering pages to add as sources, never added on their own, ADR 0031; rooms inside rooms, as doors (many homes, never inside itself), a bigger room's brief written from theirs, ADR 0032; ways to see a room (Folders like Finder, a Path from the links kept, the Board), ADR 0035; concepts, the key ideas of a room that the AI suggests when it is read (each a small room inside it, defined by the words of one of its things, linked by what builds on what), kept or dismissed by the learner, ADR 0036; since ADR 0037 read from every piece of every material with the concept-reading skill, joined across the notebook (one concept in every room whose materials discuss it), and read again only where a piece's hash changed; since ADR 0038 read from threads and notes only (sources searched for their words, no call), in levels (topics, concepts inside concepts: a tree of one room's concepts, not a graph of the notebook) shown as cards topic by topic, and filled for a concept the learner makes (what it covers, what goes inside, where the materials discuss it), each suggestion kept by the learner. Its memory, background jobs and noticing things on its own, and rooms (other than concepts) suggested by the AI, are later steps he decides.)
- Understanding-record forms, quizzes, return lines, checkout, task limits or timers.
- Plugins, animation, the step language. (The Assistant's light around the window and its orb are the founder's decision, ADR 0023; so is its window floating over what is open, with its glow and a short rise as it opens, ADR 0028.)
- Imports from Obsidian or ChatGPT. (Linking a folder on this computer, reading and editing its files as sources, making a note from a file and saving a note into the folder are the founder's decision, ADR 0025; that is not an Obsidian import.)
- Collaboration.

Anything outside the fence goes into `ideas.md`, not into code.

## Architecture rules

- `packages/core` is pure: no I/O, no Node or DOM APIs beyond `crypto.getRandomValues`. Anything that must never be wrong (ids, anchors, context assembly, the contract) lives here with tests.
- The server owns model calls and streams. The browser only watches. Every watcher connection starts with a snapshot, then deltas.
- All SQL is in `apps/server/src/store/`. Schema changes are new numbered files in `store/migrations/`; never edit an applied migration.
- A message revision's text is immutable once its status is terminal. Anchors point into revisions. Regenerate makes a new revision; it never edits one.
- Anchors are UTF-16 offsets into the raw Markdown of one revision, plus quote, prefix and suffix (W3C selectors). An anchor that cannot be found is shown as unresolved. Never jump silently to a near match.
- Validate with Zod at every boundary: HTTP bodies, responses in the client, `.env`.
- Errors that reach the learner have a kind from `ErrorKind` and a plain sentence from `describeError`. No stack traces in the UI.
- Never render model output as raw HTML. KaTeX (with `trust: false`) is the only injected HTML.
- Never log message content or API keys.
- The API key lives in `data/settings.json` (mode 0600) or `.env`. Never write it to the database, an export, a log or a response to the browser.
- The server binds to loopback only and checks Host, Origin and the `x-noema-client` header. Keep it that way.

## Tests

- Every behaviour change comes with a test. Every bug fix starts with a failing test.
- Tests and CI use the fake provider. Never call a real model in tests or CI.
- Prefer tests over real HTTP and a real SQLite file to mocks.

## Workflow

- **Branches.** Several people and agents work at once ([CONTRIBUTING.md, Branches and merges](CONTRIBUTING.md#branches-and-merges); ADR 0039).
  - Never commit to `main`.
  - Work on a branch from an up-to-date `main`, named `area/what-it-does` (for example `rooms/one-review`, `fix/drawer-under-header`), one piece of work per branch.
  - Write the acceptance tests first.
  - To catch up with `main`, merge it in. Once a branch is pushed, don't rebase it.
  - Never force-push a branch someone else has, or `main`.
- **Merging.** Everything reaches `main` by pull request with green CI. The founder reviews and merges, with a merge commit: no squash or rebase, so cited hashes stay true. The founder's approval is needed for:
  - the scope fence;
  - a new ADR;
  - a migration;
  - `contract.ts`;
  - this file.
- **Numbered files.** ADRs and migrations take the next free number. If `main` takes it first, renumber yours before the merge. Never edit a migration that is on `main`. Try a branch with a migration on a copy of your notebook (`NOEMA_DB_PATH`), never `data/noema.db`.
- **Decisions.** Record engineering decisions in `docs/adr/`: one page with the context, the decision, the consequences and how to reverse it.
- **Handoffs.** End every working session with a handoff in `docs/handoffs/YYYY-MM-DD-area-topic.md`: what changed, what was verified and how, what wasn't, what's next.
- **Docs.** Keep `docs/status.md` current when a milestone moves, and `docs/codebase.md` when files are added or move. Change only the lines about your work.
- **Commits and pushes.** Commit in small steps with conventional messages. Push your own branch as you like. An AI agent pushes or opens a pull request only when the person running it asks, and never merges.
- **The push log.** Only the founder logs in `docs/push-log.md`: each merge into `main` and each push of `main`, with what was pushed, the checks before it, how it was pushed, and the result.
