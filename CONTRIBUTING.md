# Contributing

Thanks for working on Noema. Start with these, in order:

1. [README.md](README.md): what it is and how to run it.
2. [docs/architecture.md](docs/architecture.md): how it works.
3. [docs/codebase.md](docs/codebase.md): where everything is.
4. [docs/status.md](docs/status.md): what is built and what is next.
5. The newest note in [docs/handoffs/](docs/handoffs/): where the last session stopped.
6. [AGENTS.md](AGENTS.md): the rules. They bind people and AI agents alike.

## Set up

```sh
pnpm install
pnpm dev          # http://127.0.0.1:5173
pnpm check        # typecheck, lint and unit tests
pnpm exec playwright install chromium   # once, for the end-to-end tests
pnpm e2e          # the app end to end, with the fake model
```

You need Node 22.18 or newer and pnpm 10. You do not need a model key to work on the code: tests use a fake model. To try the app for real, connect any OpenAI-compatible provider from the first screen.

Your notebook is `data/noema.db`, which git ignores. Never commit anything from `data/`, a `.env`, or real conversations; tests and fixtures use made-up text.

## How work is done here

- **Branches.** One milestone (or one feature) per branch, merged into `main` by pull request once its tests pass. Write the acceptance test first.
- **Commits.** Small, with conventional messages (`feat(web): …`, `fix(core): …`, `docs: …`).
- **Tests.** Every behaviour change comes with a test; every bug fix starts with a failing one. Unit and integration tests go next to the package (`*/test/`), end-to-end ones in `e2e/`. Never call a real model in a test.
- **Decisions.** A decision someone will later wonder about gets a one-page record in `docs/adr/`, numbered after the last one: context, decision, consequences, how to reverse it.
- **Handoffs.** Each working session ends with a note in `docs/handoffs/YYYY-MM-DD-topic.md`: what changed, what was verified and how, what was not, what is next. Say plainly what you could not check.
- **Status.** When a milestone moves, update `docs/status.md`.
- **Pushing.** Push and open pull requests only when the founder asks, and log each push in `docs/push-log.md`.
- **Scope.** Anything outside the scope fence in AGENTS.md goes into `ideas.md`, not into code.

## Before you open a pull request

- `pnpm check` and `pnpm e2e` pass.
- New behaviour has tests; a new decision has an ADR; the session has a handoff.
- No private data: nothing from `data/`, no keys, no real notebook content in code, tests or docs.
