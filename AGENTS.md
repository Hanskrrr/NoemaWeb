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
- Embeddings, semantic search, concept extraction, knowledge graphs, mastery states. (Exceptions the founder made: the chat model judges whether a question was asked before, ADR 0020; the Assistant looks things up across the notebook over keyword search, ADR 0023, and proposes changes the learner confirms one by one, ADR 0024; rooms, which set threads, sources and notes together by subject and draw lines only from links that happened, ADR 0026. Its memory, background jobs and noticing things on its own, and links or rooms suggested by the AI, are later steps he decides.)
- Understanding-record forms, quizzes, return lines, checkout, task limits or timers.
- Plugins, animation, the step language. (The Assistant's light around the window and its orb are the founder's decision, ADR 0023.)
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

- One milestone per branch, merged when its acceptance tests pass. Write the acceptance tests first.
- Record engineering decisions in `docs/adr/` (one page: context, decision, consequences, how to reverse).
- End every working session with a handoff in `docs/handoffs/YYYY-MM-DD-topic.md`: what changed, what was verified and how, what wasn't, what's next.
- Keep `docs/status.md` current when a milestone moves, and `docs/codebase.md` when files are added or move.
- Commit in small steps with conventional messages. Push and open pull requests only when the founder asks.
- Log every push in `docs/push-log.md`: what was pushed, the checks before it, how it was pushed, and the result.
