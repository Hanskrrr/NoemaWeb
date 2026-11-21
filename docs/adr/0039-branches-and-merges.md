# 0039. Branches and merges, for several people at once

Date: 2026-11-21. Status: accepted.

## Context

Until now one person (the founder, with Claude) worked on one long branch at a time: `notebook-features` is 94 commits past `main`, which has not moved since 5 November. Every push waited for the founder to ask, and each push was logged. The founder now wants others to join, people and their AI agents, each taking a piece of the work (the draft "Who can take what", 21 November). He asked for "guide about collab … like branch out and merge rule".

Four things go wrong when several people work like that:

- `main` stops being something to start from;
- two branches take the same ADR or migration number;
- shared docs conflict;
- a rebase or force-push loses someone's work.

Migrations are tracked by number in SQLite's `user_version`. A notebook that ran a branch's `029` would never run a different `029` from `main`.

## Decision

- **`main` is the branch everyone starts from, and always passes CI.** Nobody commits to it directly. A branch is named `area/what-it-does` and holds one piece of work, reviewable in one sitting. While `notebook-features` is not yet merged, it stands in for `main`.
- **Everything reaches `main` by pull request.** CI must be green: typecheck, lint, unit tests and e2e. The founder reviews and merges. His approval is needed for anything touching the scope fence, a new ADR, a migration, `contract.ts` or `AGENTS.md`. Changes an AI agent made are reviewed first by the person who ran it.
- **Merge commits only.** Handoffs and ADRs cite commit hashes; squash and rebase merges would make those hashes point at nothing on `main`.
- **Branches catch up by merging `main` in.** A branch that is pushed is never rebased. Nobody force-pushes a branch someone else has, or `main`. The branch owner resolves conflicts.
- **Numbered files.** An ADR or migration takes the next free number, shown in the pull request's title. Whoever merges second renumbers. Migrations on `main` are never edited. A branch with a migration is tried on a copy of the notebook (`NOEMA_DB_PATH`).
- **Shared docs.** In `status.md` and `codebase.md`, each person changes only their own lines. Handoffs are named `YYYY-MM-DD-area-topic.md`. Only the founder writes the push log, for merges into and pushes of `main`.
- **Pushes.** Anyone pushes their own branch. An AI agent pushes or opens a pull request only when the person running it asks, and never merges.
- **Where it is written.** The rules are in CONTRIBUTING.md ("Branches and merges"), in short in AGENTS.md (Workflow), and as a checklist in `.github/pull_request_template.md`.

## Consequences

- **Pushing gets lighter.** Branch pushes no longer wait for the founder and are no longer logged; the push log now records only what reaches `main`.
- **The founder is the one gate.** He reviews and merges everything, which is slower but keeps one view of the product while the team is small.
- **One-time steps for the founder:**
  - merge `notebook-features` into `main`, then remove the "For now" note in CONTRIBUTING.md;
  - push `main`;
  - protect `main` on GitHub (require a pull request and the CI check, no force-pushes).
- **The rules are words.** Until `main` is protected, nothing on GitHub enforces them.

## How to reverse

Put back the Workflow bullets of AGENTS.md and the "How work is done here" list of CONTRIBUTING.md from before this ADR. Delete the pull request template. One person on one branch, with pushes on request, works as before.
