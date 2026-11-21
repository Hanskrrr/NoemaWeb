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

- **Branches.** One piece of work per branch, from `main`, merged back by pull request. See [Branches and merges](#branches-and-merges) below. Write the acceptance test first.
- **Commits.** Small, with conventional messages (`feat(web): …`, `fix(core): …`, `docs: …`).
- **Tests.** Every behaviour change comes with a test; every bug fix starts with a failing one. Unit and integration tests go next to the package (`*/test/`), end-to-end ones in `e2e/`. Never call a real model in a test.
- **Decisions.** A decision someone will later wonder about gets a one-page record in `docs/adr/`, numbered after the last one: context, decision, consequences, how to reverse it.
- **Handoffs.** Each working session ends with a note in `docs/handoffs/YYYY-MM-DD-topic.md`: what changed, what was verified and how, what was not, what is next. Say plainly what you could not check.
- **Status.** When a milestone moves, update `docs/status.md`.
- **Pushing.** Push your own branch whenever you like. Only the founder merges into `main` and pushes it, and logs that in `docs/push-log.md`.
- **Scope.** Anything outside the scope fence in AGENTS.md goes into `ideas.md`, not into code.

## Branches and merges

Several people, and their AI agents, work on Noema at once. These rules keep `main` working and keep two people from undoing each other's work. The reasons are in [ADR 0039](docs/adr/0039-branches-and-merges.md).

> **For now.** The work of November is still on `notebook-features`, not yet merged into `main`. Until the founder merges it, start from `notebook-features` and open pull requests against it. This note goes when the merge is done.

### Start from `main`

- `main` is the one branch everyone starts from. It always passes CI, and nobody commits to it directly.
- Before you start, say what you are taking, so two people don't do the same thing. Either open a draft pull request with a title, or take an issue.
- Make a branch from an up-to-date `main`:

  ```sh
  git switch main && git pull
  git switch -c rooms/one-review
  ```

- **Name a branch `area/what-it-does`**, in lowercase with hyphens. The areas are:
  - `rooms`, `concepts`, `assistant`, `memory`, `threads`, `notes`, `sources`, `files`, `search` (the parts of the app);
  - `look` (styles), `infra` (build, CI, tooling), `quality` (AI checks), `docs`;
  - `fix` (a bug anywhere).

  Examples: `assistant/sees-concepts`, `fix/drawer-under-header`.
- **One piece of work per branch**, small enough to review in one sitting. A big feature becomes several pull requests, each one working on its own.

### While you work

- Commit in small steps, with conventional messages.
- Push your branch as often as you like: `git push -u origin rooms/one-review`.
- **Keep up with `main`.** When `main` moves, merge it into your branch (`git fetch && git merge origin/main`) and run the tests again.
  - Before your branch is pushed for the first time, you may rebase instead.
  - Once anyone else may have it, don't rebase it.
- **Never force-push** a branch someone else works on. Never force-push `main`.
- **Try a branch on a copy of your notebook**, never on `data/noema.db`, if it adds a migration. A migration your notebook ran that `main` never got would leave the notebook out of step with `main`.

  ```sh
  cp data/noema.db data/branch.db
  NOEMA_DB_PATH=data/branch.db pnpm dev
  ```

### Open a pull request

- Open it against `main`, as a draft while you are still working. Mark it ready when it is done.
- Fill in the template:
  - what changed and why;
  - how it was checked;
  - screenshots for anything you can see;
  - the ADR and handoff, if any;
  - what you could not check.
- Before marking it ready:
  - `pnpm check` and `pnpm e2e` pass, and CI is green;
  - new behaviour has tests, a new decision has an ADR, and the session has a handoff;
  - no private data: nothing from `data/`, no keys, no real notebook content in code, tests or docs.

### Review and merge

- **The founder reviews and merges.** Changes an AI agent made are reviewed first by the person who ran it, before the pull request is marked ready.
- **These need the founder's approval** even when someone else reviews:
  - anything that moves the scope fence;
  - a new ADR;
  - a migration;
  - a change to `packages/core/src/contract.ts`;
  - a change to `AGENTS.md`.
- **Merge with "Create a merge commit"**, not squash or rebase. That way, the commit hashes cited in handoffs and ADRs stay true on `main`.
- **Conflicts are the branch owner's to resolve.** Merge `main` into the branch, fix the conflicts, and run the checks again.
- After the merge, delete the branch. The next piece of work starts from `main` again.
- A change that moves many files (splitting a large file, a rename) is announced first, kept short and merged quickly. Others merge `main` into their branches right after.

### Files that many people change

Some files are numbered, and two branches can take the same number. Others are edited by almost everyone. The rules for each:

| File | Rule |
| --- | --- |
| `docs/adr/NNNN-*.md` | Take the next free number, and put it in the pull request's title. If `main` takes that number first, renumber yours before the merge: the file, its title and every reference to it. |
| `apps/server/src/store/migrations/NNN_*.sql` | The same: the next free number, and renumber yours if `main` takes it first. Never edit a migration that is on `main`. |
| `docs/status.md`, `docs/codebase.md` | Change only the lines about your work. In a conflict, keep both sides' facts. |
| `docs/handoffs/` | One file a session, named `YYYY-MM-DD-area-topic.md`, so two people never pick the same name. |
| `docs/push-log.md` | Only the founder writes it: each merge into `main`, and each push of `main`. |
| `AGENTS.md`, `CONTRIBUTING.md` | Changed by pull request, with the founder's approval. |

### When `main` breaks

The first thing is to fix it, before anything else is merged. Either open a `fix/…` pull request, or revert the merge that broke it (`git revert -m 1 <merge>`) and fix the branch.

### AI agents

AI agents follow everything above and AGENTS.md, like people:

- An agent works on its own branch, never on `main`.
- It pushes or opens a pull request only when the person running it asks.
- It never merges, and never force-pushes.
- It ends each session with a handoff.
